import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { ApprovalService } from '../policy/approval.js';
import { DEFAULT_POLICY } from '../policy/policy.js';
import { parseCloseBlock } from '../org/protocol.js';
import { HireBroker, checkBudget, hireDigest } from './hire.js';
import { pinBorrowed, readBorrowed, renderBorrowed, writeLock, type BorrowedAgent } from './lock.js';
import {
  GRANTABLE,
  NEVER_BY_DEFAULT,
  defaultBorrowedPermissions,
  defaultBuiltPermissions,
  grant,
  grantDigest,
  type Grantable,
} from './permissions.js';
import type { HireRequest } from '../org/protocol.js';

let dir: string;
let ledger: Ledger;
let approvals: ApprovalService;
let lockFile: string;

const LOCK_SEED = ['upstreams:', '  x: 1', '', '# 주석은 살아남아야 한다', 'borrowed_agents: []', ''].join('\n');

const REQ: HireRequest = { mode: 'borrow', target: 'hub/seo-analyst', reason: 'SEO 분석 인력 부족' };

function broker(over: { capacity?: number; occupied?: number; acquire?: unknown } = {}): HireBroker {
  return new HireBroker({
    ledger,
    approvals,
    policy: DEFAULT_POLICY,
    lockFile,
    budget: { capacity: over.capacity ?? 5, occupied: over.occupied ?? 2 },
    acquire:
      (over.acquire as never) ??
      (async () => ({ ok: true as const, packageHash: 'a'.repeat(64) })),
  });
}

