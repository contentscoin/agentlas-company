/**
 * 실행 락 (R12.4)
 *
 * 같은 레시피가 두 번 동시에 돌면 발행이 중복되고 좌석 예산이 두 배로 탄다.
 * OS 스케줄러가 지난 실행이 끝나기 전에 다음 실행을 띄우는 일은 흔하다.
 *
 * 죽은 락을 다루는 방식이 중요하다. 정전으로 프로세스가 사라지면 락 파일만
 * 남는데, 그때 영원히 잠겨 있으면 무인 운영이 멈춘다. 그래서 락에 pid 와
 * 부팅 세션을 적고, 둘 중 하나라도 어긋나면 죽은 락으로 보고 회수한다.
 *
 * 생존 확인에 signal 0 을 쓰지 않는다 — Windows 에서 그것은 확인이 아니라
 * 종료다. `proc.isAlive` 가 tasklist 조회로 대신한다.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAlive } from '../proc/index.js';
import { currentBootId } from '../capabilities/store.js';

export interface LockInfo {
  recipe: string;
  runId: string;
  pid: number;
  bootId: string;
  acquiredAt: string;
}

export type AcquireResult =
  | { ok: true; lock: LockInfo; reclaimedFrom?: LockInfo }
  | { ok: false; heldBy: LockInfo };

export class RunLock {
  private readonly file: string;
  private readonly bootId: () => string;

  constructor(file: string, bootId: () => string = currentBootId) {
    this.file = file;
    this.bootId = bootId;
    mkdirSync(dirname(file), { recursive: true });
  }

  read(): LockInfo | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as LockInfo;
    } catch {
      // 깨진 락 파일은 락이 아니다.
      return null;
    }
  }

  /** 죽은 락인가. 부팅이 달라졌거나 프로세스가 사라졌으면 죽었다. */
  isStale(lock: LockInfo): boolean {
    if (lock.bootId !== this.bootId()) return true;
    if (lock.pid === process.pid) return false;
    return !isAlive(lock.pid);
  }

  acquire(recipe: string, runId: string): AcquireResult {
    const existing = this.read();
    if (existing !== null && !this.isStale(existing)) {
      return { ok: false, heldBy: existing };
    }

    const lock: LockInfo = {
      recipe,
      runId,
      pid: process.pid,
      bootId: this.bootId(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(this.file, JSON.stringify(lock, null, 2), 'utf8');
    return existing === null ? { ok: true, lock } : { ok: true, lock, reclaimedFrom: existing };
  }

  release(): void {
    rmSync(this.file, { force: true });
  }
}
