import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, digestPayload } from '../ledger/ledger.js';
import { CapabilityStore, SwitchValidationError, ZoneForbiddenError, currentBootId } from './store.js';
import { CapabilityGuard } from './guard.js';
import { RISKY_CAPABILITIES, type Caller, type CapabilityRequest } from './types.js';

let dir: string;
let ledger: Ledger;
let store: CapabilityStore;
let guard: CapabilityGuard;
let notices: string[];
let nowMs: number;

const OWNER: Caller = { zone: 'owner', id: 'owner', device: 'phone-1', stepUp: true };
const BROKER: Caller = { zone: 'broker', id: 'publish-broker' };
const SEAT: Caller = { zone: 'seat', id: 'growth' };
const BOOT = 'boot-fixed';

function build(bootId = BOOT): void {
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  notices = [];
  store = new CapabilityStore({
    file: join(dir, 'capabilities.json'),
    ledger,
    notify: (m) => notices.push(m),
    bootId: () => bootId,
    now: () => nowMs,
  });
  guard = new CapabilityGuard({ store, ledger, now: () => nowMs });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-cap-'));
  nowMs = Date.UTC(2026, 6, 30, 12, 0, 0);
  build();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 승인 영수증 하나. 정책 게이트(Task 7)가 만들 모양. */
function approval(digest: string): NonNullable<CapabilityRequest['approval']> {
  return { digest, grantedAt: new Date(nowMs).toISOString(), device: 'phone-1' };
}

describe('출하 기본값 (R8.1, R8.2)', () => {
  it('위험 능력 10종이 등록되어 있다', () => {
    expect(RISKY_CAPABILITIES).toHaveLength(10);
    expect(new Set(RISKY_CAPABILITIES).size).toBe(10);
  });

  it('설치 직후 전부 OFF 다', () => {
    const states = store.list(OWNER);
    expect(states).toHaveLength(10);
    expect(states.every((s) => !s.enabled)).toBe(true);
    expect(states.every((s) => s.expiresAt === null)).toBe(true);
  });

  it('저장 파일이 없어도 OFF 로 읽는다', () => {
    expect(existsSync(join(dir, 'capabilities.json'))).toBe(false);
    expect(store.get(OWNER, 'spend').enabled).toBe(false);
  });

  it('저장 파일이 깨졌으면 ON 으로 추정하지 않고 전부 OFF 로 본다', () => {
    writeFileSync(join(dir, 'capabilities.json'), '{ 깨진 json', 'utf8');
    expect(store.list(OWNER).every((s) => !s.enabled)).toBe(true);
  });
});

describe('계약 테스트 — 스위치 OFF 에서 10종 전부 거부 (R8.14)', () => {
  it('모든 위험 능력이 기본 상태에서 거부된다', () => {
    for (const capability of RISKY_CAPABILITIES) {
      const d = guard.check(BROKER, { capability, approval: approval('x'), payloadDigest: 'x' });
      expect(d.allowed, `${capability} 가 OFF 인데 허용되었다`).toBe(false);
      expect(d.reason).toBe('switch-off');
    }
  });

  it('거부가 전부 원장에 남는다', () => {
    for (const capability of RISKY_CAPABILITIES) {
      guard.check(BROKER, { capability, approval: approval('x'), payloadDigest: 'x' });
    }
    expect(ledger.query({ kind: 'deny' })).toHaveLength(10);
  });
});

describe('유효기간 (R8.4, R8.5)', () => {
  it('유효 시간 없이는 켤 수 없다', () => {
    expect(() => store.enable(OWNER, { capability: 'spend', ttlMs: 0 })).toThrow(SwitchValidationError);
    expect(() => store.enable(OWNER, { capability: 'spend', ttlMs: -1 })).toThrow(SwitchValidationError);
    expect(() => store.enable(OWNER, { capability: 'spend', ttlMs: Number.NaN })).toThrow(SwitchValidationError);
  });

  it('켜면 만료 시각이 기록된다', () => {
    const s = store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    expect(s.enabled).toBe(true);
    expect(s.expiresAt).toBe(new Date(nowMs + 60_000).toISOString());
  });

  it('만료 전에는 허용된다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    nowMs += 30_000;
    const d = guard.check(BROKER, { capability: 'spend', approval: approval('p'), payloadDigest: 'p' });
    expect(d.allowed).toBe(true);
  });

  it('만료되면 자동으로 OFF 로 돌아간다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    nowMs += 60_001;
    expect(store.get(OWNER, 'spend').enabled).toBe(false);
    const d = guard.check(BROKER, { capability: 'spend', approval: approval('p'), payloadDigest: 'p' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('switch-off');
  });

  it('자동 OFF 가 원장에 사유와 함께 남는다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 1000 });
    nowMs += 2000;
    store.list(OWNER);
    const changes = ledger.query({ kind: 'switch.change' });
    expect(changes.some((e) => (e.summary ?? '').includes('유효기간 만료'))).toBe(true);
  });
});

