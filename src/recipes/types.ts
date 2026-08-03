/**
 * 반복 업무 레시피 타입 (R12)
 *
 * 좋은 결과는 좋은 반복에서 나온다. 그래서 업무를 코드가 아니라
 * **선언**으로 적는다. 스텝마다 담당 주체, 산출물, 그리고 통과를 판정하는
 * 결정론적 게이트 명령을 명시한다.
 *
 * 무인 운영에서 가장 중요한 설계 판단은 **승인 스텝이 블로킹이 아니라는 것**이다.
 * 승인 카드 TTL 이 12시간인데 예약 작업이 그동안 프로세스를 붙잡고 있으면
 * 좌석도 잠기고 재부팅에도 못 견딘다. 그래서 실행은 `paused` 로 끝나고,
 * 승인이 떨어진 뒤 `resume` 이 이어받는다.
 */

import type { AutonomyLevel } from '../ledger/types.js';

export type StepKind = 'seat' | 'gate' | 'approval' | 'publish' | 'retro' | 'studio';

interface StepBase {
  /** 레시피 안에서 고유한 식별자. 재개 지점이 된다. */
  id: string;
  kind: StepKind;
  /** 사람이 읽는 설명. 원장 요약에 쓰인다. */
  title?: string;
}

/** 좌석에 물어 산출물을 만든다. */
export interface SeatStep extends StepBase {
  kind: 'seat';
  persona: string;
  instruction: string;
  /** 산출물 이름. 뒤 스텝이 이 이름으로 참조한다. */
  produce: string;
  /** 특정 좌석을 선호한다. */
  seat?: string;
  /** 이 벤더는 쓰지 않는다. Critic 스텝이 쓴다. */
  forbidVendor?: string[];
}

/**
 * 결정론적 게이트. 셸 명령의 종료 코드로 판정한다.
 *
 * LLM 판단을 게이트로 쓰지 않는다. 게이트는 재현 가능해야 하고,
 * 원장에 남은 PASS 가 나중에 같은 조건에서 다시 PASS 여야 한다.
 */
export interface GateStep extends StepBase {
  kind: 'gate';
  /** 종료 코드 0 이면 통과. */
  command: string;
  /** 실패해도 계속할지. 기본은 false — 게이트는 막는 것이 일이다. */
  continueOnFail?: boolean;
}

/** 정책 등급을 판정하고 필요하면 승인 카드를 만든다. */
export interface ApprovalStep extends StepBase {
  kind: 'approval';
  /** 정책에서 등급을 찾을 작업 이름. */
  action: string;
  /** 승인 대상이 되는 산출물 이름. digest 바인딩에 쓰인다. */
  subject: string;
}

/**
 * Studio 산출과 검증 (R5, R11.3~R11.5).
 *
 * 좌석 스텝과 나누는 이유는 **판정이 따라붙기 때문**이다. 좌석 스텝은
 * 텍스트만 남기지만 Studio 스텝은 브랜드 대조와 결정론적 검증을 거쳐
 * 그 결과를 산출물에 묶는다. 그래야 발행 스텝이 레시피에 적힌
 * `brandOk: true` 선언 대신 **실제로 대조된 결과**를 볼 수 있다.
 */
export interface StudioStep extends StepBase {
  kind: 'studio';
  /** 무엇을 만들지. 좌석에 전달할 기획 의도. */
  brief: string;
  /** 산출물 이름. 발행 스텝이 이 이름으로 본문과 판정을 함께 받는다. */
  produce: string;
  /** 채울 슬롯. 기본은 copy 하나. */
  want?: string[];
  /**
   * 브랜드 팩 파일 경로.
   *
   * 없으면 규칙 없이 대조하고 **그 사실을 판정에 남긴다** — 규칙이 없어서
   * 위반이 없는 것과 대조해서 위반이 없는 것은 다른 사실이다.
   */
  pack?: string;
  /**
   * 검증 BLOCK 이어도 계속할지. 기본은 거짓.
   *
   * BLOCK 은 나가면 안 되는 것이고, 나갈 수 없는 본문에 좌석 호출을 더 쓰는
   * 것은 낭비다 (1회 하한 19.4k 토큰). 수정 루프를 돌리는 레시피만 켠다.
   */
  continueOnBlock?: boolean;
}

