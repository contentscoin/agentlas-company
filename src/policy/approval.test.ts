import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, digestPayload } from '../ledger/ledger.js';
import { ApprovalService } from './approval.js';
import { DEFAULT_POLICY, classify } from './policy.js';
import type { ApprovalRequest, PolicyConfig, Submitter } from './types.js';

let dir: string;
let ledger: Ledger;
let svc: ApprovalService;
let nowMs: number;
let sent: Array<{ devices: string[]; message: string }>;

const POLICY: PolicyConfig = {
  ...DEFAULT_POLICY,
  levels: {
    L0: ['meeting'],
    L1: ['publish.threads'],
    L2: ['publish.instagram'],
    L3: ['hire'],
  },
  approval: { cardTtlMs: 3_600_000, coolingWindowMs: 60_000 },
  ownerIdentities: ['owner'],
  devices: ['phone-1', 'desktop-1'],
};

const PHONE: Submitter = { identity: 'owner', device: 'phone-1', stepUp: true };
const PHONE_NO_STEPUP: Submitter = { identity: 'owner', device: 'phone-1', stepUp: false };
const INTRUDER: Submitter = { identity: 'someone-else', device: 'phone-9', stepUp: true };

function build(): void {
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  sent = [];
  svc = new ApprovalService({
    policy: POLICY,
    ledger,
    file: join(dir, 'approvals.json'),
    notify: (devices, message) => sent.push({ devices, message }),
    now: () => nowMs,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-approval-'));
  nowMs = Date.UTC(2026, 6, 30, 12, 0, 0);
  build();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DIGEST = digestPayload('발행할 본문');

function card(action = 'publish.instagram', digest = DIGEST): ApprovalRequest {
  return svc.create({
    classification: classify(POLICY, { action }),
    payloadDigest: digest,
    summary: `${action} 요청`,
  });
}

describe('승인 카드 생성', () => {
  it('만료 시각이 정책 TTL 로 정해진다', () => {
    const r = card();
    expect(r.status).toBe('pending');
    expect(r.expiresAt).toBe(new Date(nowMs + 3_600_000).toISOString());
  });

  it('등록 기기에 알린다', () => {
    card();
    expect(sent[0]?.devices).toEqual(['phone-1', 'desktop-1']);
  });

  it('원장에 요청이 남는다', () => {
    card();
    const e = ledger.query({ kind: 'approval' })[0];
    expect(e?.summary).toContain('승인 요청');
    expect(e?.payloadDigest).toBe(DIGEST);
  });
});

describe('digest 바인딩 (R4.5, R4.6)', () => {
  it('digest 가 맞으면 승인된다', () => {
    const r = card();
    const out = svc.approve(r.id, PHONE, DIGEST);
    expect(out.ok).toBe(true);
    expect(out.request.status).toBe('approved');
  });

  it('내용이 바뀌면 영수증이 무효가 된다', () => {
    const r = card();
    const out = svc.approve(r.id, PHONE, digestPayload('바뀐 본문'));
    expect(out.ok).toBe(false);
    expect(out.request.status).toBe('invalidated');
    expect(ledger.query({ kind: 'deny' })).toHaveLength(1);
  });

  it('승인 후 실행 시점에 내용이 바뀌어도 막는다', () => {
    const r = card();
    svc.approve(r.id, PHONE, DIGEST);
    nowMs += 60_000;
    const c = svc.consume(r.id, digestPayload('실행 직전에 바뀐 본문'));
    expect(c.allowed).toBe(false);
    expect(c.reason).toBe('digest-mismatch');
  });
});

describe('신원과 단계별 인증 (R4.8, R4.9)', () => {
  it('허용목록에 없는 신원을 거부하고 기록한다', () => {
    const r = card();
    const out = svc.approve(r.id, INTRUDER, DIGEST);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('허용되지 않은 신원');
    expect(svc.get(r.id)?.status).toBe('pending');
    expect(ledger.query({ kind: 'deny' })[0]?.summary).toContain('허용목록에 없는 신원');
  });

  it('L3 은 단계별 인증 없이 승인되지 않는다', () => {
    const r = card('hire');
    expect(r.level).toBe('L3');
    const out = svc.approve(r.id, PHONE_NO_STEPUP, DIGEST);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('단계별 인증');
  });

  it('L2 는 단계별 인증 없이도 승인된다', () => {
    const r = card('publish.instagram');
    expect(r.level).toBe('L2');
    expect(svc.approve(r.id, PHONE_NO_STEPUP, DIGEST).ok).toBe(true);
  });

  it('L3 승인이 다른 등록 기기에 알려진다 (R4.10)', () => {
    const r = card('hire');
    sent = [];
    svc.approve(r.id, PHONE, DIGEST);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.devices).toEqual(['desktop-1']);
    expect(sent[0]?.message).toContain('phone-1');
  });
});

describe('만료는 취소다 (R4.7)', () => {
  it('만료된 카드는 승인할 수 없다', () => {
    const r = card();
    nowMs += 3_600_001;
    const out = svc.approve(r.id, PHONE, DIGEST);
    expect(out.ok).toBe(false);
    expect(svc.get(r.id)?.status).toBe('expired');
  });

  it('만료가 통과로 해석되지 않는다', () => {
    const r = card();
    nowMs += 3_600_001;
    const c = svc.consume(r.id, DIGEST);
    expect(c.allowed).toBe(false);
    expect(c.reason).toBe('expired');
  });

  it('취소 사유가 원장에 남는다', () => {
    card();
    nowMs += 3_600_001;
    svc.pending();
    const e = ledger.query({ kind: 'approval' }).find((x) => (x.summary ?? '').includes('취소'));
    expect(e?.summary).toContain('만료는 통과가 아니다');
  });

  it('이미 승인된 카드는 만료로 뒤집히지 않는다', () => {
    const r = card();
    svc.approve(r.id, PHONE, DIGEST);
    nowMs += 3_600_001;
    expect(svc.get(r.id)?.status).toBe('approved');
  });
});

describe('유예 창 (R4.11)', () => {
  it('비가역 작업은 승인 후 바로 실행되지 않는다', () => {
    const r = svc.create({
      classification: classify(POLICY, { action: 'spend' }),
      payloadDigest: DIGEST,
      summary: '광고비 집행',
    });
    expect(r.irreversible).toBe(true);
    svc.approve(r.id, PHONE, DIGEST);

    const blocked = svc.consume(r.id, DIGEST);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('cooling');
    expect(svc.coolingRemainingMs(r.id)).toBe(60_000);
  });

  it('유예 창이 끝나면 실행된다', () => {
    const r = svc.create({
      classification: classify(POLICY, { action: 'spend' }),
      payloadDigest: DIGEST,
      summary: '광고비 집행',
    });
    svc.approve(r.id, PHONE, DIGEST);
    nowMs += 60_000;
    expect(svc.consume(r.id, DIGEST).allowed).toBe(true);
  });

  it('유예 창 안에 다른 기기가 중단할 수 있다', () => {
    const r = svc.create({
      classification: classify(POLICY, { action: 'spend' }),
      payloadDigest: DIGEST,
      summary: '광고비 집행',
    });
    svc.approve(r.id, PHONE, DIGEST);
    const aborted = svc.abort(r.id, { identity: 'owner', device: 'desktop-1' }, '내가 누른 게 아니다');
    expect(aborted.ok).toBe(true);

    nowMs += 60_000;
    const c = svc.consume(r.id, DIGEST);
    expect(c.allowed).toBe(false);
    expect(c.reason).toBe('aborted');
  });

  it('되돌릴 수 있는 작업은 유예 없이 즉시 실행된다', () => {
    const r = card('publish.instagram');
    expect(r.irreversible).toBe(false);
    svc.approve(r.id, PHONE, DIGEST);
    expect(svc.consume(r.id, DIGEST).allowed).toBe(true);
  });

  it('승인되지 않은 요청은 중단 대상이 아니다', () => {
    const r = card();
    expect(svc.abort(r.id, { identity: 'owner', device: 'phone-1' }).ok).toBe(false);
  });
});

describe('일회성 소비', () => {
  it('한 승인으로 두 번 실행하지 못한다', () => {
    const r = card();
    svc.approve(r.id, PHONE, DIGEST);
    expect(svc.consume(r.id, DIGEST).allowed).toBe(true);
    const again = svc.consume(r.id, DIGEST);
    expect(again.allowed).toBe(false);
    expect(again.reason).toBe('already-consumed');
  });

  it('승인 없이 소비할 수 없다', () => {
    const r = card();
    const c = svc.consume(r.id, DIGEST);
    expect(c.allowed).toBe(false);
    expect(c.reason).toBe('not-approved');
  });

  it('없는 요청은 거부된다', () => {
    expect(svc.consume('없는-id', DIGEST).reason).toBe('not-found');
  });
});

describe('거부', () => {
  it('거부하면 실행되지 않고 사유가 남는다', () => {
    const r = card();
    svc.reject(r.id, PHONE, '문구가 브랜드와 안 맞다');
    expect(svc.get(r.id)?.status).toBe('rejected');
    expect(svc.consume(r.id, DIGEST).allowed).toBe(false);
    expect(ledger.query({ kind: 'approval' }).some((e) => (e.summary ?? '').includes('문구가'))).toBe(true);
  });

  it('이미 결정된 요청은 다시 결정할 수 없다', () => {
    const r = card();
    svc.approve(r.id, PHONE, DIGEST);
    expect(svc.reject(r.id, PHONE).ok).toBe(false);
  });
});

describe('영속성과 원장', () => {
  it('재시작 후에도 승인 상태가 남는다', () => {
    const r = card();
    svc.approve(r.id, PHONE, DIGEST);
    build();
    expect(svc.get(r.id)?.status).toBe('approved');
    expect(svc.consume(r.id, DIGEST).allowed).toBe(true);
  });

  it('승인 결정에 주체·기기·시각·digest 가 남는다 (R4.12)', () => {
    const r = card();
    svc.approve(r.id, PHONE, DIGEST);
    const e = ledger.query({ kind: 'approval' }).find((x) => (x.summary ?? '').startsWith('승인 완료'));
    expect(e?.actor.kind).toBe('owner');
    expect(e?.actor.id).toBe('owner');
    expect(e?.summary).toContain('phone-1');
    expect(e?.payloadDigest).toBe(DIGEST);
  });

  it('원장 체인이 온전하다', () => {
    const a = card();
    svc.approve(a.id, PHONE, DIGEST);
    const b = card('hire');
    svc.reject(b.id, PHONE);
    expect(ledger.verify().ok).toBe(true);
  });

  it('pending 목록은 결정된 것을 빼고 보여준다', () => {
    const a = card();
    card('hire');
    svc.approve(a.id, PHONE, DIGEST);
    expect(svc.pending()).toHaveLength(1);
  });
});