describe('재부팅 시 전부 OFF (R17.3)', () => {
  it('다른 부팅 세션의 부여는 무효다', () => {
    store.enable(OWNER, { capability: 'product_delete', ttlMs: 3_600_000 });
    expect(store.get(OWNER, 'product_delete').enabled).toBe(true);

    // 같은 파일을 다른 부팅 세션에서 읽는다 = 재부팅
    build('boot-after-reboot');
    expect(store.get(OWNER, 'product_delete').enabled).toBe(false);
  });

  it('재부팅 무효화가 원장에 남는다', () => {
    store.enable(OWNER, { capability: 'product_delete', ttlMs: 3_600_000 });
    build('boot-after-reboot');
    store.list(OWNER);
    const changes = ledger.query({ kind: 'switch.change' });
    expect(changes.some((e) => (e.summary ?? '').includes('재부팅'))).toBe(true);
  });

  it('부팅 세션 식별자가 실제로 생성된다', () => {
    expect(currentBootId()).toMatch(/^boot-\d+$/);
    expect(currentBootId()).toBe(currentBootId());
  });
});

describe('구역 격리 (R8.7, R8.8, R15.8)', () => {
  it('좌석 구역은 읽을 수 없다', () => {
    expect(() => store.list(SEAT)).toThrow(ZoneForbiddenError);
  });

  it('좌석의 읽기 시도가 원장에 남는다', () => {
    expect(() => store.get(SEAT, 'spend')).toThrow();
    const denies = ledger.query({ kind: 'deny' });
    expect(denies).toHaveLength(1);
    expect(denies[0]?.actor.kind).toBe('agent');
    expect(denies[0]?.summary).toContain('읽으려 시도');
  });

  it('좌석 구역은 변경할 수 없다', () => {
    expect(() => store.enable(SEAT, { capability: 'spend', ttlMs: 1000 })).toThrow(ZoneForbiddenError);
    expect(store.get(OWNER, 'spend').enabled).toBe(false);
  });

  it('브로커 구역도 변경할 수 없다 — 오너만 바꾼다', () => {
    expect(() => store.enable(BROKER, { capability: 'spend', ttlMs: 1000 })).toThrow(ZoneForbiddenError);
  });

  it('단계별 인증 없는 오너 요청을 거부한다', () => {
    const noStepUp: Caller = { zone: 'owner', id: 'owner', device: 'phone-1' };
    expect(() => store.enable(noStepUp, { capability: 'spend', ttlMs: 1000 })).toThrow(ZoneForbiddenError);
    expect(ledger.query({ kind: 'deny' }).some((e) => (e.summary ?? '').includes('단계별 인증'))).toBe(true);
  });
});

