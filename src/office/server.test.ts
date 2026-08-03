import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, hashEvent } from '../ledger/ledger.js';
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
  /** 화면이 표시했을 digest. 승인은 이 값에 묶인다 (R4.6). */
  const DIGEST = 'd'.repeat(64);

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
      payloadDigest: DIGEST,
      summary: '테스트',
    }).id;
  }

  it('L2 는 단계별 인증 없이 승인된다', async () => {
    const res = await call(`/api/approvals/${card('L2')}/approve`, {
      method: 'POST',
      body: { digest: DIGEST },
    });
    expect(res.status).toBe(200);
  });

  it('L3 은 단계별 인증 없이 승인되지 않는다 (R14.7)', async () => {
    const res = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { digest: DIGEST },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('step-up-required');
  });

  it('기본 검증기는 전부 거부한다 — 등록 없이 L3 이 통과하지 않는다', async () => {
    const res = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { digest: DIGEST, stepUp: '123456' },
    });
    expect(res.status).toBe(403);
  });

  it('L3 거부가 원장에 남는다', async () => {
    await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { digest: DIGEST },
    });
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
      body: { digest: DIGEST, stepUp: code },
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
      body: { digest: DIGEST, stepUp: code },
    });
    expect(first.status).toBe(200);
    const second = await call(`/api/approvals/${card('L3')}/approve`, {
      method: 'POST',
      body: { digest: DIGEST, stepUp: code },
    });
    expect(second.status).toBe(403);
  });

  describe('승인은 화면에 보인 것에 묶인다 (R4.5, R4.6)', () => {
    /**
     * 처음에는 서버가 카드의 digest 를 꺼내 카드 자신과 비교했다. 승인자의
     * 화면이 비교에 들어가지 않아 검사가 성립하지 않았다 — 콘솔을 만들면서
     * 드러났다.
     */
    it('digest 없이 승인되지 않는다', async () => {
      const res = await call(`/api/approvals/${card('L2')}/approve`, { method: 'POST', body: {} });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('digest-required');
    });

    it('낡은 화면에서 누른 승인은 통과하지 않는다', async () => {
      const id = card('L2');
      // 화면이 표시했던 값과 다른 것을 보낸다 = 그 사이 대상이 바뀐 상황.
      const res = await call(`/api/approvals/${id}/approve`, {
        method: 'POST',
        body: { digest: 'e'.repeat(64) },
      });
      expect(res.status).toBe(409);
    });

    it('거부는 digest 를 요구하지 않는다 — 아니오는 언제나 아니오다', async () => {
      const res = await call(`/api/approvals/${card('L2')}/reject`, { method: 'POST', body: {} });
      expect(res.status).toBe(200);
    });

    it('껍데기에 회사 정보가 들어 있지 않다', async () => {
      // 승인 카드를 만들어 둔 상태에서도 화면 자체는 데이터를 담지 않는다.
      card('L3');
      const html = await (await fetch(`${base}/`)).text();
      expect(html).not.toContain('publish.irreversible');
      expect(html).not.toContain('d'.repeat(64));
    });
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

describe('콘솔 껍데기 (R14.4)', () => {
  it('토큰 없이 화면을 받는다 — 첫 요청은 헤더를 실을 수 없다', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('승인');
  });

  it('데이터 경로는 여전히 토큰을 요구한다', async () => {
    for (const path of ['/api/approvals', '/api/state', '/api/capabilities', '/api/devices']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it('질의 문자열 토큰은 SSE 에서만 통한다', async () => {
    const res = await fetch(`${base}/api/approvals?token=${token}`);
    expect(res.status).toBe(401);
  });
});

describe('진행 중인 실행 (R10.2)', () => {
  /**
   * 예전에는 마지막 이벤트의 `kind` 로 판정했다. 시작·일시정지·완료가 전부
   * `decision` 이라 **막 시작한 실행이 "실행 중 0건" 으로 보였다** —
   * 콘솔에 실행 화면을 붙이고 진짜 레시피를 돌려서 드러났다.
   */
  it('막 시작한 실행이 보인다', async () => {
    ledger.append({
      actor: { kind: 'system', id: 'recipe-engine' },
      kind: 'decision',
      runId: 'run-a',
      runPhase: 'start',
      summary: 'demo 실행 시작',
    });
    const body = await (await call('/api/state')).json();
    expect(body.running).toHaveLength(1);
    expect(body.running[0].runId).toBe('run-a');
    expect(body.running[0].derived).toBe(false);
  });

  it('끝난 실행은 빠진다', async () => {
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-b', runPhase: 'start' });
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-b', runPhase: 'end' });
    const body = await (await call('/api/state')).json();
    expect(body.running.map((r: { runId: string }) => r.runId)).not.toContain('run-b');
  });

  it('승인 대기로 멈춘 실행은 진행 중이 아니다', async () => {
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-c', runPhase: 'start' });
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-c', runPhase: 'pause' });
    const body = await (await call('/api/state')).json();
    expect(body.running.map((r: { runId: string }) => r.runId)).not.toContain('run-c');
  });

  it('재개하면 다시 진행 중이다', async () => {
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-d', runPhase: 'start' });
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-d', runPhase: 'pause' });
    ledger.append({ actor: { kind: 'system', id: 'r' }, kind: 'decision', runId: 'run-d', runPhase: 'resume' });
    const body = await (await call('/api/state')).json();
    expect(body.running.map((r: { runId: string }) => r.runId)).toContain('run-d');
  });

  it('표시 없는 옛 이벤트는 추정으로 판정하고 그 사실을 밝힌다', async () => {
    ledger.append({
      actor: { kind: 'system', id: 'seat' },
      kind: 'seat.call',
      runId: 'run-old',
      summary: '좌석 호출',
    });
    const body = await (await call('/api/state')).json();
    const row = body.running.find((r: { runId: string }) => r.runId === 'run-old');
    expect(row).toBeTruthy();
    expect(row.derived).toBe(true);
  });
});

describe('원장 수명주기 표시는 해시가 덮는다', () => {
  /**
   * 디스크에만 쓰고 정본에서 빼면 실행 상태를 체인을 깨지 않고 바꿀 수 있다.
   */
  it('runPhase 를 바꾸면 체인이 깨진다', () => {
    const e = ledger.append({
      actor: { kind: 'system', id: 'r' },
      kind: 'decision',
      runId: 'run-h',
      runPhase: 'end',
    });
    expect(e.runPhase).toBe('end');
    const tampered = { ...e, runPhase: 'start' as const };
    expect(hashEvent(tampered)).not.toBe(e.hash);
  });
});
