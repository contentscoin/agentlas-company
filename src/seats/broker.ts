/**
 * Seat Broker (R2)
 *
 * 좌석 4개를 임원 여럿이 나눠 쓰게 만드는 계층. 규칙 다섯.
 *
 * 1. 환경 위생을 강제한다. 모든 좌석 호출은 API 키가 제거된 환경에서 돈다 (R1.1).
 * 2. 판정은 종료 코드와 산출물로만 한다. stderr 존재는 실패가 아니다 (실측).
 * 3. 미검증 좌석을 조용히 쓰지 않는다. 명시적으로 허용해야 시도한다.
 * 4. 폴백이 벤더 격리를 깨지 않는다. Critic 이 같은 벤더로 떨어지면
 *    폴백하지 않고 실패한다 — 그게 R3.4 의 요점이다.
 * 5. 모든 호출과 거부가 원장에 남는다 (R9). 거부는 `deny` 종류로 따로 남긴다.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCmd, runDirect, type RunResult } from '../proc/index.js';
import { Ledger, digestPayload } from '../ledger/ledger.js';
import type { SeatId } from '../ledger/types.js';
import type { BuiltPack } from '../taint/types.js';
import { createProfile, type SeatProfile } from './profile.js';
import { ALL_SEATS, effectiveConcurrency, type SeatSpec, type Vendor } from './spec.js';
import {
  assertQuotaCoherent,
  currentWindowKey,
  exhaustionState,
  limitEnforceable,
  parseResetHint,
  SeatUsageStore,
  type SeatUsage,
} from './usage.js';

export const DEFAULT_TIMEOUT_MS = 180_000;

export interface AskRequest {
  /** 발언 주체. 원장의 actor.id 가 된다. */
  persona: string;
  prompt: string;
  preferSeat?: SeatId;
  /** Critic 크로스벤더 강제 (R3.4). 이 벤더들은 쓰지 않는다. */
  forbidVendor?: Vendor[];
  timeoutMs?: number;
  runId?: string;
  /** 입력 팩에 신뢰등급 0 콘텐츠가 있었는가 (R16.3). */
  tainted?: boolean;
  /** 미검증 좌석 사용을 명시적으로 허용한다. */
  allowUnverified?: boolean;
}

export interface AskResult {
  ok: boolean;
  seat?: SeatId;
  text?: string;
  /** 입력이 오염이면 산출물도 오염이다. 전파는 자동이다. */
  tainted: boolean;
  eventId: string;
  reason?: string;
  queuedMs: number;
  ranMs: number;
  exitCode?: number | null;
}

/** 테스트에서 실제 CLI 대신 끼워넣을 실행기. */
export type SeatRunner = (
  spec: SeatSpec,
  args: string[],
  profile: SeatProfile,
  timeoutMs: number,
  /** 프롬프트 본문. `promptVia: 'stdin'` 인 좌석은 이것을 stdin 으로 보낸다. */
  prompt: string,
) => Promise<RunResult>;

export interface BrokerOptions {
  ledger: Ledger;
  seats?: readonly SeatSpec[];
  runner?: SeatRunner;
  /**
   * 사용량 장부 (Task 5.1).
   *
   * 없으면 카운터가 이 프로세스에만 남는다 — `company` 는 부를 때마다 새
   * 프로세스이므로, 장부 없이는 카운터가 한 번도 누적되지 않고 벤더가 알려
   * 준 소진 사실도 매번 잊힌다. 단위 시험처럼 한 프로세스로 끝나는
   * 호출자만 생략한다.
   */
  usage?: SeatUsageStore;
  now?: () => number;
}

interface SeatState {
  spec: SeatSpec;
  running: number;
  waiters: Array<() => void>;
  /**
   * 창 안에서 쓴 호출 수와 소진 상태.
   *
   * 장부가 있으면 장부가 정본이고 이 값은 캐시다. 다른 `company`
   * 프로세스가 올린 카운트를 보려면 매번 다시 읽어야 한다.
   */
  usage: SeatUsage;
}

/**
 * 기본 실행기.
 *
 * `promptVia: 'stdin'` 이면 프롬프트를 stdin 으로 보낸다.
 * 실측 근거: 여러 줄 프롬프트를 셸 인자로 넘기면 개행이 명령줄을 깨뜨려
 * exit 1 이 된다. Windows 명령줄 길이 상한(약 8191자)도 컨텍스트 팩을
 * 인자로 실을 수 없게 만든다.
 */