describe('범위 지정 (R8.12)', () => {
  it('범위가 없으면 대상을 가리지 않는다', () => {
    store.enable(OWNER, { capability: 'dm_send', ttlMs: 60_000 });
    const d = guard.check(BROKER, {
      capability: 'dm_send',
      channel: 'instagram',
      approval: approval('p'),
      payloadDigest: 'p',
    });
    expect(d.allowed).toBe(true);
  });

  it('범위 안 채널은 허용한다', () => {
    store.enable(OWNER, { capability: 'dm_send', ttlMs: 60_000, scope: { channels: ['threads'] } });
    const d = guard.check(BROKER, {
      capability: 'dm_send',
      channel: 'threads',
      approval: approval('p'),
      payloadDigest: 'p',
    });
    expect(d.allowed).toBe(true);
  });

  it('범위 밖 채널은 거부한다', () => {
    store.enable(OWNER, { capability: 'dm_send', ttlMs: 60_000, scope: { channels: ['threads'] } });
    const d = guard.check(BROKER, {
      capability: 'dm_send',
      channel: 'instagram',
      approval: approval('p'),
      payloadDigest: 'p',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('out-of-scope');
  });

  it('범위가 지정됐는데 대상을 안 주면 거부한다', () => {
    store.enable(OWNER, { capability: 'dm_send', ttlMs: 60_000, scope: { channels: ['threads'] } });
    const d = guard.check(BROKER, { capability: 'dm_send', approval: approval('p'), payloadDigest: 'p' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('out-of-scope');
  });

  it('계정 범위도 같은 규칙을 따른다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000, scope: { accounts: ['brand-main'] } });
    expect(
      guard.check(BROKER, { capability: 'spend', account: 'brand-main', approval: approval('p'), payloadDigest: 'p' })
        .allowed,
    ).toBe(true);
    expect(
      guard.check(BROKER, { capability: 'spend', account: 'other', approval: approval('p'), payloadDigest: 'p' })
        .allowed,
    ).toBe(false);
  });
});

describe('오염 차단 (R16.5)', () => {
  it('오염된 산출물은 스위치가 ON 이어도 거부된다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    const d = guard.check(BROKER, {
      capability: 'spend',
      tainted: true,
      approval: approval('p'),
      payloadDigest: 'p',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('tainted');
  });

  it('오염 검사가 승인 검사보다 앞이다 — 승인해도 못 지나간다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    const withApproval = guard.check(BROKER, {
      capability: 'spend',
      tainted: true,
      approval: approval('p'),
      payloadDigest: 'p',
    });
    expect(withApproval.reason).toBe('tainted');
  });

  it('오염 거부가 원장에 오염 표시와 함께 남는다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    guard.check(BROKER, { capability: 'spend', tainted: true, approval: approval('p'), payloadDigest: 'p' });
    expect(ledger.query({ kind: 'deny', tainted: true })).toHaveLength(1);
  });
});

