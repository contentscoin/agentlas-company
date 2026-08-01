/**
 * 정책 게이트와 승인 타입 (R4)
 *
 * 등급이 정하는 것은 "누가 실행을 허락하는가" 하나다.
 *   L0  자동 — 내부 산출물
 *   L1  자동 — 화이트리스트된 채널 발행
 *   L2  오너 승인
 *   L3  오너 승인 + 단계별 인증
 *
 * 두 가지가 이 표를 무력화하지 못하게 막아야 한다.
 *   승인 만료가 통과로 해석되는 것 (R4.7) — 침묵은 승인이 아니다
 *   승인 후 내용이 바뀌는 것 (R4.6) — 영수증은 정확한 페이로드에 묶인다
 */

import type { AutonomyLevel } from '../ledger/types.js';

export type { AutonomyLevel };

export const LEVEL_ORDER: readonly AutonomyLevel[] = ['L0', 'L1', 'L2', 'L3'];

/** 등급을 한 칸 올린다. L3 은 더 올라갈 곳이 없다 (R4.4). */
export function escalate(level: AutonomyLevel): AutonomyLevel {
  const i = LEVEL_ORDER.indexOf(level);
  return LEVEL_ORDER[Math.min(i + 1, LEVEL_ORDER.length - 1)]!;
}

export function requiresApproval(level: AutonomyLevel): boolean {
  return level === 'L2' || level === 'L3';
}

export function requiresStepUp(level: AutonomyLevel): boolean {
  return level === 'L3';
}

export interface PolicyConfig {
  levels: Record<AutonomyLevel, string[]>;
  escalateWhen: {
    criticBlock: boolean;
    seiRiskSignal: boolean;
    outputTainted: boolean;
  };
  approval: {
    cardTtlMs: number;
    coolingWindowMs: number;
  };
  /** 승인을 제출할 수 있는 오너 신원 (R4.8). */
  ownerIdentities: string[];
  /** 등록된 오너 기기 (R4.10). */
  devices: string[];
}

/** 등급 판정에 들어가는 신호. */
export interface ClassifyInput {
  action: string;
  /**
   * Critic 판정. 값은 업스트림 PROTOCOLS.md v1 계약을 따른다.
   *
   * 처음에는 `PASS | CONCERN | BLOCK` 으로 적었는데 실제 프로토콜을 확인하고
   * 맞췄다. 계약이 둘로 갈리면 게이트가 헛돈다 — Critic 이 `WATCH` 를 냈는데
   * 우리 정책은 그 문자열을 모르니 승격이 조용히 일어나지 않는다.
   */
  criticVerdict?: 'CLEAR' | 'WATCH' | 'BLOCK';
  seiRisk?: boolean;
  tainted?: boolean;
  /** 되돌릴 수 없는 작업인가. 유예 창 적용 여부를 결정한다 (R4.11). */
  irreversible?: boolean;
}

export interface Classification {
  action: string;
  baseLevel: AutonomyLevel;
  level: AutonomyLevel;
  escalatedBy: string[];
  needsApproval: boolean;
  needsStepUp: boolean;
  irreversible: boolean;
}

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'aborted'
  | 'invalidated'
  | 'consumed';

export interface ApprovalRequest {
  id: string;
  action: string;
  level: AutonomyLevel;
  /** 승인이 묶이는 페이로드 digest (R4.5). */
  payloadDigest: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  irreversible: boolean;
  status: ApprovalStatus;
  decidedBy?: { identity: string; device: string; at: string; stepUp: boolean };
  /** 유예 창이 끝나 실행 가능해지는 시각 (R4.11). */
  executeAfter?: string;
  /** 취소·중단·무효 사유. */
  closedReason?: string;
}

/** 승인 제출 시 신원. */
export interface Submitter {
  identity: string;
  device: string;
  stepUp: boolean;
}

export interface ApprovalOutcome {
  ok: boolean;
  request: ApprovalRequest;
  reason?: string;
}

/** 실행 인가 확인 결과. */
export interface ConsumeOutcome {
  allowed: boolean;
  reason?:
    | 'not-found'
    | 'not-approved'
    | 'rejected'
    | 'expired'
    | 'aborted'
    | 'digest-mismatch'
    | 'cooling'
    | 'already-consumed';
  detail?: string;
  request?: ApprovalRequest;
}
