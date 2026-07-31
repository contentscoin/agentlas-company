/**
 * 동사 파서 — 구조적 경계 (R16.7)
 *
 * 이 파일이 인젝션 방어의 1차 통제다. 프롬프트 설득이 아니라
 * 타입 검사로 막는다.
 *
 * 규칙 넷:
 *   문자열 입력은 즉시 거부한다 — 자연어가 동사가 되는 경로를 없앤다
 *   알 수 없는 필드가 있으면 거부한다 — 밀수 통로를 없앤다
 *   모든 값을 스키마로 검증한다 — 길이, 형식, 허용목록
 *   링크는 도메인 허용목록을 통과해야 한다 — 인젝션이 심은 링크를 막는다
 *
 * 거부 이유를 모아서 돌려준다. 첫 오류에서 멈추면 호출자가
 * 고치고 다시 시도하는 왕복이 늘어난다.
 */

import {
  DEFAULT_VERB_POLICY,
  VERB_OPS,
  isChannel,
  type ParseResult,
  type Verb,
  type VerbPolicy,
} from './types.js';

const URL_RE = /https?:\/\/([^\s/?#]+)/gi;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const FIELDS: Record<string, readonly string[]> = {
  post_text: ['op', 'channel', 'body', 'schedule'],
  upload_media: ['op', 'channel', 'assetId', 'caption'],
  set_schedule: ['op', 'channel', 'postId', 'at'],
  read_metrics: ['op', 'channel', 'from', 'to'],
  reply_comment: ['op', 'channel', 'commentId', 'templateId'],
};

const REQUIRED: Record<string, readonly string[]> = {
  post_text: ['channel', 'body'],
  upload_media: ['channel', 'assetId', 'caption'],
  set_schedule: ['channel', 'postId', 'at'],
  read_metrics: ['channel', 'from', 'to'],
  reply_comment: ['channel', 'commentId', 'templateId'],
};

/** 본문에 실린 링크가 허용 도메인인지 검사한다. */
export function checkLinks(text: string, allowed: readonly string[]): string[] {
  const errors: string[] = [];
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const host = (m[1] ?? '').toLowerCase().replace(/^www\./, '');
    if (allowed.length === 0) {
      errors.push('링크가 허용되지 않았다 (allowedLinkDomains 비어 있음)');
      break;
    }
    const ok = allowed.some((d) => {
      const domain = d.toLowerCase().replace(/^www\./, '');
      return host === domain || host.endsWith(`.${domain}`);
    });
    if (!ok) errors.push(`허용되지 않은 링크 도메인: ${host}`);
  }
  return errors;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 동사를 파싱한다.
 *
 * 입력이 문자열이면 무조건 거부한다. 좌석이 자연어로 실행을 요청하는 것을
 * 여기서 끊는다 — 이 한 줄이 R16.7 의 실질이다.
 */
export function parseVerb(input: unknown, policy: VerbPolicy = DEFAULT_VERB_POLICY): ParseResult {
  if (typeof input === 'string') {
    return {
      ok: false,
      errors: ['자연어 문자열은 동사가 아니다. 타입 지정된 동사 객체만 받는다'],
    };
  }
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['동사는 객체여야 한다'] };
  }

  const op = str(input['op']);
  if (op === null || !(VERB_OPS as readonly string[]).includes(op)) {
    return {
      ok: false,
      errors: [`알 수 없는 동사: ${String(input['op'])}. 허용 동사는 ${VERB_OPS.join(', ')}`],
    };
  }

  const errors: string[] = [];

  // 밀수 통로 차단 — 스키마에 없는 필드는 거부한다.
  const allowedFields = FIELDS[op]!;
  for (const key of Object.keys(input)) {
    if (!allowedFields.includes(key)) errors.push(`알 수 없는 필드: ${key}`);
  }

  for (const key of REQUIRED[op]!) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      errors.push(`필수 필드 누락: ${key}`);
    }
  }

  if (!isChannel(input['channel'])) {
    errors.push(`알 수 없는 채널: ${String(input['channel'])}`);
  }

  if (op === 'post_text') {
    const body = str(input['body']);
    if (body === null) errors.push('body 는 문자열이어야 한다');
    else {
      if (body.length > policy.maxBodyLength) {
        errors.push(`body 가 최대 길이 ${policy.maxBodyLength} 를 넘었다`);
      }
      errors.push(...checkLinks(body, policy.allowedLinkDomains));
    }
    const schedule = input['schedule'];
    if (schedule !== undefined && (str(schedule) === null || !ISO_RE.test(str(schedule)!))) {
      errors.push('schedule 은 ISO8601 이어야 한다');
    }
  }

  if (op === 'upload_media') {
    const caption = str(input['caption']);
    if (caption === null) errors.push('caption 은 문자열이어야 한다');
    else {
      if (caption.length > policy.maxCaptionLength) {
        errors.push(`caption 이 최대 길이 ${policy.maxCaptionLength} 를 넘었다`);
      }
      errors.push(...checkLinks(caption, policy.allowedLinkDomains));
    }
    if (str(input['assetId']) === null) errors.push('assetId 는 문자열이어야 한다');
  }

  if (op === 'set_schedule') {
    const at = str(input['at']);
    if (at === null || !ISO_RE.test(at)) errors.push('at 은 ISO8601 이어야 한다');
    if (str(input['postId']) === null) errors.push('postId 는 문자열이어야 한다');
  }

  if (op === 'read_metrics') {
    for (const key of ['from', 'to'] as const) {
      const v = str(input[key]);
      if (v === null || !ISO_RE.test(v)) errors.push(`${key} 은 ISO8601 이어야 한다`);
    }
    const from = str(input['from']);
    const to = str(input['to']);
    if (from && to && ISO_RE.test(from) && ISO_RE.test(to) && Date.parse(from) > Date.parse(to)) {
      errors.push('from 이 to 보다 늦다');
    }
  }

  if (op === 'reply_comment') {
    const templateId = str(input['templateId']);
    if (templateId === null) {
      errors.push('templateId 는 문자열이어야 한다');
    } else if (!policy.allowedTemplateIds.includes(templateId)) {
      errors.push(
        `허용되지 않은 템플릿: ${templateId}. 댓글 응답은 등록된 템플릿만 쓴다 (자유 텍스트 응답 경로 없음)`,
      );
    }
    if (str(input['commentId']) === null) errors.push('commentId 는 문자열이어야 한다');
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, verb: input as unknown as Verb };
}

/**
 * 좌석 출력에서 동사를 뽑는다.
 *
 * 좌석은 텍스트를 낸다. 그 텍스트에서 JSON 블록을 찾아 파싱하되,
 * **텍스트 자체는 절대 실행 경로로 넘기지 않는다.**
 * 파싱에 실패하면 실패다 — "의도를 짐작해서" 실행하는 경로를 만들지 않는다.
 */
export function extractVerb(seatOutput: string, policy: VerbPolicy = DEFAULT_VERB_POLICY): ParseResult {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(seatOutput);
  const candidate = fenced?.[1] ?? seatOutput;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch {
    return {
      ok: false,
      errors: ['좌석 출력에서 동사 JSON 을 찾지 못했다. 의도를 짐작해 실행하지 않는다'],
    };
  }
  return parseVerb(parsed, policy);
}
