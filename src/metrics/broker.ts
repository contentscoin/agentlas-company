/**
 * 지표 브로커 — 경계를 한 곳에서 집행한다 (R7.6, R11.6)
 *
 * 어댑터가 무엇을 돌려주든 여기서 접는다. 어댑터마다 집계 경계를 구현하게
 * 두면 하나가 빠뜨렸을 때 아무도 모르고, 새 채널이 붙을 때마다 같은 실수를
 * 반복할 자리가 생긴다.
 *
 * **막힌 필드는 이름만 원장에 남긴다.** 값을 남기면 원장이 PII 저장소가
 * 된다 — `zones/lint.ts` 와 같은 규칙이다.
 *
 * **수집하지 못한 것을 0 으로 채우지 않는다.** 채널이 지표를 못 주는 것과
 * 그 지표가 0 인 것은 다른 사실이고, 복기가 그 둘을 섞으면 레시피를 잘못
 * 고친다 (`assurance/retro.ts` 참조).
 */

import type { Ledger } from '../ledger/ledger.js';
import type { Channel } from '../verbs/types.js';
import { foldOrders, toAggregate } from '../publish/aggregate.js';
import { describeFinding, lint } from '../zones/lint.js';
import type {
  MetricsAdapter,
  MetricsOutcome,
  MetricsResult,
  MetricsWindow,
} from './types.js';

export interface MetricsBrokerOptions {
  ledger: Ledger;
  adapters: MetricsAdapter[];
}

/**
 * 원본을 집계로 접는다.
 *
 * 배열이면 주문 목록으로 보고 건수·매출로 접는다. 객체면 필드 화이트리스트로
 * 거른다. 둘 다 아니면 빈 집계다 — 모르는 모양을 추측해 파싱하지 않는다.
 */
export function foldRaw(raw: unknown): { aggregate: MetricsResult['aggregate']; dropped: string[] } {
  if (Array.isArray(raw)) return foldOrders(raw);
  return toAggregate(raw);
}

export class MetricsBroker {
  private readonly ledger: Ledger;
  private readonly byChannel: Map<Channel, MetricsAdapter>;

  constructor(opts: MetricsBrokerOptions) {
    this.ledger = opts.ledger;
    this.byChannel = new Map(opts.adapters.map((a) => [a.channel, a]));
  }

  /** 이 채널이 낼 수 있는 지표 이름. 복기가 무엇을 기대할지 정하는 데 쓴다. */
  available(channel: Channel): readonly string[] {
    return this.byChannel.get(channel)?.metrics ?? [];
  }

  async read(channel: Channel, window: MetricsWindow): Promise<MetricsOutcome> {
    const adapter = this.byChannel.get(channel);
    if (!adapter) {
      return {
        ok: false,
        reason: 'unsupported-channel',
        detail: `${channel} 지표 어댑터가 없다`,
        checklist: [`${channel} 지표를 수동으로 확인하세요`],
      };
    }

    const ready = adapter.ready();
    if (!ready.ok) {
      return { ok: false, reason: 'not-configured', detail: ready.reason, checklist: ready.checklist };
    }

    const read = await adapter.read(window);
    if (!read.ok) {
      this.ledger.append({
        actor: { kind: 'system', id: 'metrics' },
        kind: 'deny',
        summary: `${channel} 지표 수집 실패 — ${read.detail}`,
      });
      return { ok: false, reason: 'adapter-failed', detail: read.detail, checklist: read.checklist };
    }

    // 경계 집행. 어댑터가 원본을 줬어도 여기서 접힌다 (R7.6).
    const { aggregate, dropped } = foldRaw(read.raw);

    // `notes` 는 좌석까지 가는 유일한 자유 텍스트다 — 집계 화이트리스트가
    // 걸러 주지 않는다. 인제스트 경로에도 린트를 물린다 (R15.5).
    // 걸리면 그 줄을 통째로 버린다: 어디가 문제인지 표시하려면 값의 위치를
    // 남겨야 하고, 그것이 곧 값을 가리키는 지도가 된다.
    const notes: string[] = [];
    const flagged: string[] = [];
    for (const note of read.notes ?? []) {
      const found = lint(note, channel);
      if (found.ok) notes.push(note);
      else flagged.push(...found.findings.map(describeFinding));
    }

    // 낼 수 있다고 선언했는데 안 나온 지표. 0 으로 채우지 않는다.
    const uncollected = adapter.metrics.filter((m) => aggregate[m as never] === undefined);

    this.ledger.append({
      actor: { kind: 'system', id: 'metrics' },
      kind: 'ingest',
      summary:
        `${channel} 지표 ${Object.keys(aggregate).length}건 수집` +
        (dropped.length > 0 ? `, 경계에서 ${dropped.length}필드 차단` : '') +
        (uncollected.length > 0 ? `, 미수집 ${uncollected.length}건` : '') +
        (flagged.length > 0 ? `, 린트로 메모 ${flagged.length}건 폐기` : ''),
      // 이름과 위치만 남긴다. 값은 원장에 들어가지 않는다 (R15.6).
      evidence: [...dropped.map((d) => `dropped:${d}`), ...flagged],
    });

    return {
      ok: true,
      result: {
        channel,
        window,
        aggregate,
        dropped,
        uncollected,
        notes,
        flagged,
      },
    };
  }
}
