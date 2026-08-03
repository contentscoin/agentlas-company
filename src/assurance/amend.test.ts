import { describe, expect, it } from 'vitest';
import {
  AMENDABLE_FIELDS,
  LOOSENING_FIELDS,
  assertNoLoosening,
  causeHypotheses,
  proposeEdits,
  renderDiff,
} from './amend.js';
import { compare } from './retro.js';
import type { Retro } from './retro.js';

const RECIPE = `name: demo
steps:
  - id: send
    kind: publish
    channel: threads
    subject: draft
    dryRun: true

  - id: retro
    kind: retro
    afterDays: 7
    subject: send
    channel: threads
    expect:
      views: 300
      likes: 20
      replies: 3
`;

function retroOf(actual: Record<string, number> | null): Retro {
  return compare(
    {
      runId: 'run-1',
      channel: 'threads',
      expected: { views: 300, likes: 20, replies: 3 },
      afterDays: 7,
      at: '2026-08-03T00:00:00.000Z',
    },
    actual === null ? null : { runId: 'run-1', actual, at: '2026-08-03T00:00:00.000Z' },
  );
}

describe('실측에 맞춰 예측을 다시 적는다 (R11.7)', () => {
  it('허용 범위를 벗어난 지표만 편집으로 낸다', () => {
    const p = proposeEdits({
      source: RECIPE,
      // views 는 범위 안(137%), replies 는 범위 밖(300%).
      retro: retroOf({ views: 412, likes: 20, replies: 9 }),
      stepId: 'retro',
    });
    expect(p.edits.map((e) => e.path)).toEqual(['steps[1].expect.replies']);
  });

  /**
   * 처음에는 조금이라도 다르면 편집을 냈다. 그러면 문장 쪽은 "이 레시피는
   * 그대로 두세요" 라고 하면서 diff 는 두 줄을 고치라고 하는 모순이 나왔다.
   */
  it('문장 제안과 diff 가 어긋나지 않는다', () => {
    const retro = retroOf({ views: 412, likes: 20, replies: 3 });
    const p = proposeEdits({ source: RECIPE, retro, stepId: 'retro' });
    expect(retro.amendments.join()).toContain('그대로 두세요');
    expect(p.edits).toEqual([]);
  });

  it('편집이 정확한 줄을 짚는다', () => {
    const p = proposeEdits({ source: RECIPE, retro: retroOf({ views: 900, likes: 20, replies: 3 }), stepId: 'retro' });
    const edit = p.edits[0]!;
    expect(RECIPE.split('\n')[edit.line - 1]).toBe(edit.before);
    expect(edit.before).toContain('views: 300');
    expect(edit.after).toContain('views: 900');
    // 들여쓰기를 망가뜨리지 않는다 — YAML 은 들여쓰기가 문법이다.
    expect(edit.after.startsWith('      ')).toBe(true);
  });

  it('실측값을 그대로 쓴다 — 여유를 얹어 적당히 좋은 숫자를 만들지 않는다', () => {
    const p = proposeEdits({ source: RECIPE, retro: retroOf({ views: 913, likes: 20, replies: 3 }), stepId: 'retro' });
    expect(p.edits[0]?.after).toContain('913');
  });

  /**
   * 통합 diff 의 헝크 머리말이 실제 줄 수와 맞는지 본다.
   *
   * 두 번 틀렸다. (1) 줄마다 -/+ 를 번갈아 내서 `git apply` 가 거부했고,
   * (2) `split('\n')` 의 유령 마지막 원소를 맥락 줄로 내보내 줄 수가
   * 하나씩 어긋났다. 둘 다 이 검사에 걸린다.
   */
  function assertWellFormed(diff: string): void {
    const lines = diff.split('\n');
    let i = 0;
    while (i < lines.length) {
      const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i] ?? '');
      if (!m) {
        i += 1;
        continue;
      }
      const oldWant = Number(m[2]);
      const newWant = Number(m[4]);
      let oldSeen = 0;
      let newSeen = 0;
      let sawPlusInRun = false;
      i += 1;
      for (; i < lines.length && !lines[i]?.startsWith('@@'); i++) {
        const l = lines[i] ?? '';
        if (l.startsWith('-')) {
          // 추가가 시작된 뒤에 삭제가 다시 나오면 번갈아 낸 것이다.
          expect(sawPlusInRun, '삭제는 추가보다 먼저 나와야 한다').toBe(false);
          oldSeen += 1;
        } else if (l.startsWith('+')) {
          sawPlusInRun = true;
          newSeen += 1;
        } else {
          sawPlusInRun = false;
          oldSeen += 1;
          newSeen += 1;
        }
      }
      expect(oldSeen, '헝크의 옛 줄 수').toBe(oldWant);
      expect(newSeen, '헝크의 새 줄 수').toBe(newWant);
    }
  }

  it('헝크 줄 수가 파일과 맞는다 (git apply 가 요구한다)', () => {
    const p = proposeEdits({
      source: RECIPE,
      retro: retroOf({ views: 900, likes: 20, replies: 100 }),
      stepId: 'retro',
      file: 'demo.yaml',
    });
    expect(p.edits.length).toBeGreaterThan(0);
    assertWellFormed(p.diff);
  });

  it('개행으로 끝나지 않는 파일도 줄 수가 맞는다', () => {
    const p = proposeEdits({
      source: RECIPE.trimEnd(),
      retro: retroOf({ views: 900, likes: 20, replies: 3 }),
      stepId: 'retro',
      file: 'demo.yaml',
    });
    assertWellFormed(p.diff);
  });

  it('diff 가 붙여 넣을 수 있는 형식이다', () => {
    const p = proposeEdits({
      source: RECIPE,
      retro: retroOf({ views: 900, likes: 20, replies: 9 }),
      stepId: 'retro',
      file: 'recipes/demo.yaml',
    });
    expect(p.diff).toContain('--- a/recipes/demo.yaml');
    expect(p.diff).toContain('+++ b/recipes/demo.yaml');
    expect(p.diff).toContain('-      views: 300');
    expect(p.diff).toContain('+      views: 900');
    // 가까운 편집은 한 헝크로 묶인다.
    expect(p.diff.match(/^@@/gm)).toHaveLength(1);
  });
});

