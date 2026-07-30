/**
 * 유효기간 파싱 (R8.4)
 *
 * CLI 에서 분리한 이유는 테스트 가능성이다.
 * `cli.ts` 는 모듈 로드 시 `main()` 을 실행하므로 import 하는 것만으로
 * 프로세스가 종료된다. 순수 함수는 부작용 없는 모듈에 둔다.
 *
 * 단위 없는 숫자를 거부하는 것이 중요하다. `--ttl 2` 가 2초인지 2시간인지
 * 모호한 상태로 위험 능력을 켜게 만들면 안 된다.
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `90s` `30m` `2h` `1d` → 밀리초. 형식이 아니면 null. */
export function parseTtl(text: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return n * UNIT_MS[m[2]!]!;
}

/** 남은 시간을 사람이 읽는 문자열로. */
export function humanRemaining(ms: number | null): string {
  if (ms === null) return '-';
  if (ms <= 0) return '만료';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}
