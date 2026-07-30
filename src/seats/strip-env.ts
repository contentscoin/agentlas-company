/**
 * 정본 API 키 삭제 목록 (R1.1)
 *
 * 이 파일은 저장소에서 벤더 API 키 변수 이름을 나열할 수 있는 **유일한** 곳이다.
 * `gate:apikey` 가 이 예외를 강제한다. 다른 곳에서 이름이 등장하면 빌드가 실패한다.
 *
 * 이름을 나열하는 목적은 사용이 아니라 **삭제**다.
 * 좌석 프로세스를 띄울 때 이 변수들을 자식 환경에서 제거해서,
 * CLI 가 API 키 경로로 새지 않고 OAuth 로그인 세션만 쓰게 만든다.
 *
 * 구현 근거는 업스트림 proc.js 다. 원문 인용:
 *   L30  // extra values of undefined mean "remove this var" (e.g. drop a stale API key)
 *   L31  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
 *
 * 값을 읽는 코드는 이 파일에도 없다. 이름만 있다.
 */

/** 좌석 스폰 시 자식 환경에서 제거할 변수. */
export const STRIPPED_ENV_VARS: readonly string[] = [
  // Anthropic — Claude Code
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // OpenAI — Codex CLI
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  // Google — Gemini CLI
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // Cursor
  'CURSOR_API_KEY',
  // 그 밖의 OpenAI 호환 벤더 (실수로 새는 경로를 미리 막는다)
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
] as const;

/**
 * proc 계층에 넘길 환경 오버라이드를 만든다.
 * 값이 `undefined` 인 항목은 자식 환경에서 변수를 지운다는 뜻이다.
 */
export function stripOverrides(): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const name of STRIPPED_ENV_VARS) out[name] = undefined;
  return out;
}
