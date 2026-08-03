/**
 * 기기 토큰 (R14.3, R14.4)
 *
 * 토큰 원본은 저장하지 않는다. SHA-256 해시만 남기고, 원본은 발급 시 한 번
 * 보여주고 잊는다. 저장소가 유출돼도 그 자체로는 접속권이 되지 않는다.
 *
 * 폐기는 **즉시** 여야 한다 (R14.4). 그래서 만료 시각을 두고 기다리는 대신
 * 상태를 `revoked` 로 바꾸고, 매 요청마다 파일을 다시 읽는다. 캐시를 두면
 * "폐기했는데 아직 되네" 가 생긴다 — 폐기는 그런 종류의 기능이 아니다.
 *
 * 비교는 `timingSafeEqual` 로 한다. 해시 비교라 실익이 크지 않지만, 토큰
 * 검증에서 조기 반환하는 습관을 코드에 남기지 않는다.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Ledger } from '../ledger/ledger.js';
import { ensurePrivateDir, writePrivateFile } from '../zones/private.js';

export type DeviceKind = 'desktop' | 'mobile';

export interface DeviceRecord {
  id: string;
  label: string;
  kind: DeviceKind;
  tokenHash: string;
  issuedAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface IssuedDevice {
  record: DeviceRecord;
  /** 발급 시 한 번만 존재한다. 저장되지 않는다. */
  token: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(`agentlas:office-token:v1\0${token}`).digest('hex');
}

export interface DeviceStoreOptions {
  file: string;
  ledger: Ledger;
  now?: () => number;
}

export class DeviceStore {
  private readonly file: string;
  private readonly ledger: Ledger;
  private readonly now: () => number;

  constructor(opts: DeviceStoreOptions) {
    this.file = opts.file;
    this.ledger = opts.ledger;
    this.now = opts.now ?? Date.now;
    ensurePrivateDir(dirname(this.file));
  }

  /**
   * 저장소를 읽는다.
   *
   * 손상된 파일은 "기기 없음" 으로 해석한다. 능력 스위치가 손상 시 OFF 로
   * 해석하는 것과 같은 방향이다 — 읽을 수 없는 상태에서 열어 주지 않는다.
   */
  private load(): DeviceRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: unknown };
      return Array.isArray(parsed.devices) ? (parsed.devices as DeviceRecord[]) : [];
    } catch {
      this.ledger.append({
        actor: { kind: 'system', id: 'office' },
        kind: 'deny',
        summary: '기기 저장소가 손상되어 기기 없음으로 해석한다',
      });
      return [];
    }
  }

  private save(devices: DeviceRecord[]): void {
    writePrivateFile(this.file, JSON.stringify({ devices }, null, 2));
  }

  list(): DeviceRecord[] {
    return this.load();
  }

  issue(label: string, kind: DeviceKind): IssuedDevice {
    const token = randomBytes(32).toString('base64url');
    const record: DeviceRecord = {
      id: randomBytes(8).toString('hex'),
      label,
      kind,
      tokenHash: hashToken(token),
      issuedAt: new Date(this.now()).toISOString(),
      revokedAt: null,
      lastSeenAt: null,
    };
    const devices = this.load();
    devices.push(record);
    this.save(devices);
    this.ledger.append({
      actor: { kind: 'owner', id: 'owner' },
      kind: 'device.change',
      summary: `기기 등록 — ${label} (${kind}, ${record.id})`,
    });
    return { record, token };
  }

  /** 폐기. 존재하지 않는 기기를 폐기하려 하면 거짓을 돌려준다. */
  revoke(id: string): boolean {
    const devices = this.load();
    const found = devices.find((d) => d.id === id);
    if (!found || found.revokedAt !== null) return false;
    found.revokedAt = new Date(this.now()).toISOString();
    this.save(devices);
    this.ledger.append({
      actor: { kind: 'owner', id: 'owner' },
      kind: 'device.change',
      summary: `기기 폐기 — ${found.label} (${found.id})`,
    });
    return true;
  }

  /**
   * 토큰을 검증한다.
   *
   * 매 호출마다 파일을 다시 읽는다. 폐기가 즉시 반영되어야 하기 때문이다.
   */
  verify(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const wanted = Buffer.from(hashToken(token), 'hex');
    let matched: DeviceRecord | null = null;
    for (const device of this.load()) {
      const stored = Buffer.from(device.tokenHash, 'hex');
      if (stored.length !== wanted.length) continue;
      if (!timingSafeEqual(stored, wanted)) continue;
      // 폐기된 기기는 일치해도 통과시키지 않는다.
      matched = device.revokedAt === null ? device : null;
    }
    return matched;
  }

  /** 마지막 접속 시각 기록. 실패해도 요청을 막지 않는다. */
  touch(id: string): void {
    const devices = this.load();
    const found = devices.find((d) => d.id === id);
    if (!found) return;
    found.lastSeenAt = new Date(this.now()).toISOString();
    this.save(devices);
  }
}
