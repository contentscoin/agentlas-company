/**
 * 동일 과제 연속 실패 카운터 (Task 6.2, R3.7 전반부)
 *
 * R3.7 은 트리거가 둘이다 — "동일 과제가 2회 실패" **또는** "Critic 이 BLOCK".
 * 뒤쪽만 구현돼 있었다. `meeting.ts` 의 `stateDir` 주석은 "실패 카운터가 여기
 * 쓰인다" 고 약속하고 있었지만 그 카운터를 쓰는 코드가 없었다. 즉 카운터가
 * 프로세스 메모리에 있던 것이 아니라 **아예 없었고**, 같은 안건이 몇 번을
 * 실패하든 오너에게 올라가지 않았다.
 *
 * ## "동일 과제" 를 무엇으로 볼 것인가
 *
 * 안건은 오너가 타이핑하는 자유 텍스트다. 정규화한 문자열의 **정확 일치**로
 * 본다. 정규화는 의미가 아닌 것만 건드린다 — 유니코드 NFC, 앞뒤 공백,
 * 내부 연속 공백, 라틴 대소문자, 끝의 문장부호.
 *
 * 의미 유사도로 묶지 않는다. 묶으려면 좌석 호출이 필요하고, 그러면 **통제
 * 경로가 비결정적**이 된다 — 같은 입력이 어떤 날은 War Room 을 부르고 어떤
 * 날은 안 부른다. 통제는 그렇게 만들면 안 된다.
 *
 * 대가는 분명하다. `가격 정책을 정하자` 와 `가격 정책 정하자` 는 따로 센다.
 * 그래서 이 카운터는 **과소 계수하는 쪽으로 틀린다** — 걸릴 것을 놓칠 수는
 * 있어도, 서로 다른 안건을 묶어 엉뚱한 War Room 을 부르지는 않는다. 헛
 * 소집이 반복되면 오너가 War Room 을 무시하게 되고, 그러면 통제 자체가
 * 사라진다.
 *
 * ## 안건 원문을 저장하지 않는다
 *
 * 키는 정규화한 안건의 digest 다. 원장이 안건 **전문을 남기지 않는** 것과
 * 같은 규칙이다 (R9) — 여기만 예외로 두면 통제 상태 파일이 안건 아카이브가
 * 된다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestPayload } from '../ledger/ledger.js';
import { writePrivateFile } from '../zones/private.js';

/** R3.7 의 문턱. 이 횟수에 도달하면 War Room 이다. */
export const WAR_ROOM_THRESHOLD = 2;

export interface FailureStreak {
  /** 연속 실패 횟수. 성공하거나 War Room 이 열리면 0 으로 돌아간다. */
  count: number;
  firstAt: string;
  lastAt: string;
  /** 마지막 실패의 runId. 오너가 원장에서 그 회의를 찾는 실마리다. */
  lastRunId: string;
}

export interface FailureStoreOptions {
  file?: string;
  now?: () => number;
  /** 보관할 안건 수. 통제 상태이지 감사 기록이 아니다 — 감사 기록은 원장이다. */
  keep?: number;
}

type Shape = Record<string, FailureStreak>;

export function failuresFile(stateDir: string): string {
  return join(stateDir, 'org', 'failures.json');
}

/**
 * 안건을 비교 가능한 형태로 만든다.
 *
 * 의미를 건드리지 않는 것만 정규화한다. 조사나 어미는 손대지 않는다 —
 * 한국어에서 그것을 깎기 시작하면 어디서 멈출지 규칙이 없고, 잘못 깎으면
 * 서로 다른 안건이 같은 것으로 묶인다.
 */
export function normalizeAgenda(agenda: string): string {
  return agenda
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?。！？]+$/u, '')
    .toLowerCase();
}

/** 동일 과제 판정에 쓰는 키. 안건 원문은 남지 않는다. */
export function agendaKey(agenda: string): string {
  return digestPayload(normalizeAgenda(agenda));
}

/**
 * 안건별 연속 실패 장부.
 *
 * 손상되면 빈 장부로 본다. 닫는 쪽(전부 실패로 간주)은 첫 회의부터 War Room 을
 * 열어 통제를 소음으로 만든다. 이 파일은 0600 이라 정상 경로에서 손상되지
 * 않고, 손상은 `onCorrupt` 로 알린다.
 */
export class FailureStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly onCorrupt: ((file: string) => void) | undefined;

  constructor(opts: FailureStoreOptions & { onCorrupt?: (file: string) => void }) {
    if (opts.file === undefined) throw new Error('FailureStore: file 이 필요하다');
    this.file = opts.file;
    this.now = opts.now ?? (() => Date.now());
    this.keep = opts.keep ?? 200;
    this.onCorrupt = opts.onCorrupt;
  }

  private readAll(): Shape {
    if (!existsSync(this.file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        this.onCorrupt?.(this.file);
        return {};
      }
      return raw as Shape;
    } catch {
      this.onCorrupt?.(this.file);
      return {};
    }
  }

  private writeAll(next: Shape): void {
    // 오래된 안건부터 버린다. 무한히 쌓을 이유가 없다.
    const entries = Object.entries(next).sort(([, a], [, b]) => b.lastAt.localeCompare(a.lastAt));
    writePrivateFile(this.file, JSON.stringify(Object.fromEntries(entries.slice(0, this.keep)), null, 2));
  }

  streak(agenda: string): FailureStreak | null {
    return this.readAll()[agendaKey(agenda)] ?? null;
  }

  /** 실패 1회를 더하고 지금까지의 연속 횟수를 돌려준다. */
  recordFailure(agenda: string, runId: string): FailureStreak {
    const key = agendaKey(agenda);
    const all = this.readAll();
    const at = new Date(this.now()).toISOString();
    const prev = all[key];
    const next: FailureStreak = {
      count: (prev?.count ?? 0) + 1,
      firstAt: prev?.firstAt ?? at,
      lastAt: at,
      lastRunId: runId,
    };
    all[key] = next;
    this.writeAll(all);
    return next;
  }

  /**
   * 연속을 끊는다.
   *
   * 성공한 회의는 물론이고 **War Room 이 열린 경우에도** 끊는다. 카운터의
   * 임무는 오너를 부르는 것이고 이미 불렸다 — 그대로 두면 다음 실패 한 번에
   * 즉시 다시 소집되어, 한 번 어긋난 안건이 영구히 경보를 낸다.
   */
  clear(agenda: string): void {
    const key = agendaKey(agenda);
    const all = this.readAll();
    if (all[key] === undefined) return;
    delete all[key];
    this.writeAll(all);
  }
}
