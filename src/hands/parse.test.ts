import { describe, expect, it } from 'vitest';
import { checkUrl, parseHandsPlan, parseHandsStep } from './parse.js';
import { HANDS_OPS, HANDS_TOOL, type HandsPolicy } from './types.js';

const POLICY: HandsPolicy = {
  allowedDomains: ['blog.naver.com', 'example.com'],
  maxTextLength: 100,
  maxWaitMs: 5_000,
};

describe('parseHandsStep — 자연어 차단 (R16.7)', () => {
  it('문자열 입력은 거부한다', () => {
    const r = parseHandsStep('네이버 블로그에 글 올려줘', POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('문자열');
  });

  it('배열도 객체가 아니므로 거부한다', () => {
    expect(parseHandsStep([{ op: 'snapshot' }], POLICY).ok).toBe(false);
  });

  it('알 수 없는 동사는 거부한다', () => {
    const r = parseHandsStep({ op: 'evaluate', code: 'fetch("//evil")' }, POLICY);
    expect(r.ok).toBe(false);
  });

  it('임의 코드 실행 도구는 매핑 표에 존재하지 않는다', () => {
    expect(Object.values(HANDS_TOOL)).not.toContain('browser_evaluate');
    expect(Object.values(HANDS_TOOL).some((t) => t.includes('cookie'))).toBe(false);
    expect(Object.values(HANDS_TOOL).some((t) => t.includes('localstorage'))).toBe(false);
  });

  it('알 수 없는 필드는 밀수 통로이므로 거부한다', () => {
    const r = parseHandsStep({ op: 'snapshot', script: 'alert(1)' }, POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('알 수 없는 필드');
  });
});

describe('checkUrl — 도메인 허용목록 (R7.4)', () => {
  it('허용 도메인은 통과한다', () => {
    expect(checkUrl('https://blog.naver.com/x', POLICY.allowedDomains)).toEqual([]);
  });

  it('서브도메인은 통과한다', () => {
    expect(checkUrl('https://m.blog.naver.com/x', POLICY.allowedDomains)).toEqual([]);
  });

  it('쿼리에 허용 도메인을 심은 URL 은 막는다', () => {
    const errors = checkUrl('https://evil.com/?next=blog.naver.com', POLICY.allowedDomains);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('evil.com');
  });

  it('접두가 비슷한 도메인은 막는다', () => {
    expect(checkUrl('https://notblog.naver.com.evil.com/', POLICY.allowedDomains).length).toBeGreaterThan(0);
  });

  it('허용목록이 비어 있으면 이동 자체를 금지한다', () => {
    expect(checkUrl('https://blog.naver.com/x', []).length).toBeGreaterThan(0);
  });

  it('http/https 가 아닌 스킴은 막는다', () => {
    expect(checkUrl('file:///etc/passwd', POLICY.allowedDomains).length).toBeGreaterThan(0);
    expect(checkUrl('javascript:alert(1)', POLICY.allowedDomains).length).toBeGreaterThan(0);
  });
});

describe('parseHandsStep — 스키마 검증', () => {
  it('navigate 는 허용 도메인이면 통과한다', () => {
    const r = parseHandsStep({ op: 'navigate', url: 'https://blog.naver.com/write' }, POLICY);
    expect(r.ok).toBe(true);
  });

  it('click 은 ref 가 필수다', () => {
    const r = parseHandsStep({ op: 'click', element: '게시 버튼' }, POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('ref');
  });

  it('type 의 본문 길이 상한을 적용한다', () => {
    const r = parseHandsStep(
      { op: 'type', element: '본문', ref: 'e1', text: 'x'.repeat(101) },
      POLICY,
    );
    expect(r.ok).toBe(false);
  });

  it('wait_for 는 text 나 timeMs 중 하나가 필요하다', () => {
    expect(parseHandsStep({ op: 'wait_for' }, POLICY).ok).toBe(false);
    expect(parseHandsStep({ op: 'wait_for', text: '완료' }, POLICY).ok).toBe(true);
  });

  it('wait_for 시간 상한을 적용한다', () => {
    expect(parseHandsStep({ op: 'wait_for', timeMs: 5_001 }, POLICY).ok).toBe(false);
  });

  it('인자 없는 동사는 그대로 통과한다', () => {
    expect(parseHandsStep({ op: 'snapshot' }, POLICY).ok).toBe(true);
    expect(parseHandsStep({ op: 'screenshot' }, POLICY).ok).toBe(true);
  });

  it('모든 동사가 도구 매핑을 갖는다', () => {
    for (const op of HANDS_OPS) expect(HANDS_TOOL[op]).toBeTruthy();
  });
});

describe('parseHandsPlan', () => {
  it('하나라도 실패하면 전체가 실패한다 — 절반만 실행하지 않는다', () => {
    const r = parseHandsPlan(
      [
        { op: 'navigate', url: 'https://blog.naver.com/x' },
        { op: 'navigate', url: 'https://evil.com/x' },
      ],
      POLICY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('[1]');
  });

  it('빈 계획과 과도한 길이를 거부한다', () => {
    expect(parseHandsPlan([], POLICY).ok).toBe(false);
    expect(parseHandsPlan(new Array(65).fill({ op: 'snapshot' }), POLICY).ok).toBe(false);
  });

  it('유효한 계획은 순서를 보존한다', () => {
    const r = parseHandsPlan(
      [{ op: 'navigate', url: 'https://example.com' }, { op: 'snapshot' }],
      POLICY,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps.map((s) => s.op)).toEqual(['navigate', 'snapshot']);
  });
});
