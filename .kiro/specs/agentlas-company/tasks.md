# Implementation Plan — agentlas-company

각 태스크는 독립적으로 시연 가능해야 하고, 완료 시 요구사항 번호로 추적됩니다.
태스크 1이 완료되기 전에는 런타임 코드를 추가하지 않습니다.

- [ ] 1. 좌석 계약 실측 — `SEAT-CONTRACT.md`
  - 4개 CLI(Claude Code, Codex, Gemini, Cursor)의 비대화형 명령·출력 형식·종료 코드 측정
  - 동시 세션 허용 여부, 일일·분당 쿼터, 세션 만료 증상과 복구 절차 기록
  - 모든 `*_API_KEY`를 삭제한 환경에서 각 좌석이 동작하는지 확인하고 스냅샷으로 고정
  - Cursor가 로컬 CLI로 동작하는지 판정 (Cloud Agents API는 사용 금지)
  - 시연: `company seats probe`가 좌석·모델·로그인·비대화형 명령·쿼터·동시성 표를 출력
  - _Requirements: R1, R2_

- [ ] 2. 저장소 골격과 금지 게이트
  - `vendor.lock`에 업스트림 4개 커밋 SHA 핀
  - `proc.js`를 `@company/proc`으로 추출 (원저작 라이선스 고지 유지)
  - 린트 3종을 CI 게이트로: `*_API_KEY` 0건, 위험 플래그 0건, `os.kill(pid,0)` 0건
  - CI 매트릭스 windows-latest 1순위
  - 시연: `npm test` 그린 + CI가 API 키 경로 없음을 증명
  - _Requirements: R1.2, R1.3_

- [ ] 3. 구역과 자격증명 레이아웃
  - Windows 계정 3분할(`owner` / `svc-seats` / `svc-broker`), `icacls` 적용 스크립트
  - 좌석은 자기 호스트 OAuth 디렉터리만 읽기, 브로커 자산 접근 거부
  - 시연: `company security verify`가 구역 위반 시도를 전부 거부하고 표로 보고
  - _Requirements: R15_

- [ ] 4. 해시체인 원장
  - append-only JSONL, `prevHash` 체인, 체인 검증, 쓰기 권한 단일화
  - 조회 필터, 리플레이, 암호화 오프사이트 백업
  - 시연: `company history --since 1h` 타임라인, `company replay <run-id>`, 개조 검출
  - _Requirements: R9_

- [ ] 5. Seat Broker
  - 좌석별 동시성·일일 예산·지수 백오프·타임아웃·프로세스 트리 종료
  - 환경 위생(API 키 삭제), per-run 작업 디렉터리, 폴백 체인, 만료 감지
  - 가짜 좌석으로 큐·예산 소진·폴백·취소 검증 후 실좌석 1개 스모크
  - 시연: `company ask --persona ceo "..."` → 좌석 응답 + 원장 이벤트 1건
  - _Requirements: R1.1, R1.4, R2_

- [ ] 6. 조직과 회의
  - 페르소나 정의, 2라운드 턴제 회의 엔진, `DECISION`/`OPEN`/`ACTIONS` 마감 블록
  - `companyctl decision --json` 소비, 크로스벤더 강제, CRITICAL dissent 승격, War Room
  - 시연: `company meeting exec --agenda "..."` → Discord 스레드에 독립 발언 + 마감 블록
  - _Requirements: R3_

- [ ] 7. 정책 게이트와 승인
  - `policy.yaml` 등급 판정, tainted/BLOCK 승격, digest 바인딩
  - 단계별 인증, 만료는 취소, 유예 창, 다기기 알림, 신원 허용목록
  - 시연: L0은 그대로 진행, L2는 폰에서 승인해야 진행, 만료 시 취소됨
  - _Requirements: R4_

- [ ] 8. 능력 스위치
  - 10종 위험 능력 등록, 출하 시 전부 OFF, 유효기간 필수와 자동 복귀
  - 범위 지정, 전체 차단, 에이전트 읽기·쓰기 거부, 7단계 집행 순서
  - 재부팅 시 전부 OFF 복귀, 상태 화면(남은 시간·범위·최근 사용)
  - 시연: 스위치 OFF에서 위험 동사 10종이 전부 거부되고 원장에 `deny`가 남음
  - _Requirements: R8, R15.8, R17.3_

