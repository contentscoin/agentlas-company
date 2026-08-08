import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warRoomsFile, WarRoomError, WarRoomStore } from './warroom.js';

let dir: string;
let file: string;
let store: WarRoomStore;
let n = 0;

const AT = Date.parse('2026-08-08T00:00:00.000Z');

function open(over: Partial<Parameters<WarRoomStore['convene']>[0]> = {}) {
  return store.convene({
    cause: 'critic-block',
    subject: '가격 정책을 정하자',
    agendaDigest: 'digest-a',
    runId: 'r1',
    reason: '근거 없음',
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-wr-'));
  file = warRoomsFile(dir);
  n = 0;
  store = new WarRoomStore({ file, now: () => AT, newId: () => `wr-${++n}` });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('소집', () => {
  it('열린 방으로 남는다 — 반환값으로 끝나지 않는다', () => {
    const { room, created } = open();
    expect(created).toBe(true);
    expect(store.open().map((r) => r.id)).toEqual([room.id]);
    // 새 인스턴스는 새 프로세스의 대역이다
    expect(new WarRoomStore({ file }).open()).toHaveLength(1);
  });

  /**
   * 같은 과제가 계속 실패할 때마다 방이 쌓이면 목록이 소음이 되고, 소음이
   * 되면 오너가 목록을 안 본다.
   */
  it('같은 안건으로 두 번 열지 않는다', () => {
    const a = open();
    const b = open({ runId: 'r2', cause: 'repeat-failure' });
    expect(b.created).toBe(false);
    expect(b.room.id).toBe(a.room.id);
    expect(store.open()).toHaveLength(1);
  });

  it('다른 안건은 따로 연다', () => {
    open();
    open({ agendaDigest: 'digest-b', subject: '채용 계획' });
    expect(store.open()).toHaveLength(2);
  });

  it('닫힌 방이 있으면 같은 안건으로 다시 열린다', () => {
    const a = open();
    store.close(a.room.id, 'device:phone', '확인했다');
    const b = open({ runId: 'r2' });
    expect(b.created).toBe(true);
    expect(b.room.id).not.toBe(a.room.id);
  });

  it('오너 전용으로 쓴다', () => {
    open();
    if (process.platform === 'win32') return; // ACL 은 별도 시험이다
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('종결 — 오너만, 사유와 함께 (R3.7)', () => {
  it('누가 닫았는지와 왜 닫았는지가 남는다', () => {
    const { room } = open();
    const closed = store.close(room.id, 'device:phone-1', '  재시도해서 통과 확인  ');
    expect(closed.closedBy).toBe('device:phone-1');
    expect(closed.resolution).toBe('재시도해서 통과 확인');
    expect(closed.closedAt).not.toBeNull();
    expect(store.open()).toHaveLength(0);
  });

  /** 사유 없는 종결은 목록에서 지우는 것과 다를 바가 없다. */
  it('빈 사유로 닫을 수 없다', () => {
    const { room } = open();
    expect(() => store.close(room.id, 'device:phone', '   ')).toThrow(WarRoomError);
    expect(store.open()).toHaveLength(1);
  });

  it('종결자 없이 닫을 수 없다', () => {
    const { room } = open();
    expect(() => store.close(room.id, '', '확인했다')).toThrow(WarRoomError);
  });

  /** 두 번째 종결이 첫 기록을 덮으면 실제로 판단한 사람이 지워진다. */
  it('이미 닫힌 방을 다시 닫지 않는다', () => {
    const { room } = open();
    store.close(room.id, 'device:phone-1', '첫 판단');
    expect(() => store.close(room.id, 'device:phone-2', '두 번째')).toThrow(/이미/);
    expect(store.get(room.id)?.resolution).toBe('첫 판단');
  });

  it('없는 방은 던진다', () => {
    expect(() => store.close('wr-없음', 'device:phone', '사유')).toThrow(WarRoomError);
  });

  /**
   * 시간이 지나서, 다음 회의가 성공해서, 재시도가 통과해서 저절로 닫히면
   * 그것은 오너가 종결한 것이 아니다. R3.7 이 막으려는 것이 그 자동 해소다.
   */
  it('자동으로 닫히는 경로가 없다', () => {
    const { room } = open();
    // 만료도, 조건부 종결도 없다 — 시간이 아무리 흘러도 열린 채다
    const later = new WarRoomStore({ file, now: () => AT + 365 * 86_400_000 });
    expect(later.open().map((r) => r.id)).toEqual([room.id]);
  });
});

describe('장부', () => {
  /**
   * 안건 **전문**을 담을 필드가 없다 (R9). 담을 곳이 없으면 실수로 담을
   * 수도 없다 — `zones/lint.ts` 의 `Finding` 과 같은 규칙이다.
   */
  it('안건 원문을 담을 자리가 없다 (R9)', () => {
    open({ agendaDigest: 'digest-x' });
    const record = JSON.parse(readFileSync(file, 'utf8'))[0] as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'agendaDigest', 'cause', 'closedAt', 'closedBy', 'id',
      'openedAt', 'reason', 'resolution', 'runId', 'subject',
    ]);
    expect(record.agendaDigest).toBe('digest-x');
  });

  it('최신이 앞이다', () => {
    let t = AT;
    const s = new WarRoomStore({ file, now: () => (t += 1000), newId: () => `wr-${++n}` });
    s.convene({ cause: 'critic-block', subject: 'a', agendaDigest: 'a', runId: 'r', reason: 'x' });
    s.convene({ cause: 'critic-block', subject: 'b', agendaDigest: 'b', runId: 'r', reason: 'x' });
    expect(s.list().map((r) => r.subject)).toEqual(['b', 'a']);
  });

  /**
   * 여기서 손상은 **여는 쪽**이다 — 열려 있던 방이 사라져 통제가 약해진다.
   * 그래서 반드시 알린다.
   */
  it('손상되면 빈 장부로 보되 알린다', () => {
    open();
    writeFileSync(file, '{ 깨진', 'utf8');
    const seen: string[] = [];
    const s2 = new WarRoomStore({ file, onCorrupt: (f) => seen.push(f) });
    expect(s2.open()).toHaveLength(0);
    expect(seen).toEqual([file]);
  });
});
