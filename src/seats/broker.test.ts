import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { SeatBroker, looksExhausted } from './broker.js';
import type { SeatSpec } from './spec.js';
import type { RunResult } from '../proc/index.js';
import { SeatUsageStore } from './usage.js';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-broker-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 가짜 좌석. 실제 CLI 를 띄우지 않고 브로커 로직만 검사한다. */
function fakeSeat(over: Partial<SeatSpec> & Pick<SeatSpec, 'id' | 'vendor'>): SeatSpec {
  return {
    bin: 'fake',
    configHomeEnv: null,
    authFiles: [],
    promptVia: 'arg',
    spawnMode: 'direct',
    buildArgs: (prompt, outFile) => [prompt, outFile],
    readResult: (file, stdout) => (file ?? stdout).trim() || null,
    quota: { window: 'day', limit: null, resetAt: null },
    maxConcurrent: 1,
    verified: true,
    ...over,
  } as SeatSpec;
}

const ok = (ms = 5): RunResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ms });
const fail = (code: number, stdout = ''): RunResult => ({ code, stdout, stderr: '', timedOut: false, ms: 3 });

/** 성공 실행기 — 산출 파일에 답을 써준다. 실제 codex 동작과 같은 모양. */
const writeOut =
  (answer: string) =>
  async (_spec: SeatSpec, args: string[]): Promise<RunResult> => {
    writeFileSync(args[1]!, answer, 'utf8');
    return ok();
  };

describe('좌석 선택', () => {
  it('preferSeat 을 먼저 쓴다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' }), fakeSeat({ id: 'gemini', vendor: 'google' })],
      runner: writeOut('답변'),
    });
    const r = await broker.ask({ persona: 'ceo', prompt: 'q', preferSeat: 'gemini' });
    expect(r.ok).toBe(true);
    expect(r.seat).toBe('gemini');
  });

  it('미검증 좌석은 명시 허용 없이 쓰지 않는다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'cursor', vendor: 'cursor', verified: false })],
      runner: writeOut('답변'),
    });
    const denied = await broker.ask({ persona: 'cto', prompt: 'q' });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('미검증');

    const allowed = await broker.ask({ persona: 'cto', prompt: 'q', allowUnverified: true });
    expect(allowed.ok).toBe(true);
  });

  it('금지 벤더를 쓰지 않는다 — Critic 크로스벤더 강제 (R3.4)', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' }), fakeSeat({ id: 'claude', vendor: 'anthropic' })],
      runner: writeOut('비평'),
    });
    const r = await broker.ask({ persona: 'critic', prompt: 'q', forbidVendor: ['openai'] });
    expect(r.ok).toBe(true);
    expect(r.seat).toBe('claude');
  });

  it('금지 벤더 때문에 남는 좌석이 없으면 폴백하지 않고 실패한다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: writeOut('비평'),
    });
    const r = await broker.ask({ persona: 'critic', prompt: 'q', forbidVendor: ['openai'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('크로스벤더');
    // 벤더 격리를 지키려고 실패한 것이므로 원장에 거부가 남아야 한다
    expect(ledger.query({ kind: 'deny' })).toHaveLength(1);
  });

  it('예산 한도에 도달한 좌석을 건너뛴다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [
        // 한도를 걸려면 창 경계가 잡혀야 한다 — resetAt 없이는 브로커가 거부한다
        fakeSeat({
          id: 'codex',
          vendor: 'openai',
          quota: { window: 'day', limit: 1, resetAt: '00:00 UTC' },
        }),
        fakeSeat({ id: 'claude', vendor: 'anthropic' }),
      ],
      runner: writeOut('답변'),
    });
    const first = await broker.ask({ persona: 'ceo', prompt: 'q', preferSeat: 'codex' });
    expect(first.seat).toBe('codex');
    const second = await broker.ask({ persona: 'ceo', prompt: 'q', preferSeat: 'codex' });
    expect(second.seat).toBe('claude');
  });
});

