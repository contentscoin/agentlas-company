/**
 * 복기 (R11.6, R11.7)
 *
 * 발행하고 일정 기간이 지나면 **예측과 실제를 나란히 놓는다.** 그리고 그
 * 차이에서 레시피 수정 제안을 낸다.
 *
 * **예측이 없으면 복기가 아니다.** 사후에 "잘 됐다/안 됐다" 를 말하는 것은
 * 복기가 아니라 소감이다. 그래서 예측을 먼저 등록하고, 등록되지 않은 실행은
 * 복기 대상이 아니라고 분명히 말한다 — 없는 예측을 지어내지 않는다.
 *
 * **지표 수집 경로는 아직 없다.** 채널별 `read_metrics` 동사는 정의돼 있으나
 * (`src/verbs/types.ts`) 그것을 실행하는 어댑터가 없다. 그래서 이 모듈은
 * 실측값을 **주입받고**, 주입되지 않으면 "수집 못 함" 으로 남긴다. 추정으로
 * 채우면 복기가 거짓말이 된다.
 */

export interface Prediction {
  /** 어떤 발행에 대한 예측인가. */
  runId: string;
  channel: string;
  /** 지표 이름 → 예측값. */
  expected: Record<string, number>;
  /** 며칠 뒤에 볼 것인가. */
  afterDays: number;
  at: string;
}

export interface Observed {
  runId: string;
  /** 지표 이름 → 실측값. 수집 못 한 지표는 **넣지 않는다** (0 이 아니다). */
  actual: Record<string, number>;
  at: string;
}

export type Gap = {
  metric: string;
  expected: number;
  /** 수집하지 못했으면 null. 0 과 구분한다 — 0 은 측정 결과이고 null 은 모름이다. */
  actual: number | null;
  /** 실제/예측. `actual` 이 null 이면 null. */
  ratio: number | null;
};

export interface Retro {
  runId: string;
  channel: string;
  gaps: Gap[];
  /** 수집하지 못한 지표 이름. 숨기지 않는다. */
  uncollected: string[];
  /** 레시피 수정 제안 (R11.7). */
  amendments: string[];
  /** 예측이 없어 복기할 수 없는 경우. */
  skipped?: string;
}

/** 이 배수 밖이면 예측이 빗나갔다고 본다. */
export const MISS_LOW = 0.5;
export const MISS_HIGH = 2;

/**
 * 예측과 실측을 대조한다 (R11.6).
 *
 * 수집하지 못한 지표를 0 으로 채우지 않는다. 0 으로 채우면 "예측 100,
 * 실제 0" 이 되어 레시피를 잘못 고치게 된다 — 실제로 성과가 0 이었던 것과
 * 측정을 못 한 것은 완전히 다른 사실이다.
 */
export function compare(prediction: Prediction, observed: Observed | null): Retro {
  const gaps: Gap[] = [];
  const uncollected: string[] = [];

  for (const [metric, expected] of Object.entries(prediction.expected)) {
    const actual = observed?.actual[metric];
    if (actual === undefined) {
      uncollected.push(metric);
      gaps.push({ metric, expected, actual: null, ratio: null });
      continue;
    }
    gaps.push({
      metric,
      expected,
      actual,
      ratio: expected === 0 ? null : actual / expected,
    });
  }

  return {
    runId: prediction.runId,
    channel: prediction.channel,
    gaps,
    uncollected,
    amendments: proposeAmendments(gaps, uncollected, prediction.channel),
  };
}

/**
 * 레시피 수정 제안 (R11.7).
 *
 * 제안은 **행동으로 적는다.** "성과가 낮음" 은 제안이 아니다 — 다음에
 * 무엇을 바꿀지 적혀야 레시피가 고쳐진다.
 *
 * 수집 실패가 있으면 그것을 **가장 먼저** 제안한다. 측정하지 못하는 상태에서
 * 레시피를 고치는 것은 눈 감고 방향을 트는 것이다.
 */
export function proposeAmendments(
  gaps: readonly Gap[],
  uncollected: readonly string[],
  channel: string,
): string[] {
  const out: string[] = [];

  if (uncollected.length > 0) {
    out.push(
      `먼저 측정을 고치세요 — ${uncollected.join(', ')} 을 수집하지 못했습니다. ` +
        `${channel} read_metrics 어댑터가 없으면 복기는 반쪽입니다`,
    );
  }

  const measured = gaps.filter((g) => g.ratio !== null);
  if (measured.length === 0) {
    if (uncollected.length === 0) out.push('대조할 지표가 없습니다 — 예측에 지표를 넣으세요');
    return out;
  }

  const under = measured.filter((g) => (g.ratio as number) < MISS_LOW);
  const over = measured.filter((g) => (g.ratio as number) > MISS_HIGH);
  const onTarget = measured.length - under.length - over.length;

  for (const g of under) {
    out.push(
      `${g.metric}: 예측 ${g.expected} → 실제 ${g.actual} (${Math.round((g.ratio as number) * 100)}%). ` +
        '예측을 낮추거나, 이 지표를 올리는 스텝을 레시피에 추가하세요',
    );
  }
  for (const g of over) {
    out.push(
      `${g.metric}: 예측 ${g.expected} → 실제 ${g.actual} (${Math.round((g.ratio as number) * 100)}%). ` +
        '예측이 보수적이었습니다 — 기준을 올리면 다음 복기가 더 유용해집니다',
    );
  }
  if (under.length === 0 && over.length === 0 && onTarget > 0) {
    out.push(`지표 ${onTarget}건이 예측 범위 안입니다 — 이 레시피는 그대로 두세요`);
  }

  return out;
}

/** 예측이 없는 실행. 복기하지 않고 그 사실을 남긴다. */
export function noPrediction(runId: string, channel: string): Retro {
  return {
    runId,
    channel,
    gaps: [],
    uncollected: [],
    amendments: [
      '이 실행에는 예측이 등록되지 않아 복기할 수 없습니다',
      '다음부터는 발행 전에 기대 지표를 등록하세요 — 사후 소감은 복기가 아닙니다',
    ],
    skipped: '예측 없음',
  };
}

export function renderRetro(r: Retro): string[] {
  const lines = [`복기 — ${r.channel} (${r.runId})`, ''];
  if (r.skipped) {
    lines.push(`건너뜀: ${r.skipped}`);
  } else {
    lines.push('지표      예측      실제      비율');
    for (const g of r.gaps) {
      const actual = g.actual === null ? '수집못함' : String(g.actual);
      const ratio = g.ratio === null ? '—' : `${Math.round(g.ratio * 100)}%`;
      lines.push(`${g.metric.padEnd(10)}${String(g.expected).padEnd(10)}${actual.padEnd(10)}${ratio}`);
    }
  }
  lines.push('');
  lines.push('레시피 수정 제안:');
  for (const a of r.amendments) lines.push(`  ${a}`);
  return lines;
}
