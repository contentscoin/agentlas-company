/**
 * 실행 게이트 — 외부 실행 표면을 위한 단일 진입점 (R4, R13.3, R16.5)
 *
 * `agentlas-desktop` 같은 실행 표면이 위험 작업 직전에 "이거 해도 되나" 를
 * 묻는 자리다. 여기가 없으면 통제 계층은 기록만 남기고 아무것도 막지 못한다.
 *
 * **MCP 도구 등록으로는 이 일을 할 수 없다.** MCP 는 에이전트에게 도구를
 * 제공할 뿐 호출을 가로채지 않는다. 등록만 해두면 원장에 기록은 쌓이는데
 * 실행은 그대로 나가는 — 설계 §에러 처리 원칙이 금지한 "초록인데 틀린 상태" —
 * 가 된다. 그래서 실행 표면이 실행 전에 **직접 묻는** 형태로 만든다.
 *
 * 판정 흐름은 세 갈래뿐이다.
 *   L0/L1        → 즉시 인가. 원장에 기록만 남긴다
 *   L2/L3, 카드 없음 → 승인 카드를 만들고 **거부**한다. 침묵은 승인이 아니다
 *   L2/L3, 승인됨    → 카드를 소비하고 인가한다. 한 번 쓰면 끝이다
 *
 * 호출자는 `allowed` 하나만 보면 된다. `reason` 은 사람에게 보여줄 설명이지
 * 분기 조건이 아니다 — 새 거부 사유가 생겨도 호출자가 안 깨지게 하려는 것이다.
 */

import type { Ledger } from '../ledger/ledger.js';
import { classify } from './policy.js';
import type { ApprovalService } from './approval.js';
import type { AutonomyLevel, PolicyConfig } from './types.js';

export interface GateInput {
  /** 정책표에서 등급을 찾을 작업 이름. 예: `agent.borrow` */
  action: string;
  /** 승인이 묶일 페이로드 digest. 내용이 바뀌면 인가가 무효가 된다 (R4.6). */
  payloadDigest: string;
  /** 오너가 승인 화면에서 읽을 한 줄. 비밀이나 PII 를 담지 않는다. */
  summary: string;
  criticVerdict?: 'CLEAR' | 'WATCH' | 'BLOCK';
  seiRisk?: boolean;
  /** 오염된 입력에서 나온 작업인가. 참이면 등급이 승격된다 (R16.5). */
  tainted?: boolean;
  runId?: string;
}

/**
 * 판정 사유.
 *
 * `auto`·`approved` 만 인가이고 나머지는 전부 거부다. 호출자가 이 문자열로
 * 분기하지 않도록 `allowed` 를 따로 둔다.
 */
export type GateReason =
  | 'auto'
  | 'approved'
  | 'approval-pending'
  | 'not-found'
  | 'not-approved'
  | 'rejected'
  | 'expired'
  | 'aborted'
  | 'digest-mismatch'
  | 'cooling'
  | 'already-consumed';

export interface GateDecision {
  allowed: boolean;
  action: string;
  level: AutonomyLevel;
  reason: GateReason;
  /** 오너가 결정해야 할 승인 카드. 거부 사유가 승인 관련일 때만 있다. */
  approvalId?: string;
  /** 사람이 읽는 부연. 남은 유예 시간 같은 것. */
  detail?: string;
  needsStepUp: boolean;
  irreversible: boolean;
}

export interface GateDeps {
  policy: PolicyConfig;
  approvals: ApprovalService;
  ledger: Ledger;
}

export function resolveGate(deps: GateDeps, input: GateInput): GateDecision {
  const { policy, approvals, ledger } = deps;

  const c = classify(policy, {
    action: input.action,
    ...(input.criticVerdict ? { criticVerdict: input.criticVerdict } : {}),
    ...(input.seiRisk ? { seiRisk: true } : {}),
    ...(input.tainted ? { tainted: true } : {}),
  });

  const base = {
    action: c.action,
    level: c.level,
    needsStepUp: c.needsStepUp,
    irreversible: c.irreversible,
  };

  const record = (kind: 'gate.verdict' | 'deny', summary: string): void => {
    ledger.append({
      actor: { kind: 'system', id: 'gate' },
      kind,
      level: c.level,
      payloadDigest: input.payloadDigest,
      ...(input.tainted ? { tainted: true } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      summary,
    });
  };

  // L0/L1 — 정책이 자동으로 허용한 등급. 기록은 남기되 막지 않는다.
  if (!c.needsApproval) {
    record('gate.verdict', `${c.action} 자동 인가 — 등급 ${c.level}`);
    return { ...base, allowed: true, reason: 'auto' };
  }

  const open = approvals.findOpen(c.action, input.payloadDigest);

  // 카드가 없다 → 만들고 거부한다. 만드는 것과 통과시키는 것은 다른 일이다.
  if (!open) {
    const request = approvals.create({
      classification: c,
      payloadDigest: input.payloadDigest,
      summary: input.summary,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    record('deny', `${c.action} 거부 — 오너 승인 대기 (${request.id})`);
    return { ...base, allowed: false, reason: 'approval-pending', approvalId: request.id };
  }

  if (open.status === 'pending') {
    record('deny', `${c.action} 거부 — 오너 승인 대기 (${open.id})`);
    return { ...base, allowed: false, reason: 'approval-pending', approvalId: open.id };
  }

  // 승인된 카드 → 소비를 시도한다. 소비가 실패하는 경우가 실제로 있다:
  // 유예 창이 안 끝났거나(cooling), 승인 이후 페이로드가 바뀌었거나(digest-mismatch).
  const outcome = approvals.consume(open.id, input.payloadDigest);
  if (outcome.allowed) {
    record('gate.verdict', `${c.action} 인가 — 승인 소비 (${open.id})`);
    return { ...base, allowed: true, reason: 'approved', approvalId: open.id };
  }

  const reason: GateReason = outcome.reason ?? 'not-approved';
  record('deny', `${c.action} 거부 — ${reason}${outcome.detail ? ` (${outcome.detail})` : ''}`);
  return {
    ...base,
    allowed: false,
    reason,
    approvalId: open.id,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}
