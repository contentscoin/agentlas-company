# Implementation Plan — agentlas-company

각 태스크는 독립적으로 시연 가능해야 하고, 완료 시 요구사항 번호로 추적됩니다.
태스크 1이 완료되기 전에는 런타임 코드를 추가하지 않습니다.

## 2026-08-02 재정의 — company 는 통제, desktop 은 실행

`agentlas-desktop`(v0.9.29, TS/TSX 627개)이 Hands·모바일·Studio·Hub 를 이미 갖고 있다는
사실을 확인했습니다. Task 9~17 은 그걸 모르는 채로 세워졌고, 그대로 두면 전부 다시
만들게 됩니다. **company 의 고유 가치는 통제 계층** — 해시체인 원장, 정책 등급·승인 게이트,
능력 스위치, 오염 추적, 크로스벤더 회의 프로토콜 — 이고 desktop 에 이게 없습니다.
실행 표면은 desktop 것을 씁니다. 설계 §agentlas-desktop 경계 참조.

| 태스크 | 처리 | 근거 |
|---|---|---|
| 9 발행 | **자체 구현 유지** | desktop 에 채널 발행 구현 없음 |
| 10 Hands | **desktop 연동** | 브라우저 CDP 런처 (computer-use 는 macOS 전용 — 8/2 정정) |
| 11 Studio | **범위 축소 — 완료** | 좌석 산출·브랜드 게이트만. 이미지·영상은 표면 부재로 보류 |
| 14 오피스·모바일 | **오피스 API 자체 구현 / 모바일 미해결** | 브리지가 desktop 내부 스토어에 직접 결합 — 8/2 정정 |
| 16 채용 | **desktop 연동 + 선행조건** | Hub 는 있으나 게이트 훅이 desktop 변경을 요구 |
| 17 무인운영 | **자체 구현 유지** | desktop automation 은 대상이 다름 |

연동 범위를 정한 것은 헤드리스 도달성입니다. desktop 기능 대부분이 `electron/ipc.ts` 의
`ipcMain.handle` **486개** 뒤에 있어 Electron 렌더러에서만 호출됩니다. 밖으로 나온 표면은
`mcp-tools/browser-cdp-launcher`(MCP stdio) · `mobile-bridge/server` ·
`browser/approval-server` · `mcp-tools/registry` 이고, 이것이 연동 가능 범위의 전부입니다.
`computer-use/control-server` 도 밖으로 나와 있지만 **macOS 전용**이라 Windows 대상에서는
쓰지 못합니다 (Task 10 항목의 정정 참조).

**8.1 은 Task 14 에서 닫혔습니다** — TOTP 기반 단계별 인증. 아래 주의의 전제가
해소되었으므로 Task 9 의 L3 실물 인증 의존은 더 이상 막혀 있지 않습니다.

**주의 — 순서가 바뀌었습니다.** 이전 권고는 "Task 9 먼저"였습니다. 재정의 후 Task 9 는
Task 10(네이버 블로그 Hands 경로)에 의존하고, L3 비가역 작업인 실제 발행은 8.1 단계별
인증이 자리표시자인 채로 켜면 안 됩니다. 8.1 은 Task 14 에서 해소됩니다.
따라서 **10 → 14 → 9** 가 새 임계 경로입니다.

- [x] 1. 좌석 계약 실측 — `SEAT-CONTRACT.md`
  - [x] 4개 CLI의 설치 여부·버전·비대화형 명령·출력 형식·종료 코드 측정
  - [x] 모든 `*_API_KEY`를 제거한 환경에서 호출 (제거 전에도 전부 unset이었음 → OAuth 경로 확정)
  - [x] Cursor 판정: 에이전트 CLI 미설치, GUI 셔틀만 존재
  - [x] 실측이 드러낸 설계 영향 5건 문서화 (주간 쿼터, 최소 프로필, 종료코드 단독 판정 등)
  - [ ] 1.1 최소 프로필 확정 후 좌석별 최대 동시성과 지연 측정
  - [ ] 1.2 claude 주간 한도 리셋 후 성공 종료코드·출력 스키마 측정
  - [ ] 1.3 gemini 계정 방식 확정(개인 계정 재로그인 또는 프로젝트 지정) 후 쿼터 측정
  - [ ] 1.4 Cursor 에이전트 CLI 설치 후 전 항목 측정
  - [ ] 1.5 최종 운영 대상 미니PC에서 전 항목 재측정
  - _Requirements: R1, R2_

- [x] 2. 저장소 골격과 금지 게이트
  - [x] `vendor.lock`에 업스트림 4개 커밋 SHA 핀
  - [x] `proc.js` → `src/proc` TypeScript 이식 (원저작 인용 유지, `isAlive` 추가)
  - [x] 게이트 3종: `gate:apikey`, `gate:flags`, `gate:liveness` — 종료코드 0/1/2 규약
  - [x] 키 이름은 정본 `src/seats/strip-env.ts` 에만 허용, 값 읽기는 어디서도 금지
  - [x] CI 매트릭스 windows-latest 1순위 + 비밀 유출 방지 잡
  - [x] 검증: 게이트 3종 PASS, `tsc` 0 오류, 22개 테스트 통과
  - _Requirements: R1.1, R1.2, R1.3_

