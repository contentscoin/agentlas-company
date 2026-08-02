import { describe, expect, it } from 'vitest';
import { checkBrand, findTerm, findUnsupportedClaims, type BrandPack } from './brandpack.js';
import { describeSlots, publishReadiness, slotOf, type Artifact } from './artifact.js';
import { extractCitations } from './studio.js';

const PACK: BrandPack = {
  masterSheet: {
    forbidden: ['최저가', '라이너', 'guaranteed'],
    required: ['광고'],
    brandName: '에이전트라스',
  },
  characters: [{ name: '크랩', forbidden: ['욕설', '반말'] }],
  contentBase: { claims: ['자체 실험에서 처리 시간이 줄었다'] },
};

describe('findTerm — 한국어 낱말 경계', () => {
  it('금지어가 다른 낱말의 일부면 걸지 않는다', () => {
    // "라이너" 를 부분 문자열로 찾으면 화장품 카피가 통째로 막힌다.
    expect(findTerm('아이라이너를 발랐다', '라이너')).toEqual([]);
    expect(findTerm('팬티라이너 신제품', '라이너')).toEqual([]);
  });

  it('독립된 낱말이면 잡는다', () => {
    expect(findTerm('라이너 스타일로 만들었다', '라이너').length).toBe(1);
    expect(findTerm('이것은 라이너다', '라이너').length).toBe(1);
  });

  it('조사·어미가 붙어도 잡는다 — 한국어에서는 그쪽이 보통이다', () => {
    for (const text of ['라이너를 썼다', '이것은 라이너다', '라이너의 특징']) {
      expect(findTerm(text, '라이너').length, text).toBe(1);
    }
  });

  it('앞에 붙은 한글은 합성어이므로 여전히 걸지 않는다', () => {
    expect(findTerm('아이라이너를 발랐다', '라이너')).toEqual([]);
  });

  it('영문은 낱말 문자에 붙어 있으면 다른 낱말이다', () => {
    expect(findTerm('guaranteed', 'guarantee')).toEqual([]);
    expect(findTerm('is guaranteed today', 'guaranteed').length).toBe(1);
  });

  it('대소문자를 구분하지 않는다', () => {
    expect(findTerm('GUARANTEED result', 'guaranteed').length).toBe(1);
  });

  it('빈 낱말은 찾지 않는다 — 무한 일치를 만들지 않는다', () => {
    expect(findTerm('아무 글', '')).toEqual([]);
  });
});

