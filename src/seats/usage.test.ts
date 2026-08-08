import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertQuotaCoherent,
  currentWindowKey,
  exhaustionState,
  limitEnforceable,
  nextOccurrence,
  parseResetAt,
  parseResetHint,
  QuotaSpecError,
  SeatUsageStore,
  UNBOUNDED_WINDOW,
} from './usage.js';
import { CODEX_SEAT, CLAUDE_SEAT, GEMINI_SEAT, type SeatSpec } from './spec.js';

function seat(over: Partial<SeatSpec> = {}): SeatSpec {
  return { ...CODEX_SEAT, ...over };
}

// 2026-08-04 화요일 09:00 UTC = 18:00 Asia/Seoul
const TUE_0900_UTC = Date.parse('2026-08-04T09:00:00.000Z');

describe('리셋 시각 파싱', () => {
  it('실측 모양을 읽는다', () => {
    expect(parseResetAt('20:00 Asia/Seoul')).toEqual({ hour: 20, minute: 0, zone: 'Asia/Seoul' });
  });

  it('모양이 다르면 null 이다 — 추측해서 채우지 않는다', () => {
    for (const bad of ['20시 서울', '8pm', '25:00 Asia/Seoul', '20:99 Asia/Seoul', '']) {
      expect(parseResetAt(bad)).toBeNull();
    }
    expect(parseResetAt(null)).toBeNull();
  });
});

describe('창 경계', () => {
  it('일간 창은 리셋 시각을 지났는지로 갈린다', () => {
    const s = seat({ quota: { window: 'day', limit: null, resetAt: '20:00 Asia/Seoul' } });
    // 18:00 Asia/Seoul — 아직 오늘 20시를 안 지났으므로 어제 경계가 창의 시작
    expect(currentWindowKey(s, TUE_0900_UTC)).toBe('Asia/Seoul/day/2026-08-03T20:00');
    // 4시간 뒤면 22:00 Asia/Seoul — 오늘 경계로 넘어간다
    expect(currentWindowKey(s, TUE_0900_UTC + 4 * 3_600_000)).toBe('Asia/Seoul/day/2026-08-04T20:00');
  });

  /**
   * claude 실측 문구는 시각만 알려 주고 요일은 말하지 않는다. 요일 없이
   * 주간 경계를 잡으면 최대 엿새를 틀리고, 그 방향이 한도 우회다.
   */
  it('주간 창은 요일이 없으면 계산하지 않는다', () => {
    expect(currentWindowKey(CLAUDE_SEAT, TUE_0900_UTC)).toBe(UNBOUNDED_WINDOW);
  });

  it('주간 창은 요일이 있으면 그 요일 경계로 잡힌다', () => {
    // 리셋 요일 = 월요일(1). 화요일 18:00 KST 이면 어제 월요일 20:00 이 시작
    const mon = seat({
      quota: { window: 'week', limit: null, resetAt: '20:00 Asia/Seoul', resetDay: 1 },
    });
    expect(currentWindowKey(mon, TUE_0900_UTC)).toBe('Asia/Seoul/week/2026-08-03T20:00');

    // 리셋 요일 = 화요일(2). 화요일 18:00 은 아직 20:00 전이므로 지난주 화요일
    const tue = seat({
      quota: { window: 'week', limit: null, resetAt: '20:00 Asia/Seoul', resetDay: 2 },
    });
    expect(currentWindowKey(tue, TUE_0900_UTC)).toBe('Asia/Seoul/week/2026-07-28T20:00');
  });

  it('창 종류를 모르면 계산하지 않는다', () => {
    expect(currentWindowKey(GEMINI_SEAT, TUE_0900_UTC)).toBe(UNBOUNDED_WINDOW);
  });

  it('타임존 이름이 잘못되면 계산하지 않는다 — 던지지 않는다', () => {
    const s = seat({ quota: { window: 'day', limit: null, resetAt: '20:00 Not/AZone' } });
    expect(currentWindowKey(s, TUE_0900_UTC)).toBe(UNBOUNDED_WINDOW);
  });
});