- [x] 3. 구역과 자격증명 레이아웃 (Windows 적용은 미완 — 아래 참조)
  - `src/zones/layout.ts` — 어떤 경로가 어느 구역 소유인지의 **정본 하나**.
    `icacls` 스크립트와 검증기가 같은 표를 읽는다. 정본이 둘이면 스크립트는
    열어 두고 검증기는 닫혔다고 보고하는 상태가 된다 — Task 10 에서 Chrome
    목록이 어긋났던 것과 같은 함정이고 권한에서는 결과가 훨씬 나쁘다
  - `scripts/zones/emit-icacls.mjs` — `.ps1` 을 레이아웃에서 **생성**한다
    (`npm run zones:emit`). 상속을 먼저 끊는다 — 끊지 않으면 부모의 Users
    권한이 남아 아래 규칙이 무의미해진다. 비밀번호는 사람이 입력한다
  - `src/zones/verify.ts` — 판정이 넷이다: `ok`/`violation`/`unknown`/`absent`.
    **확인하지 못한 것을 통과로 보고하지 않는다.** POSIX 는 mode 로 정확히,
    Windows 는 `icacls` 파싱이라 확신 못 하면 `unknown`
  - `src/zones/lint.ts` — 비밀·PII 린트 (R15.5). **`Finding` 에 값을 담을 필드가
    아예 없다** (R15.6) — 담을 곳이 없으면 실수로 담을 수도 없다. 린트 보고서
    자체가 유출 경로가 되는 것을 구조로 막는다. 카드번호는 Luhn 으로,
    주민번호는 생년월일로 확인한다(체크섬은 보지 않는다 — 2020년 10월 이후
    발급분은 뒤 6자리가 임의라 체크섬으로 거르면 진짜를 놓친다)
  - 린트를 발행 브로커에 물렸다. **드라이런에도 적용한다** — 드라이런 출력은
    로그·원장·오너 폰으로 흘러가므로 "실제로 안 나가니까 괜찮다" 가 성립하지 않는다
  - `src/zones/private.ts` — **실측이 찾은 실제 결함을 고쳤다.** company 가 자기
    상태 파일을 `0644` 로 만들고 있었다. 원장·기기 토큰·TOTP 시크릿·능력
    스위치가 전부 월드 리더블이면 구역 분리가 무의미하다. 스크립트로 나중에
    조이는 것에 의존하면 첫 실행부터 스크립트를 돌릴 때까지의 창이 열려 있고,
    하필 그때 그 파일들이 처음 생긴다. 이제 만들 때부터 `0600` 이다
  - 실측: `security verify` 가 `mode 644 — 소유자 외 접근 가능` 4건을 잡았고,
    고친 뒤 **열림 0**. 별도 OS 계정(`seatu`)으로 원장·기기 토큰·TOTP 시크릿을
    읽으려 시도해 **셋 다 거부**됨을 확인 (R15.2). 소유자는 정상 읽힘.
    비밀 섞인 본문의 발행은 드라이런에서도 차단되고 원장에 값이 **0건** 샜다
  - _Requirements: R15.2~R15.8 (R15.1 은 아래 3.2 참조)_

  - [ ] 3.1 좌석 간 격리 — 지금은 좌석 전체가 `svc-seats` 한 계정을 쓰고, 좌석
        끼리는 `SeatProfile` 의 per-run 디렉터리로만 나뉜다. **같은 계정 안의**
        격리라 완전하지 않다. 좌석마다 OS 계정을 줄지, 프로필 격리로 충분하다고
        볼지 결정해야 한다
  - [ ] 3.2 Windows 실적용 — `setup-zones.ps1` 은 생성됐으나 실행해 본 적이 없다.
        계정 생성·ACL 적용·`icacls` 파싱 판정을 실제 Windows 에서 확인해야 한다.
        지금 검증기의 Windows 경로는 단위 테스트로만 검증됐다
  - [ ] 3.3 인제스트 경로 린트 — R15.5 는 발행과 인제스트 **양쪽**을 요구하는데
        지금은 발행에만 물렸다. 수집 경로가 생기면 거기도 물린다

- [x] 4. 해시체인 원장
  - [x] append-only JSONL, `prevHash` SHA-256 체인, fsync, 재시작 후 체인 연결
  - [x] 프로세스 간 배타 락 — 실제 사고 수정. 두 프로세스가 동시 append 해
        seq 2 가 두 번 쓰이고 체인이 깨졌다. 락 안에서 파일 꼬리를 다시 읽는다
  - [x] `verify()` — 내용 개조·해시 재계산 개조·이벤트 삭제·잘린 줄을 각각 다른 문제로 구분
  - [x] 손상 시 `lastGoodSeq` 보고 (조용히 넘어가지 않는다)
  - [x] 필터 조회(시간·주체·종류·등급·런·오염)와 `replay(runId)`
  - [x] 본문은 원장 밖, `payloadDigest` 만 기록
  - [x] 시연: `company history`, `company verify` 동작 확인
  - [ ] 4.1 암호화 오프사이트 백업 (R9.6) — 키 관리 방식 미정
  - _Requirements: R9_

