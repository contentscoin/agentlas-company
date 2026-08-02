/**
 * 차용 패키지 권한 (R13.3)
 *
 * **차용 패키지는 남이 쓴 지시문이다.** Hub 에서 가져온 에이전트는 우리가
 * 검토하지 않은 프롬프트를 들고 오고, 그 프롬프트는 실행되면 우리 계정으로
 * 행동한다. 그래서 무권한에서 시작한다 — Hands 없음, 발행 없음,
 * 네트워크 쓰기 없음.
 *
 * **화이트리스트로 만든다.** `aggregate.ts` 와 같은 이유다. "위험한 것을
 * 빼는" 방식이면 다음에 새 권한이 생길 때 차용 패키지가 그것을 자동으로
 * 갖는다. 허용한 것만 주면 모르는 권한은 자동으로 없다.
 *
 * 승격은 오너가 명시적으로 한다. 그것도 L3 이고, 승격 자체가 별도 승인이다 —
 * 채용 승인이 권한 승인을 겸하지 않는다. 채용은 "이 에이전트를 들인다" 이고
 * 권한 부여는 "이 에이전트가 무엇을 만질 수 있다" 로, 다른 결정이다.
 */

/** 차용 패키지에 줄 수 있는 권한. 이 목록에 없는 것은 존재하지 않는다. */
export const GRANTABLE = ['read_ledger', 'seat_call', 'draft_write'] as const;

export type Grantable = (typeof GRANTABLE)[number];

/**
 * 차용 패키지에 **절대** 기본으로 주지 않는 것 (R13.3).
 *
 * 목록으로 두는 이유는 집행이 아니라 문서화다 — 집행은 `GRANTABLE` 이
 * 화이트리스트라는 사실이 한다. 이 상수는 "왜 없는가" 를 코드에 남긴다.
 */
export const NEVER_BY_DEFAULT = ['hands', 'publish', 'network_write'] as const;

export interface AgentPermissions {
  granted: Grantable[];
}

/** 차용 패키지의 출발점. 빈 권한이다. */
export function defaultBorrowedPermissions(): AgentPermissions {
  return { granted: [] };
}

/**
 * 우리가 만든 패키지의 출발점.
 *
 * 차용보다 넓지만 여전히 Hands·발행은 없다. 우리가 썼다고 해서 위험 능력을
 * 자동으로 갖는 것은 아니다 — 그것은 능력 스위치(R8)가 따로 다룬다.
 */
export function defaultBuiltPermissions(): AgentPermissions {
  return { granted: ['read_ledger', 'seat_call', 'draft_write'] };
}

export function isGrantable(value: unknown): value is Grantable {
  return typeof value === 'string' && (GRANTABLE as readonly string[]).includes(value);
}

export interface GrantResult {
  ok: boolean;
  permissions: AgentPermissions;
  refused: string[];
}

/**
 * 권한을 부여한다.
 *
 * 허용 목록 밖의 요청은 조용히 버리지 않고 `refused` 로 보고한다. 조용히
 * 버리면 "권한을 줬는데 왜 안 되지" 가 되고, 그때 사람은 다른 곳을 뒤진다.
 */
export function grant(current: AgentPermissions, wanted: readonly string[]): GrantResult {
  const granted = new Set(current.granted);
  const refused: string[] = [];

  for (const want of wanted) {
    if (isGrantable(want)) {
      granted.add(want);
      continue;
    }
    refused.push(
      (NEVER_BY_DEFAULT as readonly string[]).includes(want)
        ? `${want} 은 차용 패키지에 부여할 수 없다 (R13.3)`
        : `알 수 없는 권한: ${want}`,
    );
  }

  return {
    ok: refused.length === 0,
    permissions: { granted: [...granted] },
    refused,
  };
}
