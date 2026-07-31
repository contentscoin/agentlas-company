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
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

  /**
   * 이벤트를 추가한다. 체인을 잇고 디스크에 내려쓴다.
   *
   * 프로세스 간 배타 락을 쓴다. 실제로 겪은 사고가 근거다 — 레시피 실행과
   * 중복 실행 거부가 동시에 append 해서 seq 2 가 두 번 쓰였고 체인이 깨졌다.
   * 각 프로세스가 자기 메모리의 seq 를 믿었기 때문이다.
   *
   * 그래서 락 안에서 파일 꼬리를 다시 읽어 진짜 마지막 상태를 확인한 뒤 쓴다.
   * 메모리 값은 캐시일 뿐 진실이 아니다.
   */
  append(input: EventInput): LedgerEvent {
    const lock = acquireAppendLock(this.file);
    try {
      return this.appendLocked(input);
    } finally {
      lock.release();
    }
  }

  private appendLocked(input: EventInput): LedgerEvent {
    // 락 안에서 진짜 마지막 이벤트를 다시 읽는다.
    const tail = readTailEvent(this.file);
    if (tail !== null) {
      this.seq = tail.seq;
      this.lastHash = tail.hash;
    } else {
      this.seq = 0;
      this.lastHash = GENESIS_HASH;
    }

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

/** 락 획득 대기 상한. 이걸 넘으면 죽은 락으로 보고 회수한다. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

interface AppendLock {
  release: () => void;
}

/**
 * 프로세스 간 배타 락.
 *
 * `openSync(path, 'wx')` 는 파일이 이미 있으면 실패하는 원자적 생성이다.
 * 별도 의존성 없이 크로스 플랫폼으로 동작하는 유일한 락 기본기다.
 *
 * 죽은 락을 회수하는 장치가 필요하다. 정전으로 프로세스가 사라지면
 * 락 파일만 남는데 그때 영원히 잠기면 무인 운영이 멈춘다.
 */
function acquireAppendLock(ledgerFile: string): AppendLock {
  const lockFile = `${ledgerFile}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(fd, String(process.pid), 'utf8');
      closeSync(fd);
      return { release: () => rmSync(lockFile, { force: true }) };
    } catch {
      // 이미 잠겨 있다. 죽은 락인지 본다.
      try {
        const age = Date.now() - statSync(lockFile).mtimeMs;
        if (age > LOCK_STALE_MS) {
          rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        // 락 파일이 방금 사라졌다. 다시 시도한다.
        continue;
      }
      if (Date.now() > deadline) {
        // 기다려도 안 풀린다. 락 없이 쓰지 않는다 — 체인이 깨지는 것보다
        // 이벤트 하나를 잃는 편이 낫고, 그 사실은 예외로 드러난다.
        throw new Error(`원장 락 획득 실패: ${lockFile}`);
      }
      sleepBriefly();
    }
  }
}

/** 짧은 동기 대기. append 는 동기 API 라 비동기 sleep 을 쓸 수 없다. */
function sleepBriefly(): void {
  const until = Date.now() + 5;
  while (Date.now() < until) {
    /* busy wait — 밀리초 단위라 허용한다 */
  }
}

/**
 * 파일 꼬리에서 마지막 이벤트를 읽는다.
 *
 * 전체를 읽지 않는 이유는 append 마다 O(n) 이 되어 원장이 커질수록
 * 느려지기 때문이다. 마지막 64KB 만 보고 마지막 줄을 찾는다.
 */
function readTailEvent(file: string): LedgerEvent | null {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  if (size === 0) return null;

  const window = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(window);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, window, size - window);
  } finally {
    closeSync(fd);
  }

  const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!) as LedgerEvent;
    } catch {
      // 잘린 줄일 수 있다. 하나 앞으로 간다.
    }
  }
  return null;
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