describe('한도 집행 가능 여부', () => {
  it('한도가 없으면 집행할 것도 없다', () => {
    expect(limitEnforceable(CODEX_SEAT, TUE_0900_UTC)).toBe(false);
  });

  it('경계를 잡을 수 있어야 집행한다', () => {
    const s = seat({ quota: { window: 'day', limit: 5, resetAt: '00:00 UTC' } });
    expect(limitEnforceable(s, TUE_0900_UTC)).toBe(true);
  });
});

/**
 * 경계를 못 잡는 창에 한도를 걸면, 집행하면 좌석이 영구히 죽고 집행하지
 * 않으면 한도가 조용히 무시된다. 둘 다 소리 없이 일어나므로 사양 자체를 막는다.
 */
describe('집행 불가능한 한도는 사양 단계에서 막는다', () => {
  it('리셋 시각 없는 한도를 거부한다', () => {
    const s = seat({ quota: { window: 'day', limit: 10, resetAt: null } });
    expect(() => assertQuotaCoherent(s)).toThrow(QuotaSpecError);
    expect(() => assertQuotaCoherent(s)).toThrow(/resetAt/);
  });

  it('요일 없는 주간 한도를 거부한다 — 실측 순서를 강제한다', () => {
    const s = seat({ quota: { window: 'week', limit: 10, resetAt: '20:00 Asia/Seoul' } });
    expect(() => assertQuotaCoherent(s)).toThrow(/resetDay/);
  });

  it('한도가 null 이면 통과한다 — 지금 좌석 넷이 전부 이 상태다', () => {
    expect(() => assertQuotaCoherent(CLAUDE_SEAT)).not.toThrow();
    expect(() => assertQuotaCoherent(GEMINI_SEAT)).not.toThrow();
  });
});

describe('벤더가 말한 해제 시각', () => {
  const claudeText = "You've hit your weekly limit · resets 8pm (Asia/Seoul)";

  it('실측 문구에서 시각과 존을 판다', () => {
    const until = parseResetHint(claudeText, CLAUDE_SEAT, TUE_0900_UTC);
    // 18:00 KST 기준 다음 20:00 KST = 같은 날 11:00 UTC
    expect(until).toBe('2026-08-04T11:00:00.000Z');
  });

  it('문구에 존이 없으면 사양의 존을 쓴다', () => {
    expect(parseResetHint('resets 8pm', CLAUDE_SEAT, TUE_0900_UTC)).toBe('2026-08-04T11:00:00.000Z');
  });

  /**
   * 못 알아본 문구에 유예 시간을 지어내지 않는다. null 은 "모른다" 이고,
   * 모르면 배제가 아니라 강등이다.
   */
  it('알아볼 수 없으면 null 이다', () => {
    expect(parseResetHint('quota exceeded', GEMINI_SEAT, TUE_0900_UTC)).toBeNull();
    expect(parseResetHint('you are over the limit', GEMINI_SEAT, TUE_0900_UTC)).toBeNull();
  });

  it('오전/오후를 구분한다', () => {
    expect(nextOccurrence(8, 0, 'UTC', TUE_0900_UTC)).toBe('2026-08-05T08:00:00.000Z');
    expect(nextOccurrence(20, 0, 'UTC', TUE_0900_UTC)).toBe('2026-08-04T20:00:00.000Z');
  });
});

describe('소진 상태 판정', () => {
  const base = { windowKey: UNBOUNDED_WINDOW, used: 0 };

  it('소진이 아니면 그대로 쓴다', () => {
    expect(exhaustionState({ ...base, exhaustedAt: null, exhaustedUntil: null }, TUE_0900_UTC))
      .toEqual({ kind: 'ok' });
  });

  it('해제 시각 전이면 뺀다', () => {
    const until = '2026-08-04T11:00:00.000Z';
    expect(exhaustionState({ ...base, exhaustedAt: 'x', exhaustedUntil: until }, TUE_0900_UTC))
      .toEqual({ kind: 'excluded', until });
  });

  it('해제 시각이 지났으면 다시 쓴다', () => {
    expect(
      exhaustionState({ ...base, exhaustedAt: 'x', exhaustedUntil: '2026-08-04T08:00:00.000Z' }, TUE_0900_UTC),
    ).toEqual({ kind: 'ok' });
  });

  /**
   * 해제 시각을 모르는데 빼 버리면, 벤더 문구를 한 번 잘못 읽은 것만으로
   * 좌석이 영원히 사라지고 회사가 멈춘다.
   */
  it('해제 시각을 모르면 빼지 않고 강등한다', () => {
    expect(exhaustionState({ ...base, exhaustedAt: 'x', exhaustedUntil: null }, TUE_0900_UTC))
      .toEqual({ kind: 'demoted' });
  });
});

