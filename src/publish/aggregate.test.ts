import { describe, expect, it } from 'vitest';
import { AGGREGATE_FIELDS, foldOrders, toAggregate } from './aggregate.js';

describe('toAggregate — 집계값 전용 (R7.6)', () => {
  it('집계 필드는 통과한다', () => {
    const { aggregate } = toAggregate({ orderCount: 12, revenue: 340_000, currency: 'KRW' });
    expect(aggregate).toEqual({ orderCount: 12, revenue: 340_000, currency: 'KRW' });
  });

  it('고객 PII 를 막는다', () => {
    const { aggregate, dropped } = toAggregate({
      orderCount: 3,
      buyerName: '김OO',
      address: '서울시 …',
      phone: '010-0000-0000',
    });
    expect(aggregate).toEqual({ orderCount: 3 });
    expect(dropped.sort()).toEqual(['address', 'buyerName', 'phone']);
  });

  it('막힌 필드의 값은 돌려주지 않는다 — 보고 경로가 유출 경로가 되지 않는다', () => {
    const result = toAggregate({ buyerName: '김OO', phone: '010-1234-5678' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('김OO');
    expect(serialized).not.toContain('010-1234-5678');
  });

  it('모르는 필드는 기본적으로 막힌다 — 화이트리스트라 새 필드가 새지 않는다', () => {
    // 다음 달에 추가될 수 있는 필드. 블랙리스트였다면 그대로 통과했을 것이다.
    const { aggregate, dropped } = toAggregate({ orderCount: 1, recipientMemo: '부재시 경비실' });
    expect(aggregate).toEqual({ orderCount: 1 });
    expect(dropped).toContain('recipientMemo');
  });

  it('허용 필드라도 객체가 실려 오면 막는다 — 중첩 PII 를 막는다', () => {
    const { aggregate, dropped } = toAggregate({
      revenue: { total: 1000, byBuyer: { '김OO': 1000 } },
      orderCount: 2,
    });
    expect(aggregate).toEqual({ orderCount: 2 });
    expect(dropped).toContain('revenue');
    expect(JSON.stringify(aggregate)).not.toContain('김OO');
  });

  it('객체가 아니면 빈 집계다', () => {
    expect(toAggregate('주문 목록').aggregate).toEqual({});
    expect(toAggregate(null).aggregate).toEqual({});
    expect(toAggregate([{ buyerName: '김OO' }]).aggregate).toEqual({});
  });

  it('허용 목록이 의도한 필드만 담고 있다', () => {
    expect(AGGREGATE_FIELDS).not.toContain('buyerName' as never);
    expect(AGGREGATE_FIELDS).not.toContain('address' as never);
    expect(AGGREGATE_FIELDS).not.toContain('phone' as never);
  });
});

describe('foldOrders — 개별 주문은 좌석에 닿지 않는다', () => {
  it('주문 목록을 건수와 매출로 접는다', () => {
    const { aggregate } = foldOrders([
      { amount: 10_000, buyerName: '김OO', address: '서울' },
      { amount: 20_000, buyerName: '이OO', address: '부산' },
    ]);
    expect(aggregate.orderCount).toBe(2);
    expect(aggregate.revenue).toBe(30_000);
    expect(aggregate.averageOrderValue).toBe(15_000);
  });

  it('접은 결과에 개인정보가 남지 않는다', () => {
    const result = foldOrders([{ amount: 1, buyerName: '김OO', phone: '010-1111-2222' }]);
    expect(JSON.stringify(result.aggregate)).not.toContain('김OO');
    expect(JSON.stringify(result.aggregate)).not.toContain('010-1111-2222');
    // 무엇이 있었는지는 이름으로만 보고한다.
    expect(result.dropped).toContain('buyerName');
  });

  it('빈 목록은 0 건이고 평균을 만들지 않는다', () => {
    const { aggregate } = foldOrders([]);
    expect(aggregate.orderCount).toBe(0);
    expect(aggregate.averageOrderValue).toBeUndefined();
  });
});
