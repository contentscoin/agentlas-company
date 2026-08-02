import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { ApprovalService } from '../policy/approval.js';
import { DEFAULT_POLICY } from '../policy/policy.js';
import { PublishBroker, publishDigest } from './broker.js';
import { PublishStore, localDayKey } from './ledgerstore.js';
import type { ChannelAdapter, PublishEvidence, PublishRequest } from './types.js';
import type { Verb } from '../verbs/types.js';

let dir: string;
let ledger: Ledger;
let store: PublishStore;
let approvals: ApprovalService;
let notes: string[];

const VERB: Verb = { op: 'post_text', channel: 'threads', body: '첫 글입니다' };

/** 실제로 나가지 않고 성공을 흉내 내는 어댑터. 브로커 자체를 시험한다. */
function fakeAdapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter {
  let calls = 0;
  const adapter: ChannelAdapter = {
    channel: 'threads',
    path: 'api',
    ready: () => ({ ok: true }),
    describe: (v) => ({ preview: v }),
    publish: async () => {
      calls += 1;
      return {
        ok: true as const,
        evidence: { url: `https://example.test/post/${calls}`, screenshots: [], notes: [] },
      };
    },
    ...over,
  };
  Object.defineProperty(adapter, 'calls', { get: () => calls });
  return adapter;
}

function broker(adapters: ChannelAdapter[], dailyLimits?: Record<string, number>): PublishBroker {
  return new PublishBroker({
    ledger,
    approvals,
    policy: DEFAULT_POLICY,
    store,
    adapters,
    evidenceRoot: join(dir, 'evidence'),
    ...(dailyLimits ? { dailyLimits: dailyLimits as never } : {}),
    notify: (m) => notes.push(m),
  });
}

function req(over: Partial<PublishRequest> = {}): PublishRequest {
  return { channel: 'threads', verb: VERB, idempotencyKey: 'k1', ...over };
}

