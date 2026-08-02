import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { MetricsBroker, foldRaw } from './broker.js';
import { parseStats } from './adapters/smartstore.js';
import { foldInsights } from './adapters/threads.js';
import type { MetricsAdapter } from './types.js';

let dir: string;
let ledger: Ledger;

/** 원본을 그대로 돌려주는 어댑터. 경계 집행이 브로커에 있음을 시험한다. */
function adapter(raw: unknown, over: Partial<MetricsAdapter> = {}): MetricsAdapter {
  return {
    channel: 'smartstore',
    path: 'hands',
    metrics: ['orderCount', 'revenue', 'refundCount'],
    ready: () => ({ ok: true }),
    read: async () => ({ ok: true as const, raw }),
    ...over,
  } as MetricsAdapter;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-metrics-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('집계 경계는 브로커가 집행한다 (R7.6)', () => {
  it('어댑터가 PII 를 돌려줘도 좌석으로 넘어가지 않는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [adapter({ orderCount: 12, revenue: 340000, buyerName: '김OO', phone: '010-1234-5678' })],
    });
    const r = await broker.read('smartstore', { from: '2026-08-01', to: '2026-08-02' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.aggregate).toEqual({ orderCount: 12, revenue: 340000 });
    expect(JSON.stringify(r.result)).not.toContain('김OO');
    expect(JSON.stringify(r.result)).not.toContain('010-1234-5678');
  });

  it('막힌 필드는 이름만 보고한다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [adapter({ orderCount: 1, buyerName: '김OO' })],
    });
    const r = await broker.read('smartstore', { from: 'a', to: 'b' });
    if (!r.ok) throw new Error('실패');
    expect(r.result.dropped).toContain('buyerName');
    expect(r.result.dropped.join()).not.toContain('김OO');
  });

  it('원장에도 값이 남지 않는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [adapter({ orderCount: 1, buyerName: '김OO', address: '서울시 …' })],
    });
    await broker.read('smartstore', { from: 'a', to: 'b' });
    const raw = ledger.query({ limit: 10 }).map((e) => JSON.stringify(e)).join('');
    expect(raw).not.toContain('김OO');
    expect(raw).not.toContain('서울시');
    // 이름은 남는다 — 무엇이 막혔는지는 알아야 한다.
    expect(raw).toContain('buyerName');
  });

  it('주문 목록이 오면 건수와 매출로 접는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [
        adapter([
          { amount: 10000, buyerName: '김OO' },
          { amount: 20000, buyerName: '이OO' },
        ]),
      ],
    });
    const r = await broker.read('smartstore', { from: 'a', to: 'b' });
    if (!r.ok) throw new Error('실패');
    expect(r.result.aggregate.orderCount).toBe(2);
    expect(r.result.aggregate.revenue).toBe(30000);
    expect(JSON.stringify(r.result)).not.toContain('김OO');
  });

  it('모르는 모양은 추측해 파싱하지 않는다', () => {
    expect(foldRaw('그냥 문자열').aggregate).toEqual({});
    expect(foldRaw(null).aggregate).toEqual({});
  });
});

describe('메모에도 린트를 물린다 (R15.5)', () => {
  it('어댑터 메모에 PII 가 있으면 그 줄을 버린다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [
        adapter(
          { orderCount: 1 },
          { read: async () => ({ ok: true as const, raw: { orderCount: 1 }, notes: ['문의: 010-1234-5678', '정상 메모'] }) },
        ),
      ],
    });
    const r = await broker.read('smartstore', { from: 'a', to: 'b' });
    if (!r.ok) throw new Error('실패');
    expect(r.result.notes).toEqual(['정상 메모']);
    expect(JSON.stringify(r.result)).not.toContain('010-1234-5678');
    // 무엇이 걸렸는지는 알려 준다 — 값 없이. 한 줄이 규칙 여럿에 걸릴 수
    // 있으므로 건수를 고정하지 않는다.
    expect(r.result.flagged.length).toBeGreaterThan(0);
    expect(r.result.flagged.join()).toContain('PII');
  });

  it('걸린 메모의 값은 원장에도 남지 않는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [
        adapter(
          {},
          { read: async () => ({ ok: true as const, raw: {}, notes: ['010-1234-5678'] }) },
        ),
      ],
    });
    await broker.read('smartstore', { from: 'a', to: 'b' });
    const raw = ledger.query({ limit: 10 }).map((e) => JSON.stringify(e)).join('');
    expect(raw).not.toContain('010-1234-5678');
    expect(raw).toContain('PII');
  });
});

