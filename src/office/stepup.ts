/**
 * 단계별 인증 — Task 8.1 의 실제 구멍을 막는다 (R14.7)
 *
 * CLI 의 `--step-up` 은 자리표시자였다. 플래그를 붙이면 통과하는 것은 인증이
 * 아니라 인증의 모양이다. L3 비가역 작업이 그 위에 서 있었다.
 *
 * **사양과 다르게 구현한 부분이 있다.** tasks.md 는 "desktop 페어링 기기를
 * 두 번째 요소로 쓴다" 고 적었는데, desktop 의 `mobile-bridge` 를 실측해 보니
 * company 가 그것을 두 번째 요소로 쓸 방법이 없다 — `projector.ts` 가
 * desktop 내부 스토어(`../store/*`, `../confirm`, `../secrets/vault`)를 직접
 * import 해 자기 상태만 투영하고, 외부 시스템을 끼울 확장점이 없다.
 * desktop 을 고치지 않는 한 불가능하므로 TOTP(RFC 6238)로 닫았다.
 *
 * TOTP 를 고른 이유는 소유 요소(폰)를 검증하면서 company 밖에 의존하지 않기
 * 때문이다. 기본 검증기는 **전부 거부**한다 — 등록하지 않은 채로 L3 이
 * 통과하는 상태를 만들지 않는다.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceRecord } from './tokens.js';
import { ensurePrivateDir, writePrivateFile } from '../zones/private.js';

export type StepUpVerdict = { ok: true } | { ok: false; reason: string };

export interface StepUpVerifier {
  /**
   * 두 번째 요소를 검증한다.
   *
   * `context` 는 무엇에 대한 승인인지다. 검증기가 컨텍스트에 바인딩할 수
   * 있게 넘기지만, TOTP 는 코드가 시간에만 묶이므로 쓰지 않는다.
   */
  verify(device: DeviceRecord, proof: string, context: string): StepUpVerdict;
}

/**
 * 기본 검증기 — 전부 거부.
 *
 * 등록된 두 번째 요소가 없으면 L3 은 통과하지 못한다. 자리표시자가 통과
 * 시키던 자리를 거부가 대신한다.
 */
export class RefuseAllStepUp implements StepUpVerifier {
  verify(): StepUpVerdict {
    return { ok: false, reason: '단계별 인증 수단이 등록되지 않았다 (company office enroll)' };
  }
}

// ── TOTP (RFC 6238) ───────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/=+$/, '')) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 코드 생성. 30초 창, 6자리, HMAC-SHA1. */
export function totpCode(secret: Buffer, atMs: number, stepSec = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / stepSec);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

interface EnrollmentFile {
  secrets: Record<string, string>;
  /** 이미 쓴 (기기, 카운터) 쌍. 재사용을 막는다. */
  used: Record<string, number>;
}

export interface TotpStepUpOptions {
  file: string;
  now?: () => number;
  /** 앞뒤로 허용할 창 개수. 시계 오차를 흡수한다. */
  skew?: number;
}

export class TotpStepUp implements StepUpVerifier {
  private readonly file: string;
  private readonly now: () => number;
  private readonly skew: number;

  constructor(opts: TotpStepUpOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.skew = opts.skew ?? 1;
    ensurePrivateDir(dirname(this.file));
  }

  private load(): EnrollmentFile {
    if (!existsSync(this.file)) return { secrets: {}, used: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<EnrollmentFile>;
      return { secrets: parsed.secrets ?? {}, used: parsed.used ?? {} };
    } catch {
      // 읽을 수 없으면 등록이 없는 것으로 본다 — 열어 주지 않는 방향이다.
      return { secrets: {}, used: {} };
    }
  }

  private save(data: EnrollmentFile): void {
    writePrivateFile(this.file, JSON.stringify(data, null, 2));
  }

  /** 기기에 두 번째 요소를 등록한다. 반환한 secret 은 한 번만 보여준다. */
  enroll(deviceId: string): { secret: string; uri: string } {
    const data = this.load();
    const raw = randomBytes(20);
    const secret = base32Encode(raw);
    data.secrets[deviceId] = secret;
    this.save(data);
    const label = encodeURIComponent(`agentlas-company:${deviceId}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=agentlas-company` };
  }

  enrolled(deviceId: string): boolean {
    return typeof this.load().secrets[deviceId] === 'string';
  }

  /**
   * 코드를 검증한다.
   *
   * 같은 창의 코드를 두 번 쓰지 못한다. 어깨너머로 본 코드가 30초 안에
   * 재사용되는 것을 막는다 — 코드 하나는 승인 하나다.
   */
  verify(device: DeviceRecord, proof: string, _context: string): StepUpVerdict {
    const data = this.load();
    const secret = data.secrets[device.id];
    if (!secret) return { ok: false, reason: '이 기기에 단계별 인증이 등록되지 않았다' };
    if (!/^\d{6}$/.test(proof)) return { ok: false, reason: '6자리 코드가 아니다' };

    const raw = base32Decode(secret);
    const nowMs = this.now();
    for (let drift = -this.skew; drift <= this.skew; drift++) {
      const atMs = nowMs + drift * 30_000;
      const expected = totpCode(raw, atMs);
      const a = Buffer.from(expected);
      const b = Buffer.from(proof);
      if (a.length !== b.length || !timingSafeEqual(a, b)) continue;

      const counter = Math.floor(atMs / 1000 / 30);
      if (data.used[device.id] === counter) {
        return { ok: false, reason: '이미 사용한 코드다' };
      }
      data.used[device.id] = counter;
      this.save(data);
      return { ok: true };
    }
    return { ok: false, reason: '코드가 일치하지 않는다' };
  }
}
