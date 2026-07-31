# SEAT-CONTRACT.md

Task 1 산출물. 좌석 CLI의 **실측** 계약. 추정값을 넣지 않는다.
미측정 항목은 `unknown`으로 남긴다 — 조용한 추정이 이 문서의 유일한 실패 모드다.

측정 환경: Windows, 2026-07-30, 개발 PC (최종 운영 대상인 상시 미니PC가 아님)
측정 시 모든 `*_API_KEY` 환경변수를 제거했다. 제거 전에도 전부 unset 상태였으므로
성공한 호출은 OAuth 경로로 동작한 것이 확정된다.

## 요약

| 좌석 | 설치 | OAuth | 비대화형 | 판정 |
|---|---|---|---|---|
| codex | codex-cli 0.144.1 | 유효 | `codex exec -` (stdin) | **동작** |
| claude | 2.1.220 | 유효 | `claude -p "<본문>"` (인자·직접실행) | **동작** — 주간 한도 리셋 후 확인 |
| gemini | 0.24.0 | 캐시된 자격증명 있음 | 위치 인자 | **구성 미비** — `GOOGLE_CLOUD_PROJECT` 필요 |
| cursor | — | — | — | **미설치** — 에이전트 CLI 없음 |

**현재 가동 좌석 2/4. 서로 다른 벤더 2종(openai, anthropic) → 크로스벤더 회의 가능.**

이 문서 첫 판에는 "가동 좌석 1/4" 로 적혀 있었다. claude 가 주간 한도 소진
상태였기 때문이다. 리셋 후 재측정해 동작을 확인했고, 그 과정에서 쿼터 창이
실제로 주간이며 리셋 시각이 20:00 Asia/Seoul 임이 확증됐다.

## 좌석별 상세

### S1 claude (Claude Code 2.1.220)

```
경로       C:\Users\USER\.local\bin\claude.exe   (실행 파일 — 셔틀 아님)
호출       claude -p "<prompt>" --output-format text
           --strict-mcp-config --setting-sources project
실행       셸 없이 직접 spawn. 여러 줄 인자를 전달하려면 필수
```

| 항목 | 실측 |
|---|---|
| 성공 시 종료코드 | **0**, stdout 에 응답 단독 |
| 한도 소진 시 종료코드 | **1** |
| 한도 소진 시 출력 | `You've hit your weekly limit · resets 8pm (Asia/Seoul)` (stdout, 114 bytes) |
| 쿼터 창 | **주간**. 리셋 20:00 Asia/Seoul — 실제 리셋으로 확증 |
| 지연 | 4,325 / 5,060 / 8,717 ms |
| 최대 동시성 | unknown |

**stdin 을 읽지 않는다.** 파이프로 넣으면 출력이 0바이트이고 stderr 에
`Warning: no stdin data received in 3s, proceeding without it` 이 나온다.
즉 프롬프트는 인자로만 받는다. 그런데 여러 줄 인자는 `cmd.exe` 를 거치면
개행에서 깨진다. 그래서 **셸을 우회한 직접 spawn** 이 필요하다 —
`shell: false` 로 띄우면 인자가 CreateProcess 로 그대로 전달되어
개행도 길이 상한도 문제가 없다. 여러 줄 프롬프트로 실측 확인했다.

좌석마다 프롬프트 전달 경로가 다르다는 것이 이 문서의 핵심 발견 중 하나다.
codex 는 셔틀(`.ps1`)이라 셸을 거쳐야 하고 stdin 을 읽는다.
claude 는 실행 파일이라 직접 띄울 수 있고 인자만 읽는다.
`SeatSpec` 에 `promptVia` 와 `spawnMode` 를 함께 둔 이유다.

**최소 프로필 실측** (동일 프롬프트, 직접 spawn):

| 플래그 | 지연 |
|---|---|
| 없음 | 13,122ms |
| `--strict-mcp-config` | 11,860ms |
| `--strict-mcp-config --setting-sources project` | **8,717ms** |

사용자 전역 설정을 제외하면 33% 빨라진다. codex 와 달리 설정 홈 환경변수가
아니라 플래그로 격리한다. 인증은 건드리지 않는다.

**주간 창이 설계에 미치는 영향.** 일일 예산만 관리하면 주중에 좌석 하나가
며칠씩 통째로 사라진다. `SeatSpec.quota` 에 창 종류와 리셋 시각을 담았다.

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

**토큰 실측과 가설 정정.**

처음에 "21k 토큰의 원인은 개인 스킬·MCP 환경"이라고 적었다. 추가 측정으로 **틀렸음이
확인되어 정정한다.**

| 실행 조건 | 토큰 | 스킬 경고 | 모델 / 추론 |
|---|---|---|---|
| 기본 (개인 환경, 워크스페이스 cwd) | 21,068 | 있음 | gpt-5.5 / xhigh |
| `--ignore-user-config` 만 | 22,057 | 있음 | gpt-5.6-sol / none |
| `CODEX_HOME` 격리 + `--ignore-user-config` | **19,357** | 없음 | gpt-5.6-sol / none |

격리가 줄인 것은 약 8%(21,068 → 19,357)에 불과하다. **19.4k 는 codex 자체의 내장
시스템 프롬프트와 도구 정의 오버헤드이고, 오너의 환경 탓이 아니다.**

그래도 격리는 필요하다. 이유가 쿼터가 아니라 **재현성**이기 때문이다.
표에서 보이듯 개인 `config.toml` 이 좌석의 모델과 추론 강도를 바꿨다
(`gpt-5.5/xhigh` → `gpt-5.6-sol/none`). 격리 없이 두면 오너가 자기 에디터 설정을
만질 때 회사 임원의 두뇌가 조용히 교체된다. 컨텍스트 팩으로 같은 호출을 재현한다는
설계 전제가 그 순간 무너진다.

