/**
 * Hands 단계 동사 (R7.3, R7.4, R16.7)
 *
 * `src/verbs/` 가 "무엇을 발행할 것인가"(채널 수준)를 닫아 두었다면,
 * 여기는 "브라우저에서 무엇을 만질 것인가"(조작 수준)를 닫아 둔다.
 * 두 층 모두 **닫힌 목록**이고, 좌석이 "브라우저에서 이걸 해줘"라고 말할 수
 * 있는 함수는 어느 층에도 없다.
 *
 * 실행 표면은 agentlas-desktop 이 물질화하는 `agentlas-browser-cdp.mjs` 다.
 * 그것은 `@playwright/mcp` 앞에 선 MCP stdio 프록시이므로 도구가 매우 많다.
 * 그 전부를 노출하지 않는다 — 아래 표에 있는 것만 통과한다.
 *
 * **의도적으로 제외한 것들**과 그 이유:
 *   `browser_evaluate`     임의 JS 실행. 자유 텍스트가 실행이 되는 바로 그 경로다
 *   `browser_cookie_*`     자격증명 표면. 좌석 구역이 읽을 것이 아니다 (R15)
 *   `browser_localstorage_*` 위와 같다
 *   `browser_file_upload`  자산 경로 검증이 선행되어야 한다. Task 9 에서 연다
 *   `browser_mouse_*_xy`   좌표 조작은 스냅샷 ref 로 대체 가능하고, 화면이
 *                          바뀌었을 때 조용히 엉뚱한 곳을 누른다
 *
 * 제외 목록을 주석으로 남기는 이유는, 나중에 누군가 "왜 이건 없지" 하고
 * 무심코 추가하는 것을 막기 위해서다.
 */

/** company 동사 → `browser_*` 도구 매핑. 이 표에 없는 것은 존재하지 않는다. */
export const HANDS_TOOL: Record<HandsOp, string> = {
  navigate: 'browser_navigate',
  click: 'browser_click',
  type: 'browser_type',
  press_key: 'browser_press_key',
  select_option: 'browser_select_option',
  wait_for: 'browser_wait_for',
  snapshot: 'browser_snapshot',
  screenshot: 'browser_take_screenshot',
};

export const HANDS_OPS = [
  'navigate',
  'click',
  'type',
  'press_key',
  'select_option',
  'wait_for',
  'snapshot',
  'screenshot',
] as const;

export type HandsOp = (typeof HANDS_OPS)[number];

export function isHandsOp(value: unknown): value is HandsOp {
  return typeof value === 'string' && (HANDS_OPS as readonly string[]).includes(value);
}

export interface Navigate {
  op: 'navigate';
  /** 도메인 허용목록을 통과해야 한다 (R7.4). */
  url: string;
}

/**
 * 요소 지정은 `snapshot` 이 돌려준 `ref` 로 한다.
 *
 * `element` 는 사람이 읽는 설명이고 판정에 쓰이지 않는다. 실제 대상은 `ref`
 * 하나다 — 설명으로 요소를 찾게 두면 화면이 바뀌었을 때 비슷한 다른 것을
 * 누르고 성공으로 보고한다. 그것이 R7.5 가 금지하는 조용한 성공이다.
 */
export interface Click {
  op: 'click';
  element: string;
  ref: string;
}

export interface TypeText {
  op: 'type';
  element: string;
  ref: string;
  text: string;
  submit?: boolean;
}

export interface PressKey {
  op: 'press_key';
  key: string;
}

export interface SelectOption {
  op: 'select_option';
  element: string;
  ref: string;
  values: string[];
}

export interface WaitFor {
  op: 'wait_for';
  /** 나타나기를 기다릴 문자열. 시간 대기만으로 넘어가지 않는다. */
  text?: string;
  timeMs?: number;
}

export interface Snapshot {
  op: 'snapshot';
}

export interface Screenshot {
  op: 'screenshot';
}

export type HandsStep =
  | Navigate
  | Click
  | TypeText
  | PressKey
  | SelectOption
  | WaitFor
  | Snapshot
  | Screenshot;

export type HandsParseResult = { ok: true; step: HandsStep } | { ok: false; errors: string[] };

/**
 * 페이지 상태를 바꿀 수 있는 동사.
 *
 * 런처는 결제·전송·발행·삭제 **의도**로 게이팅하는데, 그 판정은 실행 시점의
 * 요소 텍스트와 페이지 URL 에 달려 있어 우리가 미리 알 수 없다. 그러면
 * 기준을 어디에 둘 것인가 — **부분 적용의 위험**에 둔다.
 *
 * 읽기 전용 계획은 실패해도 세상을 반쯤 바꿔놓지 못한다. 조작 계획은 할 수
 * 있다. 10단계 중 7번째에서 desktop 이 없어 멈추면 앞의 6단계는 이미
 * 적용된 뒤다. 그래서 조작이 하나라도 있으면 출발 전에 desktop 을 요구한다.
 */
export const MUTATING_OPS: readonly HandsOp[] = ['click', 'type', 'press_key', 'select_option'];

export function isMutating(op: HandsOp): boolean {
  return MUTATING_OPS.includes(op);
}

/** 계획이 desktop 승인 서버를 요구하는가. */
export function planNeedsDesktop(steps: readonly { op: HandsOp }[]): boolean {
  return steps.some((s) => isMutating(s.op));
}

export interface HandsPolicy {
  /** Hands 가 이동할 수 있는 도메인. 비어 있으면 이동 자체를 금지한다. */
  allowedDomains: string[];
  maxTextLength: number;
  maxWaitMs: number;
}

export const DEFAULT_HANDS_POLICY: HandsPolicy = {
  allowedDomains: [],
  maxTextLength: 5000,
  maxWaitMs: 30_000,
};
