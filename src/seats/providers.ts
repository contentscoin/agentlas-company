/**
 * 프로바이더 등록 — 좌석을 늘리는 문 (R1, R2)
 *
 * 좌석을 추가하려면 이 파일에 사양을 하나 더 쓰면 된다. 브로커는 바뀌지 않는다.
 *
 * 다만 **아무 프로바이더나 붙일 수 없다.** 오너의 절대 제약이 있다:
 * 모든 LLM 은 구독 계정 OAuth 로만 구동하고 API 키를 쓰지 않는다.
 *
 * 그래서 프로바이더가 인증을 어떻게 하는지를 타입으로 명시하고,
 * `apiKey` 인증은 아예 표현할 수 없게 만들었다. open-codex, opencodex 프록시,
 * AI 게이트웨이 같은 멀티프로바이더 경로는 대부분 OpenRouter·DeepSeek 등의
 * API 키로 붙기 때문에 이 등록부에 들어올 수 없다.
 *
 * 키 없이 프로바이더를 늘리는 두 갈래만 허용한다.
 *
 *   oauth  이미 로그인된 구독 계정 세션을 쓰는 로컬 CLI
 *   local  기계 안에서 도는 모델. 계정도 키도 네트워크도 없다
 */

import type { SeatId } from '../ledger/types.js';
import type { SeatSpec, Vendor } from './spec.js';

/**
 * 인증 방식.
 *
 * `apiKey` 가 목록에 없는 것이 의도다. 표현할 수 없는 것은 구현될 수 없다.
 */
export type AuthMode = 'oauth' | 'local';

export interface ProviderInfo {
  seat: SeatId;
  vendor: Vendor;
  auth: AuthMode;
  /** 사람이 읽는 설명. `company seats` 에 표시된다. */
  summary: string;
}

const trimmed = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
};

/**
 * Ollama — 로컬 모델 좌석.
 *
 * 이 좌석이 중요한 이유는 제약 때문이 아니라 **구조** 때문이다.
 * R3.4 는 Critic 이 본체와 다른 벤더 좌석에서 발언할 것을 요구하는데,
 * 지금 검증된 좌석이 codex 하나라 그 조건을 만족할 수 없어 회의(Task 6)가 막혀 있다.
 * 로컬 좌석은 벤더가 다르고 쿼터가 없어서 그 교착을 푼다.
 *
 * 제약 측면에서도 가장 깨끗하다 — 구독도 키도 네트워크도 없다.
 * OAuth 보다 더 엄격한 셈이다.
 *
 * 실측: `echo <프롬프트> | ollama run <모델>` — stdout 으로 응답, 종료 코드로 판정.
 */
export function ollamaSeat(model: string): SeatSpec {
  return {
    id: 'ollama',
    vendor: 'local',
    bin: 'ollama',
    // 로컬 모델은 설정 홈 격리가 필요 없다. 개인 스킬·MCP 를 상속하지 않는다.
    configHomeEnv: null,
    authFiles: [],
    promptVia: 'stdin',
    buildArgs: () => ['run', model],
    readResult: (_outFile, stdout) => trimmed(stdout),
    // 로컬이라 쿼터가 없다. 상한은 기계 성능이지 계정이 아니다.
    quota: { window: 'day', limit: null, resetAt: null },
    maxConcurrent: 1,
    verified: false,
    note: `로컬 모델 ${model}. 실측 후 verified 로 바꾼다.`,
  };
}

/**
 * 프로바이더 등록부.
 *
 * 새 좌석을 여기에 추가한다. 인증이 `oauth` 나 `local` 이 아니면 추가할 수 없다.
 */
export const PROVIDER_REGISTRY: readonly ProviderInfo[] = [
  { seat: 'codex', vendor: 'openai', auth: 'oauth', summary: 'Codex CLI · ChatGPT 구독 OAuth' },
  { seat: 'claude', vendor: 'anthropic', auth: 'oauth', summary: 'Claude Code · Max 구독 OAuth' },
  { seat: 'gemini', vendor: 'google', auth: 'oauth', summary: 'Gemini CLI · Google 계정 OAuth' },
  { seat: 'cursor', vendor: 'cursor', auth: 'oauth', summary: 'Cursor CLI · Cursor 구독 OAuth' },
  { seat: 'ollama', vendor: 'local', auth: 'local', summary: 'Ollama · 기계 내부 모델, 계정·키·네트워크 없음' },
];

export function providerFor(seat: SeatId): ProviderInfo | undefined {
  return PROVIDER_REGISTRY.find((p) => p.seat === seat);
}

/** 서로 다른 벤더가 몇 개 가동 가능한가. 크로스벤더 회의(R3.4)의 선행 조건이다. */
export function distinctVendors(specs: readonly SeatSpec[]): Vendor[] {
  return [...new Set(specs.filter((s) => s.verified).map((s) => s.vendor))];
}
