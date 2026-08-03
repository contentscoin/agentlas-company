/**
 * 발행 브로커 (R6)
 *
 * 순서가 설계다.
 *
 *   1. 오염 확인        신뢰등급 0 에서 나온 발행은 거부      R16.5
 *   2. 비밀·PII 린트    검출되면 차단, 값은 보고하지 않는다     R15.5, R15.6
 *   3. 브랜드 게이트    위반이면 발행 단계로 넘기지 않는다      R5.5
 *   4. 멱등성 확인      이미 나갔으면 원래 증거를 돌려준다     R6.3
 *   5. 일일 상한 확인   넘으면 정지하고 오너에게 알린다        R6.5
 *   6. 드라이런이면 페이로드만 돌려주고 끝                     R6.4
 *   7. 어댑터 준비 확인 토큰·프로필이 없으면 여기서 멈춘다
 *   8. 게이트          승인 없이 나가지 않는다                R4
 *   9. 발행 + 증거 기록                                       R6.2
 *
 * **린트가 멱등성보다 앞이다.** 뒤에 두면 이미 나간 발행의 재확인이 린트에
 * 걸려 duplicate 로 답하지 못한다. 그리고 린트는 드라이런에도 적용한다 —
 * 드라이런 출력은 로그와 원장으로 흘러가므로 "실제로 안 나가니까 괜찮다" 가
 * 성립하지 않는다.
 *
 * **멱등성이 상한보다 앞이다.** 뒤에 두면 이미 나간 발행의 재시도가 상한에
 * 걸려 실패하고, 호출자는 "발행됐나 안 됐나" 를 알 수 없게 된다. 이미 나간
 * 것을 다시 확인하는 일은 상한과 무관해야 한다.
 *
 * **드라이런이 게이트보다 앞이다.** 페이로드를 보려고 승인 카드를 만들면
 * 카드가 쌓이고, 오너는 실제로 나갈 것과 구경만 할 것을 구분하지 못한다.
 * 드라이런은 아무것도 바꾸지 않으므로 승인이 필요 없다.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger } from '../ledger/ledger.js';
import type { ApprovalService } from '../policy/approval.js';
import type { PolicyConfig } from '../policy/types.js';
import { resolveGate } from '../policy/gate.js';
import type { Channel } from '../verbs/types.js';
import { describeFinding, lint } from '../zones/lint.js';
import { PublishStore } from './ledgerstore.js';
import {
  DEFAULT_DAILY_LIMITS,
  type ChannelAdapter,
  type PublishEvidence,
  type PublishFailure,
  type PublishRequest,
  type PublishResult,
} from './types.js';

export interface PublishBrokerOptions {
  ledger: Ledger;
  approvals: ApprovalService;
  policy: PolicyConfig;
  store: PublishStore;
  adapters: ChannelAdapter[];
  evidenceRoot: string;
  dailyLimits?: Partial<Record<Channel, number>>;
  /** 상한 도달을 오너에게 알린다 (R6.5). */
  notify?: (message: string) => void;
}