describe('못 잰 것을 근거로 기준을 옮기지 않는다 (R11.6)', () => {
  it('수집 실패면 예측을 고치지 않는다', () => {
    const p = proposeEdits({ source: RECIPE, retro: retroOf(null), stepId: 'retro' });
    expect(p.edits).toEqual([]);
    expect(p.diff).toBe('');
    expect(p.notes[0]).toContain('먼저 측정을 고치세요');
  });

  it('일부만 수집돼도 못 잰 지표는 건드리지 않는다', () => {
    const p = proposeEdits({ source: RECIPE, retro: retroOf({ views: 900 }), stepId: 'retro' });
    expect(p.edits.map((e) => e.path)).toEqual(['steps[1].expect.views']);
    expect(p.notes.join()).toContain('likes');
  });

  it('채널이 없으면 그것부터 지적한다', () => {
    const noChannel = RECIPE.replace('    channel: threads\n    expect:', '    expect:');
    const p = proposeEdits({ source: noChannel, retro: retroOf(null), stepId: 'retro' });
    expect(p.notes.join()).toContain('channel 이 없습니다');
  });
});

describe('복기가 통제를 낮추지 않는다', () => {
  /**
   * 이것이 이 모듈에서 가장 중요한 규칙이다. "예측을 못 맞췄으니 승인
   * 단계를 빼자", "검증에 걸리니 brandOk 를 켜자" 는 지표를 좋아 보이게
   * 만들지만 그것이 정확히 통제를 없애는 방법이다.
   */
  it('편집 대상이 측정·예측으로만 제한된다', () => {
    for (const f of LOOSENING_FIELDS) {
      expect(AMENDABLE_FIELDS).not.toContain(f);
    }
  });

  it('게이트를 낮추는 편집이 섞이면 조용히 거르지 않고 던진다', () => {
    expect(() =>
      assertNoLoosening([
        { path: 'steps[0].brandOk', line: 5, before: '', after: '', why: '' },
      ]),
    ).toThrow(/통제를 낮추는/);
    expect(() =>
      assertNoLoosening([
        { path: 'steps[0].dryRun', line: 5, before: '', after: '', why: '' },
      ]),
    ).toThrow();
  });

  it('정상 편집은 통과한다', () => {
    expect(() =>
      assertNoLoosening([
        { path: 'steps[1].expect.views', line: 5, before: '', after: '', why: '' },
      ]),
    ).not.toThrow();
  });

  it('실제 제안에는 게이트 필드가 절대 들어가지 않는다', () => {
    const p = proposeEdits({
      source: RECIPE,
      retro: retroOf({ views: 1, likes: 1, replies: 1 }),
      stepId: 'retro',
    });
    // 지표가 전부 크게 미달이어도 제안은 expect 만 건드린다.
    expect(p.edits.every((e) => e.path.includes('.expect.'))).toBe(true);
    expect(p.diff).not.toContain('dryRun');
    expect(p.diff).not.toContain('brandOk');
  });
});

describe('원인 가설은 가설로 적는다', () => {
  it('전부 확인 요청 형태이고 결론이 아니다', () => {
    const h = causeHypotheses(retroOf({ views: 100, likes: 5, replies: 1 }));
    expect(h.some((x) => x.startsWith('가설:'))).toBe(true);
    expect(h[h.length - 1]).toContain('확인하기 전에는');
  });

  it('측정 실패면 다른 가설을 세우지 않는다', () => {
    const h = causeHypotheses(retroOf(null));
    expect(h).toHaveLength(1);
    expect(h[0]).toContain('측정 실패');
    expect(h.some((x) => x.startsWith('가설:'))).toBe(false);
  });

  it('예측 범위 안이면 바꿀 근거가 없다고 말한다', () => {
    const h = causeHypotheses(retroOf({ views: 300, likes: 20, replies: 3 }));
    expect(h.join()).toContain('바꿀 근거가 지금은 없습니다');
  });
});

describe('레시피를 못 찾는 경우', () => {
  it('스텝 id 가 없으면 지어내지 않는다', () => {
    const p = proposeEdits({ source: RECIPE, retro: retroOf({ views: 900 }), stepId: '없는스텝' });
    expect(p.edits).toEqual([]);
    expect(p.notes.join()).toContain('찾지 못했습니다');
  });

  it('편집이 없으면 빈 diff 다', () => {
    expect(renderDiff(RECIPE, [], 'x.yaml')).toBe('');
  });
});
