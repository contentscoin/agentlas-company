/**
 * 레시피 실행기 (R12)
 *
 * 설계 판단 넷.
 *
 * 1. 승인 스텝은 블로킹이 아니다. 실행이 `paused` 로 끝나고 승인이 떨어진 뒤
 *    `resume` 이 이어받는다. 12시간짜리 승인 대기로 프로세스를 붙잡으면
 *    좌석이 잠기고 재부팅에도 못 견딘다.
 *
 * 2. 게이트 실패는 다음 스텝을 막는다 (R12.2). 게이트는 막는 것이 일이다.
 *    `continueOnFail` 을 명시한 스텝만 예외다.
 *
 * 3. 재개는 상태 파일에서 한다 (R12.5). 통과한 스텝은 다시 돌지 않는다.
 *    좌석 호출 1회가 19.4k 토큰이라 재실행이 공짜가 아니다.
 *
 * 4. 오염은 실행 단위로 전파된다. 한 스텝이 오염된 자료를 만졌으면
 *    그 실행의 이후 산출물도 오염으로 본다 — 요약을 거쳤다고 세탁되지 않는다.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestPayload, type Ledger } from '../ledger/ledger.js';
import { runShell } from '../proc/index.js';
import type { SeatBroker } from '../seats/broker.js';
import type { SeatId } from '../ledger/types.js';
import type { ApprovalService } from '../policy/approval.js';
import { classify } from '../policy/policy.js';
import type { PolicyConfig } from '../policy/types.js';
import { RunLock } from './lock.js';
import type { Recipe, RunOutcome, RunState, Step, StepState } from './types.js';
import type { PublishBroker } from '../publish/broker.js';
import { isChannel } from '../verbs/types.js';

export interface EngineOptions {
  ledger: Ledger;
  broker: SeatBroker;
  approvals: ApprovalService;
  policy: PolicyConfig;
  /** 실행 상태와 락이 저장되는 디렉터리. */
  stateDir: string;
  /** 게이트 명령 타임아웃. */
  gateTimeoutMs?: number;
  /**
   * 발행기. 없으면 `publish` 스텝이 실패한다.
   *
   * 선택으로 둔 이유는 레시피 대부분이 발행 없이 돌고, 그때 발행 어댑터
   * 설정을 강요할 이유가 없기 때문이다. 다만 **없는 것을 통과로 처리하지는
   * 않는다** — 발행 스텝이 있는데 발행기가 없으면 그 자리에서 멈춘다.
   */
  publisher?: PublishBroker;
}

export class RecipeEngine {
  private readonly ledger: Ledger;
  private readonly broker: SeatBroker;
  private readonly approvals: ApprovalService;
  private readonly publisher: PublishBroker | undefined;
  private readonly policy: PolicyConfig;
  private readonly stateDir: string;
  private readonly gateTimeoutMs: number;

  constructor(opts: EngineOptions) {
    this.ledger = opts.ledger;
    this.broker = opts.broker;
    this.approvals = opts.approvals;
    this.policy = opts.policy;
    this.stateDir = opts.stateDir;
    this.gateTimeoutMs = opts.gateTimeoutMs ?? 120_000;
    this.publisher = opts.publisher;
    mkdirSync(join(this.stateDir, 'runs'), { recursive: true });
  }

  private runFile(runId: string): string {
    return join(this.stateDir, 'runs', `${runId}.json`);
  }

  private lockFor(recipe: string): RunLock {
    return new RunLock(join(this.stateDir, 'runs', `${sanitize(recipe)}.lock`));
  }

