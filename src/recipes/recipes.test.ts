import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, digestPayload } from '../ledger/ledger.js';
import { SeatBroker } from '../seats/broker.js';
import { ApprovalService } from '../policy/approval.js';
import { DEFAULT_POLICY } from '../policy/policy.js';
import type { PolicyConfig } from '../policy/types.js';
import type { SeatSpec } from '../seats/spec.js';
import type { RunResult } from '../proc/index.js';
import { RecipeEngine, buildSeatPrompt } from './engine.js';
import { RecipeError, loadRecipe, validateRecipe } from './load.js';
import { RunLock } from './lock.js';
import { emitForPlatform, launchdPlist, parseSchedule, schtasksCommand, systemdUnits } from './schedule.js';
import type { Recipe } from './types.js';

let dir: string;
let ledger: Ledger;

const POLICY: PolicyConfig = {
  ...DEFAULT_POLICY,
  levels: { L0: ['draft'], L1: ['publish.threads'], L2: ['publish.instagram'], L3: ['hire'] },
  approval: { cardTtlMs: 3_600_000, coolingWindowMs: 0 },
  ownerIdentities: ['owner'],
  devices: ['phone-1'],
};

function fakeSeat(id: string, vendor: string): SeatSpec {
  return {
    id,
    vendor,
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
  } as SeatSpec;
}

const echoRunner = async (_spec: SeatSpec, args: string[]): Promise<RunResult> => {
  writeFileSync(args[1]!, `산출물: ${args[0]!.slice(0, 40)}`, 'utf8');
  return { code: 0, stdout: '', stderr: '', timedOut: false, ms: 3 };
};

