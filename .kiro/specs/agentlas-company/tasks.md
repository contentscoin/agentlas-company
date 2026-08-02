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
| 10 Hands | **desktop 연동** | `computer-use` 제어 서버 계약 존재 |
| 11 Studio | **범위 축소** | desktop Studio 는 `ipcMain` 뒤 — 헤드리스 미도달 |
| 14 오피스·모바일 | **desktop 연동** | `mobile-bridge` 12개 모듈, main.ts 기동 확인 |
| 16 채용 | **desktop 연동 + 선행조건** | Hub 는 있으나 게이트 훅이 desktop 변경을 요구 |
| 17 무인운영 | **자체 구현 유지** | desktop automation 은 대상이 다름 |

연동 범위를 정한 것은 헤드리스 도달성입니다. desktop 기능 대부분이 `electron/ipc.ts` 의
`ipcMain.handle` **486개** 뒤에 있어 Electron 렌더러에서만 호출됩니다. 밖으로 나온 표면은
`computer-use/control-server` · `mobile-bridge/server` · `browser/approval-server` ·
`mcp-tools/registry` 넷뿐이고, 이 넷이 연동 가능 범위의 전부입니다.

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

- [ ] 3. 구역과 자격증명 레이아웃
  - Windows 계정 3분할(`owner` / `svc-seats` / `svc-broker`), `icacls` 적용 스크립트
  - 좌석은 자기 호스트 OAuth 디렉터리만 읽기, 브로커 자산 접근 거부
  - 시연: `company security verify`가 구역 위반 시도를 전부 거부하고 표로 보고
  - _Requirements: R15_

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
  - [ ] 8.1 실물 단계별 인증 — CLI 의 `--step-up` 은 자리표시자. Task 14 콘솔·PWA 가 대체
  - [ ] 8.2 6단계 유예 창은 Task 7(정책 게이트)에서 붙인다
  - _Requirements: R8, R15.8, R16.5, R17.3_

- [ ] 9. 허용 동사와 첫 발행 루프
  - **재정의 없음 — 자체 구현으로 남는다(2026-08-02 확인).** desktop 에 채널 발행 구현이
    없다. `creative-pack/`·`ecommerce-pack/` 은 각각 `surface.ts` 하나이고
    `threads`·`instagram` 은 `experience/taxonomy.ts`·`mcp-tools/catalog.ts` 의 문자열이다
  - `PublishRequest` 계약, `idempotencyKey` 멱등성, 드라이런, 채널 일일 상한
  - 쓰레드(OAuth API)와 네이버 블로그(Hands)를 각각 하나씩 살려 경로 추상화 검증
  - 네이버 블로그 경로는 Task 10 의 `DesktopHandsAdapter` 를 쓴다 → **Task 10 이 선행**
  - 시연: 기획 → 초안 → 승인 → 실제 발행 완주, 원장에 URL 증거. **첫 성과 발생 지점**
  - _Requirements: R6_
  - _의존: Task 10 (Hands 경로), Task 14 또는 8.1 (L3 실물 인증 — 아래 주의 참조)_

