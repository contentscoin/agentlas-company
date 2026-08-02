/**
 * 프로세스 계층 — 좌석 CLI 를 띄우고 확실하게 죽인다.
 *
 * 이 모듈은 업스트림 social-ai-team-custom 의 desktop/lib/proc.js 를
 * TypeScript 로 이식한 것이다. 원본 커밋은 vendor.lock 에 핀되어 있다.
 * 원본 주석 인용 (L1-2):
 *   "GUI apps don't inherit the terminal PATH, and Node's
 *    spawn(shell:true) joins args WITHOUT quoting. Both bite hard on Windows."
 *
 * 이식하면서 우리 요구에 맞춰 더한 것:
 *   - isAlive: signal 0 을 쓰지 않는 Windows 안전 생존 확인
 *   - 종료 코드와 산출 파일만 신뢰하는 결과 타입 (SEAT-CONTRACT 실측 결론)
 *   - stderr 존재를 실패로 해석하지 않음
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export const isWin = process.platform === 'win32';

const HOME = homedir();

/**
 * GUI 로 띄운 프로세스는 터미널 PATH 를 물려받지 못한다.
 * 좌석 CLI 가 실제로 설치되는 위치를 직접 얹어준다.
 * 경로는 SEAT-CONTRACT 실측에서 확인된 것들을 포함한다.
 */
export function extraDirs(): string[] {
  const d: string[] = [];
  if (isWin) {
    if (process.env.APPDATA) d.push(join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) {
      d.push(join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'));
      d.push(join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app', 'bin'));
    }
    d.push(join(HOME, 'scoop', 'shims'));
    d.push(join(HOME, 'scoop', 'apps', 'nodejs', 'current', 'bin'));
  } else {
    d.push('/usr/local/bin', '/opt/homebrew/bin');
    d.push(join(HOME, '.npm-global', 'bin'));
  }
  // 두 플랫폼 공통 — claude 가 여기 설치된다 (실측: ~/.local/bin/claude.exe)
  d.push(join(HOME, '.local', 'bin'));
  return d.filter((p) => existsSync(p));
}

/**
 * 자식 환경을 만든다.
 * `extra` 의 값이 `undefined` 면 그 변수를 **삭제**한다.
 * 이 규약이 API 키 제거(R1.1)의 구현 지점이다.
 */
export function envWithPath(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const PATH = [...extraDirs(), process.env.PATH ?? process.env.Path ?? ''].join(delimiter);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH, ...extra };
  if (isWin) env.Path = PATH;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

/**
 * 실행 파일의 절대 경로를 찾는다. 없으면 null.
 *
 * 셸을 거치지 않는 직접 spawn 에 필요하다. Windows 에서 `shell: false` 는
 * PATH 탐색과 확장자 보완을 해주지 않기 때문이다.
 */
export function resolveExecutable(bin: string): string | null {
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...extraDirs(), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter)];
  for (const dir of dirs) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Windows 셸은 인자를 알아서 인용해주지 않는다. 직접 한다. */
export function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"'`$&|<>^()[\]{};,*?!~#%=]/.test(arg)) return arg;
  if (isWin) return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * 프로세스가 살아있는지 확인한다.
 *
 * signal 0 을 쓰지 않는다. POSIX 에서는 존재 확인이지만 Windows 에서는
 * 대상 프로세스를 실제로 종료시킨다. `gate:liveness` 가 그 사용을 금지한다.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isWin) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (r.error || typeof r.stdout !== 'string') return false;
    return r.stdout.includes(`"${pid}"`);
  }
  const r = spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * 프로세스와 그 자손을 모두 종료한다.
 *
 * Windows 에 SIGKILL 이 없고, 좌석 CLI 는 셔틀(.ps1/.cmd) → node → 실제 CLI 로
 * 손자까지 뻗는다. 부모만 죽이면 고아가 남아 쿼터를 계속 태운다 (R2.4).
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 이미 죽었다 */
    }
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
}

