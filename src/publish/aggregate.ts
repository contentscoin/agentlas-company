/**
 * 집계값 전용 경계 — Z1 → Z2 (R7.6)
 *
 * 스마트스토어 화면에는 주문자 이름·주소·연락처가 그대로 떠 있다. 좌석이
 * 그것을 읽으면 고객 PII 가 벤더 API 로 나간다. 좌석은 "어제 몇 건 팔렸나"
 * 를 알면 되지 "김OO 이 어디 사는지" 를 알 필요가 없다.
 *
 * **화이트리스트로 만든다.** 블랙리스트(이름·주소·전화를 지운다)는 새 필드가
 * 생길 때마다 뚫린다 — 다음 달에 `recipientMemo` 가 추가되면 그대로 샌다.
 * 허용한 것만 통과시키면 모르는 필드는 자동으로 막힌다.
 *
 * 이 모듈은 발행이 아니라 읽기 쪽이지만 여기 둔다. 스마트스토어 어댑터가
 * 유일한 사용처이고, 경계와 그 경계를 쓰는 코드가 붙어 있는 편이 낫다.
 */

/** 좌석에 넘어가도 되는 집계 필드. 이 목록에 없으면 넘어가지 않는다. */
export const AGGREGATE_FIELDS = [
  'orderCount',
  'revenue',
  'refundCount',
  'refundAmount',
  'itemsSold',
  'averageOrderValue',
  'periodFrom',
  'periodTo',
  'currency',
] as const;

export type AggregateField = (typeof AGGREGATE_FIELDS)[number];

export type Aggregate = Partial<Record<AggregateField, number | string>>;

export interface AggregateResult {
  aggregate: Aggregate;
  /** 막힌 필드 이름. 값은 담지 않는다 — 담으면 이 객체가 유출 경로가 된다. */
  dropped: string[];
}

/**
 * 원본 레코드에서 집계 필드만 뽑는다.
 *
 * 막힌 필드는 **이름만** 보고한다. 값을 함께 돌려주면 "무엇이 막혔는지
 * 보여주려고" 만든 필드가 그대로 유출 통로가 된다.
 */
export function toAggregate(raw: unknown): AggregateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { aggregate: {}, dropped: [] };
  }
  const aggregate: Aggregate = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((AGGREGATE_FIELDS as readonly string[]).includes(key)) {
      if (typeof value === 'number' || typeof value === 'string') {
        aggregate[key as AggregateField] = value;
        continue;
      }
      // 허용 필드라도 형태가 다르면 통과시키지 않는다. 객체 안에 PII 가
      // 중첩돼 들어오는 경로를 막는다.
      dropped.push(key);
      continue;
    }
    dropped.push(key);
  }
  return { aggregate, dropped };
}

/** 주문 목록을 집계 하나로 접는다. 개별 주문은 좌석에 닿지 않는다. */
export function foldOrders(orders: readonly unknown[]): AggregateResult {
  let orderCount = 0;
  let revenue = 0;
  const dropped = new Set<string>();

  for (const order of orders) {
    if (typeof order !== 'object' || order === null) continue;
    orderCount += 1;
    const record = order as Record<string, unknown>;
    const amount = record.amount ?? record.revenue;
    if (typeof amount === 'number') revenue += amount;
    for (const key of Object.keys(record)) {
      if (key !== 'amount' && key !== 'revenue') dropped.add(key);
    }
  }

  return {
    aggregate: {
      orderCount,
      revenue,
      ...(orderCount > 0 ? { averageOrderValue: Math.round(revenue / orderCount) } : {}),
    },
    dropped: [...dropped],
  };
}
