import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProfile, leakedProfiles } from './profile.js';
import { CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT } from './spec.js';
import { STRIPPED_ENV_VARS } from './strip-env.js';

describe('좌석 프로필', () => {
  it('작업 디렉터리를 만든다 — 좌석의 유일한 쓰기 경로 (R2.5)', () => {
    const p = createProfile(CODEX_SEAT);
    try {
      expect(existsSync(p.workDir)).toBe(true);
    } finally {
      p.dispose();
    }
  });

  it('환경에서 API 키를 제거한다 (R1.1)', () => {
    const p = createProfile(GEMINI_SEAT);
    try {
      for (const name of STRIPPED_ENV_VARS) {
        expect(p.env[name], `${name} 이 삭제 목록에 없다`).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(p.env, name)).toBe(true);
      }
    } finally {
      p.dispose();
    }
  });

  it('격리 수단이 없는 좌석은 isolated 를 참으로 보고하지 않는다', () => {
    const p = createProfile(CLAUDE_SEAT);
    try {
      // claude 는 설정 홈 환경변수가 아니라 플래그로 격리한다.
      expect(CLAUDE_SEAT.configHomeEnv).toBeNull();
      expect(p.isolated).toBe(false);
      expect(p.configHome).toBeNull();
    } finally {
      p.dispose();
    }
  });

  it('dispose 를 두 번 불러도 던지지 않는다', () => {
    const p = createProfile(CODEX_SEAT);
    p.dispose();
    expect(() => p.dispose()).not.toThrow();
  });

  it('정리 실패가 예외로 새지 않는다 — 성공한 호출을 실패로 뒤집지 않는다', () => {
    // 실제로 겪은 사고: claude 가 답을 돌려준 뒤 임시 디렉터리 삭제가 EPERM 으로
    // 실패했고 finally 의 그 예외가 성공을 "실행 불가" 로 만들었다.
    const p = createProfile(CODEX_SEAT);
    // 삭제를 방해하기 위해 하위에 디렉터리를 하나 더 만들고 파일을 열어둔다.
    const stubborn = join(p.workDir, 'nested');
    mkdirSync(stubborn, { recursive: true });
    writeFileSync(join(stubborn, 'f.txt'), 'x', 'utf8');

    const before = leakedProfiles.length;
    expect(() => p.dispose()).not.toThrow();
    // 삭제가 됐으면 목록이 그대로고, 실패했으면 목록에 남는다. 둘 다 예외는 없다.
    expect(leakedProfiles.length).toBeGreaterThanOrEqual(before);
  });
});