const defaultRunner: SeatRunner = (spec, args, profile, timeoutMs, prompt) => {
  const opts = {
    cwd: profile.workDir,
    env: profile.env,
    timeoutMs,
    ...(spec.promptVia === 'stdin' ? { input: prompt } : {}),
  };
  // `.ps1`/`.cmd` 셔틀은 셸로, 실행 파일은 직접 띄운다.
  // 직접 실행은 인자에 개행이 들어가도 깨지지 않는다 (claude 가 이 경로를 쓴다).
  return spec.spawnMode === 'direct' ? runDirect(spec.bin, args, opts) : runCmd(spec.bin, args, opts);
};

export class SeatBroker {
  private readonly ledger: Ledger;
  private readonly runner: SeatRunner;
  private readonly states = new Map<SeatId, SeatState>();
  private readonly usageStore: SeatUsageStore | undefined;
  private readonly now: () => number;

  constructor(opts: BrokerOptions) {
    this.ledger = opts.ledger;
    this.runner = opts.runner ?? defaultRunner;
    this.usageStore = opts.usage;
    this.now = opts.now ?? (() => Date.now());
    for (const spec of opts.seats ?? ALL_SEATS) {
      // 집행할 수 없는 한도를 들고 출발하지 않는다. 조용히 무시되거나
      // 좌석을 영구히 죽이는 대신 여기서 멈춘다.
      assertQuotaCoherent(spec);
      this.states.set(spec.id, {
        spec,
        running: 0,
        waiters: [],
        usage: {
          windowKey: currentWindowKey(spec, this.now()),
          used: 0,
          exhaustedAt: null,
          exhaustedUntil: null,
        },
      });
    }
  }

  /**
   * 장부가 있으면 장부를 정본으로 다시 읽는다.
   *
   * 다른 `company` 프로세스가 방금 올린 카운트나 표시한 소진을 이 프로세스가
   * 보려면 매번 읽어야 한다. 한 번 읽고 캐시하면 동시에 도는 두 프로세스가
   * 서로의 소진을 못 본다.
   */
  private usageOf(state: SeatState): SeatUsage {
    if (this.usageStore === undefined) return state.usage;
    state.usage = this.usageStore.get(state.spec.id, state.spec);
    return state.usage;
  }

  /** 좌석 현황 (R2.6). */
  status(): Array<{
    seat: SeatId;
    vendor: Vendor;
    verified: boolean;
    running: number;
    queued: number;
    used: number;
    limit: number | null;
    window: string;
    exhausted: boolean;
    /** 소진이 풀리는 시각. null 이면 모른다 — 배제가 아니라 강등이다. */
    exhaustedUntil: string | null;
    /** 한도를 실제로 막는 데 쓰는가. 창 경계를 못 잡으면 집계만 한다. */
    limitEnforced: boolean;
    /** 카운터가 속한 창. `unbounded` 면 리셋되지 않는다. */
    windowKey: string;
    /** 장부에 남는가. false 면 이 프로세스가 끝날 때 사라진다. */
    persisted: boolean;
    note?: string;
  }> {
    const now = this.now();
    return [...this.states.values()].map((s) => {
      const usage = this.usageOf(s);
      // 지금 실제로 막혀 있는지를 보고한다. 해제 시각이 지난 좌석을 계속
      // "소진" 으로 보이면 화면과 선택 로직이 서로 다른 말을 한다.
      const ex = exhaustionState(usage, now);
      return {
        seat: s.spec.id,
        vendor: s.spec.vendor,
        verified: s.spec.verified,
        running: s.running,
        queued: s.waiters.length,
        used: usage.used,
        limit: s.spec.quota.limit,
        window: s.spec.quota.window,
        exhausted: ex.kind !== 'ok',
        exhaustedUntil: ex.kind === 'excluded' ? ex.until : null,
        limitEnforced: limitEnforceable(s.spec, now),
        windowKey: usage.windowKey,
        persisted: this.usageStore !== undefined,
        ...(s.spec.note !== undefined ? { note: s.spec.note } : {}),
      };
    });
  }

