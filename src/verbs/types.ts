/**
 * 허용 동사 (R7.3, R7.4, R16.7)
 *
 * Hands 와 채널 어댑터는 열린 인터페이스가 아니라 **닫힌 목록**이다.
 * 좌석이 "브라우저에서 이걸 해줘" 라고 말할 수 있는 함수는 존재하지 않는다.
 *
 * `reply_comment` 가 자유 텍스트가 아니라 `templateId` 만 받는 것이 핵심이다.
 * 댓글 응답에 자유 텍스트를 허용하면 인젝션이 곧바로 외부 발화가 된다 —
 * 공격자가 심은 문장을 우리 계정이 그대로 말하게 되는 것이다.
 */

export const CHANNELS = [
  'threads',
  'instagram',
  'youtube',
  'tiktok',
  'wordpress',
  'naver_blog',
  'naver_clip',
  'smartstore',
  'kakao_channel',
] as const;

export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export const VERB_OPS = ['post_text', 'upload_media', 'set_schedule', 'read_metrics', 'reply_comment'] as const;

export type VerbOp = (typeof VERB_OPS)[number];

export interface PostText {
  op: 'post_text';
  channel: Channel;
  body: string;
  schedule?: string;
}

export interface UploadMedia {
  op: 'upload_media';
  channel: Channel;
  assetId: string;
  caption: string;
}

export interface SetSchedule {
  op: 'set_schedule';
  channel: Channel;
  postId: string;
  at: string;
}

export interface ReadMetrics {
  op: 'read_metrics';
  channel: Channel;
  from: string;
  to: string;
}

export interface ReplyComment {
  op: 'reply_comment';
  channel: Channel;
  commentId: string;
  /** 템플릿 식별자만 받는다. 자유 텍스트 응답 경로는 없다. */
  templateId: string;
}

export type Verb = PostText | UploadMedia | SetSchedule | ReadMetrics | ReplyComment;

export type ParseResult = { ok: true; verb: Verb } | { ok: false; errors: string[] };

export interface VerbPolicy {
  /** 본문에 실을 수 있는 링크 도메인. 비어 있으면 링크 자체를 금지한다. */
  allowedLinkDomains: string[];
  /** 허용된 응답 템플릿 식별자. */
  allowedTemplateIds: string[];
  /** 채널별 본문 최대 길이. */
  maxBodyLength: number;
  maxCaptionLength: number;
}

export const DEFAULT_VERB_POLICY: VerbPolicy = {
  allowedLinkDomains: [],
  allowedTemplateIds: [],
  maxBodyLength: 5000,
  maxCaptionLength: 2200,
};
