/**
 * 브랜드 팩 대조 (R5.4, R5.5)
 *
 * 세 장으로 나눈다. 요구사항이 그렇게 부르기 때문이기도 하지만, 세 가지가
 * 서로 다른 종류의 사실이기 때문이다.
 *
 *   master_sheet     브랜드 자체 — 금지 표현, 필수 표기, 톤
 *   character_sheet  등장인물 — 이름·설정의 일관성
 *   content_base     말해도 되는 사실 — 여기 없는 주장은 근거 없는 주장이다
 *
 * **위반은 게이트 FAIL 이고 발행으로 넘어가지 않는다 (R5.5).** 경고로 두면
 * 아무도 안 본다. 브랜드 규칙은 나중에 고칠 수 있는 종류가 아니다 — 나간
 * 뒤에는 이미 나간 것이다.
 *
 * **한국어 경계 처리.** `\b` 는 한글에 동작하지 않는다. 금지어 "라이너" 를
 * 단순 부분 문자열로 찾으면 "아이라이너"·"팬티라이너" 같은 실제 상품명이
 * 걸린다. desktop 의 `shared/brand-safety.ts` 가 같은 함정을 밟고 고친 기록이
 * 있어 그 교훈만 가져왔다(코드는 별도 배포 단위라 import 하지 않는다).
 * 앞과 뒤를 다르게 보는데, 그 이유는 `findTerm` 주석에 적었다.
 */

export interface MasterSheet {
  /** 쓰면 안 되는 표현. */
  forbidden: string[];
  /** 반드시 들어가야 하는 표기 (예: 광고 표시). */
  required: string[];
  /** 브랜드 이름. 표기 흔들림을 잡는다. */
  brandName?: string;
}

export interface CharacterSheet {
  name: string;
  /** 이 인물이 하지 않는 것. */
  forbidden: string[];
}

export interface ContentBase {
  /** 근거가 있는 주장. 여기 없는 수치·효능은 쓸 수 없다. */
  claims: string[];
}

export interface BrandPack {
  masterSheet: MasterSheet;
  characters: CharacterSheet[];
  contentBase: ContentBase;
}

export type BrandRule = 'forbidden-term' | 'missing-required' | 'character-violation' | 'unsupported-claim';

export interface BrandViolation {
  rule: BrandRule;
  /** 어떤 규칙에 걸렸는지. 금지어 자체는 브랜드 자산이지 비밀이 아니므로 담는다. */
  detail: string;
  /** 본문 안 위치. 필수 표기 누락처럼 위치가 없는 것은 -1. */
  index: number;
}

export interface BrandVerdict {
  /** FAIL 이면 발행으로 넘어가지 않는다 (R5.5). */
  pass: boolean;
  violations: BrandViolation[];
}

const HANGUL = /[가-힣]/;

/**
 * 한국어 경계를 존중하는 부분 문자열 탐색.
 *
 * **앞뒤를 다르게 본다.** 한국어는 교착어라 앞과 뒤에 붙는 것의 성격이 다르다.
 *
 *   앞에 한글  합성어의 일부다      "아이라이너" 의 "라이너" → 일치 아님
 *   뒤에 한글  조사·어미다          "라이너를", "라이너다"   → 일치
 *
 * 처음에는 앞뒤 모두 한글이면 건너뛰게 만들었는데, 그러면 "라이너를 썼다"
 * 처럼 조사가 붙은 **대부분의 실제 문장**을 놓친다. 한국어에서 금지어가
 * 조사 없이 홀로 나오는 경우가 오히려 드물다.
 *
 * 이 규칙은 "라이너십" 같은 접미 합성어를 오탐한다. 브랜드 검사에서는
 * 놓치는 것보다 과하게 잡는 편이 낫다 — 오탐은 사람이 보고 넘기면 되지만,
 * 놓친 것은 나간 뒤에 발견된다.
 *
 * 영문·숫자는 `\b` 와 같은 규칙으로 앞뒤 모두 본다. 교착 현상이 없다.
 */
