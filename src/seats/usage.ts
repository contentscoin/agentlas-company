/**
 * 좌석 사용량 영속화 (Task 5.1, R2)
 *
 * 브로커의 `used`/`exhausted` 는 프로세스 메모리에만 있었다. `company` 는
 * 부를 때마다 새 프로세스이므로 **모든 호출이 빈 장부로 시작했다** — 재시작
 * 시 초기화되는 정도가 아니라 실질적으로 한 번도 누적되지 않았다.
 *
 * 실측으로 확인한 결과:
 *   프로세스 A  claude 소진시킴 → used=1 exhausted=true
 *   프로세스 B  같은 상태 디렉터리, 새 프로세스 → used=0 exhausted=false
 *
 * 결과가 둘이다. (1) `limit` 검사가 구조적으로 도달 불가였다. (2) 벤더가
 * "주간 한도에 걸렸다" 고 말해 준 사실을 다음 호출이 잊고 같은 벽에 다시
 * 부딪쳤다.
 *
 * ## 두 값의 실패 방향이 반대다
 *
 * `used` 는 **닫는 쪽으로** 틀려야 한다. 창을 일찍 롤오버하면 한도가
 * 우회되는데, 그것이 애초의 결함이다. 그래서 창 경계를 계산할 수 없으면
 * 카운터를 리셋하지 않고, 대신 **그 좌석에는 한도를 집행하지 않는다**
 * (`limitEnforceable`). 경계를 모르는 채로 막으면 영원히 막힌다.
 *
 * `exhausted` 는 **여는 쪽으로** 틀려도 된다. 너무 일찍 풀면 호출 하나가
 * 헛돌고 다시 소진으로 표시될 뿐이다. 너무 늦게 풀면 좌석이 사라진 채로
 * 회사가 멈춘다. 그래서 해제 시각을 **모를 때는 배제하지 않고 강등**한다 —
 * 후보 맨 뒤로 밀되 목록에서 빼지는 않는다.
 *
 * ## 지어내지 않는다
 *
 * 해제 시각은 벤더가 자기 입으로 말한 것만 쓴다. claude 실측 문구가
 * `resets 8pm (Asia/Seoul)` 을 담고 있으므로 그것을 판다. 문구에 없으면
 * 사양의 `resetAt` 을, 그것도 없으면 null 이다 — 임의의 유예 시간을
 * 만들어 넣지 않는다.
 *
 * 주간 창의 **요일**은 실측된 적이 없다. 그래서 "다음 20:00" 은 해제
 * 시각의 **하한**이다. 하한을 쓰면 한 번 일찍 재시도할 수 있는데, 그것은
 * 위에서 정한 허용 방향이다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeatId } from '../ledger/types.js';
import { resolveState } from '../paths.js';
import { writePrivateFile } from '../zones/private.js';
import type { SeatSpec } from './spec.js';

/** 창을 계산할 수 없을 때 쓰는 키. 이 키에서는 카운터가 리셋되지 않는다. */
export const UNBOUNDED_WINDOW = 'unbounded';

export interface SeatUsage {
  /** 이 카운터가 속한 창. 바뀌면 0 부터 다시 센다. */
  windowKey: string;
  used: number;
  /** 소진으로 확인된 시각(ISO). null 이면 소진 아님. */
  exhaustedAt: string | null;
  /**
   * 소진이 풀리는 시각(ISO). null 이면 **모른다**는 뜻이고,
   * 그때는 배제가 아니라 강등이다.
   */
  exhaustedUntil: string | null;
}

function empty(windowKey: string): SeatUsage {
  return { windowKey, used: 0, exhaustedAt: null, exhaustedUntil: null };
}

/** 저장 파일의 기본 위치. 상태 루트 아래, 소유자 전용이다. */
export function usageFile(): string {
  return join(resolveState(), 'seats', 'usage.json');
}

// ── 창 경계 ───────────────────────────────────────────────────────────────

