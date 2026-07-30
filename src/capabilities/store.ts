/**
 * 능력 스위치 저장소 (R8, R15.8, R17.3)
 *
 * 저장 위치는 브로커 구역이다. 좌석 구역 호출자는 읽기도 쓰기도 거부되고
 * 그 시도가 원장에 `deny` 로 남는다 (R8.8). OS ACL 은 Task 3 에서 덧붙지만,
 * ACL 이 없어도 이 계층에서 막히는 것이 중요하다 — 방어는 겹쳐야 한다.
 *
 * 부팅 세션 개념이 R17.3 을 구현한다. 부여는 만들어진 부팅 세션에만 유효하므로
 * 재부팅하면 전부 OFF 로 돌아간다. "켜둔 걸 잊는" 실패가 시간이 지나면 치유된다.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import type { Ledger } from '../ledger/ledger.js';
import { resolveState } from '../paths.js';
import {
  RISKY_CAPABILITIES,
  type Caller,
  type CapabilityScope,
  type CapabilityState,
  type CapabilityView,
  type RiskyCapability,
} from './types.js';

/**
 * 현재 부팅 세션 식별자.
 *
 * 부팅 시각을 초 단위로 반올림해 쓴다. os.uptime() 은 초 단위 실수라
 * 호출마다 미세하게 흔들리므로 10초 격자로 뭉갠다. 재부팅은 그보다
 * 훨씬 큰 차이를 만들기 때문에 판별에 충분하다.
 */
export function currentBootId(): string {
  const bootMs = Date.now() - uptime() * 1000;
  return `boot-${Math.round(bootMs / 10_000)}`;
}

export class ZoneForbiddenError extends Error {
  constructor(zone: string, action: string) {
    super(`구역 ${zone} 은 능력 스위치를 ${action} 할 수 없다`);
    this.name = 'ZoneForbiddenError';
  }
}

export class SwitchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwitchValidationError';
  }
}

/** ON 으로 바꿀 때 필요한 입력. 유효기간은 선택이 아니다. */
export interface EnableInput {
  capability: RiskyCapability;
  /** 유효 시간(밀리초). 필수이며 0 이하는 거부된다 (R8.4). */
  ttlMs: number;
  scope?: Partial<CapabilityScope>;
}

export type Notifier = (message: string, capability: RiskyCapability) => void;

export interface StoreOptions {
  file?: string;
  ledger: Ledger;
  /** 등록된 모든 오너 기기에 알린다 (R8.10). */
  notify?: Notifier;
  /** 테스트에서 부팅 세션을 고정하기 위한 주입점. */
  bootId?: () => string;
  now?: () => number;
}

function emptyScope(): CapabilityScope {
  return { channels: [], accounts: [] };
}

function offState(capability: RiskyCapability): CapabilityState {
  return {
    capability,
    enabled: false,
    expiresAt: null,
    scope: emptyScope(),
    bootId: null,
    lastChangedBy: null,
  };
}

export class CapabilityStore {
  private readonly file: string;
  private readonly ledger: Ledger;
  private readonly notify: Notifier;
  private readonly bootId: () => string;
  private readonly now: () => number;
  private readonly panicListeners = new Set<(reason: string) => void>();

