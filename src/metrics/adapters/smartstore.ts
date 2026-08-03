/**
 * 스마트스토어 지표 — Hands 경로 (R7.6)
 *
 * 이 어댑터가 R7.6 의 실제 시험대다. 스마트스토어 주문 화면에는 주문자
 * 이름·주소·연락처가 그대로 떠 있고, 그것이 좌석으로 넘어가면 고객 PII 가
 * 벤더 API 로 나간다.
 *
 * **이 어댑터는 원본을 그대로 돌려준다.** 경계 집행은 브로커가 한다 —
 * 어댑터마다 접으면 하나가 빠뜨렸을 때 아무도 모른다. 대신 여기서는
 * **화면에서 읽은 것을 구조화**하는 데만 집중한다.
 *
 * 다만 한 가지는 여기서 한다: **스냅샷 원문을 결과에 담지 않는다.** 접근성
 * 트리에는 고객 이름이 그대로 들어 있고, 그것을 `notes` 에 넣으면 브로커의
 * 경계를 우회해 좌석까지 간다. 경계는 한 곳이지만 **경계로 가는 길에
 * 원문을 흘리지 않는 것**은 각자의 책임이다.
 */

import type { Channel } from '../../verbs/types.js';
import type { HandsExecutor } from '../../hands/executor.js';
import type { HandsStep } from '../../hands/types.js';
import type { MetricsAdapter, MetricsWindow } from '../types.js';

export interface SmartstoreOptions {
  hands: HandsExecutor;
  /** 주문 통계 화면. 테스트가 로컬 페이지를 물릴 수 있게 열어 둔다. */
  statsUrl?: string;
}

/**
 * 스냅샷 한 줄에서 사람이 읽는 부분만 꺼낸다.
 *
 * 접근성 트리의 한 줄은 `- listitem [ref=f1e4]: 주문 건수 128` 처럼 생겼다.
 * **구조 표기는 지표가 아니다** — `[ref=f1e4]` 의 `1` 이나 `4` 를 숫자로
 * 읽으면 주문 건수가 4 건으로 보고된다. 실제로 그랬다.
 */
function contentOf(line: string): string {
  // [ref=…], [level=1] 같은 속성 표기를 먼저 지운다.
  const bare = line.replace(/\[[^\]]*\]/g, ' ');
  // `노드종류: 본문` 이면 콜론 뒤가, `cell "본문"` 이면 따옴표 안이 본문이다.
  const colon = bare.indexOf(':');
  const body = colon >= 0 ? bare.slice(colon + 1) : bare;
  return (/"([^"]*)"/.exec(body)?.[1] ?? body).trim();
}

/**
 * 접근성 스냅샷에서 숫자 지표를 뽑는다.
 *
 * `레이블 값` 형태의 줄을 찾는다. **이름·주소처럼 보이는 줄은 아예 읽지
 * 않는다** — 읽어서 버리는 것보다 읽지 않는 편이 낫다. 버리는 코드는
 * 나중에 누가 고치면서 빠뜨릴 수 있지만, 읽지 않은 것은 흘릴 수 없다.
 *
 * 숫자는 **레이블 바로 뒤에 붙은 것만** 인정한다. 줄 아무 데서나 숫자를
 * 주우면 "주문 건수 집계 중 … 152" 같은 줄에서 엉뚱한 값이 올라온다.
 * 값을 못 읽는 것은 미수집으로 정직하게 보고되지만, 틀린 값은 그대로
 * 복기에 들어가 레시피를 잘못 고친다.
 */
export function parseStats(snapshot: string): Record<string, number> {
  const out: Record<string, number> = {};
  const LABELS: ReadonlyArray<[RegExp, string]> = [
    [/주문\s*(?:건수|수)/, 'orderCount'],
    [/환불\s*금액/, 'refundAmount'],
    [/환불\s*(?:건수|수)/, 'refundCount'],
    [/(?:총\s*)?매출(?:액)?/, 'revenue'],
    [/판매\s*수량/, 'itemsSold'],
  ];

  for (const line of snapshot.split('\n')) {
    const content = contentOf(line);
    for (const [re, key] of LABELS) {
      const m = re.exec(content);
      if (!m) continue;
      // 레이블과 숫자 사이에 허용하는 것은 공백·콜론·구분자뿐이다.
      const num = /^[\s:：·|,]*(\d[\d,]*)/.exec(content.slice(m.index + m[0].length));
      if (num?.[1]) out[key] = Number(num[1].replace(/,/g, ''));
      break;
    }
  }
  return out;
}

export class SmartstoreMetricsAdapter implements MetricsAdapter {
  readonly channel: Channel = 'smartstore';
  readonly path = 'hands' as const;
  readonly metrics = ['orderCount', 'revenue', 'refundCount'] as const;

  private readonly hands: HandsExecutor;
  private readonly statsUrl: string;

  constructor(opts: SmartstoreOptions) {
    this.hands = opts.hands;
    this.statsUrl = opts.statsUrl ?? 'https://sell.smartstore.naver.com/#/statistics/sale';
  }

  ready(): { ok: true } | { ok: false; reason: string; checklist: string[] } {
    // Hands 표면 점검은 실행기가 한다. 여기서 흉내 내면 두 곳이 어긋난다.
    return { ok: true };
  }

  async read(
    _window: MetricsWindow,
  ): Promise<{ ok: true; raw: unknown; notes?: string[] } | { ok: false; detail: string; checklist: string[] }> {
    // 읽기만 하는 계획이다 — 조작 동사가 없으므로 desktop 승인이 필요 없다.
    const plan: HandsStep[] = [{ op: 'navigate', url: this.statsUrl }, { op: 'snapshot' }];

    const run = await this.hands.run({ steps: plan, gateAllowed: true });
    if (!run.ok) {
      // 실패 코드만 올리면 원인이 원장에만 남는다 — `transport-failed` 하나로는
      // 브라우저가 안 떴는지 화면이 바뀌었는지 알 수 없다. 실행기가 준 detail 을
      // 같이 올린다.
      const failed = run.steps.find((s) => !s.ok);
      const why = failed?.reason ?? run.detail;
      return {
        ok: false,
        detail: `통계 화면을 읽지 못했다 — ${run.reason}${why ? `: ${why}` : ''}`,
        checklist: [
          '스마트스토어 판매 통계를 직접 확인하세요',
          ...(run.checklist ?? []),
        ],
      };
    }

    const snapshot = run.steps.find((s) => s.op === 'snapshot')?.text ?? '';
    const stats = parseStats(snapshot);

    return {
      ok: true,
      raw: stats,
      // **스냅샷 원문을 담지 않는다.** 거기에 고객 이름이 있고, notes 는
      // 경계를 지나 좌석까지 간다.
      notes: [`통계 화면에서 지표 ${Object.keys(stats).length}건을 읽었다`],
    };
  }
}