- [x] 5. Seat Broker
  - [x] 좌석별 동시성 세마포어, 예산 집계, 폴백 체인, 타임아웃 시 프로세스 트리 종료
  - [x] 환경 위생 강제(API 키 삭제), per-run 작업 디렉터리 (R2.5)
  - [x] 프로필 격리 — `configHomeEnv` 임시 디렉터리 + 인증 파일만 복사. codex 실측 확인
  - [x] 판정은 종료코드와 산출 파일로만. stderr 존재는 실패가 아니다
  - [x] 미검증 좌석은 `allowUnverified` 없이 쓰지 않는다
  - [x] 크로스벤더 강제 — 후보가 없으면 폴백하지 않고 실패 (R3.4 보호)
  - [x] 쿼터 소진 좌석을 창 종료까지 제외 (실측 문구 기반)
  - [x] 모든 호출과 거부를 원장에 기록, 오염 자동 전파
  - [x] 시연: `company ask --persona ceo "..."` → codex 응답 10,874ms, 원장 1건, verify 정상
  - [ ] 5.1 예산 카운터 영속화 — 지금은 프로세스 메모리에만 있어 재시작 시 초기화된다
  - _Requirements: R1.1, R1.4, R2_

- [x] 6. 조직과 회의
  - [x] 임원 7명 정의 — 인격은 프롬프트가 아니라 좌석 배정이다
  - [x] 1라운드 독립 수집 — 다른 임원 발언을 주지 않는다 (R3.1)
  - [x] 2라운드 반론 — 다른 임원 1라운드 **전문** 제공, 자기 발언은 제외 (R3.2)
  - [x] CEO 집계 → `DECISION`/`OPEN`/`ACTIONS` 마감 블록. 형식 위반 시 실패 (R3.3)
  - [x] 좌석 배치가 Critic 에게 본체 벤더를 금지. 벤더 1종이면 시작조차 안 함 (R3.4)
  - [x] VERDICT 파싱 — 값이 없거나 형식 위반이면 BLOCK. BLOCKERS 있는 CLEAR 는 강등
  - [x] BLOCK 은 다수결로 기각되지 않고 War Room 으로. 판정 주체는 CEO 가 아니라 프로토콜 (R3.5, R3.7)
  - [x] `companyctl decision --dry-run` 으로 정규화. 도구 부재 시 건너뛴 사실을 남긴다 (R3.6)
  - [x] 마감 블록은 BOM 없이 쓴다 — BOM 이 업스트림 파서의 첫 줄을 삼킨다(실측)
  - [x] 실측 회의: 임원 2명 2라운드 + Critic(claude) + CEO(codex) 6회 호출, 1분 40초
  - [x] 결과: Critic WATCH 5건이 결정에 반영됨. 결정 5 · 미결 5 · 액션 6, 업스트림 정규화 통과
  - [ ] 6.1 War Room 종결 UI — 오너 종결 경로는 Task 14 콘솔에서 붙인다
  - [ ] 6.2 동일 과제 2회 실패 카운터 영속화 (R3.7 후반부)
  - _Requirements: R3_

- [x] 7. 정책 게이트와 승인
  - [x] `policy.yaml` 로딩(YAML), 부재 시 기본 정책을 쓰되 그 사실을 알린다
  - [x] 등급 판정 — 정확 일치와 접두 일치, 여러 등급에 걸치면 높은 쪽
  - [x] 안전 기본값 — 정책에 없는 작업은 자동이 아니라 L2
  - [x] 비가역 작업은 정책에 어떻게 적혀 있든 최소 L3
  - [x] 승격 — Critic BLOCK, SEI 리스크, 오염. 겹치면 여러 칸, L3 에서 멈춤
  - [x] digest 바인딩. 승인 시점과 실행 시점 양쪽에서 검증, 불일치는 `invalidated`
  - [x] 신원 허용목록 검사 후 단계별 인증 검사 (L3 만 인증 요구)
  - [x] 만료는 취소 — 상태 기계에 `expired` 를 두어 통과 경로를 제거
  - [x] 유예 창 — 비가역 작업만 적용, 다른 기기가 중단 가능
  - [x] 일회성 소비 — 승인 하나로 두 번 실행할 수 없다
  - [x] 다기기 알림 — L3 승인 시 승인한 기기를 제외한 등록 기기에 통보
  - [x] 재시작 후 승인 상태 유지, 손상된 저장소는 "승인 없음"으로 해석
  - [x] 시연: `company classify`, `company approvals`, `scripts/demo-approval.mjs`
  - [ ] 7.1 작업 엔진과 연결 — 지금은 카드를 시연 스크립트가 만든다. Task 15 에서 레시피가 만든다
  - _Requirements: R4, R16.4_

