/**
 * 오염 추적 타입 (R16)
 *
 * 이 회사의 지배적 위험은 프롬프트 인젝션이다.
 * 에이전트는 매일 댓글·웹페이지·검색결과를 읽고, 동시에 돈과 계정에 닿는
 * 손을 갖는다. 읽는 권한과 실행 권한이 한 몸에 있는 것이 confused deputy 다.
 *
 * 방어를 층으로 쌓되, **어느 층도 프롬프트 설득에 의존하지 않는다.**
 *
 *   1차  허용 동사   — 실행 가능한 것이 애초에 목록에 없다      (verbs/parse.ts)
 *   2차  능력 부재   — 최악의 명령은 스위치 OFF 로 막힌다       (capabilities/)
 *   3차  권한 분리   — 훔칠 자격증명이 그 프로세스에 없다        (Task 3)
 *   4차  오염 추적   — 오염된 산출물은 승인으로 승격된다         (이 모듈)
 *   5차  데이터 프레임 — 지시 슬롯과 데이터 슬롯을 분리한다      (pack.ts)
 *   6차  결정론적 탐지 — 지시문 형태 문자열을 신호로 보고한다    (detect.ts)
 *   7차  서킷브레이커 — 성공한 공격의 blast radius 를 제한한다
 *
 * 5·6차만으로는 부족하다. 그것들은 탐지와 마찰이고, 실제 통제는 1~3차다.
 * 이 파일의 주석이 그 우선순위를 잊지 않게 하는 장치다.
 */

/**
 * 신뢰등급.
 *
 *   0  외부 · 신뢰 불가 — 웹, 댓글, DM, 검색결과, 차용 패키지 산출물
 *   1  내부 파생 — 우리 에이전트가 신뢰 1 이상만 보고 만든 것
 *   2  검증됨 — 오너 입력, 자체 실측, 인용 팩
 */
export type TrustLevel = 0 | 1 | 2;

export type SourceKind =
  | 'web'
  | 'comment'
  | 'dm'
  | 'search'
  | 'file'
  | 'owner'
  | 'agent'
  | 'metrics'
  | 'borrowed-agent';

/** 신뢰등급 0 으로 고정되는 출처. 실수로 올려 쓸 수 없게 목록으로 못박는다. */
export const UNTRUSTED_SOURCES: readonly SourceKind[] = ['web', 'comment', 'dm', 'search', 'borrowed-agent'];

export interface SourceRef {
  kind: SourceKind;
  /** URL, 댓글 id, 파일 경로 등. 원장에 남으므로 비밀을 넣지 않는다. */
  ref: string;
}

/** 결정론적 탐지가 찾은 신호. 매칭된 문장 자체는 담지 않는다. */
export interface InjectionSignal {
  kind: InjectionSignalKind;
  /** 텍스트 내 위치. 사람이 원본을 열어 확인할 수 있게 한다. */
  at: number;
}

export type InjectionSignalKind =
  | 'instruction-override'
  | 'role-hijack'
  | 'system-delimiter'
  | 'credential-target'
  | 'payout-target'
  | 'command-execution'
  | 'exfiltration'
  | 'urgency-pressure';

export interface IngestedItem {
  id: string;
  source: SourceRef;
  trust: TrustLevel;
  text: string;
  ingestedAt: string;
  /** 본문 digest. 원장에는 이것만 남는다. */
  digest: string;
  signals: InjectionSignal[];
}

/** 컨텍스트 팩 조립 결과. */
export interface BuiltPack {
  prompt: string;
  /** 팩에 신뢰등급 0 이 하나라도 섞였는가 (R16.3). */
  tainted: boolean;
  /** 팩에 들어간 최저 신뢰등급. */
  minTrust: TrustLevel;
  sources: SourceRef[];
  signals: InjectionSignal[];
}
