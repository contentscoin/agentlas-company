#!/usr/bin/env node
// 게이트: Windows 에서 거짓말하는 프로세스 API 를 금지한다
//
// 실측 근거가 있는 금지다. 업스트림 DESKTOP.md 가 기록한 사고:
// os.kill(pid, 0) 은 POSIX 에서 "살아있나?" 를 묻지만 Windows 에서는
// 그 프로세스를 실제로 종료시킨다. GUI 의 새로고침 버튼이 봇을 조용히 죽였다.
//
// 우리 운영 대상은 상시 Windows 미니PC 다. 이 함정을 코드로 막는다.
//   - liveness 확인에 signal 0 을 쓰지 않는다
//   - SIGKILL 은 Windows 에 없다. taskkill /T /F 를 쓴다 (proc 계층에 캡슐화)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectFiles, scan, report, EXIT_CANNOT_RUN } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SELF = 'scripts/gates/no-liveness-probe.mjs';

// process.kill(pid, 0) / os.kill(pid, 0) 형태
const SIGNAL_ZERO_RE = /\b(?:process|os)\.kill\s*\([^)]*,\s*0\s*\)/;
const SIGKILL_RE = /['"`]SIGKILL['"`]/;

try {
  const files = collectFiles([join(REPO, 'src'), join(REPO, 'scripts')], ['.ts', '.mts', '.mjs', '.js', '.cjs']);

  const findings = scan(files, REPO, [
    {
      kind: 'signal-zero-liveness (Windows 에서는 확인이 아니라 종료다)',
      test: (line) => SIGNAL_ZERO_RE.test(line),
      allow: [SELF],
    },
    {
      kind: 'sigkill (Windows 에 없다 — proc 계층의 killTree 를 쓴다)',
      test: (line) => SIGKILL_RE.test(line),
      allow: [SELF],
    },
  ]);

  process.exit(
    report('gate:liveness', findings, {
      hint: '생존 확인과 종료는 src/proc 의 isAlive/killTree 만 사용한다.',
    }),
  );
} catch (err) {
  process.stderr.write(`[gate:liveness] 실행 불가: ${err.message}\n`);
  process.exit(EXIT_CANNOT_RUN);
}
