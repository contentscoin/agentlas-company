import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, digestPayload, hashEvent } from './ledger.js';
import { GENESIS_HASH, type LedgerEvent } from './types.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-ledger-'));
  file = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sysActor = { kind: 'system' as const, id: 'test' };

describe('append 와 체인', () => {
  it('첫 이벤트는 제네시스 해시를 잇는다', () => {
    const led = Ledger.open(file);
    const e = led.append({ actor: sysActor, kind: 'seat.call' });
    expect(e.seq).toBe(1);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.hash).toHaveLength(64);
  });

  it('seq 가 1부터 빈틈없이 증가한다', () => {
    const led = Ledger.open(file);
    for (let i = 0; i < 5; i++) led.append({ actor: sysActor, kind: 'seat.call' });
    expect(led.all().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('각 이벤트가 이전 이벤트의 해시를 담는다', () => {
    const led = Ledger.open(file);
    const a = led.append({ actor: sysActor, kind: 'ingest' });
    const b = led.append({ actor: sysActor, kind: 'publish' });
    expect(b.prevHash).toBe(a.hash);
  });

  it('append-only 다 — 기존 줄을 다시 쓰지 않는다', () => {
    const led = Ledger.open(file);
    led.append({ actor: sysActor, kind: 'ingest' });
    const first = readFileSync(file, 'utf8');
    led.append({ actor: sysActor, kind: 'publish' });
    const second = readFileSync(file, 'utf8');
    expect(second.startsWith(first)).toBe(true);
  });

  it('재시작 후에도 체인을 이어 쓴다', () => {
    const led1 = Ledger.open(file);
    const a = led1.append({ actor: sysActor, kind: 'ingest' });

    const led2 = Ledger.open(file);
    expect(led2.height).toBe(1);
    const b = led2.append({ actor: sysActor, kind: 'publish' });
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(led2.verify().ok).toBe(true);
  });
});

describe('verify — 개조 검출 (R9.2)', () => {
  it('건드리지 않은 원장은 통과한다', () => {
    const led = Ledger.open(file);
    for (let i = 0; i < 4; i++) led.append({ actor: sysActor, kind: 'gate.verdict' });
    const r = led.verify();
    expect(r.ok).toBe(true);
    expect(r.count).toBe(4);
    expect(r.lastGoodSeq).toBe(4);
    expect(r.problems).toEqual([]);
  });

  it('빈 원장도 통과한다', () => {
    expect(Ledger.open(file).verify().ok).toBe(true);
  });

  it('내용을 고치면 hash-mismatch 로 잡는다', () => {
    const led = Ledger.open(file);
    led.append({ actor: sysActor, kind: 'publish', summary: '원본' });
    led.append({ actor: sysActor, kind: 'publish', summary: '뒤 이벤트' });

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]!) as LedgerEvent;
    tampered.summary = '조작됨';
    lines[0] = JSON.stringify(tampered);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const r = Ledger.open(file).verify();
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.problem).toBe('hash-mismatch');
    expect(r.lastGoodSeq).toBe(0);
  });

  it('해시까지 다시 계산해 고쳐도 그 다음 이벤트의 체인이 깨진다', () => {
    const led = Ledger.open(file);
    led.append({ actor: sysActor, kind: 'publish', summary: '원본' });
    led.append({ actor: sysActor, kind: 'publish', summary: '뒤 이벤트' });

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const ev = JSON.parse(lines[0]!) as LedgerEvent;
    ev.summary = '정교하게 조작됨';
    const { hash: _drop, ...rest } = ev;
    lines[0] = JSON.stringify({ ...rest, hash: hashEvent(rest) });
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const r = Ledger.open(file).verify();
    expect(r.ok).toBe(false);
    // 1번 줄은 자체 정합하지만 2번 줄의 prevHash 가 더 이상 맞지 않는다
    expect(r.problems[0]?.problem).toBe('chain-break');
    expect(r.lastGoodSeq).toBe(1);
  });

  it('이벤트를 삭제하면 seq-gap 으로 잡는다', () => {
    const led = Ledger.open(file);
    for (let i = 0; i < 3; i++) led.append({ actor: sysActor, kind: 'deny' });

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n', 'utf8');

    const r = Ledger.open(file).verify();
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.problem).toBe('seq-gap');
  });

  it('잘린 마지막 줄을 보고하되 그 이전까지는 신뢰 가능하다고 알린다', () => {
    const led = Ledger.open(file);
    led.append({ actor: sysActor, kind: 'ingest' });
    led.append({ actor: sysActor, kind: 'ingest' });
    appendFileSync(file, '{"seq":3,"partial":', 'utf8');

    const r = Ledger.open(file).verify();
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.problem).toBe('unparseable');
    expect(r.lastGoodSeq).toBe(2);
  });
});

