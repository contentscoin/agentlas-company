import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import type { LedgerEvent } from '../ledger/types.js';
import type { CapabilityState } from '../capabilities/types.js';
import { DEFAULT_THRESHOLDS, detectAnomalies, isSurge, unreadableLedger } from './anomaly.js';
import { checkHealth } from './health.js';
import { EXPIRY_WARN_MS, buildDigest, renderDigest } from './digest.js';

let dir: string;
let ledger: Ledger;

const NOW = new Date(2026, 7, 2, 12, 0, 0).getTime();

/** 시각을 지정해 이벤트를 만든다. 원장에 쓰지 않고 판정만 시험한다. */
function ev(kind: LedgerEvent['kind'], minutesAgo: number, summary = ''): LedgerEvent {
  return {
    id: `e${minutesAgo}-${kind}-${Math.random()}`,
    seq: 1,
    at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    prevHash: '',
    hash: '',
    actor: { kind: 'system', id: 't' },
    kind,
    evidence: [],
    ...(summary ? { summary } : {}),
  } as LedgerEvent;
}

function okSurface(): never | ReturnType<typeof Object> {
  return { ok: true, launcher: '/x', approvalFile: '/y', problems: [], detail: [] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-ops-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('isSurge — 배수와 절대 기준을 함께 쓴다', () => {
  it('배수를 넘으면 급증이다', () => {
    expect(isSurge(30, 5, 3, 100)).toBe(true);
  });

  it('이전 창이 0 이면 배수로 판정하지 않는다 — 첫날 모든 것이 이상이 되지 않도록', () => {
    expect(isSurge(3, 0, 3, 100)).toBe(false);
  });

  it('이전 창이 0 이어도 절대 기준을 넘으면 급증이다', () => {
    expect(isSurge(100, 0, 3, 100)).toBe(true);
  });

  it('규모가 커져도 절대 기준이 잡는다 — 배수만 쓰면 아무것도 안 걸린다', () => {
    // 이전 창 200 → 최근 250. 배수는 1.25 라 안 걸리지만 절대 기준은 넘는다.
    expect(isSurge(250, 200, 3, 100)).toBe(true);
  });
});

describe('detectAnomalies (R17.5)', () => {
  it('평소 수준이면 이상 없음', () => {
    const events = [ev('seat.call', 10), ev('seat.call', 70), ev('deny', 80)];
    const r = detectAnomalies(events, NOW);
    expect(r.shouldHalt).toBe(false);
    expect(r.anomalies).toEqual([]);
  });

  it('거부 급증은 정지 대상이다', () => {
    const events = Array.from({ length: 25 }, (_, i) => ev('deny', i));
    const r = detectAnomalies(events, NOW);
    expect(r.shouldHalt).toBe(true);
    expect(r.anomalies[0]?.kind).toBe('deny-surge');
  });

  it('실행 볼륨 급증도 정지 대상이다', () => {
    const events = Array.from({ length: 120 }, (_, i) => ev('publish', i % 55));
    const r = detectAnomalies(events, NOW);
    expect(r.anomalies.some((a) => a.kind === 'volume-surge')).toBe(true);
  });

  it('창 밖 이벤트는 세지 않는다', () => {
    const old = Array.from({ length: 100 }, () => ev('deny', 60 * 24));
    expect(detectAnomalies(old, NOW).shouldHalt).toBe(false);
  });

  it('직전 창과 비교한다', () => {
    const events = [
      ...Array.from({ length: 15 }, (_, i) => ev('deny', i)),
      ...Array.from({ length: 2 }, (_, i) => ev('deny', 70 + i)),
    ];
    const r = detectAnomalies(events, NOW);
    expect(r.counts.recentDeny).toBe(15);
    expect(r.counts.previousDeny).toBe(2);
    // 15 / 2 = 7.5 배 → 급증.
    expect(r.shouldHalt).toBe(true);
  });

  it('시각이 깨진 이벤트는 건너뛴다', () => {
    const broken = { ...ev('deny', 1), at: '언제인지 모름' } as LedgerEvent;
    expect(() => detectAnomalies([broken], NOW)).not.toThrow();
  });

  it('임계값을 조정할 수 있다', () => {
    const events = Array.from({ length: 5 }, (_, i) => ev('deny', i));
    expect(detectAnomalies(events, NOW).shouldHalt).toBe(false);
    expect(
      detectAnomalies(events, NOW, { ...DEFAULT_THRESHOLDS, absoluteDeny: 3 }).shouldHalt,
    ).toBe(true);
  });
});

describe('unreadableLedger — 판단할 수 없는 것은 정상이 아니다', () => {
  it('읽지 못하면 정지 대상이다', () => {
    const r = unreadableLedger('파일 없음');
    expect(r.shouldHalt).toBe(true);
    expect(r.anomalies[0]?.kind).toBe('ledger-unreadable');
  });

  it('빈 배열을 넘긴 것과 구분된다 — 이것이 감시가 무력화되는 방식이다', () => {
    expect(detectAnomalies([], NOW).shouldHalt).toBe(false);
    expect(unreadableLedger('x').shouldHalt).toBe(true);
  });
});

describe('checkHealth (R17.1~R17.3)', () => {
  const allOff: CapabilityState[] = [
    { capability: 'spend', enabled: false, bootId: null } as CapabilityState,
    { capability: 'dm_send', enabled: false, bootId: null } as CapabilityState,
  ];

  it('전부 정상이면 ok', () => {
    ledger.append({ actor: { kind: 'system', id: 't' }, kind: 'seat.call', summary: 'x' });
    const r = checkHealth({
      ledger,
      capabilities: allOff,
      inspect: okSurface as never,
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.verdict === 'ok')).toBe(true);
  });

  it('이전 부팅 세션의 부여가 ON 이면 broken (R17.3)', () => {
    const r = checkHealth({
      ledger,
      capabilities: [
        ...allOff,
        { capability: 'spend', enabled: true, bootId: 'boot-111' } as CapabilityState,
      ],
      inspect: okSurface as never,
      bootId: () => 'boot-999',
    });
    expect(r.ok).toBe(false);
    expect(r.actions.join()).toContain('panic');
  });

  it('이번 부팅 세션의 ON 은 정상이다 — 오너가 켠 것이다', () => {
    // 가동 시간으로 판정하면 부팅 5분 뒤에 정당하게 켠 것도 위반이 된다.
    const r = checkHealth({
      ledger,
      capabilities: [
        ...allOff,
        { capability: 'spend', enabled: true, bootId: 'boot-999' } as CapabilityState,
      ],
      inspect: okSurface as never,
      bootId: () => 'boot-999',
    });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === '능력 스위치')?.detail).toContain('이번 부팅 세션');
  });

  it('실행 표면이 없으면 degraded — broken 은 아니지만 알린다', () => {
    const r = checkHealth({
      ledger,
      capabilities: allOff,
      inspect: () =>
        ({
          ok: false,
          launcher: '/x',
          approvalFile: null,
          problems: ['desktop-not-running'],
          detail: ['desktop 이 안 떠 있다'],
        }) as never,
    });
    // company 자체는 살아 있으므로 broken 이 아니다. 다만 절반만 살아난 것이다.
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === '실행 표면')?.verdict).toBe('degraded');
    expect(r.actions.join()).toContain('Hands');
  });

  it('원장이 손상되면 보존을 먼저 안내한다', () => {
    const broken = {
      verify: () => ({ ok: false, count: 3, lastGoodSeq: 2, problems: [] }),
    } as unknown as Ledger;
    const r = checkHealth({ ledger: broken, capabilities: allOff, inspect: okSurface as never });
    expect(r.ok).toBe(false);
    expect(r.actions.join()).toContain('덮어쓰면');
  });
});

