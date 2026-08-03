/**
 * 지표 수집 계약 (R11.6, R7.6)
 *
 * 발행 어댑터(`publish/types.ts`)와 **따로 둔다.** 읽기와 쓰기는 준비 조건도
 * 위험도 다르다 — 스마트스토어는 읽기만 하고 발행하지 않으며, 반대로 쓰레드는
 * 발행 토큰과 읽기 권한의 범위가 다르다. 한 인터페이스에 묶으면 한쪽 때문에
 * 다른 쪽이 막힌다.
 *
 * **Z1 → Z2 경계가 여기서 집행된다 (R7.6).** 채널에서 읽은 것 중 좌석으로
 * 넘어가는 것은 집계값뿐이다. 어댑터가 원본 레코드를 돌려주더라도 브로커가
 * 접어서 내보낸다 — 어댑터를 믿지 않는 것이 아니라, 경계를 한 곳에서
 * 집행해야 다음 어댑터가 생겨도 같은 규칙이 적용되기 때문이다.
 */

import type { Channel } from '../verbs/types.js';
import type { Aggregate } from '../publish/aggregate.js';

export interface MetricsWindow {
  /** ISO 날짜. 포함. */
  from: string;
  /** ISO 날짜. 포함. */
  to: string;
}

export interface MetricsResult {
  channel: Channel;
  window: MetricsWindow;
  /** 좌석으로 넘어가도 되는 집계값 (R7.6). */
  aggregate: Aggregate;
  /** 경계에서 막힌 필드 이름. **값은 담지 않는다.** */
  dropped: string[];
  /** 수집하지 못한 지표 이름. 0 으로 채우지 않는다 (R11.6). */
  uncollected: string[];
  /** 린트를 통과한 메모만 담긴다. */
  notes: string[];
  /**
   * 린트에 걸려 버려진 메모의 설명. 종류·위치·길이만 담고 **값은 없다** (R15.6).
   */
  flagged: string[];
}

export type MetricsFailure = 'not-configured' | 'adapter-failed' | 'unsupported-channel';

export type MetricsOutcome =
  | { ok: true; result: MetricsResult }
  | { ok: false; reason: MetricsFailure; detail: string; checklist: string[] };

/**
 * 지표 어댑터.
 *
 * `read` 는 **원본을 돌려줘도 된다.** 브로커가 집계 경계를 적용하므로
 * 어댑터가 그 책임을 지지 않는다 — 어댑터마다 경계를 다시 구현하면
 * 하나가 빠뜨렸을 때 아무도 모른다.
 */
export interface MetricsAdapter {
  readonly channel: Channel;
  readonly path: 'api' | 'hands';
  ready(): { ok: true } | { ok: false; reason: string; checklist: string[] };
  /** 이 채널이 낼 수 있는 지표 이름. 복기가 무엇을 기대할 수 있는지 알린다. */
  readonly metrics: readonly string[];
  read(
    window: MetricsWindow,
  ): Promise<{ ok: true; raw: unknown; notes?: string[] } | { ok: false; detail: string; checklist: string[] }>;
}
