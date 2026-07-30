# Requirements Document — agentlas-company

## Introduction

상시 가동되는 Windows 11 미니PC 한 대를 "회사"로 삼아, 임원 에이전트들이 회의로 사업 목표를 정하고 콘텐츠를 기획·제작·발행하고 성과를 복기해 다음 주 업무를 개선하는 자율 운영 시스템입니다. 오너는 Board 자리에 앉아 승인과 방향 제시만 합니다.

네 개의 기존 자산을 커밋 핀 라이브러리로 소비합니다: `ai-company-discord`(회의 프로토콜·`companyctl`), `social-ai-team-custom`(채널 실행·`proc.js`), `agentlas-sei`(검증 엔진), `Agentlas-OS`(에이전트 패키징).

**절대 제약**: 모든 LLM은 구독 계정 OAuth로 로그인된 로컬 CLI로만 구동됩니다. API 키는 문서상 금지가 아니라 코드 경로에서 차단되고 테스트로 증명됩니다.

**첫 사업 목표**: 자체 미디어 채널 성장(팔로워·유입·저장).

표기 규약: 설명은 한국어, 계약 키워드(WHEN/IF/WHERE/THEN/SHALL)는 영문.

## Glossary

| 용어 | 정의 |
|---|---|
| 좌석(Seat) | OAuth 로그인된 로컬 LLM CLI 하나. 4개: Claude Code(Max), Codex(ChatGPT Pro), Gemini CLI, Cursor CLI |
| Hands | 로그인된 브라우저·데스크톱을 직접 조작하는 실행 계층 |
| 원장(Ledger) | 해시체인으로 연결된 append-only 이벤트 기록 |
| 구역(Zone) | Z0 오너 전용 · Z1 브로커 · Z2 좌석 · Z3 신뢰 0(오염) |
| tainted | 신뢰등급 0 콘텐츠를 만진 실행의 산출물에 붙는 표시 |
| 등급(L0~L3) | 자율성 등급. L0 자동 · L1 화이트리스트 자동발행 · L2 승인 · L3 항상 승인 |
| 허용 동사 | Hands·채널 어댑터가 노출하는 닫힌 동작 목록 |
| 위험 능력 | 능력 스위치로 통제되는 비가역·금전 관련 동사군 (R8) |
| 능력 스위치 | 위험 능력의 오너 전용 온오프 토글. 기본 OFF, 유효시간 필수 |
| 유예 창 | 비가역 작업이 승인된 뒤 실행 전까지의 중단 가능 지연 구간 |
| 단계별 인증 | 기기 토큰 + 기기 잠금 해제(생체·패스코드)를 함께 요구하는 확인 |
| DoD | Definition of Done. Loop가 PASS/FAIL로 판정 |

---

## Requirement 1: OAuth 전용 모델 접근

**User Story:** 오너로서, 종량 과금 API 키를 쓰지 않고 이미 보유한 구독 계정만으로 모든 에이전트를 구동하고 싶다. 비용이 예측 가능하고 키 유출 위험이 없기 때문이다.

### Acceptance Criteria