describe('checkBrand (R5.4, R5.5)', () => {
  it('금지 표현을 잡는다', () => {
    const v = checkBrand('업계 최저가 입니다. 광고', PACK);
    expect(v.pass).toBe(false);
    expect(v.violations.some((x) => x.rule === 'forbidden-term')).toBe(true);
  });

  it('필수 표기 누락을 잡는다', () => {
    const v = checkBrand('좋은 제품입니다', PACK);
    expect(v.violations.some((x) => x.rule === 'missing-required')).toBe(true);
  });

  it('깨끗한 본문은 통과한다', () => {
    expect(checkBrand('좋은 제품입니다. 광고', PACK).pass).toBe(true);
  });

  it('등장하지 않는 인물의 금지 사항은 보지 않는다', () => {
    // "욕설" 이 본문에 있어도 크랩이 안 나오면 그 인물 규칙은 무관하다.
    const v = checkBrand('욕설 없는 커뮤니티를 만듭니다. 광고', PACK);
    expect(v.violations.some((x) => x.rule === 'character-violation')).toBe(false);
  });

  it('등장하는 인물의 금지 사항은 본다', () => {
    const v = checkBrand('크랩이 욕설을 했다. 광고', PACK);
    expect(v.violations.some((x) => x.rule === 'character-violation')).toBe(true);
  });

  it('위반을 첫 건에서 멈추지 않고 모아 준다', () => {
    const v = checkBrand('최저가 이고 guaranteed 입니다', PACK);
    // 금지어 둘 + 필수 표기 누락 하나.
    expect(v.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('findUnsupportedClaims', () => {
  it('근거 없는 수치 주장을 잡는다', () => {
    const found = findUnsupportedClaims('3배 빠릅니다', PACK.contentBase);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.rule).toBe('unsupported-claim');
  });

  it('업계 1위 같은 표현을 잡는다', () => {
    expect(findUnsupportedClaims('업계 1위 제품', PACK.contentBase).length).toBeGreaterThan(0);
  });

  it('content_base 의 근거가 본문에 있으면 통과시킨다', () => {
    const text = '자체 실험에서 처리 시간이 줄었다. 3배 빠릅니다';
    expect(findUnsupportedClaims(text, PACK.contentBase)).toEqual([]);
  });

  it('평범한 문장은 잡지 않는다', () => {
    expect(findUnsupportedClaims('오늘 신제품을 소개합니다', PACK.contentBase)).toEqual([]);
  });
});

describe('extractCitations (R5.1)', () => {
  it('[출처] 줄을 뽑는다', () => {
    expect(extractCitations('본문\n[출처] 자체 실험 2026-07')).toContain('자체 실험 2026-07');
  });

  it('URL 을 뽑는다', () => {
    expect(extractCitations('근거: https://example.com/a')).toContain('https://example.com/a');
  });

  it('없으면 빈 배열이다 — 인용을 지어내지 않는다', () => {
    expect(extractCitations('아무 근거 없는 글')).toEqual([]);
  });

  it('중복을 접는다', () => {
    const c = extractCitations('https://a.com 그리고 https://a.com');
    expect(c).toHaveLength(1);
  });
});

describe('슬롯 — 미충족을 추정하지 않는다 (R5.2)', () => {
  const artifact: Artifact = {
    id: 'a1',
    title: '테스트',
    slots: [
      { kind: 'copy', state: 'filled', content: '본문입니다', citations: ['x'], seat: 'codex' },
      { kind: 'image', state: 'blocked', reason: 'desktop 표면 없음' },
    ],
    brandPass: true,
    brandNotes: [],
  };

  it('요청되지 않은 슬롯은 미충족으로 취급한다', () => {
    const slot = slotOf(artifact, 'video');
    expect(slot.state).toBe('unmet');
  });

  it('미충족 슬롯에는 산출물을 담을 필드가 없다', () => {
    const slot = slotOf(artifact, 'image');
    expect('content' in slot).toBe(false);
  });

  it('막힌 슬롯의 사유를 표에 그대로 보여준다', () => {
    const rows = describeSlots(artifact).join('\n');
    expect(rows).toContain('막힘');
    expect(rows).toContain('desktop 표면 없음');
  });

  it('필요한 슬롯이 막혀 있으면 발행할 수 없다', () => {
    const r = publishReadiness(artifact, ['copy', 'image']);
    expect(r.ready).toBe(false);
    expect(r.reasons.join()).toContain('막힘');
  });

  it('필요한 슬롯이 다 차고 브랜드를 통과하면 발행 가능하다', () => {
    expect(publishReadiness(artifact, ['copy']).ready).toBe(true);
  });

  it('브랜드 대조를 안 한 산출물은 발행 불가다 — 건너뛴 것은 통과가 아니다', () => {
    const unchecked: Artifact = { ...artifact, brandNotes: [] };
    delete (unchecked as { brandPass?: boolean }).brandPass;
    const r = publishReadiness(unchecked, ['copy']);
    expect(r.ready).toBe(false);
    expect(r.reasons.join()).toContain('검사하지 않은 것은 통과가 아니다');
  });

  it('브랜드 실패 사유를 그대로 전달한다', () => {
    const failed: Artifact = { ...artifact, brandPass: false, brandNotes: ['금지 표현 "최저가"'] };
    expect(publishReadiness(failed, ['copy']).reasons.join()).toContain('최저가');
  });
});
