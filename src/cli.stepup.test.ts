import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseStepUpDevice, readStepUpCode } from './cli.js';
import { TotpStepUp, totpCode, base32Decode } from './office/stepup.js';
import type { DeviceRecord } from './office/tokens.js';

/**
 * CLI 의 `--step-up` 은 값 없는 플래그였다. 타이핑하는 것이 곧 인증이라
 * 두 번째 요소가 아니었다 — 오피스 API 는 TOTP 로 닫혔는데 CLI 는 그대로여서
 * 같은 구멍이 좁아진 채로 남아 있었다.
 */
describe('--step-up 은 코드를 요구한다 (R8, R15.8)', () => {
  it('플래그가 없으면 요청하지 않은 것이다', () => {
    expect(readStepUpCode(['caps', 'on', 'dm_send'])).toEqual({ requested: false, code: null });
  });

  it('값 없는 플래그는 코드 없음이다 — 통과가 아니다', () => {
    expect(readStepUpCode(['caps', 'on', 'dm_send', '--step-up'])).toEqual({
      requested: true,
      code: null,
    });
  });

  it('뒤에 다른 플래그가 오면 그것을 코드로 삼지 않는다', () => {
    expect(readStepUpCode(['approve', '--step-up', '--device', 'phone'])).toEqual({
      requested: true,
      code: null,
    });
  });

  it('코드가 있으면 그대로 읽는다', () => {
    expect(readStepUpCode(['approve', '--step-up', '123456'])).toEqual({
      requested: true,
      code: '123456',
    });
  });
});

describe('어느 기기의 코드인지 정한다', () => {
  it('하나만 등록됐으면 그것을 쓴다', () => {
    expect(chooseStepUpDevice(undefined, ['a'])).toEqual({ ok: true, device: 'a' });
  });

  it('명시하면 그것을 쓴다', () => {
    expect(chooseStepUpDevice('b', ['a', 'b'])).toEqual({ ok: true, device: 'b' });
  });

  /**
   * 아무거나 고르면 실패 이유가 "코드가 틀렸다" 로 나와 오너가 원인을 못 찾는다.
   */
  it('둘 이상이면 고르지 않고 물어본다', () => {
    const r = chooseStepUpDevice(undefined, ['a', 'b']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.checklist.join()).toContain('--device');
  });

  it('등록이 없으면 등록부터 안내한다', () => {
    const r = chooseStepUpDevice(undefined, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.checklist.join()).toContain('office enroll');
  });
});

describe('등록된 기기 목록', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentlas-cli-su-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const device = (id: string): DeviceRecord => ({
    id,
    label: id,
    kind: 'mobile',
    tokenHash: 'x',
    issuedAt: '2026-08-03T00:00:00.000Z',
    revokedAt: null,
    lastSeenAt: null,
  });

  it('등록한 기기만 나온다', () => {
    const totp = new TotpStepUp({ file: join(dir, 'stepup.json') });
    expect(totp.enrolledIds()).toEqual([]);
    totp.enroll('phone-1');
    totp.enroll('phone-2');
    expect(totp.enrolledIds().sort()).toEqual(['phone-1', 'phone-2']);
  });

  it('CLI 에서 쓴 코드는 다시 못 쓴다 — 코드 하나는 승인 하나다', () => {
    const totp = new TotpStepUp({ file: join(dir, 'stepup.json') });
    const { secret } = totp.enroll('phone-1');
    const code = totpCode(base32Decode(secret), Date.now());
    expect(totp.verify(device('phone-1'), code, 'cli').ok).toBe(true);
    const again = totp.verify(device('phone-1'), code, 'cli');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('이미 사용한');
  });
});
