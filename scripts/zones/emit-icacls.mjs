#!/usr/bin/env node
// icacls 스크립트를 레이아웃에서 **생성**한다 (R15.1)
//
// 손으로 쓴 .ps1 을 저장소에 두지 않는 이유는 정본이 둘이 되기 때문이다.
// 스크립트가 열어 둔 경로를 검증기가 모르면, 검증은 통과하는데 실제로는
// 열려 있는 상태가 된다. Task 10 에서 Chrome 목록이 어긋났던 것과 같은
// 함정이고, 권한에서는 결과가 훨씬 나쁘다.
//
// 그래서 `src/zones/layout.ts` 하나만 고치면 스크립트와 검증기가 함께 따라온다.
//
// 사용: node scripts/zones/emit-icacls.mjs > setup-zones.ps1

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const { ZONE_ACCOUNTS, zoneLayout } = await import(join(REPO, 'dist', 'zones', 'layout.js'));

// 실제 배치의 경로로 치환할 자리표시자. 생성 시점의 이 기계 경로를 굳혀
// 넣으면 오너 기계에서 엉뚱한 곳에 권한을 건다.
const STATE = '$env:USERPROFILE\\.agentlas-company';
const HOME = '$env:USERPROFILE';

const entries = zoneLayout('__STATE__', '__HOME__');

const lines = [
  '# agentlas-company 구역 권한 설정 (R15.1)',
  '#',
  '# 이 파일은 생성물이다. 직접 고치지 말고 src/zones/layout.ts 를 고친 뒤',
  '#   npm run build && node scripts/zones/emit-icacls.mjs > setup-zones.ps1',
  '# 로 다시 만든다. 검증기(company security verify)가 같은 표를 읽는다.',
  '#',
  '# 관리자 PowerShell 에서 실행한다.',
  '',
  '$ErrorActionPreference = "Stop"',
  '',
  `$state = "${STATE}"`,
  `$home_ = "${HOME}"`,
  '',
  '# ── 계정 셋 ─────────────────────────────────────────────────────',
  '# 이미 있으면 건너뛴다. 비밀번호는 사람이 정한다 — 스크립트가 정하면',
  '# 그 값이 저장소나 셸 히스토리에 남는다.',
  '',
];

for (const [zone, account] of Object.entries(ZONE_ACCOUNTS)) {
  if (zone === 'owner') continue; // 오너는 사람이 이미 쓰는 계정이다.
  lines.push(
    `if (-not (Get-LocalUser -Name "${account}" -ErrorAction SilentlyContinue)) {`,
    `  Write-Host "계정 ${account} 를 만듭니다 — 비밀번호를 입력하세요"`,
    `  $pw = Read-Host -AsSecureString "비밀번호 (${account})"`,
    `  New-LocalUser -Name "${account}" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword`,
    `  # 관리자 그룹에 넣지 않는다 (R15.1 — 비관리자 계정).`,
    '}',
    '',
  );
}

lines.push('# ── 경로 권한 ───────────────────────────────────────────────────', '');

for (const entry of entries) {
  // 레이아웃은 이 기계(POSIX)에서 만들어져 구분자가 `/` 다. icacls 는
  // Windows 도구이므로 `\\` 로 바꿔서 넘긴다.
  const path = entry.path
    .replace('__STATE__', '$state')
    .replace('__HOME__', '$home_')
    .replace(/\//g, '\\');
  const quoted = `"${path}"`;
  lines.push(`# ${entry.label}`);
  lines.push(`if (Test-Path ${quoted}) {`);
  // 상속을 끊는다. 끊지 않으면 부모의 Users 권한이 그대로 남아 아래 규칙이
  // 무의미해진다 — icacls 로 권한을 좁힐 때 가장 흔한 실수다.
  lines.push(`  icacls ${quoted} /inheritance:r | Out-Null`);
  for (const [zone, account] of Object.entries(ZONE_ACCOUNTS)) {
    const mode = entry.access[zone];
    if (mode === 'none') {
      lines.push(`  icacls ${quoted} /deny "${account}:(OI)(CI)F" | Out-Null`);
    } else if (mode === 'read') {
      lines.push(`  icacls ${quoted} /grant "${account}:(OI)(CI)R" | Out-Null`);
    } else {
      lines.push(`  icacls ${quoted} /grant "${account}:(OI)(CI)M" | Out-Null`);
    }
  }
  lines.push(`  Write-Host "  ok ${entry.label}"`);
  lines.push('} else {');
  lines.push(
    entry.optional
      ? `  Write-Host "  건너뜀 ${entry.label} (아직 없음 — 선택)"`
      : `  Write-Warning "  없음 ${entry.label} — 먼저 company 를 한 번 실행하세요"`,
  );
  lines.push('}', '');
}

lines.push(
  'Write-Host ""',
  'Write-Host "설정 완료. 확인:  company security verify"',
  '',
);

process.stdout.write(lines.join('\n'));
