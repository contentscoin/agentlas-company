/**
 * 차용 패키지 핀 (R13.2)
 *
 * 확보한 패키지의 digest 를 `vendor.lock` 에 적는다. 저장소에 남기는 이유는
 * 두 가지다.
 *
 *   1. 같은 이름으로 내용이 바뀐 패키지가 조용히 들어오는 것을 막는다
 *   2. 어떤 외부 코드가 이 회사 안에서 도는지가 커밋 히스토리에 남는다
 *
 * **`vendor.lock` 은 YAML 이지만 손으로 쓴 주석이 많다.** 파싱해서 다시
 * 쓰면 그 주석이 전부 날아간다 — 그 주석들이 업스트림 인용 근거이고
 * Task 2 의 산출물이다. 그래서 파일을 통째로 다시 만들지 않고 `borrowed_agents:`
 * 블록만 문자열로 교체한다. 형식이 거칠지만 잃는 것이 없다.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { AgentPermissions } from './permissions.js';

export interface BorrowedAgent {
  /** Hub 패키지 식별자. */
  id: string;
  /** 패키지 내용의 digest. 같은 id 라도 내용이 바뀌면 다른 값이다. */
  digest: string;
  /** 언제 확보했는가. */
  at: string;
  /** 어느 승인 카드로 들였는가. 원장과 이어진다. */
  approvalId: string;
  permissions: AgentPermissions;
  /** 회의가 적은 사유. */
  reason: string;
}

const BLOCK_RE = /^borrowed_agents:.*$(?:\n(?:[ \t]+.*|)$)*/m;

/** `vendor.lock` 에서 핀된 목록을 읽는다. */
export function readBorrowed(lockText: string): BorrowedAgent[] {
  const m = BLOCK_RE.exec(lockText);
  if (!m) return [];
  const block = m[0];
  if (/^borrowed_agents:\s*\[\s*\]\s*$/m.test(block.split('\n')[0] ?? '')) return [];

  const agents: BorrowedAgent[] = [];
  let current: Partial<BorrowedAgent> | null = null;
  for (const raw of block.split('\n').slice(1)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('- id:')) {
      if (current?.id) agents.push(current as BorrowedAgent);
      current = { id: line.slice('- id:'.length).trim() };
      continue;
    }
    if (!current) continue;
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2] ?? '';
    if (key === 'digest') current.digest = value;
    else if (key === 'at') current.at = value;
    else if (key === 'approvalId') current.approvalId = value;
    else if (key === 'reason') current.reason = value.replace(/^"|"$/g, '');
    else if (key === 'permissions') {
      const inner = value.replace(/^\[|\]$/g, '').trim();
      current.permissions = {
        granted: inner === '' ? [] : (inner.split(',').map((p) => p.trim()) as never),
      };
    }
  }
  if (current?.id) agents.push(current as BorrowedAgent);
  return agents;
}

/** 목록을 YAML 블록 문자열로 만든다. */
export function renderBorrowed(agents: readonly BorrowedAgent[]): string {
  if (agents.length === 0) return 'borrowed_agents: []';
  const lines = ['borrowed_agents:'];
  for (const a of agents) {
    lines.push(`  - id: ${a.id}`);
    lines.push(`    digest: ${a.digest}`);
    lines.push(`    at: ${a.at}`);
    lines.push(`    approvalId: ${a.approvalId}`);
    lines.push(`    permissions: [${a.permissions.granted.join(', ')}]`);
    lines.push(`    reason: "${a.reason.replace(/"/g, "'")}"`);
  }
  return lines.join('\n');
}

export type PinResult =
  | { ok: true; agents: BorrowedAgent[] }
  | { ok: false; reason: string };

/**
 * 패키지를 핀한다.
 *
 * 같은 id 가 **다른 digest** 로 다시 오면 거부한다. 갱신처럼 보이지만,
 * 조용히 덮으면 승인받은 것과 다른 내용이 도는 상태가 된다 — 승인은
 * digest 에 묶여 있다 (R4.6). 갱신하려면 오너가 기존 핀을 지우고 새로
 * 채용해야 하고, 그 과정에서 승인 카드가 다시 만들어진다.
 */
export function pinBorrowed(lockText: string, agent: BorrowedAgent): PinResult {
  const existing = readBorrowed(lockText);
  const same = existing.find((a) => a.id === agent.id);
  if (same) {
    if (same.digest === agent.digest) {
      return { ok: false, reason: `이미 핀되어 있다: ${agent.id}` };
    }
    return {
      ok: false,
      reason:
        `${agent.id} 는 다른 digest 로 이미 핀되어 있다 (${same.digest.slice(0, 12)} → ` +
        `${agent.digest.slice(0, 12)}). 승인은 digest 에 묶이므로 조용히 덮지 않는다 — ` +
        '기존 핀을 지우고 다시 채용하세요',
    };
  }
  return { ok: true, agents: [...existing, agent] };
}

/**
 * `vendor.lock` 파일에 반영한다. 주석은 건드리지 않는다.
 *
 * **`writePrivateFile`(0600)을 쓰지 않는다.** 이 파일은 커밋되는 저장소
 * 산출물이고 누구나 읽어야 한다 — 어떤 외부 코드가 도는지가 공개 기록인
 * 것이 핀의 목적이다. 게다가 그 헬퍼는 부모 디렉터리도 0700 으로 조이는데,
 * 여기서는 그 부모가 저장소 루트다.
 */
export function writeLock(file: string, agents: readonly BorrowedAgent[]): void {
  const text = readFileSync(file, 'utf8');
  const block = renderBorrowed(agents);
  const next = BLOCK_RE.test(text)
    ? text.replace(BLOCK_RE, block)
    : // 자리가 없으면 끝에 붙인다. Task 2 가 만든 자리가 사라진 경우다.
      `${text.trimEnd()}\n\n${block}`;
  // 블록이 파일 끝에 있으면 개행이 사라진다. git 이 "\ No newline at end of
  // file" 로 표시하고, 다음 수정의 diff 가 한 줄 더 커진다.
  writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}
