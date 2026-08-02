import { describe, expect, it } from 'vitest';
import { PublicBindRefused, assertBindable, classifyAddress } from './bind.js';

describe('classifyAddress — 공개 인터페이스 거부 (R14.2)', () => {
  it('와일드카드를 전부 막는다 — 0.0.0.0 만 막으면 나머지로 다 뚫린다', () => {
    for (const addr of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '*', '']) {
      expect(classifyAddress(addr).ok, addr).toBe(false);
    }
  });

  it('loopback 을 통과시킨다', () => {
    for (const addr of ['127.0.0.1', '127.1.2.3', '::1']) {
      const v = classifyAddress(addr);
      expect(v.ok, addr).toBe(true);
      if (v.ok) expect(v.kind).toBe('loopback');
    }
  });

  it('사설 대역을 통과시킨다 (R14.1)', () => {
    for (const addr of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.10', '169.254.1.1']) {
      expect(classifyAddress(addr).ok, addr).toBe(true);
    }
  });

  it('Tailscale CGNAT 대역을 사설로 본다', () => {
    expect(classifyAddress('100.64.0.1').ok).toBe(true);
    expect(classifyAddress('100.127.255.255').ok).toBe(true);
  });

  it('사설 대역 경계 밖은 막는다', () => {
    // 172.15 와 172.32 는 사설이 아니다. 경계를 헷갈리면 공개 주소가 샌다.
    expect(classifyAddress('172.15.0.1').ok).toBe(false);
    expect(classifyAddress('172.32.0.1').ok).toBe(false);
    expect(classifyAddress('100.63.0.1').ok).toBe(false);
    expect(classifyAddress('100.128.0.1').ok).toBe(false);
  });

  it('공개 IPv4 를 막는다', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '203.0.113.5']) {
      expect(classifyAddress(addr).ok, addr).toBe(false);
    }
  });

  it('IPv4-mapped IPv6 를 IPv4 규칙으로 판정한다', () => {
    expect(classifyAddress('::ffff:192.168.0.1').ok).toBe(true);
    expect(classifyAddress('::ffff:8.8.8.8').ok).toBe(false);
    // 매핑된 와일드카드도 모든 인터페이스다.
    expect(classifyAddress('::ffff:0.0.0.0').ok).toBe(false);
  });

  it('IPv6 사설·링크로컬을 통과시키고 공개는 막는다', () => {
    expect(classifyAddress('fd00::1').ok).toBe(true);
    expect(classifyAddress('fe80::1').ok).toBe(true);
    expect(classifyAddress('2001:4860:4860::8888').ok).toBe(false);
  });

  it('대괄호 표기를 벗겨서 판정한다', () => {
    expect(classifyAddress('[::1]').ok).toBe(true);
    expect(classifyAddress('[2001:db8::1]').ok).toBe(false);
  });

  it('호스트명은 해석 결과를 모르므로 막는다', () => {
    // localhost 도 hosts 파일에 따라 다른 곳을 가리킬 수 있다.
    expect(classifyAddress('localhost').ok).toBe(false);
    expect(classifyAddress('office.example.com').ok).toBe(false);
  });
});

describe('assertBindable', () => {
  it('통과하지 못하면 던진다 — 무시하고 진행할 반환값이 없다', () => {
    expect(() => assertBindable('0.0.0.0')).toThrow(PublicBindRefused);
    expect(() => assertBindable('8.8.8.8')).toThrow(PublicBindRefused);
  });

  it('통과하면 판정을 돌려준다', () => {
    expect(assertBindable('127.0.0.1').kind).toBe('loopback');
    expect(assertBindable('192.168.0.2').kind).toBe('private');
  });
});