/** 동사에서 밖으로 나갈 텍스트를 모은다. 린트 대상이다 (R15.5). */
export function outboundText(verb: { op: string } & Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['body', 'caption']) {
    const value = verb[key];
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

/** 발행 페이로드의 digest. 승인은 이 값에 묶인다 (R4.6). */
export function publishDigest(req: PublishRequest): string {
  return createHash('sha256')
    .update('agentlas:publish:v1\0')
    .update(JSON.stringify({ channel: req.channel, verb: req.verb, key: req.idempotencyKey }))
    .digest('hex');
}

export class PublishBroker {
  private readonly opts: PublishBrokerOptions;
  private readonly byChannel: Map<Channel, ChannelAdapter>;

  constructor(opts: PublishBrokerOptions) {
    this.opts = opts;
    this.byChannel = new Map(opts.adapters.map((a) => [a.channel, a]));
  }

  private limit(channel: Channel): number {
    return this.opts.dailyLimits?.[channel] ?? DEFAULT_DAILY_LIMITS[channel];
  }

  private fail(
    req: PublishRequest,
    reason: PublishFailure,
    detail: string,
    checklist: string[],
  ): PublishResult {
    this.opts.ledger.append({
      actor: { kind: 'system', id: 'publish' },
      kind: 'deny',
      ...(req.tainted ? { tainted: true } : {}),
      ...(req.runId ? { runId: req.runId } : {}),
      payloadDigest: publishDigest(req),
      summary: `${req.channel} 발행 거부 — ${reason}: ${detail}`,
    });
    return {
      ok: false,
      channel: req.channel,
      idempotencyKey: req.idempotencyKey,
      reason,
      detail,
      checklist,
    };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const adapter = this.byChannel.get(req.channel);
    if (!adapter) {
      return this.fail(req, 'not-configured', `${req.channel} 어댑터가 없다`, [
        `${req.channel} 채널을 수동으로 발행하세요`,
      ]);
    }

    // 1 — 오염. Hands 와 같은 이유로 승인보다 앞이다.
    if (req.tainted === true) {
      return this.fail(req, 'tainted', '신뢰등급 0 콘텐츠에서 나온 발행은 내보내지 않는다', [
        '초안의 출처를 확인하고 오염되지 않은 원문으로 다시 만드세요',
      ]);
    }

    // 2 — 비밀·PII 린트 (R15.5). 오염 검사 바로 뒤다.
    //
    // 드라이런에도 적용한다. 드라이런 출력은 로그·원장·오너 폰으로 흘러가므로
    // "실제로 안 나가니까 괜찮다" 가 성립하지 않는다.
    const scan = lint(outboundText(req.verb as never), req.channel);
    if (!scan.ok) {
      // 검출 내역은 종류와 위치만 남긴다 (R15.6). 값은 어디에도 싣지 않는다.
      return this.fail(
        req,
        'secret-detected',
        scan.findings.map(describeFinding).join('; '),
        [
          '본문에서 아래 항목을 제거한 뒤 다시 시도하세요:',
          ...scan.findings.map(describeFinding),
          '검출된 값은 보고에 담기지 않습니다 — 원문을 직접 확인하세요',
        ],
      );
    }

    // 3 — 브랜드 게이트 (R5.5). 위반은 발행 단계로 넘어가지 않는다.
    //
    // undefined 도 막는다. 검사를 건너뛴 것을 통과로 읽으면 검사가 없는
    // 것과 같다 — 호출자가 책임을 지려면 명시적으로 true 를 넘겨야 한다.
    if (req.brandPass !== true) {
      const notes = req.brandNotes ?? [];
      return this.fail(
        req,
        'brand-fail',
        req.brandPass === false
          ? `브랜드 위반 ${notes.length}건`
          : '브랜드 대조를 하지 않았다',
        req.brandPass === false
          ? ['아래 브랜드 위반을 고친 뒤 다시 시도하세요:', ...notes]
          : [
              '브랜드 팩 대조를 거치지 않은 본문입니다',
              'company studio 로 산출하거나, 브랜드 책임을 지고 brandPass 를 명시하세요',
            ],
      );
    }

    // 4 — 결정론적 검증 (R11.5). BLOCK 은 발행으로 넘어가지 않는다.
    //
    // FAIL 은 막지 않는다. DoD 미달은 사람이 판단할 여지가 있고, 그것까지
    // 막으면 기준을 낮추려고 검증을 끄게 된다 — 끈 검증은 없는 검증이다.
    if (req.assurance === 'BLOCK') {
      return this.fail(
        req,
        'assurance-block',
        `검증 BLOCK — ${(req.assuranceNotes ?? []).length}건`,
        ['아래를 고친 뒤 다시 시도하세요:', ...(req.assuranceNotes ?? [])],
      );
    }

    // 5 — 멱등성. 이미 나갔으면 그 증거를 그대로 돌려준다 (R6.3).
    const already = this.opts.store.find(req.idempotencyKey);
    if (already) {
      this.opts.ledger.append({
        actor: { kind: 'system', id: 'publish' },
        kind: 'publish',
        ...(req.runId ? { runId: req.runId } : {}),
        payloadDigest: publishDigest(req),
        summary: `${req.channel} 중복 요청 — 이미 발행됨, 다시 내보내지 않는다`,
        evidence: already.url ? [already.url] : already.screenshots,
      });
      return {
        ok: true,
        channel: req.channel,
        idempotencyKey: req.idempotencyKey,
        reason: 'duplicate',
        original: already,
        evidence: already,
      };
    }

    // 6 — 일일 상한 (R6.5).
    const used = this.opts.store.countToday(req.channel);
    const cap = this.limit(req.channel);
    if (used >= cap) {
      this.opts.notify?.(`${req.channel} 일일 발행 상한 도달 (${used}/${cap}) — 추가 발행을 정지했다`);
      return this.fail(req, 'daily-limit', `오늘 ${used}/${cap} 건 — 상한 도달`, [
        `${req.channel} 은 오늘 상한(${cap})에 도달했습니다. 내일 다시 시도하거나 상한을 조정하세요`,
      ]);
    }

    const ready = adapter.ready();

    // 7 — 드라이런은 여기서 끝. 아무것도 바꾸지 않으므로 승인이 필요 없다 (R6.4).
    //
    // **준비 검사보다 앞이다.** 드라이런의 쓸모가 가장 큰 순간이 자격증명을
    // 아직 넣지 않았을 때다 — "무엇이 나갈 것인가" 는 토큰 없이도 답할 수
    // 있고, `describe()` 는 그렇게 만들어져 있다. 준비되지 않은 사실은
    // 숨기지 않고 페이로드와 **함께** 보고한다. Task 15 실측에서 레시피
    // 드라이런이 토큰 부재로 막히는 것을 보고 순서를 바꿨다.
    if (req.dryRun === true) {
      return {
        ok: true,
        channel: req.channel,
        idempotencyKey: req.idempotencyKey,
        payload: adapter.describe(req.verb),
        ...(ready.ok
          ? {}
          : { detail: `드라이런 — 다만 지금은 발행할 수 없다: ${ready.reason}`, checklist: ready.checklist }),
      };
    }

    // 8 — 어댑터가 실제로 나갈 수 있는가.
    if (!ready.ok) {
      return this.fail(req, 'not-configured', ready.reason, ready.checklist);
    }

    // 9 — 게이트. 발행은 비가역이므로 최소 L3 이다.
    const digest = publishDigest(req);
    const decision = resolveGate(
      { policy: this.opts.policy, approvals: this.opts.approvals, ledger: this.opts.ledger },
      {
        action: 'irreversible',
        payloadDigest: digest,
        summary: `${req.channel} 발행 (${req.verb.op})`,
        ...(req.runId ? { runId: req.runId } : {}),
      },
    );
    if (!decision.allowed) {
      return this.fail(req, 'gate-denied', decision.reason, [
        `승인 후 다시 시도하세요 — company approvals approve ${decision.approvalId ?? ''} --digest ${digest}`,
      ]);
    }

    // 10 — 발행.
    const runId = req.runId ?? req.idempotencyKey;
    const evidenceDir = join(this.opts.evidenceRoot, runId);
    mkdirSync(evidenceDir, { recursive: true });

    const result = await adapter.publish(req.verb, { runId, evidenceDir });
    if (!result.ok) {
      return this.fail(req, 'adapter-failed', result.detail, result.checklist);
    }

    // 증거를 남기기 **전에** 멱등성 기록을 넣는다. 순서가 반대면, 원장에는
    // 발행이 남았는데 멱등성 기록이 없어 재시도가 두 번째 발행을 낸다.
    this.opts.store.record(req.idempotencyKey, req.channel, result.evidence);
    this.opts.ledger.append({
      actor: { kind: 'system', id: 'publish' },
      kind: 'publish',
      level: 'L3',
      runId,
      payloadDigest: digest,
      summary: `${req.channel} 발행 완료${result.evidence.url ? ` — ${result.evidence.url}` : ''}`,
      evidence: [
        ...(result.evidence.url ? [result.evidence.url] : []),
        ...result.evidence.screenshots,
      ],
    });

    return {
      ok: true,
      channel: req.channel,
      idempotencyKey: req.idempotencyKey,
      evidence: result.evidence,
    };
  }
}

export type { PublishEvidence };
