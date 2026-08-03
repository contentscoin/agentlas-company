/**
 * 구역 검증 (R15.1~R15.3, R15.7, R15.8)
 *
 * **확인하지 못한 것을 통과로 보고하지 않는다.** 판정은 셋이다 —
 * `ok`(닫혀 있음이 확인됨) / `violation`(열려 있음이 확인됨) / `unknown`
 * (확인 불가). 마지막을 없애고 싶은 유혹이 크지만, 없애면 "초록인데 틀린
 * 상태" 가 된다. 보안 보고서에서 그것이 가장 나쁜 결과다.
 *
 * 플랫폼마다 확인 방법이 다르다.
 *   POSIX    stat 의 uid/gid/mode 로 판정한다. 정확하다
 *   Windows  icacls 출력을 파싱한다. ACL 은 상속·거부 규칙이 얽혀 있어
 *            문자열 파싱으로는 확신할 수 없는 경우가 있고, 그때는 unknown
 *
 * 운영 대상이 Windows 인데 POSIX 쪽이 더 정확한 것이 아이러니하지만,
 * 정확하지 않은 것을 정확한 척하는 것보다 낫다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { FORBIDDEN_PATTERNS, ZONE_ACCOUNTS, type AccessMode, type ZoneAccount, type ZoneEntry } from './layout.js';

export type Verdict = 'ok' | 'violation' | 'unknown' | 'absent';

export interface CheckRow {
  label: string;
  path: string;
  /** 누가 접근하면 안 되는지. 보통 좌석 구역이다. */
  deniedTo: ZoneAccount[];
  verdict: Verdict;
  detail: string;
}

export interface VerifyReport {
  platform: string;
  rows: CheckRow[];
  forbidden: Array<{ path: string; detail: string }>;
  counts: Record<Verdict, number>;
  /** 위반이 하나라도 있으면 거짓. unknown 은 통과로 세지 않는다. */
  ok: boolean;
}

function deniedAccounts(entry: ZoneEntry): ZoneAccount[] {
  return (Object.keys(ZONE_ACCOUNTS) as ZoneAccount[]).filter(
    (zone) => entry.access[zone] === ('none' as AccessMode),
  );
}

/**
 * POSIX 판정.
 *
 * 그룹·기타 비트가 하나라도 서 있으면 소유자 외에 열려 있는 것이다.
 * 소유자가 누구인지까지는 보지 않는다 — 계정 이름 매핑은 배치마다 다르고,
 * 여기서 중요한 것은 "타인에게 열려 있는가" 다.
 *
 * **Windows 에서는 판정하지 않는다.** Node 가 Windows 에서 돌려주는 mode 는
 * POSIX 비트가 아니다 — 쓰기 가능하면 `0666`, 읽기 전용이면 `0444` 로
 * 뭉뚱그린다. 그 값을 POSIX 규칙으로 읽으면 실제로는 잠긴 파일을
 * `violation` 으로 보고한다. CI(windows-latest)가 정확히 그것을 잡았다.
 *
 * 이 모듈의 원칙은 "확인하지 못한 것을 통과로 보고하지 않는다" 인데,
 * **위반으로 보고해서도 안 된다.** 거짓 경보는 진짜 경보를 묻는다.
 */
export function checkPosix(
  path: string,
  platform: NodeJS.Platform = process.platform,
): { verdict: Verdict; detail: string } {
  if (platform === 'win32') {
    return {
      verdict: 'unknown',
      detail: 'Windows 에서는 POSIX mode 가 의미를 갖지 않는다 — icacls 로 판정한다',
    };
  }
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    const groupOther = mode & 0o077;
    if (groupOther === 0) {
      return { verdict: 'ok', detail: `mode ${mode.toString(8).padStart(3, '0')} — 소유자 전용` };
    }
    return {
      verdict: 'violation',
      detail: `mode ${mode.toString(8).padStart(3, '0')} — 소유자 외 접근 가능`,
    };
  } catch (err) {
    return { verdict: 'unknown', detail: `stat 실패: ${(err as Error).message}` };
  }
}