/** `'20:00 Asia/Seoul'` 를 시·분·타임존으로 나눈다. 모양이 다르면 null. */
export function parseResetAt(
  resetAt: string | null,
): { hour: number; minute: number; zone: string } | null {
  if (resetAt === null) return null;
  const m = /^(\d{1,2}):(\d{2})\s+(\S+)$/.exec(resetAt.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, zone: m[3]! };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 해당 타임존의 벽시계. 존 이름이 잘못되면 null. */
function wallClock(
  ms: number,
  zone: string,
): { date: string; hour: number; minute: number; dow: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const [y, mo, d] = [get('year'), get('month'), get('day')];
    if (y === '' || mo === '' || d === '') return null;
    const dow = DOW.indexOf(get('weekday'));
    if (dow < 0) return null;
    // hourCycle 에 따라 자정이 '24' 로 나오는 구현이 있다. 0 으로 접는다.
    const hour = Number(get('hour')) % 24;
    return { date: `${y}-${mo}-${d}`, hour, minute: Number(get('minute')), dow };
  } catch {
    return null;
  }
}

/**
 * 지금이 속한 창의 키.
 *
 * 계산에 필요한 것: 창 종류(`day`/`week`), 리셋 시각, 그리고 주간이면
 * 리셋 **요일**. 하나라도 실측되지 않았으면 `UNBOUNDED_WINDOW` 다 —
 * 그 좌석의 카운터는 리셋되지 않고, 대신 한도가 집행되지 않는다.
 */
export function currentWindowKey(spec: SeatSpec, now: number): string {
  const { window, resetDay } = spec.quota;
  if (window !== 'day' && window !== 'week') return UNBOUNDED_WINDOW;
  const at = parseResetAt(spec.quota.resetAt);
  if (at === null) return UNBOUNDED_WINDOW;
  const nowWall = wallClock(now, at.zone);
  if (nowWall === null) return UNBOUNDED_WINDOW;

  const timePassed =
    nowWall.hour > at.hour || (nowWall.hour === at.hour && nowWall.minute >= at.minute);

  let daysBack: number;
  if (window === 'day') {
    // 아직 오늘 경계를 안 지났으면 어제 경계가 창의 시작이다.
    daysBack = timePassed ? 0 : 1;
  } else {
    if (resetDay === undefined || resetDay === null) return UNBOUNDED_WINDOW;
    if (!Number.isInteger(resetDay) || resetDay < 0 || resetDay > 6) return UNBOUNDED_WINDOW;
    const sinceDay = (nowWall.dow - resetDay + 7) % 7;
    // 리셋 요일 당일인데 시각을 아직 안 지났으면 지난주 경계가 창의 시작이다.
    daysBack = sinceDay === 0 && !timePassed ? 7 : sinceDay;
  }

  const startWall = daysBack === 0 ? nowWall : wallClock(now - daysBack * 86_400_000, at.zone);
  if (startWall === null) return UNBOUNDED_WINDOW;
  const hh = String(at.hour).padStart(2, '0');
  const mm = String(at.minute).padStart(2, '0');
  return `${at.zone}/${window}/${startWall.date}T${hh}:${mm}`;
}

export class QuotaSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaSpecError';
  }
}

/**
 * 한도를 집행할 수 있는 사양인지 확인한다. 아니면 던진다.
 *
 * 경계를 못 잡는 창에 한도를 걸면 둘 중 하나다 — 집행하면 카운터가 영원히
 * 안 줄어 좌석이 영구히 죽고, 집행하지 않으면 한도가 조용히 무시된다.
 * 둘 다 나쁘고 둘 다 소리 없이 일어난다. 그래서 그 사양 자체를 거부한다.
 *
 * 실무적으로는 순서를 강제하는 장치다. 나중에 claude 주간 한도를 실측해
 * `limit` 을 채우려는 사람은 여기서 막혀 **리셋 요일도 함께 실측**하게 된다.
 */
