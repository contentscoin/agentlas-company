/**
 * 채용 (R13)
 *
 * 순서가 설계다.
 *
 *   1. 예산 확인      좌석이 감당 못 하면 거부하고 재배분 안을 낸다   R13.5
 *   2. 게이트         채용은 L3 다. 승인 없이 활성화되지 않는다      R13.4
 *   3. 확보           Hub 차용 또는 자체 생성                       R13.1
 *   4. 핀             digest 를 vendor.lock 에                     R13.2
 *   5. 권한           차용은 무권한에서 시작                        R13.3
 *
 * **예산이 게이트보다 앞이다.** 뒤에 두면 감당 못 할 채용에 오너가 승인
 * 버튼을 누르고, 그 다음에야 안 된다는 말을 듣는다. 승인은 오너의 시간이고
 * 기계가 먼저 답할 수 있는 것은 기계가 답해야 한다.
 *
 * **Hub 차용 자체는 desktop 이 한다.** company 는 무엇을 들일지 판정하고
 * 기록한다 — 통제와 실행의 분업 그대로다. 여기서 `acquire` 를 주입점으로
 * 둔 이유가 그것이고, 실제 구현은 desktop 의 게이트 훅(Task 16.0)이
 * `company gate` 를 부르는 방향으로 붙는다.
 */

import { createHash } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.js';
import type { ApprovalService } from '../policy/approval.js';
import type { PolicyConfig } from '../policy/types.js';
import { resolveGate } from '../policy/gate.js';
import type { HireRequest } from '../org/protocol.js';
import { defaultBorrowedPermissions, defaultBuiltPermissions } from './permissions.js';
import { pinBorrowed, readBorrowed, writeLock, type BorrowedAgent } from './lock.js';

/** 채용 대상의 digest. 승인은 이 값에 묶인다 (R4.6). */
export function hireDigest(req: HireRequest, packageHash?: string): string {
  return createHash('sha256')
    .update('agentlas:hire:v1\0')
    .update(JSON.stringify({ mode: req.mode, target: req.target, packageHash: packageHash ?? null }))
    .digest('hex');
}

export interface SeatBudget {
  /** 동시에 앉힐 수 있는 에이전트 수. 좌석 실측에서 나온다. */
  capacity: number;
  /** 지금 자리를 차지한 에이전트. 임원 상수 + 차용 목록. */
  occupied: number;
}

export interface BudgetVerdict {
  ok: boolean;
  detail: string;
  /** 초과 시 재배분 안 (R13.5). 거부만 하지 않는다. */
  proposal: string[];
}

/**
 * 예산을 확인한다 (R13.5).
 *
 * 거부만 하고 끝내지 않는다 — 요구사항이 "재배분 안을 제시" 라고 적은 것은,
 * 채용이 막힌 회의에 다음 수를 주기 위해서다. 안을 못 내면 회의가 같은
 * 결정을 반복한다.
 */
export function checkBudget(budget: SeatBudget, borrowed: readonly BorrowedAgent[]): BudgetVerdict {
  const free = budget.capacity - budget.occupied;
  if (free > 0) {
    return { ok: true, detail: `여유 ${free}자리 (${budget.occupied}/${budget.capacity})`, proposal: [] };
  }

  const proposal = [
    `좌석 정원 ${budget.capacity} 을 이미 채웠습니다 (${budget.occupied}명).`,
    '아래 중 하나를 고르세요:',
    '  1. 좌석을 늘린다 — 미검증 좌석을 가동하면 정원이 늘어납니다 (company seats)',
  ];
  if (borrowed.length > 0) {
    // 가장 오래 전에 들인 차용 패키지를 후보로 든다. 우리가 만든 임원보다
    // 남의 패키지를 먼저 내보내는 편이 안전한 방향이다.
    const oldest = [...borrowed].sort((a, b) => a.at.localeCompare(b.at))[0];
    proposal.push(
      `  2. 차용 패키지를 내보낸다 — 가장 오래된 것은 ${oldest?.id} (${oldest?.at.slice(0, 10)})`,
    );
  } else {
    proposal.push('  2. 기존 임원 중 하나를 쉬게 한다 — 차용 패키지는 아직 없습니다');
  }
  proposal.push('  3. 이번 채용을 미룬다');

  return { ok: false, detail: `정원 초과 (${budget.occupied}/${budget.capacity})`, proposal };
}

