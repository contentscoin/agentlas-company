# agentlas-company 구역 권한 설정 (R15.1)
#
# 이 파일은 생성물이다. 직접 고치지 말고 src/zones/layout.ts 를 고친 뒤
#   npm run build && node scripts/zones/emit-icacls.mjs > setup-zones.ps1
# 로 다시 만든다. 검증기(company security verify)가 같은 표를 읽는다.
#
# 관리자 PowerShell 에서 실행한다.

$ErrorActionPreference = "Stop"

$state = "$env:USERPROFILE\.agentlas-company"
$home_ = "$env:USERPROFILE"

# ── 계정 셋 ─────────────────────────────────────────────────────
# 이미 있으면 건너뛴다. 비밀번호는 사람이 정한다 — 스크립트가 정하면
# 그 값이 저장소나 셸 히스토리에 남는다.

if (-not (Get-LocalUser -Name "svc-broker" -ErrorAction SilentlyContinue)) {
  Write-Host "계정 svc-broker 를 만듭니다 — 비밀번호를 입력하세요"
  $pw = Read-Host -AsSecureString "비밀번호 (svc-broker)"
  New-LocalUser -Name "svc-broker" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
  # 관리자 그룹에 넣지 않는다 (R15.1 — 비관리자 계정).
}

if (-not (Get-LocalUser -Name "svc-seats" -ErrorAction SilentlyContinue)) {
  Write-Host "계정 svc-seats 를 만듭니다 — 비밀번호를 입력하세요"
  $pw = Read-Host -AsSecureString "비밀번호 (svc-seats)"
  New-LocalUser -Name "svc-seats" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
  # 관리자 그룹에 넣지 않는다 (R15.1 — 비관리자 계정).
}

# ── 경로 권한 ───────────────────────────────────────────────────

# 원장
if (Test-Path "$state\events.jsonl") {
  icacls "$state\events.jsonl" /inheritance:r | Out-Null
  icacls "$state\events.jsonl" /grant "owner:(OI)(CI)R" | Out-Null
  icacls "$state\events.jsonl" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$state\events.jsonl" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 원장"
} else {
  Write-Warning "  없음 원장 — 먼저 company 를 한 번 실행하세요"
}

# 능력 스위치
if (Test-Path "$state\broker\capabilities.json") {
  icacls "$state\broker\capabilities.json" /inheritance:r | Out-Null
  icacls "$state\broker\capabilities.json" /grant "owner:(OI)(CI)R" | Out-Null
  icacls "$state\broker\capabilities.json" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$state\broker\capabilities.json" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 능력 스위치"
} else {
  Write-Warning "  없음 능력 스위치 — 먼저 company 를 한 번 실행하세요"
}

# 승인 카드
if (Test-Path "$state\broker\approvals.json") {
  icacls "$state\broker\approvals.json" /inheritance:r | Out-Null
  icacls "$state\broker\approvals.json" /grant "owner:(OI)(CI)R" | Out-Null
  icacls "$state\broker\approvals.json" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$state\broker\approvals.json" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 승인 카드"
} else {
  Write-Warning "  없음 승인 카드 — 먼저 company 를 한 번 실행하세요"
}

# 오피스 기기 토큰
if (Test-Path "$state\office\devices.json") {
  icacls "$state\office\devices.json" /inheritance:r | Out-Null
  icacls "$state\office\devices.json" /grant "owner:(OI)(CI)R" | Out-Null
  icacls "$state\office\devices.json" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$state\office\devices.json" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 오피스 기기 토큰"
} else {
  Write-Warning "  없음 오피스 기기 토큰 — 먼저 company 를 한 번 실행하세요"
}

# 단계별 인증 시크릿
if (Test-Path "$state\office\stepup.json") {
  icacls "$state\office\stepup.json" /inheritance:r | Out-Null
  icacls "$state\office\stepup.json" /deny "owner:(OI)(CI)F" | Out-Null
  icacls "$state\office\stepup.json" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$state\office\stepup.json" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 단계별 인증 시크릿"
} else {
  Write-Warning "  없음 단계별 인증 시크릿 — 먼저 company 를 한 번 실행하세요"
}

# 발행 멱등성 기록
if (Test-Path "$state\publish\published.json") {
  icacls "$state\publish\published.json" /inheritance:r | Out-Null
  icacls "$state\publish\published.json" /grant "owner:(OI)(CI)R" | Out-Null
  icacls "$state\publish\published.json" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$state\publish\published.json" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 발행 멱등성 기록"
} else {
  Write-Warning "  없음 발행 멱등성 기록 — 먼저 company 를 한 번 실행하세요"
}

# 브라우저 프로필
if (Test-Path "$home_\.agentlas\chrome-cdp-profile") {
  icacls "$home_\.agentlas\chrome-cdp-profile" /inheritance:r | Out-Null
  icacls "$home_\.agentlas\chrome-cdp-profile" /deny "owner:(OI)(CI)F" | Out-Null
  icacls "$home_\.agentlas\chrome-cdp-profile" /grant "svc-broker:(OI)(CI)M" | Out-Null
  icacls "$home_\.agentlas\chrome-cdp-profile" /deny "svc-seats:(OI)(CI)F" | Out-Null
  Write-Host "  ok 브라우저 프로필"
} else {
  Write-Host "  건너뜀 브라우저 프로필 (아직 없음 — 선택)"
}

# codex OAuth
if (Test-Path "$home_\.codex") {
  icacls "$home_\.codex" /inheritance:r | Out-Null
  icacls "$home_\.codex" /grant "owner:(OI)(CI)R" | Out-Null
  icacls "$home_\.codex" /deny "svc-broker:(OI)(CI)F" | Out-Null
  icacls "$home_\.codex" /grant "svc-seats:(OI)(CI)R" | Out-Null
  Write-Host "  ok codex OAuth"
} else {
  Write-Host "  건너뜀 codex OAuth (아직 없음 — 선택)"
}

Write-Host ""
Write-Host "설정 완료. 확인:  company security verify"
