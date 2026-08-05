/**
 * 회의 엔진 (R3)
 *
 * 좌석(2~4)이 임원(6+)보다 적으므로 실시간 난상토론은 불가능하다.
 * 2라운드 턴제가 그 제약 안에서 의견 다양성을 지키는 방법이다.
 *
 *   1라운드  각자 독립 의견. 서로의 발언을 보지 못한다 (R3.1)
 *   2라운드  다른 임원의 1라운드 **전문**을 받고 반론 (R3.2)
 *   비평     Critic 이 다른 벤더 좌석에서 판정 (R3.4)
 *   집계     CEO 가 마감 블록 생성 (R3.3)
 *   정규화   companyctl decision 으로 파싱해 원장에 적재 (R3.6)
 *
 * 비용을 설계에 반영했다. 좌석 호출 1회가 codex 19.4k 토큰·claude 5~9초다.
 * 임원 4명 2라운드면 8회 + Critic + CEO = 10회다. 라운드를 늘리지 않는다.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestPayload, type Ledger } from '../ledger/ledger.js';
import { runShell } from '../proc/index.js';
import type { SeatBroker } from '../seats/broker.js';
import type { Vendor } from '../seats/spec.js';
import { CEO, CRITIC, personaById, type Persona, type PersonaId } from './personas.js';
import { agendaKey, failuresFile, FailureStore, WAR_ROOM_THRESHOLD } from './failures.js';
import {
  isCriticalDissent,
  parseCloseBlock,
  parseVerdict,
  renderCloseBlock,
  validateCloseBlock,
  type CloseBlock,
  type CriticVerdict,
} from './protocol.js';

export interface Turn {
  persona: PersonaId;
  seat: string;
  text: string;
  ms: number;
}

export type MeetingStatus = 'closed' | 'board-gate' | 'war-room' | 'failed';

/**
 * War Room 이 왜 열렸는가 (R3.7).
 *
 *   critic-block     Critic 이 BLOCK 을 냈다
 *   repeat-failure   동일 과제가 문턱 횟수만큼 연속 실패했다
 *
 * 오너가 볼 화면과 할 일이 다르다. 하나로 뭉치면 "무엇이 막혔는지" 를
 * 원장에서 다시 파헤쳐야 한다.
 */
export type WarRoomCause = 'critic-block' | 'repeat-failure';

export interface MeetingResult {
  status: MeetingStatus;
  runId: string;
  round1: Turn[];
  round2: Turn[];
  verdict?: CriticVerdict;
  block?: CloseBlock;
  /** `companyctl decision` 정규화 결과. 도구가 없으면 undefined. */
  normalized?: unknown;
  /** 업스트림 정규화를 건너뛴 이유. */
  normalizationSkipped?: string;
  reason?: string;
  /** `status: 'war-room'` 일 때만 채워진다. */
  warRoomCause?: WarRoomCause;
  /** 이 안건의 연속 실패 횟수. 실패·소집 판단의 근거를 그대로 노출한다. */
  failureStreak?: number;
}

export interface Seating {
  bodyVendor: Vendor;
  criticForbids: Vendor[];
}

export interface MeetingOptions {
  ledger: Ledger;
  broker: SeatBroker;
  /** 실행 상태 디렉터리. 마감 블록 파일과 실패 카운터가 여기 쓰인다. */
  stateDir: string;
  /** `companyctl.py` 경로. 없으면 업스트림 정규화를 건너뛴다. */
  companyctl?: string;
  timeoutMs?: number;
  /**
   * 동일 과제 연속 실패 장부 (R3.7). 주지 않으면 `stateDir` 아래에 만든다.
   *
   * 회의는 매번 새 프로세스에서 돌므로 이 카운터는 반드시 프로세스 밖에
   * 있어야 한다 — 안에 두면 "2회 연속" 이 성립할 수가 없다.
   */
  failures?: FailureStore;
}

export interface MeetingRequest {
  agenda: string;
  /** CEO 와 Critic 을 제외한 참석자. */
  attendees: PersonaId[];
  runId: string;
}

export class MeetingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingError';
  }
}

/**
 * 좌석 배치를 정한다 (R3.4).
 *
 * 본체가 어느 벤더에 앉을지 먼저 고정하고 Critic 에게 그 벤더를 금지한다.
 * 검증된 벤더가 하나뿐이면 회의를 **시작하지 않는다** — 같은 모델이
 * 자기 산출물을 비평하는 것은 교차 비평이 아니다.
 */