describe('동시 쓰기 (실제 사고에서 나온 테스트)', () => {
  it('같은 파일을 두 인스턴스가 번갈아 써도 체인이 온전하다', () => {
    // 실제로 겪은 사고: 레시피 실행과 중복 실행 거부가 동시에 append 해서
    // seq 2 가 두 번 쓰였고 체인이 깨졌다. 각자 자기 메모리의 seq 를 믿었기 때문이다.
    const a = Ledger.open(file);
    const b = Ledger.open(file);

    a.append({ actor: sysActor, kind: 'decision', summary: 'A1' });
    b.append({ actor: sysActor, kind: 'deny', summary: 'B1' });
    a.append({ actor: sysActor, kind: 'decision', summary: 'A2' });
    b.append({ actor: sysActor, kind: 'deny', summary: 'B2' });

    const r = Ledger.open(file).verify();
    expect(r.ok, JSON.stringify(r.problems)).toBe(true);
    expect(r.count).toBe(4);
    expect(a.all().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('나중에 연 인스턴스가 앞선 쓰기를 덮어쓰지 않는다', () => {
    const a = Ledger.open(file);
    a.append({ actor: sysActor, kind: 'ingest' });
    a.append({ actor: sysActor, kind: 'ingest' });

    // b 는 이벤트가 2건일 때 열렸다고 가정
    const b = Ledger.open(file);
    a.append({ actor: sysActor, kind: 'ingest' });
    const fromB = b.append({ actor: sysActor, kind: 'publish' });

    expect(fromB.seq).toBe(4);
    expect(Ledger.open(file).verify().ok).toBe(true);
  });

  it('락 파일을 남기지 않는다', () => {
    const led = Ledger.open(file);
    led.append({ actor: sysActor, kind: 'ingest' });
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});

describe('query (R9.4)', () => {
  const t = (n: number): string => new Date(Date.UTC(2026, 6, 30, 0, 0, n)).toISOString();

  function seed(): Ledger {
    const led = Ledger.open(file);
    led.append({ actor: { kind: 'agent', id: 'ceo', seat: 'claude' }, kind: 'meeting.turn', at: t(1), runId: 'r1' });
    led.append({ actor: { kind: 'agent', id: 'growth', seat: 'codex' }, kind: 'publish', at: t(2), runId: 'r1', level: 'L1' });
    led.append({ actor: { kind: 'system', id: 'gate' }, kind: 'deny', at: t(3), runId: 'r2', level: 'L3' });
    led.append({ actor: { kind: 'agent', id: 'growth', seat: 'codex' }, kind: 'publish', at: t(4), runId: 'r2', tainted: true });
    return led;
  }

  it('종류로 거른다', () => {
    expect(seed().query({ kind: 'publish' })).toHaveLength(2);
  });

  it('종류 여러 개로 거른다', () => {
    expect(seed().query({ kind: ['deny', 'meeting.turn'] })).toHaveLength(2);
  });

  it('주체로 거른다', () => {
    expect(seed().query({ actorId: 'growth' })).toHaveLength(2);
  });

  it('등급으로 거른다', () => {
    expect(seed().query({ level: 'L3' })).toHaveLength(1);
  });

  it('시간 범위로 거른다', () => {
    expect(seed().query({ since: t(2), until: t(3) })).toHaveLength(2);
  });

  it('오염 여부로 거른다 — 표시 없는 것은 오염 아님으로 취급한다', () => {
    const led = seed();
    expect(led.query({ tainted: true })).toHaveLength(1);
    expect(led.query({ tainted: false })).toHaveLength(3);
  });

  it('limit 은 최근 것을 남긴다', () => {
    const got = seed().query({ limit: 2 });
    expect(got.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('필터가 없으면 전부 돌려준다', () => {
    expect(seed().query()).toHaveLength(4);
  });
});

describe('replay (R9.5)', () => {
  it('한 실행의 이벤트를 순서대로 재생한다', () => {
    const led = Ledger.open(file);
    led.append({ actor: sysActor, kind: 'seat.call', runId: 'A' });
    led.append({ actor: sysActor, kind: 'seat.call', runId: 'B' });
    led.append({ actor: sysActor, kind: 'publish', runId: 'A' });

    const a = led.replay('A');
    expect(a.map((e) => e.seq)).toEqual([1, 3]);
    expect(led.replay('없는런')).toEqual([]);
  });
});

describe('digestPayload', () => {
  it('본문 대신 digest 를 남긴다 — 같은 본문은 같은 digest', () => {
    expect(digestPayload('hello')).toBe(digestPayload('hello'));
    expect(digestPayload('hello')).not.toBe(digestPayload('hello '));
    expect(digestPayload('hello')).toHaveLength(64);
  });
});