- [ ] 10. Hands — desktop computer-use 연동
  - **재정의(2026-08-02)**: CDP 브라우저 조작과 네이티브 입력을 자체 구현하지 않는다.
    `agentlas-desktop` 이 이미 가진 표면에 붙는다. 설계 §agentlas-desktop 경계 참조
  - `DesktopHandsAdapter` — 제어 파일 `<userData>/computer-use/control.json` 을 읽고
    (`{ schemaVersion, port, token }`, mode 0600) loopback HTTP 에 `Bearer <token>` 으로 호출
  - `schemaVersion !== 1` 이면 실행하지 않고 실패한다. 미지원 버전을 추정으로 진행하지 않는다
  - 도구 16종(`computer_status`·`focus_app`·`click`·`type_text`·`press_key` 등)을 타입 지정
    동사로 감싼다. 자유 텍스트가 desktop 으로 넘어가는 경로를 만들지 않는다 (Z2→Z1 규칙)
  - desktop 미기동·제어 파일 부재·토큰 불일치는 각각 다른 실패로 구분한다. 조용한 성공 금지
  - 모든 호출과 거부를 원장에 기록. 오염된 입력은 스위치가 켜져 있어도 거부 (R16.5)
  - 스마트스토어 집계값 전용 규칙은 company 쪽 동사 계약에서 강제한다 (R7.6 — desktop 은 모른다)
  - 반자동 체크리스트 폴백은 유지 — desktop 이 요소를 못 찾으면 사람이 이어받는다 (R7.5)
  - 시연: `company hands` 가 desktop 을 통해 실제 조작 1건 수행, 원장에 증거
  - [ ] 10.1 desktop 미설치 환경의 동작 확정 — 현재 미정. Hands 스텝을 실패로 막을지,
        체크리스트 폴백으로 강등할지는 Task 9 실사용 후 결정
  - _Requirements: R7_
  - _업스트림: agentlas-desktop `electron/computer-use/{control-server,channel,mcp-server}.ts`_

- [ ] 11. Studio — 좌석 산출 + desktop 표면 (범위 축소)
  - **재정의(2026-08-02)**: desktop 의 Studio 계열(`creative-pack/`·`document/`·`oberon/`·
    `agents/oberon-film-studio`)은 전부 `ipcMain` 뒤에 있어 헤드리스로 닿지 않는다.
    따라서 이 태스크는 **닿는 것만** 한다
  - 글·기획·프로그램은 company 좌석으로 자체 산출 (기존 계획 유지 — 좌석은 이미 있다)
  - 브랜드 팩 대조와 위반 시 게이트 FAIL 은 company 가 소유한다. desktop 의
    `shared/brand-safety.ts` 는 참조만 하고 import 하지 않는다 (별도 배포 단위)
  - 생성 코드 격리 실행 유지
  - **이미지·영상은 이 태스크에서 만들지 않는다.** desktop 이 표면을 노출하기 전까지
    보류하고, 보류 사실을 산출물에 남긴다 (`unknown` 으로 남기고 추정하지 않는다)
  - 시연: 한 포스트에 카피와 기획이 산출되고, 이미지·영상 슬롯은 미충족으로 명시 표기
  - [ ] 11.1 desktop 에 Studio 외부 표면 요청 — Task 16.0 과 같은 성격의 선행 조건.
        표면이 생기면 이미지·영상 슬롯을 채운다
  - _Requirements: R5_

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

- [ ] 14. 오피스 API와 라이브오피스 — desktop mobile-bridge 연동
  - **재정의(2026-08-02)**: 모바일 PWA·페어링·릴레이·TLS 를 자체 구현하지 않는다.
    desktop 의 `mobile-bridge/`(12개 모듈, main.ts 에 기동 확인)에 붙는다
  - 오피스 API 는 company 가 소유한다 — loopback + 사설망 바인딩, 공개 인터페이스 기동 거부,
    SSE 원장 tail, 재연결 시 누락 구간 보충, 합성 표시 금지 (R10, R14.1)
  - 모바일 표면은 desktop 것을 쓴다. `MobileBridgeAuthority` 의 권한 경계와 company 의
    정책 등급을 **매핑 표로 고정**한다. 두 권한 모델이 어긋나면 낮은 쪽을 택한다
  - 기기 토큰 폐기는 양쪽 모두에서 동작해야 한다 — desktop 페어링 해제만으로는
    company 승인 권한이 남는다. 폐기 경로를 한 번에 묶는다
  - **Task 8.1(실물 단계별 인증)이 여기서 해소된다.** 현재 `--step-up` 은 자리표시자이고,
    이것이 L3 비가역 작업의 실제 구멍이다. desktop 페어링 기기를 두 번째 요소로 쓴다
  - 시연: 폰에서 진행 중 작업이 실시간으로 보이고 L3까지 승인 가능, 폐기 후 즉시 거부
  - _Requirements: R10, R14_
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
