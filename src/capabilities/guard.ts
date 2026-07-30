/**
 * 능력 게이트 — 집행 순서 (R8)
 *
 * design.md 가 고정한 7단계를 그대로 구현한다.
 * 하나라도 실패하면 실행되지 않고, 거부는 반드시 원장에 남는다.
 *
 *   1. 스위치 ON 확인          OFF 면 거부                       R8.3
 *   2. 유효기간 확인           만료면 OFF 복귀 후 거부            R8.5
 *   3. 범위 확인               대상이 scope 밖이면 거부           R8.12
 *   4. tainted 확인            오염이면 ON 이어도 거부            R16.5
 *   5. L3 개별 승인 확인       digest 바인딩 검증                R8.6, R4.5
 *   6. 유예 창 대기            중단 신호가 오면 취소              R4.11
 *   7. 실행 + 증거 기록
 *
 * 이 파일은 1~5 를 담당한다. 6(유예 창)은 정책 게이트(Task 7)가,
 * 7(실행)은 Hands 계층(Task 10)이 맡는다.
 *
 * 순서가 설계다. tainted 검사가 승인보다 **앞**에 있는 것이 핵심이다.
 * 오염된 산출물은 오너가 승인 버튼을 눌러도 통과하지 못한다.
 */

import type { Ledger } from '../ledger/ledger.js';
import type { CapabilityStore } from './store.js';
import type { Caller, CapabilityRequest, CapabilityState, GuardDecision } from './types.js';

export interface GuardOptions {
  store: CapabilityStore;
  ledger: Ledger;
  now?: () => number;
}

export class CapabilityGuard {
  private readonly store: CapabilityStore;
  private readonly ledger: Ledger;
  private readonly now: () => number;

  constructor(opts: GuardOptions) {
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 위험 능력 사용을 검사한다.
   *
   * 호출자는 브로커 구역이다. 좌석은 이 함수를 직접 부르지 않고
   * 타입 지정된 동사 호출로 브로커에 요청한다 — 자연어 지시가
   * 실행 경로로 들어오는 문을 만들지 않기 위해서다 (R8.9, R16.7).
   */
  check(caller: Caller, req: CapabilityRequest): GuardDecision {
    const decision = this.evaluate(caller, req);
    if (!decision.allowed) {
      this.ledger.append({
        actor: { kind: caller.zone === 'seat' ? 'agent' : 'system', id: caller.id },
        kind: 'deny',
        level: 'L3',
        ...(req.tainted !== undefined ? { tainted: req.tainted } : {}),
        summary: `${req.capability} 거부 — ${decision.reason}${decision.detail ? `: ${decision.detail}` : ''}`,
      });
    }
    return decision;
  }

  private evaluate(caller: Caller, req: CapabilityRequest): GuardDecision {
    let state: CapabilityState;
    try {
      // 브로커 구역으로 읽는다. 좌석이 스위치를 직접 읽는 경로는 없다.
      state = this.store.get({ zone: 'broker', id: caller.id }, req.capability);
    } catch (err) {
      return { allowed: false, reason: 'zone-forbidden', detail: (err as Error).message };
    }

    // 1 · 2 — 스위치와 유효기간. store.get 이 만료·재부팅을 이미 OFF 로 접었다.
    if (!state.enabled) {
      return { allowed: false, reason: 'switch-off', detail: '기본 차단 상태' };
    }
    if (state.expiresAt !== null && Date.parse(state.expiresAt) <= this.now()) {
      return { allowed: false, reason: 'expired', detail: `만료 ${state.expiresAt}` };
    }

    // 3 — 범위. 범위가 지정되어 있으면 대상이 그 안이어야 한다.
    if (state.scope.channels.length > 0) {
      if (req.channel === undefined || !state.scope.channels.includes(req.channel)) {
        return {
          allowed: false,
          reason: 'out-of-scope',
          detail: `채널 ${req.channel ?? '(없음)'} 은 허용 범위 [${state.scope.channels.join(',')}] 밖`,
        };
      }
    }
    if (state.scope.accounts.length > 0) {
      if (req.account === undefined || !state.scope.accounts.includes(req.account)) {
        return {
          allowed: false,
          reason: 'out-of-scope',
          detail: `계정 ${req.account ?? '(없음)'} 은 허용 범위 밖`,
        };
      }
    }

    // 4 — 오염. 스위치가 ON 이어도 막는다 (R16.5).
    // 인젝션이 성공해도 위험 능력까지 도달하지 못하게 하는 마지막 구조적 방어다.
    if (req.tainted === true) {
      return {
        allowed: false,
        reason: 'tainted',
        detail: '오염된 산출물은 스위치가 ON 이어도 위험 능력을 쓸 수 없다',
      };
    }

    // 5 — L3 개별 승인. 스위치는 전제조건이지 대체물이 아니다 (R8.6).
    if (!req.approval) {
      return { allowed: false, reason: 'no-approval', detail: '스위치 ON 은 승인을 대체하지 않는다' };
    }
    if (req.payloadDigest !== undefined && req.approval.digest !== req.payloadDigest) {
      return {
        allowed: false,
        reason: 'approval-digest-mismatch',
        detail: '승인 후 페이로드가 바뀌었다. 영수증은 무효다',
      };
    }

    return { allowed: true };
  }
}
