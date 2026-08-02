/**
 * 결정론적 검사와 DoD 판정 (R11.3, R11.4, R11.5)
 *
 * 세 가지를 찾는다 — 출처 없는 수치, 클레임 간 모순, 증거 공백.
 *
 * **결정론적이라는 말이 핵심이다.** 좌석에게 "이거 괜찮아?" 라고 묻지 않는다.
 * 같은 입력에 같은 답이 나와야 게이트가 되고, 좌석 판단은 매번 흔들린다.
 * Critic 좌석(R3)은 그 흔들림을 활용하는 자리이고 여기는 아니다.
 *
 * `BLOCK` 은 발행으로 넘어가지 않는다 (R11.5). 브랜드 게이트(R5.5)와 같은
 * 위치에 서고, 둘 다 통과해야 나간다.
 */

import type { Claim } from './claims.js';

export type FindingKind = 'unsourced-number' | 'contradiction' | 'evidence-gap';

export interface AssuranceFinding {
  kind: FindingKind;
  detail: string;
  index: number;
}

export type Verdict = 'PASS' | 'FAIL' | 'BLOCK';

export interface AssuranceResult {
  /** BLOCK 이면 발행 금지 (R11.5). FAIL 은 DoD 미달이고 사람이 판단한다. */
  verdict: Verdict;
  findings: AssuranceFinding[];
  claims: Claim[];
  /** SEI 를 돌렸는가. 못 돌렸으면 그 사실을 남긴다 — 건너뛴 것을 숨기지 않는다. */
  seiRan: boolean;
  seiNote?: string;
}

/**
 * 서로 모순되는 수치를 찾는다.
 *
 * 같은 단위의 수치가 여러 개인데 값이 다르면 모순 후보다. 문맥을 모르므로
 * **후보일 뿐**이고, 그래서 `BLOCK` 이 아니라 발견으로 보고한다 — 진짜
 * 모순인지는 사람이 본다. 자동 판정을 밀어붙이면 정상 문서가 막힌다.
 */
export function findContradictions(claims: readonly Claim[]): AssuranceFinding[] {
  const byUnit = new Map<string, Claim[]>();
  for (const c of claims) {
    if (c.kind !== 'quantity') continue;
    const unit = /[가-힣%]+$/.exec(c.text.trim())?.[0] ?? '';
    if (unit === '') continue;
    byUnit.set(unit, [...(byUnit.get(unit) ?? []), c]);
  }

  const findings: AssuranceFinding[] = [];
  for (const [unit, group] of byUnit) {
    const values = new Set(group.map((c) => c.text.replace(/[^\d.]/g, '')));
    if (values.size > 1 && group.length > 1) {
      findings.push({
        kind: 'contradiction',
        detail: `같은 단위(${unit})에 다른 값이 있다: ${[...values].join(', ')} — 문맥이 다르면 정상이다`,
        index: group[0]?.index ?? -1,
      });
    }
  }
  return findings;
}

export interface DodCriteria {
  /** 미검증 클레임을 몇 개까지 허용하는가. 0 이면 하나도 없어야 한다. */
  maxUnverified: number;
  /** 본문 최소 길이. 빈 산출물이 통과하는 것을 막는다. */
  minLength: number;
  /** 반드시 있어야 하는 인용 수. */
  minCitations: number;
}

export const DEFAULT_DOD: DodCriteria = {
  // 기본은 0 이다. 미검증 주장을 하나라도 달고 나가지 않는다 — 느슨하게
  // 하고 싶으면 오너가 명시적으로 올린다.
  maxUnverified: 0,
  minLength: 50,
  minCitations: 1,
};

export interface AssureInput {
  text: string;
  claims: Claim[];
  citations: readonly string[];
  dod?: DodCriteria;
  /** SEI 를 돌린 결과. 없으면 못 돌린 것이다. */
  sei?: { ran: true; risk: boolean; note?: string } | { ran: false; note: string };
}

/**
 * 판정한다 (R11.3, R11.4).
 *
 * `BLOCK` 과 `FAIL` 을 구분한다.
 *   BLOCK  나가면 안 되는 것 — 출처 없는 수치, SEI 위험 신호
 *   FAIL   DoD 미달 — 인용 부족, 너무 짧음. 사람이 판단할 여지가 있다
 *
 * 구분하는 이유는 오너가 할 일이 다르기 때문이다. BLOCK 은 본문을 고쳐야
 * 하고, FAIL 은 기준을 낮추거나 보강하거나 둘 중 하나다.
 */
export function assure(input: AssureInput): AssuranceResult {
  const dod = input.dod ?? DEFAULT_DOD;
  const findings: AssuranceFinding[] = [];

  // 출처 없는 수치 (R11.3).
  const unverified = input.claims.filter((c) => c.grade === 'unverified');
  for (const c of unverified) {
    findings.push({
      kind: 'unsourced-number',
      detail: `근거 없는 주장 "${c.text}" — 팩 인용도 실측도 아니다`,
      index: c.index,
    });
  }

  findings.push(...findContradictions(input.claims));

  // 증거 공백 — 주장은 있는데 인용이 하나도 없다.
  if (input.claims.length > 0 && input.citations.length === 0) {
    findings.push({
      kind: 'evidence-gap',
      detail: `주장 ${input.claims.length}건이 있는데 인용이 하나도 없다`,
      index: -1,
    });
  }

  const seiRan = input.sei?.ran === true;
  const seiRisk = input.sei?.ran === true && input.sei.risk;

  let verdict: Verdict = 'PASS';
  if (unverified.length > dod.maxUnverified || seiRisk) {
    verdict = 'BLOCK';
  } else if (
    input.text.length < dod.minLength ||
    input.citations.length < dod.minCitations
  ) {
    verdict = 'FAIL';
  }

  return {
    verdict,
    findings,
    claims: input.claims,
    seiRan,
    ...(input.sei?.note ? { seiNote: input.sei.note } : {}),
  };
}

export function describeFinding(f: AssuranceFinding): string {
  return f.index >= 0 ? `${f.detail} (위치 ${f.index})` : f.detail;
}
