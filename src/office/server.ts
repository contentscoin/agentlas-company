/**
 * 오피스 API — 데스크톱과 모바일이 같은 것을 본다 (R10, R14)
 *
 * 한 API 를 두 클라이언트가 소비한다 (R14.5). 모바일 전용 축약본을 따로
 * 두지 않는 이유는, 두 개가 되는 순간 둘이 달라지고 폰에서 본 것이 사실이
 * 아니게 되기 때문이다. 화면 크기는 클라이언트가 해결할 문제다.
 *
 * **라이브오피스는 합성하지 않는다 (R10.3).** 표시할 이벤트가 없으면 빈
 * 목록을 준다. "지금 작업 중인 것처럼 보이는" 응답을 만들어 내지 않는다 —
 * 이 요구사항이 존재하는 이유는 그런 연출이 흔하기 때문이다.
 *
 * 재연결 시 누락 구간은 `?since=<seq>` 로 메운다 (R10.4). 원장이 seq 를
 * 단조 증가로 보장하므로, 클라이언트는 마지막으로 본 seq 만 기억하면 된다.
 * 서버가 재시작해도 seq 는 이어진다.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Ledger } from '../ledger/ledger.js';
import type { LedgerEvent } from '../ledger/types.js';
import type { ApprovalService } from '../policy/approval.js';
import type { CapabilityStore } from '../capabilities/store.js';
import { isRiskyCapability, type Caller } from '../capabilities/types.js';
import { parseTtl } from '../capabilities/ttl.js';
import { assertBindable } from './bind.js';
import type { DeviceRecord, DeviceStore } from './tokens.js';
import type { StepUpVerifier } from './stepup.js';

export interface OfficeServerOptions {
  ledger: Ledger;
  approvals: ApprovalService;
  capabilities: CapabilityStore;
  devices: DeviceStore;
  stepUp: StepUpVerifier;
  host?: string;
  port?: number;
  /** SSE 폴링 간격. 원장은 파일이라 변경 통지가 없어 짧게 다시 읽는다. */
  pollMs?: number;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  device: DeviceRecord;
  body: Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 브라우저 콘솔이 로컬에서 붙는다. 자격증명은 Authorization 헤더로만 오간다.
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // 승인 API 에 큰 본문이 올 이유가 없다. 메모리를 지킨다.
    if (size > 64 * 1024) throw new Error('본문이 너무 크다');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class OfficeServer {
  private readonly opts: OfficeServerOptions;
  private server: Server | null = null;
  private readonly streams = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: OfficeServerOptions) {
    this.opts = opts;
  }

  /**
   * 오너 구역 호출자.
   *
   * `stepUp` 은 이 요청에서 두 번째 요소를 실제로 검증했을 때만 참이다.
   * 기본값을 참으로 두면 능력 스토어의 R8.7 검사가 무력화된다 — API 가
   * 스토어보다 느슨해지는 순간 스토어의 규칙은 없는 것이 된다.
   */
  private caller(device: DeviceRecord, stepUp = false): Caller {
    return { zone: 'owner', id: `device:${device.id}`, device: device.label, stepUp };
  }

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? '127.0.0.1';
    // 기동 거부는 여기서 일어난다. 서버를 만들기 전에 판정한다 (R14.2).
    assertBindable(host);

    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: 'internal' });
        else res.end();
      });
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.startPump();
    return { host, port };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.server?.close();
    this.server = null;
  }

  get address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? { host: addr.address, port: addr.port } : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://office.invalid');

    // 인증이 가장 앞이다. 토큰 없는 요청은 어떤 경로도 보지 못한다 (R14.3).
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const device = this.opts.devices.verify(token);
    if (!device) {
      json(res, 401, { error: 'device-token-required' });
      return;
    }
    this.opts.devices.touch(device.id);

    if (url.pathname === '/api/events' && req.method === 'GET') {
      this.openStream(req, res, url);
      return;
    }

    const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : {};
    const ctx: Ctx = { req, res, url, device, body };
    const route = `${req.method} ${url.pathname}`;

    switch (true) {
      case route === 'GET /api/state':
        return this.getState(ctx);
      case route === 'GET /api/history':
        return this.getHistory(ctx);
      case route === 'GET /api/approvals':
        return this.getApprovals(ctx);
      case /^POST \/api\/approvals\/[^/]+\/(approve|reject)$/.test(route):
        return this.decideApproval(ctx);
      case route === 'GET /api/capabilities':
        return this.getCapabilities(ctx);
      case /^POST \/api\/capabilities\/[^/]+\/(on|off)$/.test(route):
        return this.setCapability(ctx);
      case route === 'POST /api/panic':
        return this.panic(ctx);
      case route === 'GET /api/devices':
        return json(res, 200, { devices: this.opts.devices.list() });
      default:
        return json(res, 404, { error: 'not-found' });
    }
  }

  // ── 라이브오피스 ────────────────────────────────────────────────

  /**
   * 지금 상태. 합성하지 않는다 (R10.3).
   *
   * `running` 은 원장에 시작 기록이 있고 종료 기록이 없는 실행이다. 추정이
   * 아니라 기록에서 유도한 사실이며, 기록이 없으면 빈 목록이다.
   */
  private getState(ctx: Ctx): void {
    const recent = this.opts.ledger.query({ limit: 200 });
    const running = this.runningRuns(recent);
    json(ctx.res, 200, {
      at: new Date().toISOString(),
      head: this.opts.ledger.head,
      running,
      pendingApprovals: this.opts.approvals.pending().length,
      capabilities: this.opts.capabilities.list(this.caller(ctx.device)),
      // 합성 금지의 증거 — 이벤트가 없으면 그렇다고 말한다.
      synthesized: false,
      eventCount: recent.length,
    });
  }

  /** 진행 중인 실행 — 주체·좌석·작업명·경과·증거 건수 (R10.2). */
  private runningRuns(events: readonly LedgerEvent[]): unknown[] {
    const byRun = new Map<string, LedgerEvent[]>();
    for (const e of events) {
      if (!e.runId) continue;
      const list = byRun.get(e.runId) ?? [];
      list.push(e);
      byRun.set(e.runId, list);
    }
    const now = Date.now();
    const out: unknown[] = [];
    for (const [runId, list] of byRun) {
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      // 종결 이벤트가 있으면 진행 중이 아니다.
      if (last.kind === 'publish' || last.kind === 'retro' || last.kind === 'decision') continue;
      out.push({
        runId,
        actor: first.actor,
        seat: first.actor.seat ?? null,
        task: first.summary ?? first.kind,
        startedAt: first.at,
        elapsedMs: now - Date.parse(first.at),
        evidenceCount: sorted.reduce((n, e) => n + (e.evidence?.length ?? 0), 0),
        tainted: sorted.some((e) => e.tainted === true),
      });
    }
    return out;
  }

  private getHistory(ctx: Ctx): void {
    const since = Number(ctx.url.searchParams.get('since') ?? '0');
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? '100'), 500);
    const events = this.opts.ledger
      .query({ limit: 1000 })
      .filter((e) => e.seq > since)
      .slice(-limit);
    json(ctx.res, 200, { events, head: this.opts.ledger.head });
  }

  /**
   * SSE 원장 tail (R10.1).
   *
   * 접속 즉시 `?since=` 이후의 누락분을 먼저 흘려보낸다 (R10.4). 그 다음부터
   * 새 이벤트를 이어 보낸다. 클라이언트가 끊긴 동안의 구간이 사라지지 않는다.
   */
  private openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });

    const since = Number(url.searchParams.get('since') ?? '0');
    const backlog = this.opts.ledger.query({ limit: 1000 }).filter((e) => e.seq > since);
    for (const event of backlog) this.write(res, event);

    const last = backlog[backlog.length - 1]?.seq ?? since;
    (res as ServerResponse & { lastSeq?: number }).lastSeq = last;
    this.streams.add(res);
    req.on('close', () => {
      this.streams.delete(res);
    });
  }

  private write(res: ServerResponse, event: LedgerEvent): void {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** 원장은 파일이라 변경 통지가 없다. 짧게 다시 읽어 새 이벤트만 밀어낸다. */
  private startPump(): void {
    const interval = this.opts.pollMs ?? 500;
    this.timer = setInterval(() => {
      if (this.streams.size === 0) return;
      const recent = this.opts.ledger.query({ limit: 200 });
      for (const res of this.streams) {
        const tracked = res as ServerResponse & { lastSeq?: number };
        const from = tracked.lastSeq ?? 0;
        const fresh = recent.filter((e) => e.seq > from);
        for (const event of fresh) this.write(res, event);
        if (fresh.length > 0) tracked.lastSeq = fresh[fresh.length - 1]!.seq;
      }
    }, interval);
    this.timer.unref?.();
  }

  // ── 승인 (R14.6) ────────────────────────────────────────────────

  private getApprovals(ctx: Ctx): void {
    json(ctx.res, 200, { pending: this.opts.approvals.pending() });
  }

  /**
   * 승인·거부.
   *
   * L3 은 단계별 인증을 요구한다 (R14.7). 검증기가 통과시키지 않으면 승인
   * 자체를 시도하지 않는다 — 승인 서비스에 먼저 넣고 나중에 되돌리는 경로를
   * 만들면 되돌리기가 실패했을 때 승인이 남는다.
   */
  private decideApproval(ctx: Ctx): void {
    const parts = ctx.url.pathname.split('/');
    const id = parts[3] ?? '';
    const action = parts[4];
    const card = this.opts.approvals.pending().find((r) => r.id === id);
    if (!card) {
      json(ctx.res, 404, { error: 'approval-not-found' });
      return;
    }

    if (card.level === 'L3') {
      const proof = typeof ctx.body.stepUp === 'string' ? ctx.body.stepUp : '';
      const verdict = this.opts.stepUp.verify(ctx.device, proof, `approval:${id}`);
      if (!verdict.ok) {
        this.opts.ledger.append({
          actor: { kind: 'owner', id: `device:${ctx.device.id}` },
          kind: 'deny',
          level: 'L3',
          summary: `모바일 L3 승인 거부 — 단계별 인증 실패 (${verdict.reason})`,
        });
        json(ctx.res, 403, { error: 'step-up-required', reason: verdict.reason });
        return;
      }
    }

    // 신원은 오너다. 기기는 "누가" 가 아니라 "어떻게" 이므로 device 에 싣는다 —
    // 신원 허용목록(R4.4)은 오너를 알지 기기를 알지 못한다.
    const submitter = {
      identity: 'owner',
      device: ctx.device.label,
      // L3 은 위에서 두 번째 요소를 검증하고 내려온 것만 여기 닿는다.
      stepUp: card.level === 'L3',
    };
    const outcome =
      action === 'approve'
        ? this.opts.approvals.approve(id, submitter, card.payloadDigest)
        : this.opts.approvals.reject(id, submitter, String(ctx.body.reason ?? '오너 거부'));
    json(ctx.res, outcome.ok ? 200 : 409, outcome);
  }

  // ── 능력 스위치 (R14.8) ─────────────────────────────────────────

  private getCapabilities(ctx: Ctx): void {
    json(ctx.res, 200, { capabilities: this.opts.capabilities.list(this.caller(ctx.device)) });
  }

  private setCapability(ctx: Ctx): void {
    const parts = ctx.url.pathname.split('/');
    const name = decodeURIComponent(parts[3] ?? '');
    const action = parts[4];
    if (!isRiskyCapability(name)) {
      json(ctx.res, 400, { error: 'unknown-capability', capability: name });
      return;
    }

    // 켜기와 끄기 모두 단계별 인증을 요구한다 (R14.7).
    //
    // 끄기에 마찰을 두지 않는 편이 자연스러워 보이지만, 능력 스토어가
    // `disable` 에도 단계별 인증을 요구한다. 두 권한 모델이 어긋나면 낮은
    // 쪽 — 더 엄격한 쪽 — 을 택한다. API 가 스토어보다 느슨하면 스토어의
    // 규칙은 우회 가능한 장식이 된다. 마찰 없는 경로는 전체 차단뿐이다.
    const proof = typeof ctx.body.stepUp === 'string' ? ctx.body.stepUp : '';
    const verdict = this.opts.stepUp.verify(ctx.device, proof, `capability:${name}`);
    if (!verdict.ok) {
      json(ctx.res, 403, { error: 'step-up-required', reason: verdict.reason });
      return;
    }

    const caller = this.caller(ctx.device, true);
    try {
      if (action === 'off') {
        json(ctx.res, 200, { state: this.opts.capabilities.disable(caller, name) });
        return;
      }
      const ttlMs = parseTtl(String(ctx.body.ttl ?? ''));
      // 유효기간 없는 켜기는 없다 (R8.4). 데스크톱과 같은 규칙이다.
      if (ttlMs === null) {
        json(ctx.res, 400, { error: 'invalid-ttl', detail: '예: 2h, 30m, 1d' });
        return;
      }
      const channels = Array.isArray(ctx.body.channels)
        ? (ctx.body.channels as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
      const state = this.opts.capabilities.enable(caller, {
        capability: name,
        ttlMs,
        scope: { channels, accounts: [] },
      });
      json(ctx.res, 200, { state });
    } catch (err) {
      json(ctx.res, 403, { error: 'refused', detail: (err as Error).message });
    }
  }

  /** 전체 차단. 마찰을 두지 않는다 — 킬 스위치에 단계별 인증을 요구하지 않는다. */
  private panic(ctx: Ctx): void {
    const states = this.opts.capabilities.panicDisableAll(
      this.caller(ctx.device),
      String(ctx.body.reason ?? `모바일 전체 차단 (${ctx.device.label})`),
    );
    json(ctx.res, 200, { states });
  }
}
