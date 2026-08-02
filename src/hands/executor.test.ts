import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { McpClient } from './mcp.js';
import {
  HandsExecutor,
  checklistFrom,
  planDigest,
  toolArguments,
  type HandsRunInput,
} from './executor.js';
import { isMutating, planNeedsDesktop, type HandsStep } from './types.js';

let dir: string;
let ledger: Ledger;

const PLAN: HandsStep[] = [
  { op: 'navigate', url: 'https://blog.naver.com/write' },
  { op: 'click', element: '제목', ref: 'e1' },
  { op: 'type', element: '제목', ref: 'e1', text: '안녕' },
];

/**
 * 가짜 MCP stdio 서버를 파일로 만든다.
 *
 * 실제 런처 대신 이것을 물리면 전송 계층(줄 단위 JSON, initialize, tools/call)이
 * 진짜로 오간다. 모킹한 클라이언트로는 프레이밍 버그를 못 잡는다.
 */
function fakeServer(behavior: 'ok' | 'tool-error' | 'silent' | 'crash'): string {
  const file = join(dir, `server-${behavior}.mjs`);
  writeFileSync(
    file,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05' } }); return; }
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/call') {
    ${behavior === 'crash' ? 'process.exit(1);' : ''}
    ${behavior === 'silent' ? 'return;' : ''}
    const isError = ${behavior === 'tool-error'} && m.params.name === 'browser_click';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: isError ? 'Element not found: e1' : 'ok ' + m.params.name }], isError } });
    return;
  }
  if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'browser_navigate' }] } }); return; }
});
`,
    'utf8',
  );
  return file;
}

function executor(behavior: 'ok' | 'tool-error' | 'silent' | 'crash'): HandsExecutor {
  const server = fakeServer(behavior);
  return new HandsExecutor({
    ledger,
    // 표면은 가짜다 — 이 컨테이너에 Chrome 도 desktop 도 없다. 전송 계층을
    // 진짜로 돌리기 위해 표면 점검만 대체하고 MCP 왕복은 실제로 한다.
    inspect: () => ({ ok: true, launcher: server, approvalFile: null, problems: [], detail: [] }),
    createClient: () =>
      new McpClient({
        command: process.execPath,
        args: [server],
        requestTimeoutMs: behavior === 'silent' ? 400 : 10_000,
      }),
  });
}

function input(over: Partial<HandsRunInput> = {}): HandsRunInput {
  return { steps: PLAN, gateAllowed: true, runId: 'run-1', ...over };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-hands-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('planDigest', () => {
  it('같은 계획은 같은 digest', () => {
    expect(planDigest(PLAN)).toBe(planDigest([...PLAN]));
  });

  it('단계 하나만 바뀌어도 digest 가 바뀐다 — 승인이 다른 계획에 재사용되지 않는다', () => {
    const changed: HandsStep[] = [...PLAN.slice(0, 2), { op: 'type', element: '제목', ref: 'e1', text: '다른 글' }];
    expect(planDigest(changed)).not.toBe(planDigest(PLAN));
  });

  it('순서가 바뀌면 digest 가 바뀐다', () => {
    expect(planDigest([PLAN[1]!, PLAN[0]!, PLAN[2]!])).not.toBe(planDigest(PLAN));
  });
});

describe('toolArguments — 표면으로 넘어가는 것만', () => {
  it('navigate 는 url 만 넘긴다', () => {
    expect(toolArguments({ op: 'navigate', url: 'https://x.com' })).toEqual({ url: 'https://x.com' });
  });

  it('wait_for 의 ms 를 초로 바꾼다', () => {
    expect(toolArguments({ op: 'wait_for', timeMs: 2_000 })).toEqual({ time: 2 });
  });

  it('submit 이 없으면 필드를 만들지 않는다', () => {
    expect(toolArguments({ op: 'type', element: 'a', ref: 'e1', text: 'x' })).toEqual({
      element: 'a',
      ref: 'e1',
      text: 'x',
    });
  });
});

describe('HandsExecutor — 거부 경로', () => {
  it('오염된 계획은 게이트가 통과여도 실행하지 않는다 (R16.5)', async () => {
    const r = await executor('ok').run(input({ tainted: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tainted-plan');
    expect(ledger.query({ kind: 'deny' })).toHaveLength(1);
    expect(ledger.query({ kind: 'deny' })[0]?.tainted).toBe(true);
  });

  it('게이트 거부는 실행으로 이어지지 않는다', async () => {
    const r = await executor('ok').run(input({ gateAllowed: false, gateReason: 'approval-pending' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('gate-denied');
    expect(r.detail).toContain('approval-pending');
  });

  it('거부해도 사람이 이어받을 체크리스트를 준다 (R7.5)', async () => {
    const r = await executor('ok').run(input({ tainted: true }));
    expect(r.checklist).toHaveLength(PLAN.length);
    expect(r.checklist?.[0]).toContain('blog.naver.com');
  });
});

describe('HandsExecutor — 실행 경로', () => {
  it('모든 단계가 성공하면 ok', async () => {
    const r = await executor('ok').run(input());
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(3);
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });

  it('각 단계가 원장에 남는다', async () => {
    await executor('ok').run(input());
    const events = ledger.query({ kind: 'hands.step' });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.runId === 'run-1')).toBe(true);
    expect(events.every((e) => typeof e.payloadDigest === 'string')).toBe(true);
  });

  it('요소를 못 찾으면 멈추고 조용히 성공하지 않는다 (R7.5)', async () => {
    const r = await executor('tool-error').run(input());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('step-failed');
    // navigate 는 성공, click 에서 중단 → 3번째 단계는 실행되지 않는다.
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1]?.ok).toBe(false);
    expect(r.steps[1]?.reason).toContain('Element not found');
  });

  it('중단 시 체크리스트는 남은 단계부터 시작한다', async () => {
    const r = await executor('tool-error').run(input());
    expect(r.checklist).toHaveLength(2);
    expect(r.checklist?.[0]).toContain('클릭');
  });

  it('응답이 없으면 시간 초과로 실패한다 — 무응답이 성공이 되지 않는다', async () => {
    const r = await executor('silent').run(input());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('transport-failed');
  });

  it('서버가 죽으면 전송 실패로 보고한다', async () => {
    const r = await executor('crash').run(input());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('transport-failed');
    expect(ledger.query({ kind: 'deny' }).length).toBeGreaterThan(0);
  });
});

describe('planNeedsDesktop — 부분 적용 위험으로 판정한다', () => {
  it('읽기 전용 계획은 desktop 없이도 돈다', () => {
    expect(
      planNeedsDesktop([{ op: 'navigate', url: 'https://x.com' }, { op: 'snapshot' }, { op: 'screenshot' }]),
    ).toBe(false);
  });

  it('조작이 하나라도 섞이면 desktop 을 요구한다', () => {
    expect(planNeedsDesktop([{ op: 'snapshot' }, { op: 'click', element: 'a', ref: 'e1' }])).toBe(true);
  });

  it('조작 동사 넷을 모두 조작으로 센다', () => {
    expect((['click', 'type', 'press_key', 'select_option'] as const).every(isMutating)).toBe(true);
    expect((['navigate', 'snapshot', 'screenshot', 'wait_for'] as const).some(isMutating)).toBe(false);
  });

  it('조작 계획은 표면 부재 시 0단계 실행 전에 멈춘다 — 부분 적용이 없다', async () => {
    const server = fakeServer('ok');
    const exec = new HandsExecutor({
      ledger,
      inspect: (requireDesktop) => ({
        ok: !requireDesktop,
        launcher: server,
        approvalFile: null,
        problems: requireDesktop ? ['desktop-not-running'] : [],
        detail: [],
      }),
      createClient: () => new McpClient({ command: process.execPath, args: [server] }),
    });

    const mutating = await exec.run(input({ steps: PLAN }));
    expect(mutating.reason).toBe('surface-unavailable');
    expect(mutating.steps).toHaveLength(0);

    const readOnly = await exec.run(input({ steps: [{ op: 'navigate', url: 'https://x.com' }, { op: 'snapshot' }] }));
    expect(readOnly.ok).toBe(true);
  });
});

describe('checklistFrom', () => {
  it('입력 단계는 본문을 노출하지 않고 길이만 알린다', () => {
    const list = checklistFrom([{ op: 'type', element: '본문', ref: 'e1', text: '비밀글' }], 0);
    expect(list[0]).toContain('3자');
    expect(list[0]).not.toContain('비밀글');
  });
});