export function planSeating(broker: SeatBroker): Seating {
  const usable = broker.status().filter((s) => s.verified && !s.exhausted);
  const vendors = [...new Set(usable.map((s) => s.vendor))];

  if (vendors.length === 0) throw new MeetingError('가용 좌석이 없다');
  if (vendors.length < 2) {
    throw new MeetingError(
      `검증된 벤더가 ${vendors.length}종(${vendors.join(', ')})뿐이다. ` +
        'Critic 이 본체와 같은 벤더가 되므로 회의를 시작하지 않는다 (R3.4)',
    );
  }
  return { bodyVendor: vendors[0]!, criticForbids: [vendors[0]!] };
}

export class Meeting {
  private readonly ledger: Ledger;
  private readonly broker: SeatBroker;
  private readonly stateDir: string;
  private readonly companyctl: string | undefined;
  private readonly timeoutMs: number;
  private readonly failures: FailureStore;

  constructor(opts: MeetingOptions) {
    this.ledger = opts.ledger;
    this.broker = opts.broker;
    this.stateDir = opts.stateDir;
    this.companyctl = opts.companyctl;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.failures = opts.failures ?? new FailureStore({ file: failuresFile(opts.stateDir) });
  }

  async run(req: MeetingRequest): Promise<MeetingResult> {
    const seating = planSeating(this.broker);

    this.ledger.append({
      actor: { kind: 'system', id: 'meeting' },
      kind: 'decision',
      runId: req.runId,
      summary: `회의 시작 — 참석 ${req.attendees.join(', ')}, 본체 벤더 ${seating.bodyVendor}, Critic 금지 ${seating.criticForbids.join(', ')}`,
    });

    // 1라운드 — 서로의 발언을 보지 못한다 (R3.1)
    const round1 = await this.collectRound(req, seating, [], 1);
    if (round1.length === 0) {
      return this.fail(req, '1라운드에서 발언을 받지 못했다');
    }

    // 2라운드 — 다른 임원의 1라운드 전문을 제공한다 (R3.2)
    const round2 = await this.collectRound(req, seating, round1, 2);

    // Critic — 다른 벤더 좌석에서 판정 (R3.4)
    const criticTurn = await this.askPersona(CRITIC, req, seating, buildCriticPrompt(req.agenda, round1, round2));
    if (criticTurn === null) return this.fail(req, 'Critic 판정을 받지 못했다');

    const verdict = parseVerdict(criticTurn.text);
    this.ledger.append({
      actor: { kind: 'agent', id: 'critic', seat: criticTurn.seat as never },
      kind: 'gate.verdict',
      runId: req.runId,
      summary: `Critic ${verdict.verdict} — blockers ${verdict.blockers.length}, watch ${verdict.watch.length}`,
    });

    // CEO 집계 (R3.3)
    const ceoTurn = await this.askPersona(
      CEO,
      req,
      seating,
      buildCeoPrompt(req.agenda, round1, round2, verdict, criticTurn.text),
    );
    if (ceoTurn === null) return this.fail(req, 'CEO 집계를 받지 못했다');

    const block = parseCloseBlock(ceoTurn.text);
    const problems = validateCloseBlock(block);
    if (problems.length > 0) {
      return this.fail(req, `마감 블록이 불완전하다: ${problems.join(' / ')}`);
    }

    // 업스트림 정규화 (R3.6)
    const norm = await this.normalize(block, req.runId);

    const base: MeetingResult = {
      status: 'closed',
      runId: req.runId,
      round1,
      round2,
      verdict,
      block,
      ...(norm.value !== undefined ? { normalized: norm.value } : {}),
      ...(norm.skipped !== undefined ? { normalizationSkipped: norm.skipped } : {}),
    };

    // 여기까지 왔으면 이 안건은 마감 블록까지 만들어졌다. 연속 실패가
    // 끊긴 것이고, 끊지 않으면 몇 달 전 실패 한 번이 다음 실패와 이어져
    // 엉뚱한 시점에 War Room 을 부른다.
    this.failures.clear(req.agenda);

    // R3.5 / R3.7 — BLOCK 은 다수결로 기각되지 않는다
    if (isCriticalDissent(verdict)) {
      this.ledger.append({
        actor: { kind: 'system', id: 'meeting' },
        kind: 'decision',
        runId: req.runId,
        level: 'L3',
        summary:
          `Critic BLOCK — War Room 소집. 다수결로 기각하지 않는다. ` +
          `오너만 종결할 수 있다. 사유 ${verdict.blockers.length}건`,
      });
      return {
        ...base,
        status: 'war-room',
        reason: verdict.blockers.join(' / '),
        warRoomCause: 'critic-block',
      };
    }

    this.ledger.append({
      actor: { kind: 'agent', id: 'ceo', seat: ceoTurn.seat as never },
      kind: 'decision',
      runId: req.runId,
      payloadDigest: digestPayload(renderCloseBlock(block)),
      summary: `회의 마감 — 결정 ${block.decisions.length}, 미결 ${block.open.length}, 액션 ${block.actions.length}`,
    });
    return base;
  }

