/**
 * 부팅 복귀 점검 (R17.1, R17.2, R17.3)
 *
 * 재부팅 후 회사가 스스로 출근했는지 확인한다. 세 가지를 본다.
 *
 *   원장 무손실     해시체인이 온전한가                   R17.2
 *   스위치 전부 OFF  재부팅으로 부여가 무효화됐는가        R17.3
 *   실행 표면       desktop 이 함께 떴는가                 (Task 10·14 의존)
 *
 * **desktop 확인을 여기 넣은 이유.** company 만 살아나고 desktop 이 안 뜨면
 * Hands 와 오피스 API 가 조용히 죽는다. 그 상태는 "정상 복귀" 처럼 보이는데
 * 실제로는 절반만 살아난 것이다 — 그 절반이 어느 쪽인지 부팅 시점에 알아야
 * 한다. 재정의(2026-08-02)가 이것을 명시했다.
 *
 * **R17.1(무인 복귀) 자체는 여기서 하지 않는다.** OS 스케줄러가 한다 —
 * R12.6 이 자체 supervisor 를 금지한다. 이 모듈은 복귀 **후** 무엇이
 * 온전한지 판정하고, 등록 명령문은 `company schedule` 이 낸다.
 */

import type { Ledger } from '../ledger/ledger.js';
import { currentBootId } from '../capabilities/store.js';
import type { CapabilityState } from '../capabilities/types.js';
import { inspectSurface, type Surface } from '../hands/locate.js';

export type HealthVerdict = 'ok' | 'degraded' | 'broken';

export interface HealthCheck {
  name: string;
  verdict: HealthVerdict;
  detail: string;
}

export interface HealthReport {
  at: string;
  checks: HealthCheck[];
  /** 하나라도 broken 이면 거짓. degraded 는 참이지만 알린다. */
  ok: boolean;
  /** 사람이 손대야 하는 것. */
  actions: string[];
}

export interface HealthOptions {
  ledger: Ledger;
  capabilities: CapabilityState[];
  /** 테스트가 표면을 대체할 수 있게 열어 둔다. */
  inspect?: () => Surface;
  now?: () => number;
  /** 현재 부팅 세션 식별자. 테스트가 고정할 수 있게 열어 둔다. */
  bootId?: () => string;
}

/**
 * 부팅 후 점검을 돈다.
 *
 * 판정이 셋인 이유는 `zones/verify.ts` 와 같다 — "확인했고 정상" 과
 * "확인했고 문제" 와 "일부만 살아남" 은 오너가 할 일이 각각 다르다.
 */
export function checkHealth(opts: HealthOptions): HealthReport {
  const checks: HealthCheck[] = [];
  const actions: string[] = [];

  // 1 — 원장 무손실 (R17.2). 이것이 깨졌으면 나머지 판정도 신뢰할 수 없다.
  const verify = opts.ledger.verify();
  if (verify.ok) {
    checks.push({
      name: '원장 무손실',
      verdict: 'ok',
      detail: `이벤트 ${verify.count}건, 체인 정상`,
    });
  } else {
    checks.push({
      name: '원장 무손실',
      verdict: 'broken',
      detail: `체인 손상 — 마지막 온전한 seq ${verify.lastGoodSeq}`,
    });
    actions.push(
      `원장이 손상됐습니다. seq ${verify.lastGoodSeq} 이후를 확인하세요 — company verify`,
      '백업에서 복구하기 전에 손상 구간을 보존하세요. 덮어쓰면 무슨 일이 있었는지 사라집니다',
    );
  }

  // 2 — 스위치 부팅 무효화 (R17.3).
  //
  // **가동 시간으로 판정하지 않는다.** 처음에는 "부팅 15분 안에 ON 이면
  // 위반" 으로 만들었는데, 오너가 부팅 5분 뒤에 정당하게 켠 것도 위반이 됐다.
  // 실측에서 바로 그 상태를 만들어 잡았다.
  //
  // 진짜 신호는 **부여가 어느 부팅 세션에서 났는가** 다. 이전 세션의 부여가
  // 아직 ON 이면 무효화 장치가 고장난 것이고, 이번 세션의 ON 은 오너가 켠
  // 것이라 정상이다. 스토어가 읽을 때 접으므로 정상 동작에서는 나올 수 없는
  // 상태인데 — 그것을 확인하는 것이 이 점검의 요점이다.
  const boot = (opts.bootId ?? currentBootId)();
  const on = opts.capabilities.filter((c) => c.enabled);
  const stale = on.filter((c) => c.bootId !== null && c.bootId !== boot);

  if (stale.length > 0) {
    checks.push({
      name: '능력 스위치',
      verdict: 'broken',
      detail:
        `이전 부팅 세션의 부여가 아직 ON 이다: ` +
        stale.map((c) => `${c.capability}(${c.bootId})`).join(', '),
    });
    actions.push(
      'company caps panic 으로 즉시 전부 차단하고, 부팅 세션 무효화가 왜 안 됐는지 확인하세요',
    );
  } else if (on.length === 0) {
    checks.push({
      name: '능력 스위치',
      verdict: 'ok',
      detail: `${opts.capabilities.length}종 전부 OFF`,
    });
  } else {
    checks.push({
      name: '능력 스위치',
      verdict: 'ok',
      detail: `${on.length}종 ON (${on.map((c) => c.capability).join(', ')}) — 이번 부팅 세션의 부여다`,
    });
  }

  // 3 — 실행 표면. 없으면 절반만 살아난 것이다.
  const surface = (opts.inspect ?? ((): Surface => inspectSurface({ requireDesktop: true })))();
  if (surface.ok) {
    checks.push({ name: '실행 표면', verdict: 'ok', detail: 'desktop·Chrome 확인됨' });
  } else {
    checks.push({
      name: '실행 표면',
      verdict: 'degraded',
      detail: surface.problems.join(', '),
    });
    actions.push(...surface.detail);
    actions.push('Hands 와 오피스 API 가 이 상태에서는 동작하지 않습니다');
  }

  const broken = checks.some((c) => c.verdict === 'broken');
  return {
    at: new Date(opts.now?.() ?? Date.now()).toISOString(),
    checks,
    ok: !broken,
    actions,
  };
}
