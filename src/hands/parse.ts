/**
 * Hands 단계 파서 (R7.3, R7.4, R16.7)
 *
 * `src/verbs/parse.ts` 와 같은 네 가지 규칙을 따른다.
 *   문자열 입력은 즉시 거부한다 — 자연어가 조작이 되는 경로를 없앤다
 *   알 수 없는 필드가 있으면 거부한다 — 밀수 통로를 없앤다
 *   모든 값을 스키마로 검증한다
 *   URL 은 도메인 허용목록을 통과해야 한다
 *
 * 두 파서를 합치지 않은 이유는 검증 대상이 다르기 때문이다. 채널 동사는
 * 본문 안에 **섞여 있는** 링크를 찾아야 하고, Hands 는 URL **필드 전체**가
 * 대상이다. 하나로 묶으면 둘 중 하나가 헐거워진다.
 */

import {
  DEFAULT_HANDS_POLICY,
  HANDS_OPS,
  isHandsOp,
  type HandsParseResult,
  type HandsPolicy,
  type HandsStep,
} from './types.js';

const FIELDS: Record<string, readonly string[]> = {
  navigate: ['op', 'url'],
  click: ['op', 'element', 'ref'],
  type: ['op', 'element', 'ref', 'text', 'submit'],
  press_key: ['op', 'key'],
  select_option: ['op', 'element', 'ref', 'values'],
  wait_for: ['op', 'text', 'timeMs'],
  snapshot: ['op'],
  screenshot: ['op'],
};

const REQUIRED: Record<string, readonly string[]> = {
  navigate: ['url'],
  click: ['element', 'ref'],
  type: ['element', 'ref', 'text'],
  press_key: ['key'],
  select_option: ['element', 'ref', 'values'],
  wait_for: [],
  snapshot: [],
  screenshot: [],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * URL 이 허용 도메인인지 검사한다.
 *
 * 문자열 포함(`includes`)이 아니라 파싱된 호스트로 비교한다.
 * `https://evil.com/?x=blog.naver.com` 같은 것이 통과하면 안 된다.
 */
export function checkUrl(raw: string, allowed: readonly string[]): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [`URL 형식이 아니다: ${raw.slice(0, 80)}`];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return [`허용되지 않은 프로토콜: ${url.protocol}`];
  }
  if (allowed.length === 0) return ['이동이 허용되지 않았다 (allowedDomains 비어 있음)'];

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const ok = allowed.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
  return ok ? [] : [`허용되지 않은 도메인: ${host}`];
}

/** 단계 하나를 파싱한다. 실패 사유는 모아서 돌려준다. */
export function parseHandsStep(
  input: unknown,
  policy: HandsPolicy = DEFAULT_HANDS_POLICY,
): HandsParseResult {
  // 자연어가 조작이 되는 경로를 여기서 끊는다. 이 한 줄이 R16.7 의 실질이다.
  if (typeof input === 'string') {
    return { ok: false, errors: ['문자열 입력은 조작으로 해석하지 않는다'] };
  }
  if (!isPlainObject(input)) return { ok: false, errors: ['객체가 아니다'] };

  const op = input.op;
  if (!isHandsOp(op)) {
    return { ok: false, errors: [`알 수 없는 동사: ${String(op)} (허용: ${HANDS_OPS.join(', ')})`] };
  }

  const errors: string[] = [];
  const allowed = FIELDS[op] ?? [];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push(`알 수 없는 필드: ${key}`);
  }
  for (const key of REQUIRED[op] ?? []) {
    if (input[key] === undefined) errors.push(`필수 필드 누락: ${key}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const text = (key: string, max: number): string | null => {
    const value = input[key];
    if (typeof value !== 'string') {
      errors.push(`${key} 는 문자열이어야 한다`);
      return null;
    }
    if (value.length === 0) errors.push(`${key} 가 비어 있다`);
    if (value.length > max) errors.push(`${key} 가 너무 길다 (${value.length} > ${max})`);
    return value;
  };

  switch (op) {
    case 'navigate': {
      const url = text('url', 2048);
      if (url) errors.push(...checkUrl(url, policy.allowedDomains));
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, step: { op, url: url as string } };
    }
    case 'click': {
      const element = text('element', 200);
      const ref = text('ref', 200);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, step: { op, element: element as string, ref: ref as string } };
    }
    case 'type': {
      const element = text('element', 200);
      const ref = text('ref', 200);
      const value = text('text', policy.maxTextLength);
      const submit = input.submit;
      if (submit !== undefined && typeof submit !== 'boolean') errors.push('submit 은 불리언이어야 한다');
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        step: {
          op,
          element: element as string,
          ref: ref as string,
          text: value as string,
          ...(typeof submit === 'boolean' ? { submit } : {}),
        },
      };
    }
    case 'press_key': {
      const key = text('key', 32);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, step: { op, key: key as string } };
    }
    case 'select_option': {
      const element = text('element', 200);
      const ref = text('ref', 200);
      const values = input.values;
      if (!Array.isArray(values) || values.length === 0) {
        errors.push('values 는 비어 있지 않은 배열이어야 한다');
      } else if (!values.every((v) => typeof v === 'string' && v.length <= 200)) {
        errors.push('values 항목은 200자 이하 문자열이어야 한다');
      }
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        step: { op, element: element as string, ref: ref as string, values: values as string[] },
      };
    }
    case 'wait_for': {
      const value = input.text;
      const timeMs = input.timeMs;
      if (value !== undefined && typeof value !== 'string') errors.push('text 는 문자열이어야 한다');
      if (timeMs !== undefined) {
        if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs <= 0) {
          errors.push('timeMs 는 양수여야 한다');
        } else if (timeMs > policy.maxWaitMs) {
          errors.push(`timeMs 가 상한을 넘는다 (${timeMs} > ${policy.maxWaitMs})`);
        }
      }
      if (value === undefined && timeMs === undefined) {
        errors.push('wait_for 는 text 또는 timeMs 중 하나가 필요하다');
      }
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        step: {
          op,
          ...(typeof value === 'string' ? { text: value } : {}),
          ...(typeof timeMs === 'number' ? { timeMs } : {}),
        },
      };
    }
    case 'snapshot':
    case 'screenshot':
      return { ok: true, step: { op } };
  }
}

/** 단계 목록을 파싱한다. 하나라도 실패하면 전체가 실패다 — 절반만 실행하지 않는다. */
export function parseHandsPlan(
  input: unknown,
  policy: HandsPolicy = DEFAULT_HANDS_POLICY,
): { ok: true; steps: HandsStep[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(input)) return { ok: false, errors: ['단계 목록은 배열이어야 한다'] };
  if (input.length === 0) return { ok: false, errors: ['단계가 비어 있다'] };
  if (input.length > 64) return { ok: false, errors: [`단계가 너무 많다 (${input.length} > 64)`] };

  const steps: HandsStep[] = [];
  const errors: string[] = [];
  input.forEach((raw, i) => {
    const parsed = parseHandsStep(raw, policy);
    if (parsed.ok) steps.push(parsed.step);
    else errors.push(...parsed.errors.map((e) => `[${i}] ${e}`));
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}
