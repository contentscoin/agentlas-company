import { describe, expect, it } from 'vitest';
import { humanRemaining, parseTtl } from './ttl.js';

describe('parseTtl', () => {
  it('네 단위를 모두 읽는다', () => {
    expect(parseTtl('90s')).toBe(90_000);
    expect(parseTtl('30m')).toBe(1_800_000);
    expect(parseTtl('2h')).toBe(7_200_000);
    expect(parseTtl('1d')).toBe(86_400_000);
  });

  it('앞뒤 공백을 흡수한다', () => {
    expect(parseTtl('  2h ')).toBe(7_200_000);
  });

  it('단위 없는 숫자를 거부한다 — 2초인지 2시간인지 모호한 채로 위험 능력을 켜지 않는다', () => {
    expect(parseTtl('2')).toBeNull();
    expect(parseTtl('7200000')).toBeNull();
  });

  it('0 과 음수를 거부한다 — 무기한 ON 이 되는 경로를 막는다', () => {
    expect(parseTtl('0h')).toBeNull();
    expect(parseTtl('-1h')).toBeNull();
  });

  it('알 수 없는 단위를 거부한다', () => {
    expect(parseTtl('2w')).toBeNull();
    expect(parseTtl('2주')).toBeNull();
    expect(parseTtl('forever')).toBeNull();
    expect(parseTtl('')).toBeNull();
  });
});

describe('humanRemaining', () => {
  it('시간과 분으로 표시한다', () => {
    expect(humanRemaining(7_200_000)).toBe('2시간 0분');
    expect(humanRemaining(5_400_000)).toBe('1시간 30분');
    expect(humanRemaining(1_800_000)).toBe('30분');
  });

  it('OFF 와 만료를 구분한다', () => {
    expect(humanRemaining(null)).toBe('-');
    expect(humanRemaining(0)).toBe('만료');
    expect(humanRemaining(-5)).toBe('만료');
  });
});