- [x] 8. 능력 스위치
  - [x] 위험 능력 10종 등록, 출하 시 전부 OFF, 저장소 손상 시에도 OFF 로 해석
  - [x] 유효기간 필수 — 단위 없는 값·0·음수·무기한을 모두 거부
  - [x] 만료 시 자동 OFF 복귀 + 사유를 원장에 기록
  - [x] 재부팅 시 전부 OFF — 부팅 세션 식별자로 부여를 무효화 (R17.3)
  - [x] 범위 지정(채널·계정). 범위 밖 대상과 대상 누락을 모두 거부
  - [x] 구역 격리 — 좌석은 읽기·쓰기·전체차단 모두 거부되고 시도가 원장에 남는다
  - [x] 오너 변경에 단계별 인증 요구. 전체 차단은 인증 없이 통과(킬 스위치에 마찰 금지)
  - [x] 7단계 집행 순서의 1~5단계 구현. tainted 검사가 승인 검사보다 앞
  - [x] 스위치 ON 이 승인을 대체하지 않음. digest 불일치 시 영수증 무효
  - [x] 전체 차단 + 진행 중 작업 중단 신호 + 모든 오너 기기 알림
  - [x] 상태 화면 — 남은 시간·범위·최근 사용·최근 거부
  - [x] 계약 테스트: 10종 전부 OFF 에서 거부되고 원장에 `deny` 10건
  - [x] 시연: `company caps`, `caps on --ttl 2h --channel`, `caps panic` 실제 동작 확인
  - [x] 8.1 실물 단계별 인증 — Task 14 에서 TOTP(RFC 6238)로 닫았다. 기본 검증기는
        전부 거부라 등록 없이 L3 이 통과하지 않는다. CLI 의 `--step-up` 자리표시자는
        오피스 API 경로에서는 더 이상 쓰이지 않는다 (CLI 자체는 8.3 참조)
  - [ ] 8.3 CLI 의 `--step-up` 플래그도 TOTP 로 바꾼다. 지금은 오피스 API 만
        실물 인증을 쓰고 CLI 는 여전히 플래그로 통과한다 — 같은 구멍이 좁은 채로 남아 있다
  - [ ] 8.2 6단계 유예 창은 Task 7(정책 게이트)에서 붙인다
  - _Requirements: R8, R15.8, R16.5, R17.3_

- [x] 9. 허용 동사와 첫 발행 루프 (실계정 발행은 미완 — 아래 참조)
  - **재정의 없음 — 자체 구현으로 남는다(2026-08-02 확인).** desktop 에 채널 발행
    구현이 없다. `creative-pack/`·`ecommerce-pack/` 은 각각 `surface.ts` 하나이고
    `threads`·`instagram` 은 `experience/taxonomy.ts`·`mcp-tools/catalog.ts` 의 문자열이다
  - `publish/types.ts` — `PublishRequest` 하나로 두 경로를 덮는다 (R6.1). 어댑터
    인터페이스를 좁게 잡아 Hands 채널만 별도 필드를 요구하는 일이 없게 했다
  - `publish/ledgerstore.ts` — 멱등성 기록과 일일 카운터 (R6.3, R6.5). 원장이
    아니라 인덱스다. 원장은 선형 탐색이라 발행 직전마다 훑으면 느려지고, 느려진
    만큼 중복 요청이 겹칠 창이 넓어진다. 날짜는 로컬 시간으로 센다
  - `publish/broker.ts` — 오염 → 멱등성 → 상한 → 준비 → 드라이런 → 게이트 → 발행.
    **멱등성이 상한보다 앞이다** — 뒤에 두면 이미 나간 발행의 재확인이 상한에
    걸려 호출자가 발행 여부를 알 수 없게 된다. **드라이런이 게이트보다 앞이다** —
    구경하려고 승인 카드를 쌓지 않는다
  - `publish/adapters/threads.ts` — OAuth API 경로. 2단계(컨테이너 생성 → 발행)이고,
    1단계만 성공하면 그 사실을 체크리스트에 적는다 — 사람이 컨테이너를 두 번
    만들지 않도록. 토큰 부재는 "실패" 가 아니라 "설정 안 됨" 으로 구분한다
  - `publish/adapters/naver-blog.ts` — Hands 경로. 선택자를 박지 않고 스냅샷에서
    찾는다. 못 찾으면 멈춘다 (R7.5)
  - `publish/aggregate.ts` — **R7.6 을 여기서 닫았다.** 화이트리스트다. 블랙리스트로
    만들면 다음 달에 `recipientMemo` 가 생길 때 그대로 샌다. 막힌 필드는 이름만
    보고한다 — 값을 함께 돌려주면 그 보고 필드가 유출 경로가 된다
  - **R7.2 도 여기서 닫았다.** `browser_take_screenshot` 이 돌려주는 base64 이미지를
    받아 증거 디렉터리에 쓴다. 텍스트 블록에도 경로가 실려 오지만 그것은
    playwright 의 임시 디렉터리이고, 남의 임시 파일을 증거라고 부를 수는 없다
  - 실측 완주: 드라이런 → 게이트 거부 → 오너 승인 → **실제 Chromium 으로 발행** →
    URL 증거(`/posted`) + PNG 6,700바이트 저장 → 같은 키 재요청은 `이미 발행됨`.
    원장에 `publish` 2건(발행 1, 중복 1)
  - **실계정 미완**: 로컬 모의 페이지로 확인했다. 네이버 계정·쓰레드 OAuth 토큰이
    없고 컨테이너에서 외부 https 가 프록시에 막힌다. 경로는 검증됐고 자격증명이 남았다
  - _Requirements: R6, R7.2, R7.6_

  - [ ] 9.1 실계정 1회 발행 — 네이버 로그인 세션이 있는 프로필과 desktop 기동
        상태에서 완주. 여기서 실제 화면의 요소 패턴(`@find:` 정규식)도 확정한다
  - [ ] 9.2 쓰레드 OAuth 토큰 발급 후 API 경로 실측. 지금은 `ready()` 가 거짓이라
        설정 안 됨으로 막힌다
  - [ ] 9.3 스마트스토어 읽기 동사 — `aggregate.ts` 는 준비됐으나 그것을 부르는
        어댑터가 없다. `read_metrics` 를 스마트스토어 화면에 붙인다

