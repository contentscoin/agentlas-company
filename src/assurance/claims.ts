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
  // 만·억·조를 사이에 허용한다. 이것이 없어서 `500만원`·`3억 원`·`1,200만 명`
  // 이 전부 빠져나갔다 — 한국어 사업 문서의 금액·수량은 대부분 이 형태다.
  // 차단 대상 종류라 놓치면 근거 없는 금액 주장이 그대로 발행된다.
  { kind: 'quantity', re: /\d[\d,.]*\s*(?:[만억조]\s*)?(?:배|%|퍼센트|원|건|명)/g },
  // 시간 단위는 따로 뺐다. 실측에서 이 단위의 유일한 검출이 점검 공지의
  // "총 2시간" 이었고, 그것 때문에 서비스 점검 안내가 BLOCK 됐다.
  // 성과 주장일 수도 있으므로 버리지 않고 **권고**로 돌린다 (아래 참조).
  { kind: 'duration', re: /\d[\d,.]*\s*(?:초|분|시간|일|주|개월|년)(?![가-힣])/g },
  { kind: 'superlative', re: /(?:업계|국내|세계|시장)\s*(?:1위|최초|최고|유일)/g },
  // 접두어 없는 최상급·선도 주장. Task 11.4 에서 실측 후 추가했다.
  // **뒤따르는 형태를 요구한다** — `최고치`·`최고급`·`최적화`·`최소한` 같은
  // 일상어를 잡지 않기 위해서다.
  {
    kind: 'superlative-bare',
    re: /(?:선도(?:하|적|합|해)|(?:최고|최상)(?:의|\s*수준)|유일한|독보적|1\s*위)/g,
  },
  { kind: 'medical', re: /(?:완치|치료|의학적으로\s*입증|부작용\s*없)/g },
  { kind: 'comparative', re: /(?:경쟁사|타사|기존)\s*(?:대비|보다)/g },
];

/**
 * 검출하되 **발행을 막지는 않는** 주장 종류 (R11.3, R11.5).
 *
 * Task 11.4 에서 실좌석 산출물 14편(5,379자)을 재고 정했다. 근거는 셋이다.
 *
 * 1. **정규식이 다짐과 단언을 못 가른다.** 코퍼스의 유일한 선도 표현은
 *    "업계를 선도하는 기준이 **되겠습니다**" 였다 — 현재 상태 주장이 아니라
 *    포부다. 막을 근거가 없다.
 * 2. **지시문 되울림이 걸린다.** "최고 수준을 내세우는 브랜드…" 는 좌석이
 *    내 브리프를 그대로 되읊은 것이다. 어떤 패턴을 써도 이 형태는 잡힌다.
 * 3. **시간 단위는 실측에서 오탐이 100%였다.** 유일한 검출이 점검 공지의
 *    "총 2시간" 이었고 그 때문에 안내문이 BLOCK 됐다. 막으면 사람들은
 *    검증을 끄게 되고, 끈 검증은 없는 검증이다.
 *
 * 권고는 **버리는 것이 아니다.** 클레임으로 등록되고(R11.1) 미검증으로
 * 표시되며(R11.2) 발견으로 보고된다(R11.3). 자동 차단만 하지 않는다 —
 * 모순 후보를 다루는 방식과 같은 규율이다.
 */
export const ADVISORY_KINDS: readonly ClaimKind[] = ['superlative-bare', 'duration'];

export function isAdvisory(kind: ClaimKind): boolean {
  return ADVISORY_KINDS.includes(kind);
}

export type ClaimKind =
  | 'quantity'
  | 'duration'
  | 'superlative'
  | 'superlative-bare'
  | 'medical'
  | 'comparative';
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
/**
 * 날짜를 같은 길이의 공백으로 가린다.
 *
 * `2026년 8월 3일` 이 기간 주장으로 잡혔다 — 점검 공지의 일시였다. 날짜는
 * 어떤 종류의 주장도 아니므로 패턴이 닿기 전에 지운다.
 *
 * **길이를 보존한다.** 클레임은 위치(`index`)를 들고 다니고 사람이 그것으로
 * 원문을 찾아간다. 길이가 바뀌면 그 위치가 어긋난다.
 */
export function maskDates(text: string): string {
  const DATE =
    /\d{4}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}-\d{2}-\d{2}/g;
  return text.replace(DATE, (m) => ' '.repeat(m.length));
}

export function extractClaims(text: string): Array<Omit<Claim, 'grade' | 'evidence'>> {
  const out: Array<Omit<Claim, 'grade' | 'evidence'>> = [];
  const scanned = maskDates(text);
  for (const { kind, re } of CLAIM_PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(scanned)) !== null) {
      out.push({ text: m[0], kind, index: m.index });
      if (m.index === rx.lastIndex) rx.lastIndex += 1;
    }
  }
  // 접두어 있는 최상급이 잡은 자리를 접두어 없는 패턴이 다시 잡는다 —
  // `업계 1위` 안에 `1위` 가 들어 있다. 같은 주장이 두 번 등록되고, 게다가
  // 한쪽은 차단이고 한쪽은 권고라 판정이 갈린다. 안쪽 것을 버린다.
  const prefixed = out.filter((c) => c.kind === 'superlative');
  const deduped = out.filter(
    (c) =>
      c.kind !== 'superlative-bare' ||
      !prefixed.some((p) => c.index >= p.index && c.index + c.text.length <= p.index + p.text.length),
  );

  return deduped.sort((a, b) => a.index - b.index);
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

/**
 * 근거 인용을 뽑는다 (R5.1).
 *
 * 형식을 강제하지 않고 흔한 두 형태를 받는다 — `[출처] …` 줄과 URL.
 * 하나도 없으면 빈 배열이다. **인용을 지어내지 않는다.**
 *
 * Studio 와 검증이 같은 규칙을 써야 한다. 예전에 클레임 패턴을 두 곳에 두었다가
 * 한쪽만 개선되는 일을 겪었다 — 인용도 같은 종류의 값이라 정본을 하나로 둔다.
 */
export function extractCitations(text: string): string[] {
  const cites = new Set<string>();
  for (const line of text.split('\n')) {
    const tagged = /^\s*\[(?:출처|근거|source|ref)\]\s*(.+)$/i.exec(line);
    if (tagged?.[1]) cites.add(tagged[1].trim());
  }
  for (const url of text.match(/https?:\/\/[^\s)\]]+/g) ?? []) cites.add(url);
  return [...cites];
}
