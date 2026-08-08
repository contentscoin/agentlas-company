/**
 * War Room — 열린 상태로 남고, 오너만 닫는다 (Task 6.1, R3.7)
 *
 * R3.7 은 "War Room 을 소집하고 **오너만이 종결할 수 있게** 해야 한다" 이다.
 * 지금까지 소집은 반환값이었다 — `MeetingResult.status = 'war-room'` 이 잠깐
 * 떴다가 프로세스가 끝나면 사라졌다. 닫을 것이 없으니 "오너만 닫는다" 는
 * 절반도 구현되지 않았고, 원장에 소집 기록만 남은 채 회사는 아무 일 없다는
 * 듯 다음 작업으로 갔다.
 *
 * Task 5.1·6.2 와 같은 모양이다 — 통제 상태가 프로세스 안에 있었다.
 *
 * ## 닫는 것은 사람이다
 *
 * 자동 종결 경로를 두지 않는다. 시간이 지나서, 다음 회의가 성공해서, 또는
 * 재시도가 통과해서 저절로 닫히면 그것은 오너가 종결한 것이 아니다. R3.7 이
 * 막으려는 것이 바로 그 자동 해소다 — Critic 이 BLOCK 한 사안이나 두 번
 * 실패한 과제가 사람 눈을 거치지 않고 흘러가는 것.
 *
 * 그래서 이 파일에는 만료도, 조건부 자동 close 도 없다. 닫는 함수는 하나이고
 * **누가 닫았는지를 인자로 요구한다.**
 *
 * ## 안건 원문을 담지 않는다
 *
 * `failures.ts` 와 같은 규칙이다 (R9). 안건은 digest 로만 들고, 사람이 화면에서
 * 무엇인지 알아볼 수 있게 `subject` 에 **오너가 직접 친 제목**을 짧게 남긴다.
 * 회의 안건 전문이 아니라 목록에서 구분할 만큼만이다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '../zones/private.js';
import type { WarRoomCause } from './meeting.js';

export interface WarRoom {
  id: string;
  cause: WarRoomCause;
  /** 목록에서 구분할 만큼의 짧은 제목. 안건 전문이 아니다. */
  subject: string;
  /** 동일 과제 판정에 쓴 키. 안건 원문은 아니다. */
  agendaDigest: string;
  /** 소집을 부른 회의. 원장에서 그 회의를 찾는 실마리다. */
  runId: string;
  /** 소집 사유 한 줄. Critic BLOCKERS 또는 마지막 실패 사유. */
  reason: string;
  openedAt: string;
  /** 닫히지 않았으면 null. 자동으로 채워지는 경로는 없다. */
  closedAt: string | null;
  /** 누가 닫았는가. `device:phone-1` 처럼 신원이 남는다. */
  closedBy: string | null;
  /** 오너가 적은 종결 사유. 빈 문자열로 닫을 수 없다. */
  resolution: string | null;
}

export interface WarRoomStoreOptions {
  file?: string;
  now?: () => number;
  /** 식별자 생성. 시험에서 고정하기 위한 주입점. */
  newId?: () => string;
  onCorrupt?: (file: string) => void;
}

export function warRoomsFile(stateDir: string): string {
  return join(stateDir, 'org', 'warrooms.json');
}

export class WarRoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarRoomError';
  }
}

/**
 * 열린 War Room 장부.
 *
 * 손상되면 빈 장부로 본다. 여기서는 그 방향이 **여는 쪽**이다 — 열려 있던
 * 방이 사라지므로 통제가 약해진다. 그래서 조용히 넘어가지 않고 반드시
 * 알린다. 닫는 쪽(전부 열린 것으로 간주)은 만들어 낼 방의 내용이 없으므로
 * 애초에 불가능하다.
 */
export class WarRoomStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly onCorrupt: ((file: string) => void) | undefined;

  constructor(opts: WarRoomStoreOptions & { file: string }) {
    this.file = opts.file;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => `wr-${Math.random().toString(36).slice(2, 10)}`);
    this.onCorrupt = opts.onCorrupt;
  }

  private readAll(): WarRoom[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) {
        this.onCorrupt?.(this.file);
        return [];
      }
      return raw as WarRoom[];
    } catch {
      this.onCorrupt?.(this.file);
      return [];
    }
  }

  private writeAll(rooms: WarRoom[]): void {
    writePrivateFile(this.file, JSON.stringify(rooms, null, 2));
  }

  /** 닫힌 것까지 전부. 최신이 앞이다. */
  list(): WarRoom[] {
    return [...this.readAll()].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  /** 오너가 처리해야 할 것들. */
  open(): WarRoom[] {
    return this.list().filter((r) => r.closedAt === null);
  }

  get(id: string): WarRoom | null {
    return this.readAll().find((r) => r.id === id) ?? null;
  }

  /**
   * 소집한다.
   *
   * 같은 안건으로 이미 열린 방이 있으면 **새로 열지 않고 그 방을 돌려준다.**
   * 같은 과제가 계속 실패할 때마다 방이 쌓이면 목록이 소음이 되고, 소음이
   * 되면 오너가 목록을 안 본다 — `failures.ts` 에서 헛 소집을 피한 것과
   * 같은 이유다.
   */
  convene(input: {
    cause: WarRoomCause;
    subject: string;
    agendaDigest: string;
    runId: string;
    reason: string;
  }): { room: WarRoom; created: boolean } {
    const rooms = this.readAll();
    const existing = rooms.find((r) => r.closedAt === null && r.agendaDigest === input.agendaDigest);
    if (existing !== undefined) return { room: existing, created: false };

    const room: WarRoom = {
      id: this.newId(),
      cause: input.cause,
      subject: input.subject,
      agendaDigest: input.agendaDigest,
      runId: input.runId,
      reason: input.reason,
      openedAt: new Date(this.now()).toISOString(),
      closedAt: null,
      closedBy: null,
      resolution: null,
    };
    rooms.push(room);
    this.writeAll(rooms);
    return { room, created: true };
  }

  /**
   * 종결한다. **오너만 부를 수 있는 경로에서만 불려야 한다.**
   *
   * `by` 와 `resolution` 이 둘 다 필요하다. 누가 닫았는지 없으면 "오너만
   * 닫는다" 를 나중에 증명할 수 없고, 사유가 없으면 목록에서 지우는 것과
   * 다를 바가 없다. 이미 닫힌 방을 다시 닫지 않는다 — 두 번째 종결이 첫
   * 번째 기록을 덮으면 실제로 판단한 사람이 지워진다.
   */
  close(id: string, by: string, resolution: string): WarRoom {
    const rooms = this.readAll();
    const room = rooms.find((r) => r.id === id);
    if (room === undefined) throw new WarRoomError(`War Room ${id} 가 없다`);
    if (room.closedAt !== null) {
      throw new WarRoomError(`War Room ${id} 는 이미 ${room.closedBy ?? '누군가'} 가 종결했다`);
    }
    if (by.trim() === '') throw new WarRoomError('종결자가 필요하다');
    if (resolution.trim() === '') throw new WarRoomError('종결 사유가 필요하다');

    room.closedAt = new Date(this.now()).toISOString();
    room.closedBy = by;
    room.resolution = resolution.trim();
    this.writeAll(rooms);
    return room;
  }
}
