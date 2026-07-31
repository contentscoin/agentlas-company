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

**1. 크로스벤더 회의가 지금은 불가능하다.**
R3.4는 Critic이 본체와 다른 벤더 좌석에서 발언할 것을 요구한다. 가동 좌석이
codex 하나뿐이라 이 조건을 만족할 수 없다. Task 6(회의)은 최소 2개 벤더가
살아난 뒤에 착수해야 한다.

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

### S5 ollama (로컬 모델 좌석)

오너 요청("오픈코덱스로 다양한 프로바이더")을 제약 안에서 구현한 결과다.
멀티프로바이더 포크·프록시·게이트웨이는 대부분 OpenRouter·DeepSeek 등의
**API 키**로 붙어 R1 에 걸린다. 키 없이 벤더를 늘리는 유일한 두 갈래가
OAuth 로컬 CLI 와 **로컬 모델**이다.

```
설치      ollama 0.1.34 (2024-05-07 설치본)
GPU       GTX 1660 SUPER 6GB, 시스템 RAM 32GB
호출      ollama run <모델>   프롬프트는 stdin 또는 인자
```

| 항목 | 실측 |
|---|---|
| `/api/tags` | 200, 모델 2종 인식 |
| `/api/ps` | **404** — 이 버전에 없는 엔드포인트 |
| `/api/generate` | **타임아웃** (16분 46초 후 500) |
| `ollama run` (stdin) | exit 1, 출력 0바이트 |
| `ollama run` (인자) | 10분 초과, 응답 없음 |

**근본 원인 (server.log).**

```
llama_model_load: error loading model:
  done_getting_tensors: wrong number of tensors; expected 147, got 146
error loading llama server: timed out waiting for llama runner to start
```

설치된 런타임이 2년 이상 오래돼서 llama3.2 아키텍처를 로드하지 못한다.
런너 디렉터리도 `cuda_v11.3` 세대다. 기존 `llama3:latest` 는 blob 이
사라져 이미 깨져 있었다.

**판정: 로컬 좌석은 코드는 완성됐고 런타임이 막고 있다.**
`verified: false` 로 두고 사유를 기록한다. 해결 경로 둘.

1. Ollama 를 최신으로 업그레이드 — 기존 설치 앱을 교체하므로 오너 확인 필요
2. 0.1.34 가 지원하는 세대 모델을 받기 — `llama3:latest` 재수신(4.7GB).
   8B 를 6GB VRAM 에 부분 오프로드하므로 응답이 느릴 수 있다

**이 좌석이 왜 중요한가.** 제약 준수가 아니라 **교착 해소** 때문이다.
지금 검증된 좌석이 codex 하나뿐이라 R3.4(Critic 은 다른 벤더)를 만족할 수
없어 회의(Task 6)가 막혀 있다. 로컬 좌석은 벤더가 다르고 쿼터가 없어
그 교착을 푼다. `company seats` 가 이 상태를 마지막 줄에 명시한다.

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
