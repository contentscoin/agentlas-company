# agentlas-company

상시 가동되는 미니PC 한 대를 회사로 삼아, 임원 에이전트가 회의로 사업 목표를 정하고
콘텐츠를 기획·제작·발행하고 성과를 복기해 다음 주 업무를 개선하는 자율 운영 시스템.
오너는 Board 자리에서 승인과 방향 제시만 한다.

## 절대 제약

모든 LLM은 구독 계정 OAuth로 로그인된 로컬 CLI로만 구동한다.
API 키 금지는 문서상 원칙이 아니라 코드 경로에서 차단되고 테스트로 증명된다.

- 좌석 스폰 시 `*_API_KEY` 환경변수를 삭제한다
- CI가 소스 내 `*_API_KEY` 참조 0건을 강제한다 — **벤더 이름이 아니라 패턴으로** 잡는다
- 세션이 만료되면 그 좌석은 멈춘다. API 키로 폴백하지 않는다

프로바이더를 늘리는 문은 `src/seats/providers.ts` 하나다. 인증 방식이
`oauth` 뿐이라 **`apiKey` 를 타입으로 표현할 수 없다.** 멀티프로바이더
포크·프록시·게이트웨이(open-codex, opencodex, AI 게이트웨이)는 대부분
OpenRouter·DeepSeek 같은 API 키로 붙기 때문에 이 등록부에 들어올 수 없다.
표현할 수 없는 것은 구현될 수 없다.

## 3개 평면

| 평면 | 위치 | 역할 |
|---|---|---|
| 회의 | Discord | 임원 회의, 승인 알림, 히스토리 |
| 오피스 | 상시 Windows 11 미니PC | 좌석 브로커, 작업 엔진, Hands, 원장 |
| 콘솔 | 데스크톱 + 모바일 PWA | 라이브오피스, 승인, 능력 스위치 |

오피스 API는 loopback과 사설망 인터페이스에만 바인딩한다. 공개 포트는 없다.

## 좌석 4개

| 좌석 | 호스트 | 배치 역할 |
|---|---|---|
| S1 | Claude Code (Max) | CEO 오케스트레이션 + Critic |
| S2 | Codex CLI (ChatGPT Pro) | CTO 구현 + Planner |
| S3 | Gemini CLI (Google) | Loop 검증 + Research |
| S4 | Cursor CLI | 레포 단위 개발 실행 |

Critic 좌석은 본체와 다른 벤더여야 한다. 의견 다양성을 프롬프트 연기가 아니라
서로 다른 모델로 확보한다. 좌석(4)이 임원(6+)보다 적으므로 회의는 2라운드 턴제로
진행한다 — 1라운드 독립 의견, 2라운드 반론, CEO 집계.

## 설계 원칙 셋

**읽는 것과 실행하는 것을 분리한다.** 에이전트는 매일 신뢰할 수 없는 외부 텍스트를
읽고 동시에 돈과 계정에 닿는 손을 갖는다. 둘이 한 프로세스에 있으면 프롬프트 하나로
회사가 조종된다. 자유 텍스트는 구역 경계를 넘지 못하고 타입 지정된 동사 호출만 넘어간다.

**위험한 능력은 기본으로 꺼져 있다.** 정산계좌 변경, 상품 삭제, 환불, 대량 삭제, 지출
같은 비가역 동사 10종은 능력 스위치로 통제된다. 출하 시 전부 OFF, 켤 때 유효기간 필수,
만료 시 자동 OFF, 재부팅 시 전부 OFF 복귀. 켜져 있어도 개별 실행은 별도 승인이 필요하다.
어떤 에이전트도 스위치를 읽거나 바꿀 수 없다.

```
$ company caps
능력                       상태   남은시간      범위                 사용  거부
price_bulk_change         ON    1시간 59분      smartstore          0    0
spend                     off   -            전체                  0    0
...

$ company caps on price_bulk_change --ttl 2h --step-up --channel smartstore
$ company caps panic --reason "이상 볼륨 감지"     # 인증 요구 없음
```

집행 순서가 설계다. `스위치 ON → 유효기간 → 범위 → 오염 → L3 승인 → 유예 창 → 실행`.
오염 검사가 승인보다 **앞**에 있어서, 프롬프트 인젝션으로 오염된 산출물은
오너가 승인 버튼을 눌러도 위험 능력에 도달하지 못한다.

