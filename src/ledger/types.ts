/**
 * 원장 타입 (R9)
 *
 * 원장은 이 시스템의 유일한 상태 저장소다.
 * 라이브오피스(R10), 히스토리(R9.4), 리플레이(R9.5), 검증과 복기(R11)가
 * 모두 이 하나의 스트림을 읽는다. 별도 상태 저장소를 만들지 않는다.
 */

export const GENESIS_HASH = '0'.repeat(64);

export type ActorKind = 'agent' | 'owner' | 'system';

/**
 * 좌석 식별자.
 *
 * `ollama` 는 로컬 모델 좌석이다. 구독도 API 키도 없이 벤더 하나를 더 확보해
 * 크로스벤더 회의(R3.4)의 교착을 푼다.
 */
export type SeatId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'ollama';

export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * 이벤트 종류.
 *
 * `deny` 를 별도 종류로 둔 것은 의도적이다.
 * 거부 이벤트의 급증이 침해 탐지의 주 신호이기 때문에(R17.5),
 * 다른 종류에 섞어 두면 그 신호를 놓친다.
 */
export type EventKind =
  | 'seat.call'
  | 'meeting.turn'
  | 'decision'
  | 'gate.verdict'
  | 'approval'
  | 'switch.change'
  | 'hands.step'
  | 'publish'
  | 'deny'
  | 'retro'
  | 'ingest';

export interface Actor {
  kind: ActorKind;
  id: string;
  seat?: SeatId;
}

/** 원장에 적히기 전의 이벤트. seq/hash/prevHash 는 원장이 채운다. */
export interface EventInput {
  at?: string;
  actor: Actor;
  kind: EventKind;
  level?: AutonomyLevel;
  tainted?: boolean;
  /** 같은 실행에 속한 이벤트를 묶는 키. 리플레이 단위 (R9.5). */
  runId?: string;
  /** 본문은 원장 밖에 두고 여기에는 digest 만 남긴다. */
  payloadDigest?: string;
  /** 사람이 읽는 한 줄 요약. 비밀이나 PII 를 담지 않는다. */
  summary?: string;
  /** 스크린샷·URL·커밋 해시 등 증거 경로. */
  evidence?: string[];
}

/** 원장에 확정 기록된 이벤트. */
export interface LedgerEvent {
  id: string;
  seq: number;
  at: string;
  prevHash: string;
  hash: string;
  actor: Actor;
  kind: EventKind;
  level?: AutonomyLevel;
  tainted?: boolean;
  runId?: string;
  payloadDigest?: string;
  summary?: string;
  evidence: string[];
}

export interface QueryFilter {
  since?: string;
  until?: string;
  kind?: EventKind | EventKind[];
  actorId?: string;
  level?: AutonomyLevel;
  runId?: string;
  tainted?: boolean;
  limit?: number;
}

export type VerifyProblem =
  | { at: number; problem: 'unparseable'; detail: string }
  | { at: number; problem: 'seq-gap'; detail: string }
  | { at: number; problem: 'chain-break'; detail: string }
  | { at: number; problem: 'hash-mismatch'; detail: string };

export interface VerifyResult {
  ok: boolean;
  count: number;
  /** 마지막으로 온전한 이벤트의 seq. 손상 지점 이전까지는 신뢰할 수 있다. */
  lastGoodSeq: number;
  problems: VerifyProblem[];
}
