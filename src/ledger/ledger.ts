/**
 * 해시체인 append-only 원장 (R9)
 *
 * 설계 판단 셋:
 *
 * 1. 파일 쓰기는 이 클래스만 한다. 좌석은 API 로 제출한다 (R9.3).
 *    에이전트가 과거를 고쳐 쓸 수 있으면 검증(R11)은 연극이 된다.
 *
 * 2. 각 이벤트가 이전 이벤트의 해시를 포함한다. 중간을 고치면
 *    그 뒤 전체의 체인이 깨지므로 개조가 검출된다 (R9.2).
 *
 * 3. 손상은 복구 대상이지 은폐 대상이 아니다. 마지막 줄이 잘려도
 *    그 이전까지는 신뢰할 수 있으므로 `lastGoodSeq` 를 돌려준다.
 *    조용히 넘어가지 않는다.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  GENESIS_HASH,
  type EventInput,
  type EventKind,
  type LedgerEvent,
  type QueryFilter,
  type VerifyProblem,
  type VerifyResult,
} from './types.js';

/** 해시 계산용 정규 직렬화. 키 순서를 고정해야 해시가 재현된다. */
export function canonicalize(event: Omit<LedgerEvent, 'hash'>): string {
  const ordered: Record<string, unknown> = {
    id: event.id,
    seq: event.seq,
    at: event.at,
    prevHash: event.prevHash,
    actor: { kind: event.actor.kind, id: event.actor.id, ...(event.actor.seat ? { seat: event.actor.seat } : {}) },
    kind: event.kind,
    ...(event.level ? { level: event.level } : {}),
    ...(event.tainted !== undefined ? { tainted: event.tainted } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.payloadDigest ? { payloadDigest: event.payloadDigest } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    evidence: event.evidence,
  };
  return JSON.stringify(ordered);
}

export function hashEvent(event: Omit<LedgerEvent, 'hash'>): string {
  return createHash('sha256').update(canonicalize(event), 'utf8').digest('hex');
}

/** 본문 digest. 본문 자체는 원장에 넣지 않는다. */
export function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class Ledger {
  private readonly file: string;
  private seq: number;
  private lastHash: string;

  private constructor(file: string, seq: number, lastHash: string) {
    this.file = file;
    this.seq = seq;
    this.lastHash = lastHash;
  }

  /**
   * 원장을 연다. 없으면 만든다.
   * 기존 파일이 있으면 마지막 온전한 이벤트에서 이어 쓴다.
   */
  static open(file: string): Ledger {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) return new Ledger(file, 0, GENESIS_HASH);

    const events = readEvents(file);
    if (events.length === 0) return new Ledger(file, 0, GENESIS_HASH);

    const last = events[events.length - 1]!;
    return new Ledger(file, last.seq, last.hash);
  }

  get path(): string {
    return this.file;
  }

  get height(): number {
    return this.seq;
  }

  get head(): string {
    return this.lastHash;
  }

  /** 이벤트를 추가한다. 체인을 잇고 디스크에 내려쓴다. */
  append(input: EventInput): LedgerEvent {
    const unhashed: Omit<LedgerEvent, 'hash'> = {
      id: randomUUID(),
      seq: this.seq + 1,
      at: input.at ?? new Date().toISOString(),
      prevHash: this.lastHash,
      actor: input.actor,
      kind: input.kind,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.tainted !== undefined ? { tainted: input.tainted } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.payloadDigest !== undefined ? { payloadDigest: input.payloadDigest } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      evidence: input.evidence ?? [],
    };

    const event: LedgerEvent = { ...unhashed, hash: hashEvent(unhashed) };

    // 한 줄씩 append 하고 fsync 한다.
    // 정전 후 원장 무손실(R17.2)을 확인할 수 있어야 하므로 버퍼에 두지 않는다.
    appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8');
    const fd = openSync(this.file, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    this.seq = event.seq;
    this.lastHash = event.hash;
    return event;
  }

  /** 전체 이벤트를 읽는다. 손상된 줄은 건너뛰지 않고 verify 가 보고한다. */
  all(): LedgerEvent[] {
    return readEvents(this.file);
  }

  /** 체인 무결성을 검사한다 (R9.2). */
  verify(): VerifyResult {
    const problems: VerifyProblem[] = [];
    const lines = existsSync(this.file)
      ? readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim() !== '')
      : [];

    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    let lastGoodSeq = 0;
    let count = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      let event: LedgerEvent;
      try {
        event = JSON.parse(lines[i]!) as LedgerEvent;
      } catch (err) {
        problems.push({ at: lineNo, problem: 'unparseable', detail: (err as Error).message });
        break;
      }

      if (event.seq !== expectedSeq) {
        problems.push({ at: lineNo, problem: 'seq-gap', detail: `expected ${expectedSeq}, got ${event.seq}` });
        break;
      }
      if (event.prevHash !== prevHash) {
        problems.push({ at: lineNo, problem: 'chain-break', detail: `seq ${event.seq} prevHash 불일치` });
        break;
      }
      const { hash, ...unhashed } = event;
      if (hashEvent(unhashed) !== hash) {
        problems.push({ at: lineNo, problem: 'hash-mismatch', detail: `seq ${event.seq} 내용이 개조되었다` });
        break;
      }

      prevHash = event.hash;
      expectedSeq = event.seq + 1;
      lastGoodSeq = event.seq;
      count++;
    }

    return { ok: problems.length === 0, count, lastGoodSeq, problems };
  }

  /** 필터 조회 (R9.4). */
  query(filter: QueryFilter = {}): LedgerEvent[] {
    const kinds: EventKind[] | undefined =
      filter.kind === undefined ? undefined : Array.isArray(filter.kind) ? filter.kind : [filter.kind];

    let out = this.all().filter((e) => {
      if (filter.since && e.at < filter.since) return false;
      if (filter.until && e.at > filter.until) return false;
      if (kinds && !kinds.includes(e.kind)) return false;
      if (filter.actorId && e.actor.id !== filter.actorId) return false;
      if (filter.level && e.level !== filter.level) return false;
      if (filter.runId && e.runId !== filter.runId) return false;
      if (filter.tainted !== undefined && (e.tainted ?? false) !== filter.tainted) return false;
      return true;
    });

    if (filter.limit !== undefined && filter.limit >= 0) out = out.slice(-filter.limit);
    return out;
  }

  /** 한 실행을 순서대로 재생한다 (R9.5). */
  replay(runId: string): LedgerEvent[] {
    return this.query({ runId }).sort((a, b) => a.seq - b.seq);
  }
}

function readEvents(file: string): LedgerEvent[] {
  if (!existsSync(file)) return [];
  const out: LedgerEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as LedgerEvent);
    } catch {
      // 손상된 줄에서 멈춘다. 그 뒤를 읽으면 체인이 의미를 잃는다.
      break;
    }
  }
  return out;
}