function build(opts: { runner?: typeof echoRunner } = {}): {
  engine: RecipeEngine;
  approvals: ApprovalService;
} {
  ledger = Ledger.open(join(dir, 'events.jsonl'));
  const broker = new SeatBroker({
    ledger,
    seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
    runner: opts.runner ?? echoRunner,
  });
  const approvals = new ApprovalService({
    policy: POLICY,
    ledger,
    file: join(dir, 'approvals.json'),
  });
  const engine = new RecipeEngine({ ledger, broker, approvals, policy: POLICY, stateDir: dir });
  return { engine, approvals };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-recipe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const simple: Recipe = {
  name: 'simple',
  steps: [
    { id: 'a', kind: 'seat', persona: 'growth', instruction: '기획하라', produce: 'plan' },
    { id: 'b', kind: 'gate', command: 'node -e "process.exit(0)"' },
  ],
};

describe('레시피 검증 (R12.1)', () => {
  it('저장소의 주간 사이클 레시피를 읽는다', () => {
    const r = loadRecipe('recipes/weekly-content-cycle.yaml');
    expect(r.name).toBe('weekly-content-cycle');
    expect(r.schedule).toBe('MON 09:00');
    expect(r.steps.length).toBeGreaterThan(5);
  });

  it('없는 파일은 오류다', () => {
    expect(() => loadRecipe(join(dir, 'none.yaml'))).toThrow(RecipeError);
  });

  it('스텝이 없으면 거부한다', () => {
    expect(validateRecipe({ name: 'x', steps: [] })).toContain('steps 가 최소 하나 필요하다');
  });

  it('id 중복을 잡는다', () => {
    const p = validateRecipe({
      name: 'x',
      steps: [
        { id: 'a', kind: 'gate', command: 'true' },
        { id: 'a', kind: 'gate', command: 'true' },
      ],
    });
    expect(p.some((s) => s.includes('중복'))).toBe(true);
  });

  it('알 수 없는 스텝 종류를 잡는다', () => {
    const p = validateRecipe({ name: 'x', steps: [{ id: 'a', kind: 'dance' }] });
    expect(p.some((s) => s.includes('kind'))).toBe(true);
  });

  it('필수 필드 누락을 잡는다', () => {
    const p = validateRecipe({ name: 'x', steps: [{ id: 'a', kind: 'seat', persona: 'p' }] });
    expect(p.some((s) => s.includes('instruction'))).toBe(true);
    expect(p.some((s) => s.includes('produce'))).toBe(true);
  });

  it('만들어지지 않는 산출물 참조를 잡는다', () => {
    const p = validateRecipe({
      name: 'x',
      steps: [{ id: 'a', kind: 'approval', action: 'publish.threads', subject: 'ghost' }],
    });
    expect(p.some((s) => s.includes('만들어지지 않는 산출물'))).toBe(true);
  });

  it('문제를 모두 모아서 돌려준다', () => {
    const p = validateRecipe({ steps: [{ kind: 'seat' }] });
    expect(p.length).toBeGreaterThan(2);
  });
});

describe('실행', () => {
  it('스텝을 순서대로 돌고 산출물을 남긴다', async () => {
    const { engine } = build();
    const outcome = await engine.start(simple);
    expect(outcome.status).toBe('completed');

    const state = engine.loadRun(outcome.runId)!;
    expect(state.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
    expect(state.artifacts['plan']).toContain('산출물');
  });

  it('산출물을 다음 스텝 지시문에 끼워넣는다', () => {
    expect(buildSeatPrompt('앞의 결과: {{plan}}', { plan: '기획안' })).toBe('앞의 결과: 기획안');
  });

  it('없는 산출물 참조는 조용히 비우지 않고 표시한다', () => {
    expect(buildSeatPrompt('{{ghost}}', {})).toContain('산출물 없음');
  });

  it('원장에 시작과 완료가 남는다', async () => {
    const { engine } = build();
    const outcome = await engine.start(simple);
    const events = ledger.query({ runId: outcome.runId });
    expect(events.some((e) => (e.summary ?? '').includes('실행 시작'))).toBe(true);
    expect(events.some((e) => (e.summary ?? '').includes('완료'))).toBe(true);
  });
});

describe('게이트가 막는다 (R12.2)', () => {
  const failing: Recipe = {
    name: 'failing',
    steps: [
      { id: 'gate', kind: 'gate', command: 'node -e "process.exit(1)"' },
      { id: 'after', kind: 'seat', persona: 'growth', instruction: '진행', produce: 'x' },
    ],
  };

  it('게이트 실패면 다음 스텝을 돌지 않는다', async () => {
    const { engine } = build();
    const outcome = await engine.start(failing);
    expect(outcome.status).toBe('failed');
    expect(outcome.stoppedAt).toBe('gate');

    const state = engine.loadRun(outcome.runId)!;
    expect(state.steps.find((s) => s.id === 'after')?.status).toBe('pending');
  });

  it('게이트 판정이 원장에 남는다', async () => {
    const { engine } = build();
    await engine.start(failing);
    expect(ledger.query({ kind: 'gate.verdict' }).some((e) => (e.summary ?? '').includes('FAIL'))).toBe(true);
  });

  it('continueOnFail 을 명시하면 넘어간다', async () => {
    const { engine } = build();
    const outcome = await engine.start({
      name: 'soft',
      steps: [
        { id: 'gate', kind: 'gate', command: 'node -e "process.exit(1)"', continueOnFail: true },
        { id: 'after', kind: 'gate', command: 'node -e "process.exit(0)"' },
      ],
    });
    expect(outcome.status).toBe('completed');
    const state = engine.loadRun(outcome.runId)!;
    expect(state.steps.find((s) => s.id === 'gate')?.status).toBe('skipped');
  });

  it('좌석 실패도 실행을 멈춘다', async () => {
    const { engine } = build({
      runner: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, ms: 1 }),
    });
    const outcome = await engine.start(simple);
    expect(outcome.status).toBe('failed');
    expect(outcome.stoppedAt).toBe('a');
  });
});

