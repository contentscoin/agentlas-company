/**
 * 쓰레드 지표 — OAuth API 경로 (R11.6)
 *
 * 발행 어댑터와 같은 토큰을 쓰지만 별도 클래스다. 읽기만 되고 쓰기가 안 되는
 * 토큰이 있을 수 있고, 그때 발행이 막혔다고 지표까지 못 읽을 이유가 없다.
 *
 * 응답을 그대로 넘긴다. 집계 경계는 브로커가 집행한다 — 쓰레드 인사이트에는
 * PII 가 없지만, 그렇다고 여기만 경계를 건너뛰면 다음 채널에서 같은 판단을
 * 반복하게 된다.
 */

import type { Channel } from '../../verbs/types.js';
import type { MetricsAdapter, MetricsWindow } from '../types.js';
import { THREADS_TOKEN_ENV, THREADS_USER_ENV } from '../../publish/adapters/threads.js';

export interface ThreadsMetricsOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** 쓰레드 인사이트 응답을 지표 이름 → 값으로 바꾼다. */
export function foldInsights(body: unknown): Record<string, number> {
  const data = (body as { data?: Array<{ name?: unknown; values?: Array<{ value?: unknown }> }> })?.data;
  if (!Array.isArray(data)) return {};

  const NAME_MAP: Record<string, string> = {
    views: 'views',
    likes: 'likes',
    replies: 'replies',
    reposts: 'reposts',
  };

  const out: Record<string, number> = {};
  for (const metric of data) {
    const name = typeof metric.name === 'string' ? NAME_MAP[metric.name] : undefined;
    if (!name) continue;
    const value = metric.values?.[0]?.value;
    if (typeof value === 'number') out[name] = value;
  }
  return out;
}

export class ThreadsMetricsAdapter implements MetricsAdapter {
  readonly channel: Channel = 'threads';
  readonly path = 'api' as const;
  readonly metrics = ['views', 'likes', 'replies'] as const;

  private readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ThreadsMetricsOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://graph.threads.net/v1.0';
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  ready(): { ok: true } | { ok: false; reason: string; checklist: string[] } {
    if (!this.env[THREADS_TOKEN_ENV] || !this.env[THREADS_USER_ENV]) {
      return {
        ok: false,
        reason: '쓰레드 OAuth 토큰이 설정되지 않았다',
        checklist: [
          `${THREADS_TOKEN_ENV} 와 ${THREADS_USER_ENV} 를 설정하세요`,
          '설정 전까지 쓰레드 지표는 수동 확인입니다',
        ],
      };
    }
    return { ok: true };
  }

  async read(
    window: MetricsWindow,
  ): Promise<{ ok: true; raw: unknown; notes?: string[] } | { ok: false; detail: string; checklist: string[] }> {
    const token = this.env[THREADS_TOKEN_ENV] as string;
    const user = this.env[THREADS_USER_ENV] as string;
    const url =
      `${this.baseUrl}/${user}/threads_insights` +
      `?metric=${this.metrics.join(',')}&since=${window.from}&until=${window.to}`;

    try {
      const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          detail: `HTTP ${res.status} ${text.slice(0, 200)}`,
          checklist: ['쓰레드 인사이트를 앱에서 직접 확인하세요'],
        };
      }
      return { ok: true, raw: foldInsights(JSON.parse(text) as unknown) };
    } catch (err) {
      return {
        ok: false,
        detail: (err as Error).message,
        checklist: ['네트워크를 확인하고 다시 시도하세요'],
      };
    }
  }
}