describe('buildDigest (R17.6, R17.4)', () => {
  const at = new Date(NOW);

  it('요구된 세 가지를 담는다', () => {
    const events = [
      ev('switch.change', 60, 'spend ON'),
      ev('deny', 30, '거부됨'),
      ev('publish', 10, 'spend 집행'),
    ];
    const d = buildDigest(events, at);
    expect(d.switchChanges).toHaveLength(1);
    expect(d.denials).toHaveLength(1);
    expect(d.riskyUse.length).toBeGreaterThan(0);
  });

  it('이벤트가 없으면 없다고 쓴다 — 합성하지 않는다', () => {
    const d = buildDigest([], at);
    expect(d.quiet).toBe(true);
    expect(renderDigest(d).join()).toContain('추정해 채우지 않습니다');
  });

  it('빈 섹션도 "없음" 으로 남긴다 — 침묵과 누락을 구분한다', () => {
    const d = buildDigest([ev('seat.call', 5, '초안')], at);
    expect(d.quiet).toBe(false);
    expect(renderDigest(d).join('\n')).toContain('없음');
  });

  it('다른 날 이벤트는 세지 않는다', () => {
    expect(buildDigest([ev('deny', 60 * 24 * 2)], at).quiet).toBe(true);
  });

  it('만료 임박 좌석을 급한 것으로 올린다 (R17.4)', () => {
    const d = buildDigest([], at, [{ seat: 'claude', remainingMs: EXPIRY_WARN_MS - 1 }]);
    expect(d.urgent[0]).toContain('claude');
    expect(d.urgent[0]).toContain('만료');
  });

  it('이미 만료된 좌석은 재인증을 요구한다', () => {
    const d = buildDigest([], at, [{ seat: 'codex', remainingMs: -1 }]);
    expect(d.urgent[0]).toContain('재인증');
  });

  it('만료 시각을 모르는 좌석은 급한 것에 넣지 않는다 — 추정하지 않는다', () => {
    expect(buildDigest([], at, [{ seat: 'gemini', remainingMs: null }]).urgent).toEqual([]);
  });

  it('거부가 많으면 앞쪽만 보여준다 — 요약이 로그가 되지 않도록', () => {
    const many = Array.from({ length: 30 }, (_, i) => ev('deny', i, `거부 ${i}`));
    const d = buildDigest(many, at);
    expect(d.denials.length).toBeLessThanOrEqual(11);
    expect(d.denials[d.denials.length - 1]).toContain('외');
  });
});
