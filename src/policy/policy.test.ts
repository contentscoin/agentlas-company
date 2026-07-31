import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, baseLevelOf, classify, isIrreversibleAction, loadPolicy } from './policy.js';
import { escalate, requiresApproval, requiresStepUp, type PolicyConfig } from './types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-policy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const policy: PolicyConfig = {
  ...DEFAULT_POLICY,
  levels: {
    L0: ['meeting', 'draft'],
    L1: ['publish.threads', 'publish.naver_blog'],
    L2: ['publish.instagram', 'store.write'],
    L3: ['hire', 'credential.change'],
  },
};

describe('등급 사다리', () => {
  it('한 칸씩 올라가고 L3 에서 멈춘다', () => {
    expect(escalate('L0')).toBe('L1');
    expect(escalate('L1')).toBe('L2');
    expect(escalate('L2')).toBe('L3');
    expect(escalate('L3')).toBe('L3');
  });

  it('L2 부터 승인이 필요하다', () => {
    expect(requiresApproval('L0')).toBe(false);
    expect(requiresApproval('L1')).toBe(false);
    expect(requiresApproval('L2')).toBe(true);
    expect(requiresApproval('L3')).toBe(true);
  });

  it('단계별 인증은 L3 만이다', () => {
    expect(requiresStepUp('L2')).toBe(false);
    expect(requiresStepUp('L3')).toBe(true);
  });
});

describe('작업 → 등급 (R4.1)', () => {
  it('정확히 일치하는 항목을 찾는다', () => {
    expect(baseLevelOf(policy, 'meeting')).toBe('L0');
    expect(baseLevelOf(policy, 'publish.threads')).toBe('L1');
    expect(baseLevelOf(policy, 'publish.instagram')).toBe('L2');
    expect(baseLevelOf(policy, 'hire')).toBe('L3');
  });

  it('등록되지 않은 작업은 null 이다', () => {
    expect(baseLevelOf(policy, 'publish.tiktok')).toBeNull();
  });

  it('접두 항목을 지원하고 여러 등급에 걸치면 높은 쪽을 택한다', () => {
    const p: PolicyConfig = { ...policy, levels: { ...policy.levels, L1: ['publish.*'], L2: ['publish.instagram'] } };
    expect(baseLevelOf(p, 'publish.threads')).toBe('L1');
    expect(baseLevelOf(p, 'publish.instagram')).toBe('L2');
  });
});

describe('안전 기본값', () => {
  it('정책에 없는 작업은 자동이 아니라 L2 다', () => {
    const c = classify(policy, { action: 'publish.tiktok' });
    expect(c.baseLevel).toBe('L2');
    expect(c.needsApproval).toBe(true);
    expect(c.escalatedBy).toContain('unknown-action');
  });

  it('위험 능력에 대응하는 작업은 정책과 무관하게 최소 L3 다', () => {
    expect(isIrreversibleAction('spend')).toBe(true);
    expect(isIrreversibleAction('order_cancel_refund')).toBe(true);
    expect(isIrreversibleAction('draft')).toBe(false);

    const permissive: PolicyConfig = { ...policy, levels: { ...policy.levels, L0: ['spend'] } };
    const c = classify(permissive, { action: 'spend' });
    expect(c.baseLevel).toBe('L3');
    expect(c.irreversible).toBe(true);
  });
});

describe('승격 (R4.4)', () => {
  it('Critic BLOCK 이면 한 칸 올린다', () => {
    const c = classify(policy, { action: 'publish.threads', criticVerdict: 'BLOCK' });
    expect(c.baseLevel).toBe('L1');
    expect(c.level).toBe('L2');
    expect(c.escalatedBy).toContain('critic-block');
  });

  it('PASS 나 CONCERN 은 올리지 않는다', () => {
    expect(classify(policy, { action: 'publish.threads', criticVerdict: 'PASS' }).level).toBe('L1');
    expect(classify(policy, { action: 'publish.threads', criticVerdict: 'CONCERN' }).level).toBe('L1');
  });

  it('SEI 리스크 신호로 올린다', () => {
    const c = classify(policy, { action: 'publish.threads', seiRisk: true });
    expect(c.level).toBe('L2');
    expect(c.escalatedBy).toContain('sei-risk');
  });

  it('오염된 산출물은 자동발행이어도 승인으로 올라간다 (R16.4)', () => {
    const c = classify(policy, { action: 'publish.threads', tainted: true });
    expect(c.baseLevel).toBe('L1');
    expect(c.level).toBe('L2');
    expect(c.needsApproval).toBe(true);
  });

  it('신호가 겹치면 여러 칸 올라간다', () => {
    const c = classify(policy, { action: 'meeting', criticVerdict: 'BLOCK', seiRisk: true, tainted: true });
    expect(c.baseLevel).toBe('L0');
    expect(c.level).toBe('L3');
    expect(c.escalatedBy).toHaveLength(3);
  });

  it('L3 은 더 올라가지 않는다', () => {
    const c = classify(policy, { action: 'hire', criticVerdict: 'BLOCK', tainted: true });
    expect(c.level).toBe('L3');
  });

  it('L0 자동 작업은 신호가 없으면 승인이 필요 없다 (R4.2)', () => {
    const c = classify(policy, { action: 'meeting' });
    expect(c.level).toBe('L0');
    expect(c.needsApproval).toBe(false);
  });
});

describe('policy.yaml 로딩', () => {
  it('파일이 없으면 기본 정책과 그 사실을 알린다', () => {
    const r = loadPolicy(join(dir, 'none.yaml'));
    expect(r.source).toBe('default');
    expect(r.policy.levels.L3).toContain('spend');
  });

  it('경로를 주지 않아도 기본 정책을 쓴다', () => {
    expect(loadPolicy().source).toBe('default');
  });

  it('실제 YAML 을 읽는다', () => {
    const file = join(dir, 'policy.yaml');
    writeFileSync(
      file,
      [
        'levels:',
        '  L0: [meeting]',
        '  L1: [publish.threads]',
        '  L2: [publish.instagram]',
        '  L3: [hire]',
        'approval:',
        '  card_ttl_minutes: 30',
        '  cooling_window_seconds: 45',
        'owner_identities: [owner, spouse]',
        'devices: [phone-1, desktop-1]',
      ].join('\n'),
      'utf8',
    );
    const { policy: p, source } = loadPolicy(file);
    expect(source).toBe('file');
    expect(p.levels.L1).toEqual(['publish.threads']);
    expect(p.approval.cardTtlMs).toBe(1_800_000);
    expect(p.approval.coolingWindowMs).toBe(45_000);
    expect(p.ownerIdentities).toEqual(['owner', 'spouse']);
    expect(p.devices).toEqual(['phone-1', 'desktop-1']);
  });

  it('저장소의 policy.example.yaml 을 읽을 수 있다', () => {
    const { policy: p, source } = loadPolicy('policy.example.yaml');
    expect(source).toBe('file');
    expect(p.levels.L1).toContain('publish.threads');
    expect(p.levels.L3).toContain('spend');
  });

  it('빈 파일이면 기본 정책으로 떨어진다', () => {
    const file = join(dir, 'empty.yaml');
    writeFileSync(file, '', 'utf8');
    expect(loadPolicy(file).source).toBe('default');
  });
});