export function assertQuotaCoherent(spec: SeatSpec): void {
  if (spec.quota.limit === null) return;
  if (currentWindowKey(spec, Date.now()) !== UNBOUNDED_WINDOW) return;
  const missing =
    spec.quota.window === 'unknown'
      ? 'quota.window 가 unknown 이다'
      : spec.quota.resetAt === null
        ? 'quota.resetAt 이 없다'
        : 'quota.resetDay 가 없다 (주간 창은 요일이 있어야 경계가 잡힌다)';
  throw new QuotaSpecError(
    `좌석 ${spec.id}: 한도 ${String(spec.quota.limit)} 를 집행할 창 경계를 계산할 수 없다 — ${missing}. ` +
      '리셋 경계를 실측해 채우거나 limit 을 null 로 두세요.',
  );
}

/**
 * 이 좌석에 한도를 집행할 수 있는가.
 *
 * 창 경계를 못 잡으면 카운터가 영원히 누적되므로, 한도를 걸면 언젠가
 * 그 좌석이 영구히 막힌다. 그래서 집행하지 않고 집계만 한다 —
 * `status()` 가 그 사실을 그대로 보여 준다.
 */
export function limitEnforceable(spec: SeatSpec, now: number): boolean {
  if (spec.quota.limit === null) return false;
  return currentWindowKey(spec, now) !== UNBOUNDED_WINDOW;
}

/**
 * 벤더가 말한 해제 시각을 판다.
 *
 * 실측 문구: `You've hit your weekly limit · resets 8pm (Asia/Seoul)`
 *
 * 화이트리스트다 — 이 모양이 아니면 null 이고, null 은 "모른다" 로 흘러
 * 배제가 아니라 강등이 된다. 못 알아본 문구를 추측해서 유예 시간을
 * 만들어 내지 않는다.
 *
 * 돌려주는 값은 **하한**이다. 주간 창의 요일이 실측되지 않았으므로
 * "다음 그 시각" 보다 늦게 풀릴 수 있다.
 */
export function parseResetHint(
  text: string,
  spec: SeatSpec,
  now: number,
): string | null {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([\w+-]+\/[\w+-]+)\))?/i.exec(text);
  const fallback = parseResetAt(spec.quota.resetAt);

  let hour: number;
  let minute: number;
  let zone: string;
  if (m) {
    const raw = Number(m[1]);
    const mer = m[3]?.toLowerCase();
    if (raw > 23) return null;
    hour = mer === 'pm' ? (raw % 12) + 12 : mer === 'am' ? raw % 12 : raw;
    minute = m[2] === undefined ? 0 : Number(m[2]);
    if (minute > 59) return null;
    const parsedZone = m[4] ?? fallback?.zone;
    if (parsedZone === undefined) return null;
    zone = parsedZone;
  } else if (fallback !== null) {
    ({ hour, minute, zone } = fallback);
  } else {
    return null;
  }

  return nextOccurrence(hour, minute, zone, now);
}

/** 그 타임존에서 지금 이후 처음 오는 hh:mm 의 절대 시각(ISO). */
export function nextOccurrence(
  hour: number,
  minute: number,
  zone: string,
  now: number,
): string | null {
  const wall = wallClock(now, zone);
  if (wall === null) return null;
  const nowMin = wall.hour * 60 + wall.minute;
  const targetMin = hour * 60 + minute;
  const deltaMin = targetMin > nowMin ? targetMin - nowMin : targetMin - nowMin + 1440;
  // 벽시계 차이를 그대로 더한다. 존의 UTC 오프셋을 직접 다루지 않으므로
  // DST 전환일에는 최대 한 시간 어긋날 수 있다 — 하한이라 허용 방향이다.
  return new Date(now + deltaMin * 60_000).toISOString();
}

// ── 저장소 ────────────────────────────────────────────────────────────────

export interface UsageStoreOptions {
  file?: string;
  now?: () => number;
  /** 파일이 손상돼 빈 장부로 시작할 때 알린다. 조용히 넘어가지 않는다. */
  onCorrupt?: (file: string) => void;
}

type Shape = Partial<Record<SeatId, SeatUsage>>;

/**
 * 좌석 사용량 장부.
 *
 * 손상되면 빈 장부로 본다. 닫는 쪽(전부 소진으로 간주)은 회사를 멈추고,
 * 이 파일은 0600 이라 손상 자체가 정상 경로에서는 일어나지 않는다.
 * 대신 조용히 넘어가지 않고 `onCorrupt` 로 알린다 — 카운터가 리셋됐다는
 * 사실 자체가 오너가 봐야 할 신호다.
 */