  /**
   * 요청에 쓸 좌석 후보를 고른다.
   *
   * preferSeat 를 먼저 보고, 그다음 검증된 좌석을 순서대로 본다.
   * 소진이지만 해제 시각을 모르는 좌석은 **빼지 않고 맨 뒤로 민다** —
   * 빼면 벤더 문구를 한 번 잘못 읽은 것만으로 회사가 멈춘다
   * (`usage.ts` 의 실패 방향 참조).
   */
  private candidates(req: AskRequest): SeatSpec[] {
    const forbid = new Set(req.forbidVendor ?? []);
    const now = this.now();

    /** 못 쓰면 null, 쓰면 순위(0 이 앞). */
    const rank = (s: SeatState): number | null => {
      if (forbid.has(s.spec.vendor)) return null;
      if (!s.spec.verified && !req.allowUnverified) return null;
      const usage = this.usageOf(s);
      const { limit } = s.spec.quota;
      if (limit !== null && usage.used >= limit && limitEnforceable(s.spec, now)) return null;
      const ex = exhaustionState(usage, now);
      if (ex.kind === 'excluded') return null;
      return ex.kind === 'demoted' ? 1 : 0;
    };

    const out: Array<{ spec: SeatSpec; rank: number; order: number }> = [];
    let order = 0;
    if (req.preferSeat) {
      const pref = this.states.get(req.preferSeat);
      if (pref) {
        const r = rank(pref);
        if (r !== null) out.push({ spec: pref.spec, rank: r, order: order++ });
      }
    }
    for (const s of this.states.values()) {
      if (s.spec.id === req.preferSeat) continue;
      const r = rank(s);
      if (r !== null) out.push({ spec: s.spec, rank: r, order: order++ });
    }
    // 강등된 좌석만 뒤로 민다. 같은 순위 안에서는 원래 순서를 지킨다.
    out.sort((a, b) => a.rank - b.rank || a.order - b.order);
    return out.map((o) => o.spec);
  }

  /** 호출 1회를 센다. 장부가 있으면 장부에, 없으면 이 프로세스에만. */
  private countCall(state: SeatState): void {
    if (this.usageStore !== undefined) {
      state.usage = this.usageStore.bump(state.spec.id, state.spec);
      return;
    }
    state.usage = { ...state.usage, used: state.usage.used + 1 };
  }

  private markExhausted(state: SeatState, until: string | null): void {
    const at = new Date(this.now()).toISOString();
    state.usage = { ...state.usage, exhaustedAt: at, exhaustedUntil: until };
    this.usageStore?.markExhausted(state.spec.id, state.spec, until);
  }

  private async acquire(state: SeatState): Promise<void> {
    const cap = effectiveConcurrency(state.spec);
    if (state.running < cap) {
      state.running++;
      return;
    }
    await new Promise<void>((resolve) => state.waiters.push(resolve));
    state.running++;
  }

  private release(state: SeatState): void {
    state.running--;
    const next = state.waiters.shift();
    if (next) next();
  }

  /**
   * 컨텍스트 팩으로 묻는다.
   *
   * 오염 전파를 호출자가 잊을 수 없게 만드는 진입점이다.
   * `ask` 는 `tainted` 를 넘기는 것을 잊을 수 있지만, 이 함수는
   * 팩이 계산한 값을 그대로 쓴다 (R16.3).
   */
  async askWithPack(
    persona: string,
    pack: BuiltPack,
    opts: Omit<AskRequest, 'persona' | 'prompt' | 'tainted'> = {},
  ): Promise<AskResult> {
    return this.ask({ ...opts, persona, prompt: pack.prompt, tainted: pack.tainted });
  }

