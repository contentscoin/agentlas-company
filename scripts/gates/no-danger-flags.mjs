#!/usr/bin/env node
// 게이트: 좌석 CLI 의 권한 우회 플래그를 금지한다 (R1.3)
//
// 자율 운영을 만들다 보면 승인 프롬프트를 끄고 싶은 유혹이 반드시 온다.
// 그 순간이 이 시스템의 모든 통제가 무의미해지는 순간이다.
// 소스는 문서를 스캔하지 않는다 — 문서는 금지 대상을 논의할 수 있어야 한다.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectFiles, scan, report, EXIT_CANNOT_RUN } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SELF = 'scripts/gates/no-danger-flags.mjs';

// 조각으로 조립해 게이트 자신이 자기 규칙에 걸리지 않게 한다.
const DANGER = [
  '--dangerously' + '-skip-permissions',
  '--yo' + 'lo',
  '--full' + '-auto',
  '--approval-mode' + '=yolo',
  'approval_policy' + '="never"',
  '--sandbox' + ' danger-full-access',
  'danger-full' + '-access',
  'bypassPermissions',
];

try {
  const files = collectFiles([join(REPO, 'src'), join(REPO, 'scripts')], ['.ts', '.mts', '.mjs', '.js', '.cjs']);

  const findings = scan(files, REPO, [
    {
      kind: 'danger-flag (권한 우회 플래그)',
      test: (line) => DANGER.some((d) => line.includes(d)),
      allow: [SELF, 'scripts/gates/no-danger-flags.test.mjs'],
    },
  ]);

  process.exit(
    report('gate:flags', findings, {
      hint: '권한 우회 대신 능력 스위치(R8)와 정책 게이트(R4)를 쓴다.',
    }),
  );
} catch (err) {
  process.stderr.write(`[gate:flags] 실행 불가: ${err.message}\n`);
  process.exit(EXIT_CANNOT_RUN);
}