  private async collectRound(
    req: MeetingRequest,
    seating: Seating,
    priorTurns: Turn[],
    round: 1 | 2,
  ): Promise<Turn[]> {
    const turns: Turn[] = [];
    for (const id of req.attendees) {
      const persona = personaById(id);
      const prompt =
        round === 1
          ? buildRound1Prompt(persona, req.agenda)
          : buildRound2Prompt(persona, req.agenda, priorTurns);
      const turn = await this.askPersona(persona, req, seating, prompt, round);
      if (turn !== null) turns.push(turn);
    }
    return turns;
  }

  private async askPersona(
    persona: Persona,
    req: MeetingRequest,
    seating: Seating,
    prompt: string,
    round?: 1 | 2,
  ): Promise<Turn | null> {
    const isCritic = persona.id === 'critic';
    const result = await this.broker.ask({
      persona: persona.id,
      prompt,
      runId: req.runId,
      timeoutMs: this.timeoutMs,
      ...(isCritic ? { forbidVendor: seating.criticForbids } : {}),
      ...(persona.preferSeat ? { preferSeat: persona.preferSeat } : {}),
    });

    if (!result.ok || result.text === undefined || result.seat === undefined) {
      this.ledger.append({
        actor: { kind: 'system', id: 'meeting' },
        kind: 'deny',
        runId: req.runId,
        summary: `${persona.id} 발언 실패${round ? ` (${round}라운드)` : ''} — ${result.reason ?? '알 수 없음'}`,
      });
      return null;
    }

    if (round !== undefined) {
      this.ledger.append({
        actor: { kind: 'agent', id: persona.id, seat: result.seat },
        kind: 'meeting.turn',
        runId: req.runId,
        payloadDigest: digestPayload(result.text),
        summary: `${round}라운드 ${persona.id} → ${result.seat} (${result.ranMs}ms)`,
      });
    }

    return { persona: persona.id, seat: result.seat, text: result.text, ms: result.ranMs };
  }

  /**
   * 업스트림 `companyctl decision` 으로 정규화한다 (R3.6).
   *
   * 도구가 없으면 건너뛰되 그 사실을 결과에 남긴다. 우리 파서 결과를
   * 업스트림 정규화라고 주장하지 않는다.
   *
   * 파일은 **BOM 없이** 쓴다. 실측에서 BOM 이 있으면 업스트림 파서가
   * 첫 줄(`DECISION:`)을 "섹션 밖" 으로 흘려 결정이 통째로 사라졌다.
   */
  private async normalize(
    block: CloseBlock,
    runId: string,
  ): Promise<{ value?: unknown; skipped?: string }> {
    if (this.companyctl === undefined) {
      return { skipped: 'companyctl 경로가 설정되지 않았다' };
    }

    const file = join(this.stateDir, `close-${runId}.txt`);
    writeFileSync(file, renderCloseBlock(block), 'utf8');

    const r = await runShell(`python "${this.companyctl}" decision --dry-run --file "${file}"`, {
      timeoutMs: 60_000,
    });
    if (r.code !== 0) {
      return { skipped: `companyctl 실패 (exit ${String(r.code)})` };
    }
    try {
      // stdout 에 경고가 섞일 수 있으므로 첫 `{` 부터 읽는다.
      const start = r.stdout.indexOf('{');
      if (start < 0) return { skipped: 'companyctl 출력에서 JSON 을 찾지 못했다' };
      return { value: JSON.parse(r.stdout.slice(start)) };
    } catch (err) {
      return { skipped: `companyctl 출력 파싱 실패: ${(err as Error).message}` };
    }
  }

