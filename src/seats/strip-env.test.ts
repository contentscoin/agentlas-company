import { describe, expect, it } from 'vitest';
import { STRIPPED_ENV_VARS, stripOverrides } from './strip-env.js';
import { envWithPath } from '../proc/index.js';

describe('API 키 제거 목록 (R1.1)', () => {
  it('벤더 4곳을 모두 덮는다', () => {
    const joined = STRIPPED_ENV_VARS.join(',');
    for (const vendor of ['ANTHROPIC', 'OPENAI', 'GEMINI', 'GOOGLE', 'CURSOR']) {
      expect(joined).toContain(vendor);
    }
  });

  it('중복이 없다', () => {
    expect(new Set(STRIPPED_ENV_VARS).size).toBe(STRIPPED_ENV_VARS.length);
  });

  it('모든 항목이 undefined 로 매핑된다 — 값 주입이 아니라 삭제다', () => {
    const o = stripOverrides();
    expect(Object.keys(o).length).toBe(STRIPPED_ENV_VARS.length);
    for (const k of Object.keys(o)) expect(o[k]).toBeUndefined();
  });

  it('실제로 자식 환경에서 키가 사라진다', () => {
    // 이름을 하드코딩하지 않고 목록에서 가져온다.
    // 그래야 목록이 늘어날 때 테스트가 자동으로 따라간다.
    const restore: Array<[string, string | undefined]> = [];
    for (const name of STRIPPED_ENV_VARS) {
      restore.push([name, process.env[name]]);
      process.env[name] = 'fake-value-for-test';
    }
    try {
      const env = envWithPath(stripOverrides());
      for (const name of STRIPPED_ENV_VARS) {
        expect(name in env, `${name} 이 자식 환경에 남았다`).toBe(false);
      }
    } finally {
      for (const [name, prev] of restore) {
        if (prev === undefined) delete process.env[name];
        else process.env[name] = prev;
      }
    }
  });

  it('키를 지워도 PATH 보강은 유지된다', () => {
    const env = envWithPath(stripOverrides());
    expect(env.PATH).toBeTruthy();
  });
});