describe('스위치는 승인을 대체하지 않는다 (R8.6)', () => {
  it('ON 이어도 승인 영수증이 없으면 거부한다', () => {
    store.enable(OWNER, { capability: 'order_cancel_refund', ttlMs: 60_000 });
    const d = guard.check(BROKER, { capability: 'order_cancel_refund' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no-approval');
  });

  it('승인 후 페이로드가 바뀌면 영수증이 무효다 (R4.6)', () => {
    store.enable(OWNER, { capability: 'order_cancel_refund', ttlMs: 60_000 });
    const d = guard.check(BROKER, {
      capability: 'order_cancel_refund',
      approval: approval(digestPayload('원래 내용')),
      payloadDigest: digestPayload('바뀐 내용'),
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('approval-digest-mismatch');
  });

  it('digest 가 일치하면 통과한다', () => {
    store.enable(OWNER, { capability: 'order_cancel_refund', ttlMs: 60_000 });
    const d = digestPayload('환불 3건');
    expect(
      guard.check(BROKER, { capability: 'order_cancel_refund', approval: approval(d), payloadDigest: d }).allowed,
    ).toBe(true);
  });
});

describe('전체 차단 (R8.13)', () => {
  it('켜진 능력을 모두 끈다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    store.enable(OWNER, { capability: 'dm_send', ttlMs: 60_000 });
    store.panicDisableAll(OWNER, '이상 징후');
    expect(store.list(OWNER).every((s) => !s.enabled)).toBe(true);
  });

  it('진행 중 작업에 중단 신호를 보낸다', () => {
    const seen: string[] = [];
    store.onPanic((reason) => seen.push(reason));
    store.panicDisableAll(OWNER, '이상 징후');
    expect(seen).toEqual(['이상 징후']);
  });

  it('구독 해지가 동작한다', () => {
    const seen: string[] = [];
    const off = store.onPanic((r) => seen.push(r));
    off();
    store.panicDisableAll(OWNER, 'x');
    expect(seen).toEqual([]);
  });

  it('단계별 인증을 요구하지 않는다 — 킬 스위치에 마찰을 두지 않는다', () => {
    const noStepUp: Caller = { zone: 'owner', id: 'owner', device: 'phone-1' };
    expect(() => store.panicDisableAll(noStepUp)).not.toThrow();
  });

  it('시스템 구역도 전체 차단을 부를 수 있다 — 자동 방어가 쓴다', () => {
    expect(() => store.panicDisableAll({ zone: 'system', id: 'anomaly-detector' })).not.toThrow();
  });

  it('좌석 구역은 전체 차단조차 부를 수 없다', () => {
    expect(() => store.panicDisableAll(SEAT)).toThrow(ZoneForbiddenError);
  });
});

describe('알림 (R8.10)', () => {
  it('켤 때 알린다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('spend');
    expect(notices[0]).toContain('만료');
  });

  it('전체 차단도 알린다', () => {
    store.panicDisableAll(OWNER, '테스트');
    expect(notices.some((n) => n.includes('전체 차단'))).toBe(true);
  });
});

describe('원장 기록 (R8.11)', () => {
  it('변경에 기기·만료·범위가 남는다', () => {
    store.enable(OWNER, {
      capability: 'price_bulk_change',
      ttlMs: 60_000,
      scope: { channels: ['smartstore'] },
    });
    const e = ledger.query({ kind: 'switch.change' })[0];
    expect(e?.level).toBe('L3');
    expect(e?.summary).toContain('phone-1');
    expect(e?.summary).toContain('smartstore');
    expect(e?.summary).toContain('만료');
  });

  it('OFF 도 기록된다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    store.disable(OWNER, 'spend');
    expect(ledger.query({ kind: 'switch.change' })).toHaveLength(2);
  });

  it('체인이 온전하게 유지된다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000 });
    guard.check(BROKER, { capability: 'dm_send' });
    store.panicDisableAll(OWNER);
    expect(ledger.verify().ok).toBe(true);
  });
});

describe('스위치 화면 (R8.15)', () => {
  it('남은 시간과 범위, 최근 거부 건수를 보여준다', () => {
    store.enable(OWNER, { capability: 'spend', ttlMs: 60_000, scope: { channels: ['smartstore'] } });
    guard.check(BROKER, { capability: 'spend', tainted: true, approval: approval('p'), payloadDigest: 'p' });

    nowMs += 10_000;
    const row = store.view(OWNER).find((v) => v.capability === 'spend');
    expect(row?.enabled).toBe(true);
    expect(row?.remainingMs).toBe(50_000);
    expect(row?.scope.channels).toEqual(['smartstore']);
    expect(row?.recentDenials).toBe(1);
    expect(row?.lastChangedBy?.device).toBe('phone-1');
  });

  it('OFF 인 능력의 남은 시간은 null 이다', () => {
    const row = store.view(OWNER).find((v) => v.capability === 'account_delete');
    expect(row?.enabled).toBe(false);
    expect(row?.remainingMs).toBeNull();
  });
});