  /**
   * 회의 실패를 기록하고, 문턱에 닿으면 War Room 으로 올린다 (R3.7 전반부).
   *
   * 문턱에 닿으면 연속을 끊는다. 그대로 두면 다음 실패 한 번에 즉시 다시
   * 소집되어, 한 번 어긋난 안건이 영구히 경보를 낸다.
   */
  private fail(req: MeetingRequest, reason: string): MeetingResult {
    const streak = this.failures.recordFailure(req.agenda, req.runId);

    this.ledger.append({
      actor: { kind: 'system', id: 'meeting' },
      kind: 'deny',
      runId: req.runId,
      // 안건 원문은 남기지 않는다 (R9). digest 앞자리로 같은 과제임을 대조한다.
      payloadDigest: agendaKey(req.agenda),
      summary: `회의 실패 (동일 과제 연속 ${streak.count}회) — ${reason}`,
    });

    if (streak.count < WAR_ROOM_THRESHOLD) {
      return { status: 'failed', runId: req.runId, round1: [], round2: [], reason, failureStreak: streak.count };
    }

    this.failures.clear(req.agenda);
    this.ledger.append({
      actor: { kind: 'system', id: 'meeting' },
      kind: 'decision',
      runId: req.runId,
      level: 'L3',
      payloadDigest: agendaKey(req.agenda),
      summary:
        `동일 과제 ${streak.count}회 연속 실패 — War Room 소집. 오너만 종결할 수 있다. ` +
        `직전 실패 ${streak.lastRunId}`,
    });
    return {
      status: 'war-room',
      runId: req.runId,
      round1: [],
      round2: [],
      // 사유만 담는다. 횟수는 `failureStreak` 이, 무엇 때문인지는
      // `warRoomCause` 가 말한다 — 한 문장에 세 번 되풀이하지 않는다.
      reason,
      warRoomCause: 'repeat-failure',
      failureStreak: streak.count,
    };
  }
}

function header(persona: Persona, agenda: string): string {
  return [persona.charter, '', `안건: ${agenda}`].join('\n');
}

export function buildRound1Prompt(persona: Persona, agenda: string): string {
  return [
    header(persona, agenda),
    '',
    '1라운드다. 다른 임원의 의견은 아직 없다. 너의 판단만 말하라.',
    '',
    '6줄 이내로, 결론부터. 근거 없는 수치를 쓰지 마라.',
  ].join('\n');
}

export function buildRound2Prompt(persona: Persona, agenda: string, round1: Turn[]): string {
  const others = round1.filter((t) => t.persona !== persona.id);
  const transcript = others.map((t) => `[${t.persona}]\n${t.text}`).join('\n\n');

  return [
    header(persona, agenda),
    '',
    '2라운드다. 아래는 다른 임원들의 1라운드 발언 전문이다.',
    '요약이 아니라 원문이므로 그대로 읽고 반론하라.',
    '',
    '───── 다른 임원 1라운드 ─────',
    transcript === '' ? '(다른 발언 없음)' : transcript,
    '───────────────────────',
    '',
    '동의하는 부분과 반대하는 부분을 각각 명시하라. 6줄 이내.',
    '동조를 위해 입장을 바꾸지 마라. 근거가 바뀌었을 때만 바꿔라.',
  ].join('\n');
}

export function buildCriticPrompt(agenda: string, round1: Turn[], round2: Turn[]): string {
  const all = [...round1, ...round2].map((t) => `[${t.persona}]\n${t.text}`).join('\n\n');
  return [CRITIC.charter, '', `안건: ${agenda}`, '', '───── 회의 전문 ─────', all, '─────────────────'].join('\n');
}

export function buildCeoPrompt(
  agenda: string,
  round1: Turn[],
  round2: Turn[],
  verdict: CriticVerdict,
  verdictText: string,
): string {
  const all = [...round1, ...round2].map((t) => `[${t.persona}]\n${t.text}`).join('\n\n');
  return [
    CEO.charter,
    '',
    `안건: ${agenda}`,
    '',
    '───── 회의 전문 ─────',
    all,
    '',
    '───── Critic 판정 (원문) ─────',
    verdictText,
    '─────────────────────────',
    '',
    verdict.verdict === 'BLOCK'
      ? 'Critic 이 BLOCK 했다. 이 판정을 기각하지 마라. 결정에 그 사실을 반영하고 미결로 남길 것을 OPEN 에 적어라.'
      : '',
    '',
    '아래 형식으로만 답하라. 다른 문장을 앞뒤에 붙이지 마라.',
    '',
    'DECISION:',
    '- (결정 사항. 최소 1건)',
    'OPEN:',
    '- (미결 사항. 없으면 섹션 생략)',
    'ACTIONS:',
    '- @Owner : 할 일 (DUE: YYYY-MM-DD)',
    '',
    '@Owner 는 다음 중에서 고른다: @CTO @Growth @Studio @Loop @Research',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