- [ ] 9. 허용 동사와 첫 발행 루프
  - `PublishRequest` 계약, `idempotencyKey` 멱등성, 드라이런, 채널 일일 상한
  - 쓰레드(OAuth API)와 네이버 블로그(Hands)를 각각 하나씩 살려 경로 추상화 검증
  - 시연: 기획 → 초안 → 승인 → 실제 발행 완주, 원장에 URL 증거. **첫 성과 발생 지점**
  - _Requirements: R6_

- [ ] 10. Hands 일반화
  - 전용 브라우저 프로필 + CDP, 단계별 스크린샷, 스키마·도메인 검증
  - 요소 미발견 시 중단(조용한 성공 금지), 반자동 체크리스트 폴백
  - 스마트스토어·네이버 클립·카카오채널 어댑터, 집계값만 반환
  - 시연: 클립 초안 업로드를 자동 수행, 실패 시 이어받을 체크리스트 생성
  - _Requirements: R7_

- [ ] 11. Studio
  - 글은 좌석, 이미지·영상은 OAuth 생성 경로, 프로그램은 Cursor 좌석
  - 브랜드 팩 대조, 위반 시 게이트 FAIL, 생성 코드 격리 실행
  - 시연: 한 포스트에 카피·이미지·짧은 클립이 한 번에 산출
  - _Requirements: R5_

- [ ] 12. 오염 추적과 인젝션 방어
  - 수집 콘텐츠 출처·신뢰등급 태깅, 신뢰 불가 데이터 프레임 전달
  - `tainted` 전파, 등급 승격, 지시문 형태 문자열 검출
  - tainted 산출물은 스위치 ON이어도 위험 능력 거부
  - 시연: 악성 지시가 심긴 목 댓글을 읽힌 뒤 발행이 멈추고 경고가 옴
  - _Requirements: R16_

- [ ] 13. Assurance와 복기
  - `sei` CLI 소비 + 업무 산출물 어댑터, 클레임 등록, 미검증 표시
  - 결정론적 증거 검사(출처 없는 수치·모순·공백), Loop PASS/FAIL
  - 발행 후 지표 수집과 예측 대조, 레시피 수정 제안
  - 시연: `company retro`가 예측 대비 실제와 원인 가설, 레시피 diff를 산출
  - _Requirements: R11_

- [ ] 14. 오피스 API와 콘솔·모바일·라이브오피스
  - loopback + 사설망 바인딩, 공개 인터페이스 기동 거부, 기기 토큰과 폐기
  - SSE 원장 tail, 재연결 시 누락 구간 보충, 합성 표시 금지
  - 데스크톱 Control Room + 모바일 PWA 동일 API, 모바일 전 등급 승인
  - 시연: 폰에서 진행 중 작업이 실시간으로 보이고 L3까지 승인 가능
  - _Requirements: R10, R14_

- [ ] 15. 레시피와 무인 스케줄
  - 선언적 스텝(주체·산출물·게이트 명령), 게이트 실패 시 정지
  - 중복 실행 방지 락, 실패 지점 재개, OS 스케줄러 위임
  - 시연: 예정 시각에 주간 사이클이 무인으로 시작되고 승인 카드만 폰으로 옴
  - _Requirements: R12_

- [ ] 16. 에이전트 채용
  - `HIRE` 블록 처리, 패키지 생성 또는 Hub 차용, digest를 `vendor.lock`에 핀
  - 차용 패키지 무권한 기본값, L3 승인, 좌석 예산 초과 시 거부
  - 시연: 회의 결정 → 패키지 생성 → 승인 → 다음 사이클에 실제 참여
  - _Requirements: R13_

- [ ] 17. 무인 운영과 침해 복구
  - 재부팅 무인 복귀, 원장 무손실 검증, 스위치 전부 OFF 복귀
  - 좌석 만료 알림, 이상 볼륨·`deny` 급증 시 정지, 일일 요약
  - OAuth 그랜트 폐기 순서와 복구 런북 작성 후 **1회 실전 연습**
  - 시연: 전원을 뽑고 다시 켜면 회사가 스스로 출근하고 원장이 온전함
  - _Requirements: R17_