function approveHire(req: HireRequest): void {
  const digest = hireDigest(req);
  const card = approvals.pending().find((c) => c.payloadDigest === digest);
  if (card) approvals.approve(card.id, { identity: 'owner', device: 't', stepUp: true }, digest);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-hire-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  approvals = new ApprovalService({ file: join(dir, 'approvals.json'), ledger, policy: DEFAULT_POLICY });
  lockFile = join(dir, 'vendor.lock');
  writeFileSync(lockFile, LOCK_SEED, 'utf8');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('HIRE 블록 파싱 (R13.1)', () => {
  it('borrow 와 build 를 구분해 읽는다', () => {
    const block = parseCloseBlock(
      ['DECISION:', '- 인력 보강', 'HIRE:', '- borrow hub/seo : 검색 분석', '- build 리서처 : 자체 조사'].join('\n'),
    );
    expect(block.hires).toHaveLength(2);
    expect(block.hires[0]).toEqual({ mode: 'borrow', target: 'hub/seo', reason: '검색 분석' });
    expect(block.hires[1]?.mode).toBe('build');
  });

  it('HIRE 섹션이 없으면 빈 배열이다', () => {
    expect(parseCloseBlock('DECISION:\n- 결정만').hires).toEqual([]);
  });

  it('형식이 아닌 줄은 채용으로 읽지 않는다', () => {
    const block = parseCloseBlock(['HIRE:', '- 사람을 더 뽑자', '- borrow hub/x : 사유'].join('\n'));
    expect(block.hires).toHaveLength(1);
  });

  it('HIRE 가 DECISION 을 삼키지 않는다', () => {
    const block = parseCloseBlock(
      ['HIRE:', '- borrow hub/x : 사유', 'DECISION:', '- 결정 하나'].join('\n'),
    );
    expect(block.decisions).toEqual(['결정 하나']);
    expect(block.hires).toHaveLength(1);
  });
});

describe('차용 권한 기본값 (R13.3)', () => {
  it('차용 패키지는 무권한에서 시작한다', () => {
    expect(defaultBorrowedPermissions().granted).toEqual([]);
  });

  it('우리가 만든 것도 Hands·발행은 없다', () => {
    const built = defaultBuiltPermissions().granted as readonly string[];
    for (const never of NEVER_BY_DEFAULT) expect(built).not.toContain(never);
  });

  it('Hands·발행·네트워크 쓰기는 부여할 수 없다', () => {
    const r = grant(defaultBorrowedPermissions(), [...NEVER_BY_DEFAULT]);
    expect(r.ok).toBe(false);
    expect(r.permissions.granted).toEqual([]);
    expect(r.refused).toHaveLength(NEVER_BY_DEFAULT.length);
  });

  it('허용 목록 밖 요청은 조용히 버리지 않고 보고한다', () => {
    const r = grant(defaultBorrowedPermissions(), ['made_up']);
    expect(r.ok).toBe(false);
    expect(r.refused[0]).toContain('알 수 없는 권한');
  });

  it('허용 목록 안은 부여된다', () => {
    const r = grant(defaultBorrowedPermissions(), ['read_ledger']);
    expect(r.ok).toBe(true);
    expect(r.permissions.granted).toEqual(['read_ledger']);
  });

  it('허용 목록에 위험 권한이 없다 — 화이트리스트가 집행한다', () => {
    for (const never of NEVER_BY_DEFAULT) {
      expect(GRANTABLE as readonly string[]).not.toContain(never);
    }
  });
});

describe('vendor.lock 핀 (R13.2)', () => {
  const AGENT: BorrowedAgent = {
    id: 'hub/seo',
    digest: 'b'.repeat(64),
    at: '2026-08-02T00:00:00.000Z',
    approvalId: 'card-1',
    permissions: { granted: [] },
    reason: '검색 분석',
  };

  it('썼다가 다시 읽으면 같은 값이다', () => {
    const rendered = renderBorrowed([AGENT]);
    const back = readBorrowed(`upstreams:\n  a: 1\n\n${rendered}\n`);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(AGENT);
  });

  it('빈 목록을 읽는다', () => {
    expect(readBorrowed(LOCK_SEED)).toEqual([]);
  });

  it('주석을 지우지 않는다', () => {
    writeLock(lockFile, [AGENT]);
    const text = readFileSync(lockFile, 'utf8');
    expect(text).toContain('# 주석은 살아남아야 한다');
    expect(text).toContain('hub/seo');
  });

  it('같은 id 를 다른 digest 로 덮지 않는다 — 승인은 digest 에 묶인다', () => {
    const text = `${LOCK_SEED.replace('borrowed_agents: []', renderBorrowed([AGENT]))}\n`;
    const r = pinBorrowed(text, { ...AGENT, digest: 'c'.repeat(64) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('조용히 덮지 않는다');
  });

  it('이미 같은 것이 있으면 다시 핀하지 않는다', () => {
    const text = `${LOCK_SEED.replace('borrowed_agents: []', renderBorrowed([AGENT]))}\n`;
    expect(pinBorrowed(text, AGENT).ok).toBe(false);
  });

  it('vendor.lock 은 소유자 전용이 아니다 — 커밋되는 공개 기록이다', () => {
    writeLock(lockFile, [AGENT]);
    // 0600 으로 조이면 저장소 파일로서 쓸모가 없고, 부모(레포 루트)까지 조인다.
    expect(readFileSync(lockFile, 'utf8').length).toBeGreaterThan(0);
  });

  it('파일 끝 개행을 남긴다 — git 이 "no newline" 으로 표시하지 않도록', () => {
    writeLock(lockFile, [AGENT]);
    expect(readFileSync(lockFile, 'utf8').endsWith('\n')).toBe(true);
  });
});

describe('예산 (R13.5)', () => {
  it('여유가 있으면 통과한다', () => {
    expect(checkBudget({ capacity: 5, occupied: 2 }, []).ok).toBe(true);
  });

  it('정원을 채웠으면 거부한다', () => {
    expect(checkBudget({ capacity: 3, occupied: 3 }, []).ok).toBe(false);
  });

  it('거부만 하지 않고 재배분 안을 낸다', () => {
    const v = checkBudget({ capacity: 3, occupied: 3 }, []);
    expect(v.proposal.length).toBeGreaterThan(2);
    expect(v.proposal.join()).toContain('좌석을 늘린다');
  });

  it('차용 패키지가 있으면 가장 오래된 것을 후보로 든다', () => {
    const old: BorrowedAgent = {
      id: 'hub/old',
      digest: 'd'.repeat(64),
      at: '2025-01-01T00:00:00.000Z',
      approvalId: 'x',
      permissions: { granted: [] },
      reason: 'r',
    };
    const recent: BorrowedAgent = { ...old, id: 'hub/new', at: '2026-08-01T00:00:00.000Z' };
    const v = checkBudget({ capacity: 2, occupied: 2 }, [recent, old]);
    expect(v.proposal.join()).toContain('hub/old');
  });
});

describe('HireBroker — 순서 (R13.4, R13.5)', () => {
  it('예산이 게이트보다 앞이다 — 감당 못 할 채용에 승인을 요구하지 않는다', async () => {
    const r = await broker({ capacity: 2, occupied: 2 }).hire(REQ, LOCK_SEED);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('budget');
    expect(r.proposal?.length).toBeGreaterThan(0);
    // 승인 카드가 만들어지지 않았다.
    expect(approvals.pending()).toHaveLength(0);
  });

  it('채용은 L3 이라 승인 없이 통과하지 않는다', async () => {
    const r = await broker().hire(REQ, LOCK_SEED);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('gate-denied');
    expect(approvals.pending()).toHaveLength(1);
    expect(approvals.pending()[0]?.level).toBe('L3');
  });

  it('승인 후에는 확보하고 핀한다', async () => {
    const b = broker();
    await b.hire(REQ, LOCK_SEED);
    approveHire(REQ);
    const r = await b.hire(REQ, LOCK_SEED);
    expect(r.ok).toBe(true);
    expect(r.agent?.digest).toBe('a'.repeat(64));
    expect(readBorrowed(readFileSync(lockFile, 'utf8'))).toHaveLength(1);
  });

  it('차용은 무권한으로 핀된다 (R13.3)', async () => {
    const b = broker();
    await b.hire(REQ, LOCK_SEED);
    approveHire(REQ);
    const r = await b.hire(REQ, LOCK_SEED);
    expect(r.agent?.permissions.granted).toEqual([]);
  });

  it('build 는 차용보다 넓지만 Hands·발행은 없다', async () => {
    const req: HireRequest = { mode: 'build', target: '리서처', reason: '자체 조사' };
    const b = broker();
    await b.hire(req, LOCK_SEED);
    approveHire(req);
    const r = await b.hire(req, LOCK_SEED);
    const granted = r.agent?.permissions.granted as readonly string[];
    expect(granted.length).toBeGreaterThan(0);
    for (const never of NEVER_BY_DEFAULT) expect(granted).not.toContain(never);
  });

  it('확보 실패는 핀하지 않는다', async () => {
    const b = broker({ acquire: async () => ({ ok: false as const, reason: 'Hub 응답 없음' }) });
    await b.hire(REQ, LOCK_SEED);
    approveHire(REQ);
    const r = await b.hire(REQ, LOCK_SEED);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('acquire-failed');
    expect(readBorrowed(readFileSync(lockFile, 'utf8'))).toEqual([]);
  });

  it('거부가 원장에 남는다', async () => {
    await broker({ capacity: 1, occupied: 1 }).hire(REQ, LOCK_SEED);
    expect(ledger.query({ kind: 'deny' }).some((e) => e.summary?.includes('채용 거부'))).toBe(true);
  });

  it('채용 완료가 원장에 L3 로 남는다', async () => {
    const b = broker();
    await b.hire(REQ, LOCK_SEED);
    approveHire(REQ);
    await b.hire(REQ, LOCK_SEED);
    const done = ledger.query({ kind: 'decision' }).find((e) => e.summary?.includes('채용 완료'));
    expect(done?.level).toBe('L3');
  });
});

describe('권한 승격은 채용과 별개 결정이다 (R13.3, Task 16.3)', () => {
  const PKG = 'a'.repeat(64);

  it('같은 에이전트라도 권한 집합이 다르면 다른 승인이다', () => {
    const one = grantDigest('hub/x', PKG, ['read_ledger']);
    const two = grantDigest('hub/x', PKG, ['read_ledger', 'seat_call']);
    expect(one).not.toBe(two);
  });

  it('적은 순서가 달라도 같은 승인이다 — 오너가 같은 결정을 두 번 하지 않는다', () => {
    expect(grantDigest('hub/x', PKG, ['seat_call', 'read_ledger'])).toBe(
      grantDigest('hub/x', PKG, ['read_ledger', 'seat_call']),
    );
  });

  /**
   * "이 에이전트에 이 권한을 준다" 에서 "이 에이전트" 는 우리가 살펴본
   * 그 내용물이다. 패키지가 바뀌면 예전 승인이 넘어오면 안 된다.
   */
  it('패키지 내용이 바뀌면 다른 승인이다', () => {
    expect(grantDigest('hub/x', PKG, ['read_ledger'])).not.toBe(
      grantDigest('hub/x', 'b'.repeat(64), ['read_ledger']),
    );
  });

  it('채용 승인과 digest 가 겹치지 않는다', () => {
    const hire = hireDigest({ mode: 'borrow', target: 'hub/x', reason: 'r' });
    expect(grantDigest('hub/x', PKG, ['read_ledger'])).not.toBe(hire);
  });

  it('hire.grant 는 L3 다', () => {
    expect(DEFAULT_POLICY.levels.L3).toContain('hire.grant');
    // 채용과 별개 항목으로 남아 있어야 한다.
    expect(DEFAULT_POLICY.levels.L3).toContain('hire');
  });

  it('줄 수 없는 권한은 부여되지 않고 이유가 남는다', () => {
    const r = grant({ granted: [] }, ['read_ledger', 'hands']);
    expect(r.ok).toBe(false);
    expect(r.permissions.granted).toEqual(['read_ledger']);
    expect(r.refused.join()).toContain('hands');
  });

  it('회수는 lock 왕복을 견딘다', () => {
    const agent = {
      id: 'hub/x',
      digest: PKG,
      at: '2026-08-01T00:00:00.000Z',
      approvalId: 'card-1',
      permissions: { granted: ['read_ledger', 'seat_call'] as Grantable[] },
      reason: '사유',
    };
    const text = renderBorrowed([{ ...agent, permissions: { granted: ['read_ledger'] } }]);
    expect(readBorrowed(text)[0]?.permissions.granted).toEqual(['read_ledger']);
  });
});