  /** 좌석에 한 번 묻는다. 큐·예산·폴백·원장 기록을 모두 처리한다. */
  async ask(req: AskRequest): Promise<AskResult> {
    const tainted = req.tainted ?? false;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const queueStart = Date.now();

    const candidates = this.candidates(req);
    if (candidates.length === 0) {
      const reason = this.explainNoSeat(req);
      const ev = this.ledger.append({
        actor: { kind: 'system', id: 'seat-broker' },
        kind: 'deny',
        ...(req.runId !== undefined ? { runId: req.runId } : {}),
        tainted,
        summary: `좌석 배정 실패: ${reason}`,
      });
      return { ok: false, tainted, eventId: ev.id, reason, queuedMs: 0, ranMs: 0 };
    }

    const failures: string[] = [];

    for (const spec of candidates) {
      const state = this.states.get(spec.id)!;
      await this.acquire(state);
      const queuedMs = Date.now() - queueStart;

      const profile = createProfile(spec);
      try {
        this.countCall(state);
        const outFile = join(profile.workDir, 'seat-out.txt');
        // stdin 좌석에는 프롬프트를 인자로 심지 않는다.
        const args = spec.buildArgs(spec.promptVia === 'stdin' ? '' : req.prompt, outFile);
        const run = await this.runner(spec, args, profile, timeoutMs, req.prompt);

        // 판정은 종료 코드와 산출물로만. stderr 는 보지 않는다.
        const fileContent = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
        const text = run.code === 0 ? spec.readResult(fileContent, run.stdout) : null;

        if (run.code === 0 && text !== null) {
          // 답을 줬다는 것이 소진이 아니라는 가장 확실한 근거다.
          // 하한으로 잡아 둔 해제 시각이 실제보다 늦었어도 여기서 풀린다.
          this.usageStore?.clearExhausted(spec.id);
          const ev = this.ledger.append({
            actor: { kind: 'agent', id: req.persona, seat: spec.id },
            kind: 'seat.call',
            ...(req.runId !== undefined ? { runId: req.runId } : {}),
            tainted,
            payloadDigest: digestPayload(req.prompt),
            summary: `${req.persona} → ${spec.id} (${run.ms}ms${profile.isolated ? ', 격리' : ', 개인환경 상속'})`,
          });
          return {
            ok: true,
            seat: spec.id,
            text,
            tainted,
            eventId: ev.id,
            queuedMs,
            ranMs: run.ms,
            exitCode: run.code,
          };
        }

        // 쿼터 소진은 재시도 대상이 아니다. 해제 시각을 알면 그때까지 빼고,
        // 모르면 맨 뒤로 민다 (`usage.ts`).
        if (looksExhausted(run)) {
          const until = parseResetHint(`${run.stdout}\n${run.stderr}`, spec, this.now());
          this.markExhausted(state, until);
          failures.push(
            `${spec.id}: 쿼터 소진${until === null ? ' (해제 시각 미상 — 후순위로 민다)' : ` (해제 ${until} 이후)`}`,
          );
        } else if (run.timedOut) {
          failures.push(`${spec.id}: 타임아웃 ${timeoutMs}ms`);
        } else {
          failures.push(`${spec.id}: exit ${String(run.code)}`);
        }

        this.ledger.append({
          actor: { kind: 'system', id: 'seat-broker' },
          kind: 'deny',
          ...(req.runId !== undefined ? { runId: req.runId } : {}),
          tainted,
          summary: `좌석 실패 ${spec.id}: exit ${String(run.code)}${run.timedOut ? ' (타임아웃)' : ''}`,
        });
      } finally {
        profile.dispose();
        this.release(state);
      }
    }

    const reason = `모든 후보 좌석 실패 — ${failures.join(' / ')}`;
    const ev = this.ledger.append({
      actor: { kind: 'system', id: 'seat-broker' },
      kind: 'deny',
      ...(req.runId !== undefined ? { runId: req.runId } : {}),
      tainted,
      summary: reason,
    });
    return { ok: false, tainted, eventId: ev.id, reason, queuedMs: Date.now() - queueStart, ranMs: 0 };
  }

  private explainNoSeat(req: AskRequest): string {
    const forbid = req.forbidVendor ?? [];
    if (forbid.length > 0) {
      return `벤더 제외 조건(${forbid.join(', ')})을 만족하는 가용 좌석이 없다. 크로스벤더 격리를 깨지 않기 위해 폴백하지 않는다`;
    }
    const unverified = [...this.states.values()].filter((s) => !s.spec.verified).map((s) => s.spec.id);
    if (!req.allowUnverified && unverified.length > 0) {
      return `검증된 좌석이 없다. 미검증 좌석(${unverified.join(', ')})은 allowUnverified 없이 쓰지 않는다`;
    }
    // 전부 소진이면 언제 풀리는지가 오너가 물을 첫 질문이다.
    const now = this.now();
    const held = [...this.states.values()]
      .map((s) => ({ id: s.spec.id, ex: exhaustionState(this.usageOf(s), now) }))
      .filter((h) => h.ex.kind === 'excluded');
    if (held.length > 0) {
      const when = held.map((h) => `${h.id}(${h.ex.kind === 'excluded' ? h.ex.until : ''} 이후)`);
      return `모든 좌석이 쿼터 소진 상태다 — ${when.join(', ')}`;
    }
    return '가용 좌석이 없다';
  }
}

/**
 * 쿼터 소진 판별.
 *
 * 실측 문구를 근거로 한다:
 *   claude → "You've hit your weekly limit · resets 8pm (Asia/Seoul)" (exit 1)
 * 문구는 벤더가 바꿀 수 있으므로, 못 알아봐도 일반 실패로 처리되도록
 * 보수적으로만 판단한다.
 */
export function looksExhausted(run: RunResult): boolean {
  if (run.code === 0) return false;
  const text = `${run.stdout}\n${run.stderr}`.toLowerCase();
  return (
    text.includes('hit your weekly limit') ||
    text.includes('usage limit') ||
    text.includes('rate limit') ||
    text.includes('quota exceeded')
  );
}