/**
 * 채널 발행 (R6, R12.1).
 *
 * `subject` 는 **이전 스텝의 산출물 이름**이다. 본문을 레시피에 직접 적지
 * 않는다 — 적을 수 있게 하면 레시피가 자유 텍스트 발행 경로가 되고, 동사
 * 계약(R16.7)을 우회한다. 산출물을 만든 스텝이 본문의 출처다.
 */
export interface PublishStep extends StepBase {
  kind: 'publish';
  channel: string;
  subject: string;
  /**
   * 브랜드 대조를 통과한 것으로 볼지.
   *
   * 기본은 거짓이고, 그러면 발행 브로커가 막는다 (R5.5). 레시피에 적는다는
   * 것은 오너가 브랜드 책임을 진다는 선언이다.
   *
   * **산출물에 판정이 붙어 있으면 그쪽이 이긴다.** Studio 스텝이 실제로
   * 대조한 결과를 레시피의 선언으로 덮을 수 있다면 대조할 이유가 없다 —
   * 이 필드는 Studio 를 거치지 않은 산출물에만 쓰인다.
   */
  brandOk?: boolean;
  /** 실제로 내보내지 않고 페이로드만 확인한다 (R6.4). */
  dryRun?: boolean;
}

/**
 * 발행 후 성과 회수와 복기 (R11.6, R11.7).
 *
 * `subject` 는 예측을 등록한 발행 스텝의 id 다. **예측이 없으면 복기하지
 * 않는다** — 사후 소감은 복기가 아니다.
 */
export interface RetroStep extends StepBase {
  kind: 'retro';
  afterDays: number;
  subject: string;
  /** 지표 이름 → 예측값. 없으면 복기할 것이 없다. */
  expect?: Record<string, number>;
  /** 지표를 읽을 채널. 없으면 실측 없이 복기한다. */
  channel?: string;
  /** 집계 구간. 채널이 있을 때만 쓰인다. */
  from?: string;
  to?: string;
}

export type Step = SeatStep | GateStep | ApprovalStep | PublishStep | RetroStep | StudioStep;

export interface Recipe {
  name: string;
  /** cron 유사 표기. 실행은 OS 스케줄러가 하고 여기엔 기록만 남는다 (R12.6). */
  schedule?: string;
  description?: string;
  steps: Step[];
}

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'awaiting-approval';

export interface StepState {
  id: string;
  kind: StepKind;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  /** 산출물 digest. 재개 시 승인 바인딩을 다시 확인하는 데 쓴다. */
  artifactDigest?: string;
  /** 이 스텝이 만든 승인 카드 id. */
  approvalId?: string;
  level?: AutonomyLevel;
  detail?: string;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'paused';

export interface RunState {
  runId: string;
  recipe: string;
  status: RunStatus;
  startedAt: string
  endedAt?: string;
  steps: StepState[];
  /** 산출물 저장. 이름 → 텍스트. */
  artifacts: Record<string, string>;
  /**
   * 산출물에 붙은 판정. 이름 → 브랜드·검증 결과.
   *
   * **스텝이 아니라 산출물에 묶는다.** 발행 스텝은 자기 `subject` 로만
   * 산출물을 알고, 그것을 누가 만들었는지는 모른다 — 판정이 산출물을 따라와야
   * 중간에 스텝이 끼어도 이어진다.
   */
  judgments?: Record<string, ArtifactJudgment>;
  /** 오염 전파. 한 번 오염되면 그 실행의 이후 산출물도 오염이다. */
  tainted: boolean;
  detail?: string;
}

/** 산출물에 붙는 브랜드·검증 판정 (R5.4, R11.3~R11.5). */
export interface ArtifactJudgment {
  brandPass: boolean;
  brandNotes: string[];
  verdict: 'PASS' | 'FAIL' | 'BLOCK';
  assuranceNotes: string[];
  /** 브랜드 팩 없이 대조했는가. 규칙이 없어서 통과한 것을 통과로 읽지 않게 한다. */
  packless: boolean;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  /** 멈춘 지점. `paused` 나 `failed` 일 때 채워진다. */
  stoppedAt?: string;
  reason?: string;
}
