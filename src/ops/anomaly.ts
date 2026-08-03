/**
 * 이상 탐지 (R17.5)
 *
 * 원장을 읽어 "평소와 다른" 것을 찾는다. 두 가지를 본다.
 *
 *   거부 급증   `deny` 가 갑자기 몰린다 — 무언가가 반복해서 벽을 두드린다
 *   볼륨 이상   발행·좌석 호출이 평소보다 많다 — 폭주하거나 조종당하고 있다
 *
 * **기준선은 원장에서 가져온다.** 상수로 박으면 회사가 커질 때마다 오탐이
 * 늘고, 그러면 사람이 경보를 끈다. 최근 창과 그 이전 창을 비교한다.
 *
 * **읽지 못하면 이상으로 본다.** 원장을 못 읽는 상태는 정상이 아니고,
 * "판단할 수 없으니 통과" 는 감시의 반대다. 이 모듈에서 가장 중요한 줄이다.
 *
 * 정지는 능력 스위치 전체 차단(R8.10)을 재사용한다. 새 정지 메커니즘을
 * 만들지 않는 이유는, 두 개가 되면 하나만 걸리는 상태가 생기기 때문이다.
 */

import type { LedgerEvent } from '../ledger/types.js';

export type AnomalyKind = 'deny-surge' | 'volume-surge' | 'ledger-unreadable';

export interface Anomaly {
  kind: AnomalyKind;
  detail: string;
  /** 정지까지 갈 일인가. 경고만 할 것과 구분한다. */
  halt: boolean;
}

export interface AnomalyThresholds {
  /** 최근 창 길이(밀리초). */
  windowMs: number;
  /** 이 배수를 넘으면 급증으로 본다. */
  surgeRatio: number;
  /** 배수와 무관하게 이 건수를 넘으면 급증이다. 시작 직후의 0 기준선을 다룬다. */
  absoluteDeny: number;
  absoluteVolume: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  windowMs: 60 * 60_000,
  surgeRatio: 3,
  // 한 시간에 거부 20건은 정상 운영에서 나오지 않는다. 무언가 반복 시도 중이다.
  absoluteDeny: 20,
  absoluteVolume: 100,
};

const VOLUME_KINDS = new Set(['publish', 'seat.call', 'hands.step']);

/**
 * 두 창을 비교해 급증인지 본다.
 *
 * 이전 창이 0 일 때 배수는 무한대가 된다. 그래서 절대 기준을 함께 둔다 —
 * 배수만 쓰면 회사를 처음 켠 날 모든 것이 이상이 되고, 절대 기준만 쓰면
 * 규모가 커진 뒤 아무것도 안 걸린다.
 */
export function isSurge(
  recent: number,
  previous: number,
  ratio: number,
  absolute: number,
): boolean {
  if (recent >= absolute) return true;
  if (previous === 0) return false;
  return recent / previous >= ratio;
}

export interface AnomalyReport {
  anomalies: Anomaly[];
  /** 하나라도 halt 면 참. 실행을 멈춰야 한다. */
  shouldHalt: boolean;
  counts: { recentDeny: number; previousDeny: number; recentVolume: number; previousVolume: number };
}

/**
 * 원장을 검사한다.
 *
 * `events` 는 최근 것부터든 오래된 것부터든 상관없다 — 시각으로 나눈다.
 */
export function detectAnomalies(
  events: readonly LedgerEvent[],
  now: number,
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): AnomalyReport {
  const recentFrom = now - thresholds.windowMs;
  const previousFrom = now - thresholds.windowMs * 2;

  let recentDeny = 0;
  let previousDeny = 0;
  let recentVolume = 0;
  let previousVolume = 0;

  for (const e of events) {
    const at = Date.parse(e.at);
    if (Number.isNaN(at)) continue;
    const inRecent = at >= recentFrom && at <= now;
    const inPrevious = at >= previousFrom && at < recentFrom;
    if (!inRecent && !inPrevious) continue;

    if (e.kind === 'deny') {
      if (inRecent) recentDeny += 1;
      else previousDeny += 1;
    }
    if (VOLUME_KINDS.has(e.kind)) {
      if (inRecent) recentVolume += 1;
      else previousVolume += 1;
    }
  }

  const anomalies: Anomaly[] = [];

  if (isSurge(recentDeny, previousDeny, thresholds.surgeRatio, thresholds.absoluteDeny)) {
    anomalies.push({
      kind: 'deny-surge',
      detail: `거부 ${recentDeny}건 (직전 창 ${previousDeny}건)`,
      // 거부 급증은 정지 대상이다. 무언가가 반복해서 벽을 두드리고 있고,
      // 그 벽이 언제까지 버틸지는 우리가 알 수 없다.
      halt: true,
    });
  }

  if (isSurge(recentVolume, previousVolume, thresholds.surgeRatio, thresholds.absoluteVolume)) {
    anomalies.push({
      kind: 'volume-surge',
      detail: `실행 ${recentVolume}건 (직전 창 ${previousVolume}건)`,
      halt: true,
    });
  }

  return {
    anomalies,
    shouldHalt: anomalies.some((a) => a.halt),
    counts: { recentDeny, previousDeny, recentVolume, previousVolume },
  };
}

/**
 * 원장을 읽지 못한 경우.
 *
 * 별도 함수로 둔 이유는 호출자가 이 경로를 빼먹기 쉽기 때문이다 —
 * `try/catch` 의 `catch` 에서 빈 배열을 넘기면 "이상 없음" 이 되고,
 * 그것이 정확히 감시가 무력화되는 방식이다.
 */
export function unreadableLedger(detail: string): AnomalyReport {
  return {
    anomalies: [
      {
        kind: 'ledger-unreadable',
        detail: `원장을 읽지 못했다 — ${detail}. 판단할 수 없는 것은 정상이 아니다`,
        halt: true,
      },
    ],
    shouldHalt: true,
    counts: { recentDeny: 0, previousDeny: 0, recentVolume: 0, previousVolume: 0 },
  };
}

export function describeAnomaly(a: Anomaly): string {
  return `${a.halt ? '정지' : '경고'} ${a.kind} — ${a.detail}`;
}