describe('실패와 폴백', () => {
  it('첫 좌석이 실패하면 다음 좌석으로 넘어간다', async () => {
    let calls = 0;
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' }), fakeSeat({ id: 'claude', vendor: 'anthropic' })],
      runner: async (_spec, args) => {
        calls++;
        if (calls === 1) return fail(1);
        writeFileSync(args[1]!, '두 번째 좌석 답변', 'utf8');
        return ok();
      },
    });
    const r = await broker.ask({ persona: 'ceo', prompt: 'q', preferSeat: 'codex' });
    expect(r.ok).toBe(true);
    expect(r.seat).toBe('claude');
    expect(r.text).toBe('두 번째 좌석 답변');
  });

  it('쿼터 소진 좌석은 이후 요청에서 제외된다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'claude', vendor: 'anthropic' })],
      runner: async () => fail(1, "You've hit your weekly limit · resets 8pm (Asia/Seoul)"),
    });
    const first = await broker.ask({ persona: 'ceo', prompt: 'q' });
    expect(first.ok).toBe(false);
    expect(first.reason).toContain('쿼터 소진');

    const second = await broker.ask({ persona: 'ceo', prompt: 'q' });
    // 언제 풀리는지가 오너가 물을 첫 질문이다. 벤더가 말한 시각을 그대로 붙인다
    expect(second.reason).toContain('쿼터 소진');
    expect(second.reason).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(broker.status().find((s) => s.seat === 'claude')?.exhausted).toBe(true);
  });

  it('타임아웃을 실패로 보고한다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, ms: 1500 }),
    });
    const r = await broker.ask({ persona: 'ceo', prompt: 'q', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('타임아웃');
  });

  it('종료 코드 0 이어도 산출물이 비면 실패로 본다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: async () => ok(),
    });
    const r = await broker.ask({ persona: 'ceo', prompt: 'q' });
    expect(r.ok).toBe(false);
  });

  it('stderr 가 있어도 종료 코드 0 이면 성공이다 — 실측에서 codex 가 그랬다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: async (_spec, args) => {
        writeFileSync(args[1]!, 'SEAT_OK', 'utf8');
        return { code: 0, stdout: '', stderr: 'warning: failed to load models cache', timedOut: false, ms: 4 };
      },
    });
    const r = await broker.ask({ persona: 'ceo', prompt: 'q' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('SEAT_OK');
  });
});

describe('동시성', () => {
  it('좌석 동시성을 넘겨 실행하지 않는다', async () => {
    let concurrent = 0;
    let peak = 0;
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai', maxConcurrent: 1 })],
      runner: async (_spec, args) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        writeFileSync(args[1]!, 'ok', 'utf8');
        return ok(30);
      },
    });
    await Promise.all([1, 2, 3, 4].map(() => broker.ask({ persona: 'ceo', prompt: 'q' })));
    expect(peak).toBe(1);
  });

  it('대기한 요청의 queuedMs 가 0보다 크다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai', maxConcurrent: 1 })],
      runner: async (_spec, args) => {
        await new Promise((r) => setTimeout(r, 40));
        writeFileSync(args[1]!, 'ok', 'utf8');
        return ok(40);
      },
    });
    const [, second] = await Promise.all([
      broker.ask({ persona: 'a', prompt: 'q' }),
      broker.ask({ persona: 'b', prompt: 'q' }),
    ]);
    expect(second.queuedMs).toBeGreaterThan(0);
  });
});

describe('원장 기록과 오염 전파', () => {
  it('성공 호출을 seat.call 로 남긴다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: writeOut('답변'),
    });
    await broker.ask({ persona: 'growth', prompt: '질문', runId: 'run-1' });
    const calls = ledger.query({ kind: 'seat.call' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.actor.id).toBe('growth');
    expect(calls[0]?.actor.seat).toBe('codex');
    expect(calls[0]?.runId).toBe('run-1');
    // 프롬프트 본문은 원장에 넣지 않고 digest 만 남긴다
    expect(calls[0]?.payloadDigest).toHaveLength(64);
    expect(JSON.stringify(calls[0])).not.toContain('질문');
  });

  it('입력이 오염이면 결과와 원장 모두 오염으로 표시된다 (R16.3)', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: writeOut('답변'),
    });
    const r = await broker.ask({ persona: 'research', prompt: 'q', tainted: true });
    expect(r.tainted).toBe(true);
    expect(ledger.query({ tainted: true })).toHaveLength(1);
  });

  it('원장 체인이 온전하게 유지된다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: writeOut('답변'),
    });
    await broker.ask({ persona: 'a', prompt: 'q' });
    await broker.ask({ persona: 'b', prompt: 'q' });
    expect(ledger.verify().ok).toBe(true);
  });
});

describe('프롬프트 전달 경로', () => {
  it('stdin 좌석은 프롬프트를 인자에 심지 않는다', async () => {
    let seenArgs: string[] = [];
    let seenPrompt = '';
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai', promptVia: 'stdin', buildArgs: (_p, out) => ['-', out] })],
      runner: async (_spec, args, _profile, _timeout, prompt) => {
        seenArgs = args;
        seenPrompt = prompt;
        writeFileSync(args[1]!, 'ok', 'utf8');
        return ok();
      },
    });

    const multiline = '첫 줄\n\n두 번째 줄\n세 번째 줄';
    const r = await broker.ask({ persona: 'ceo', prompt: multiline });
    expect(r.ok).toBe(true);
    expect(seenArgs[0]).toBe('-');
    expect(seenArgs.join(' ')).not.toContain('첫 줄');
    expect(seenPrompt).toBe(multiline);
  });

  it('arg 좌석은 프롬프트를 인자로 받는다', async () => {
    let seenArgs: string[] = [];
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai', promptVia: 'arg' })],
      runner: async (_spec, args) => {
        seenArgs = args;
        writeFileSync(args[1]!, 'ok', 'utf8');
        return ok();
      },
    });
    await broker.ask({ persona: 'ceo', prompt: '질문' });
    expect(seenArgs[0]).toBe('질문');
  });
});

