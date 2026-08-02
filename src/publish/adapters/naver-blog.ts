/**
 * 네이버 블로그 — Hands 경로 (R6.1)
 *
 * 공개 API 가 없어서 브라우저를 직접 조작한다. 호출자는 그것을 알 필요가
 * 없다 — 쓰레드 어댑터와 같은 인터페이스를 구현한다.
 *
 * **선택자를 상수로 박지 않는다.** 네이버가 화면을 바꾸면 박아 둔 선택자는
 * 조용히 다른 것을 누른다. 대신 `snapshot` 으로 접근성 트리를 받아 거기서
 * 요소를 **찾고**, 못 찾으면 멈춘다 (R7.5). 느리지만 조용한 오발행보다 낫다.
 *
 * 발행 버튼을 누르는 순간은 desktop 승인 게이트가 한 번 더 잡는다 — 런처가
 * "발행" 텍스트를 보고 게이팅하기 때문이다. 그것이 정상 경로다.
 */

import type { Channel, Verb } from '../../verbs/types.js';
import type { HandsExecutor } from '../../hands/executor.js';
import type { HandsStep } from '../../hands/types.js';
import type { ChannelAdapter, PublishEvidence } from '../types.js';

/** 스냅샷 텍스트에서 현재 URL 을 읽는다. 발행 결과 주소가 증거다 (R6.2). */
export function findUrl(snapshot: string): string | null {
  const m = /^-?\s*Page URL:\s*(\S+)/m.exec(snapshot);
  return m?.[1] ?? null;
}

export interface NaverBlogOptions {
  hands: HandsExecutor;
  /** 글쓰기 화면 주소. 테스트가 로컬 페이지를 물릴 수 있게 열어 둔다. */
  writeUrl?: string;
  allowedDomains?: string[];
}

export class NaverBlogAdapter implements ChannelAdapter {
  readonly channel: Channel = 'naver_blog';
  readonly path = 'hands' as const;

  private readonly hands: HandsExecutor;
  private readonly writeUrl: string;

  constructor(opts: NaverBlogOptions) {
    this.hands = opts.hands;
    this.writeUrl = opts.writeUrl ?? 'https://blog.naver.com/GoBlogWrite.naver';
  }

  ready(): { ok: true } | { ok: false; reason: string; checklist: string[] } {
    // Hands 표면 점검은 실행기가 한다. 여기서 미리 흉내 내면 두 곳이
    // 어긋날 수 있다 — Task 10 에서 Chrome 목록이 어긋났던 것과 같은 실수다.
    return { ok: true };
  }

  describe(verb: Verb): unknown {
    if (verb.op !== 'post_text') return { unsupported: verb.op };
    return {
      channel: this.channel,
      path: this.path,
      url: this.writeUrl,
      bodyLength: verb.body.length,
      bodyPreview: verb.body.slice(0, 80),
      steps: ['navigate', 'snapshot', 'type(제목)', 'type(본문)', 'click(발행)', 'screenshot'],
    };
  }

  async publish(
    verb: Verb,
    ctx: { runId: string; evidenceDir: string },
  ): Promise<
    { ok: true; evidence: PublishEvidence } | { ok: false; detail: string; checklist: string[] }
  > {
    if (verb.op !== 'post_text') {
      return { ok: false, detail: `${verb.op} 은 지원하지 않는다`, checklist: [`${verb.op} 를 수동으로 처리하세요`] };
    }

    // 계획 하나, 세션 하나. `ref` 는 세션 안에서만 유효하므로 정찰과 조작을
    // 나누면 두 번째 세션에서 그 ref 가 없다 — 실제 브라우저가 "Ref not found"
    // 로 알려줬다. 아직 모르는 요소는 `@find:` 로 적고 실행기가 채운다.
    const plan: HandsStep[] = [
      { op: 'navigate', url: this.writeUrl },
      { op: 'snapshot' },
      { op: 'type', element: '본문', ref: '@find:textbox|본문', text: verb.body },
      { op: 'click', element: '발행', ref: '@find:button.*(발행|게시)' },
      { op: 'snapshot' },
      { op: 'screenshot' },
    ];

    const run = await this.hands.run({
      steps: plan,
      gateAllowed: true,
      runId: ctx.runId,
      evidenceDir: ctx.evidenceDir,
    });

    if (!run.ok) {
      // 실패한 단계의 원문을 그대로 올린다. 처음엔 사유 코드만 올렸는데,
      // 도구 인자 오류가 났을 때 "step-failed" 한 줄만 남아 무엇이 틀렸는지
      // 알 수 없었다 — 진단을 삼키면 안 된다.
      const failed = run.steps.find((step) => !step.ok);
      const why = failed?.reason ?? run.detail ?? '';
      return {
        ok: false,
        detail: `발행이 중단됐다 — ${run.reason}${why ? `: ${why}` : ''}`,
        checklist: [
          ...(run.checklist ?? ['네이버 블로그에서 직접 발행하세요']),
          `본문 ${verb.body.length}자가 준비되어 있습니다`,
        ],
      };
    }

    // 마지막 스냅샷의 주소가 발행 결과다 (R6.2).
    const snapshots = run.steps.filter((step) => step.op === 'snapshot');
    const after = snapshots[snapshots.length - 1]?.text ?? '';
    const url = findUrl(after);
    return {
      ok: true,
      evidence: {
        ...(url ? { url } : {}),
        screenshots: run.screenshots ?? [],
        notes: [`본문 ${verb.body.length}자 입력`, '발행 버튼 클릭'],
      },
    };
  }
}
