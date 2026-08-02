/**
 * Hands 실행기 — 집행 순서 7단계의 마지막 칸 (R7)
 *
 * `capabilities/guard.ts` 가 1~5 를, 정책 게이트가 6 을 맡고, 여기가 7(실행과
 * 증거 기록)이다. 실행 표면은 agentlas-desktop 이 물질화한
 * `agentlas-browser-cdp.mjs` 이며, 그것은 `@playwright/mcp` 앞에 선 MCP
 * 프록시로서 결제·게시·삭제 같은 민감 행동을 desktop 승인 UI 로 다시 막는다.
 * 즉 조작 하나에 게이트가 둘이다 — 우리 것과 desktop 것.
 *
 * **오염된 계획은 거부한다.** R16.4 의 "한 단계 승격" 은 정책 게이트가 산출물
 * 등급에 적용하는 규칙이고, 여기서는 그보다 강하게 막는다. Hands 계획은
 * 구체적인 조작의 나열이므로, 그것이 신뢰등급 0 콘텐츠에서 나왔다면 이미
 * **공격자가 쓴 행동**이다. 오너가 승인 버튼을 눌러 안전해지는 종류가 아니다.
 *
 * 실패는 조용히 성공이 되지 않는다 (R7.5). 중단 지점까지의 결과와 사람이
 * 이어받을 체크리스트를 함께 돌려준다.
 */

import { createHash } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.js';
import { HANDS_TOOL, planNeedsDesktop, type HandsStep } from './types.js';
import { inspectSurface, type Surface } from './locate.js';
import { McpClient } from './mcp.js';

export interface HandsStepResult {
  index: number;
  op: HandsStep['op'];
  ok: boolean;
  /** 도구가 돌려준 보고. 증거 digest 의 원본이다. */
  text: string;
  reason?: string;
}

export type HandsFailure =
  | 'surface-unavailable'
  | 'tainted-plan'
  | 'gate-denied'
  | 'step-failed'
  | 'transport-failed';

export interface HandsRunResult {
  ok: boolean;
  reason?: HandsFailure;
  detail?: string;
  steps: HandsStepResult[];
  /** 실패했을 때 사람이 이어받을 목록 (R7.5). 성공이면 없다. */
  checklist?: string[];
  surface?: Surface;
}

export interface HandsRunInput {
  steps: HandsStep[];
  /** 신뢰등급 0 콘텐츠를 만진 계획인가 (R16.3). */
  tainted?: boolean;
  runId?: string;
  /** 계획이 승인 게이트를 통과했는가. 호출자(CLI)가 `resolveGate` 로 판정한다. */
  gateAllowed: boolean;
  gateReason?: string;
}

export interface HandsExecutorOptions {
  ledger: Ledger;
  /** 테스트가 가짜 서버를 끼울 수 있게 열어 둔다. */
  createClient?: (surface: Surface) => McpClient;
  /**
   * desktop 승인 서버를 항상 요구할지 강제한다.
   *
   * 기본값은 계획을 보고 정한다 — 조작이 하나라도 있으면 요구하고, 읽기
   * 전용이면 요구하지 않는다. 근거는 `types.ts` 의 `MUTATING_OPS` 주석.
   */
  requireDesktop?: boolean;
  /**
   * 표면 점검을 대체한다.
   *
   * 실제 실행에서는 절대 쓰지 않는다 — 표면 점검을 건너뛰면 desktop 이
   * 없는데도 도는 것처럼 보인다. 테스트가 가짜 MCP 서버를 물릴 때만 쓴다.
   */
  inspect?: (requireDesktop: boolean) => Surface;
}

/** 계획의 digest. 승인은 이 값에 묶인다 (R4.6). */
export function planDigest(steps: readonly HandsStep[]): string {
  return createHash('sha256')
    .update('agentlas:hands-plan:v1\0')
    .update(JSON.stringify(steps))
    .digest('hex');
}

/** 도구 인자로 변환한다. 여기 없는 필드는 표면으로 넘어가지 않는다. */
export function toolArguments(step: HandsStep): Record<string, unknown> {
  switch (step.op) {
    case 'navigate':
      return { url: step.url };
    case 'click':
      return { element: step.element, ref: step.ref };
    case 'type':
      return {
        element: step.element,
        ref: step.ref,
        text: step.text,
        ...(step.submit === undefined ? {} : { submit: step.submit }),
      };
    case 'press_key':
      return { key: step.key };
    case 'select_option':
      return { element: step.element, ref: step.ref, values: step.values };
    case 'wait_for':
      return {
        ...(step.text === undefined ? {} : { text: step.text }),
        ...(step.timeMs === undefined ? {} : { time: step.timeMs / 1000 }),
      };
    case 'snapshot':
    case 'screenshot':
      return {};
  }
}

