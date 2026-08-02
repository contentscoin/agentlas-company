/**
 * 최소 MCP stdio 클라이언트
 *
 * `agentlas-browser-cdp.mjs` 는 MCP stdio 서버다. 우리는 그 계약의
 * **세 부분만** 쓴다: `initialize`, `tools/list`, `tools/call`.
 * SDK 를 끌어오지 않는 이유는 의존성 하나를 아끼려는 것이 아니라, 우리가
 * 쓰는 표면을 이 파일 안에서 전부 읽을 수 있게 하려는 것이다.
 *
 * 프레이밍은 줄 단위 JSON 이다 — 런처가 `writeOutput(JSON.stringify(obj) + '\n')`
 * 으로 쓰고 클라이언트 줄을 그대로 파싱하는 것을 확인했다.
 *
 * 타임아웃이 지나면 프로세스 트리를 죽인다. 응답을 못 받은 것을 성공으로
 * 해석할 경로는 두지 않는다.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { killTree } from '../proc/index.js';

export interface McpToolResult {
  ok: boolean;
  /** 도구가 돌려준 텍스트 조각을 이어 붙인 것. */
  text: string;
  /** MCP `isError` 플래그. 전송은 성공했지만 도구가 실패한 경우다. */
  toolError: boolean;
}

export interface McpClientOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class McpClient {
  private child: ChildProcess | null = null;
  private reader: Interface | null = null;
  private readonly pending = new Map<string | number, Pending>();
  private seq = 0;
  private closed = false;
  private readonly timeoutMs: number;
  /** 서버 stderr. 실패 진단에 쓰되 판정 근거로 쓰지 않는다. */
  readonly stderr: string[] = [];

  constructor(private readonly opts: McpClientOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.opts.command, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.opts.env ?? process.env,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      // 프로세스 트리 종료는 proc 계층(killTree)에 맡긴다. Windows 에는
      // SIGKILL 도 프로세스 그룹도 없어서 taskkill /T /F 가 필요하다 —
      // 그 분기가 이미 캡슐화되어 있다.
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderr.length < 200) this.stderr.push(chunk.toString('utf8').trimEnd());
    });
    this.child.on('exit', () => this.failAll(new Error('MCP 서버가 종료되었다')));
    this.child.on('error', (err) => this.failAll(err));

    if (this.child.stdout) {
      this.reader = createInterface({ input: this.child.stdout });
      this.reader.on('line', (line) => this.onLine(line));
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 서버가 진단 문구를 stdout 에 흘릴 수 있다. 응답이 아니면 무시한다.
      return;
    }
    const id = msg.id as string | number | undefined;
    if (id === undefined) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  }

  private failAll(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (!this.child?.stdin) return Promise.reject(new Error('MCP 서버가 시작되지 않았다'));
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 응답 시간 초과 (${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(payload, (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agentlas-company', version: '0' },
    });
    // notifications/initialized 는 응답이 없는 알림이다.
    this.child?.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  async listTools(): Promise<string[]> {
    const msg = await this.request('tools/list', {});
    const result = msg.result as { tools?: Array<{ name?: unknown }> } | undefined;
    return (result?.tools ?? [])
      .map((t) => t.name)
      .filter((n): n is string => typeof n === 'string');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const msg = await this.request('tools/call', { name, arguments: args });
    if (msg.error) {
      const err = msg.error as { message?: unknown };
      return { ok: false, toolError: false, text: String(err.message ?? 'MCP 오류') };
    }
    const result = msg.result as
      | { content?: Array<{ type?: string; text?: unknown }>; isError?: unknown }
      | undefined;
    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    const toolError = result?.isError === true;
    return { ok: !toolError, toolError, text };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('클라이언트를 닫았다'));
    this.reader?.close();
    const child = this.child;
    this.child = null;
    // 런처는 Chrome 과 @playwright/mcp 를 자식으로 띄운다. 부모만 죽이면
    // 그것들이 남는다. 트리째 정리하는 것은 proc 계층의 책임이다.
    killTree(child?.pid);
  }
}
