/**
 * 바인딩 규칙 — 공개 인터페이스 기동 거부 (R14.1, R14.2)
 *
 * 오피스 API 는 원장 전체와 승인 권한을 들고 있다. 이것이 공개 인터페이스에
 * 뜨는 순간 회사가 인터넷에 열린다. 그래서 **거부는 기본값이 아니라 유일한
 * 동작**이다 — 경고를 찍고 뜨는 경로를 만들지 않는다.
 *
 * 판정을 문자열 비교가 아니라 주소 파싱으로 하는 이유는, `0.0.0.0` 만 막고
 * 끝내면 `::` 도 `[::ffff:0.0.0.0]` 도 다 뚫리기 때문이다. 실제로 이 셋은
 * 모두 "모든 인터페이스" 를 뜻한다.
 *
 * 허용하는 것:
 *   loopback            127.0.0.0/8, ::1
 *   사설 대역           10/8, 172.16/12, 192.168/16, fc00::/7 (VPN 인터페이스)
 *   링크로컬            169.254/16, fe80::/10 (Tailscale·WireGuard 가 쓴다)
 *
 * CGNAT 대역(100.64/10)도 허용한다. Tailscale 이 기본으로 쓰는 대역이고,
 * 오너의 사설망 그 자체다.
 */

export type BindVerdict =
  | { ok: true; kind: 'loopback' | 'private'; address: string }
  | { ok: false; reason: string; address: string };

/** 모든 인터페이스를 뜻하는 표기들. 어느 것도 통과하지 않는다. */
const WILDCARDS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '*', '']);

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/**
 * IPv4 사설·loopback 판정.
 *
 * `::ffff:192.168.0.1` 같은 IPv4-mapped IPv6 를 먼저 벗겨낸다. 벗기지 않으면
 * IPv6 경로로 흘러가 사설 대역인데도 공개로 판정된다.
 */
export function classifyAddress(raw: string): BindVerdict {
  const address = raw.trim().replace(/^\[|\]$/g, '');
  const lower = address.toLowerCase();

  if (WILDCARDS.has(lower)) {
    return { ok: false, address, reason: '모든 인터페이스에 바인딩하려 했다' };
  }

  // IPv4-mapped IPv6 를 IPv4 로 되돌린다.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const target = mapped?.[1] ?? address;

  const v4 = parseIpv4(target);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return { ok: true, kind: 'loopback', address };
    if (a === 10) return { ok: true, kind: 'private', address };
    if (a === 172 && b >= 16 && b <= 31) return { ok: true, kind: 'private', address };
    if (a === 192 && b === 168) return { ok: true, kind: 'private', address };
    if (a === 169 && b === 254) return { ok: true, kind: 'private', address };
    // Tailscale 등이 쓰는 CGNAT 대역. 오너의 사설망이다.
    if (a === 100 && b >= 64 && b <= 127) return { ok: true, kind: 'private', address };
    return { ok: false, address, reason: `공개 IPv4 주소다 (${address})` };
  }

  if (lower === '::1') return { ok: true, kind: 'loopback', address };
  // fc00::/7 (unique local) 과 fe80::/10 (link local).
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return { ok: true, kind: 'private', address };
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return { ok: true, kind: 'private', address };
  if (lower.includes(':')) return { ok: false, address, reason: `공개 IPv6 주소다 (${address})` };

  // 호스트명은 해석 결과를 알 수 없다. 이름이 어디를 가리키는지 모르는 채로
  // 열지 않는다 — localhost 도 hosts 파일에 따라 다른 곳을 가리킬 수 있다.
  return { ok: false, address, reason: `IP 주소가 아니다 (${address}) — 해석 결과를 신뢰할 수 없다` };
}

export class PublicBindRefused extends Error {
  constructor(readonly verdict: BindVerdict & { ok: false }) {
    super(`오피스 API 기동 거부 — ${verdict.reason}`);
    this.name = 'PublicBindRefused';
  }
}

/** 통과하지 못하면 던진다. 호출자가 무시하고 진행할 수 있는 반환값을 주지 않는다. */
export function assertBindable(address: string): BindVerdict & { ok: true } {
  const verdict = classifyAddress(address);
  if (!verdict.ok) throw new PublicBindRefused(verdict);
  return verdict;
}
