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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger } from '../ledger/ledger.js';
import { HANDS_TOOL, findPattern, isFindRef, planNeedsDesktop, type HandsStep } from './types.js';
import { inspectSurface, type Surface } from './locate.js';
import { McpClient } from './mcp.js';

export interface HandsStepResult {
  index: number;
  op: HandsStep['op'];
  ok: boolean;
  /** 도구가 돌려준 보고. 증거 digest 의 원본이다. */
  text: string;
  /** 저장된 스크린샷 경로 (R7.2). */
  screenshots?: string[];
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
  /** 이번 실행이 남긴 스크린샷 전부 (R7.2). */
  screenshots?: string[];
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
  /**
   * 스크린샷을 저장할 디렉터리 (R7.2).
   *
   * 주어지면 도구가 돌려준 이미지를 여기에 쓰고 경로를 원장 증거로 남긴다.
   * 없으면 이미지를 버린다 — 읽기 전용 탐색까지 디스크를 채울 이유는 없다.
   * 디렉터리는 호출자가 미리 만든다.
   */
  evidenceDir?: string;
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

/**
 * 직전 스냅샷에서 요소 ref 를 찾는다.
 *
 * 접근성 트리의 한 줄이 `- textbox "본문" [ref=f1e3]` 형태라, 패턴에 맞는
 * 줄의 `[ref=...]` 를 읽는다. 첫 일치를 쓴다 — 여럿이면 계획이 모호한
 * 것이고, 모호한 채로 아무거나 누르는 것보다 계획을 좁히는 편이 맞다.
 */
export function resolveRef(snapshot: string, pattern: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return null;
  }
  for (const line of snapshot.split('\n')) {
    if (!re.test(line)) continue;
    const m = /\[ref=([^\]]+)\]/.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * 도구 인자로 변환한다. 여기 없는 필드는 표면으로 넘어가지 않는다.
 *
 * **요소 지정 필드는 `target` 이다.** 처음에 `ref` 로 보냈고 타입 검사도
 * 테스트도 통과했지만 실제 도구는 전부 거부했다 — 가짜 MCP 서버가 무엇이든
 * 받아 주어서 프레이밍만 검증되고 도구 계약은 검증되지 않았기 때문이다.
 * Task 9 에서 진짜 브라우저에 붙이고 나서야 잡혔다. 그 뒤로 가짜 서버도
 * 필수 필드를 검사한다.
 */
export function toolArguments(step: HandsStep): Record<string, unknown> {
  switch (step.op) {
    case 'navigate':
      return { url: step.url };
    case 'click':
      return { element: step.element, target: step.ref };
    case 'type':
      return {
        element: step.element,
        target: step.ref,
        text: step.text,
        ...(step.submit === undefined ? {} : { submit: step.submit }),
      };
    case 'press_key':
      return { key: step.key };
    case 'select_option':
      return { element: step.element, target: step.ref, values: step.values };
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
    const shots: string[] = [];
    try {
      client.start();
      await client.initialize();

      let lastSnapshot = '';
      for (let i = 0; i < input.steps.length; i++) {
        let step = input.steps[i]!;

        // `@find:` 를 직전 스냅샷으로 채운다. 못 찾으면 여기서 멈춘다 —
        // 요소를 못 찾은 것을 성공으로 넘기지 않는다 (R7.5).
        if ('ref' in step && typeof step.ref === 'string' && isFindRef(step.ref)) {
          const found = resolveRef(lastSnapshot, findPattern(step.ref));
          if (!found) {
            const detail = `요소를 찾지 못했다: ${findPattern(step.ref)}`;
            steps.push({ index: i, op: step.op, ok: false, text: detail, reason: detail });
            this.ledger.append({
              actor: { kind: 'system', id: 'hands' },
              kind: 'deny',
              ...(input.runId ? { runId: input.runId } : {}),
              summary: `${step.op} 중단 — ${detail}`,
            });
            return {
              ok: false,
              reason: 'step-failed',
              detail,
              steps,
              screenshots: shots,
              checklist: checklistFrom(input.steps, i),
              surface,
            };
          }
          step = { ...step, ref: found } as HandsStep;
        }

        const result = await client.callTool(HANDS_TOOL[step.op], toolArguments(step));
        if (step.op === 'snapshot' && result.ok) lastSnapshot = result.text;

        // 도구가 이미지를 돌려줬으면 우리 자리에 쓴다. playwright 의 임시
        // 파일을 가리키는 것은 증거가 아니다 — 지워지면 사라진다 (R7.2).
        const saved: string[] = [];
        if (input.evidenceDir) {
          result.images.forEach((image, n) => {
            const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const file = join(input.evidenceDir as string, `${String(i).padStart(2, '0')}-${step.op}${n > 0 ? `-${n}` : ''}.${ext}`);
            writeFileSync(file, Buffer.from(image.data, 'base64'));
            saved.push(file);
          });
        }
        shots.push(...saved);
        steps.push({
          index: i,
          op: step.op,
          ok: result.ok,
          text: result.text,
          ...(saved.length > 0 ? { screenshots: saved } : {}),
        });

        this.ledger.append({
          actor: { kind: 'system', id: 'hands' },
          kind: 'hands.step',
          ...(input.runId ? { runId: input.runId } : {}),
          payloadDigest: createHash('sha256').update(result.text).digest('hex'),
          summary: `${step.op} ${result.ok ? '성공' : '실패'}`,
          evidence: saved.length > 0 ? saved : [`step:${i}`],
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
            screenshots: shots,
            checklist: checklistFrom(input.steps, i),
            surface,
          };
        }
      }
      return { ok: true, steps, screenshots: shots, surface };
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
