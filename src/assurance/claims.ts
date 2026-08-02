/**
 * 클레임 등록과 근거 등급 (R11.1, R11.2)
 *
 * 산출물이 **주장하는 것**을 뽑아 목록으로 만든다. 그래야 "무엇을 검증할
 * 것인가" 가 명시적이 된다 — 검증할 대상이 암묵적이면 검증은 느낌이 된다.
 *
 * 근거 등급이 셋이다.
 *
 *   pack-citation  브랜드 팩·컨텍스트 팩에 있는 사실을 인용했다
 *   measured       우리가 실제로 재서 원장에 남긴 값이다
 *   unverified     둘 다 아니다
 *
 * **`unverified` 를 추정으로 채우지 않는다 (R11.2).** "아마 맞을 것" 은
 * 근거가 아니고, 그것을 근거처럼 적으면 다음 사람이 검증된 것으로 읽는다.
 * 미검증은 미검증으로 남고, 그 상태로 발행 게이트에 간다.
 *
 * 클레임 **추출**은 `studio/brandpack.ts` 와 같은 패턴을 쓴다. 두 곳에
 * 정규식을 복사하면 한쪽만 개선되고 다른 쪽이 뒤처진다 — 그래서 여기가
 * 정본이고 브랜드 검사가 이것을 쓴다.
 */

/** 검증 대상이 되는 주장의 패턴. 여기가 정본이다. */
export const CLAIM_PATTERNS: ReadonlyArray<{ kind: ClaimKind; re: RegExp }> = [
  // 숫자로 된 크기 주장. 활용형이 다양해(빠릅니다·빨라졌다) 서술어로 좁히면
  // 대부분을 놓치므로 숫자 자체를 대상으로 본다.
  { kind: 'quantity', re: /\d[\d,.]*\s*(?:배|%|퍼센트|원|건|명|시간|분)/g },
  { kind: 'superlative', re: /(?:업계|국내|세계|시장)\s*(?:1위|최초|최고|유일)/g },
  { kind: 'medical', re: /(?:완치|치료|의학적으로\s*입증|부작용\s*없)/g },
  { kind: 'comparative', re: /(?:경쟁사|타사|기존)\s*(?:대비|보다)/g },
];

export type ClaimKind = 'quantity' | 'superlative' | 'medical' | 'comparative';
export type EvidenceGrade = 'pack-citation' | 'measured' | 'unverified';

export interface Claim {
  /** 주장 원문 조각. 사람이 원문에서 찾을 수 있어야 한다. */
  text: string;
  kind: ClaimKind;
  /** 본문 안 위치. */
  index: number;
  grade: EvidenceGrade;
  /** 어떤 근거에 묶였는가. `unverified` 면 비어 있다. */
  evidence: string[];
}

export interface EvidenceSources {
  /** 팩에 실린 사실. 브랜드 content_base, 컨텍스트 팩 인용 등. */
  packFacts: readonly string[];
  /** 우리가 재서 원장에 남긴 값. `지표: 값` 형태의 키. */
  measured: readonly string[];
}

/**
 * 본문에서 클레임을 뽑는다 (R11.1).
 *
 * 겹치는 자리는 각각 등록한다 — "업계 1위" 와 그 안의 숫자는 서로 다른
 * 종류의 주장이고, 근거도 다를 수 있다.
 */
export function extractClaims(text: string): Array<Omit<Claim, 'grade' | 'evidence'>> {
  const out: Array<Omit<Claim, 'grade' | 'evidence'>> = [];
  for (const { kind, re } of CLAIM_PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      out.push({ text: m[0], kind, index: m.index });
      if (m.index === rx.lastIndex) rx.lastIndex += 1;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 클레임이 있는 줄. 근접성 판정의 단위다. */
function lineOf(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

/**
 * 근거 하나가 주장 하나를 뒷받침하는가.
 *
 * **문서 어딘가에 인용이 있다는 것은 근거가 아니다.** 처음에는
 * `text.includes(fact)` 로 판정했는데, 그러면 문서 끝에 `[출처]` 한 줄만
 * 있으면 본문의 **모든** 수치가 검증된 것이 됐다. 실측에서 근거 없는 주장
 * 셋이 전부 "팩인용" 으로 통과하는 것을 보고 잡았다.
 *
 * 뒷받침한다고 보는 경우는 둘이다.
 *   근거가 그 값을 직접 말한다     "전환율 12%" 가 "12%" 를 뒷받침
 *   같은 줄에 함께 있다             한 문장 안에서 근거를 대고 있다
 *
 * 문단 단위로 넓히지 않는 이유는, 넓힐수록 앞의 실패로 되돌아가기 때문이다.
 * 좁아서 안 묶이면 사람이 근거를 주장 옆에 적게 되고, 그것이 바라는 방향이다.
 */
export function supports(fact: string, claim: Omit<Claim, 'grade' | 'evidence'>, text: string): boolean {
  if (fact.trim() === '') return false;
  if (fact.includes(claim.text)) return true;
  return lineOf(text, claim.index).includes(fact);
}

/**
 * 근거를 매긴다 (R11.2).
 *
 * 애매하면 묶지 않고 미검증으로 둔다 — **검증됐다고 잘못 말하는 쪽이 훨씬
 * 나쁘다.** 미검증은 사람이 보고 근거를 붙이면 되지만, 잘못 검증된 것은
 * 아무도 다시 보지 않는다.
 */
export function gradeClaim(
  claim: Omit<Claim, 'grade' | 'evidence'>,
  text: string,
  sources: EvidenceSources,
): Claim {
  const cited = sources.packFacts.filter((fact) => supports(fact, claim, text));
  if (cited.length > 0) {
    return { ...claim, grade: 'pack-citation', evidence: cited };
  }

  const measured = sources.measured.filter((m) => supports(m, claim, text));
  if (measured.length > 0) {
    return { ...claim, grade: 'measured', evidence: measured };
  }

  return { ...claim, grade: 'unverified', evidence: [] };
}

/** 본문 전체를 클레임 목록으로 만든다. */
export function registerClaims(text: string, sources: EvidenceSources): Claim[] {
  return extractClaims(text).map((c) => gradeClaim(c, text, sources));
}

export function describeClaim(c: Claim): string {
  const grade =
    c.grade === 'unverified'
      ? '미검증'
      : c.grade === 'measured'
        ? `실측(${c.evidence.length})`
        : `팩인용(${c.evidence.length})`;
  return `${grade} ${c.kind} "${c.text}" (위치 ${c.index})`;
}
