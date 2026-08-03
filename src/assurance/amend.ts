/**
 * 레시피 수정 제안 — 말이 아니라 diff (R11.7)
 *
 * `proposeAmendments` 는 사람이 읽는 문장을 낸다. 그것만으로는 레시피가
 * 고쳐지지 않는다 — 오너가 파일을 열고, 어느 줄인지 찾고, 숫자를 옮겨
 * 적어야 한다. 그 사이에서 제안이 증발한다.
 *
 * 그래서 여기서는 **적용 가능한 편집**을 낸다. 줄 위치와 바뀔 값을 짚고
 * 통합 diff 로 보여 준다.
 *
 * ## 절대 낮추지 않는다
 *
 * 복기가 게이트를 낮추는 제안을 내면 시스템이 스스로 통제를 침식한다.
 * "예측을 못 맞췄으니 승인 단계를 빼자", "검증에 걸리니 brandOk 를 켜자" 는
 * 지표를 좋아 보이게 만들지만 그것이 정확히 통제를 없애는 방법이다.
 *
 * 그래서 **편집 대상을 화이트리스트로 제한한다.** `expect` 숫자와 `channel`
 * 같은 측정 설정만 건드린다. 게이트·승인·브랜드·검증에 관한 필드는 제안
 * 대상이 아니고, 그 규칙을 `assertNoLoosening` 이 실행 시점에 다시 확인한다 —
 * 화이트리스트를 나중에 누가 넓힐 때를 대비한 두 번째 자물쇠다.
 *
 * ## 적용하지 않는다
 *
 * 제안은 제안이다. 이 모듈은 파일을 쓰지 않는다. 무인 운영에서 레시피가
 * 스스로를 고치기 시작하면 원장에 남는 것은 결과뿐이고 누가 왜 바꿨는지가
 * 사라진다.
 */

import { parseDocument } from 'yaml';
import { MISS_HIGH, MISS_LOW, type Gap, type Retro } from './retro.js';

/** 제안 한 건. 줄 단위로 짚어야 오너가 확인할 수 있다. */
export interface RecipeEdit {
  /** 사람이 읽는 위치. 예: `steps[7].expect.views` */
  path: string;
  /** 1부터 세는 줄 번호. */
  line: number;
  before: string;
  after: string;
  why: string;
}

export interface AmendProposal {
  edits: RecipeEdit[];
  /** 편집으로 표현할 수 없어 말로 남는 것. */
  notes: string[];
  /** 통합 diff. 편집이 없으면 빈 문자열. */
  diff: string;
}

/**
 * 제안이 건드려도 되는 필드.
 *
 * **측정과 예측만이다.** 여기 없는 것은 제안하지 않는다 — 목록을 좁게 두는
 * 것이 이 모듈의 안전장치다.
 */
export const AMENDABLE_FIELDS: readonly string[] = ['expect', 'channel', 'from', 'to', 'afterDays'];

/**
 * 이 이름들이 편집 경로에 나타나면 통제를 낮추는 제안이다.
 *
 * 화이트리스트가 이미 막지만, 나중에 누가 `AMENDABLE_FIELDS` 를 넓힐 수 있다.
 * 그때 이 검사가 걸린다.
 */
export const LOOSENING_FIELDS: readonly string[] = [
  'brandOk',
  'continueOnBlock',
  'continueOnFail',
  'dryRun',
  'kind',
  'command',
  'action',
  'pack',
  'forbidVendor',
];

/** 통제를 낮추는 편집이 섞이면 던진다. 조용히 거르지 않는다. */
export function assertNoLoosening(edits: readonly RecipeEdit[]): void {
  for (const e of edits) {
    const field = e.path.split('.').pop() ?? '';
    const bad = LOOSENING_FIELDS.find((f) => e.path.includes(`.${f}`) || field === f);
    if (bad) {
      throw new Error(
        `복기가 통제를 낮추는 제안을 냈다: ${e.path} (${bad}). ` +
          '복기는 측정과 예측만 고친다 — 게이트를 낮춰 지표를 맞추는 것은 통제 침식이다',
      );
    }
  }
}

/** 오프셋을 1부터 세는 줄 번호로. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 실측에 맞춰 예측을 다시 적는다.
 *
 * **실측값을 그대로 쓴다.** 여유를 얹거나 반올림해 "적당히 좋은" 숫자를
 * 만들지 않는다 — 다음 복기가 대조할 기준은 근거 있는 값이어야 하고,
 * 실제로 나온 값보다 근거 있는 숫자는 없다.
 *
 * **`proposeAmendments` 와 같은 허용 범위를 쓴다.** 처음에는 조금이라도
 * 다르면 편집을 냈는데, 그러면 문장 쪽은 "이 레시피는 그대로 두세요" 라고
 * 하면서 diff 는 두 줄을 고치라고 하는 모순이 나왔다 — 실제로 그랬다.
 * 범위 안의 흔들림까지 반영하면 매 복기마다 레시피가 흔들린다.
 */
