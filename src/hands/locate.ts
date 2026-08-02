/**
 * 실행 표면 탐색 — 왜 못 하는지를 구분한다 (R7.5)
 *
 * Hands 가 못 도는 이유는 여러 가지이고, 오너가 해야 할 일이 각각 다르다.
 * "Hands 실패" 한 줄로 뭉뚱그리면 무엇을 고쳐야 하는지 알 수 없다.
 *
 *   launcher-missing   desktop 이 런처를 물질화하지 않았다 → desktop 을 한 번 켠다
 *   chrome-missing     Chrome 이 없다 → 설치한다
 *   desktop-not-running  승인 서버가 없다 → desktop 을 켠다
 *   node-missing       런처를 돌릴 node 가 없다
 *
 * 마지막 것을 따로 두는 이유는, company 자신이 node 로 돌고 있어도 좌석
 * 구역의 PATH 가 다를 수 있기 때문이다. 자기 실행 경로를 쓰면 그 위험이 없다.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** desktop 이 물질화하는 CDP 런처. `browser-cdp-launcher.ts` 의 경로 규약과 같다. */
export const LAUNCHER_BASENAME = 'agentlas-browser-cdp.mjs';

/** desktop 이 승인 서버 포트·토큰을 쓰는 파일을 가리키는 환경변수. */
export const BROWSER_APPROVAL_FILE_ENV = 'AGENTLAS_BROWSER_APPROVAL_FILE';

export type SurfaceProblem =
  | 'launcher-missing'
  | 'chrome-missing'
  | 'desktop-not-running'
  | 'node-missing';

export interface Surface {
  ok: boolean;
  launcher: string;
  /** desktop 승인 파일. 없으면 desktop 이 안 떠 있다는 뜻이다. */
  approvalFile: string | null;
  problems: SurfaceProblem[];
  detail: string[];
}

export function launcherPath(): string {
  return process.env.AGENTLAS_BROWSER_LAUNCHER ?? join(homedir(), '.agentlas', LAUNCHER_BASENAME);
}

/**
 * desktop 승인 파일 경로.
 *
 * 환경변수가 없으면 플랫폼별 Electron userData 규약으로 추정한다. 추정이
 * 틀릴 수 있으므로 **추정값으로 성공을 보고하지 않는다** — 파일이 실제로
 * 있을 때만 있다고 답한다.
 */
export function approvalFilePath(): string | null {
  const explicit = process.env[BROWSER_APPROVAL_FILE_ENV]?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Agentlas Desktop')]
      : process.platform === 'darwin'
        ? [join(home, 'Library', 'Application Support', 'Agentlas Desktop')]
        : [join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Agentlas Desktop')];

  for (const dir of candidates) {
    const file = join(dir, 'browser', 'approval.json');
    if (existsSync(file)) return file;
  }
  return null;
}

/** Chrome 실행 파일 후보. desktop 의 `browserCdpExecutableCandidates` 와 같은 자리를 본다. */
export function chromeCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
}

/**
 * 실행 표면을 점검한다.
 *
 * `requireDesktop` 이 거짓이면 승인 서버 부재를 문제로 세지 않는다. 읽기 전용
 * 단계(snapshot·screenshot)는 desktop 승인이 필요 없기 때문인데, 기본값은
 * 참이다 — 승인 없이 도는 것이 기본이 되어서는 안 된다.
 */
export function inspectSurface(opts: { requireDesktop?: boolean } = {}): Surface {
  const requireDesktop = opts.requireDesktop ?? true;
  const launcher = launcherPath();
  const approvalFile = approvalFilePath();
  const problems: SurfaceProblem[] = [];
  const detail: string[] = [];

  if (!existsSync(launcher)) {
    problems.push('launcher-missing');
    detail.push(`런처가 없다: ${launcher} — agentlas-desktop 을 한 번 실행하면 물질화된다`);
  }

  const chrome = chromeCandidates().find((c) => existsSync(c));
  if (!chrome) {
    problems.push('chrome-missing');
    detail.push(`Chrome 을 찾지 못했다 (확인한 경로: ${chromeCandidates().join(', ')})`);
  }

  if (requireDesktop && !approvalFile) {
    problems.push('desktop-not-running');
    detail.push(
      'desktop 승인 서버 파일이 없다 — agentlas-desktop 이 떠 있어야 민감 행동 승인이 가능하다',
    );
  }

  if (!process.execPath) {
    problems.push('node-missing');
    detail.push('node 실행 경로를 알 수 없다');
  }

  return { ok: problems.length === 0, launcher, approvalFile, problems, detail };
}
