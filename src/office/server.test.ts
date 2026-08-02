import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { ApprovalService } from '../policy/approval.js';
import { CapabilityStore } from '../capabilities/store.js';
import { DEFAULT_POLICY } from '../policy/policy.js';
import { OfficeServer } from './server.js';
import { DeviceStore } from './tokens.js';
import { RefuseAllStepUp, TotpStepUp, totpCode, base32Decode } from './stepup.js';

let dir: string;
let ledger: Ledger;
let devices: DeviceStore;
let approvals: ApprovalService;
let capabilities: CapabilityStore;
let server: OfficeServer;
let base: string;
let token: string;
let deviceId: string;

/** 서버를 띄우고 기기 하나를 등록한다. */
async function boot(stepUp = new RefuseAllStepUp()): Promise<void> {
  server = new OfficeServer({
    ledger,
    approvals,
    capabilities,
    devices,
    stepUp,
    host: '127.0.0.1',
    port: 0,
    pollMs: 50,
  });
  const { host, port } = await server.listen();
  base = `http://${host}:${port}`;
}

function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const auth = init.token === null ? {} : { authorization: `Bearer ${init.token ?? token}` };
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...auth, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-office-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  devices = new DeviceStore({ file: join(dir, 'devices.json'), ledger });
  approvals = new ApprovalService({ file: join(dir, 'approvals.json'), ledger, policy: DEFAULT_POLICY });
  capabilities = new CapabilityStore({ file: join(dir, 'caps.json'), ledger });
  const issued = devices.issue('테스트 폰', 'mobile');
  token = issued.token;
  deviceId = issued.record.id;
  await boot();
});

afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('인증 (R14.3)', () => {
  it('토큰이 없으면 어떤 경로도 보지 못한다', async () => {
    for (const path of ['/api/state', '/api/approvals', '/api/capabilities', '/api/devices']) {
      const res = await call(path, { token: null });
      expect(res.status, path).toBe(401);
    }
  });

  it('틀린 토큰을 거부한다', async () => {
    expect((await call('/api/state', { token: 'wrong' })).status).toBe(401);
  });

  it('유효한 토큰은 통과한다', async () => {
    expect((await call('/api/state')).status).toBe(200);
  });
});

describe('기기 폐기 (R14.4)', () => {
  it('폐기하면 즉시 거부된다 — 재기동을 기다리지 않는다', async () => {
    expect((await call('/api/state')).status).toBe(200);
    expect(devices.revoke(deviceId)).toBe(true);
    expect((await call('/api/state')).status).toBe(401);
  });

  it('폐기가 원장에 남는다', async () => {
    devices.revoke(deviceId);
    const events = ledger.query({ kind: 'device.change' });
    expect(events.some((e) => e.summary?.includes('폐기'))).toBe(true);
  });

  it('이미 폐기한 기기를 다시 폐기하지 않는다', () => {
    expect(devices.revoke(deviceId)).toBe(true);
    expect(devices.revoke(deviceId)).toBe(false);
  });

  it('토큰 원본은 저장되지 않는다', () => {
    const stored = JSON.stringify(devices.list());
    expect(stored).not.toContain(token);
  });
});