  constructor(opts: StoreOptions) {
    this.file = opts.file ?? join(resolveState(), 'broker', 'capabilities.json');
    this.ledger = opts.ledger;
    this.notify = opts.notify ?? ((): void => {});
    this.bootId = opts.bootId ?? currentBootId;
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  /** 진행 중 작업이 전체 차단에 반응할 수 있게 등록한다 (R8.13). */
  onPanic(listener: (reason: string) => void): () => void {
    this.panicListeners.add(listener);
    return () => this.panicListeners.delete(listener);
  }

  private assertCanRead(caller: Caller): void {
    if (caller.zone === 'seat') {
      this.ledger.append({
        actor: { kind: 'agent', id: caller.id },
        kind: 'deny',
        summary: `좌석 구역이 능력 스위치를 읽으려 시도했다 (${caller.id})`,
      });
      throw new ZoneForbiddenError(caller.zone, '읽기');
    }
  }

  private assertCanWrite(caller: Caller): void {
    if (caller.zone !== 'owner') {
      this.ledger.append({
        actor: { kind: caller.zone === 'seat' ? 'agent' : 'system', id: caller.id },
        kind: 'deny',
        summary: `구역 ${caller.zone} 이 능력 스위치를 변경하려 시도했다 (${caller.id})`,
      });
      throw new ZoneForbiddenError(caller.zone, '변경');
    }
    if (caller.stepUp !== true) {
      this.ledger.append({
        actor: { kind: 'owner', id: caller.id },
        kind: 'deny',
        summary: '단계별 인증 없이 스위치 변경을 시도했다',
      });
      throw new ZoneForbiddenError(caller.zone, '단계별 인증 없이 변경');
    }
  }

  /** 디스크에서 읽는다. 파일이 없거나 깨졌으면 전부 OFF 로 시작한다 (R8.1). */
  private load(): Map<RiskyCapability, CapabilityState> {
    const map = new Map<RiskyCapability, CapabilityState>();
    for (const cap of RISKY_CAPABILITIES) map.set(cap, offState(cap));

    if (!existsSync(this.file)) return map;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { states?: CapabilityState[] };
      for (const s of raw.states ?? []) {
        if (map.has(s.capability)) map.set(s.capability, s);
      }
    } catch {
      // 손상된 저장소는 "전부 OFF" 로 해석한다.
      // 위험한 능력을 켜진 상태로 추정하는 것보다 안전한 방향이다.
      return map;
    }
    return map;
  }

  private save(map: Map<RiskyCapability, CapabilityState>): void {
    writeFileSync(this.file, JSON.stringify({ states: [...map.values()] }, null, 2), 'utf8');
  }

  /**
   * 유효한 상태를 돌려준다. 만료·부팅 세션 불일치는 여기서 OFF 로 접힌다.
   * 만료가 확인되면 디스크에도 반영한다 (R8.5).
   */
  private effective(map: Map<RiskyCapability, CapabilityState>): {
    states: Map<RiskyCapability, CapabilityState>;
    changed: boolean;
  } {
    const boot = this.bootId();
    const nowMs = this.now();
    let changed = false;

    for (const [cap, state] of map) {
      if (!state.enabled) continue;

      const staleBoot = state.bootId !== boot;
      const expired = state.expiresAt === null || Date.parse(state.expiresAt) <= nowMs;

      if (staleBoot || expired) {
        map.set(cap, { ...offState(cap), lastChangedBy: state.lastChangedBy });
        changed = true;
        this.ledger.append({
          actor: { kind: 'system', id: 'capability-store' },
          kind: 'switch.change',
          summary: `${cap} 자동 OFF — ${staleBoot ? '재부팅으로 부여 무효' : '유효기간 만료'}`,
        });
      }
    }
    return { states: map, changed };
  }

  /** 현재 상태 전체. 만료 정리를 겸한다. */
  list(caller: Caller): CapabilityState[] {
    this.assertCanRead(caller);
    const { states, changed } = this.effective(this.load());
    if (changed) this.save(states);
    return [...states.values()];
  }

  get(caller: Caller, capability: RiskyCapability): CapabilityState {
    this.assertCanRead(caller);
    const { states, changed } = this.effective(this.load());
    if (changed) this.save(states);
    return states.get(capability) ?? offState(capability);
  }

  /** 능력을 켠다. 유효기간이 없으면 거부한다 (R8.4). */
  enable(caller: Caller, input: EnableInput): CapabilityState {
    this.assertCanWrite(caller);
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new SwitchValidationError('유효 시간은 필수이며 0보다 커야 한다. 무기한 ON 은 만들 수 없다');
    }

