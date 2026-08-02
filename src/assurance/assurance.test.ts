import { describe, expect, it } from 'vitest';
import { extractClaims, gradeClaim, registerClaims, describeClaim } from './claims.js';
import { DEFAULT_DOD, assure, findContradictions } from './checks.js';
import { compare, noPrediction, proposeAmendments, renderRetro } from './retro.js';

const NO_SOURCES = { packFacts: [], measured: [] };

describe('클레임 등록 (R11.1)', () => {
  it('수치 주장을 뽑는다', () => {
    const claims = extractClaims('처리 시간이 3배 줄었고 만족도가 90% 입니다');
    expect(claims.map((c) => c.text)).toEqual(['3배', '90%']);
    expect(claims.every((c) => c.kind === 'quantity')).toBe(true);
  });

  it('최상급·의학·비교 주장을 각각 구분한다', () => {
    const claims = extractClaims('업계 1위 이고 부작용 없으며 경쟁사 대비 낫습니다');
    const kinds = claims.map((c) => c.kind);
    expect(kinds).toContain('superlative');
    expect(kinds).toContain('medical');
    expect(kinds).toContain('comparative');
  });

  it('위치 순으로 돌려준다 — 사람이 원문을 훑는 순서다', () => {
    const claims = extractClaims('업계 1위 이고 3배 빠릅니다');
    expect(claims[0]?.index).toBeLessThan(claims[1]?.index ?? Infinity);
  });

  it('평범한 문장에는 클레임이 없다', () => {
    expect(extractClaims('오늘 새 소식을 전합니다')).toEqual([]);
  });
});

describe('근거 등급 (R11.2)', () => {
  it('같은 줄에서 근거를 대면 pack-citation', () => {
    const text = '자체 실험에서 3배 줄었다';
    const claims = registerClaims(text, { packFacts: ['자체 실험에서'], measured: [] });
    expect(claims[0]?.grade).toBe('pack-citation');
    expect(claims[0]?.evidence).toEqual(['자체 실험에서']);
  });

  it('실측값과 묶이면 measured', () => {
    const claims = registerClaims('전환율 12%', { packFacts: [], measured: ['전환율 12%'] });
    expect(claims[0]?.grade).toBe('measured');
  });

  it('문서 끝의 인용 한 줄이 본문 전체를 검증하지 않는다', () => {
    // 실측에서 잡은 버그. text.includes(fact) 로 판정하면 아래 세 주장이
    // 전부 "팩인용" 으로 통과했다 — 근거가 하나도 대응하지 않는데도.
    const text = ['10배 줄었고 90% 를 자동화했습니다. 업계 1위 입니다.', '', '[출처] 사내 파일럿 2026-07'].join('\n');
    const claims = registerClaims(text, { packFacts: ['사내 파일럿 2026-07'], measured: [] });
    expect(claims).toHaveLength(3);
    expect(claims.every((c) => c.grade === 'unverified')).toBe(true);
  });

  it('근거가 값을 직접 말하면 줄이 달라도 묶인다', () => {
    const text = ['본문에서 3배 라고 적었다', '', '[출처] 실험 결과 3배 개선'].join('\n');
    const claims = registerClaims(text, { packFacts: ['실험 결과 3배 개선'], measured: [] });
    expect(claims[0]?.grade).toBe('pack-citation');
  });

  it('둘 다 아니면 unverified — 추정으로 채우지 않는다', () => {
    const claims = registerClaims('3배 빠릅니다', NO_SOURCES);
    expect(claims[0]?.grade).toBe('unverified');
    expect(claims[0]?.evidence).toEqual([]);
  });

  it('미검증에는 근거를 지어내지 않는다', () => {
    const c = gradeClaim({ text: '90%', kind: 'quantity', index: 0 }, '90%', NO_SOURCES);
    expect(JSON.stringify(c)).not.toContain('추정');
    expect(c.evidence).toHaveLength(0);
  });

  it('사람이 읽는 문구에 등급이 드러난다', () => {
    const [c] = registerClaims('3배', NO_SOURCES);
    expect(describeClaim(c!)).toContain('미검증');
  });
});

describe('결정론적 검사 (R11.3)', () => {
  it('출처 없는 수치를 잡는다', () => {
    const claims = registerClaims('3배 빠릅니다', NO_SOURCES);
    const r = assure({ text: 'x'.repeat(60), claims, citations: ['출처'] });
    expect(r.findings.some((f) => f.kind === 'unsourced-number')).toBe(true);
  });

  it('같은 단위의 다른 값을 모순 후보로 본다', () => {
    const claims = registerClaims('3배 빨라졌고 5배 늘었다', { packFacts: ['3배', '5배'], measured: [] });
    const found = findContradictions(claims);
    expect(found).toHaveLength(1);
    // 자동 판정을 밀어붙이지 않는다 — 문맥이 다르면 정상이라고 적혀 있다.
    expect(found[0]?.detail).toContain('정상이다');
  });

  it('같은 값이 반복되면 모순이 아니다', () => {
    const claims = registerClaims('3배 그리고 3배', { packFacts: ['3배'], measured: [] });
    expect(findContradictions(claims)).toEqual([]);
  });

  it('주장은 있는데 인용이 없으면 증거 공백이다', () => {
    const claims = registerClaims('3배', { packFacts: ['3배'], measured: [] });
    const r = assure({ text: 'x'.repeat(60), claims, citations: [] });
    expect(r.findings.some((f) => f.kind === 'evidence-gap')).toBe(true);
  });

  it('결정론적이다 — 같은 입력에 같은 답', () => {
    const run = (): string =>
      JSON.stringify(
        assure({ text: '3배 빠릅니다'.repeat(10), claims: registerClaims('3배 빠릅니다', NO_SOURCES), citations: [] }),
      );
    expect(run()).toBe(run());
  });
});

