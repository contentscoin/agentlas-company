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
import { runCmd, type RunResult } from '../proc/index.js';
import { Ledger, digestPayload } from '../ledger/ledger.js';
import type { SeatId } from '../ledger/types.js';
import type { BuiltPack } from '../taint/types.js';
import { createProfile, type SeatProfile } from './profile.js';
import { ALL_SEATS, effectiveConcurrency, type SeatSpec, type Vendor } from './spec.js';

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
}

interface SeatState {
  spec: SeatSpec;
  running: number;
  waiters: Array<() => void>;
  /** 창 안에서 쓴 호출 수. limit 이 null 이면 집계만 하고 막지 않는다. */
  used: number;
  /** 소진으로 확인된 좌석. 다음 리셋까지 선택 대상에서 제외한다. */
  exhausted: boolean;
}

/**
 * 기본 실행기.
 *
 * `promptVia: 'stdin'` 이면 프롬프트를 stdin 으로 보낸다.
 * 실측 근거: 여러 줄 프롬프트를 셸 인자로 넘기면 개행이 명령줄을 깨뜨려
 * exit 1 이 된다. Windows 명령줄 길이 상한(약 8191자)도 컨텍스트 팩을
 * 인자로 실을 수 없게 만든다.
 */
const defaultRunner: SeatRunner = (spec, args, profile, timeoutMs, prompt) =>
  runCmd(spec.bin, args, {
    cwd: profile.workDir,
    env: profile.env,
    timeoutMs,
    ...(spec.promptVia === 'stdin' ? { input: prompt } : {}),
  });

export class SeatBroker {
  private readonly ledger: Ledger;
  private readonly runner: SeatRunner;
  private readonly states = new Map<SeatId, SeatState>();

  constructor(opts: BrokerOptions) {
    this.ledger = opts.ledger;
    this.runner = opts.runner ?? defaultRunner;
    for (const spec of opts.seats ?? ALL_SEATS) {
      this.states.set(spec.id, { spec, running: 0, waiters: [], used: 0, exhausted: false });
    }
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
    note?: string;
  }> {
    return [...this.states.values()].map((s) => ({
      seat: s.spec.id,
      vendor: s.spec.vendor,
      verified: s.spec.verified,
      running: s.running,
      queued: s.waiters.length,
      used: s.used,
      limit: s.spec.quota.limit,
      window: s.spec.quota.window,
      exhausted: s.exhausted,
      ...(s.spec.note !== undefined ? { note: s.spec.note } : {}),
    }));
  }

  /**
   * 요청에 쓸 좌석 후보를 고른다.
   * preferSeat 를 먼저 보고, 그다음 검증된 좌석을 순서대로 본다.
   */
  private candidates(req: AskRequest): SeatSpec[] {
    const forbid = new Set(req.forbidVendor ?? []);
    const usable = (s: SeatState): boolean => {
      if (forbid.has(s.spec.vendor)) return false;
      if (s.exhausted) return false;
      if (!s.spec.verified && !req.allowUnverified) return false;
      const { limit } = s.spec.quota;
      if (limit !== null && s.used >= limit) return false;
      return true;
    };

    const out: SeatSpec[] = [];
    if (req.preferSeat) {
      const pref = this.states.get(req.preferSeat);
      if (pref && usable(pref)) out.push(pref.spec);
    }
    for (const s of this.states.values()) {
      if (s.spec.id === req.preferSeat) continue;
      if (usable(s)) out.push(s.spec);
    }
    return out;
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
        state.used++;
        const outFile = join(profile.workDir, 'seat-out.txt');
        // stdin 좌석에는 프롬프트를 인자로 심지 않는다.
        const args = spec.buildArgs(spec.promptVia === 'stdin' ? '' : req.prompt, outFile);
        const run = await this.runner(spec, args, profile, timeoutMs, req.prompt);

        // 판정은 종료 코드와 산출물로만. stderr 는 보지 않는다.
        const fileContent = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
        const text = run.code === 0 ? spec.readResult(fileContent, run.stdout) : null;

        if (run.code === 0 && text !== null) {
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

        // 쿼터 소진은 재시도 대상이 아니다. 좌석을 창이 끝날 때까지 뺀다.
        if (looksExhausted(run)) {
          state.exhausted = true;
          failures.push(`${spec.id}: 쿼터 소진`);
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