export function findTerm(text: string, term: string): number[] {
  if (term.length === 0) return [];
  const hits: number[] = [];
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;

    const before = at > 0 ? text[at - 1] ?? '' : '';
    const after = text[at + term.length] ?? '';
    const termStartsHangul = HANGUL.test(term[0] ?? '');
    const termEndsHangul = HANGUL.test(term[term.length - 1] ?? '');

    // 한글은 앞만 본다 — 뒤에 오는 한글은 조사·어미다.
    if (termStartsHangul && HANGUL.test(before)) continue;
    // 영문·숫자는 앞뒤 모두 본다.
    if (!termStartsHangul && /[A-Za-z0-9_]/.test(before)) continue;
    if (!termEndsHangul && /[A-Za-z0-9_]/.test(after)) continue;

    hits.push(at);
  }
  return hits;
}

/**
 * 본문을 브랜드 팩과 대조한다.
 *
 * 위반을 전부 모아서 돌려준다. 첫 위반에서 멈추면 고치고 다시 돌리는 왕복이
 * 늘어나고, 그 왕복마다 좌석 호출이 든다.
 */
export function checkBrand(text: string, pack: BrandPack): BrandVerdict {
  const violations: BrandViolation[] = [];

  for (const term of pack.masterSheet.forbidden) {
    for (const at of findTerm(text, term)) {
      violations.push({ rule: 'forbidden-term', detail: `금지 표현 "${term}"`, index: at });
    }
  }

  for (const term of pack.masterSheet.required) {
    if (findTerm(text, term).length === 0) {
      violations.push({ rule: 'missing-required', detail: `필수 표기 "${term}" 누락`, index: -1 });
    }
  }

  for (const character of pack.characters) {
    // 등장하지 않는 인물의 금지 사항은 볼 이유가 없다.
    if (findTerm(text, character.name).length === 0) continue;
    for (const term of character.forbidden) {
      for (const at of findTerm(text, term)) {
        violations.push({
          rule: 'character-violation',
          detail: `${character.name} 설정 위반 "${term}"`,
          index: at,
        });
      }
    }
  }

  violations.sort((a, b) => a.index - b.index);
  return { pass: violations.length === 0, violations };
}

/**
 * 근거 없는 주장을 찾는다 (R5.1 의 인용과 짝).
 *
 * 수치와 효능 표현을 뽑아 `content_base` 에 대응하는 근거가 있는지 본다.
 * 완전한 사실 검증은 불가능하므로 **패턴이 있는 것만** 잡는다 — "3배",
 * "1위", "효과가 있다" 같은 것들이다. 못 잡는 주장이 있다는 사실을 숨기지
 * 않기 위해, 이 함수는 `checkBrand` 와 분리해 두고 결과도 따로 보고한다.
 */
export function findUnsupportedClaims(text: string, base: ContentBase): BrandViolation[] {
  // 수치는 활용형이 다양해(빠릅니다·빨라졌다·개선됐다) 서술어로 좁히면
  // 대부분을 놓친다. **숫자로 된 크기 주장 자체**를 근거 대상으로 본다 —
  // 브랜드 카피에 숫자가 나오면 출처가 있어야 한다는 것이 원래 규칙이다.
  const patterns: RegExp[] = [
    /\d+\s*(?:배|%|퍼센트)/g,
    /(?:업계|국내|세계)\s*(?:1위|최초|최고)/g,
    /(?:완치|치료|의학적으로\s*입증)/g,
  ];

  const violations: BrandViolation[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const claim = m[0];
      const supported = base.claims.some((c) => findTerm(text, c).length > 0 || c.includes(claim));
      if (!supported) {
        violations.push({
          rule: 'unsupported-claim',
          detail: `근거 없는 주장 "${claim}" — content_base 에 대응하는 근거가 없다`,
          index: m.index,
        });
      }
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return violations;
}

/** 사람이 읽는 한 줄. */
export function describeViolation(v: BrandViolation): string {
  return v.index >= 0 ? `${v.detail} (위치 ${v.index})` : v.detail;
}
