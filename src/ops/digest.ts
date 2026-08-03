/**
 * 일일 요약 (R17.6)
 *
 * 하루치 원장을 접어 오너가 아침에 한 번 보는 것을 만든다. 요구사항이 지정한
 * 세 가지가 반드시 들어간다 — 위험 능력 사용, 스위치 변경, 거부.
 *
 * **없는 것은 없다고 쓴다.** "특이사항 없음" 은 이벤트가 없었다는 사실이고,
 * 그것도 정보다. 라이브오피스가 합성하지 않는 것(R10.3)과 같은 규칙이다 —
 * 요약이 조용하면 오너는 평온하다고 읽고, 그 평온이 사실이어야 한다.
 *
 * **좌석 만료 경고도 여기 싣는다 (R17.4).** 별도 알림 채널을 만들지 않는
 * 이유는, 알림이 여러 곳으로 흩어지면 어느 것도 안 보게 되기 때문이다.
 * 급한 것(임박·만료)은 요약 맨 위로 올린다.
 */

import type { LedgerEvent } from '../ledger/types.js';
import { localDayKey } from '../publish/ledgerstore.js';

export interface SeatExpiry {
  seat: string;
  /** 남은 시간(밀리초). 음수면 이미 만료다. */
  remainingMs: number | null;
}

export interface DailyDigest {
  day: string;
  /** 맨 위에 올라가는 급한 것. 비어 있으면 급한 일이 없었다. */
  urgent: string[];
  riskyUse: string[];
  switchChanges: string[];
  denials: string[];
  published: string[];
  /** 이벤트가 하나도 없었는가. 합성하지 않았다는 증거다. */
  quiet: boolean;
  totalEvents: number;
}

/** 만료가 임박했다고 볼 시간. 하루 남으면 알린다. */
export const EXPIRY_WARN_MS = 24 * 3_600_000;

const RISKY_HINT = /(spend|payout|credential|delete|dm_send|mass_follow|bulk)/i;

/**
 * 하루치를 접는다.
 *
 * `day` 는 로컬 날짜다. UTC 로 자르면 한국 시간 오전 9시에 하루가 바뀌어
 * "어제 무슨 일이 있었나" 가 어긋난다 — 발행 상한과 같은 이유다.
 */
export function buildDigest(
  events: readonly LedgerEvent[],
  at: Date,
  expiries: readonly SeatExpiry[] = [],
): DailyDigest {
  const day = localDayKey(at);
  const today = events.filter((e) => {
    const parsed = Date.parse(e.at);
    return !Number.isNaN(parsed) && localDayKey(new Date(parsed)) === day;
  });

  const urgent: string[] = [];
  for (const e of expiries) {
    if (e.remainingMs === null) continue;
    if (e.remainingMs <= 0) urgent.push(`좌석 ${e.seat} 세션이 만료됐습니다 — 재인증 필요`);
    else if (e.remainingMs <= EXPIRY_WARN_MS) {
      urgent.push(`좌석 ${e.seat} 세션이 ${Math.round(e.remainingMs / 3_600_000)}시간 뒤 만료됩니다`);
    }
  }

  const riskyUse: string[] = [];
  const switchChanges: string[] = [];
  const denials: string[] = [];
  const published: string[] = [];

  for (const e of today) {
    const line = `${e.at.slice(11, 16)} ${e.summary ?? e.kind}`;
    if (e.kind === 'switch.change') switchChanges.push(line);
    else if (e.kind === 'deny') denials.push(line);
    else if (e.kind === 'publish') published.push(line);

    // 위험 능력 사용은 종류가 아니라 내용으로 판별한다 — 능력 이름이
    // summary 에 실리고, 전용 이벤트 종류가 따로 없다.
    if (e.kind !== 'deny' && RISKY_HINT.test(e.summary ?? '')) riskyUse.push(line);
  }

  // 거부가 많으면 앞쪽만 보여준다. 전부 실으면 요약이 로그가 된다.
  const cap = (list: string[]): string[] =>
    list.length <= 10 ? list : [...list.slice(0, 10), `… 외 ${list.length - 10}건`];

  return {
    day,
    urgent,
    riskyUse: cap(riskyUse),
    switchChanges: cap(switchChanges),
    denials: cap(denials),
    published: cap(published),
    quiet: today.length === 0,
    totalEvents: today.length,
  };
}

/** 사람이 읽는 형태. 빈 섹션도 "없음" 으로 남긴다 — 침묵과 누락을 구분한다. */
export function renderDigest(d: DailyDigest): string[] {
  const lines = [`일일 요약 — ${d.day}`, ''];

  if (d.urgent.length > 0) {
    lines.push('급한 것:');
    for (const u of d.urgent) lines.push(`  ! ${u}`);
    lines.push('');
  }

  if (d.quiet) {
    lines.push('오늘 원장에 기록된 이벤트가 없습니다.');
    lines.push('(활동을 추정해 채우지 않습니다 — 없었다는 사실 그대로입니다)');
    return lines;
  }

  const section = (title: string, items: string[]): void => {
    lines.push(`${title} (${items.length}건)`);
    if (items.length === 0) lines.push('  없음');
    else for (const i of items) lines.push(`  ${i}`);
    lines.push('');
  };

  section('위험 능력 사용', d.riskyUse);
  section('스위치 변경', d.switchChanges);
  section('거부', d.denials);
  section('발행', d.published);
  lines.push(`전체 이벤트 ${d.totalEvents}건`);
  return lines;
}