    const map = this.effective(this.load()).states;
    const expiresAt = new Date(this.now() + input.ttlMs).toISOString();
    const state: CapabilityState = {
      capability: input.capability,
      enabled: true,
      expiresAt,
      scope: {
        channels: input.scope?.channels ?? [],
        accounts: input.scope?.accounts ?? [],
      },
      bootId: this.bootId(),
      lastChangedBy: { device: caller.device ?? 'unknown', at: new Date(this.now()).toISOString() },
    };
    map.set(input.capability, state);
    this.save(map);

    const scopeText =
      state.scope.channels.length === 0 && state.scope.accounts.length === 0
        ? '범위 지정 없음'
        : `채널[${state.scope.channels.join(',')}] 계정[${state.scope.accounts.join(',')}]`;

    this.ledger.append({
      actor: { kind: 'owner', id: caller.id, ...(caller.device ? {} : {}) },
      kind: 'switch.change',
      level: 'L3',
      summary: `${input.capability} ON — 만료 ${expiresAt}, ${scopeText}, 기기 ${caller.device ?? 'unknown'}`,
    });

    // R8.10 — 켜졌다는 사실은 모든 오너 기기가 알아야 한다.
    this.notify(`능력 ON: ${input.capability} (만료 ${expiresAt})`, input.capability);
    return state;
  }

  disable(caller: Caller, capability: RiskyCapability): CapabilityState {
    this.assertCanWrite(caller);
    const map = this.effective(this.load()).states;
    const prev = map.get(capability);
    map.set(capability, { ...offState(capability), lastChangedBy: prev?.lastChangedBy ?? null });
    this.save(map);

    this.ledger.append({
      actor: { kind: 'owner', id: caller.id },
      kind: 'switch.change',
      summary: `${capability} OFF — 기기 ${caller.device ?? 'unknown'}`,
    });
    return map.get(capability)!;
  }

  /**
   * 전체 차단 (R8.13).
   *
   * 단계별 인증을 요구하지 않는다. 위험을 줄이는 방향의 조작은
   * 마찰이 없어야 한다. 급할 때 인증 화면을 통과해야 하는 킬 스위치는
   * 킬 스위치가 아니다.
   */
  panicDisableAll(caller: Caller, reason = '오너 전체 차단'): CapabilityState[] {
    if (caller.zone === 'seat') {
      this.ledger.append({
        actor: { kind: 'agent', id: caller.id },
        kind: 'deny',
        summary: '좌석 구역이 전체 차단을 호출하려 시도했다',
      });
      throw new ZoneForbiddenError(caller.zone, '전체 차단');
    }

    const map = this.load();
    for (const cap of RISKY_CAPABILITIES) {
      const prev = map.get(cap);
      map.set(cap, { ...offState(cap), lastChangedBy: prev?.lastChangedBy ?? null });
    }
    this.save(map);

    this.ledger.append({
      actor: { kind: caller.zone === 'owner' ? 'owner' : 'system', id: caller.id },
      kind: 'switch.change',
      level: 'L3',
      summary: `전체 차단 — ${reason}. 진행 중 작업 중단 신호 발송`,
    });

    for (const listener of this.panicListeners) listener(reason);
    this.notify(`전체 차단 실행 — ${reason}`, RISKY_CAPABILITIES[0]);
    return [...map.values()];
  }

  /** 스위치 화면용 뷰 (R8.15). 최근 사용·거부 건수를 원장에서 센다. */
  view(caller: Caller): CapabilityView[] {
    const states = this.list(caller);
    const events = this.ledger.query({ kind: ['hands.step', 'deny'] });
    const nowMs = this.now();

    return states.map((s) => {
      const uses = events.filter((e) => e.kind === 'hands.step' && (e.summary ?? '').includes(s.capability)).length;
      const denials = events.filter((e) => e.kind === 'deny' && (e.summary ?? '').includes(s.capability)).length;
      return {
        capability: s.capability,
        enabled: s.enabled,
        remainingMs: s.enabled && s.expiresAt ? Math.max(0, Date.parse(s.expiresAt) - nowMs) : null,
        scope: s.scope,
        lastChangedBy: s.lastChangedBy,
        recentUses: uses,
        recentDenials: denials,
      };
    });
  }
}
