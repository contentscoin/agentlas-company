# SEAT-CONTRACT.md

Task 1 산출물. 좌석 CLI의 **실측** 계약. 추정값을 넣지 않는다.
미측정 항목은 `unknown`으로 남긴다 — 조용한 추정이 이 문서의 유일한 실패 모드다.

측정 환경: Windows, 2026-07-30, 개발 PC (최종 운영 대상인 상시 미니PC가 아님)
측정 시 모든 `*_API_KEY` 환경변수를 제거했다. 제거 전에도 전부 unset 상태였으므로
성공한 호출은 OAuth 경로로 동작한 것이 확정된다.

## 요약

| 좌석 | 설치 | OAuth | 비대화형 | 판정 |
|---|---|---|---|---|
| claude | 2.1.220 | 유효 | `-p` | **한도 소진** — 주간 한도, 20시(Asia/Seoul) 리셋 |
| codex | codex-cli 0.144.1 | 유효 | `codex exec` | **동작** |
| gemini | 0.24.0 | 캐시된 자격증명 있음 | 위치 인자 | **구성 미비** — `GOOGLE_CLOUD_PROJECT` 필요 |
| cursor | — | — | — | **미설치** — 에이전트 CLI 없음 |

**현재 가동 좌석 1/4.**

## 좌석별 상세

### S1 claude (Claude Code 2.1.220)

```
경로       C:\Users\USER\.local\bin\claude.exe
호출       claude -p "<prompt>"
출력형식   --output-format text | json | stream-json  (--print 전용)
기타       --model, --permission-mode, --input-format
```

| 항목 | 실측 |
|---|---|
| 성공 시 종료코드 | unknown (한도 소진으로 미측정) |
| 한도 소진 시 종료코드 | **1** |
| 한도 소진 시 출력 | `You've hit your weekly limit · resets 8pm (Asia/Seoul)` (stdout, 114 bytes) |
| 쿼터 창 | **주간**. 일간이 아니다 |
| 최대 동시성 | unknown |
| 지연 | unknown |

**중요.** Max 구독의 한도가 주간 단위라는 것은 설계에 직접 영향을 준다.
일일 예산만 관리하면 주중에 좌석 하나가 며칠씩 통째로 사라진다.
`SeatSpec`에 주간 예산과 리셋 시각(로컬 타임존 포함)을 넣어야 한다.

### S2 codex (codex-cli 0.144.1)

```
경로       C:\Users\USER\AppData\Roaming\npm\codex.ps1   (PowerShell 셔틀 → node)
호출       codex exec "<prompt>" --skip-git-repo-check -s read-only -o <파일>
출력       -o/--output-last-message <FILE> 로 최종 메시지만 깨끗하게 회수
기타       --json, --output-schema, -m/--model, -C/--cd, -s/--sandbox
```

| 항목 | 실측 |
|---|---|
| 성공 시 종료코드 | **0** |
| 최종 메시지 회수 | `-o` 파일에 `SEAT_OK` 단독 기록 — 파싱 불필요 |
| 활성 모델 | gpt-5.5 / provider openai |
| approval | never (비대화형에서 자동) |
| sandbox | read-only 지정이 반영됨 |
| **한 줄 프롬프트 토큰** | **21,068** |
| 최대 동시성 | unknown |
| 지연 | unknown (측정값 유실) |

**중요.** 한 줄 프롬프트에 21k 토큰을 썼다. 원인은 프롬프트가 아니라 기본 로드되는
스킬과 MCP 서버다. 출력에 다음 경고가 있었다.

```
warning: Skill descriptions were shortened to fit the 2% skills context budget.
```

좌석 호출마다 21k를 태우면 예산이 프롬프트가 아니라 **환경 때문에** 소진된다.
브로커는 스킬·MCP를 끈 최소 프로필로 좌석을 띄워야 한다.

부수 관찰: stderr에 `codex_models_manager::cache: failed to load models cache:
missing field supports_reasoning_summaries` 경고가 나오지만 호출은 성공했다.
종료코드만 보고 판정해야 하며 stderr 존재를 실패로 해석하면 안 된다.

### S3 gemini (Gemini CLI 0.24.0)

```
경로       C:\Users\USER\scoop\apps\nodejs\current\bin\gemini.ps1
호출       gemini "<prompt>" -o json          ← 위치 인자 사용
주의       -p/--prompt 는 deprecated. 향후 제거 예정
출력형식   -o text | json | stream-json
```

| 항목 | 실측 |
|---|---|
| 종료코드 | **1** |
| OAuth 상태 | `Loaded cached credentials.` — 세션은 존재 |
| 실패 원인 | `This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var` |
| 쿼터 | 공표치 60/분·1000/일은 **개인 Google 계정** 기준. 이 계정에는 적용되지 않음 |
| 최대 동시성 | unknown |

