/**
 * 비밀·PII 린트 (R15.5, R15.6)
 *
 * 밖으로 나가는 것과 밖에서 들어오는 것을 검사한다. 발행 본문에 API 키가
 * 섞여 나가는 사고와, 수집한 페이지에 실린 개인정보가 원장에 박히는 사고를
 * 같은 검사로 막는다.
 *
 * **검출된 값을 절대 출력하지 않는다 (R15.6).** 종류와 위치만 보고한다.
 * 이 규칙이 없으면 린트 보고서 자체가 유출 경로가 된다 — CI 로그에,
 * 원장에, 오너 폰 알림에 그대로 실려 나간다. `aggregate.ts` 가 막힌 필드의
 * 이름만 돌려주는 것과 같은 이유다.
 *
 * 그래서 `Finding` 에는 값을 담을 필드가 아예 없다. 담을 곳이 없으면
 * 실수로 담을 수도 없다.
 */

export type SecretKind =
  | 'anthropic-key'
  | 'openai-key'
  | 'google-key'
  | 'github-token'
  | 'aws-access-key'
  | 'slack-token'
  | 'private-key'
  | 'jwt'
  | 'bearer-token'
  | 'generic-secret-assignment';

export type PiiKind =
  | 'kr-rrn'
  | 'kr-phone'
  | 'email'
  | 'credit-card'
  | 'kr-account-number';

export type FindingKind = SecretKind | PiiKind;

/**
 * 검출 하나.
 *
 * 값을 담는 필드가 없다. `line`/`column` 으로 사람이 원문을 찾아갈 수 있고,
 * 그 원문은 이미 그 사람이 접근 권한을 가진 자리에 있다.
 */
export interface Finding {
  kind: FindingKind;
  category: 'secret' | 'pii';
  line: number;
  column: number;
  /** 검출 길이. 값이 아니라 크기만 알린다. */
  length: number;
  /** 어디서 왔는지. 파일이면 경로, 발행이면 채널. */
  source?: string;
}

interface Rule {
  kind: FindingKind;
  category: 'secret' | 'pii';
  re: RegExp;
  /** 추가 검증. 형식만으로는 오탐이 많은 것들(카드번호, 주민번호)에 쓴다. */
  confirm?: (match: string) => boolean;
}

/** Luhn 검사. 형식만 맞는 숫자열을 카드번호로 부르지 않는다. */
export function luhn(digits: string): boolean {
  const nums = digits.replace(/\D/g, '');
  if (nums.length < 13 || nums.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let d = nums.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * 주민등록번호 형식 검사.
 *
 * 체크섬까지 보지 않는다 — 2020년 10월 이후 발급분은 뒤 6자리가 임의라
 * 체크섬이 맞지 않는다. 형식과 생년월일 유효성만 본다. 오탐을 조금
 * 감수하더라도 실제 주민번호를 놓치지 않는 쪽을 택한다.
 */
export function looksLikeRrn(text: string): boolean {
  const m = /^(\d{2})(\d{2})(\d{2})-?([1-8])\d{6}$/.exec(text.replace(/\s/g, ''));
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

const RULES: Rule[] = [
  // ── 비밀 ────────────────────────────────────────────────────────
  { kind: 'anthropic-key', category: 'secret', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', category: 'secret', re: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { kind: 'google-key', category: 'secret', re: /AIza[A-Za-z0-9_-]{35}/g },
  { kind: 'github-token', category: 'secret', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'aws-access-key', category: 'secret', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'slack-token', category: 'secret', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'private-key',
    category: 'secret',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { kind: 'jwt', category: 'secret', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer-token', category: 'secret', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  {
    // `password = "..."` 류. 값 자체는 패턴이 없으므로 대입 형태로 잡는다.
    kind: 'generic-secret-assignment',
    category: 'secret',
    re: /\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  },

  // ── PII ────────────────────────────────────────────────────────
  {
    kind: 'kr-rrn',
    category: 'pii',
    re: /\b\d{6}-?[1-8]\d{6}\b/g,
    confirm: looksLikeRrn,
  },
  { kind: 'kr-phone', category: 'pii', re: /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g },
  { kind: 'email', category: 'pii', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: 'credit-card',
    category: 'pii',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    confirm: luhn,
  },
  // 계좌번호는 은행마다 형식이 달라 자릿수 묶음으로만 잡는다.
  { kind: 'kr-account-number', category: 'pii', re: /\b\d{3,6}-\d{2,6}-\d{2,8}\b/g },
];

export interface LintResult {
  ok: boolean;
  findings: Finding[];
  /** 종류별 건수. 보고용 요약이며 값은 담지 않는다. */
  summary: Record<string, number>;
}

/** 오프셋을 줄·칸으로 바꾼다. 사람이 원문을 찾아갈 수 있게. */
function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}

/**
 * 텍스트를 검사한다.
 *
 * 같은 자리에서 여러 규칙이 걸리면 전부 보고한다 — 계좌번호처럼 보이는
 * 주민번호를 하나로 접으면 무엇을 지워야 하는지 흐려진다.
 */
export function lint(text: string, source?: string): LintResult {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (rule.confirm && !rule.confirm(value)) continue;
      const { line, column } = locate(text, m.index);
      findings.push({
        kind: rule.kind,
        category: rule.category,
        line,
        column,
        length: value.length,
        ...(source ? { source } : {}),
      });
      // 길이 0 매치로 무한루프에 빠지지 않게 한다.
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  const summary: Record<string, number> = {};
  for (const f of findings) summary[f.kind] = (summary[f.kind] ?? 0) + 1;
  return { ok: findings.length === 0, findings, summary };
}

/** 사람이 읽는 한 줄. 값은 들어가지 않는다 (R15.6). */
export function describeFinding(f: Finding): string {
  const where = f.source ? `${f.source}:${f.line}:${f.column}` : `${f.line}:${f.column}`;
  return `${f.category === 'secret' ? '비밀' : 'PII'} ${f.kind} — ${where} (${f.length}자)`;
}