- [x] 10. Hands — desktop 브라우저 CDP 런처 연동
  - **재정의 정정(2026-08-02).** 8/2 1차 재정의는 `computer-use` 제어 서버에 붙는다고
    적었다. **틀렸다.** 실제 소스 확인 결과 그 표면은 **macOS 전용**이다 —
    `control-server.ts:236` 이 `process.platform !== 'darwin'` 이면 서버를 아예 띄우지
    않고, `native-driver.ts:47` 도 같으며, `native/` 에는 `macos` 만 있다.
    우리 운영 대상은 Windows 다(설계 §Windows 배치, CI 매트릭스 windows-latest 1순위).
    **그 계획대로 만들었다면 대상 플랫폼에서 한 줄도 돌지 않았다.**
  - 대신 붙은 곳: desktop 이 물질화하는 `~/.agentlas/agentlas-browser-cdp.mjs`.
    `@playwright/mcp` 앞에 선 MCP stdio 프록시이며 **크로스플랫폼**이고, 원래 태스크
    문구가 요구한 "전용 브라우저 프로필 + CDP" 바로 그것이다. Task 9 의 네이버 블로그
    발행이 필요로 하는 것도 네이티브 입력이 아니라 이 경로다
  - `src/hands/types.ts` — 동사 8종만 노출하는 **닫힌 목록**. `browser_evaluate`(임의 JS),
    `browser_cookie_*`·`browser_localstorage_*`(자격증명 표면), `browser_mouse_*_xy`(좌표
    조작)는 의도적으로 제외하고 제외 이유를 주석으로 고정했다
  - `src/hands/parse.ts` — 문자열 입력 즉시 거부(R16.7), 알 수 없는 필드 거부,
    URL 은 **파싱된 호스트**로 허용목록 대조(R7.4). `evil.com/?next=blog.naver.com` 같은
    문자열 포함 우회를 막는다
  - `src/hands/locate.ts` — 실패 사유를 구분한다: `launcher-missing` / `chrome-missing` /
    `desktop-not-running` / `node-missing`. 오너가 해야 할 일이 각각 다르다
  - `src/hands/mcp.ts` — 최소 MCP stdio 클라이언트(initialize·tools/list·tools/call).
    무응답은 타임아웃으로 실패하며 성공이 되지 않는다. 종료는 `proc.killTree`
  - `src/hands/executor.ts` — 오염 계획 거부 → 게이트 → 단계 실행 → 원장.
    실패 시 남은 단계를 사람이 이어받을 체크리스트로 산출(R7.5)
  - 조작 하나에 게이트가 둘이다 — company 승인 게이트와, 런처가 결제·게시·삭제에
    대해 desktop 승인 UI 로 거는 게이트
  - **실제 브라우저 왕복 확인 완료(2026-08-02).** desktop 소스에서 런처를 물질화하고
    Chromium 141 로 실행해 `company hands` 를 완주시켰다 — navigate·snapshot·screenshot
    3단계 전부 ok, 스냅샷이 실제 접근성 트리(`heading … [ref=e2]`, `textbox "제목"
    [ref=e3]`)를 반환했다. 원장 14건 무결성 정상. 가짜 서버가 아니라
    company → 런처 → @playwright/mcp → 진짜 Chromium 의 전 구간이다
  - `planNeedsDesktop` — desktop 요구 여부를 계획으로 판정한다. 런처는 실행 시점의
    요소 텍스트·URL 로 게이팅해서 미리 알 수 없으므로, 기준을 **부분 적용의 위험**에
    두었다. 읽기 전용 계획은 실패해도 세상을 반쯤 바꾸지 못하고 조작 계획은 바꿀 수
    있다. 실측에서 조작 계획이 0단계 실행 **전에** 멈추는 것을 확인했다
  - **미구현**: R7.2 단계별 스크린샷 증거는 도구 보고의 digest 만 남긴다. 이미지 파일
    보존은 실제 브라우저 왕복을 보고 정해야 해서 열어 뒀다
  - **미구현**: R7.6 스마트스토어 집계값 전용. 읽기 동사가 아직 없어 Task 9 에서 붙인다
  - _Requirements: R7.1, R7.3, R7.4, R7.5 (R7.2·R7.6 은 위 미구현 참조)_
  - _업스트림: agentlas-desktop `electron/mcp-tools/browser-cdp-launcher.ts`, `electron/browser/`_

  - [ ] 10.1 Windows + desktop 기동 상태에서 조작 동사(click/type) 1회 실행.
        읽기 전용 경로는 Linux/Chromium 으로 확인했으나, 조작 경로는 desktop 승인
        게이트가 실제로 떠야 통과한다. 여기서 R7.2 증거 형식도 확정한다
  - [ ] 10.2 desktop 미설치 환경의 동작 확정 — 지금은 `surface-unavailable` 로 막는다.
        체크리스트 폴백으로 강등할지는 Task 9 실사용 후 결정