/**
 * Windows 판정.
 *
 * `icacls <path>` 는 `계정:(권한)` 줄들을 낸다. 좌석 계정이 등장하고 그것이
 * 거부(`(DENY)`)가 아니면 위반이다. 계정이 아예 없으면 접근권이 없는
 * 것이지만, 상속으로 들어온 그룹 권한(`Users`, `Everyone`)이 대신 열어 줄 수
 * 있으므로 그 경우도 위반으로 본다.
 */
export function parseIcacls(output: string, seatAccount: string): { verdict: Verdict; detail: string } {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { verdict: 'unknown', detail: 'icacls 출력이 비어 있다' };

  const broad = lines.filter((l) => /\b(Everyone|BUILTIN\\Users|AUTHENTICATED USERS)\b/i.test(l) && !/\(DENY\)/i.test(l));
  if (broad.length > 0) {
    return { verdict: 'violation', detail: `광범위한 권한이 있다: ${broad[0]}` };
  }

  const seatLines = lines.filter((l) => l.toLowerCase().includes(seatAccount.toLowerCase()));
  const allowed = seatLines.filter((l) => !/\(DENY\)/i.test(l));
  if (allowed.length > 0) {
    return { verdict: 'violation', detail: `좌석 계정에 권한이 있다: ${allowed[0]}` };
  }
  if (seatLines.length > 0) {
    return { verdict: 'ok', detail: '좌석 계정이 명시적으로 거부되어 있다' };
  }
  return { verdict: 'ok', detail: '좌석 계정에 부여된 권한이 없다' };
}

function checkWindows(path: string, seatAccount: string): { verdict: Verdict; detail: string } {
  try {
    const output = execFileSync('icacls', [path], { encoding: 'utf8', timeout: 10_000 });
    return parseIcacls(output, seatAccount);
  } catch (err) {
    return { verdict: 'unknown', detail: `icacls 실행 실패: ${(err as Error).message}` };
  }
}

/** 금지 파일 탐색 (R15.7). 이름만 본다 — 내용을 열지 않는다. */
export function scanForbidden(paths: readonly string[]): Array<{ path: string; detail: string }> {
  const hits: Array<{ path: string; detail: string }> = [];
  for (const path of paths) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (!pattern.test(path)) continue;
      hits.push({ path, detail: '2FA 시드·복구코드는 이 기계에 두지 않는다 (R15.7)' });
      break;
    }
  }
  return hits;
}

export interface VerifyOptions {
  entries: ZoneEntry[];
  /** 금지 파일을 찾을 후보 경로. 호출자가 수집해 넘긴다. */
  candidatePaths?: string[];
  platform?: NodeJS.Platform;
}

export function verifyZones(opts: VerifyOptions): VerifyReport {
  const platform = opts.platform ?? process.platform;
  const rows: CheckRow[] = [];

  for (const entry of opts.entries) {
    const denied = deniedAccounts(entry);
    if (denied.length === 0) continue;

    if (!existsSync(entry.path)) {
      rows.push({
        label: entry.label,
        path: entry.path,
        deniedTo: denied,
        // 없는 것은 위반이 아니다. 다만 선택적이지 않은데 없으면 알린다.
        verdict: 'absent',
        detail: entry.optional ? '아직 만들어지지 않았다 (선택)' : '아직 만들어지지 않았다',
      });
      continue;
    }

    const result =
      platform === 'win32'
        ? checkWindows(entry.path, ZONE_ACCOUNTS.seats)
        : checkPosix(entry.path, platform);
    rows.push({ label: entry.label, path: entry.path, deniedTo: denied, ...result });
  }

  const forbidden = scanForbidden(opts.candidatePaths ?? []);
  const counts: Record<Verdict, number> = { ok: 0, violation: 0, unknown: 0, absent: 0 };
  for (const row of rows) counts[row.verdict] += 1;

  return {
    platform,
    rows,
    forbidden,
    counts,
    // unknown 은 통과가 아니다. 다만 위반과도 구분하므로 ok 판정에서만 뺀다.
    ok: counts.violation === 0 && forbidden.length === 0,
  };
}

/** 지금 어느 계정으로 돌고 있는가. 보고서 머리말에 쓴다. */
export function currentAccount(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}