1. WHEN 시스템이 좌석 프로세스를 스폰할 THEN the system SHALL 자식 환경에서 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CURSOR_API_KEY`를 삭제해야 한다.
2. WHEN CI가 실행될 THEN the system SHALL 소스 트리 내 `*_API_KEY` 참조가 0건임을 검증하고, 1건 이상이면 빌드를 실패시켜야 한다.
3. WHEN CI가 실행될 THEN the system SHALL `--dangerously-skip-permissions`, `--yolo`, `--full-auto` 계열 플래그 사용이 0건임을 검증해야 한다.
4. IF 좌석의 OAuth 세션이 만료되었다면 THEN the system SHALL 해당 좌석을 사용 불가로 표시하고 재로그인 요청을 오너에게 알려야 하며, API 키로 폴백하지 않아야 한다.
5. WHERE Cursor 좌석이 사용되는 경우 the system SHALL 로컬 Cursor CLI만 호출하고 Cursor Cloud Agents API를 호출하지 않아야 한다.
6. WHEN 이미지 또는 영상을 생성할 THEN the system SHALL OAuth 기반 생성 경로(ima2)만 사용하고 유료 생성 API를 호출하지 않아야 한다.

## Requirement 2: 좌석 브로커 — 큐·쿼터·격리

**User Story:** 오너로서, 좌석 4개를 임원 6명 이상이 나눠 쓰면서도 레이트리밋에 걸려 회사가 멈추지 않기를 원한다.

### Acceptance Criteria

1. WHEN 좌석 호출이 요청될 THEN the system SHALL 좌석별 최대 동시성(실측값)을 초과하지 않고 큐에 적재해야 한다.
2. WHEN 좌석의 일일 호출 예산이 소진될 THEN the system SHALL 폴백 좌석으로 라우팅하거나 작업을 연기하고, 그 사유를 원장에 기록해야 한다.
3. IF 좌석 호출이 실패하면 THEN the system SHALL 지수 백오프로 재시도하고, 정해진 횟수 초과 시 실패로 확정해야 한다.
4. WHEN 좌석 호출이 타임아웃될 THEN the system SHALL 프로세스 트리를 종료해 고아 프로세스를 남기지 않아야 한다.
5. WHEN 좌석이 스폰될 THEN the system SHALL per-run 작업 디렉터리를 유일한 쓰기 경로로 지정해야 한다.
6. WHEN 오너가 좌석 상태를 조회할 THEN the system SHALL 좌석별 로그인 상태, 남은 예산, 마지막 성공 시각, 동시성 점유를 반환해야 한다.

## Requirement 3: 조직과 회의

**User Story:** 오너로서, 임원들이 각자 독립적으로 판단하고 서로 반박하며 사업 목표를 도출하기를 원한다. 한 인격이 여러 이름으로 같은 말을 하는 것은 회의가 아니다.

### Acceptance Criteria

1. WHEN 임원 회의가 시작될 THEN the system SHALL 1라운드에서 각 임원의 의견을 서로 노출하지 않은 상태로 수집해야 한다.
2. WHEN 1라운드가 끝날 THEN the system SHALL 2라운드에서 각 임원에게 다른 임원들의 1라운드 전문을 제공하고 반론을 수집해야 한다.
3. WHEN 2라운드가 끝날 THEN CEO SHALL 원 발언의 요점을 보존한 채 `DECISION` / `OPEN` / `ACTIONS` 마감 블록을 생성해야 한다.
4. IF Critic 좌석의 벤더가 본체 좌석과 동일하다면 THEN the system SHALL 회의를 시작하지 않고 구성 오류로 거부해야 한다.
5. IF Critic이 CRITICAL dissent를 제출하면 THEN the system SHALL 다수결로 이를 기각하지 않고 Board 승인 게이트로 승격해야 한다.
6. WHEN 마감 블록이 생성될 THEN the system SHALL 이를 `companyctl decision`으로 파싱해 정규화 JSON으로 원장에 적재해야 한다.
7. WHEN 동일 과제가 2회 실패하거나 Critic이 BLOCK을 낼 THEN the system SHALL War Room을 소집하고 오너만이 종결할 수 있게 해야 한다.

## Requirement 4: 자율성 등급과 승인

**User Story:** 오너로서, 내부 작업은 알아서 굴러가되 외부로 나가거나 돈이 움직이는 일은 내 승인을 거치게 하고 싶다. 그리고 그 승인을 폰으로 어디서든 끝내고 싶다.

### Acceptance Criteria

1. WHEN 작업이 실행 대기에 들 THEN the system SHALL `policy.yaml`에 따라 L0~L3 등급을 판정해야 한다.
2. WHERE 등급이 L0 또는 화이트리스트된 L1인 경우 the system SHALL 오너 개입 없이 실행해야 한다.
3. WHERE 등급이 L2 또는 L3인 경우 the system SHALL 오너 승인 없이 실행하지 않아야 한다.
4. IF Critic이 BLOCK을 냈거나 SEI 리스크 신호가 있다면 THEN the system SHALL 등급을 한 단계 승격시켜야 한다.
5. WHEN 승인 카드가 생성될 THEN the system SHALL 승인을 정확한 페이로드 digest에 바인딩해야 한다.
6. IF 승인 후 페이로드가 변경되면 THEN the system SHALL 기존 승인 영수증을 무효로 처리해야 한다.
7. WHEN 승인 카드가 만료될 THEN the system SHALL 요청을 **취소**하고 사유를 원장에 기록해야 하며, 통과로 처리하지 않아야 한다.
8. WHEN 승인이 제출될 THEN the system SHALL 제출 주체를 등록된 오너 신원 허용목록과 대조하고 불일치 시 거부해야 한다.
9. WHERE 등급이 L3인 경우 the system SHALL 단계별 인증(등록 기기 토큰 + 기기 잠금 해제)을 통과한 제출만 인정해야 한다.
10. WHEN L3 승인이 성립할 THEN the system SHALL 등록된 다른 모든 오너 기기에 승인 발생 사실을 알려야 한다.
11. WHERE 승인된 작업이 비가역 능력을 사용하는 경우 the system SHALL 실행 전 유예 창을 두고, 그 구간에 등록된 어떤 기기든 중단할 수 있게 해야 한다.
12. WHEN 승인 또는 거부가 이뤄질 THEN the system SHALL 주체·기기·시각·digest를 원장에 기록해야 한다.

## Requirement 5: 콘텐츠 제작

**User Story:** 오너로서, 글·이미지·영상·기획서·프로그램까지 한 시스템에서 나오기를 원한다.

### Acceptance Criteria

1. WHEN 글 산출물이 요청될 THEN the system SHALL 좌석을 통해 초안을 생성하고 근거 인용을 함께 기록해야 한다.
2. WHEN 이미지 또는 영상이 요청될 THEN the system SHALL OAuth 생성 경로를 사용하고 산출물 메타데이터를 원장에 링크해야 한다.
3. WHEN 프로그램 산출물이 요청될 THEN the system SHALL Cursor 좌석으로 레포 작업을 수행하고 커밋 해시를 원장에 기록해야 한다.
4. WHEN 산출물이 생성될 THEN the system SHALL 브랜드 팩(master_sheet, character_sheet, content_base)의 규칙을 대조해야 한다.
5. IF 산출물이 브랜드 금지 규칙을 위반하면 THEN the system SHALL 게이트를 FAIL로 판정하고 발행 단계로 넘기지 않아야 한다.
6. WHERE 생성된 코드를 실행하는 경우 the system SHALL 격리된 per-run 환경에서만 실행하고 프로덕션 배포는 L3로 분류해야 한다.

## Requirement 6: 채널 발행

**User Story:** 오너로서, 쓰레드·인스타그램·블로그·워드프레스·스마트스토어·유튜브·틱톡을 실제로 운영하고 싶다. 채널이 API가 있는지 없는지는 내가 신경 쓸 문제가 아니다.

### Acceptance Criteria

1. WHEN 발행이 요청될 THEN the system SHALL 채널이 OAuth API 경로인지 Hands 경로인지와 무관하게 동일한 `PublishRequest` 계약을 수용해야 한다.
2. WHEN 발행이 완료될 THEN the system SHALL 증거(게시물 URL 또는 스크린샷)를 원장에 기록해야 한다.
3. WHEN 동일한 발행 요청이 두 번 제출될 THEN the system SHALL 중복 발행하지 않아야 한다.
4. WHEN 드라이런이 요청될 THEN the system SHALL 실제 발행 없이 최종 페이로드를 반환해야 한다.
5. IF 채널별 일일 발행 상한에 도달하면 THEN the system SHALL 추가 발행을 정지하고 오너에게 알려야 한다.
6. IF 발행이 실패하면 THEN the system SHALL 사람이 이어받을 수 있는 반자동 체크리스트를 생성해야 한다.

## Requirement 7: 컴퓨터·브라우저 직접 조작 (Hands)

**User Story:** 오너로서, 공개 API가 없는 네이버 블로그·클립·스마트스토어·카카오채널도 시스템이 직접 조작해 운영하기를 원한다.

### Acceptance Criteria

1. WHEN Hands가 조작을 수행할 THEN the system SHALL 로그인 세션이 유지된 전용 브라우저 프로필을 사용해야 한다.
2. WHEN Hands가 각 단계를 수행할 THEN the system SHALL 스크린샷 증거를 남겨야 한다.
3. WHEN Hands가 호출될 THEN the system SHALL 허용 동사 목록에 있는 동작만 수용하고 자유 형식 지시를 거부해야 한다.
4. WHEN 허용 동사가 호출될 THEN the system SHALL 파라미터를 스키마로 검증하고 URL은 도메인 허용목록과 대조해야 한다.
5. IF 대상 화면의 요소를 찾지 못하면 THEN the system SHALL 조작을 중단하고 실패를 원장에 기록하며 조용히 성공으로 처리하지 않아야 한다.
6. WHEN 스마트스토어에서 데이터를 읽을 THEN the system SHALL 집계값만 반환하고 고객 이름·주소·연락처 원본을 에이전트에 전달하지 않아야 한다.

## Requirement 8: 능력 스위치 (기본 차단, 오너 전용 토글)

**User Story:** 오너로서, 위험한 능력을 평소에는 기계에서 꺼두되 필요할 때 내가 직접 켜서 쓰고 싶다. 영구히 없는 것도, 영구히 켜져 있는 것도 원하지 않는다.

### Acceptance Criteria

1. WHEN 시스템이 최초 설치될 THEN the system SHALL 모든 위험 능력 스위치를 OFF 상태로 출하해야 한다.
2. WHEN 위험 능력이 정의될 THEN the system SHALL 아래 각 항목을 독립적으로 토글 가능한 능력으로 등록해야 한다: 정산계좌·결제수단 변경, 비밀번호·2FA·복구코드 변경, 상품 삭제, 가격 일괄 변경, 주문 취소·환불, 게시물 대량 삭제, 계정 삭제, DM 발송, 대량 팔로우, 지출·구독·광고비 집행.
3. IF 능력 스위치가 OFF라면 THEN the system SHALL 해당 동사 호출을 실행 이전에 거부하고 거부 사유를 원장에 기록해야 한다.
4. WHEN 능력 스위치를 ON으로 전환할 THEN the system SHALL 유효 시간을 필수 입력으로 요구해야 한다.
5. WHEN 능력 스위치의 유효 시간이 만료될 THEN the system SHALL 해당 스위치를 자동으로 OFF로 복귀시켜야 한다.
6. WHERE 능력 스위치가 ON인 경우에도 the system SHALL 개별 실행마다 L3 승인을 별도로 요구해야 한다.
7. WHEN 스위치 상태 변경이 요청될 THEN the system SHALL 오너 단계별 인증을 요구해야 한다.
8. WHEN 어떤 에이전트가 스위치 상태를 읽거나 변경하려 시도할 THEN the system SHALL 이를 거부하고 원장에 기록해야 한다.
9. WHEN 에이전트가 스위치 변경을 요청하는 내용을 생성할 THEN the system SHALL 이를 실행 가능한 요청으로 처리하지 않아야 한다.
10. WHEN 스위치가 ON으로 전환될 THEN the system SHALL 등록된 모든 오너 기기에 알려야 한다.
11. WHEN 스위치 상태가 변경될 THEN the system SHALL 주체·기기·시각·유효기간·대상 채널 및 계정을 원장에 기록해야 한다.
12. WHERE 스위치가 특정 채널 또는 계정으로 범위 지정된 경우 the system SHALL 범위 밖의 채널·계정에 그 능력을 부여하지 않아야 한다.
13. WHEN 오너가 전체 차단을 실행할 THEN the system SHALL 모든 스위치를 즉시 OFF로 전환하고 진행 중인 해당 작업을 중단해야 한다.
14. WHEN 계약 테스트가 실행될 THEN the system SHALL 각 위험 동사가 스위치 OFF 상태에서 거부됨을 증명해야 한다.
15. WHEN 오너가 스위치 화면을 열 THEN the system SHALL 각 능력의 현재 상태, 남은 유효 시간, 적용 범위, 최근 사용 내역을 표시해야 한다.

## Requirement 9: 원장과 히스토리

**User Story:** 오너로서, 회의 과정과 업무 과정을 나중에 그대로 되짚어볼 수 있기를 원한다.

### Acceptance Criteria

1. WHEN 어떤 이벤트가 발생할 THEN the system SHALL 이전 이벤트의 해시를 포함하는 레코드를 append-only로 기록해야 한다.
2. WHEN 원장이 검증될 THEN the system SHALL 해시체인 불일치를 검출해 보고해야 한다.
3. WHEN 좌석이 이벤트를 남길 THEN the system SHALL 원장 파일을 직접 쓰지 않고 원장 서비스 API를 경유해야 한다.
4. WHEN 오너가 히스토리를 조회할 THEN the system SHALL 시간·주체·작업·등급으로 필터된 타임라인을 반환해야 한다.
5. WHEN 오너가 특정 실행을 리플레이할 THEN the system SHALL 그 실행의 이벤트 순서와 증거 링크를 재생해야 한다.
6. WHEN 원장이 백업될 THEN the system SHALL 암호화된 오프사이트 사본을 생성해야 한다.

## Requirement 10: 라이브오피스

**User Story:** 오너로서, 지금 누가 무슨 일을 실제로 하고 있는지 실시간으로 보고 싶다. 연출된 애니메이션이 아니라 사실이어야 한다.

### Acceptance Criteria

1. WHEN 콘솔이 라이브오피스를 열 THEN the system SHALL 원장 이벤트 스트림을 구독해 표시해야 한다.
2. WHEN 좌석이 작업 중일 THEN the system SHALL 주체, 점유 좌석, 작업명, 경과 시간, 증거 건수를 표시해야 한다.
3. WHEN 표시할 이벤트가 없을 THEN the system SHALL 활동을 합성하거나 추정해 표시하지 않아야 한다.
4. IF 스트림 연결이 끊기면 THEN the system SHALL 재연결하고 누락 구간을 원장에서 메워야 한다.
5. WHEN 라이브오피스가 동작할 THEN the system SHALL Discord 게이트웨이에 상주 리스너를 두지 않아야 한다.

## Requirement 11: 검증과 복기

**User Story:** 오너로서, 모든 업무가 검증과 복기를 거쳐 문제를 찾아내고 개선되기를 원한다.

### Acceptance Criteria

1. WHEN 산출물이 제출될 THEN the system SHALL 그 산출물이 주장하는 클레임을 등록해야 한다.
2. IF 클레임의 근거가 팩 인용도 실측도 아니라면 THEN the system SHALL 이를 미검증으로 표시하고 추정으로 채우지 않아야 한다.
3. WHEN 결정론적 검사가 실행될 THEN the system SHALL 출처 없는 수치, 클레임 간 모순, 증거 공백을 검출해야 한다.
4. WHEN Loop가 검증할 THEN the system SHALL DoD 기준으로 PASS 또는 FAIL을 판정해야 한다.
5. IF 결정론적 검사가 BLOCK을 내면 THEN the system SHALL 발행 단계로 진행하지 않아야 한다.
6. WHEN 발행 후 정해진 기간이 지날 THEN the system SHALL 실제 성과 지표를 수집해 예측값과 대조한 복기를 생성해야 한다.
7. WHEN 복기가 완료될 THEN the system SHALL 해당 레시피의 수정 제안을 산출해야 한다.

## Requirement 12: 반복 업무 레시피와 무인 스케줄

**User Story:** 오너로서, 잘 설계된 반복 업무가 사람 손 없이 매주 돌기를 원한다.

### Acceptance Criteria

1. WHEN 레시피가 정의될 THEN the system SHALL 각 스텝의 담당 주체, 산출물, 결정론적 게이트 명령을 선언적으로 표현해야 한다.
2. WHEN 스텝의 게이트가 실패할 THEN the system SHALL 다음 스텝으로 진행하지 않아야 한다.
3. WHEN 예정 시각이 도래할 THEN the system SHALL 오너 개입 없이 사이클을 시작해야 한다.
4. IF 동일 레시피가 이미 실행 중이라면 THEN the system SHALL 중복 실행을 거부해야 한다.
5. IF 사이클이 중간에 실패하면 THEN the system SHALL 실패 지점부터 재개할 수 있어야 한다.
6. WHEN 상시 기동이 구성될 THEN the system SHALL OS 스케줄러 또는 서비스 관리자에 위임하고 자체 supervisor를 구현하지 않아야 한다.

## Requirement 13: 에이전트 채용

**User Story:** 오너로서, 필요할 때 임원 회의가 새 에이전트를 고용해 조직을 늘릴 수 있기를 원한다.

### Acceptance Criteria

1. WHEN 회의가 `HIRE` 블록을 마감할 THEN the system SHALL 에이전트 패키지를 생성하거나 Hub에서 차용해야 한다.
2. WHEN 패키지가 확보될 THEN the system SHALL 그 digest를 `vendor.lock`에 기록해야 한다.
3. WHERE 차용된 외부 패키지인 경우 the system SHALL 기본적으로 Hands 권한, 발행 권한, 네트워크 쓰기 권한을 부여하지 않아야 한다.
4. WHEN 채용이 요청될 THEN the system SHALL 이를 L3로 분류해 오너 승인 없이 활성화하지 않아야 한다.
5. IF 채용으로 좌석 예산이 초과되면 THEN the system SHALL 채용을 거부하고 예산 재배분 안을 제시해야 한다.
6. WHEN 신규 에이전트의 산출물이 제출될 THEN the system SHALL 기존과 동일한 검증 게이트를 적용해야 한다.

## Requirement 14: 데스크톱·모바일 운용

**User Story:** 오너로서, 집에서는 데스크톱으로, 밖에서는 폰으로 회사를 보고 모든 승인을 끝내고 싶다.

### Acceptance Criteria

1. WHEN 오피스 API가 기동될 THEN the system SHALL loopback과 사설 VPN 인터페이스에만 바인딩해야 한다.
2. IF 공개 네트워크 인터페이스에 바인딩이 시도되면 THEN the system SHALL 기동을 거부해야 한다.
3. WHEN 클라이언트가 접속할 THEN the system SHALL 기기별 토큰을 요구하고 없으면 거부해야 한다.
4. WHEN 오너가 기기를 폐기할 THEN the system SHALL 해당 기기 토큰을 즉시 무효화해야 한다.
5. WHEN 데스크톱과 모바일이 접속할 THEN the system SHALL 동일한 API를 소비해 동일한 상태를 표시해야 한다.
6. WHEN 모바일에서 승인이 요청될 THEN the system SHALL L0부터 L3까지 모든 등급의 승인을 처리할 수 있어야 한다.
7. WHERE 모바일에서 L3 승인 또는 능력 스위치 변경이 이뤄지는 경우 the system SHALL 단계별 인증을 요구해야 한다.
8. WHEN 모바일에서 능력 스위치를 조작할 THEN the system SHALL 데스크톱과 동일한 유효 시간·범위 지정·전체 차단 기능을 제공해야 한다.

## Requirement 15: 구역 분리와 자격증명 보호

**User Story:** 오너로서, 미니PC 한 대가 뚫려도 모든 계정을 동시에 잃지 않기를 원한다.

### Acceptance Criteria

1. WHEN 시스템이 구성될 THEN the system SHALL 좌석 실행 사용자와 브로커 실행 사용자를 서로 다른 비관리자 Windows 계정으로 분리해야 한다.
2. WHEN 좌석 사용자가 브로커 자격증명이나 브라우저 프로필을 읽으려 시도할 THEN the system SHALL 이를 거부하고 감사 로그를 남겨야 한다.
3. WHERE 좌석이 자기 호스트의 OAuth 디렉터리를 읽는 경우 the system SHALL 그 좌석의 디렉터리에만 읽기를 허용해야 한다.
4. WHEN 비밀이 저장될 THEN the system SHALL 저장소 밖의 사용자별 보호 경로에 두고 레포에 커밋하지 않아야 한다.
5. WHEN 외부 발행 또는 외부 인제스트가 시도될 THEN the system SHALL 비밀·PII 린트를 통과시켜야 하며, 검출 시 차단해야 한다.
6. WHEN 린트가 결과를 보고할 THEN the system SHALL 검출된 비밀 값을 출력하지 않고 종류와 위치만 보고해야 한다.
7. WHEN 시스템이 구성될 THEN the system SHALL 2FA 시드와 복구코드를 이 기계에 저장하지 않아야 한다.
8. WHEN 능력 스위치 상태가 저장될 THEN the system SHALL 이를 브로커 구역에 두고 좌석 사용자의 읽기·쓰기를 거부해야 한다.

## Requirement 16: 오염 추적과 프롬프트 인젝션 방어

**User Story:** 오너로서, 댓글이나 웹페이지에 심긴 악성 지시가 회사를 조종하지 못하게 하고 싶다.

### Acceptance Criteria

1. WHEN 외부 콘텐츠가 수집될 THEN the system SHALL 출처와 신뢰등급 태그를 부여해 원장에 기록해야 한다.
2. WHEN 신뢰등급 0 콘텐츠가 좌석에 전달될 THEN the system SHALL 이를 지시 슬롯이 아닌 신뢰 불가 데이터로 구분해 전달해야 한다.
3. WHEN 신뢰등급 0 콘텐츠를 만진 실행이 산출물을 낼 THEN the system SHALL 그 산출물을 `tainted`로 표시해야 한다.
4. IF 산출물이 `tainted`라면 THEN the system SHALL 정책 등급을 한 단계 승격시켜야 한다.
5. IF `tainted` 산출물이 위험 능력을 사용하려 하면 THEN the system SHALL 능력 스위치가 ON이더라도 이를 거부해야 한다.
6. WHEN 결정론적 검사가 실행될 THEN the system SHALL 수집 콘텐츠 내 지시문 형태 문자열을 검출해 보고해야 한다.
7. WHEN 좌석이 Hands 또는 발행을 요청할 THEN the system SHALL 타입 지정된 허용 동사 호출만 수용하고 자연어 지시를 실행 경로로 전달하지 않아야 한다.

## Requirement 17: 무인 운영과 침해 복구

**User Story:** 오너로서, 정전이나 사고 후에도 회사가 스스로 복귀하고, 뚫렸을 때 무엇을 어떤 순서로 해야 하는지 미리 정해져 있기를 원한다.

### Acceptance Criteria

1. WHEN 기계가 재부팅될 THEN the system SHALL 오너 개입 없이 서비스를 정상 사용자 컨텍스트로 복귀시켜야 한다.
2. WHEN 재부팅이 완료될 THEN the system SHALL 원장 무손실을 검증해야 한다.
3. WHEN 재부팅이 완료될 THEN the system SHALL 모든 능력 스위치를 OFF 상태로 복귀시켜야 한다.
4. WHEN 좌석 세션 만료가 임박하거나 발생할 THEN the system SHALL 오너에게 알려야 한다.
5. WHEN 이상 볼륨이나 거부 이벤트가 급증할 THEN the system SHALL 실행을 정지하고 오너에게 알려야 한다.
6. WHEN 오너가 일일 요약을 확인할 THEN the system SHALL 위험 능력 사용 내역, 스위치 변경 내역, 거부 내역을 포함해야 한다.
7. WHEN 침해가 의심될 THEN the system SHALL 계정별 OAuth 그랜트 폐기 순서와 복구 절차를 담은 런북을 제공해야 한다.

---

## 원 요구 대응 추적

| 오너 요구 | 대응 |
|---|---|
| 1. 데스크톱+모바일 | R14 |
| 2. 컴퓨터·브라우저 조작 | R7 |
| 3. 7개 채널 운영 | R6, R7 |
| 4. 기획→제작→배포 | R5, R6, R12 |
| 5. 회의로 목표 도출 | R3 |
| 6. CEO 주도 자동 진행 | R3, R12 |
| 7. 등급별 자동/승인 | R4 |
| 8. 글·이미지·영상·기획·프로그램 | R5 |
| 9. 독립적 사고와 토론 | R3 |
| 10. 히스토리 | R9 |
| 11. 라이브오피스 | R10 |
| 12. 에이전트 고용 | R13 |
| 13. 검증·복기 | R11 |
| 14. 반복 업무 설계 | R12 |
| 추가: API 금지 / OAuth 전용 | R1 |
| 추가: 능력 온오프 버튼 | R8, R14.8 |
| 추가: 모바일 전 등급 승인 | R14.6, R14.7 |
| 추가: 보안 | R15, R16, R17 |

---

## 남는 위험 (정직하게)

**능력 스위치는 능력 부재보다 약하다.** 유효시간·개별 승인·에이전트 접근 차단으로 최대한 좁혔지만, 스위치가 ON인 창 안에서 오너가 잘못 승인하면 비가역 작업이 실제로 나간다. 완화 장치는 R4.11의 유예 창과 R16.5(오염된 산출물은 스위치가 켜져 있어도 거부)이다. R17.3에 따라 재부팅하면 모든 스위치가 OFF로 돌아가므로 "켜둔 걸 잊는" 실패는 시간이 지나면 자동 치유된다.

**폰 하나로 L3까지 통과 가능하다.** 이전 설계는 Discord(폰) + 콘솔(집)로 물리적 2채널이었으나, 모바일 전 등급 승인 요구에 따라 두 요소가 같은 기기에 있을 수 있다. 폰이 잠금 해제된 상태로 탈취되면 방어선이 얇아진다. 남은 방어는 기기 토큰(R14.3), 다른 기기로의 즉시 알림(R4.10), 유예 창 중단(R4.11)이다. 폰 분실 시 R14.4의 토큰 무효화를 즉시 해야 하며 이것은 오너의 몫이다.

**벤더 약관.** 구독 CLI를 24시간 자동화로 돌리는 것은 개인 사용 경계를 시험한다. 계정 제재가 오면 회사가 멈춘다. 기술로 해결되지 않으며 완화는 서킷브레이커의 속도 제한과 좌석 분산뿐이다.

**빈 기계 리스크.** 첫 사업 목표가 미디어 채널 성장이므로 Task 9(첫 발행 루프)가 이른 시점에 실제 발행을 내야 한다. 검증·라이브오피스보다 발행을 앞에 둔 이유다.
