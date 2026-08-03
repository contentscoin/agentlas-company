/**
 * 쓰레드 — OAuth API 경로 (R6.1)
 *
 * 네이버 블로그 어댑터와 **같은 인터페이스**를 구현한다. 이 파일과
 * `naver-blog.ts` 를 나란히 놓았을 때 호출자 쪽 코드가 달라질 이유가
 * 없어야 R6.1 이 충족된 것이다.
 *
 * **토큰이 없으면 `ready()` 가 거짓이다.** 없는 채로 호출해 401 을 받고
 * 실패로 처리해도 되지만, 그러면 "설정이 안 됐다" 와 "발행이 실패했다" 가
 * 같은 모양이 된다. 오너가 할 일이 다르므로 구분한다.
 *
 * 토큰은 환경변수에서 읽는다. `*_API_KEY` 금지 규칙(R1.1)은 **좌석 벤더**
 * 키를 겨냥한 것이고 — 좌석은 OAuth 구독으로만 돌아야 한다 — 채널 발행
 * 토큰은 그 규칙의 대상이 아니다. 값은 원장에 남기지 않는다.
 */

import type { Channel, Verb } from '../../verbs/types.js';
import type { ChannelAdapter, PublishEvidence } from '../types.js';

export const THREADS_TOKEN_ENV = 'AGENTLAS_THREADS_TOKEN';
export const THREADS_USER_ENV = 'AGENTLAS_THREADS_USER_ID';

export interface ThreadsOptions {
  /** 테스트가 로컬 서버를 물릴 수 있게 열어 둔다. */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export class ThreadsAdapter implements ChannelAdapter {
  readonly channel: Channel = 'threads';
  readonly path = 'api' as const;

  private readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ThreadsOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://graph.threads.net/v1.0';
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  ready(): { ok: true } | { ok: false; reason: string; checklist: string[] } {
    const token = this.env[THREADS_TOKEN_ENV];
    const user = this.env[THREADS_USER_ENV];
    if (!token || !user) {
      return {
        ok: false,
        reason: '쓰레드 OAuth 토큰이 설정되지 않았다',
        checklist: [
          `${THREADS_TOKEN_ENV} 와 ${THREADS_USER_ENV} 를 설정하세요`,
          '설정 전까지 쓰레드 발행은 수동입니다',
        ],
      };
    }
    return { ok: true };
  }

  describe(verb: Verb): unknown {
    if (verb.op !== 'post_text') return { unsupported: verb.op };
    return {
      channel: this.channel,
      path: this.path,
      endpoint: `${this.baseUrl}/${this.env[THREADS_USER_ENV] ?? '<user>'}/threads`,
      method: 'POST',
      // 토큰은 페이로드에 싣지 않는다. 드라이런 출력이 그대로 로그에 남는다.
      body: { media_type: 'TEXT', text: verb.body },
    };
  }

  /**
   * 쓰레드는 2단계다 — 컨테이너를 만들고, 그것을 발행한다.
   *
   * 1단계만 성공하고 2단계가 실패하면 게시물은 나가지 않았지만 컨테이너는
   * 남는다. 그 사실을 체크리스트에 적는다 — 사람이 이어받을 때 컨테이너를
   * 다시 만들지 말아야 한다.
   */
  async publish(
    verb: Verb,
    _ctx: { runId: string; evidenceDir: string },
  ): Promise<
    { ok: true; evidence: PublishEvidence } | { ok: false; detail: string; checklist: string[] }
  > {
    if (verb.op !== 'post_text') {
      return { ok: false, detail: `${verb.op} 은 지원하지 않는다`, checklist: [`${verb.op} 를 수동으로 처리하세요`] };
    }
    const token = this.env[THREADS_TOKEN_ENV] as string;
    const user = this.env[THREADS_USER_ENV] as string;

    const create = await this.post(`${this.baseUrl}/${user}/threads`, token, {
      media_type: 'TEXT',
      text: verb.body,
    });
    if (!create.ok) {
      return {
        ok: false,
        detail: `컨테이너 생성 실패 — ${create.detail}`,
        checklist: ['쓰레드에서 직접 게시하세요', `본문 ${verb.body.length}자가 준비되어 있습니다`],
      };
    }

    const containerId = String((create.body as { id?: unknown }).id ?? '');
    if (!containerId) {
      return {
        ok: false,
        detail: '컨테이너 id 를 받지 못했다',
        checklist: ['쓰레드에서 직접 게시하세요'],
      };
    }

    const publish = await this.post(`${this.baseUrl}/${user}/threads_publish`, token, {
      creation_id: containerId,
    });
    if (!publish.ok) {
      return {
        ok: false,
        detail: `발행 실패 — ${publish.detail}`,
        checklist: [
          `컨테이너 ${containerId} 는 이미 만들어졌습니다 — 다시 만들지 마세요`,
          '쓰레드 앱에서 해당 초안을 발행하거나 컨테이너를 폐기하세요',
        ],
      };
    }

    const postId = String((publish.body as { id?: unknown }).id ?? containerId);
    return {
      ok: true,
      evidence: {
        url: `https://www.threads.net/@me/post/${postId}`,
        screenshots: [],
        notes: [`컨테이너 ${containerId}`, `게시물 ${postId}`],
      },
    };
  }

  private async post(
    url: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> {
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
      try {
        return { ok: true, body: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, detail: `JSON 이 아닌 응답: ${text.slice(0, 120)}` };
      }
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
