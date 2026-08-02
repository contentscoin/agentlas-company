import { describe, expect, it } from 'vitest';
import { describeFinding, lint, looksLikeRrn, luhn } from './lint.js';

describe('검출 값을 절대 출력하지 않는다 (R15.6)', () => {
  const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';

  it('결과 객체 어디에도 값이 없다', () => {
    const result = lint(`token: ${SECRET}`);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('AAAABBBB');
  });

  it('사람이 읽는 문구에도 값이 없다', () => {
    const result = lint(`token: ${SECRET}`);
    const text = result.findings.map(describeFinding).join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('anthropic-key');
  });

  it('PII 값도 나오지 않는다', () => {
    const result = lint('연락처 010-1234-5678, 이메일 hong@example.com');
    const serialized = JSON.stringify(result) + result.findings.map(describeFinding).join('\n');
    expect(serialized).not.toContain('010-1234-5678');
    expect(serialized).not.toContain('hong@example.com');
  });

  it('Finding 에는 값을 담을 필드 자체가 없다', () => {
    const [first] = lint('sk-ant-api03-XXXXXXXXXXXXXXXXXXXX').findings;
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['category', 'column', 'kind', 'length', 'line'].sort(),
    );
  });
});

describe('비밀 검출', () => {
  it.each([
    ['anthropic-key', 'sk-ant-api03-AAAABBBBCCCCDDDD1234'],
    ['openai-key', 'sk-proj-AAAABBBBCCCCDDDDEEEEFFFF1234'],
    ['google-key', `AIza${'A'.repeat(35)}`],
    ['github-token', `ghp_${'a'.repeat(36)}`],
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack-token', 'xoxb-123456789012-abcdefghij'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['jwt', 'eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK'],
  ])('%s 를 잡는다', (kind, sample) => {
    const result = lint(sample);
    expect(result.findings.map((f) => f.kind)).toContain(kind);
  });

  it('대입 형태의 비밀을 잡는다', () => {
    const result = lint('password = "hunter2hunter2"');
    expect(result.findings.some((f) => f.kind === 'generic-secret-assignment')).toBe(true);
  });

  it('평범한 문장은 통과한다', () => {
    expect(lint('오늘 블로그에 신제품 소개를 올렸습니다. 반응이 좋네요.').ok).toBe(true);
  });

  it('anthropic 키를 openai 키로 중복 보고하지 않는다', () => {
    const kinds = lint('sk-ant-api03-AAAABBBBCCCCDDDD1234').findings.map((f) => f.kind);
    expect(kinds).toContain('anthropic-key');
    expect(kinds).not.toContain('openai-key');
  });
});

describe('PII 검출', () => {
  it('주민등록번호를 잡는다', () => {
    expect(lint('900101-1234567').findings.some((f) => f.kind === 'kr-rrn')).toBe(true);
  });

  it('생년월일이 불가능하면 주민번호로 보지 않는다', () => {
    // 13월, 32일 — 형식은 맞지만 날짜가 아니다.
    expect(looksLikeRrn('901301-1234567')).toBe(false);
    expect(looksLikeRrn('900132-1234567')).toBe(false);
  });

  it('2020년 이후 발급분처럼 체크섬이 안 맞아도 잡는다', () => {
    // 체크섬까지 검사하면 이런 실제 주민번호를 놓친다.
    expect(looksLikeRrn('990101-3000000')).toBe(true);
  });

  it('휴대폰 번호를 형식 셋 다 잡는다', () => {
    for (const phone of ['010-1234-5678', '01012345678', '010 1234 5678']) {
      expect(lint(phone).findings.some((f) => f.kind === 'kr-phone'), phone).toBe(true);
    }
  });

  it('카드번호는 Luhn 을 통과할 때만 잡는다', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(lint('4111 1111 1111 1111').findings.some((f) => f.kind === 'credit-card')).toBe(true);
    // 형식만 맞는 숫자열은 카드가 아니다.
    expect(lint('1234567890123456').findings.some((f) => f.kind === 'credit-card')).toBe(false);
  });

  it('이메일을 잡는다', () => {
    expect(lint('문의: help@agentlas.io').findings.some((f) => f.kind === 'email')).toBe(true);
  });
});

describe('위치 보고', () => {
  it('줄과 칸을 알려준다 — 사람이 원문을 찾아갈 수 있게', () => {
    const text = ['첫 줄', '둘째 줄', 'key = sk-ant-api03-AAAABBBBCCCCDDDD1234'].join('\n');
    const found = lint(text).findings.find((f) => f.kind === 'anthropic-key');
    expect(found?.line).toBe(3);
    expect(found?.column).toBeGreaterThan(1);
  });

  it('출처를 함께 남긴다', () => {
    const found = lint('sk-ant-api03-AAAABBBBCCCCDDDD1234', 'naver_blog').findings[0];
    expect(found?.source).toBe('naver_blog');
    expect(describeFinding(found!)).toContain('naver_blog');
  });

  it('요약은 종류별 건수만 담는다', () => {
    const result = lint('a@b.com 과 c@d.com');
    expect(result.summary.email).toBe(2);
    expect(JSON.stringify(result.summary)).not.toContain('a@b.com');
  });
});