function proposedExpectation(gap: Gap): number | null {
  if (gap.actual === null || gap.ratio === null) return null;
  if (gap.actual === gap.expected) return null;
  if (gap.ratio >= MISS_LOW && gap.ratio <= MISS_HIGH) return null;
  return gap.actual;
}

export interface AmendInput {
  /** 레시피 YAML 원문. */
  source: string;
  /** 복기 결과. */
  retro: Retro;
  /** 예측을 들고 있는 retro 스텝의 id. */
  stepId: string;
  /** 파일 경로. diff 머리말에 쓴다. */
  file?: string;
}

/**
 * 복기에서 레시피 편집을 뽑는다.
 *
 * 수집하지 못한 지표는 **예측을 고치지 않는다.** 못 잰 것을 근거로 기준을
 * 옮기면 다음 복기도 같은 자리에서 헛돈다 — 먼저 측정을 고쳐야 한다.
 */
export function proposeEdits(input: AmendInput): AmendProposal {
  const notes: string[] = [];
  const edits: RecipeEdit[] = [];

  if (input.retro.skipped) {
    return { edits: [], notes: [`복기를 건너뛰었습니다 (${input.retro.skipped}) — 고칠 근거가 없습니다`], diff: '' };
  }

  const doc = parseDocument(input.source);
  const steps = doc.get('steps') as { items?: unknown[] } | undefined;
  const items = Array.isArray(steps?.items) ? steps.items : [];
  const index = items.findIndex(
    (it) => (it as { get(k: string): unknown }).get('id') === input.stepId,
  );
  if (index < 0) {
    return {
      edits: [],
      notes: [`레시피에서 스텝 "${input.stepId}" 을 찾지 못했습니다 — 파일이 바뀌었는지 확인하세요`],
      diff: '',
    };
  }

  const step = items[index] as { get(k: string, keep?: boolean): unknown };
  const expect = step.get('expect', true) as { items?: unknown[] } | undefined;

  // 측정 실패가 먼저다. 못 잰 지표의 예측은 건드리지 않는다.
  if (input.retro.uncollected.length > 0) {
    notes.push(
      `먼저 측정을 고치세요 — ${input.retro.uncollected.join(', ')} 을 수집하지 못했습니다. ` +
        '못 잰 지표의 예측은 고치지 않았습니다',
    );
    const channel = step.get('channel');
    if (channel === undefined) {
      notes.push(
        `steps[${index}] 에 channel 이 없습니다 — 실측을 읽으려면 채널을 지정해야 합니다`,
      );
    }
  }

  for (const gap of input.retro.gaps) {
    const next = proposedExpectation(gap);
    if (next === null) continue;

    const pair = (expect?.items ?? []).find(
      (p) => (p as { key: { value: unknown } }).key.value === gap.metric,
    ) as { value: { value: unknown; range: [number, number, number] } } | undefined;
    if (!pair) {
      notes.push(`${gap.metric}: 레시피에서 예측 줄을 찾지 못했습니다`);
      continue;
    }

    const line = lineOf(input.source, pair.value.range[0]);
    const before = input.source.split('\n')[line - 1] ?? '';
    edits.push({
      path: `steps[${index}].expect.${gap.metric}`,
      line,
      before,
      after: before.replace(String(pair.value.value), String(next)),
      why:
        `예측 ${gap.expected} → 실제 ${gap.actual}` +
        (gap.ratio === null ? '' : ` (${Math.round(gap.ratio * 100)}%)`) +
        '. 실측값을 다음 기준으로 씁니다',
    });
  }

  // 화이트리스트가 이미 막지만 한 번 더 본다.
  assertNoLoosening(edits);

  return { edits, notes, diff: renderDiff(input.source, edits, input.file ?? 'recipe.yaml') };
}

/**
 * 통합 diff 로 그린다.
 *
 * 편집이 줄 단위 치환이라 일반 diff 알고리즘이 필요 없다 — 바뀐 줄과 그
 * 주변만 보여 준다. `git apply` 로 확인한 형식이다.
 */
