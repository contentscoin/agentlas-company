import { describe, expect, it } from 'vitest';
import { cellWidth } from './cli.js';

/**
 * `company seats` 표가 어긋나 있었다. `CODEX_HOME(미적용)` 이 고정 폭 13 을
 * 넘겨 다음 칸(`day`)을 붙여 버렸고, 폭을 내용에서 계산하도록 고쳐도 한글은
 * 고정폭 터미널에서 **두 칸**이라 글자 수로는 맞지 않는다.
 */
describe('터미널 표시 폭', () => {
  it('아스키는 한 칸이다', () => {
    expect(cellWidth('CODEX_HOME')).toBe(10);
    expect(cellWidth('')).toBe(0);
  });

  it('한글은 두 칸이다', () => {
    expect(cellWidth('미적용')).toBe(6);
    expect(cellWidth('좌석')).toBe(4);
  });

  it('섞이면 더한다 — 이 셀 하나가 표를 밀고 있었다', () => {
    expect(cellWidth('CODEX_HOME(미적용)')).toBe(10 + 1 + 6 + 1);
  });

  it('전각 기호도 두 칸이다', () => {
    expect(cellWidth('（）')).toBe(4);
  });
});
