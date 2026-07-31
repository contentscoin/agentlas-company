import { describe, expect, it } from 'vitest';
import { envWithPath, isAlive, isWin, killTree, quoteArg, runCmd, runShell } from './index.js';

describe('quoteArg', () => {
  it('공백 없는 단순 인자는 그대로 둔다', () => {
    expect(quoteArg('SEAT_OK')).toBe('SEAT_OK');
  });

  it('공백이 있으면 인용한다 — shell:true 가 알아서 해주지 않는다', () => {
    const q = quoteArg('hello world');
    expect(q).not.toBe('hello world');
    expect(q.startsWith(isWin ? '"' : "'")).toBe(true);
  });

  it('인용부호가 섞인 인자를 흘리지 않는다', () => {
    const q = quoteArg('say "hi"');
    expect(q.length).toBeGreaterThan('say "hi"'.length);
  });

  it('빈 문자열도 인용한다 — 인자가 사라지면 안 된다', () => {
    expect(quoteArg('')).not.toBe('');
  });
});

describe('envWithPath', () => {
  it('PATH 를 보강한다', () => {
    const env = envWithPath();
    expect(env.PATH).toBeTruthy();
    expect((env.PATH ?? '').length).toBeGreaterThan((process.env.PATH ?? '').length - 1);
  });

  it('Windows 에서는 Path 도 함께 맞춘다', () => {
    const env = envWithPath();
    if (isWin) expect(env.Path).toBe(env.PATH);
  });

  it('값이 undefined 인 항목은 변수를 삭제한다 — API 키 제거의 구현 지점', () => {
    const probe = 'AGENTLAS_PROC_PROBE';
    process.env[probe] = 'present';
    try {
      const kept = envWithPath();
      expect(kept[probe]).toBe('present');

      const dropped = envWithPath({ [probe]: undefined });
      expect(probe in dropped).toBe(false);
    } finally {
      delete process.env[probe];
    }
  });

  it('명시된 값은 덮어쓴다', () => {
    const env = envWithPath({ AGENTLAS_PROC_PROBE: 'set-by-test' });
    expect(env.AGENTLAS_PROC_PROBE).toBe('set-by-test');
  });
});

describe('isAlive', () => {
  it('자기 자신은 살아있다', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('있을 수 없는 pid 는 죽어있다', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(2_147_483_646)).toBe(false);
  });
});

describe('killTree', () => {
  it('없는 pid 로 불러도 던지지 않는다', () => {
    expect(() => killTree(undefined)).not.toThrow();
    expect(() => killTree(2_147_483_646)).not.toThrow();
  });
});

describe('runShell — 완성된 명령줄', () => {
  it('인용된 인자를 포함한 명령줄이 깨지지 않는다', async () => {
    const r = await runShell('node -e "process.stdout.write(\'SHELL_OK\')"');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('SHELL_OK');
  });

  it('종료 코드를 보존한다 — 게이트 판정의 근거', async () => {
    expect((await runShell('node -e "process.exit(0)"')).code).toBe(0);
    expect((await runShell('node -e "process.exit(1)"')).code).toBe(1);
  });

  it('runCmd 로 같은 명령줄을 넘기면 깨진다 — 두 함수가 따로 있는 이유', async () => {
    const viaShell = await runShell('node -e "process.exit(0)"');
    const viaCmd = await runCmd('node -e "process.exit(0)"', []);
    expect(viaShell.code).toBe(0);
    expect(viaCmd.code).not.toBe(0);
  });

  it('타임아웃을 지킨다', async () => {
    const r = await runShell('node -e "setTimeout(()=>{}, 60000)"', { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
  });
});

describe('runCmd', () => {
  it('종료 코드 0 과 stdout 을 돌려준다', async () => {
    const r = await runCmd('node', ['-e', 'process.stdout.write("SEAT_OK")']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('SEAT_OK');
    expect(r.timedOut).toBe(false);
  });

  it('실패한 명령의 종료 코드를 보존한다', async () => {
    const r = await runCmd('node', ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('stderr 가 있어도 성공은 성공이다 — 실측에서 codex 가 그랬다', async () => {
    const r = await runCmd('node', [
      '-e',
      'process.stderr.write("warning: noisy"); process.stdout.write("SEAT_OK")',
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('warning');
    expect(r.stdout.trim()).toBe('SEAT_OK');
  });

  it('공백이 든 인자를 온전히 전달한다', async () => {
    const r = await runCmd('node', ['-e', 'process.stdout.write(process.argv[1])', 'two words']);
    expect(r.stdout).toBe('two words');
  });

  it('타임아웃이면 프로세스 트리를 정리하고 timedOut 을 세운다', async () => {
    const r = await runCmd('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(20_000);
  });

  it('없는 명령은 던지지 않고 실패로 보고한다', async () => {
    const r = await runCmd('agentlas_no_such_command_xyz', []);
    expect(r.code === null || r.code !== 0).toBe(true);
  });
});
