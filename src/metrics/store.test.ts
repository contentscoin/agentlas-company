import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { MetricsBroker } from './broker.js';
import { MetricsStore } from './store.js';
import type { MetricsAdapter } from './types.js';

let dir: string;
let store: MetricsStore;
let ledger: Ledger;

const WINDOW = { from: '2026-08-01', to: '2026-08-02' };

function adapter(over: Partial<MetricsAdapter> = {}): MetricsAdapter {
  return {
    channel: 'smartstore',
    path: 'hands',
    metrics: ['orderCount', 'revenue'],
    ready: () => ({ ok: true }),
    read: async () => ({ ok: true as const, raw: { orderCount: 3 } }),
    ...over,
  } as MetricsAdapter;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-mstore-'));
  store = new MetricsStore({ file: join(dir, 'metrics', 'records.json') });
  ledger = Ledger.open(join(dir, 'events.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('측정 기록', () => {
  it('없으면 빈 것으로 읽는다', () => {
    expect(store.read()).toEqual({ collections: [], retros: [] });
  });

  it('오너 전용으로 쓴다', () => {
    store.recordRetro({
      at: 'x', runId: 'r', subject: 's', gaps: [], uncollected: [], amendments: [], editCount: 0,
    });
    if (process.platform === 'win32') return; // ACL 은 별도 시험이다
    expect(statSync(join(dir, 'metrics', 'records.json')).mode & 0o777).toBe(0o600);
  });

  it('최신이 앞이고 오래된 것은 잘린다', () => {
    const s = new MetricsStore({ file: join(dir, 'm2.json'), keep: 2 });
    for (const n of ['a', 'b', 'c']) {
      s.recordRetro({
        at: n, runId: n, subject: n, gaps: [], uncollected: [], amendments: [], editCount: 0,
      });
    }
    expect(s.read().retros.map((r) => r.runId)).toEqual(['c', 'b']);
  });

  it('채널별 마지막 수집만 고른다', () => {
    for (const ch of ['smartstore', 'threads', 'smartstore']) {
      store.recordCollection({
        at: ch, channel: ch, window: WINDOW, ok: true, aggregate: {}, dropped: [], uncollected: [],
      });
    }
    expect(store.latestByChannel().map((c) => c.channel)).toEqual(['smartstore', 'threads']);
  });

  it('손상되면 빈 것으로 본다 — 화면용 캐시라 복구할 것이 없다', () => {
    const s = new MetricsStore({ file: join(dir, 'broken.json') });
    s.recordRetro({ at: 'x', runId: 'r', subject: 's', gaps: [], uncollected: [], amendments: [], editCount: 0 });
    rmSync(join(dir, 'broken.json'));
    expect(s.read()).toEqual({ collections: [], retros: [] });
  });
});

describe('브로커가 남기는 것 (R7.6)', () => {
  it('막힌 필드는 이름만 남고 값은 남지 않는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      store,
      adapters: [adapter({ read: async () => ({ ok: true as const, raw: { orderCount: 3, buyerName: '김OO' } }) })],
    });
    await broker.read('smartstore', WINDOW);
    const raw = JSON.stringify(store.read());
    expect(raw).toContain('buyerName');
    expect(raw).not.toContain('김OO');
  });

  it('미수집을 0 으로 채우지 않는다', async () => {
    const broker = new MetricsBroker({ ledger, store, adapters: [adapter()] });
    await broker.read('smartstore', WINDOW);
    const c = store.read().collections[0];
    if (!c || !c.ok) throw new Error('성공 기록이어야 한다');
    expect(c.uncollected).toEqual(['revenue']);
    expect(c.aggregate.revenue).toBeUndefined();
  });

  /**
   * 남기지 않으면 화면에서 "측정이 고장 났다" 와 "측정할 일이 없었다" 가
   * 구분되지 않는다.
   */
  it('수집 실패도 남는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      store,
      adapters: [adapter({ read: async () => ({ ok: false as const, detail: '화면 없음', checklist: [] }) })],
    });
    await broker.read('smartstore', WINDOW);
    const c = store.read().collections[0];
    expect(c?.ok).toBe(false);
    if (c && !c.ok) expect(c.reason).toBe('adapter-failed');
  });

  it('설정 미비도 남는다 — 그 채널이 화면에서 사라지지 않는다', async () => {
    const broker = new MetricsBroker({
      ledger,
      store,
      adapters: [adapter({ ready: () => ({ ok: false, reason: '토큰 없음', checklist: [] }) })],
    });
    await broker.read('smartstore', WINDOW);
    const c = store.read().collections[0];
    expect(c?.ok).toBe(false);
    if (c && !c.ok) {
      expect(c.reason).toBe('not-configured');
      expect(c.detail).toBe('토큰 없음');
    }
  });

  it('보관소가 없어도 수집은 된다', async () => {
    const broker = new MetricsBroker({ ledger, adapters: [adapter()] });
    const r = await broker.read('smartstore', WINDOW);
    expect(r.ok).toBe(true);
  });
});
