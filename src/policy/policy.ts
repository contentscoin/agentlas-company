/**
 * 정책 로딩과 등급 판정 (R4.1 ~ R4.4)
 *
 * 안전 기본값 하나가 이 파일의 핵심이다.
 * **정책에 없는 작업은 L2 로 본다.** 모르는 작업을 자동 실행하는 쪽이 아니라
 * 승인을 요구하는 쪽으로 기울인다. 새 동작을 추가하면서 정책 등록을 잊는 일은
 * 반드시 생기고, 그때 조용히 자동 실행되면 안 된다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { RISKY_CAPABILITIES } from '../capabilities/types.js';
import {
  escalate,
  requiresApproval,
  requiresStepUp,
  type AutonomyLevel,
  type Classification,
  type ClassifyInput,
  type PolicyConfig,
} from './types.js';

/** 정책에 없는 작업의 기본 등급. 자동이 아니라 승인이다. */
export const UNKNOWN_ACTION_LEVEL: AutonomyLevel = 'L2';

export const DEFAULT_POLICY: PolicyConfig = {
  levels: {
    L0: ['meeting', 'plan', 'draft', 'analyze', 'verify'],
    L1: [],
    L2: [],
    L3: ['spend', 'hire', 'credential.change', 'irreversible'],
  },
  escalateWhen: { criticBlock: true, seiRiskSignal: true, outputTainted: true },
  approval: { cardTtlMs: 12 * 3_600_000, coolingWindowMs: 120_000 },
  ownerIdentities: ['owner'],
  devices: [],
};

interface RawPolicy {
  levels?: Partial<Record<string, string[]>>;
  escalate_when?: Array<Record<string, unknown>>;
  approval?: {
    card_ttl_minutes?: number;
    cooling_window_seconds?: number;
  };
  owner_identities?: string[];
  devices?: string[];
}

/**
 * `policy.yaml` 을 읽는다. 파일이 없으면 기본 정책을 쓴다.
 *
 * 운영 파일은 저장소에 커밋되지 않으므로(`.gitignore`) 부재가 정상 상황이다.
 * 다만 부재를 조용히 넘기지 않고 호출자에게 알린다.
 */
export function loadPolicy(file?: string): { policy: PolicyConfig; source: 'file' | 'default' } {
  if (!file || !existsSync(file)) return { policy: DEFAULT_POLICY, source: 'default' };

  const raw = parseYaml(readFileSync(file, 'utf8')) as RawPolicy | null;
  if (!raw) return { policy: DEFAULT_POLICY, source: 'default' };

  const levels: Record<AutonomyLevel, string[]> = {
    L0: raw.levels?.['L0'] ?? DEFAULT_POLICY.levels.L0,
    L1: raw.levels?.['L1'] ?? [],
    L2: raw.levels?.['L2'] ?? [],
    L3: raw.levels?.['L3'] ?? DEFAULT_POLICY.levels.L3,
  };

  const flags = raw.escalate_when ?? [];
  const flagOn = (key: string): boolean =>
    flags.some((entry) => Object.prototype.hasOwnProperty.call(entry, key));

  const ttlMinutes = raw.approval?.card_ttl_minutes;
  const coolingSeconds = raw.approval?.cooling_window_seconds;

  return {
    source: 'file',
    policy: {
      levels,
      escalateWhen: {
        criticBlock: flagOn('critic_verdict') || DEFAULT_POLICY.escalateWhen.criticBlock,
        seiRiskSignal: flagOn('sei_risk_signal') || DEFAULT_POLICY.escalateWhen.seiRiskSignal,
        outputTainted: flagOn('output_tainted') || DEFAULT_POLICY.escalateWhen.outputTainted,
      },
      approval: {
        cardTtlMs: ttlMinutes !== undefined ? ttlMinutes * 60_000 : DEFAULT_POLICY.approval.cardTtlMs,
        coolingWindowMs:
          coolingSeconds !== undefined ? coolingSeconds * 1000 : DEFAULT_POLICY.approval.coolingWindowMs,
      },
      ownerIdentities: raw.owner_identities ?? DEFAULT_POLICY.ownerIdentities,
      devices: raw.devices ?? DEFAULT_POLICY.devices,
    },
  };
}

/** 위험 능력에 대응하는 작업은 되돌릴 수 없다고 본다. */
export function isIrreversibleAction(action: string): boolean {
  return (RISKY_CAPABILITIES as readonly string[]).includes(action);
}

/**
 * 작업의 기본 등급을 찾는다.
 *
 * 정확히 일치하는 항목을 먼저 보고, 그다음 `publish.*` 같은 접두 항목을 본다.
 * 여러 등급에 걸치면 **가장 높은 등급**을 택한다 — 안전한 방향이다.
 */
export function baseLevelOf(policy: PolicyConfig, action: string): AutonomyLevel | null {
  let found: AutonomyLevel | null = null;
  for (const level of ['L0', 'L1', 'L2', 'L3'] as const) {
    for (const entry of policy.levels[level]) {
      const match = entry === action || (entry.endsWith('.*') && action.startsWith(entry.slice(0, -1)));
      if (match) found = level;
    }
  }
  return found;
}

export function classify(policy: PolicyConfig, input: ClassifyInput): Classification {
  const irreversible = input.irreversible ?? isIrreversibleAction(input.action);
  const declared = baseLevelOf(policy, input.action);

  // 비가역 작업은 정책에 어떻게 적혀 있든 최소 L3 이다.
  let baseLevel: AutonomyLevel = declared ?? UNKNOWN_ACTION_LEVEL;
  if (irreversible) baseLevel = 'L3';

  let level = baseLevel;
  const escalatedBy: string[] = [];

  if (policy.escalateWhen.criticBlock && input.criticVerdict === 'BLOCK') {
    level = escalate(level);
    escalatedBy.push('critic-block');
  }
  if (policy.escalateWhen.seiRiskSignal && input.seiRisk === true) {
    level = escalate(level);
    escalatedBy.push('sei-risk');
  }
  if (policy.escalateWhen.outputTainted && input.tainted === true) {
    level = escalate(level);
    escalatedBy.push('tainted');
  }
  if (declared === null && !irreversible) {
    escalatedBy.push('unknown-action');
  }

  return {
    action: input.action,
    baseLevel,
    level,
    escalatedBy,
    needsApproval: requiresApproval(level),
    needsStepUp: requiresStepUp(level),
    irreversible,
  };
}