export interface RunResult {
  /** 판정의 유일한 근거. stderr 존재는 실패가 아니다 (SEAT-CONTRACT 실측). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 타임아웃으로 강제 종료되었는가. */
  timedOut: boolean;
  ms: number;
}

/**
 * 명령을 실행한다. 인자는 직접 인용하고 PATH 는 보강한다.
 * 타임아웃 시 프로세스 트리를 정리한다.
 */
export function runCmd(name: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return spawnLine([name, ...args].map(quoteArg).join(' '), opts);
}

/**
 * 이미 완성된 셸 명령줄을 그대로 실행한다.
 *
 * `runCmd` 는 인자를 인용하므로 `node -e "x"` 같은 명령줄을 넘기면
 * 전체가 하나의 인자로 인용되어 깨진다. 게이트 명령처럼 우리가 작성한
 * 명령줄은 이 함수로 돈다.
 *
 * 중요한 경계: 이 함수에 들어오는 문자열은 **운영자가 작성한 설정**
 * (레시피 파일, 정책 파일)에서만 와야 한다. 에이전트 산출물이 여기로
 * 흘러들면 임의 명령 실행이 되므로, 레시피 파일은 정책 파일과 같은
 * 신뢰 등급으로 취급하고 에이전트가 쓸 수 없는 경로에 둔다.
 */
export function runShell(commandLine: string, opts: RunOptions = {}): Promise<RunResult> {
  return spawnLine(commandLine, opts);
}

/**
 * 셸을 거치지 않고 직접 실행한다.
 *
 * 이 경로가 필요한 실측 근거: claude 좌석은 프롬프트를 인자로만 받는데
 * (stdin 을 읽지 않는다) 여러 줄 인자는 cmd.exe 를 거치면 개행에서 깨진다.
 * 셸을 빼면 인자가 CreateProcess 로 그대로 전달되어 개행도 길이도 문제가 없다.
 *
 * 대신 PATH 탐색을 우리가 해야 하므로 `resolveExecutable` 을 먼저 쓴다.
 * `.ps1` 셔틀은 직접 실행할 수 없어 셸 경로를 쓴다.
 */
export function runDirect(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const resolved = resolveExecutable(bin);
  if (resolved === null) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: `실행 파일을 찾지 못했다: ${bin}`,
      timedOut: false,
      ms: 0,
    });
  }
  return spawnChild(resolved, args, false, opts);
}

function spawnLine(line: string, opts: RunOptions): Promise<RunResult> {
  return spawnChild(line, undefined, true, opts);
}

function spawnChild(
  target: string,
  args: string[] | undefined,
  useShell: boolean,
  opts: RunOptions,
): Promise<RunResult> {
  const started = Date.now();

  return new Promise<RunResult>((resolve) => {
    const child = spawn(target, args ?? [], {
      shell: useShell,
      windowsHide: true,
      cwd: opts.cwd ?? process.cwd(),
      env: envWithPath(opts.env ?? {}),
      detached: !isWin,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
          }, opts.timeoutMs)
        : undefined;

    // 자식이 이미 죽었거나 stdin 을 읽지 않으면 write 가 EPIPE 를 던진다.
    // 그 에러는 스트림의 'error' 이벤트로 나오고, 핸들러가 없으면 **부모
    // 프로세스가 통째로 죽는다**. Task 11 실측에서 밟았다 — 좌석 CLI 가
    // 설치되어 있지 않아 자식이 즉시 종료했고, company 가 스택 트레이스를
    // 뱉으며 죽었다. 좌석이 없는 것은 흔한 상태이고, 그때 죽으면 안 된다.
    //
    // 파이프가 닫힌 것은 실패가 아니라 정보다 — 종료 코드로 판정한다.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => {
        // 닫힌 파이프. 판정은 종료 코드가 한다.
      });
      try {
        if (opts.input !== undefined) stdin.write(opts.input);
        stdin.end();
      } catch {
        // 위와 같다. 동기 예외로 나오는 경로도 있다.
      }
    }

    const finish = (code: number | null): void => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}