describe('장부', () => {
  let dir: string;
  let file: string;
  let store: SeatUsageStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentlas-usage-'));
    file = join(dir, 'seats', 'usage.json');
    store = new SeatUsageStore({ file, now: () => TUE_0900_UTC });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('없으면 0 부터다', () => {
    expect(store.get('codex', CODEX_SEAT)).toEqual({
      windowKey: UNBOUNDED_WINDOW, used: 0, exhaustedAt: null, exhaustedUntil: null,
    });
  });

  it('오너 전용으로 쓴다', () => {
    store.bump('codex', CODEX_SEAT);
    if (process.platform === 'win32') return; // ACL 은 별도 시험이다
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  /** 이 시험 하나가 Task 5.1 의 요점이다 — 새 객체는 새 프로세스의 대역이다. */
  it('다른 인스턴스가 올린 카운트를 본다', () => {
    const a = new SeatUsageStore({ file, now: () => TUE_0900_UTC });
    const b = new SeatUsageStore({ file, now: () => TUE_0900_UTC });
    a.bump('codex', CODEX_SEAT);
    a.bump('codex', CODEX_SEAT);
    expect(b.get('codex', CODEX_SEAT).used).toBe(2);
  });

  it('창이 넘어가면 카운터가 0 부터다', () => {
    const s = seat({ quota: { window: 'day', limit: null, resetAt: '20:00 Asia/Seoul' } });
    const before = new SeatUsageStore({ file, now: () => TUE_0900_UTC });
    before.bump('codex', s);
    expect(before.get('codex', s).used).toBe(1);

    // 20:00 KST 를 넘긴 시점
    const after = new SeatUsageStore({ file, now: () => TUE_0900_UTC + 4 * 3_600_000 });
    expect(after.get('codex', s).used).toBe(0);
  });

  /**
   * 창이 넘어간 것과 벤더가 말한 해제 시각은 별개다. 창 롤오버로 소진까지
   * 풀어 주면, 벤더가 "다음 주에 풀린다" 고 말한 좌석을 하루 만에 다시 친다.
   */
  it('창이 넘어가도 소진 해제 시각은 살아 있다', () => {
    const s = seat({ quota: { window: 'day', limit: null, resetAt: '20:00 Asia/Seoul' } });
    const until = '2026-08-10T11:00:00.000Z';
    new SeatUsageStore({ file, now: () => TUE_0900_UTC }).markExhausted('codex', s, until);

    const after = new SeatUsageStore({ file, now: () => TUE_0900_UTC + 4 * 3_600_000 });
    const u = after.get('codex', s);
    expect(u.used).toBe(0);
    expect(u.exhaustedUntil).toBe(until);
  });

  it('소진을 풀 수 있다', () => {
    store.markExhausted('codex', CODEX_SEAT, null);
    expect(store.get('codex', CODEX_SEAT).exhaustedAt).not.toBeNull();
    store.clearExhausted('codex');
    expect(store.get('codex', CODEX_SEAT).exhaustedAt).toBeNull();
  });

  it('손상되면 빈 장부로 시작하되 조용히 넘어가지 않는다', () => {
    store.bump('codex', CODEX_SEAT);
    writeFileSync(file, '{ 깨진', 'utf8');
    const seen: string[] = [];
    const s2 = new SeatUsageStore({ file, now: () => TUE_0900_UTC, onCorrupt: (f) => seen.push(f) });
    expect(s2.get('codex', CODEX_SEAT).used).toBe(0);
    expect(seen).toEqual([file]);
  });

  it('JSON 이지만 모양이 아니어도 손상으로 본다', () => {
    store.bump('codex', CODEX_SEAT); // 파일과 디렉터리를 만든다
    writeFileSync(file, '[1,2,3]', 'utf8');
    const seen: string[] = [];
    const s2 = new SeatUsageStore({ file, now: () => TUE_0900_UTC, onCorrupt: (f) => seen.push(f) });
    expect(s2.get('codex', CODEX_SEAT).used).toBe(0);
    expect(seen).toEqual([file]);
  });
});
