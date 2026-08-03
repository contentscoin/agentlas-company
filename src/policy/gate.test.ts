import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { ApprovalService } from './approval.js';
import { DEFAULT_POLICY } from './policy.js';
import { resolveGate, type GateDeps, type GateInput } from './gate.js';
import type { PolicyConfig, Submitter } from './types.js';

let dir: string;
let ledger: Ledger;
let approvals: ApprovalService;
let nowMs: number;

const POLICY: PolicyConfig = {
  ...DEFAULT_POLICY,
  levels: {
    L0: ['meeting'],
    L1: ['publish.threads'],
    L2: ['agent.borrow'],
    L3: ['hire'],
  },
  approval: { cardTtlMs: 3_600_000, coolingWindowMs: 60_000 },
  ownerIdentities: ['owner'],
  devices: ['phone-1'],
};

const OWNER: Submitter = { identity: 'owner', device: 'phone-1', stepUp: true };
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function deps(): GateDeps {
  return { policy: POLICY, approvals, ledger };
}

function ask(over: Partial<GateInput> = {}): ReturnType<typeof resolveGate> {
  return resolveGate(deps(), {
    action: 'agent.borrow',
    payloadDigest: DIGEST,
    summary: 'Hub 에이전트 차용',
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-gate-'));
  nowMs = Date.UTC(2026, 7, 2, 12, 0, 0);
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  approvals = new ApprovalService({
    policy: POLICY,
    ledger,
    file: join(dir, 'approvals.json'),
    now: () => nowMs,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveGate — 자동 등급', () => {
  it('L0 은 카드 없이 즉시 인가한다', () => {
    const d = ask({ action: 'meeting' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('auto');
    expect(d.approvalId).toBeUndefined();
    expect(approvals.pending()).toHaveLength(0);
  });

  it('L1 도 즉시 인가한다', () => {
    expect(ask({ action: 'publish.threads' }).allowed).toBe(true);
  });

  it('자동 인가도 원장에 남는다 — 통과가 조용히 일어나면 안 된다', () => {
    ask({ action: 'meeting' });
    const events = ledger.query({ kind: 'gate.verdict' });
    expect(events).toHaveLength(1);
    expect(events[0]?.payloadDigest).toBe(DIGEST);
  });
});

describe('resolveGate — 승인이 필요한 등급', () => {
  it('카드가 없으면 만들고 거부한다. 만드는 것은 통과가 아니다', () => {
    const d = ask();
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('approval-pending');
    expect(d.approvalId).toBeDefined();
    expect(approvals.pending()).toHaveLength(1);
  });

  it('두 번째 시도는 새 카드를 만들지 않고 같은 카드를 가리킨다', () => {
    const first = ask();
    const second = ask();
    expect(second.approvalId).toBe(first.approvalId);
    expect(approvals.pending()).toHaveLength(1);
  });

  it('대기 중에는 계속 거부한다 — 침묵은 승인이 아니다', () => {
    ask();
    expect(ask().allowed).toBe(false);
    expect(ask().allowed).toBe(false);
  });

  it('승인 후에는 인가하고 카드를 소비한다', () => {
    const pending = ask();
    approvals.approve(pending.approvalId!, OWNER, DIGEST);
    nowMs += POLICY.approval.coolingWindowMs + 1;

    const d = ask();
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('approved');
    expect(approvals.get(pending.approvalId!)?.status).toBe('consumed');
  });

  it('승인 하나로 두 번 통과할 수 없다', () => {
    const pending = ask();
    approvals.approve(pending.approvalId!, OWNER, DIGEST);
    nowMs += POLICY.approval.coolingWindowMs + 1;

    expect(ask().allowed).toBe(true);
    // 소비된 카드는 열린 카드가 아니므로 새 카드가 만들어지고 다시 거부된다.
    const again = ask();
    expect(again.allowed).toBe(false);
    expect(again.reason).toBe('approval-pending');
    expect(again.approvalId).not.toBe(pending.approvalId);
  });

  it('가역 작업은 유예 창이 없다 — 승인 직후 바로 통과한다', () => {
    const pending = ask();
    approvals.approve(pending.approvalId!, OWNER, DIGEST);

    // `agent.borrow` 는 위험 능력 목록에 없어 비가역이 아니다. 유예 창은
    // 비가역 작업에만 붙으므로(R4.11) 여기서 기다릴 것이 없다.
    const d = ask();
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('approved');
  });

  it('비가역 작업은 유예 창이 안 끝나면 거부한다 (R4.11)', () => {
    // `spend` 는 위험 능력이므로 정책 표와 무관하게 비가역·L3 이다.
    const pending = ask({ action: 'spend' });
    expect(pending.level).toBe('L3');
    expect(pending.irreversible).toBe(true);
    approvals.approve(pending.approvalId!, OWNER, DIGEST);

    const cooling = ask({ action: 'spend' });
    expect(cooling.allowed).toBe(false);
    expect(cooling.reason).toBe('cooling');
    expect(cooling.detail).toContain('남음');

    nowMs += POLICY.approval.coolingWindowMs + 1;
    expect(ask({ action: 'spend' }).allowed).toBe(true);
  });
});

describe('resolveGate — digest 바인딩 (R4.6)', () => {
  it('다른 digest 로 물으면 그 카드로 통과하지 못한다', () => {
    const pending = ask();
    approvals.approve(pending.approvalId!, OWNER, DIGEST);
    nowMs += POLICY.approval.coolingWindowMs + 1;

    // 페이로드가 바뀌었다 → 그 카드는 이 요청의 카드가 아니다.
    const d = ask({ payloadDigest: OTHER_DIGEST });
    expect(d.allowed).toBe(false);
    expect(d.approvalId).not.toBe(pending.approvalId);
    // 원래 카드는 승인 상태로 남아 있고 소비되지 않았다.
    expect(approvals.get(pending.approvalId!)?.status).toBe('approved');
  });
});

describe('resolveGate — 종단 상태', () => {
  it('거부된 카드는 통과시키지 않는다', () => {
    const pending = ask();
    approvals.reject(pending.approvalId!, OWNER);
    const d = ask();
    expect(d.allowed).toBe(false);
  });

  it('만료는 통과가 아니다 (R4.7)', () => {
    ask();
    nowMs += POLICY.approval.cardTtlMs + 1;
    const d = ask();
    expect(d.allowed).toBe(false);
  });
});

describe('resolveGate — 승격 (R16.5)', () => {
  it('오염된 입력은 등급을 올린다', () => {
    const clean = ask({ action: 'publish.threads' });
    expect(clean.level).toBe('L1');
    expect(clean.allowed).toBe(true);

    const tainted = ask({ action: 'publish.threads', tainted: true });
    expect(tainted.level).toBe('L2');
    expect(tainted.allowed).toBe(false);
  });

  it('Critic BLOCK 도 등급을 올린다', () => {
    const d = ask({ action: 'publish.threads', criticVerdict: 'BLOCK' });
    expect(d.allowed).toBe(false);
  });

  it('정책에 없는 작업은 자동이 아니라 L2 다', () => {
    const d = ask({ action: 'agent.borrow.unknown-variant' });
    expect(d.level).toBe('L2');
    expect(d.allowed).toBe(false);
  });
});

describe('resolveGate — 거부 기록', () => {
  it('모든 거부가 deny 로 남는다 — 급증이 침해 신호다 (R17.5)', () => {
    ask();
    ask();
    ask();
    expect(ledger.query({ kind: 'deny' })).toHaveLength(3);
  });

  it('오염 표시가 원장까지 전파된다', () => {
    ask({ tainted: true });
    const denies = ledger.query({ kind: 'deny' });
    expect(denies[0]?.tainted).toBe(true);
  });
});