export class SeatUsageStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly onCorrupt: ((file: string) => void) | undefined;

  constructor(opts: UsageStoreOptions = {}) {
    this.file = opts.file ?? usageFile();
    this.now = opts.now ?? (() => Date.now());
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
    writePrivateFile(this.file, JSON.stringify(next, null, 2));
  }

  /**
   * 지금 창 기준의 사용량. 창이 바뀌었으면 0 부터다.
   *
   * 창 롤오버는 읽을 때 판정한다 — 저장된 키가 지금 키와 다르면 지난
   * 창의 기록이고, 지난 창의 카운터는 지금 한도와 무관하다.
   */
  get(seat: SeatId, spec: SeatSpec): SeatUsage {
    const key = currentWindowKey(spec, this.now());
    const stored = this.readAll()[seat];
    if (stored === undefined) return empty(key);
    if (stored.windowKey !== key) {
      // 창이 넘어갔다. 카운터는 리셋되지만 소진 해제 시각은 별개다 —
      // 벤더가 말한 시각이 아직 안 왔으면 여전히 소진이다.
      return { ...empty(key), exhaustedAt: stored.exhaustedAt, exhaustedUntil: stored.exhaustedUntil };
    }
    return stored;
  }

  /**
   * 사용 1회를 더한다.
   *
   * 쓰기 직전에 다시 읽어 병합한다. `company` 프로세스가 동시에 둘 이상
   * 돌 수 있고, 읽고-고치고-쓰기 사이에 끼어들면 카운트가 사라진다.
   * 병합은 큰 쪽을 남기므로 카운터가 뒤로 가지 않는다 — 락 없이 얻을 수
   * 있는 보장은 여기까지이고, 닫는 쪽이라 허용된다.
   */
  bump(seat: SeatId, spec: SeatSpec): SeatUsage {
    const key = currentWindowKey(spec, this.now());
    const all = this.readAll();
    const stored = all[seat];
    const base = stored !== undefined && stored.windowKey === key ? stored.used : 0;
    const next: SeatUsage = {
      windowKey: key,
      used: base + 1,
      exhaustedAt: stored?.exhaustedAt ?? null,
      exhaustedUntil: stored?.exhaustedUntil ?? null,
    };
    all[seat] = next;
    this.writeAll(all);
    return next;
  }

  /** 소진으로 표시한다. `until` 이 null 이면 "해제 시각을 모른다" 는 뜻이다. */
  markExhausted(seat: SeatId, spec: SeatSpec, until: string | null): void {
    const all = this.readAll();
    const current = all[seat] ?? empty(currentWindowKey(spec, this.now()));
    all[seat] = {
      ...current,
      exhaustedAt: new Date(this.now()).toISOString(),
      exhaustedUntil: until,
    };
    this.writeAll(all);
  }

  /** 소진을 푼다. 그 좌석이 실제로 답을 준 순간이 가장 확실한 근거다. */
  clearExhausted(seat: SeatId): void {
    const all = this.readAll();
    const current = all[seat];
    if (current === undefined || current.exhaustedAt === null) return;
    all[seat] = { ...current, exhaustedAt: null, exhaustedUntil: null };
    this.writeAll(all);
  }
}

/**
 * 지금 이 좌석을 어떻게 다룰 것인가.
 *
 *   ok        평소대로 쓴다
 *   excluded  해제 시각이 아직 안 왔다. 후보에서 뺀다
 *   demoted   소진이지만 해제 시각을 모른다. 맨 뒤로 민다 — 빼지는 않는다
 */
export function exhaustionState(
  usage: SeatUsage,
  now: number,
): { kind: 'ok' } | { kind: 'excluded'; until: string } | { kind: 'demoted' } {
  if (usage.exhaustedAt === null) return { kind: 'ok' };
  if (usage.exhaustedUntil === null) return { kind: 'demoted' };
  return Date.parse(usage.exhaustedUntil) > now
    ? { kind: 'excluded', until: usage.exhaustedUntil }
    : { kind: 'ok' };
}