describe('askWithPack — 오염 전파를 잊을 수 없게 한다', () => {
  it('팩이 오염되면 결과와 원장이 오염으로 표시된다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: writeOut('답변'),
    });
    const pack = { prompt: '질문', tainted: true, minTrust: 0 as const, sources: [], signals: [] };
    const r = await broker.askWithPack('research', pack);
    expect(r.ok).toBe(true);
    expect(r.tainted).toBe(true);
    expect(ledger.query({ kind: 'seat.call', tainted: true })).toHaveLength(1);
  });

  it('깨끗한 팩은 오염되지 않는다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat({ id: 'codex', vendor: 'openai' })],
      runner: writeOut('답변'),
    });
    const pack = { prompt: '질문', tainted: false, minTrust: 2 as const, sources: [], signals: [] };
    const r = await broker.askWithPack('ceo', pack);
    expect(r.tainted).toBe(false);
  });
});

describe('status (R2.6)', () => {
  it('좌석별 검증 여부와 사유를 보고한다', () => {
    const broker = new SeatBroker({
      ledger,
      seats: [
        fakeSeat({ id: 'codex', vendor: 'openai' }),
        fakeSeat({ id: 'cursor', vendor: 'cursor', verified: false, note: '에이전트 CLI 미설치' }),
      ],
    });
    const s = broker.status();
    expect(s.find((x) => x.seat === 'codex')?.verified).toBe(true);
    expect(s.find((x) => x.seat === 'cursor')?.note).toContain('미설치');
  });
});

describe('looksExhausted', () => {
  it('실측 문구를 알아본다', () => {
    expect(looksExhausted(fail(1, "You've hit your weekly limit · resets 8pm"))).toBe(true);
  });

  it('성공은 소진이 아니다', () => {
    expect(looksExhausted(ok())).toBe(false);
  });

  it('알아보지 못하는 실패는 소진으로 단정하지 않는다', () => {
    expect(looksExhausted(fail(1, 'some other error'))).toBe(false);
  });
});

/**
 * Task 5.1 — `company` 는 부를 때마다 새 프로세스다. 장부가 없던 동안
 * 카운터는 재시작 시 초기화되는 정도가 아니라 **한 번도 누적되지 않았고**,
 * 벤더가 알려 준 소진 사실도 매 호출 잊혔다. 아래 시험에서 새 `SeatBroker`
 * 인스턴스가 새 프로세스의 대역이다.
 */
