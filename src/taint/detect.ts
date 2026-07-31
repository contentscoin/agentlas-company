/**
 * 결정론적 지시문 탐지 (R16.6)
 *
 * 이것은 **탐지이고 통제가 아니다.** 패턴 목록으로 인젝션을 막을 수 없다는
 * 것을 전제로 만들었다. 목적은 둘이다.
 *
 *   신호를 원장에 남겨 사후에 무슨 일이 있었는지 재구성할 수 있게 한다
 *   신호가 있으면 정책 등급을 올려 사람을 한 명 끼워넣는다
 *
 * LLM 을 쓰지 않는 이유는 결정론이다. 같은 입력에 같은 판정이 나와야
 * 원장의 증거가 의미를 갖고, 검증 게이트가 재현 가능해진다.
 *
 * 한국어와 영어를 함께 본다. 운영 채널이 국내 플랫폼이라
 * 영어 패턴만 보면 절반을 놓친다.
 */

import type { InjectionSignal, InjectionSignalKind } from './types.js';

interface Rule {
  kind: InjectionSignalKind;
  pattern: RegExp;
}

/**
 * 규칙은 의도적으로 보수적이다. 오탐이 많으면 등급 승격이 상시화되어
 * 오너가 승인 카드를 읽지 않고 누르게 된다 — 그게 이 시스템의 실질적 붕괴다.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'instruction-override',
    pattern:
      /(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instruction|prompt|rule|direction)/i,
  },
  {
    kind: 'instruction-override',
    pattern: /(이전|위의|앞의)\s*(모든\s*)?(지시|명령|규칙|프롬프트)(사항)?\s*(은|는|을|를)?\s*(무시|잊)/,
  },
  {
    kind: 'role-hijack',
    pattern: /you\s+are\s+(now|no\s+longer)\s+/i,
  },
  {
    kind: 'role-hijack',
    pattern: /(당신|너)(은|는)\s*(이제|지금부터)\s*/,
  },
  {
    kind: 'system-delimiter',
    pattern: /(<\|im_(start|end)\|>|<\/?system>|^\s*system\s*:|```\s*system)/im,
  },
  {
    kind: 'credential-target',
    pattern: /(비밀번호|패스워드|복구\s*코드|인증\s*코드|2fa|otp)\s*(를|을|은|는)?\s*(변경|바꾸|알려|전송|보내)/i,
  },
  {
    kind: 'payout-target',
    pattern: /(정산\s*계좌|출금\s*계좌|결제\s*수단|payout\s+account|bank\s+account)\s*(를|을)?\s*(변경|바꾸|수정|change|update)/i,
  },
  {
    kind: 'command-execution',
    pattern: /\b(rm\s+-rf|curl\s+http|wget\s+http|powershell\s+-enc|Invoke-WebRequest|npm\s+i\s+http)/i,
  },
  {
    kind: 'command-execution',
    pattern: /(다음|아래)\s*(명령|커맨드|스크립트)\s*(를|을)?\s*(실행|수행)/,
  },
  {
    kind: 'exfiltration',
    pattern: /(send|post|upload|forward)\s+(this|the|all)?\s*(data|content|file|credential|token|key)s?\s+to\s+http/i,
  },
  {
    kind: 'exfiltration',
    pattern: /(이|해당)?\s*(내용|파일|자료|토큰|키)\s*(를|을)\s*(https?:\/\/|외부로)/,
  },
  {
    kind: 'urgency-pressure',
    pattern: /(승인\s*없이|묻지\s*말고|확인\s*없이|바로\s*실행)/,
  },
  {
    kind: 'urgency-pressure',
    pattern: /(without\s+(asking|approval|confirmation)|do\s+not\s+ask)/i,
  },
];

/**
 * 텍스트에서 지시문 형태 신호를 찾는다.
 *
 * 매칭된 문장을 반환하지 않는다. 신호 종류와 위치만 남긴다 —
 * 원장에 공격자가 심은 문장을 그대로 실어 나르면 그 원장을 읽는
 * 다음 에이전트가 같은 공격에 노출된다.
 */
export function detectInjection(text: string): InjectionSignal[] {
  const signals: InjectionSignal[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      signals.push({ kind: rule.kind, at: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return signals.sort((a, b) => a.at - b.at);
}

/** 신호 종류별 건수. 원장 요약과 화면 표시에 쓴다. */
export function summarizeSignals(signals: InjectionSignal[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of signals) out[s.kind] = (out[s.kind] ?? 0) + 1;
  return out;
}

/** 탐지된 규칙 수. 게이트가 임계값을 정할 때 쓴다. */
export const RULE_COUNT = RULES.length;
