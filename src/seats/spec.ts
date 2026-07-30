/**
 * 좌석 사양 — SEAT-CONTRACT.md 실측값만 담는다.
 *
 * `verified` 가 false 인 좌석은 실측되지 않았다는 뜻이다.
 * 브로커는 미검증 좌석을 조용히 쓰지 않고 호출자에게 그 사실을 알린다.
 * 추정으로 채운 명령줄로 좌석을 띄우면 실패 원인을 영원히 못 찾는다.
 */

import type { SeatId } from '../ledger/types.js';

export type Vendor = 'anthropic' | 'openai' | 'google' | 'cursor';

/** 쿼터 창. claude 는 주간이고 codex 는 일간이다 (실측). */
export interface QuotaWindow {
  window: 'day' | 'week' | 'unknown';
  /** 실측 전에는 null. 추정값을 넣지 않는다. */
  limit: number | null;
  /** 예: '20:00 Asia/Seoul' — claude 실측값. */
  resetAt: string | null;
}

export interface SeatSpec {
  id: SeatId;
  vendor: Vendor;
  /** 실행 파일 이름. PATH 는 proc 계층이 보강한다. */
  bin: string;
  /**
   * 설정 홈을 가리키는 환경변수 이름.
   * 이걸 격리 디렉터리로 돌리면 개인 스킬·플러그인·설정을 상속하지 않는다.
   * null 이면 격리 수단이 아직 실측되지 않았다는 뜻이다.
   */
  configHomeEnv: string | null;
  /** 격리 디렉터리로 복사할 인증 파일 이름들. OAuth 세션을 유지하는 최소 집합. */
  authFiles: string[];
  /** 프롬프트와 출력 파일을 받아 인자 배열을 만든다. */
  buildArgs: (prompt: string, outFile: string) => string[];
  /**
   * 결과를 읽는다. 종료 코드 0 이어도 이 함수가 null 을 주면 실패로 본다.
   * stderr 는 판정에 쓰지 않는다 — codex 가 성공하면서도 경고를 냈다 (실측).
   */
  readResult: (outFileContent: string | null, stdout: string) => string | null;
  quota: QuotaWindow;
  /** 실측된 최대 동시 세션. null 이면 미측정이라 1로 취급한다. */
  maxConcurrent: number | null;
  /** 실측 여부. */
  verified: boolean;
  /** 미검증이거나 사용 불가인 이유. */
  note?: string;
}

const trimmed = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
};

/**
 * codex — 유일하게 실측으로 동작이 확인된 좌석.
 *
 * 실측 근거:
 *   codex exec "<prompt>" --ignore-user-config --skip-git-repo-check -s read-only -o <file>
 *   → EXIT=0, 출력 파일에 최종 메시지 단독 기록, 19,357 토큰
 *
 *   --ignore-user-config 의 자체 도움말: "Do not load `$CODEX_HOME/config.toml`;
 *   auth still uses `CODEX_HOME`" — 설정은 끊고 인증은 유지한다.
 *   이 플래그 없이 돌리면 오너의 개인 설정이 좌석 모델을 바꾼다
 *   (실측: gpt-5.5/xhigh → gpt-5.6-sol/none).
 */
export const CODEX_SEAT: SeatSpec = {
  id: 'codex',
  vendor: 'openai',
  bin: 'codex',
  configHomeEnv: 'CODEX_HOME',
  authFiles: ['auth.json'],
  buildArgs: (prompt, outFile) => [
    'exec',
    prompt,
    '--ignore-user-config',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-o',
    outFile,
  ],
  readResult: (outFileContent) => trimmed(outFileContent),
  quota: { window: 'day', limit: null, resetAt: null },
  maxConcurrent: null,
  verified: true,
};

/**
 * claude — 표면은 확인됐으나 주간 한도 소진으로 성공 경로 미측정.
 *
 * 실측: claude -p "<prompt>" → EXIT=1,
 * "You've hit your weekly limit · resets 8pm (Asia/Seoul)"
 *
 * 성공 시 종료 코드와 출력 스키마, 설정 격리 수단은 아직 모른다.
 */
export const CLAUDE_SEAT: SeatSpec = {
  id: 'claude',
  vendor: 'anthropic',
  bin: 'claude',
  configHomeEnv: null,
  authFiles: [],
  buildArgs: (prompt) => ['-p', prompt, '--output-format', 'text'],
  readResult: (_outFileContent, stdout) => trimmed(stdout),
  quota: { window: 'week', limit: null, resetAt: '20:00 Asia/Seoul' },
  maxConcurrent: null,
  verified: false,
  note: '주간 한도 소진으로 성공 경로 미측정. 설정 격리 수단 미확인.',
};

/**
 * gemini — OAuth 세션은 있으나 계정 방식 때문에 실행 불가.
 *
 * 실측: gemini "<prompt>" -o json → EXIT=1,
 * "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var"
 * 공표 무료 한도(60/분, 1000/일)는 개인 Google 계정 기준이며 이 계정에 적용되지 않는다.
 *
 * -p/--prompt 는 deprecated 라 위치 인자를 쓴다.
 */
export const GEMINI_SEAT: SeatSpec = {
  id: 'gemini',
  vendor: 'google',
  bin: 'gemini',
  configHomeEnv: null,
  authFiles: [],
  buildArgs: (prompt) => [prompt, '-o', 'text'],
  readResult: (_outFileContent, stdout) => trimmed(stdout),
  quota: { window: 'unknown', limit: null, resetAt: null },
  maxConcurrent: null,
  verified: false,
  note: 'Workspace 계정이라 GOOGLE_CLOUD_PROJECT 를 요구한다. 개인 계정 재로그인 필요.',
};

/**
 * cursor — 에이전트 CLI 미설치.
 *
 * 실측: PATH 에 cursor-agent 없음. cursor.cmd 는 GUI 에디터 셔틀로
 * --diff/--merge 같은 편집기 옵션만 노출한다.
 * R1.5 에 따라 Cloud Agents API 는 쓸 수 없다.
 */
export const CURSOR_SEAT: SeatSpec = {
  id: 'cursor',
  vendor: 'cursor',
  bin: 'cursor-agent',
  configHomeEnv: null,
  authFiles: [],
  buildArgs: (prompt) => ['-p', prompt],
  readResult: (_outFileContent, stdout) => trimmed(stdout),
  quota: { window: 'unknown', limit: null, resetAt: null },
  maxConcurrent: null,
  verified: false,
  note: '에이전트 CLI 미설치. Cloud Agents API 는 R1.5 로 금지.',
};

export const ALL_SEATS: readonly SeatSpec[] = [CODEX_SEAT, CLAUDE_SEAT, GEMINI_SEAT, CURSOR_SEAT];

export function seatById(id: SeatId): SeatSpec {
  const found = ALL_SEATS.find((s) => s.id === id);
  if (!found) throw new Error(`알 수 없는 좌석: ${id}`);
  return found;
}

/** 실측으로 동작이 확인된 좌석만. */
export function verifiedSeats(): SeatSpec[] {
  return ALL_SEATS.filter((s) => s.verified);
}

/** 미측정 동시성은 1로 취급한다. 추정으로 올리지 않는다. */
export function effectiveConcurrency(spec: SeatSpec): number {
  return spec.maxConcurrent ?? 1;
}