/** 남은 단계를 사람이 이어받을 목록으로 바꾼다. */
export function checklistFrom(steps: readonly HandsStep[], failedAt: number): string[] {
  return steps.slice(failedAt).map((step, i) => {
    const n = failedAt + i + 1;
    switch (step.op) {
      case 'navigate':
        return `${n}. ${step.url} 로 이동`;
      case 'click':
        return `${n}. "${step.element}" 클릭`;
      case 'type':
        return `${n}. "${step.element}" 에 입력 (${step.text.length}자, 클립보드 준비됨)`;
      case 'press_key':
        return `${n}. ${step.key} 키 입력`;
      case 'select_option':
        return `${n}. "${step.element}" 에서 ${step.values.join(', ')} 선택`;
      case 'wait_for':
        return `${n}. ${step.text ?? `${step.timeMs}ms`} 대기`;
      default:
        return `${n}. ${step.op}`;
    }
  });
}

export class HandsExecutor {
  private readonly ledger: Ledger;
  private readonly createClient: (surface: Surface) => McpClient;
  private readonly inspect: (requireDesktop: boolean) => Surface;
  private readonly requireDesktop: boolean | undefined;

  constructor(opts: HandsExecutorOptions) {
    this.ledger = opts.ledger;
    this.requireDesktop = opts.requireDesktop;
    this.inspect = opts.inspect ?? ((requireDesktop): Surface => inspectSurface({ requireDesktop }));
    this.createClient =
      opts.createClient ??
      ((surface) =>
        new McpClient({
          command: process.execPath,
          args: [surface.launcher],
          env: {
            ...process.env,
            ...(surface.approvalFile
              ? { AGENTLAS_BROWSER_APPROVAL_FILE: surface.approvalFile }
              : {}),
          },
        }));
  }

  private deny(reason: HandsFailure, detail: string, input: HandsRunInput): HandsRunResult {
    this.ledger.append({
      actor: { kind: 'system', id: 'hands' },
      kind: 'deny',
      ...(input.tainted ? { tainted: true } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      payloadDigest: planDigest(input.steps),
      summary: `hands 거부 — ${reason}: ${detail}`,
    });
    return {
      ok: false,
      reason,
      detail,
      steps: [],
      checklist: checklistFrom(input.steps, 0),
    };
  }

  async run(input: HandsRunInput): Promise<HandsRunResult> {
    // 오염 검사가 가장 앞이다. 승인보다 앞에 두는 것은 guard.ts 와 같은 이유다.
    if (input.tainted === true) {
      return this.deny('tainted-plan', '신뢰등급 0 콘텐츠에서 나온 계획은 실행하지 않는다', input);
    }
    if (!input.gateAllowed) {
      return this.deny('gate-denied', input.gateReason ?? '정책 게이트가 거부했다', input);
    }

    // 조작이 섞인 계획만 desktop 을 요구한다. 읽기 전용 계획을 desktop 부재로
    // 막으면, 실패해도 세상을 바꾸지 않는 작업을 이유 없이 세우는 것이 된다.
    const surface = this.inspect(this.requireDesktop ?? planNeedsDesktop(input.steps));
    if (!surface.ok) {
      const result = this.deny('surface-unavailable', surface.problems.join(', '), input);
      return { ...result, surface };
    }

    const client = this.createClient(surface);
    const steps: HandsStepResult[] = [];
    try {
      client.start();
      await client.initialize();

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i]!;
        const result = await client.callTool(HANDS_TOOL[step.op], toolArguments(step));
        steps.push({ index: i, op: step.op, ok: result.ok, text: result.text });

        this.ledger.append({
          actor: { kind: 'system', id: 'hands' },
          kind: 'hands.step',
          ...(input.runId ? { runId: input.runId } : {}),
          payloadDigest: createHash('sha256').update(result.text).digest('hex'),
          summary: `${step.op} ${result.ok ? '성공' : '실패'}`,
          evidence: [`step:${i}`],
        });

        // 요소를 못 찾았거나 승인이 거부되면 여기서 멈춘다. 남은 단계를
        // 건너뛰고 성공으로 보고하는 경로는 없다 (R7.5).
        if (!result.ok) {
          steps[steps.length - 1]!.reason = result.text.slice(0, 300);
          return {
            ok: false,
            reason: 'step-failed',
            detail: `단계 ${i} (${step.op}) 에서 중단`,
            steps,
            checklist: checklistFrom(input.steps, i),
            surface,
          };
        }
      }
      return { ok: true, steps, surface };
    } catch (err) {
      const detail = (err as Error).message;
      this.ledger.append({
        actor: { kind: 'system', id: 'hands' },
        kind: 'deny',
        ...(input.runId ? { runId: input.runId } : {}),
        summary: `hands 전송 실패 — ${detail}`,
      });
      return {
        ok: false,
        reason: 'transport-failed',
        detail,
        steps,
        checklist: checklistFrom(input.steps, steps.length),
        surface,
      };
    } finally {
      client.close();
    }
  }
}
