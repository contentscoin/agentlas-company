/**
 * 프로바이더 등록 — 좌석을 늘리는 문 (R1, R2)
 *
 * 좌석을 추가하려면 이 파일에 항목을 하나 더 쓰면 된다. 브로커는 바뀌지 않는다.
 *
 * 다만 **아무 프로바이더나 붙일 수 없다.** 오너의 절대 제약이 있다:
 * 모든 LLM 은 구독 계정 OAuth 로만 구동하고 API 키를 쓰지 않는다.
 *
 * 그래서 인증 방식을 타입으로 못박았고 `apiKey` 는 표현할 수 없게 두었다.
 * open-codex, opencodex 프록시, AI 게이트웨이 같은 멀티프로바이더 경로는
 * 대부분 OpenRouter·DeepSeek 등의 API 키로 붙기 때문에 이 등록부에 들어올 수 없다.
 * 표현할 수 없는 것은 구현될 수 없다.
 */

import type { SeatId } from '../ledger/types.js';
import type { SeatSpec, Vendor } from './spec.js';

/**
 * 인증 방식.
 *
 * 현재 `oauth` 하나뿐이다. 로컬 모델 좌석을 검토했으나 오너 판단으로 제외했다.
 * 다시 필요해지면 여기에 방식을 더하고 등록부에 항목을 추가하면 된다.
 */
export type AuthMode = 'oauth';

export interface ProviderInfo {
  seat: SeatId;
  vendor: Vendor;
  auth: AuthMode;
  /** 사람이 읽는 설명. `company seats` 에 표시된다. */
  summary: string;
}

/**
 * 프로바이더 등록부.
 *
 * 인증이 `oauth` 가 아닌 좌석은 타입상 추가할 수 없다.
 */
export const PROVIDER_REGISTRY: readonly ProviderInfo[] = [
  { seat: 'codex', vendor: 'openai', auth: 'oauth', summary: 'Codex CLI · ChatGPT 구독 OAuth' },
  { seat: 'claude', vendor: 'anthropic', auth: 'oauth', summary: 'Claude Code · Max 구독 OAuth' },
  { seat: 'gemini', vendor: 'google', auth: 'oauth', summary: 'Gemini CLI · Google 계정 OAuth' },
  { seat: 'cursor', vendor: 'cursor', auth: 'oauth', summary: 'Cursor CLI · Cursor 구독 OAuth' },
];

export function providerFor(seat: SeatId): ProviderInfo | undefined {
  return PROVIDER_REGISTRY.find((p) => p.seat === seat);
}

/** 서로 다른 벤더가 몇 개 가동 가능한가. 크로스벤더 회의(R3.4)의 선행 조건이다. */
export function distinctVendors(specs: readonly SeatSpec[]): Vendor[] {
  return [...new Set(specs.filter((s) => s.verified).map((s) => s.vendor))];
}

/** 크로스벤더 회의가 가능한가 (R3.4). */
export function crossVendorPossible(specs: readonly SeatSpec[]): boolean {
  return distinctVendors(specs).length >= 2;
}