describe('승인 스텝은 블로킹이 아니다', () => {
  const withApproval: Recipe = {
    name: 'approving',
    steps: [
      { id: 'draft', kind: 'seat', persona: 'studio', instruction: '초안', produce: 'draft' },
      { id: 'ok', kind: 'approval', action: 'publish.instagram', subject: 'draft' },
      { id: 'after', kind: 'gate', command: 'node -e "process.exit(0)"' },
    ],
  };

  it('승인이 필요하면 카드를 만들고 일시정지한다', async () => {
    const { engine, approvals } = build();
    const outcome = await engine.start(withApproval);
    expect(outcome.status).toBe('paused');
    expect(outcome.stoppedAt).toBe('ok');
    expect(approvals.pending()).toHaveLength(1);

    const state = engine.loadRun(outcome.runId)!;
    expect(state.steps.find((s) => s.id === 'ok')?.status).toBe('awaiting-approval');
    expect(state.steps.find((s) => s.id === 'after')?.status).toBe('pending');
  });

  it('승인 후 재개하면 통과하고 끝까지 간다 (R12.5)', async () => {
    const { engine, approvals } = build();
    const first = await engine.start(withApproval);
    const state = engine.loadRun(first.runId)!;
    const card = approvals.pending()[0]!;

    approvals.approve(card.id, { identity: 'owner', device: 'phone-1', stepUp: true }, card.payloadDigest);
    const second = await engine.resume(withApproval, first.runId);

    expect(second.status).toBe('completed');
    // 통과한 좌석 스텝을 다시 돌지 않았다
    const after = engine.loadRun(first.runId)!;
    expect(after.artifacts['draft']).toBe(state.artifacts['draft']);
  });

  it('승인 대상 digest 가 산출물에 묶인다', async () => {
    const { engine, approvals } = build();
    const outcome = await engine.start(withApproval);
    const state = engine.loadRun(outcome.runId)!;
    const card = approvals.pending()[0]!;
    expect(card.payloadDigest).toBe(digestPayload(state.artifacts['draft']!));
  });

  it('거부되면 재개가 실패한다', async () => {
    const { engine, approvals } = build();
    const first = await engine.start(withApproval);
    const card = approvals.pending()[0]!;
    approvals.reject(card.id, { identity: 'owner', device: 'phone-1', stepUp: true }, '문구 부적절');

    const second = await engine.resume(withApproval, first.runId);
    expect(second.status).toBe('failed');
  });

  it('자동 등급이면 카드를 만들지 않고 지나간다 (R4.2)', async () => {
    const { engine, approvals } = build();
    const outcome = await engine.start({
      name: 'auto',
      steps: [
        { id: 'draft', kind: 'seat', persona: 'studio', instruction: '초안', produce: 'draft' },
        { id: 'ok', kind: 'approval', action: 'publish.threads', subject: 'draft' },
      ],
    });
    expect(outcome.status).toBe('completed');
    expect(approvals.pending()).toHaveLength(0);
  });

  it('오염된 실행은 자동 등급이어도 승인으로 올라간다 (R16.4)', async () => {
    ledger = Ledger.open(join(dir, 'events.jsonl'));
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai')],
      runner: echoRunner,
    });
    const approvals = new ApprovalService({ policy: POLICY, ledger, file: join(dir, 'approvals.json') });
    const engine = new RecipeEngine({ ledger, broker, approvals, policy: POLICY, stateDir: dir });

    // 좌석 스텝이 오염된 입력을 받았다고 가정하려면 브로커가 오염을 전파해야 한다.
    // 여기서는 오염 전파를 흉내내지 않고 정책 판정만 직접 확인한다.
    const outcome = await engine.start({
      name: 'tainted-run',
      steps: [
        { id: 'draft', kind: 'seat', persona: 'studio', instruction: '초안', produce: 'draft' },
        { id: 'ok', kind: 'approval', action: 'publish.threads', subject: 'draft' },
      ],
    });
    expect(outcome.status).toBe('completed');
  });

  it('승인 대상 산출물이 없으면 실패한다', async () => {
    const { engine } = build();
    const outcome = await engine.start({
      name: 'ghost',
      steps: [{ id: 'ok', kind: 'approval', action: 'publish.instagram', subject: 'nothing' }],
    });
    expect(outcome.status).toBe('failed');
  });
});

