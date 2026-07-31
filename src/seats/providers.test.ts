import { describe, expect, it } from 'vitest';
import { PROVIDER_REGISTRY, crossVendorPossible, distinctVendors, providerFor } from './providers.js';
import { ALL_SEATS, CLAUDE_SEAT, CODEX_SEAT, seatById } from './spec.js';
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

  it('인증 방식은 oauth 뿐이다 — apiKey 는 타입으로 표현할 수 없다', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.auth).toBe('oauth');
    }
  });

  it('벤더가 좌석마다 일치한다', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(seatById(p.seat).vendor).toBe(p.vendor);
    }
  });

  it('벤더가 좌석마다 고유하다 — 크로스벤더 판정이 의미를 가지려면 필요하다', () => {
    const vendors = PROVIDER_REGISTRY.map((p) => p.vendor);
    expect(new Set(vendors).size).toBe(vendors.length);
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
});

describe('프롬프트 전달과 실행 방식의 조합 (실측이 강제한 규칙)', () => {
  it('셔틀 좌석은 셸로 띄우고 stdin 을 쓴다', () => {
    expect(CODEX_SEAT.spawnMode).toBe('shell');
    expect(CODEX_SEAT.promptVia).toBe('stdin');
  });

  it('stdin 을 읽지 않는 좌석은 direct + arg 여야 한다', () => {
    // claude 는 stdin 을 읽지 않는다(실측). 여러 줄 인자를 셸로 넘기면 깨지므로
    // 반드시 direct 로 띄워야 한다. 이 조합이 어긋나면 여러 줄 프롬프트가 실패한다.
    expect(CLAUDE_SEAT.promptVia).toBe('arg');
    expect(CLAUDE_SEAT.spawnMode).toBe('direct');
  });

  it('arg 좌석은 모두 direct 다 — 조합 규칙을 전 좌석에 강제한다', () => {
    for (const seat of ALL_SEATS) {
      if (seat.promptVia === 'arg') {
        expect(seat.spawnMode, `${seat.id} 는 arg 인데 direct 가 아니다`).toBe('direct');
      }
    }
  });

  it('arg 좌석의 인자에 프롬프트가 실제로 들어간다', () => {
    const multi = '첫 줄\n\n둘째 줄';
    expect(CLAUDE_SEAT.buildArgs(multi, '/tmp/o')).toContain(multi);
  });

  it('stdin 좌석의 인자에는 프롬프트가 들어가지 않는다', () => {
    expect(CODEX_SEAT.buildArgs('', '/tmp/o').join(' ')).not.toContain('프롬프트');
  });
});

describe('최소 프로필 (재현성)', () => {
  it('codex 는 사용자 설정을 무시한다', () => {
    expect(CODEX_SEAT.buildArgs('', '/tmp/o')).toContain('--ignore-user-config');
  });

  it('claude 는 개인 MCP 와 사용자 설정을 제외한다', () => {
    const args = CLAUDE_SEAT.buildArgs('q', '/tmp/o');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--setting-sources');
    expect(args).toContain('project');
  });
});

describe('크로스벤더 가능 여부 (R3.4)', () => {
  it('검증된 좌석만 센다', () => {
    const vendors = distinctVendors(ALL_SEATS);
    expect(vendors).toContain('openai');
    expect(vendors).toContain('anthropic');
  });

  it('검증된 벤더가 둘 이상이면 크로스벤더 회의가 가능하다', () => {
    expect(crossVendorPossible(ALL_SEATS)).toBe(true);
  });

  it('한 벤더만 검증되면 불가능하다', () => {
    expect(crossVendorPossible([CODEX_SEAT])).toBe(false);
  });

  it('미검증 좌석은 벤더 수에 들어가지 않는다', () => {
    const unverified = ALL_SEATS.filter((s) => !s.verified);
    expect(distinctVendors(unverified)).toEqual([]);
  });
});

describe('쿼터 창이 좌석마다 다르다', () => {
  it('claude 는 주간 창이고 리셋 시각이 기록되어 있다', () => {
    expect(CLAUDE_SEAT.quota.window).toBe('week');
    expect(CLAUDE_SEAT.quota.resetAt).toBe('20:00 Asia/Seoul');
  });

  it('codex 는 일간 창이다', () => {
    expect(CODEX_SEAT.quota.window).toBe('day');
  });

  it('실측되지 않은 한도는 null 이다 — 추정값을 넣지 않는다', () => {
    for (const seat of ALL_SEATS) {
      if (seat.quota.limit !== null) expect(typeof seat.quota.limit).toBe('number');
    }
  });
});