**침묵은 승인이 아니다.** 승인 카드는 정확한 페이로드 digest 에 묶이고, 내용이 바뀌면
영수증이 무효가 된다. 만료는 통과가 아니라 취소다. 비가역 작업은 승인 뒤에도 유예 창을
지나야 실행되고, 그 사이 등록된 어떤 기기든 중단할 수 있다.

```
$ company classify publish.threads --tainted
기본 등급   L1
최종 등급   L2  ← 승격: tainted
승인 필요   yes

$ node scripts/demo-approval.mjs      # 승인 흐름 전체 시연
```

정책에 없는 작업은 자동이 아니라 L2 로 본다. 새 동작을 추가하면서 정책 등록을 잊는 일은
반드시 생기고, 그때 조용히 자동 실행되면 안 된다.

**인젝션 방어는 프롬프트 설득에 의존하지 않는다.** 에이전트는 매일 댓글·웹페이지를 읽고
동시에 돈과 계정에 닿는 손을 갖는다. 그 둘을 구조로 분리한다.

| 층 | 통제 | 성격 |
|---|---|---|
| 1 | 허용 동사 — 자연어 문자열은 동사가 아니다 | 근본 |
| 2 | 능력 스위치 — 최악의 명령은 기본 OFF | 근본 |
| 3 | 권한 분리 — 훔칠 자격증명이 그 프로세스에 없다 | 근본 (Task 3) |
| 4 | 오염 추적 — 오염된 산출물은 승인으로 승격 | 보조 |
| 5 | 데이터 프레임 — 지시 슬롯과 데이터 슬롯 분리 | 보조 |
| 6 | 결정론적 탐지 — 지시문 형태 문자열을 신호로 | 탐지 |
| 7 | 서킷브레이커 — blast radius 제한 | 피해 억제 |

4~6 층만 쌓는 것이 이 분야의 전형적 실패다. 실제 통제는 1~3 층이다.

```
$ npm run demo:injection
[4차 방어 · 허용 동사]
  자연어 지시:        거부 — 자연어 문자열은 동사가 아니다
  악성 링크 발행:     거부 — 허용되지 않은 링크 도메인: evil.example
[5차 방어 · 능력 스위치]
  스위치 ON + 오염:    거부 — tainted
공격 문장이 원장에 실려 있는가?
  "evil.example" 포함: false
```

수집한 콘텐츠의 신뢰등급은 **출처가 정하고 호출자가 올릴 수 없다.** 댓글·DM·웹·검색결과는
목록으로 0 에 고정된다. 원장에는 본문 대신 digest 만 남긴다 — 공격자가 심은 문장을 원장에
실어 나르면 그 원장을 읽는 다음 에이전트가 같은 공격에 노출된다.

## 회의

임원의 인격은 프롬프트로 흉내낸 성격이 아니라 **좌석 배정**이다. 서로 다른 벤더
모델이 실제로 다른 답을 내는 것이 "독립적인 사고로 토론"의 유일한 실질적 구현이다.
같은 모델에 다른 이름을 붙여 여러 명인 척하는 것은 회의가 아니라 독백이다.

```
$ company meeting --agenda "8월 첫째 주 무엇에 집중할 것인가" --attendees cto,growth
1라운드 cto    → codex  (20502ms)     ← 서로의 발언을 보지 못한다
1라운드 growth → codex  (14295ms)
2라운드 cto    → codex  (14162ms)     ← 다른 임원 1라운드 전문을 받는다
2라운드 growth → codex  (16740ms)
Critic         → claude (17685ms)     ← 본체와 다른 벤더 강제
Critic  WATCH
CEO            → codex  (19147ms)
마감 블록  결정 5 · 미결 5 · 액션 6
companyctl 정규화 완료
```

**Critic 은 본체와 다른 벤더 좌석에 앉는다.** 검증된 벤더가 하나뿐이면 회의를
시작하지 않는다 — 같은 모델이 자기 산출물을 비평하는 것은 교차 비평이 아니다.

**BLOCK 은 다수결로 기각되지 않는다.** War Room 으로 올라가고 오너만 종결할 수 있다.
그 판정을 CEO 가 아니라 프로토콜이 하는 것이 요점이다. 집계하는 주체가 반대 의견의
무게를 정하면 그 반대는 장식이 된다. VERDICT 를 못 찾거나 형식을 어기면 BLOCK 으로
본다 — 그러지 않으면 Critic 을 무력화하는 가장 쉬운 방법이 "형식을 어기는 것"이 된다.