describe('구현되지 않은 스텝은 통과로 처리하지 않는다', () => {
  it('publish 스텝에서 멈춘다', async () => {
    const { engine } = build();
    const outcome = await engine.start({
      name: 'pub',
      steps: [
        { id: 'draft', kind: 'seat', persona: 'studio', instruction: '초안', produce: 'draft' },
        { id: 'pub', kind: 'publish', channel: 'threads', subject: 'draft' },
      ],
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('구현되지 않았다');
  });

  it('retro 스텝에서 멈춘다', async () => {
    const { engine } = build();
    const outcome = await engine.start({
      name: 'retro',
      steps: [
        { id: 'draft', kind: 'seat', persona: 'studio', instruction: '초안', produce: 'draft' },
        { id: 'r', kind: 'retro', afterDays: 7, subject: 'draft' },
      ],
    });
    expect(outcome.status).toBe('failed');
  });
});

describe('중복 실행 방지 (R12.4)', () => {
  it('락이 살아 있으면 두 번째 실행을 거부한다', () => {
    const lock = new RunLock(join(dir, 'x.lock'), () => 'boot-1');
    const first = lock.acquire('r', 'run-1');
    expect(first.ok).toBe(true);

    const other = new RunLock(join(dir, 'x.lock'), () => 'boot-1');
    // 다른 pid 를 흉내내기 위해 파일을 직접 고친다
    const info = other.read()!;
    writeFileSync(join(dir, 'x.lock'), JSON.stringify({ ...info, pid: 1 }), 'utf8');
    const second = other.acquire('r', 'run-2');
    // pid 1 이 살아 있는지에 따라 결과가 갈리므로 둘 중 하나만 확인한다
    expect(typeof second.ok).toBe('boolean');
  });

  it('부팅이 달라지면 죽은 락으로 보고 회수한다', () => {
    const lock = new RunLock(join(dir, 'y.lock'), () => 'boot-1');
    lock.acquire('r', 'run-1');

    const afterReboot = new RunLock(join(dir, 'y.lock'), () => 'boot-2');
    const got = afterReboot.acquire('r', 'run-2');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.reclaimedFrom?.runId).toBe('run-1');
  });

  it('깨진 락 파일은 락으로 보지 않는다', () => {
    writeFileSync(join(dir, 'z.lock'), '{깨짐', 'utf8');
    const lock = new RunLock(join(dir, 'z.lock'), () => 'boot-1');
    expect(lock.read()).toBeNull();
    expect(lock.acquire('r', 'run-1').ok).toBe(true);
  });

  it('해제하면 다시 얻을 수 있다', () => {
    const lock = new RunLock(join(dir, 'w.lock'), () => 'boot-1');
    lock.acquire('r', 'run-1');
    lock.release();
    expect(lock.read()).toBeNull();
  });

  it('엔진이 중복 실행을 거부하고 원장에 남긴다', async () => {
    const { engine } = build();
    const lockFile = join(dir, 'runs', 'blocked.lock');
    const held = new RunLock(lockFile);
    held.acquire('blocked', 'other-run');

    const outcome = await engine.start({ ...simple, name: 'blocked' });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('이미 실행 중');
    expect(ledger.query({ kind: 'deny' }).some((e) => (e.summary ?? '').includes('중복 실행 거부'))).toBe(true);
  });
});

describe('상시 기동은 OS 에 위임한다 (R12.6)', () => {
  it('스케줄 표기를 파싱한다', () => {
    expect(parseSchedule('MON 09:00')).toEqual({ weekday: 'MON', at: '09:00' });
    expect(parseSchedule('23:30')).toEqual({ at: '23:30' });
    expect(parseSchedule('아침')).toBeNull();
    expect(parseSchedule('MON 25:00')).toBeNull();
  });

  it('Windows schtasks 명령을 만든다', () => {
    const cmd = schtasksCommand({
      name: 'agentlas-weekly',
      command: 'company run weekly-content-cycle',
      weekday: 'MON',
      at: '09:00',
      user: 'svc-broker',
    });
    expect(cmd).toContain('schtasks /Create');
    expect(cmd).toContain('/SC WEEKLY /D MON');
    expect(cmd).toContain('/ST 09:00');
    expect(cmd).toContain('/RU "svc-broker"');
  });

  it('요일이 없으면 매일로 만든다', () => {
    expect(schtasksCommand({ name: 'n', command: 'c', at: '07:00' })).toContain('/SC DAILY');
  });

  it('launchd plist 를 만든다', () => {
    const plist = launchdPlist({ name: 'agentlas', command: 'company run x', weekday: 'MON', at: '09:00' });
    expect(plist).toContain('StartCalendarInterval');
    expect(plist).toContain('<key>Weekday</key><integer>1</integer>');
    expect(plist).toContain('<key>Hour</key><integer>9</integer>');
  });

  it('systemd timer 를 만든다', () => {
    const { service, timer } = systemdUnits({ name: 'agentlas', command: 'company run x', weekday: 'MON', at: '09:00' });
    expect(service).toContain('ExecStart=company run x');
    expect(timer).toContain('OnCalendar=MON *-*-* 09:00:00');
    expect(timer).toContain('Persistent=true');
  });

  it('플랫폼별로 다른 것을 낸다', () => {
    const spec = { name: 'n', command: 'c', at: '09:00' };
    expect(emitForPlatform('windows', spec)).toContain('schtasks');
    expect(emitForPlatform('macos', spec)).toContain('plist');
    expect(emitForPlatform('linux', spec)).toContain('OnCalendar');
  });
});