export type HireFailure = 'budget' | 'gate-denied' | 'acquire-failed' | 'pin-failed';

export interface HireResult {
  ok: boolean;
  request: HireRequest;
  reason?: HireFailure;
  detail?: string;
  proposal?: string[];
  agent?: BorrowedAgent;
  approvalId?: string;
}

/** Hub 에서 패키지를 가져오는 주입점. 실제 확보는 desktop 이 한다. */
export type Acquire = (
  req: HireRequest,
) => Promise<{ ok: true; packageHash: string } | { ok: false; reason: string }>;

export interface HireOptions {
  ledger: Ledger;
  approvals: ApprovalService;
  policy: PolicyConfig;
  /** `vendor.lock` 경로. */
  lockFile: string;
  budget: SeatBudget;
  acquire: Acquire;
  now?: () => number;
}

export class HireBroker {
  private readonly opts: HireOptions;

  constructor(opts: HireOptions) {
    this.opts = opts;
  }

  private fail(
    req: HireRequest,
    reason: HireFailure,
    detail: string,
    extra: { proposal?: string[]; approvalId?: string } = {},
  ): HireResult {
    this.opts.ledger.append({
      actor: { kind: 'system', id: 'hire' },
      kind: 'deny',
      summary: `채용 거부 — ${reason}: ${detail} (${req.mode} ${req.target})`,
    });
    return { ok: false, request: req, reason, detail, ...extra };
  }

  async hire(req: HireRequest, lockText: string): Promise<HireResult> {
    const borrowed = readBorrowed(lockText);

    // 1 — 예산. 오너 승인을 요청하기 전에 기계가 답할 수 있는 것을 답한다.
    const budget = checkBudget(this.opts.budget, borrowed);
    if (!budget.ok) {
      return this.fail(req, 'budget', budget.detail, { proposal: budget.proposal });
    }

    // 2 — 게이트. 채용은 L3 다 (R13.4).
    //
    // digest 를 패키지 해시 없이 먼저 만든다. 확보 전이라 해시를 모르는데,
    // 그래서 확보 후 해시가 다르면 4단계 핀에서 다시 걸린다 — 승인은
    // "이 대상을 들인다" 에 묶이고, 내용 검증은 핀이 맡는다.
    const digest = hireDigest(req);
    const decision = resolveGate(
      { policy: this.opts.policy, approvals: this.opts.approvals, ledger: this.opts.ledger },
      {
        action: 'hire',
        payloadDigest: digest,
        summary: `채용 ${req.mode} ${req.target} — ${req.reason}`,
      },
    );
    if (!decision.allowed) {
      return this.fail(req, 'gate-denied', decision.reason, {
        ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      });
    }

    // 3 — 확보. 실제 차용은 desktop 이 한다.
    const acquired = await this.opts.acquire(req);
    if (!acquired.ok) {
      return this.fail(req, 'acquire-failed', acquired.reason);
    }

    // 4·5 — 핀과 권한. 차용은 무권한에서 시작한다 (R13.3).
    const agent: BorrowedAgent = {
      id: req.target,
      digest: acquired.packageHash,
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
      approvalId: decision.approvalId ?? 'consumed',
      permissions:
        req.mode === 'borrow' ? defaultBorrowedPermissions() : defaultBuiltPermissions(),
      reason: req.reason,
    };

    const pinned = pinBorrowed(lockText, agent);
    if (!pinned.ok) {
      return this.fail(req, 'pin-failed', pinned.reason);
    }
    writeLock(this.opts.lockFile, pinned.agents);

    this.opts.ledger.append({
      actor: { kind: 'owner', id: 'owner' },
      kind: 'decision',
      level: 'L3',
      payloadDigest: acquired.packageHash,
      summary:
        `채용 완료 — ${req.mode} ${req.target}, 권한 ` +
        `[${agent.permissions.granted.join(', ') || '없음'}]`,
    });

    return { ok: true, request: req, agent, ...(decision.approvalId ? { approvalId: decision.approvalId } : {}) };
  }
}