describe('라이브오피스 (R10)', () => {
  it('이벤트가 없으면 합성하지 않고 빈 목록을 준다 (R10.3)', async () => {
    const body = (await (await call('/api/state')).json()) as {
      running: unknown[];
      synthesized: boolean;
    };
    expect(body.running).toEqual([]);
    expect(body.synthesized).toBe(false);
  });

  it('진행 중 실행의 주체·작업·경과·증거를 보고한다 (R10.2)', async () => {
    ledger.append({
      actor: { kind: 'agent', id: 'cmo', seat: 'codex' },
      kind: 'seat.call',
      runId: 'r1',
      summary: '블로그 초안',
      evidence: ['a', 'b'],
    });
    const body = (await (await call('/api/state')).json()) as {
      running: Array<{ runId: string; task: string; seat: string; evidenceCount: number }>;
    };
    expect(body.running).toHaveLength(1);
    expect(body.running[0]?.task).toBe('블로그 초안');
    expect(body.running[0]?.seat).toBe('codex');
    expect(body.running[0]?.evidenceCount).toBe(2);
  });

  it('종결된 실행은 진행 중으로 세지 않는다', async () => {
    ledger.append({ actor: { kind: 'agent', id: 'cmo' }, kind: 'seat.call', runId: 'r2', summary: '초안' });
    ledger.append({ actor: { kind: 'system', id: 'pub' }, kind: 'publish', runId: 'r2', summary: '발행 완료' });
    const body = (await (await call('/api/state')).json()) as { running: unknown[] };
    expect(body.running).toEqual([]);
  });

  it('since 로 누락 구간을 메운다 (R10.4)', async () => {
    const marks: number[] = [];
    for (let i = 0; i < 5; i++) {
      marks.push(ledger.append({ actor: { kind: 'system', id: 's' }, kind: 'seat.call', summary: `e${i}` }).seq);
    }
    // 두 번째 이벤트까지 봤다고 치면 그 뒤 셋만 와야 한다.
    const since = marks[1]!;
    const body = (await (await call(`/api/history?since=${since}`)).json()) as {
      events: Array<{ seq: number }>;
    };
    expect(body.events.every((e) => e.seq > since)).toBe(true);
    expect(body.events.map((e) => e.seq)).toEqual(marks.slice(2));
  });

  it('SSE 가 접속 즉시 누락분을 흘려보낸다', async () => {
    for (let i = 0; i < 3; i++) {
      ledger.append({ actor: { kind: 'system', id: 's' }, kind: 'seat.call', summary: `x${i}` });
    }
    const res = await fetch(`${base}/api/events?since=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('data:');
    expect(chunk).toContain('x1');
    await reader.cancel();
  });
});

describe('승인 (R14.6, R14.7)', () => {
  function card(level: 'L2' | 'L3'): string {
    return approvals.create({
      classification: {
        action: level === 'L3' ? 'publish.irreversible' : 'draft.write',
        baseLevel: level,
        level,
        escalatedBy: [],
        needsApproval: true,
        needsStepUp: level === 'L3',
        irreversible: level === 'L3',
      },
      payloadDigest: 'd'.repeat(64),
      summary: '테스트',
    }).id;
  }

  it('L2 는 단계별 인증 없이 승인된다', async () => {
    const res = await call(`/api/approvals/${card('L2')}/approve`, { method: 'POST', body: {} });
    expect(res.status).toBe(200);
  });

  it('L3 은 단계별 인증 없이 승인되지 않는다 (R14.7)', async () => {
    const res = await call(`/api/approvals/${card('L3')}/approve`, { method: 'POST', body: {} });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('step-up-required');
  });

  it('기본 검증기는 전부 거부한다 — 등록 없이 L3 이 통과하지 않는다', async () => {
    const res = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { stepUp: '123456' },
    });
    expect(res.status).toBe(403);
  });

  it('L3 거부가 원장에 남는다', async () => {
    await call(`/api/approvals/${card('L3')}/approve`, { method: 'POST', body: {} });
    const denies = ledger.query({ kind: 'deny' });
    expect(denies.some((e) => e.summary?.includes('단계별 인증 실패'))).toBe(true);
  });

  it('TOTP 를 등록하면 L3 이 통과한다', async () => {
    server.close();
    const totp = new TotpStepUp({ file: join(dir, 'totp.json') });
    const { secret } = totp.enroll(deviceId);
    await boot(totp);
    const code = totpCode(base32Decode(secret), Date.now());
    const res = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { stepUp: code },
    });
    expect(res.status).toBe(200);
  });

  it('같은 코드를 두 번 쓰지 못한다', async () => {
    server.close();
    const totp = new TotpStepUp({ file: join(dir, 'totp.json') });
    const { secret } = totp.enroll(deviceId);
    await boot(totp);
    const code = totpCode(base32Decode(secret), Date.now());
    const first = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { stepUp: code },
    });
    expect(first.status).toBe(200);
    const second = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { stepUp: code },
    });
    expect(second.status).toBe(403);
  });
});

describe('능력 스위치 (R14.8)', () => {
  it('유효기간 없이 켜지 못한다 — 데스크톱과 같은 규칙', async () => {
    const res = await call('/api/capabilities/dm_send/on', { method: 'POST', body: {} });
    // 단계별 인증이 먼저 막는다. 등록 후에도 ttl 은 여전히 필수다.
    expect([400, 403]).toContain(res.status);
  });

  it('끄기도 단계별 인증을 요구한다 — 능력 스토어보다 느슨해지지 않는다', async () => {
    const res = await call('/api/capabilities/dm_send/off', { method: 'POST', body: {} });
    expect(res.status).toBe(403);
  });

  it('등록된 코드로는 끄기가 통과한다', async () => {
    server.close();
    const totp = new TotpStepUp({ file: join(dir, 'totp.json') });
    const { secret } = totp.enroll(deviceId);
    await boot(totp);
    const res = await call('/api/capabilities/dm_send/off', {
      method: 'POST',
      body: { stepUp: totpCode(base32Decode(secret), Date.now()) },
    });
    expect(res.status).toBe(200);
  });

  it('전체 차단은 마찰 없이 통과한다', async () => {
    const res = await call('/api/panic', { method: 'POST', body: { reason: '테스트' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { states: Array<{ enabled: boolean }> };
    expect(body.states.every((s) => !s.enabled)).toBe(true);
  });

  it('알 수 없는 능력은 거부한다', async () => {
    const res = await call('/api/capabilities/made_up/off', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
  });
});

describe('바인딩 거부 (R14.2)', () => {
  it('공개 인터페이스로는 기동하지 않는다', async () => {
    const bad = new OfficeServer({
      ledger,
      approvals,
      capabilities,
      devices,
      stepUp: new RefuseAllStepUp(),
      host: '0.0.0.0',
    });
    await expect(bad.listen()).rejects.toThrow(/기동 거부/);
  });
});