**격리 방식 (실측 확인).**

`codex exec --help` 원문: `--ignore-user-config` 는
"Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`".
즉 `CODEX_HOME` 을 임시 디렉터리로 돌리고 그 안에 **`auth.json` 만** 복사하면
설정·스킬·플러그인은 상속하지 않고 OAuth 세션은 유지된다.
실측 결과 `EXIT=0`, `SEAT_OK`, 스킬 경고 사라짐, 19,357 토큰.

**쿼터 관점의 실제 결론.** 좌석 호출 1회의 하한이 약 19.4k 토큰이다.
임원 6명 2라운드 회의면 12회 호출 × 19.4k ≈ **233k 토큰이 회의 한 번의 최소 비용**이다.
수다스러운 다회차 대화는 이 구조에서 성립하지 않는다. 회의 설계가 호출 수를
아끼는 방향이어야 한다.

**End-to-end 지연 (브로커 경유 실측).** 10,874ms / 13,008ms / 19,339ms.
프롬프트가 한 줄인데도 11~19초가 걸리고 편차가 크다. 라이브오피스의 "경과 시간"
표시가 장식이 아니라 실제로 필요한 이유다.

**프롬프트는 stdin 으로 넘겨야 한다 (레시피 실행에서 발견).**

한 줄 프롬프트는 셸 인자로 잘 동작했지만, 레시피의 여러 줄 지시문을 인자로
넘기자 `exit 1` 로 실패했다. 개행이 명령줄을 깨뜨린 것이다. 그리고 Windows
명령줄 길이 상한이 약 8191자라, 컨텍스트 팩(자료 여러 건 + 역할 정의)을
인자로는 애초에 실을 수 없다.

`codex exec --help` 원문: "[PROMPT] Initial instructions for the agent.
If not provided as an argument (or if `-` is used), instructions are read from stdin."

`codex exec -` 로 stdin 전달을 실측 확인했다 (여러 줄, EXIT=0).
`SeatSpec.promptVia: 'stdin'` 을 기본으로 두고 arg 경로는 예외로 남긴다.

| 좌석 | promptVia | 실측 |
|---|---|---|
| codex | stdin | 확인 |
| claude | stdin | 미확인 (주간 한도) |
| gemini | stdin | 미확인 (계정 구성). 도움말에 "Appended to input on stdin" 명시 |
| cursor | stdin | 미확인 (미설치) |

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

**1. 크로스벤더 회의가 가능해졌다.**
R3.4 는 Critic 이 본체와 다른 벤더 좌석에서 발언할 것을 요구한다. 처음 측정
때는 가동 좌석이 codex 하나뿐이라 불가능했고 Task 6(회의)이 막혀 있었다.
claude 한도 리셋 후 벤더가 둘(openai, anthropic)이 되어 교착이 풀렸다.

실측 확인: `company ask --persona critic --forbid-vendor openai` →
원장에 `critic → claude (5,060ms)`. 금지 벤더를 피해 다른 벤더로 라우팅된다.
`company seats` 마지막 줄이 이 가능 여부를 항상 표시한다.

**2. 프로필 격리는 쿼터가 아니라 재현성 요구다.**
격리의 토큰 절감폭은 8%뿐이다. 진짜 이유는 개인 설정이 좌석의 모델과 추론 강도를
바꾼다는 것(실측)이다. `SeatSpec.configHomeEnv` + 인증 파일만 복사하는 방식으로
구현했고 codex 에서 동작을 확인했다. claude·gemini·cursor 의 격리 수단은 미측정이라
`configHomeEnv: null` 로 두고 브로커가 "개인환경 상속" 으로 정직하게 표시한다.

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

## 검토 후 제외한 경로

### 멀티프로바이더 포크·프록시 (API 키 경로)

`ymichael/open-codex`, `opencodex.me` / `lidge-jun/opencodex` 프록시,
`just-every/code`, AI 게이트웨이 방식을 검토했다. 이들의 "다양한 프로바이더"는
대부분 OpenRouter·DeepSeek 등의 **API 키**로 붙어 R1 과 정면 충돌한다.

이 조사 과정에서 우리 게이트의 구멍을 찾았다. `OPENROUTER_API_KEY` 를 소스에
넣고 `gate:apikey` 를 돌렸더니 **통과했다** — 벤더 이름을 열거형으로 나열했고
목록에 없는 벤더였기 때문이다. 프로바이더는 계속 늘어나므로 허용목록 방식은
언젠가 반드시 뚫린다. `<대문자>_API_KEY` 패턴 전체를 막도록 고쳤다.

### 로컬 모델 (ollama)

키 없이 벤더를 늘리는 대안으로 검토했고 **오너 판단으로 제외했다.**

참고용으로 실측 결과만 남긴다. 설치된 ollama 0.1.34(2024-05-07)가
llama3.2 아키텍처를 로드하지 못했다 — `done_getting_tensors: wrong number of
tensors; expected 147, got 146`. `/api/generate` 는 16분 46초 후 500,
`ollama run` 은 10분 초과. 런타임 업그레이드가 필요한 상태였다.

`AuthMode` 에서 `local` 을 제거해 등록부에는 `oauth` 만 남았다.
다시 필요해지면 방식을 더하고 항목을 추가하면 된다.

### 크로스벤더 교착은 다르게 풀렸다

로컬 좌석의 목적은 R3.4(Critic 은 본체와 다른 벤더) 교착 해소였다.
그런데 claude 의 주간 한도가 리셋되어 **두 번째 벤더가 그냥 열렸다.**
로컬 모델 없이 교착이 풀렸으므로 그 경로는 필요하지 않다.

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