describe('미수집을 0 으로 채우지 않는다 (R11.6)', () => {
  it('선언한 지표가 안 나오면 미수집으로 보고한다', async () => {
    const broker = new MetricsBroker({ ledger, adapters: [adapter({ orderCount: 5 })] });
    const r = await broker.read('smartstore', { from: 'a', to: 'b' });
    if (!r.ok) throw new Error('실패');
    expect(r.result.uncollected).toEqual(['revenue', 'refundCount']);
    expect(r.result.aggregate.revenue).toBeUndefined();
    expect(r.result.aggregate.revenue).not.toBe(0);
  });

  it('전부 나오면 미수집이 없다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [adapter({ orderCount: 5, revenue: 100, refundCount: 0 })],
    });
    const r = await broker.read('smartstore', { from: 'a', to: 'b' });
    if (!r.ok) throw new Error('실패');
    // refundCount 가 0 인 것은 측정 결과다 — 미수집이 아니다.
    expect(r.result.uncollected).toEqual([]);
    expect(r.result.aggregate.refundCount).toBe(0);
  });
});

describe('실패 경로', () => {
  it('어댑터가 없는 채널은 구분해서 알린다', async () => {
    const broker = new MetricsBroker({ ledger, adapters: [] });
    const r = await broker.read('youtube', { from: 'a', to: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported-channel');
  });

  it('준비되지 않은 어댑터는 설정 문제다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [adapter({}, { ready: () => ({ ok: false, reason: '토큰 없음', checklist: ['설정하세요'] }) })],
    });
    const r = await broker.read('smartstore', { from: 'a', to: 'b' });
    if (r.ok) throw new Error('통과하면 안 된다');
    expect(r.reason).toBe('not-configured');
    expect(r.checklist).toEqual(['설정하세요']);
  });

  it('읽기 실패는 원장에 남는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      adapters: [
        adapter({}, { read: async () => ({ ok: false as const, detail: '화면 없음', checklist: [] }) }),
      ],
    });
    await broker.read('smartstore', { from: 'a', to: 'b' });
    expect(ledger.query({ kind: 'deny' }).some((e) => e.summary?.includes('화면 없음'))).toBe(true);
  });
});

describe('스마트스토어 화면 파싱', () => {
  it('통계 레이블에서 숫자를 뽑는다', () => {
    const snap = [
      '- text "주문 건수 128"',
      '- text "총 매출 3,450,000"',
      '- text "환불 건수 3"',
    ].join('\n');
    expect(parseStats(snap)).toEqual({ orderCount: 128, revenue: 3450000, refundCount: 3 });
  });

  /**
   * 실제 실행에서 나온 모양이다. 처음 구현은 줄에서 첫 숫자를 주웠고,
   * `[ref=e4]` 의 4 가 주문 건수로 올라갔다.
   */
  it('접근성 트리의 ref 번호를 지표로 읽지 않는다', () => {
    const snap = [
      '- generic [ref=f1e1]:',
      '  - heading "판매 통계" [level=1] [ref=f1e2]',
      '  - list [ref=f1e3]:',
      '    - listitem [ref=f1e4]: 주문 건수 128',
      '    - listitem [ref=f1e5]: 총 매출 3,450,000',
      '    - listitem [ref=f1e6]: 환불 건수 3',
    ].join('\n');
    expect(parseStats(snap)).toEqual({ orderCount: 128, revenue: 3450000, refundCount: 3 });
  });

  it('고객 정보 줄은 아예 읽지 않는다 — 읽어서 버리지 않는다', () => {
    const snap = [
      '- row [ref=e10]:',
      '  - cell "주문자 김OO" [ref=e11]',
      '  - cell "연락처 010-1234-5678" [ref=e12]',
      '  - cell "배송지 서울시 강남구 테헤란로 152" [ref=e13]',
      '- listitem [ref=e14]: 주문 건수 5',
    ].join('\n');
    const stats = parseStats(snap);
    expect(stats).toEqual({ orderCount: 5 });
    expect(JSON.stringify(stats)).not.toContain('김OO');
    // 주소의 번지수(152)도 지표로 올라오지 않는다.
    expect(Object.values(stats)).not.toContain(152);
  });

  it('숫자가 없으면 그 지표를 만들지 않는다', () => {
    expect(parseStats('- text "주문 건수 집계 중"')).toEqual({});
  });

  it('레이블에서 떨어진 숫자는 그 지표의 값이 아니다', () => {
    // 틀린 값보다 미수집이 낫다 — 틀린 값은 그대로 복기에 들어간다.
    expect(parseStats('- listitem [ref=e4]: 주문 건수 집계 중, 방문자 3,201')).toEqual({});
  });

  it('환불 금액을 환불 건수로 읽지 않는다', () => {
    expect(parseStats('- listitem [ref=e9]: 환불 금액 120,000')).toEqual({ refundAmount: 120000 });
  });
});

describe('쓰레드 인사이트 파싱', () => {
  it('지표 이름과 값을 뽑는다', () => {
    const body = {
      data: [
        { name: 'views', values: [{ value: 1200 }] },
        { name: 'likes', values: [{ value: 34 }] },
      ],
    };
    expect(foldInsights(body)).toEqual({ views: 1200, likes: 34 });
  });

  it('모르는 지표는 무시한다', () => {
    expect(foldInsights({ data: [{ name: 'made_up', values: [{ value: 1 }] }] })).toEqual({});
  });

  it('모양이 다르면 빈 객체다', () => {
    expect(foldInsights({ error: 'x' })).toEqual({});
    expect(foldInsights(null)).toEqual({});
  });
});