describe('사용량이 프로세스를 넘어 남는다 (Task 5.1)', () => {
  const CLAUDE_MSG = "You've hit your weekly limit · resets 8pm (Asia/Seoul)";
  const seats = [fakeSeat({ id: 'claude', vendor: 'anthropic' })];
  let usage: SeatUsageStore;

  beforeEach(() => {
    usage = new SeatUsageStore({ file: join(dir, 'seats', 'usage.json') });
  });

  it('장부가 없으면 카운터가 프로세스와 함께 사라진다', async () => {
    const first = new SeatBroker({ ledger, seats, runner: writeOut('답') });
    await first.ask({ persona: 'ceo', prompt: 'q' });
    expect(first.status()[0]?.used).toBe(1);

    const second = new SeatBroker({ ledger, seats, runner: writeOut('답') });
    expect(second.status()[0]?.used).toBe(0);
    expect(second.status()[0]?.persisted).toBe(false);
  });

  it('장부가 있으면 다음 프로세스가 이어서 센다', async () => {
    const first = new SeatBroker({ ledger, seats, usage, runner: writeOut('답') });
    await first.ask({ persona: 'ceo', prompt: 'q' });

    const second = new SeatBroker({ ledger, seats, usage, runner: writeOut('답') });
    expect(second.status()[0]?.used).toBe(1);
    await second.ask({ persona: 'ceo', prompt: 'q' });
    expect(new SeatBroker({ ledger, seats, usage, runner: writeOut('답') }).status()[0]?.used).toBe(2);
  });

  it('벤더가 말한 소진을 다음 프로세스가 기억한다', async () => {
    const first = new SeatBroker({ ledger, seats, usage, runner: async () => fail(1, CLAUDE_MSG) });
    await first.ask({ persona: 'ceo', prompt: 'q' });

    let called = false;
    const second = new SeatBroker({
      ledger, seats, usage,
      runner: async () => { called = true; return fail(1, CLAUDE_MSG); },
    });
    const r = await second.ask({ persona: 'ceo', prompt: 'q' });
    // 벽인 줄 알면서 다시 치지 않는다
    expect(called).toBe(false);
    expect(r.reason).toContain('쿼터 소진 상태');
    expect(second.status()[0]?.exhaustedUntil).not.toBeNull();
  });

  it('해제 시각이 지나면 다시 쓴다', async () => {
    let now = Date.parse('2026-08-04T09:00:00.000Z');
    const clock = (): number => now;
    const store = new SeatUsageStore({ file: join(dir, 'seats', 'usage.json'), now: clock });
    const a = new SeatBroker({ ledger, seats, usage: store, now: clock, runner: async () => fail(1, CLAUDE_MSG) });
    await a.ask({ persona: 'ceo', prompt: 'q' });

    now += 3 * 3_600_000; // 해제로 잡힌 20:00 KST 를 지난다
    const b = new SeatBroker({ ledger, seats, usage: store, now: clock, runner: writeOut('답') });
    const r = await b.ask({ persona: 'ceo', prompt: 'q' });
    expect(r.ok).toBe(true);
    // 답을 준 것이 소진이 아니라는 가장 확실한 근거다
    expect(b.status()[0]?.exhausted).toBe(false);
  });

  /**
   * 해제 시각을 모르는데 후보에서 빼면, 벤더 문구를 한 번 잘못 읽은 것만으로
   * 좌석이 영원히 사라지고 회사가 멈춘다.
   */
  it('해제 시각을 모르면 빼지 않고 뒤로 민다', async () => {
    const two = [
      fakeSeat({ id: 'gemini', vendor: 'google' }),
      fakeSeat({ id: 'codex', vendor: 'openai' }),
    ];
    const a = new SeatBroker({
      ledger, seats: two, usage,
      runner: async (spec, args) => {
        if (spec.id === 'gemini') return fail(1, 'quota exceeded');
        writeFileSync(args[1]!, 'codex 답', 'utf8');
        return ok();
      },
    });
    await a.ask({ persona: 'ceo', prompt: 'q', preferSeat: 'gemini' });
    expect(usage.get('gemini', two[0]!).exhaustedUntil).toBeNull();

    // 다음 프로세스: gemini 는 강등이므로 codex 가 먼저 불린다
    const tried: string[] = [];
    const b = new SeatBroker({
      ledger, seats: two, usage,
      runner: async (spec, args) => {
        tried.push(spec.id);
        writeFileSync(args[1]!, '답', 'utf8');
        return ok();
      },
    });
    await b.ask({ persona: 'ceo', prompt: 'q', preferSeat: 'gemini' });
    expect(tried).toEqual(['codex']);

    // 그래도 목록에는 남아 있다 — codex 가 죽으면 gemini 를 다시 친다
    const solo: string[] = [];
    const c = new SeatBroker({
      ledger, seats: two, usage,
      runner: async (spec) => { solo.push(spec.id); return fail(1); },
    });
    await c.ask({ persona: 'ceo', prompt: 'q' });
    expect(solo).toContain('gemini');
  });

  /**
   * 창을 못 잡는 좌석에 한도를 걸면 카운터가 영원히 안 줄어 좌석이 죽는다.
   * 조용히 무시하지도, 조용히 죽이지도 않고 사양 단계에서 멈춘다.
   */
  it('집행할 수 없는 한도를 들고 출발하지 않는다', () => {
    expect(
      () =>
        new SeatBroker({
          ledger,
          seats: [fakeSeat({ id: 'codex', vendor: 'openai', quota: { window: 'day', limit: 5, resetAt: null } })],
        }),
    ).toThrow(/집행할 창 경계/);
  });
});

describe('화면과 선택 로직이 같은 말을 한다', () => {
  it('해제 시각이 지나면 status 도 소진이 아니라고 말한다', async () => {
    let now = Date.parse('2026-08-04T09:00:00.000Z');
    const clock = (): number => now;
    const seats = [fakeSeat({ id: 'claude', vendor: 'anthropic' })];
    const usage = new SeatUsageStore({ file: join(dir, 'seats', 'usage.json'), now: clock });
    const b = new SeatBroker({
      ledger, seats, usage, now: clock,
      runner: async () => fail(1, "You've hit your weekly limit · resets 8pm (Asia/Seoul)"),
    });
    await b.ask({ persona: 'ceo', prompt: 'q' });
    expect(b.status()[0]?.exhausted).toBe(true);

    now += 3 * 3_600_000; // 해제로 잡힌 시각을 지난다. 호출은 하지 않는다
    expect(b.status()[0]?.exhausted).toBe(false);
    expect(b.status()[0]?.exhaustedUntil).toBeNull();
  });
});