- [x] 11. Studio — 좌석 산출 + 브랜드 게이트 (범위 축소, 이미지·영상 보류)
  - **재정의(2026-08-02) 그대로 유효.** desktop 의 Studio 계열은 전부 `ipcMain`
    뒤에 있어 헤드리스로 닿지 않는다. 이번에도 표면을 다시 뒤졌고 결론은 같다
  - `src/studio/artifact.ts` — 슬롯 상태를 타입으로 강제한다. **미충족 슬롯에는
    산출물을 담을 필드가 아예 없다.** 담을 곳이 없으면 추정해서 채울 수도 없다.
    `unmet`(아직 안 만듦)과 `blocked`(만들 수 없음)를 구분하는데, 오너가 할 일이
    다르기 때문이다 — 앞은 기다리면 되고 뒤는 설치하거나 요청해야 한다
  - `src/studio/brandpack.ts` — master_sheet·character_sheet·content_base 대조.
    **한국어 경계를 앞뒤 다르게 본다.** 앞에 붙은 한글은 합성어("아이라이너"),
    뒤에 붙은 한글은 조사·어미("라이너를")다. 처음엔 앞뒤 모두 막았는데 그러면
    조사가 붙은 **대부분의 실제 문장**을 놓친다 — 한국어에서 금지어가 조사 없이
    홀로 나오는 경우가 오히려 드물다
  - `src/studio/studio.ts` — 좌석 산출 + 인용 추출(R5.1). **인용을 지어내지
    않는다** — 없으면 빈 배열이고 그 사실이 슬롯에 남는다
  - 브랜드 게이트를 발행 브로커에 물렸다 (R5.5). `brandPass !== true` 면 막는데,
    **`undefined` 도 막는다** — 검사를 건너뛴 것을 통과로 읽으면 검사가 없는 것과
    같다. CLI 는 `--brand-ok` 로 오너가 책임을 명시해야 통과한다
  - 실측: `claude` 좌석으로 copy·plan 산출, image·video 는 desktop 표면 부재로,
    program 은 cursor 좌석 부재로 **막힘 표기**. 브랜드 게이트가 좌석이 지어낸
    마케팅 수치 4건("10배", "90%"×2, "100%")을 근거 없음으로 잡아 발행을 막았다 —
    이 요구사항이 존재하는 이유가 그대로 재현됐다
  - **실측이 찾은 실제 버그를 고쳤다**: `src/proc` 가 자식 stdin 에 쓸 때
    EPIPE 를 처리하지 않아, 좌석 CLI 가 없어 자식이 즉시 종료하면 **company 가
    통째로 죽었다**. 좌석이 없는 것은 흔한 상태이고 그때 죽으면 안 된다
  - _Requirements: R5.1, R5.4, R5.5 (R5.2·R5.3·R5.6 은 아래 참조)_

  - [ ] 11.1 desktop 에 Studio 외부 표면 요청 — 표면이 생기면 이미지·영상
        슬롯(R5.2)을 채운다. Task 16.0 과 같은 성격의 선행 조건
  - [ ] 11.2 프로그램 슬롯(R5.3) — Cursor 좌석이 선행 조건이다 (Task 1.4).
        커밋 해시를 원장에 기록하는 경로도 아직 없다
  - [ ] 11.3 생성 코드 격리 실행(R5.6) — `SeatBroker` 의 per-run 디렉터리가
        절반을 담당하지만, 생성된 코드를 **실행**하는 경로 자체가 아직 없다.
        프로덕션 배포 L3 분류도 그때 붙인다
  - [ ] 11.4 근거 없는 주장 탐지의 한계 — 지금은 숫자·순위·의학 표현만 잡는다.
        패턴 없는 주장("업계를 선도합니다")은 통과한다. 이 한계를 문서에 남겼으나
        탐지 범위를 넓힐지는 실사용 오탐률을 보고 정한다

- [x] 12. 오염 추적과 인젝션 방어
  - [x] 신뢰등급은 출처가 정한다 — 외부 출처는 목록으로 0 에 고정, 호출자가 올릴 수 없다
  - [x] 수집 시 출처·신뢰등급·탐지 신호를 원장에 기록. 본문은 digest 만 남긴다
  - [x] 결정론적 지시문 탐지 8종 — 한국어·영어. 매칭 문장은 원장에 담지 않는다
  - [x] 컨텍스트 팩 — 지시 슬롯과 데이터 슬롯 분리, 오염 자동 계산, 재현 가능한 digest
  - [x] `askWithPack` — 오염 전파를 호출자가 잊을 수 없는 진입점
  - [x] 허용 동사 파서 — 문자열 입력 즉시 거부, 알 수 없는 필드 거부, 링크 도메인 허용목록
  - [x] 댓글 응답은 템플릿 id 만. 자유 텍스트 응답 경로가 존재하지 않는다
  - [x] `extractVerb` — 산문에서 의도를 짐작해 실행하지 않는다
  - [x] 시연: `npm run demo:injection` 이 5개 층 차단과 원장에 공격 문장 미포함을 증명
  - [ ] 12.1 실제 채널에서 댓글·DM 수집 — Task 10 Hands 와 함께
  - _Requirements: R16, R7.3, R7.4_

- [ ] 13. Assurance와 복기
  - `sei` CLI 소비 + 업무 산출물 어댑터, 클레임 등록, 미검증 표시
  - 결정론적 증거 검사(출처 없는 수치·모순·공백), Loop PASS/FAIL
  - 발행 후 지표 수집과 예측 대조, 레시피 수정 제안
  - 시연: `company retro`가 예측 대비 실제와 원인 가설, 레시피 diff를 산출
  - _Requirements: R11_