describe('DoD 판정 (R11.4, R11.5)', () => {
  const long = 'x'.repeat(100);

  it('깨끗하면 PASS', () => {
    const claims = registerClaims('3배', { packFacts: ['3배'], measured: [] });
    expect(assure({ text: long, claims, citations: ['출처'] }).verdict).toBe('PASS');
  });

  it('미검증 주장이 있으면 BLOCK — 발행으로 넘어가지 않는다', () => {
    const claims = registerClaims('3배', NO_SOURCES);
    expect(assure({ text: long, claims, citations: ['출처'] }).verdict).toBe('BLOCK');
  });

  it('DoD 미달은 FAIL 이지 BLOCK 이 아니다 — 사람이 판단할 여지가 있다', () => {
    expect(assure({ text: '짧다', claims: [], citations: ['출처'] }).verdict).toBe('FAIL');
    expect(assure({ text: long, claims: [], citations: [] }).verdict).toBe('FAIL');
  });

  it('기본 DoD 는 미검증 0 이다 — 느슨하게 하려면 명시해야 한다', () => {
    expect(DEFAULT_DOD.maxUnverified).toBe(0);
    const claims = registerClaims('3배', NO_SOURCES);
    const loose = assure({ text: long, claims, citations: ['출처'], dod: { ...DEFAULT_DOD, maxUnverified: 5 } });
    expect(loose.verdict).toBe('PASS');
  });

  it('SEI 위험 신호는 BLOCK 이다', () => {
    const r = assure({ text: long, claims: [], citations: ['출처'], sei: { ran: true, risk: true } });
    expect(r.verdict).toBe('BLOCK');
  });

  it('SEI 를 못 돌렸으면 그 사실을 남긴다 — 건너뛴 것을 숨기지 않는다', () => {
    const r = assure({ text: long, claims: [], citations: ['출처'], sei: { ran: false, note: 'sei 미설치' } });
    expect(r.seiRan).toBe(false);
    expect(r.seiNote).toContain('미설치');
  });
});

describe('복기 (R11.6)', () => {
  const prediction = {
    runId: 'r1',
    channel: 'threads',
    expected: { views: 300, likes: 20 },
    afterDays: 7,
    at: '2026-08-02T00:00:00.000Z',
  };

  it('예측과 실측을 대조한다', () => {
    const r = compare(prediction, { runId: 'r1', actual: { views: 600, likes: 10 }, at: 'x' });
    expect(r.gaps.find((g) => g.metric === 'views')?.ratio).toBe(2);
    expect(r.gaps.find((g) => g.metric === 'likes')?.ratio).toBe(0.5);
  });

  it('수집하지 못한 지표를 0 으로 채우지 않는다', () => {
    const r = compare(prediction, { runId: 'r1', actual: { views: 300 }, at: 'x' });
    const likes = r.gaps.find((g) => g.metric === 'likes');
    expect(likes?.actual).toBeNull();
    expect(likes?.actual).not.toBe(0);
    expect(r.uncollected).toEqual(['likes']);
  });

  it('실측이 전혀 없으면 전부 수집 못 함이다', () => {
    const r = compare(prediction, null);
    expect(r.uncollected).toEqual(['views', 'likes']);
    expect(r.gaps.every((g) => g.actual === null)).toBe(true);
  });

  it('예측이 없으면 복기하지 않는다 — 사후 소감은 복기가 아니다', () => {
    const r = noPrediction('r2', 'threads');
    expect(r.skipped).toBe('예측 없음');
    expect(r.amendments.join()).toContain('사후 소감');
  });
});

describe('레시피 수정 제안 (R11.7)', () => {
  it('수집 실패를 가장 먼저 제안한다 — 눈 감고 방향을 틀지 않는다', () => {
    const out = proposeAmendments([{ metric: 'views', expected: 300, actual: null, ratio: null }], ['views'], 'threads');
    expect(out[0]).toContain('먼저 측정을 고치세요');
  });

  it('미달 지표에 행동을 적는다', () => {
    const out = proposeAmendments([{ metric: 'views', expected: 300, actual: 60, ratio: 0.2 }], [], 'threads');
    expect(out[0]).toContain('예측을 낮추거나');
  });

  it('초과 지표는 기준을 올리라고 한다', () => {
    const out = proposeAmendments([{ metric: 'views', expected: 100, actual: 900, ratio: 9 }], [], 'threads');
    expect(out[0]).toContain('보수적이었습니다');
  });

  it('범위 안이면 그대로 두라고 한다', () => {
    const out = proposeAmendments([{ metric: 'views', expected: 300, actual: 320, ratio: 1.07 }], [], 'threads');
    expect(out[0]).toContain('그대로 두세요');
  });

  it('표에 "수집못함" 을 그대로 보여준다', () => {
    const r = compare(
      { runId: 'r1', channel: 'threads', expected: { views: 300 }, afterDays: 7, at: 'x' },
      null,
    );
    expect(renderRetro(r).join('\n')).toContain('수집못함');
  });
});
