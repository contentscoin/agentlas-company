/**
 * 능력 스위치 타입 (R8)
 *
 * 위험한 능력을 코드에서 지우는 대신 오너가 켜고 끄는 스위치로 만든다.
 * 안전을 지키는 것은 스위치 자체가 아니라 스위치에 붙은 제약 넷이다.
 *
 *   기본 OFF 출하 · 유효기간 필수 · 재부팅 시 전부 OFF · 에이전트 접근 불가
 *
 * 켜져 있다는 것은 "실행해도 된다"가 아니라 "실행 요청을 받아줄 수는 있다"는 뜻이다.
 * 개별 실행은 여전히 L3 승인을 따로 받는다 (R8.6).
 */

/** 스위치로 통제되는 위험 능력 10종 (R8.2). */
export const RISKY_CAPABILITIES = [
  'payout_account_change',
  'credential_change',
  'product_delete',
  'price_bulk_change',
  'order_cancel_refund',
  'post_bulk_delete',
  'account_delete',
  'dm_send',
  'mass_follow',
  'spend',
] as const;

export type RiskyCapability = (typeof RISKY_CAPABILITIES)[number];

export function isRiskyCapability(value: string): value is RiskyCapability {
  return (RISKY_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * 호출자의 구역. 자격증명과 스위치는 브로커 구역에 있고
 * 좌석 구역은 읽기조차 거부된다 (R15.8, R8.8).
 */
export type Zone = 'owner' | 'broker' | 'seat' | 'system';

export interface Caller {
  zone: Zone;
  id: string;
  /** 오너 기기 식별자. 스위치 변경 기록에 남는다 (R8.11). */
  device?: string;
  /** 단계별 인증 통과 여부 (R8.7). */
  stepUp?: boolean;
}

/** 적용 범위. 비어 있으면 "범위 지정 없음"이며 그때만 전체 허용이다. */
export interface CapabilityScope {
  channels: string[];
  accounts: string[];
}

export interface CapabilityState {
  capability: RiskyCapability;
  enabled: boolean;
  /** ON 일 때 필수. null 이면서 enabled 인 상태는 저장될 수 없다 (R8.4). */
  expiresAt: string | null;
  scope: CapabilityScope;
  /**
   * 이 부여가 만들어진 부팅 세션. 현재 부팅과 다르면 OFF 로 본다 (R17.3).
   * 재부팅으로 "켜둔 걸 잊는" 실패가 자동 치유된다.
   */
  bootId: string | null;
  lastChangedBy: { device: string; at: string } | null;
}

export interface CapabilityRequest {
  capability: RiskyCapability;
  /** 대상 채널. 범위 검사에 쓰인다. */
  channel?: string;
  account?: string;
  /** 이 요청을 만든 산출물이 오염되었는가 (R16.5). */
  tainted?: boolean;
  /**
   * L3 승인 영수증. Task 7 의 정책 게이트가 채운다.
   * 지금은 존재 여부만 검사한다 — 없으면 스위치가 ON 이어도 거부된다 (R8.6).
   */
  approval?: { digest: string; grantedAt: string; device: string } | undefined;
  /** 실행될 페이로드의 digest. 승인 바인딩 검증에 쓰인다 (R4.5). */
  payloadDigest?: string;
}

export type DenyReason =
  | 'switch-off'
  | 'expired'
  | 'stale-boot'
  | 'out-of-scope'
  | 'tainted'
  | 'no-approval'
  | 'approval-digest-mismatch'
  | 'zone-forbidden';

export interface GuardDecision {
  allowed: boolean;
  reason?: DenyReason;
  detail?: string;
}

/** 스위치 화면에 보일 한 줄 (R8.15). */
export interface CapabilityView {
  capability: RiskyCapability;
  enabled: boolean;
  remainingMs: number | null;
  scope: CapabilityScope;
  lastChangedBy: { device: string; at: string } | null;
  recentUses: number;
  recentDenials: number;
}
