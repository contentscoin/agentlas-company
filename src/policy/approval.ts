/**
 * 승인 서비스 (R4.5 ~ R4.12)
 *
 * 상태 기계로 만든 이유는 "만료가 통과로 새는" 경로를 타입 수준에서 없애기 위해서다.
 *
 *   pending ──approve──> approved ──cooling 종료──> consumed
 *      │                     │
 *      ├─reject──> rejected  └─abort──> aborted
 *      ├─만료────> expired          (= 취소. 통과가 아니다)
 *      └─내용변경─> invalidated
 *
 * `consume()` 는 `approved` 이고 digest 가 일치하고 유예 창이 끝난 경우에만
 * 허용을 돌려준다. 다른 모든 상태는 거부이며 이유가 함께 나온다.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Ledger } from '../ledger/ledger.js';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  Classification,
  ConsumeOutcome,
  PolicyConfig,
  Submitter,
} from './types.js';

export interface CreateInput {
  classification: Classification;
  payloadDigest: string;
  summary: string;
  runId?: string;
}

export type DeviceNotifier = (devices: string[], message: string, request: ApprovalRequest) => void;

export interface ApprovalOptions {
  policy: PolicyConfig;
  ledger: Ledger;
  file?: string;
  notify?: DeviceNotifier;
  now?: () => number;
}

export class ApprovalService {
  private readonly policy: PolicyConfig;
  private readonly ledger: Ledger;
  private readonly file: string | undefined;
  private readonly notify: DeviceNotifier;
  private readonly now: () => number;
  private requests = new Map<string, ApprovalRequest>();

  constructor(opts: ApprovalOptions) {
    this.policy = opts.policy;
    this.ledger = opts.ledger;
    this.file = opts.file;
    this.notify = opts.notify ?? ((): void => {});
    this.now = opts.now ?? Date.now;
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { requests?: ApprovalRequest[] };
      for (const r of raw.requests ?? []) this.requests.set(r.id, r);
    } catch {
      // 손상된 승인 저장소는 "승인 없음" 으로 해석한다.
      // 승인이 있었다고 추정하는 것보다 안전한 방향이다.
      this.requests = new Map();
    }
  }

  private persist(): void {
    if (!this.file) return;
    writeFileSync(this.file, JSON.stringify({ requests: [...this.requests.values()] }, null, 2), 'utf8');
  }

  /** 만료를 정리한다. 만료는 취소이며 통과가 아니다 (R4.7). */
  private sweep(): void {
    const nowMs = this.now();
    let changed = false;
    for (const r of this.requests.values()) {
      if (r.status !== 'pending') continue;
      if (Date.parse(r.expiresAt) <= nowMs) {
        r.status = 'expired';
        r.closedReason = '승인 카드 만료 — 요청을 취소했다. 만료는 통과가 아니다';
        changed = true;
        this.ledger.append({
          actor: { kind: 'system', id: 'approval-service' },
          kind: 'approval',
          level: r.level,
          summary: `${r.action} 취소 — ${r.closedReason}`,
        });
      }
    }
    if (changed) this.persist();
  }

  /** 승인 카드를 만든다. L0/L1 은 카드가 필요 없으므로 호출자가 걸러야 한다. */
  create(input: CreateInput): ApprovalRequest {
    this.sweep();
    const nowMs = this.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      action: input.classification.action,
      level: input.classification.level,
      payloadDigest: input.payloadDigest,
      summary: input.summary,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.policy.approval.cardTtlMs).toISOString(),
      irreversible: input.classification.irreversible,
      status: 'pending',
    };
    this.requests.set(request.id, request);
    this.persist();

    this.ledger.append({
      actor: { kind: 'system', id: 'approval-service' },
      kind: 'approval',
      level: request.level,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      payloadDigest: input.payloadDigest,
      summary: `승인 요청 ${request.action} (${request.level}) — 만료 ${request.expiresAt}`,
    });

    this.notify(this.policy.devices, `승인 요청: ${request.summary}`, request);
    return request;
  }

  get(id: string): ApprovalRequest | undefined {
    this.sweep();
    return this.requests.get(id);
  }

  pending(): ApprovalRequest[] {
    this.sweep();
    return [...this.requests.values()].filter((r) => r.status === 'pending');
  }

  /**
   * 승인한다.
   *
   * 검사 순서: 존재 → 상태 → 신원 허용목록 → 단계별 인증 → digest 일치.
   * 신원을 인증보다 먼저 보는 이유는, 허용목록에 없는 주체의 시도는
   * 인증 성공 여부와 무관하게 기록해야 할 사건이기 때문이다.
   */
  approve(id: string, by: Submitter, payloadDigest: string): ApprovalOutcome {
    this.sweep();
    const request = this.requests.get(id);
    if (!request) return { ok: false, request: missing(id), reason: '없는 승인 요청' };
    if (request.status !== 'pending') {
      return { ok: false, request, reason: `이미 ${request.status} 상태다` };
    }

    // R4.8 — 제출 주체가 등록된 오너 신원인가
    if (!this.policy.ownerIdentities.includes(by.identity)) {
      this.deny(request, `허용목록에 없는 신원의 승인 시도 (${by.identity})`);
      return { ok: false, request, reason: '허용되지 않은 신원' };
    }

    // R4.9 — L3 은 단계별 인증을 통과한 제출만 인정한다
    if (request.level === 'L3' && !by.stepUp) {
      this.deny(request, 'L3 승인에 단계별 인증이 없다');
      return { ok: false, request, reason: 'L3 은 단계별 인증이 필요하다' };
    }

    // R4.5 / R4.6 — 승인은 정확한 페이로드에 묶인다
    if (request.payloadDigest !== payloadDigest) {
      request.status = 'invalidated';
      request.closedReason = '승인 대상 페이로드가 바뀌었다';
      this.persist();
      this.deny(request, request.closedReason);
      return { ok: false, request, reason: 'digest 불일치' };
    }

    const nowMs = this.now();
    request.status = 'approved';
    request.decidedBy = {
      identity: by.identity,
      device: by.device,
      at: new Date(nowMs).toISOString(),
      stepUp: by.stepUp,
    };
    // R4.11 — 비가역 작업은 유예 창을 둔다
    request.executeAfter = new Date(
      nowMs + (request.irreversible ? this.policy.approval.coolingWindowMs : 0),
    ).toISOString();
    this.persist();

    this.ledger.append({
      actor: { kind: 'owner', id: by.identity },
      kind: 'approval',
      level: request.level,
      payloadDigest: request.payloadDigest,
      summary: `승인 완료 ${request.action} — 기기 ${by.device}, 인증 ${by.stepUp ? '통과' : '없음'}${
        request.irreversible ? `, 유예 창 종료 ${request.executeAfter}` : ''
      }`,
    });

    // R4.10 — 승인한 기기를 제외한 다른 등록 기기에 알린다
    const others = this.policy.devices.filter((d) => d !== by.device);
    if (others.length > 0) {
      this.notify(others, `${by.device} 에서 ${request.level} 승인이 발생했습니다: ${request.summary}`, request);
    }
    return { ok: true, request };
  }

  reject(id: string, by: Submitter, reason = '오너 거부'): ApprovalOutcome {
    this.sweep();
    const request = this.requests.get(id);
    if (!request) return { ok: false, request: missing(id), reason: '없는 승인 요청' };
    if (request.status !== 'pending') return { ok: false, request, reason: `이미 ${request.status} 상태다` };

    request.status = 'rejected';
    request.closedReason = reason;
    request.decidedBy = {
      identity: by.identity,
      device: by.device,
      at: new Date(this.now()).toISOString(),
      stepUp: by.stepUp,
    };
    this.persist();
    this.ledger.append({
      actor: { kind: 'owner', id: by.identity },
      kind: 'approval',
      level: request.level,
      summary: `거부 ${request.action} — ${reason} (기기 ${by.device})`,
    });
    return { ok: true, request };
  }

  /**
   * 유예 창 안에서 중단한다 (R4.11).
   * 등록된 어떤 기기든 부를 수 있다 — 잘못 누른 승인을 되돌리는 마지막 기회다.
   */
  abort(id: string, by: { identity: string; device: string }, reason = '유예 창 중단'): ApprovalOutcome {
    this.sweep();
    const request = this.requests.get(id);
    if (!request) return { ok: false, request: missing(id), reason: '없는 승인 요청' };
    if (request.status !== 'approved') return { ok: false, request, reason: `${request.status} 상태는 중단할 수 없다` };

    request.status = 'aborted';
    request.closedReason = reason;
    this.persist();
    this.ledger.append({
      actor: { kind: 'owner', id: by.identity },
      kind: 'approval',
      level: request.level,
      summary: `중단 ${request.action} — ${reason} (기기 ${by.device})`,
    });
    return { ok: true, request };
  }

  /** 유예 창이 끝났는지. */
  coolingRemainingMs(id: string): number | null {
    const r = this.requests.get(id);
    if (!r || r.status !== 'approved' || !r.executeAfter) return null;
    return Math.max(0, Date.parse(r.executeAfter) - this.now());
  }

  /**
   * 실행 인가를 소비한다. 한 번만 쓸 수 있다.
   *
   * 재사용을 막는 이유: 승인 하나로 같은 위험 작업을 여러 번 실행하는 경로를
   * 남기면 "개별 실행마다 승인" (R8.6) 이 무의미해진다.
   */
  consume(id: string, payloadDigest: string): ConsumeOutcome {
    this.sweep();
    const request = this.requests.get(id);
    if (!request) return { allowed: false, reason: 'not-found' };

    if (request.status === 'consumed') return { allowed: false, reason: 'already-consumed', request };
    if (request.status === 'aborted') return { allowed: false, reason: 'aborted', request };
    if (request.status === 'expired') return { allowed: false, reason: 'expired', request };
    // 거부와 무효는 종단 상태다. 대기로 해석하면 레시피가 영원히 재개를 시도한다.
    if (request.status === 'rejected') return { allowed: false, reason: 'rejected', request };
    if (request.status === 'invalidated') return { allowed: false, reason: 'digest-mismatch', request };
    if (request.status !== 'approved') return { allowed: false, reason: 'not-approved', request };

    if (request.payloadDigest !== payloadDigest) {
      request.status = 'invalidated';
      request.closedReason = '실행 시점에 페이로드가 달랐다';
      this.persist();
      this.deny(request, request.closedReason);
      return { allowed: false, reason: 'digest-mismatch', request };
    }

    const remaining = this.coolingRemainingMs(id) ?? 0;
    if (remaining > 0) {
      return { allowed: false, reason: 'cooling', detail: `${remaining}ms 남음`, request };
    }

    request.status = 'consumed';
    this.persist();
    return { allowed: true, request };
  }

  private deny(request: ApprovalRequest, detail: string): void {
    this.ledger.append({
      actor: { kind: 'system', id: 'approval-service' },
      kind: 'deny',
      level: request.level,
      summary: `${request.action} 승인 거부 — ${detail}`,
    });
  }
}

function missing(id: string): ApprovalRequest {
  return {
    id,
    action: '(unknown)',
    level: 'L3',
    payloadDigest: '',
    summary: '',
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(0).toISOString(),
    irreversible: true,
    status: 'expired',
    closedReason: '존재하지 않는 요청',
  };
}