- [x] 14. 오피스 API와 라이브오피스 (모바일 연동은 미완 — 아래 참조)
  - **재정의 정정(2026-08-02).** 8/2 재정의는 "모바일 표면은 desktop 의
    `mobile-bridge/` 를 쓴다" 고 적었다. **company 쪽만으로는 불가능하다.**
    `projector.ts` 가 desktop 내부 스토어(`../store/firms`, `../store/projects`,
    `../confirm`, `../secrets/vault`, `../usage`, `../one/*`)를 **직접 import** 해
    자기 상태만 투영한다. 외부 시스템을 끼울 확장점·피드·설정이 없다
    (`externalFeed`/`registerProvider`/`fetch` 어느 것도 없음). 즉 브리지는
    desktop 이 아는 것을 폰에 보여주는 닫힌 투영이고, company 의 원장·승인·
    능력 스위치는 desktop 이 모른다. Task 10 때와 달리 플랫폼 문제가 아니라
    **결합도 문제**이며, desktop 을 고치지 않는 한 열리지 않는다
  - 그래서 이번 작업은 **company 가 소유한 오피스 API** 로 한정했다. 원래
    태스크 문구도 "오피스 API 는 company 가 소유한다" 였고, 그 부분은 온전하다
  - `src/office/bind.ts` — loopback·사설 대역만 허용하고 공개 인터페이스는
    **기동 자체를 거부**한다 (R14.1, R14.2). 와일드카드 6종(`0.0.0.0`, `::`,
    `::0`, …), IPv4-mapped IPv6, 사설 대역 경계(172.15/172.32, 100.63/100.128),
    호스트명을 각각 판정한다 — 이름은 해석 결과를 모르므로 거부한다
  - `src/office/tokens.ts` — 기기별 토큰 (R14.3). 원본은 저장하지 않고 해시만
    남기며, 폐기는 매 요청마다 파일을 다시 읽어 **재기동 없이 즉시** 듣는다 (R14.4)
  - `src/office/server.ts` — 데스크톱·모바일이 같은 API 를 본다 (R14.5).
    SSE 원장 tail (R10.1), `?since=` 로 재연결 누락 구간 보충 (R10.4),
    진행 중 실행의 주체·좌석·작업명·경과·증거 건수 (R10.2),
    이벤트가 없으면 **합성하지 않고 빈 목록** (R10.3)
  - 승인 L0~L3 전부 처리 (R14.6), 능력 스위치 TTL·범위·전체 차단 (R14.8)
  - **Task 8.1 이 여기서 닫혔다.** `--step-up` 자리표시자를 TOTP(RFC 6238)로
    대체했다. 기본 검증기는 **전부 거부**라 등록 없이 L3 이 통과하지 않는다.
    같은 창의 코드를 두 번 쓰지 못한다 — 코드 하나는 승인 하나다
  - **사양과 다른 선택**: 태스크는 "desktop 페어링 기기를 두 번째 요소로 쓴다"
    였으나 위 결합도 문제로 불가능해 TOTP 로 닫았다. 소유 요소(폰)를 검증하면서
    company 밖에 의존하지 않는다. desktop 페어링을 쓰려면 desktop 변경이 선행된다
  - 능력 스위치는 켜기·끄기 **모두** 단계별 인증을 요구한다. 끄기에 마찰을
    두지 않는 편이 자연스러워 보이지만 능력 스토어가 `disable` 에도 요구하므로,
    태스크 문구대로 **두 권한 모델이 어긋나면 낮은 쪽**을 택했다. API 가
    스토어보다 느슨하면 스토어의 규칙은 우회 가능한 장식이 된다
  - 실측: 공개 바인딩 2종 거부 · 토큰 없이 401 · L3 을 코드 없이/틀린 코드로
    거부 후 올바른 코드로 승인 · SSE 로 새 이벤트 실시간 도착 · 폐기 후
    재기동 없이 401 · 진행 중 작업 표시
  - _Requirements: R10, R14.1~R14.6, R14.8 (R14.7 은 TOTP 로 충족, 아래 14.1 참조)_
  - _업스트림 조사: agentlas-desktop `electron/mobile-bridge/{projector,server,runtime}.ts`_

  - [ ] 14.1 모바일 표면 결정 — 셋 중 하나를 골라야 한다.
        (a) company 가 PWA 를 직접 낸다 (오피스 API 는 이미 준비됨)
        (b) desktop 에 외부 피드 확장점을 넣는 PR 을 올린다 (desktop 저장소 작업)
        (c) desktop 을 MCP 클라이언트로 두고 company 를 도구로 등록한다 (Task 16)
        지금은 API 만 있고 폰에서 볼 화면이 없다
  - [ ] 14.2 사설망 실측 — loopback 으로만 확인했다. Tailscale/WireGuard
        인터페이스에 실제로 바인딩되는지는 그 환경에서 봐야 한다
  - _해소: 8.1(단계별 인증), 6.1(War Room 종결 UI)_
  - _업스트림: agentlas-desktop `electron/mobile-bridge/{server,authority,pairing,runtime}.ts`_