export function renderDiff(source: string, edits: readonly RecipeEdit[], file: string): string {
  if (edits.length === 0) return '';
  // `split` 은 개행으로 끝나는 파일에서 유령 원소를 하나 더 만든다. 그것을
  // 맥락 줄로 내보내면 헝크의 줄 수가 파일과 어긋나 `git apply` 가 거부한다 —
  // 실제로 거부당했다. 마지막 개행은 줄이 아니라 줄의 끝이다.
  const raw = source.split('\n');
  const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  const CONTEXT = 3;
  // 절대 경로에 `a/` 를 붙이면 `a//home/...` 가 된다. 실제로 그렇게 나왔다.
  const label = file.startsWith('/') ? file.slice(1) : file;

  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];

  const sorted = [...edits].sort((a, b) => a.line - b.line);
  let i = 0;
  while (i < sorted.length) {
    const group = [sorted[i] as RecipeEdit];
    while (
      i + 1 < sorted.length &&
      (sorted[i + 1] as RecipeEdit).line - (group[group.length - 1] as RecipeEdit).line <= CONTEXT * 2
    ) {
      i += 1;
      group.push(sorted[i] as RecipeEdit);
    }
    i += 1;

    const first = group[0] as RecipeEdit;
    const last = group[group.length - 1] as RecipeEdit;
    const start = Math.max(1, first.line - CONTEXT);
    const end = Math.min(lines.length, last.line + CONTEXT);
    const count = end - start + 1;

    out.push(`@@ -${start},${count} +${start},${count} @@`);
    const byLine = new Map(group.map((e) => [e.line, e]));

    // **연속된 변경은 삭제를 모두 낸 뒤 추가를 낸다.** 줄마다 -/+ 를
    // 번갈아 내면 `git apply` 가 거부한다 — 처음에 그렇게 냈고 실제로
    // 거부당했다. 통합 diff 는 헝크 안에서 삭제 블록과 추가 블록을 나눈다.
    let n = start;
    while (n <= end) {
      if (!byLine.has(n)) {
        out.push(` ${lines[n - 1] ?? ''}`);
        n += 1;
        continue;
      }
      const run: RecipeEdit[] = [];
      while (n <= end && byLine.has(n)) {
        run.push(byLine.get(n) as RecipeEdit);
        n += 1;
      }
      for (const e of run) out.push(`-${e.before}`);
      for (const e of run) out.push(`+${e.after}`);
    }
  }
  return out.join('\n');
}

/**
 * 원인 가설 (R11.7).
 *
 * **가설을 결론으로 적지 않는다.** 우리가 가진 것은 숫자 몇 개뿐이고,
 * 그것으로 원인을 안다고 말하면 다음 사람이 검증된 것으로 읽는다. 그래서
 * 전부 "무엇을 확인해 보라" 로 끝난다 — 검증할 수 있는 형태여야 가설이다.
 *
 * 측정 실패가 있으면 다른 가설을 내지 않는다. 못 잰 상태에서 원인을 추측하는
 * 것은 눈 감고 방향을 트는 것이다.
 */
export function causeHypotheses(retro: Retro): string[] {
  if (retro.skipped) return [`복기를 건너뛰었습니다 (${retro.skipped}) — 세울 가설이 없습니다`];

  if (retro.uncollected.length > 0) {
    return [
      `측정 실패: ${retro.uncollected.join(', ')} 를 수집하지 못했습니다. ` +
        '원인 가설은 세우지 않습니다 — 못 잰 상태의 추측은 다음 복기를 오염시킵니다',
    ];
  }

  const measured = retro.gaps.filter((g) => g.ratio !== null);
  if (measured.length === 0) return ['대조한 지표가 없어 가설을 세울 수 없습니다'];

  const under = measured.filter((g) => (g.ratio as number) < 0.7);
  const over = measured.filter((g) => (g.ratio as number) > 1.3);
  const out: string[] = [];

  if (under.length === measured.length) {
    out.push(
      '가설: 예측 자체가 높았을 수 있습니다 — 지난 실행들의 실측 분포를 보고 기준선을 다시 잡아 보세요',
    );
    out.push(
      '가설: 도달이 아니라 노출 단계에서 막혔을 수 있습니다 — 발행 시각과 채널 노출 지표를 함께 확인해 보세요',
    );
  } else if (under.length > 0 && over.length > 0) {
    out.push(
      `가설: 지표끼리 방향이 갈립니다 (${under.map((g) => g.metric).join(', ')} 미달 / ` +
        `${over.map((g) => g.metric).join(', ')} 초과). ` +
        '두 지표가 같은 원인을 공유하는지 — 예를 들어 노출은 늘고 전환은 줄었는지 확인해 보세요',
    );
  } else if (over.length === measured.length) {
    out.push('가설: 기준이 낮아 대조가 느슨했습니다 — 예측을 올리면 다음 복기가 더 많은 것을 말해 줍니다');
  } else {
    out.push('지표가 대체로 예측 범위 안입니다 — 이 레시피를 바꿀 근거가 지금은 없습니다');
  }

  out.push('위는 전부 가설입니다. 확인하기 전에는 레시피를 바꾸는 근거로 쓰지 마세요');
  return out;
}
