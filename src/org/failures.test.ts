import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agendaKey,
  failuresFile,
  FailureStore,
  normalizeAgenda,
  WAR_ROOM_THRESHOLD,
} from './failures.js';

let dir: string;
let file: string;
let store: FailureStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-fail-'));
  file = failuresFile(dir);
  store = new FailureStore({ file });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('동일 과제 판정', () => {
  it('의미가 아닌 차이는 무시한다', () => {
    expect(normalizeAgenda('  가격 정책을   정하자.  ')).toBe('가격 정책을 정하자');
    expect(normalizeAgenda('Pricing Policy')).toBe('pricing policy');
    expect(normalizeAgenda('가격 정책을 정하자!!')).toBe('가격 정책을 정하자');
  });

  it('같은 안건은 같은 키다', () => {
    expect(agendaKey('가격 정책을 정하자')).toBe(agendaKey(' 가격  정책을 정하자. '));
  });

  /**
   * 조사·어미는 손대지 않는다. 깎기 시작하면 어디서 멈출지 규칙이 없고,
   * 잘못 깎으면 서로 다른 안건이 하나로 묶여 엉뚱한 War Room 이 열린다.
   * 그래서 이 카운터는 **과소 계수하는 쪽으로** 틀린다.
   */
  it('표기가 다르면 다른 과제로 센다 — 과소 계수가 고른 방향이다', () => {
    expect(agendaKey('가격 정책을 정하자')).not.toBe(agendaKey('가격 정책 정하자'));
  });

  it('키에 안건 원문이 남지 않는다', () => {
    expect(agendaKey('영업비밀 프로젝트 X')).not.toContain('프로젝트');
    expect(agendaKey('영업비밀 프로젝트 X')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('연속 실패 장부', () => {
  it('없으면 연속도 없다', () => {
    expect(store.streak('가격 정책')).toBeNull();
  });

  it('실패를 쌓는다', () => {
    expect(store.recordFailure('가격 정책', 'r1').count).toBe(1);
    expect(store.recordFailure('가격 정책', 'r2').count).toBe(2);
    expect(store.streak('가격 정책')?.lastRunId).toBe('r2');
  });

  it('안건마다 따로 센다', () => {
    store.recordFailure('가격 정책', 'r1');
    store.recordFailure('채용 계획', 'r2');
    expect(store.streak('가격 정책')?.count).toBe(1);
    expect(store.streak('채용 계획')?.count).toBe(1);
  });

  it('끊으면 0 부터다', () => {
    store.recordFailure('가격 정책', 'r1');
    store.clear('가격 정책');
    expect(store.streak('가격 정책')).toBeNull();
    expect(store.recordFailure('가격 정책', 'r2').count).toBe(1);
  });

  it('오너 전용으로 쓴다', () => {
    store.recordFailure('가격 정책', 'r1');
    if (process.platform === 'win32') return; // ACL 은 별도 시험이다
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  /** 이 시험이 Task 6.2 의 요점이다 — 새 객체는 새 프로세스의 대역이다. */
  it('다른 인스턴스가 쌓은 실패를 본다', () => {
    new FailureStore({ file }).recordFailure('가격 정책', 'r1');
    expect(new FailureStore({ file }).recordFailure('가격 정책', 'r2').count).toBe(2);
  });

  it('안건 원문은 파일에 남지 않는다 (R9)', () => {
    store.recordFailure('영업비밀 프로젝트 X 인수', 'r1');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('영업비밀');
    expect(raw).not.toContain('프로젝트');
  });

  it('오래된 안건부터 버린다', () => {
    let t = Date.parse('2026-08-01T00:00:00.000Z');
    const s = new FailureStore({ file, keep: 2, now: () => (t += 60_000) });
    for (const a of ['a', 'b', 'c']) s.recordFailure(a, 'r');
    expect(s.streak('a')).toBeNull();
    expect(s.streak('b')?.count).toBe(1);
    expect(s.streak('c')?.count).toBe(1);
  });

  /**
   * 닫는 쪽(전부 실패로 간주)은 첫 회의부터 War Room 을 열어 통제를 소음으로
   * 만든다. 대신 조용히 넘어가지 않는다.
   */
  it('손상되면 빈 장부로 시작하되 알린다', () => {
    store.recordFailure('가격 정책', 'r1');
    writeFileSync(file, '{ 깨진', 'utf8');
    const seen: string[] = [];
    const s2 = new FailureStore({ file, onCorrupt: (f) => seen.push(f) });
    expect(s2.streak('가격 정책')).toBeNull();
    expect(seen).toEqual([file]);
  });
});

describe('문턱', () => {
  it('R3.7 의 문턱은 2회다', () => {
    expect(WAR_ROOM_THRESHOLD).toBe(2);
  });
});
