/**
 * 멱등성 기록과 일일 카운터 (R6.3, R6.5)
 *
 * 둘 다 "이미 일어난 일" 을 세는 것이라 한 파일에 둔다. 나누면 두 파일이
 * 서로 다른 시점의 사실을 말하게 되고, 그 사이에 중복 발행이 들어온다.
 *
 * **원장이 아니라 별도 파일인 이유.** 원장은 append-only 해시체인이라 조회가
 * 선형 탐색이다. 발행 직전마다 전체를 훑으면 이벤트가 쌓일수록 느려지고,
 * 느려진 만큼 중복 요청이 겹칠 창이 넓어진다. 여기는 인덱스다 — 정본은
 * 여전히 원장이고, 이 파일이 깨지면 원장에서 복구할 수 있다.
 *
 * 날짜 경계는 로컬 시간이다. "오늘 5개" 는 오너가 사는 날짜로 세는 것이
 * 자연스럽고, UTC 로 세면 한국 시간 오전 9시에 상한이 초기화된다.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Channel } from '../verbs/types.js';
import type { PublishEvidence } from './types.js';
import { ensurePrivateDir, writePrivateFile } from '../zones/private.js';

interface Record_ {
  key: string;
  channel: Channel;
  at: string;
  evidence: PublishEvidence;
}

interface FileShape {
  published: Record_[];
}

/** 로컬 날짜 키. `toISOString` 은 UTC 라 쓰지 않는다. */
export function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface PublishStoreOptions {
  file: string;
  now?: () => number;
}

export class PublishStore {
  private readonly file: string;
  private readonly now: () => number;

  constructor(opts: PublishStoreOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    ensurePrivateDir(dirname(this.file));
  }

  /**
   * 읽는다. 손상되면 빈 것으로 본다.
   *
   * 여기서의 안전한 방향은 다른 저장소와 반대다. 능력 스위치는 못 읽으면
   * OFF 로 접어 **덜** 하지만, 발행 기록을 못 읽으면 "발행한 적 없음" 이
   * 되어 중복 발행 쪽으로 기운다. 그래서 손상은 조용히 넘기지 않고
   * 호출자가 알 수 있도록 표시한다.
   */
  private load(): { data: FileShape; damaged: boolean } {
    if (!existsSync(this.file)) return { data: { published: [] }, damaged: false };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      return { data: { published: parsed.published ?? [] }, damaged: false };
    } catch {
      return { data: { published: [] }, damaged: true };
    }
  }

  private save(data: FileShape): void {
    writePrivateFile(this.file, JSON.stringify(data, null, 2));
  }

  get damaged(): boolean {
    return this.load().damaged;
  }

  /** 이미 발행한 요청인가 (R6.3). 그렇다면 원래 증거를 돌려준다. */
  find(key: string): PublishEvidence | null {
    return this.load().data.published.find((r) => r.key === key)?.evidence ?? null;
  }

  /** 오늘 이 채널로 나간 건수 (R6.5). */
  countToday(channel: Channel): number {
    const today = localDayKey(new Date(this.now()));
    return this.load().data.published.filter(
      (r) => r.channel === channel && localDayKey(new Date(r.at)) === today,
    ).length;
  }

  record(key: string, channel: Channel, evidence: PublishEvidence): void {
    const { data } = this.load();
    // 같은 키가 이미 있으면 덮어쓰지 않는다. 첫 발행의 증거가 정본이다.
    if (data.published.some((r) => r.key === key)) return;
    data.published.push({ key, channel, at: new Date(this.now()).toISOString(), evidence });
    this.save(data);
  }
}