**중요.** 로그인된 계정이 Workspace / Gemini Code Assist 계정이라 GCP 프로젝트 지정을
요구한다. README에 적힌 개인 계정 무료 한도(1000/일)는 **이 계정에 해당하지 않는다.**
선택지는 둘이다.

1. 개인 Google 계정으로 재로그인 → 공표 무료 한도 적용
2. `GOOGLE_CLOUD_PROJECT` 지정 → 구성이 늘고 과금 경로 검토 필요

`policy.example.yaml`에 `gemini: 1000`으로 적어둔 값은 **근거 없는 수치**이므로
계정 방식이 확정될 때까지 0으로 되돌리거나 unknown 표기해야 한다.

부수 관찰: 기동 시 MCP 서버 다수를 탐색하며 `pencil`, `context7`,
`firebase-mcp-server`가 연결 실패하고 `manyfast`, `vercel`은 인증을 요구한다.
codex와 같은 문제 — 좌석은 최소 프로필로 띄워야 한다.

### S4 cursor

```
발견된 것   cursor.cmd 3.13.25 — GUI 에디터 셔틀. --diff/--merge 등 편집기 옵션만
없는 것     cursor-agent (에이전트 CLI)
```

에이전트 CLI가 설치되지 않았다. `--help`에 프롬프트 실행 표면이 없다.
R1.5에 따라 Cloud Agents API는 사용할 수 없으므로, 이 좌석을 쓰려면
Cursor 에이전트 CLI를 별도 설치하고 OAuth 로그인해야 한다. 미설치 상태로는 `unknown`.

## 설계에 미치는 영향

**1. 크로스벤더 회의가 지금은 불가능하다.**
R3.4는 Critic이 본체와 다른 벤더 좌석에서 발언할 것을 요구한다. 가동 좌석이
codex 하나뿐이라 이 조건을 만족할 수 없다. Task 6(회의)은 최소 2개 벤더가
살아난 뒤에 착수해야 한다.

**2. 최소 프로필이 새 요구사항이다.**
codex와 gemini 모두 스킬·MCP를 기본 로드해 컨텍스트를 크게 먹고 기동이 느려지며
실패 노이즈를 만든다. `SeatSpec`에 최소 프로필(스킬 비활성, MCP 비활성, 고정 모델)을
넣고, 좌석 호출이 사용자의 개인 개발 환경 설정을 상속하지 않도록 격리해야 한다.
이는 R2.5(per-run 작업 디렉터리)의 연장선이며 재현성 요구와도 맞물린다.

**3. 쿼터 모델이 일간만으로는 부족하다.**
claude는 주간 창이다. `SeatSpec.dailyBudget` 하나로는 표현되지 않으므로
`quotaWindows: [{ window: 'week', resetAt: '20:00 Asia/Seoul' }]` 형태가 필요하다.

**4. 판정은 종료코드로만 한다.**
codex는 성공했는데도 stderr에 경고를 냈다. PowerShell 셔틀(`.ps1`)을 거치는 좌석은
stderr가 `NativeCommandError`로 승격되어 호출자를 오도한다. 브로커는 종료코드와
`-o` 산출 파일만 신뢰해야 한다.

**5. 좌석 스폰은 PowerShell 셔틀을 거친다.**
codex와 gemini가 `.ps1` 셔틀이다. `proc.js`의 Windows 인용 처리가 필요한 이유가
여기서 실측으로 확인됐다.

## 미측정 항목 (다음 측정 대상)

| 항목 | 왜 아직 안 했는가 |
|---|---|
| 좌석별 최대 동시성 | 최소 프로필 확정 전에 재면 21k 토큰이 병렬로 낭비된다 |
| 성공 지연(p50/p95) | 동일 |
| claude 성공 시 종료코드·출력 스키마 | 주간 한도 리셋 후 |
| gemini 실제 쿼터 | 계정 방식 확정 후 |
| cursor 전체 | 에이전트 CLI 설치 후 |
| 세션 만료 증상·복구 절차 | 만료를 강제로 유발해야 하므로 별도 진행 |
| 미니PC 기준 재측정 | 최종 운영 환경이 다른 기계이므로 전 항목 재확인 필요 |

## 결론

Task 2(저장소 골격과 린트 게이트)는 좌석 가동과 무관하므로 **지금 착수 가능**하다.
Task 5(Seat Broker)는 최소 프로필 설계가 이 문서에 반영된 상태이므로 착수 가능하나,
동시성 상수는 최소 프로필이 만들어진 뒤 측정해 채운다.
Task 6(회의)은 2개 벤더 가동이 선행 조건이다.