- [x] 15. 레시피와 무인 스케줄
  - [x] 선언적 스텝 5종(seat/gate/approval/publish/retro), YAML 로딩과 검증
  - [x] 검증이 실행 전에 막는다 — id 중복, 필수 필드, 만들어지지 않는 산출물 참조
  - [x] 게이트는 셸 종료 코드로 판정. 실패 시 다음 스텝을 돌지 않는다 (R12.2)
  - [x] 승인 스텝은 블로킹이 아니다 — `paused` 로 끝나고 `resume` 이 이어받는다
  - [x] 재개 시 통과한 스텝을 다시 돌지 않는다 (R12.5). 좌석 호출은 공짜가 아니다
  - [x] 중복 실행 락 — pid + 부팅 세션. 죽은 락은 회수하고 원장에 남긴다 (R12.4)
  - [x] 구현되지 않은 publish/retro 스텝은 통과가 아니라 실패로 멈춘다
  - [x] 상시 기동은 OS 에 위임 — schtasks / launchd / systemd 명령문 출력만 (R12.6)
  - [x] `company run` / `company run --resume` / `company schedule`
  - [x] 시연: 실제 codex 좌석으로 pause → 승인 → resume → completed 완주
  - [ ] 15.1 예정 시각 무인 시작은 오너가 `company schedule` 출력을 등록해야 동작한다
  - _Requirements: R12_

- [ ] 16. 에이전트 채용 — desktop Hub 연동
  - **재정의(2026-08-02)**: Hub·마켓플레이스·패키지 저장을 자체 구현하지 않는다.
    desktop 의 `cloud-agents/`·`marketplace/`·`hub-bookmark-sync.ts` 가 이미 갖고 있다
  - [x] 16.0 **선행 조건 — desktop 게이트 훅** (오너 승인 2026-08-02, 완료)
    - MCP 레지스트리 등록은 **능력 제공이지 집행이 아니다** — MCP 는 도구를 줄 뿐
      호출을 가로채지 않는다. 그래서 실행 표면이 실행 전에 **직접 묻는** 형태로 만들었다
    - company 쪽: `src/policy/gate.ts` 의 `resolveGate()` + `company gate` 명령.
      종료 코드가 계약이다 — 0 인가 / 1 거부 / 2 묻지 못함
    - desktop 쪽: `electron/agents/company-gate.ts` + `electron/mcp/registry.ts` 의
      `installAgent()`·`installMyAgent()` 훅. 차용 경로는 이 둘뿐이다
    - **2 를 1 과 구분한다.** "안 된다고 답했다" 와 "물어보지 못했다" 는 다른 사실이고
      답인 것은 앞의 하나뿐이다. 2 를 통과로 해석하면 게이트를 끄는 방법이 게이트를
      고장내는 것이 된다. spawn 실패·타임아웃·종료코드 2 는 전부 거부다
    - **CLI 경로는 절대 경로 강제.** 맨 이름은 PATH 로 해석되고 PATH 섀도잉이 진짜
      게이트를 대신해 "허용"이라 답하는 경로가 된다. 풀 가치가 있는 해석 문제가 아니다
    - 승인은 동작을 결정하는 필드의 digest 에 묶인다 — 지시문·trust grade·MCP 서버·
      env 요구 키 + Hub 릴리스 해시. `packageHash` 를 단독 신뢰하지 않으므로 같은
      해시로 내용만 바뀐 패키지가 승인을 재사용할 수 없다 (R4.6)
    - 프로세스 경계를 넘는 것은 식별자뿐. 지시문과 env 값은 넘어가지 않는다
    - 기본은 꺼져 있다. `AGENTLAS_COMPANY_GATE_CLI` 미설정이면 desktop 단독 동작 그대로
    - 실측: 1차 거부 → 오너 승인 → 2차 인가(소비) → 3차 거부(재사용 불가), fail-closed 4종
    - _PR: agentlas-company#1, agentlas-desktop#1_
    - **남은 것**: desktop 저장소가 테스트를 gitignore 한다(owner decision 2026-07-26).
      훅의 회귀 방어가 desktop CI 에 없다 — 판정 로직은 company 쪽 18개 단위 테스트가
      덮지만 훅 자체는 덮지 않는다. desktop 테스트 정책이 바뀌면 붙인다
  - `HIRE` 블록 처리와 L3 승인은 company 가 소유한다 (통제 계층)
  - 차용 패키지 digest 를 `vendor.lock` 의 `borrowed_agents` 에 핀 (R13.2 — 이미 자리 있음)
  - 차용 패키지 무권한 기본값, 좌석 예산 초과 시 거부
  - 시연: 회의 결정 → desktop Hub 차용 → company L3 승인 → 다음 사이클 참여
  - _Requirements: R13_
  - _의존: 16.0 완료 — 게이트 훅이 desktop 에 붙어 있다_
  - _업스트림: agentlas-desktop `electron/{cloud-agents,marketplace}/`, `Agentlas-OS`_

- [ ] 17. 무인 운영과 침해 복구
  - **재정의 없음 — 자체 구현으로 남는다(2026-08-02 확인).** desktop 의
    `automation-{scheduler,watchdog,recovery,strategy}.ts`(2,382줄)는 desktop 자신의
    자동화를 감독하는 것이고 company 서비스의 무인 복귀와 대상이 다르다. 다만 desktop 이
    함께 뜨지 않으면 Task 10·14 가 죽으므로, 복귀 검증에 **desktop 기동 확인을 포함**한다
  - 재부팅 무인 복귀, 원장 무손실 검증, 스위치 전부 OFF 복귀
  - 좌석 만료 알림, 이상 볼륨·`deny` 급증 시 정지, 일일 요약
  - OAuth 그랜트 폐기 순서와 복구 런북 작성 후 **1회 실전 연습**
  - 시연: 전원을 뽑고 다시 켜면 회사가 스스로 출근하고 원장이 온전함
  - _Requirements: R17_