마감 블록 문법과 정규화는 업스트림 `ai-company-discord` 의 PROTOCOLS.md v1 을 따르고
`companyctl decision` 을 진실원천으로 소비한다.

## 반복 업무

업무를 코드가 아니라 선언으로 적는다. 스텝마다 담당 주체, 산출물, 통과를 판정하는
결정론적 게이트 명령을 명시한다.

```
$ company run recipes/smoke.yaml
smoke → paused  (run aba71f4c…)
  passed             draft
  passed             shape-gate
  awaiting-approval  publish-approval  오너 결정 대기
  승인 후 이어서: company run recipes/smoke.yaml --resume aba71f4c…

$ company approvals approve <id> --digest <d> --step-up --device phone-1
$ company run recipes/smoke.yaml --resume aba71f4c…
smoke → completed
  passed             publish-approval  승인 확인
```

**승인 스텝은 블로킹이 아니다.** 승인 카드 TTL 이 12시간인데 예약 작업이 그동안 프로세스를
붙잡으면 좌석이 잠기고 재부팅에도 못 견딘다. 실행은 `paused` 로 끝나고 재개가 이어받으며,
통과한 스텝은 다시 돌지 않는다 — 좌석 호출 1회가 약 19.4k 토큰이라 재실행이 공짜가 아니다.

**상시 기동은 OS 에 위임한다.** 자체 supervisor 를 만들지 않는다. 프로세스를 감시하는
프로세스는 그 자신이 죽으면 아무도 감시하지 않는다. `company schedule` 이 등록 명령문을
출력하고 실제 등록은 오너가 실행한다 — 시스템 스케줄러 변경을 코드가 조용히 하지 않는다.

**조용한 성공을 만들지 않는다.** 미확인은 추정으로 채우지 않고 `unknown`으로 남긴다.
게이트 실패는 다음 스텝을 막는다. Hands가 요소를 못 찾으면 성공으로 승격되지 않는다.

## 현재 상태

**가동 좌석 2/4. 서로 다른 벤더 2종 → 크로스벤더 회의 가능.**

codex(OpenAI)와 claude(Anthropic)가 동작한다. gemini는 계정 구성 미비,
cursor 에이전트 CLI는 미설치다. 자세한 실측값은 `SEAT-CONTRACT.md` 참고.

실측이 설계를 바꾼 것 넷:

- claude 쿼터는 **주간 창**이고 리셋이 20:00 Asia/Seoul이다. 일간 예산으로는 표현되지 않는다
- **좌석마다 프롬프트 전달 경로가 다르다.** codex는 셔틀(`.ps1`)이라 셸을 거쳐
  stdin으로 받고, claude는 실행 파일이라 셸 없이 직접 띄워 인자로 받는다.
  claude에 여러 줄 인자를 셸로 넘기면 개행에서 깨진다
- 최소 프로필은 쿼터가 아니라 **재현성**을 위한 것이다. 개인 설정이 좌석의
  모델과 동작을 바꾼다. claude는 부수적으로 33% 빨라지기도 한다
- 성공한 호출도 stderr에 경고를 낸다. 판정은 종료코드와 산출 파일로만 한다

| 문서 | 내용 |
|---|---|
| `.kiro/specs/agentlas-company/requirements.md` | 요구사항 R1~R17과 수용 기준 |
| `.kiro/specs/agentlas-company/design.md` | 구역, 좌석 브로커, 허용 동사, 능력 스위치, 원장 |
| `.kiro/specs/agentlas-company/tasks.md` | 구현 태스크 17개 |
| `SEAT-CONTRACT.md` | 좌석 CLI 실측 계약 (Task 1) |
| `vendor.lock` | 업스트림 커밋 핀 |
| `policy.example.yaml` | 자율성 등급과 능력 스위치 예시 |

## 업스트림

`ai-company-discord` · `social-ai-team-custom` · `agentlas-sei` · `Agentlas-OS`
소스를 복사하지 않고 커밋 핀으로 소비한다. 자세한 고지는 `NOTICE.md`.

## 라이선스

Apache-2.0
