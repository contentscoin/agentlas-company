/**
 * 좌석 사양 — SEAT-CONTRACT.md 실측값만 담는다.
 *
 * `verified` 가 false 인 좌석은 실측되지 않았다는 뜻이다.
 * 브로커는 미검증 좌석을 조용히 쓰지 않고 호출자에게 그 사실을 알린다.
 * 추정으로 채운 명령줄로 좌석을 띄우면 실패 원인을 영원히 못 찾는다.
 */

import type { SeatId } from '../ledger/types.js';

export type Vendor = 'anthropic' | 'openai' | 'google' | 'cursor';

/**
 * 프로세스 실행 방식. 실측이 강제한 구분이다.
 *
 *   shell   `.ps1`/`.cmd` 셔틀을 거치는 좌석 (codex, gemini). 프롬프트는 stdin.
 *   direct  실행 파일을 셸 없이 직접 띄운다 (claude).
 *
 * claude 는 프롬프트를 인자로만 받고 stdin 을 읽지 않는데, 여러 줄 인자는
 * cmd.exe 를 거치면 개행에서 깨진다. 셸을 빼면 인자가 CreateProcess 로
 * 그대로 전달되어 개행도 길이도 문제가 없다.
 */
export type SpawnMode = 'shell' | 'direct';

/** 쿼터 창. claude 는 주간이고 codex 는 일간이다 (실측). */
export interface QuotaWindow {
  window: 'day' | 'week' | 'unknown';
  /** 실측 전에는 null. 추정값을 넣지 않는다. */
  limit: number | null;
  /** 예: '20:00 Asia/Seoul' — claude 실측값. */
  resetAt: string | null;
  /**
   * 주간 창이 넘어가는 요일 (0=일요일). 주간 창에서만 의미가 있다.
   *
   * claude 실측 문구는 `resets 8pm (Asia/Seoul)` 까지만 알려 주고 **요일은
   * 말하지 않는다**. 그래서 실측 전에는 null 이고, null 이면 주간 창의
   * 경계를 계산할 수 없다 — `usage.ts` 가 그 좌석의 카운터를 리셋하지 않고
   * 한도도 집행하지 않는다.
   *
   * 한도(`limit`)를 채워 넣으려면 이 값이 먼저 있어야 한다.
   * `assertQuotaCoherent` 가 그 순서를 강제한다.
   */
  resetDay?: number | null;
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
  /**
   * 프롬프트를 어떻게 넘기는가.
   *
   * `stdin` 이 기본이어야 한다. 실측 근거: 여러 줄 프롬프트를 셸 인자로 넘기면
   * 개행이 명령줄을 깨뜨려 exit 1 이 된다. 그리고 Windows 명령줄 길이 상한이
   * 약 8191자라 컨텍스트 팩을 인자로는 실을 수 없다.
   */
  promptVia: 'arg' | 'stdin';
  /**
   * 프로세스 실행 방식.
   *
   * `.ps1`/`.cmd` 셔틀은 직접 실행할 수 없어 `shell` 이어야 한다.
   * stdin 을 읽지 않는 좌석은 `direct` + `arg` 로 셸을 우회해야 여러 줄이 전달된다.
   */
  spawnMode: SpawnMode;
  /**
   * 인자 배열을 만든다.
   * `promptVia: 'stdin'` 이면 `prompt` 는 빈 문자열로 들어오고 본문은 stdin 으로 간다.
   */
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
  // `codex exec -` 는 지시문을 stdin 에서 읽는다 (자체 도움말: "If not provided
  // as an argument (or if `-` is used), instructions are read from stdin").
  // 여러 줄 프롬프트로 실측 확인했다.
  promptVia: 'stdin',
  // `.ps1` 셔틀이라 셸을 거쳐야 한다.
  spawnMode: 'shell',
  buildArgs: (_prompt, outFile) => [
    'exec',
    '-',
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
 * claude — 주간 한도 리셋 후 실측 확인.
 *
 * 실측 경과:
 *   1차(한도 소진)  claude -p "<prompt>" → EXIT=1,
 *                   "You've hit your weekly limit · resets 8pm (Asia/Seoul)"
 *   2차(리셋 후)    같은 명령 → EXIT=0, "SEAT_OK". 쿼터 창이 주간이고
 *                   리셋 시각이 실제로 20:00 Asia/Seoul 임을 확인했다.
 *
 * stdin 은 읽지 않는다. 파이프로 넣으면 출력이 0바이트이고, stderr 에
 * "Warning: no stdin data received in 3s, proceeding without it" 이 나온다.
 * 즉 프롬프트는 인자로만 받으며, 여러 줄 인자는 셸을 거치면 깨지므로
 * `direct` 실행으로 셸을 우회한다.
 *
 * 최소 프로필 실측 (동일 프롬프트):
 *   플래그 없음                                13,122ms
 *   --strict-mcp-config                        11,860ms
 *   --strict-mcp-config --setting-sources project  8,717ms
 *
 * 사용자 설정을 제외하면 33% 빨라진다. 격리의 이유는 속도가 아니라
 * 재현성이지만(codex 에서 확인) 여기서는 속도까지 얻는다.
 */
export const CLAUDE_SEAT: SeatSpec = {
  id: 'claude',
  vendor: 'anthropic',
  bin: 'claude',
  // 설정 홈 환경변수 대신 플래그로 격리한다. 인증은 건드리지 않는다.
  configHomeEnv: null,
  authFiles: [],
  promptVia: 'arg',
  spawnMode: 'direct',
  buildArgs: (prompt) => [
    '-p',
    prompt,
    '--output-format',
    'text',
    // 개인 MCP 서버를 상속하지 않는다.
    '--strict-mcp-config',
    // 사용자 전역 설정을 제외한다. 좌석의 모델과 동작이 오너의 에디터 설정에
    // 따라 조용히 바뀌는 것을 막는다.
    '--setting-sources',
    'project',
  ],
  readResult: (_outFileContent, stdout) => trimmed(stdout),
  quota: { window: 'week', limit: null, resetAt: '20:00 Asia/Seoul' },
  maxConcurrent: null,
  verified: true,
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
  // Gemini CLI 도움말: "-p, --prompt  Prompt. Appended to input on stdin (if any)."
  // stdin 입력을 받는다고 적혀 있으나 계정 구성 미비로 실측하지 못했다.
  promptVia: 'stdin',
  spawnMode: 'shell',
  buildArgs: () => ['-o', 'text'],
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
  promptVia: 'stdin',
  spawnMode: 'shell',
  buildArgs: () => ['-p'],
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