/** 게이트를 통과시킨다. 발행은 L3 이라 승인 없이는 나가지 않는다. */
function approveAll(request: PublishRequest): void {
  const digest = publishDigest(request);
  const card = approvals
    .pending()
    .find((c) => c.payloadDigest === digest && c.status === 'pending');
  if (card) {
    approvals.approve(card.id, { identity: 'owner', device: 'test', stepUp: true }, digest);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-publish-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  store = new PublishStore({ file: join(dir, 'published.json') });
  approvals = new ApprovalService({ file: join(dir, 'approvals.json'), ledger, policy: DEFAULT_POLICY });
  notes = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('드라이런 (R6.4)', () => {
  it('실제로 내보내지 않고 페이로드를 돌려준다', async () => {
    const adapter = fakeAdapter();
    const r = await broker([adapter]).publish(req({ dryRun: true }));
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({ preview: VERB });
    expect((adapter as unknown as { calls: number }).calls).toBe(0);
  });

  it('드라이런은 승인 카드를 만들지 않는다 — 구경이 승인 대기를 쌓지 않는다', async () => {
    await broker([fakeAdapter()]).publish(req({ dryRun: true }));
    expect(approvals.pending()).toHaveLength(0);
  });

  it('드라이런은 멱등성 기록을 남기지 않는다', async () => {
    await broker([fakeAdapter()]).publish(req({ dryRun: true }));
    expect(store.find('k1')).toBeNull();
  });
});

describe('게이트 (R4)', () => {
  it('승인 없이는 나가지 않는다', async () => {
    const adapter = fakeAdapter();
    const r = await broker([adapter]).publish(req());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('gate-denied');
    expect((adapter as unknown as { calls: number }).calls).toBe(0);
  });

  it('승인 후에는 나간다', async () => {
    const b = broker([fakeAdapter()]);
    const request = req();
    await b.publish(request);
    approveAll(request);
    const r = await b.publish(request);
    expect(r.ok).toBe(true);
    expect(r.evidence?.url).toContain('example.test');
  });
});

describe('멱등성 (R6.3)', () => {
  async function publishOnce(b: PublishBroker, request: PublishRequest): Promise<void> {
    await b.publish(request);
    approveAll(request);
    await b.publish(request);
  }

  it('같은 키로 두 번 보내도 한 번만 나간다', async () => {
    const adapter = fakeAdapter();
    const b = broker([adapter]);
    const request = req();
    await publishOnce(b, request);
    expect((adapter as unknown as { calls: number }).calls).toBe(1);

    const second = await b.publish(request);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('duplicate');
    expect((adapter as unknown as { calls: number }).calls).toBe(1);
  });

  it('중복 요청은 원래 증거를 그대로 돌려준다', async () => {
    const b = broker([fakeAdapter()]);
    const request = req();
    await publishOnce(b, request);
    const second = await b.publish(request);
    expect(second.original?.url).toBe('https://example.test/post/1');
  });

  it('다른 키는 별개 발행이다', async () => {
    const adapter = fakeAdapter();
    const b = broker([adapter]);
    for (const key of ['k1', 'k2']) {
      const request = req({ idempotencyKey: key });
      await publishOnce(b, request);
    }
    expect((adapter as unknown as { calls: number }).calls).toBe(2);
  });

  it('멱등성 확인이 상한보다 앞이다 — 이미 나간 것의 재확인은 상한과 무관하다', async () => {
    const b = broker([fakeAdapter()], { threads: 1 });
    const request = req();
    await b.publish(request);
    approveAll(request);
    await b.publish(request);
    // 상한 1 을 이미 채웠지만, 같은 키의 재요청은 duplicate 로 답해야 한다.
    const again = await b.publish(request);
    expect(again.reason).toBe('duplicate');
    expect(again.ok).toBe(true);
  });
});

describe('일일 상한 (R6.5)', () => {
  it('상한에 도달하면 정지하고 오너에게 알린다', async () => {
    const b = broker([fakeAdapter()], { threads: 1 });
    const first = req({ idempotencyKey: 'a' });
    await b.publish(first);
    approveAll(first);
    await b.publish(first);

    const second = req({ idempotencyKey: 'b' });
    const r = await b.publish(second);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('daily-limit');
    expect(notes.some((n) => n.includes('상한 도달'))).toBe(true);
  });

  it('상한 초과는 체크리스트를 준다 (R6.6)', async () => {
    const b = broker([fakeAdapter()], { threads: 0 });
    const r = await b.publish(req());
    expect(r.checklist?.[0]).toContain('상한');
  });

  it('날짜 경계는 로컬 시간으로 센다', () => {
    // UTC 로 세면 한국 시간 오전 9시에 상한이 초기화된다.
    const at = new Date(2026, 7, 2, 1, 30);
    expect(localDayKey(at)).toBe('2026-08-02');
  });
});

describe('오염 (R16.5)', () => {
  it('오염된 발행은 승인이 있어도 나가지 않는다', async () => {
    const adapter = fakeAdapter();
    const r = await broker([adapter]).publish(req({ tainted: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tainted');
    expect((adapter as unknown as { calls: number }).calls).toBe(0);
    expect(ledger.query({ kind: 'deny' })[0]?.tainted).toBe(true);
  });
});

describe('실패와 체크리스트 (R6.6)', () => {
  it('어댑터가 준비되지 않으면 설정 문제로 구분한다', async () => {
    const r = await broker([
      fakeAdapter({
        ready: () => ({ ok: false, reason: '토큰 없음', checklist: ['토큰을 설정하세요'] }),
      }),
    ]).publish(req());
    expect(r.reason).toBe('not-configured');
    expect(r.checklist).toEqual(['토큰을 설정하세요']);
  });

  it('어댑터 실패는 체크리스트를 그대로 전달한다', async () => {
    const b = broker([
      fakeAdapter({
        publish: async () => ({ ok: false as const, detail: '요소 없음', checklist: ['수동으로 게시하세요'] }),
      }),
    ]);
    const request = req();
    await b.publish(request);
    approveAll(request);
    const r = await b.publish(request);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('adapter-failed');
    expect(r.checklist).toEqual(['수동으로 게시하세요']);
  });

  it('실패는 멱등성 기록을 남기지 않는다 — 재시도가 막히면 안 된다', async () => {
    const b = broker([
      fakeAdapter({ publish: async () => ({ ok: false as const, detail: 'x', checklist: [] }) }),
    ]);
    const request = req();
    await b.publish(request);
    approveAll(request);
    await b.publish(request);
    expect(store.find('k1')).toBeNull();
  });

  it('어댑터가 없는 채널은 설정 문제다', async () => {
    const r = await broker([]).publish(req({ channel: 'youtube' }));
    expect(r.reason).toBe('not-configured');
  });
});

describe('증거 (R6.2)', () => {
  it('발행 URL 이 원장에 남는다', async () => {
    const b = broker([fakeAdapter()]);
    const request = req();
    await b.publish(request);
    approveAll(request);
    await b.publish(request);
    const published = ledger.query({ kind: 'publish' });
    expect(published).toHaveLength(1);
    expect(published[0]?.evidence).toContain('https://example.test/post/1');
  });

  it('증거 디렉터리를 실행 단위로 만든다', async () => {
    const b = broker([fakeAdapter()]);
    const request = req({ runId: 'run-9' });
    await b.publish(request);
    approveAll(request);
    await b.publish(request);
    expect(existsSync(join(dir, 'evidence', 'run-9'))).toBe(true);
  });
});

describe('PublishStore', () => {
  it('같은 키의 증거를 덮어쓰지 않는다 — 첫 발행이 정본이다', () => {
    const first: PublishEvidence = { url: 'first', screenshots: [], notes: [] };
    const second: PublishEvidence = { url: 'second', screenshots: [], notes: [] };
    store.record('k', 'threads', first);
    store.record('k', 'threads', second);
    expect(store.find('k')?.url).toBe('first');
  });

  it('채널별로 따로 센다', () => {
    store.record('a', 'threads', { screenshots: [], notes: [] });
    store.record('b', 'naver_blog', { screenshots: [], notes: [] });
    expect(store.countToday('threads')).toBe(1);
    expect(store.countToday('naver_blog')).toBe(1);
  });
});
