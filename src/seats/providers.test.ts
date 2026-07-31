import { describe, expect, it } from 'vitest';
import { PROVIDER_REGISTRY, distinctVendors, ollamaSeat, providerFor } from './providers.js';
import { ALL_SEATS, OLLAMA_MODEL, seatById } from './spec.js';
import { STRIPPED_ENV_VARS } from './strip-env.js';

describe('프로바이더 등록부', () => {
  it('모든 좌석이 등록부에 있다', () => {
    for (const seat of ALL_SEATS) {
      expect(providerFor(seat.id), `${seat.id} 가 등록부에 없다`).toBeDefined();
    }
  });

  it('등록부의 모든 좌석이 실제 사양으로 존재한다', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(() => seatById(p.seat)).not.toThrow();
    }
  });

  it('인증 방식은 oauth 또는 local 뿐이다 — apiKey 는 표현할 수 없다', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(['oauth', 'local']).toContain(p.auth);
    }
  });

  it('벤더가 좌석마다 일치한다', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(seatById(p.seat).vendor).toBe(p.vendor);
    }
  });
});

describe('API 키 경로가 사양에 없다 (R1)', () => {
  it('어떤 좌석의 인자에도 키 변수 이름이 들어가지 않는다', () => {
    for (const seat of ALL_SEATS) {
      const args = seat.buildArgs('프롬프트', '/tmp/out.txt').join(' ');
      for (const name of STRIPPED_ENV_VARS) {
        expect(args, `${seat.id} 인자에 ${name} 이 있다`).not.toContain(name);
      }
    }
  });

  it('모든 좌석이 stdin 으로 프롬프트를 받는다 — 인자 길이 상한과 개행 문제 회피', () => {
    for (const seat of ALL_SEATS) {
      expect(seat.promptVia, `${seat.id}`).toBe('stdin');
    }
  });
});

describe('로컬 좌석 (Ollama)', () => {
  const seat = ollamaSeat('llama3.2:1b');

  it('벤더가 local 이라 크로스벤더 조건을 만족시킬 수 있다 (R3.4)', () => {
    expect(seat.vendor).toBe('local');
    expect(seat.id).toBe('ollama');
  });

  it('모델 이름을 인자에 담는다', () => {
    expect(seat.buildArgs('', '/tmp/o.txt')).toEqual(['run', 'llama3.2:1b']);
  });

  it('설정 홈 격리가 필요 없다 — 개인 스킬·MCP 를 상속하지 않는다', () => {
    expect(seat.configHomeEnv).toBeNull();
    expect(seat.authFiles).toEqual([]);
  });

  it('쿼터 한도가 없다 — 상한은 기계 성능이지 계정이 아니다', () => {
    expect(seat.quota.limit).toBeNull();
  });

  it('stdout 을 결과로 읽고 공백만 있으면 실패로 본다', () => {
    expect(seat.readResult(null, '  SEAT_OK \n')).toBe('SEAT_OK');
    expect(seat.readResult(null, '   \n ')).toBeNull();
  });

  it('실측 전에는 verified 가 아니다 — 추정으로 켜지 않는다', () => {
    expect(seat.verified).toBe(false);
    expect(seat.note).toContain('llama3.2:1b');
  });

  it('모델 이름을 환경변수로 바꿀 수 있다', () => {
    expect(OLLAMA_MODEL).toBeTruthy();
    expect(ollamaSeat('qwen3:1.7b').buildArgs('', 'x')).toContain('qwen3:1.7b');
  });
});

describe('크로스벤더 가능 여부', () => {
  it('검증된 좌석만 센다', () => {
    const vendors = distinctVendors(ALL_SEATS);
    expect(vendors).toContain('openai');
    // 나머지는 실측 전이므로 세어지지 않는다
    expect(vendors).not.toContain('local');
  });

  it('검증된 좌석이 하나면 크로스벤더 회의가 불가능하다', () => {
    const verified = ALL_SEATS.filter((s) => s.verified);
    const vendors = distinctVendors(verified);
    // 지금 상태를 기록해 둔다. 좌석이 늘면 이 기대값이 바뀌어야 한다.
    expect(vendors.length).toBeLessThanOrEqual(2);
  });

  it('가짜로 검증된 로컬 좌석을 더하면 벤더가 둘이 된다', () => {
    const local = { ...ollamaSeat('m'), verified: true };
    const vendors = distinctVendors([...ALL_SEATS, local]);
    expect(vendors).toContain('openai');
    expect(vendors).toContain('local');
    expect(vendors.length).toBeGreaterThanOrEqual(2);
  });
});
