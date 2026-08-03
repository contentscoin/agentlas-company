/**
 * 산출물과 슬롯 (R5)
 *
 * 한 포스트는 여러 슬롯으로 이뤄진다 — 카피, 기획, 이미지, 영상, 프로그램.
 * **채우지 못한 슬롯은 `unmet` 이고, 추정하지 않는다.**
 *
 * 이것이 이 모듈의 존재 이유다. 이미지 생성 표면이 없는데 "이미지: 준비됨"
 * 이라고 적으면, 발행 직전에야 없다는 것을 알게 된다. 더 나쁘게는 그대로
 * 나가서 빈 자리로 게시된다. 그래서 슬롯 상태를 타입으로 강제한다 —
 * `unmet` 슬롯에는 산출물을 담을 필드가 아예 없다.
 *
 * `blocked` 와 `unmet` 을 구분한다.
 *   unmet    아직 안 만들었다. 만들면 채워진다
 *   blocked  만들 수 없다. 표면이 없거나 좌석이 없다 — 사람이 개입해야 한다
 *
 * 구분하는 이유는 오너가 할 일이 다르기 때문이다. 앞은 기다리면 되고,
 * 뒤는 무언가를 설치하거나 요청해야 한다.
 */

export const SLOT_KINDS = ['copy', 'plan', 'image', 'video', 'program'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

export interface FilledSlot {
  kind: SlotKind;
  state: 'filled';
  /** 산출물 본문 또는 참조(파일 경로, 커밋 해시). */
  content: string;
  /** 근거 인용 (R5.1). 비어 있어도 되지만 필드는 있어야 한다. */
  citations: string[];
  /** 어느 좌석이 만들었는가. */
  seat?: string;
}

export interface UnfilledSlot {
  kind: SlotKind;
  state: 'unmet' | 'blocked';
  /** 왜 비어 있는지. 추정 대신 이유를 남긴다. */
  reason: string;
}

export type Slot = FilledSlot | UnfilledSlot;

export function isFilled(slot: Slot): slot is FilledSlot {
  return slot.state === 'filled';
}

export interface Artifact {
  id: string;
  title: string;
  slots: Slot[];
  /** 브랜드 대조 결과. 아직 안 했으면 없다 — 통과로 간주하지 않는다. */
  brandPass?: boolean;
  brandNotes: string[];
}

/** 슬롯을 찾는다. 없으면 `unmet` 으로 취급한다 — 없는 것을 있다고 하지 않는다. */
export function slotOf(artifact: Artifact, kind: SlotKind): Slot {
  return (
    artifact.slots.find((s) => s.kind === kind) ?? {
      kind,
      state: 'unmet',
      reason: '요청되지 않았다',
    }
  );
}

/**
 * 발행 가능한가.
 *
 * 필요한 슬롯이 전부 채워지고 브랜드 대조를 통과해야 한다. **브랜드 대조를
 * 하지 않은 것은 통과가 아니다** — `brandPass` 가 `undefined` 면 막는다.
 * 검사를 건너뛴 것을 통과로 읽으면 검사가 없는 것과 같다.
 */
export function publishReadiness(
  artifact: Artifact,
  requiredSlots: readonly SlotKind[],
): { ready: boolean; missing: Slot[]; reasons: string[] } {
  const missing = requiredSlots.map((kind) => slotOf(artifact, kind)).filter((s) => !isFilled(s));
  const reasons: string[] = [];

  for (const slot of missing) {
    const unfilled = slot as UnfilledSlot;
    reasons.push(
      `${slot.kind} — ${unfilled.state === 'blocked' ? '막힘' : '미충족'}: ${unfilled.reason}`,
    );
  }
  if (artifact.brandPass === undefined) {
    reasons.push('브랜드 대조를 아직 하지 않았다 — 검사하지 않은 것은 통과가 아니다');
  } else if (!artifact.brandPass) {
    reasons.push(...artifact.brandNotes.map((n) => `브랜드 위반 — ${n}`));
  }

  return { ready: missing.length === 0 && artifact.brandPass === true, missing, reasons };
}

/** 사람이 읽는 슬롯 표. 미충족 사유를 숨기지 않는다. */
export function describeSlots(artifact: Artifact): string[] {
  return SLOT_KINDS.map((kind) => {
    const slot = slotOf(artifact, kind);
    if (isFilled(slot)) {
      const cites = slot.citations.length > 0 ? ` · 인용 ${slot.citations.length}` : '';
      return `${kind.padEnd(8)} 충족   ${slot.seat ? `[${slot.seat}] ` : ''}${slot.content.slice(0, 40)}${cites}`;
    }
    const label = slot.state === 'blocked' ? '막힘  ' : '미충족';
    return `${kind.padEnd(8)} ${label} ${slot.reason}`;
  });
}
