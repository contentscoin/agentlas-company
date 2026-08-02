/**
 * 발행 계약 (R6)
 *
 * **채널이 API 를 갖고 있는지는 오너가 신경 쓸 문제가 아니다 (R6.1).**
 * 쓰레드는 OAuth API 로, 네이버 블로그는 브라우저 조작으로 나가지만
 * 호출자가 보는 것은 같은 `PublishRequest` 하나다. 이 추상화가 새면 —
 * 예컨대 Hands 채널만 별도 필드를 요구하면 — 호출자가 채널마다 분기하게
 * 되고 R6.1 은 문서에만 남는다.
 *
 * 그래서 어댑터 인터페이스를 좁게 잡았다. 어댑터는 동사 하나를 받아
 * 증거를 돌려주거나 실패한다. 그 외의 협상 여지를 두지 않는다.
 */

import type { Channel, Verb } from '../verbs/types.js';

export interface PublishRequest {
  channel: Channel;
  verb: Verb;
  /**
   * 같은 요청을 두 번 보내도 한 번만 나간다 (R6.3).
   *
   * 호출자가 정한다. 자동 생성하면 재시도가 새 발행이 되어 멱등성의
   * 의미가 사라진다 — 네트워크가 끊겨 응답을 못 받은 호출자는 반드시
   * 재시도하고, 그때 같은 키를 보내야 중복이 막힌다.
   */
  idempotencyKey: string;
  /** 실제로 내보내지 않고 최종 페이로드만 돌려준다 (R6.4). */
  dryRun?: boolean;
  runId?: string;
  /** 신뢰등급 0 콘텐츠를 만졌는가 (R16.3). */
  tainted?: boolean;
}

/** 발행이 남긴 증거 (R6.2). URL 이거나 스크린샷이거나, 둘 다일 수 있다. */
export interface PublishEvidence {
  /** 게시물 URL. Hands 경로에서는 발행 후 주소창에서 읽는다. */
  url?: string;
  /** 저장된 스크린샷 경로 (R7.2). */
  screenshots: string[];
  /** 어댑터가 남긴 사람이 읽는 기록. */
  notes: string[];
}

export type PublishFailure =
  | 'duplicate'
  | 'daily-limit'
  | 'gate-denied'
  | 'tainted'
  | 'capability-off'
  | 'adapter-failed'
  /** 본문에서 비밀·PII 가 검출됐다 (R15.5). */
  | 'secret-detected'
  | 'not-configured';

export interface PublishResult {
  ok: boolean;
  channel: Channel;
  idempotencyKey: string;
  reason?: PublishFailure;
  detail?: string;
  evidence?: PublishEvidence;
  /** 드라이런이 돌려주는 최종 페이로드 (R6.4). */
  payload?: unknown;
  /** 실패 시 사람이 이어받을 목록 (R6.6). */
  checklist?: string[];
  /** 중복이었을 때 원래 발행의 증거. */
  original?: PublishEvidence;
}

/**
 * 채널 어댑터.
 *
 * `describe` 가 드라이런의 실체다. 실제로 내보내는 코드와 페이로드를 만드는
 * 코드가 갈라지면 드라이런이 거짓말을 하게 되므로, `publish` 도 같은
 * `describe` 결과를 써서 나간다.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  /** 'api' 는 OAuth API 경로, 'hands' 는 브라우저 조작 경로. */
  readonly path: 'api' | 'hands';
  /** 이 어댑터가 지금 실제로 나갈 수 있는가. 토큰·프로필이 없으면 거짓. */
  ready(): { ok: true } | { ok: false; reason: string; checklist: string[] };
  /** 최종 페이로드. 드라이런과 실제 발행이 같은 것을 쓴다. */
  describe(verb: Verb): unknown;
  publish(
    verb: Verb,
    ctx: { runId: string; evidenceDir: string },
  ): Promise<{ ok: true; evidence: PublishEvidence } | { ok: false; detail: string; checklist: string[] }>;
}

/** 채널별 일일 상한 (R6.5). */
export const DEFAULT_DAILY_LIMITS: Record<Channel, number> = {
  threads: 10,
  instagram: 5,
  youtube: 2,
  tiktok: 5,
  wordpress: 10,
  naver_blog: 5,
  naver_clip: 5,
  smartstore: 20,
  kakao_channel: 10,
};