  loadRun(runId: string): RunState | null {
    const file = this.runFile(runId);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as RunState;
    } catch {
      return null;
    }
  }

  private saveRun(state: RunState): void {
    writeFileSync(this.runFile(state.runId), JSON.stringify(state, null, 2), 'utf8');
  }

  /** 새 실행을 시작한다. 같은 레시피가 돌고 있으면 거부한다 (R12.4). */
  async start(recipe: Recipe): Promise<RunOutcome> {
    const runId = randomUUID();
    const lock = this.lockFor(recipe.name);
    const acquired = lock.acquire(recipe.name, runId);

    if (!acquired.ok) {
      this.ledger.append({
        actor: { kind: 'system', id: 'recipe-engine' },
        kind: 'deny',
        summary: `${recipe.name} 중복 실행 거부 — ${acquired.heldBy.runId} 가 실행 중 (pid ${acquired.heldBy.pid})`,
      });
      return { runId, status: 'failed', reason: `이미 실행 중: ${acquired.heldBy.runId}` };
    }

    if (acquired.reclaimedFrom) {
      this.ledger.append({
        actor: { kind: 'system', id: 'recipe-engine' },
        kind: 'deny',
        summary: `${recipe.name} 죽은 락 회수 — 이전 실행 ${acquired.reclaimedFrom.runId} (pid ${acquired.reclaimedFrom.pid})`,
      });
    }

    const state: RunState = {
      runId,
      recipe: recipe.name,
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: recipe.steps.map<StepState>((s) => ({ id: s.id, kind: s.kind, status: 'pending' })),
      artifacts: {},
      tainted: false,
    };
    this.saveRun(state);

    this.ledger.append({
      actor: { kind: 'system', id: 'recipe-engine' },
      kind: 'decision',
      runId,
      summary: `${recipe.name} 실행 시작 — 스텝 ${recipe.steps.length}개`,
    });

    try {
      return await this.execute(recipe, state);
    } finally {
      lock.release();
    }
  }

  /**
   * 멈춘 실행을 이어받는다 (R12.5).
   * 통과한 스텝은 다시 돌지 않는다.
   */
  async resume(recipe: Recipe, runId: string): Promise<RunOutcome> {
    const state = this.loadRun(runId);
    if (!state) return { runId, status: 'failed', reason: '실행 상태를 찾을 수 없다' };
    if (state.status === 'completed') return { runId, status: 'completed' };

    const lock = this.lockFor(recipe.name);
    const acquired = lock.acquire(recipe.name, runId);
    if (!acquired.ok) {
      return { runId, status: 'failed', reason: `이미 실행 중: ${acquired.heldBy.runId}` };
    }

    state.status = 'running';
    this.saveRun(state);
    this.ledger.append({
      actor: { kind: 'system', id: 'recipe-engine' },
      kind: 'decision',
      runId,
      summary: `${recipe.name} 재개`,
    });

    try {
      return await this.execute(recipe, state);
    } finally {
      lock.release();
    }
  }

  private async execute(recipe: Recipe, state: RunState): Promise<RunOutcome> {
    for (const step of recipe.steps) {
      const st = state.steps.find((s) => s.id === step.id);
      if (!st) continue;
      if (st.status === 'passed' || st.status === 'skipped') continue;

      st.status = 'running';
      st.startedAt = new Date().toISOString();
      this.saveRun(state);

      const result = await this.runStep(step, state, st);

      st.endedAt = new Date().toISOString();
      this.saveRun(state);

      if (result === 'pause') {
        state.status = 'paused';
        state.detail = `${step.id} 승인 대기`;
        this.saveRun(state);
        this.ledger.append({
          actor: { kind: 'system', id: 'recipe-engine' },
          kind: 'decision',
          runId: state.runId,
          summary: `${recipe.name} 일시정지 — ${step.id} 승인 대기`,
        });
        return { runId: state.runId, status: 'paused', stoppedAt: step.id, reason: '승인 대기' };
      }

      if (result === 'stop') {
        state.status = 'failed';
        state.detail = `${step.id} 실패: ${st.detail ?? ''}`;
        state.endedAt = new Date().toISOString();
        this.saveRun(state);
        this.ledger.append({
          actor: { kind: 'system', id: 'recipe-engine' },
          kind: 'gate.verdict',
          runId: state.runId,
          summary: `${recipe.name} 중단 — ${step.id}: ${st.detail ?? '실패'}`,
        });
        return {
          runId: state.runId,
          status: 'failed',
          stoppedAt: step.id,
          ...(st.detail !== undefined ? { reason: st.detail } : {}),
        };
      }
    }

    state.status = 'completed';
    state.endedAt = new Date().toISOString();
    this.saveRun(state);
    this.ledger.append({
      actor: { kind: 'system', id: 'recipe-engine' },
      kind: 'decision',
      runId: state.runId,
      summary: `${recipe.name} 완료`,
    });
    return { runId: state.runId, status: 'completed' };
  }

  private async runStep(step: Step, state: RunState, st: StepState): Promise<'continue' | 'stop' | 'pause'> {
    switch (step.kind) {
      case 'seat': {
        const r = await this.broker.ask({
          persona: step.persona,
          prompt: buildSeatPrompt(step.instruction, state.artifacts),
          runId: state.runId,
          tainted: state.tainted,
          ...(step.seat ? { preferSeat: step.seat as SeatId } : {}),
          ...(step.forbidVendor ? { forbidVendor: step.forbidVendor as never } : {}),
        });
        if (!r.ok || r.text === undefined) {
          st.status = 'failed';
          st.detail = r.reason ?? '좌석 응답 없음';
          return 'stop';
        }
        state.artifacts[step.produce] = r.text;
        if (r.tainted) state.tainted = true;
        st.status = 'passed';
        st.artifactDigest = digestPayload(r.text);
        return 'continue';
      }

      case 'gate': {
        // 레시피의 게이트 명령은 운영자가 작성한 셸 명령줄이다.
        // 에이전트 산출물이 이 경로로 들어오면 임의 명령 실행이 되므로
        // 레시피 파일은 정책 파일과 같은 신뢰 등급으로 취급한다.
        const r = await runShell(step.command, { timeoutMs: this.gateTimeoutMs });
        const passed = r.code === 0;
        st.status = passed ? 'passed' : 'failed';
        if (passed) delete st.detail;
        else st.detail = `exit ${String(r.code)}${r.timedOut ? ' (타임아웃)' : ''}`;

        this.ledger.append({
          actor: { kind: 'system', id: 'recipe-engine' },
          kind: 'gate.verdict',
          runId: state.runId,
          summary: `게이트 ${step.id} ${passed ? 'PASS' : 'FAIL'} — ${step.command}`,
        });

        if (passed) return 'continue';
        if (step.continueOnFail === true) {
          st.status = 'skipped';
          return 'continue';
        }
        return 'stop';
      }

      case 'approval': {
        const subject = state.artifacts[step.subject];
        if (subject === undefined) {
          st.status = 'failed';
          st.detail = `승인 대상 산출물이 없다: ${step.subject}`;
          return 'stop';
        }
        const digest = digestPayload(subject);
        const c = classify(this.policy, { action: step.action, tainted: state.tainted });
        st.level = c.level;

        // 승인이 필요 없으면 그냥 통과한다 (R4.2)
        if (!c.needsApproval) {
          st.status = 'passed';
          st.detail = `${c.level} 자동 진행`;
          return 'continue';
        }

        // 이미 카드를 만들었다면 결과를 확인한다 (재개 경로)
        if (st.approvalId !== undefined) {
          const outcome = this.approvals.consume(st.approvalId, digest);
          if (outcome.allowed) {
            st.status = 'passed';
            st.detail = '승인 확인';
            return 'continue';
          }
          if (outcome.reason === 'cooling') {
            st.status = 'awaiting-approval';
            st.detail = `유예 창 대기 — ${outcome.detail ?? ''}`;
            return 'pause';
          }
          if (outcome.reason === 'not-approved') {
            st.status = 'awaiting-approval';
            st.detail = '오너 결정 대기';
            return 'pause';
          }
          st.status = 'failed';
          st.detail = `승인 불가: ${outcome.reason}`;
          return 'stop';
        }

        const card = this.approvals.create({
          classification: c,
          payloadDigest: digest,
          summary: step.title ?? `${step.action} 승인 요청`,
          runId: state.runId,
        });
        st.approvalId = card.id;
        st.artifactDigest = digest;
        st.status = 'awaiting-approval';
        st.detail = `승인 카드 ${card.id}`;
        return 'pause';
      }

      case 'publish': {
        if (!this.publisher) {
          // 발행기를 물리지 않은 엔진으로 발행 스텝을 돌리려 했다.
          // 통과로 처리하지 않는다 — 조용한 성공을 만들지 않는다.
          st.status = 'failed';
          st.detail = '발행기가 연결되지 않은 엔진이다 (PublishBroker 미주입)';
          return 'stop';
        }

        // 본문은 이전 스텝 산출물에서 온다. 레시피에 본문을 직접 적는
        // 경로를 만들지 않는다 — 그러면 레시피가 자유 텍스트 발행 통로가 된다.
        const body = state.artifacts[step.subject];
        if (body === undefined) {
          st.status = 'failed';
          st.detail = `산출물 "${step.subject}" 이 없다 — 앞 스텝이 만들지 않았다`;
          return 'stop';
        }

        if (!isChannel(step.channel)) {
          st.status = 'failed';
          st.detail = `알 수 없는 채널: ${step.channel}`;
          return 'stop';
        }

        const result = await this.publisher.publish({
          channel: step.channel,
          verb: { op: 'post_text', channel: step.channel, body },
          // 같은 레시피 실행의 같은 스텝은 한 번만 나간다 (R6.3). 재개해도
          // 다시 나가지 않는 것이 R12.5 와 맞물리는 지점이다.
          idempotencyKey: `${state.runId}:${step.id}`,
          runId: state.runId,
          ...(step.dryRun ? { dryRun: true } : {}),
          ...(step.brandOk ? { brandPass: true } : {}),
        });

        if (!result.ok) {
          st.status = 'failed';
          st.detail = `발행 실패 — ${result.reason}${result.detail ? `: ${result.detail}` : ''}`;
          // 체크리스트는 사람이 이어받는 자리다. 삼키지 않는다 (R6.6).
          if (result.checklist?.length) st.detail += `\n  ${result.checklist.join('\n  ')}`;
          return 'stop';
        }

        st.status = 'passed';
        st.detail = result.reason === 'duplicate'
          ? '이미 발행됨 — 다시 내보내지 않았다'
          : result.payload !== undefined
            ? '드라이런 — 실제로 나가지 않았다'
            : `발행 완료${result.evidence?.url ? ` — ${result.evidence.url}` : ''}`;
        if (result.evidence?.url) state.artifacts[`${step.id}.url`] = result.evidence.url;
        return 'continue';
      }

      case 'retro': {
        // R11(검증과 복기)이 아직 없다. 구현되지 않은 것을 통과로 처리하지
        // 않는다 — 레시피가 초록으로 끝나는데 복기가 없는 상태를 만들지 않는다.
        st.status = 'failed';
        st.detail = 'retro 스텝은 아직 구현되지 않았다 (R11 검증·복기 미구현)';
        return 'stop';
      }
    }
  }
}

/** 이전 스텝 산출물을 지시문에 끼워넣는다. `{{이름}}` 을 치환한다. */
export function buildSeatPrompt(instruction: string, artifacts: Record<string, string>): string {
  return instruction.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => artifacts[name] ?? `[산출물 없음: ${name}]`);
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]/g, '_');
}
