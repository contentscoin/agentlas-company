import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokerAssets, seatOauthDirs, zoneLayout, ZONE_ACCOUNTS } from './layout.js';
import { checkPosix, parseIcacls, scanForbidden, verifyZones } from './verify.js';
import { writePrivateFile } from './private.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-zones-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('checkPosix', () => {
  it('소유자 전용이면 닫힘', () => {
    const file = join(dir, 'a.json');
    writePrivateFile(file, '{}');
    expect(checkPosix(file).verdict).toBe('ok');
  });

  it('그룹·기타 비트가 서 있으면 열림', () => {
    const file = join(dir, 'b.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    expect(checkPosix(file).verdict).toBe('violation');
  });

  it('그룹 읽기만 있어도 열림이다 — 좌석이 그룹에 있으면 읽힌다', () => {
    const file = join(dir, 'c.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o640);
    expect(checkPosix(file).verdict).toBe('violation');
  });

  it('없는 파일은 확인 불가다 — 통과가 아니다', () => {
    expect(checkPosix(join(dir, 'missing')).verdict).toBe('unknown');
  });
});

describe('parseIcacls', () => {
  it('좌석 계정에 권한이 있으면 위반', () => {
    const out = 'C:\\x\\ledger.jsonl NT AUTHORITY\\SYSTEM:(F)\n  DESKTOP\\svc-seats:(R)';
    expect(parseIcacls(out, 'svc-seats').verdict).toBe('violation');
  });

  it('좌석 계정이 명시적으로 거부되어 있으면 닫힘', () => {
    const out = 'C:\\x\\ledger.jsonl DESKTOP\\svc-broker:(M)\n  DESKTOP\\svc-seats:(DENY)(F)';
    expect(parseIcacls(out, 'svc-seats').verdict).toBe('ok');
  });

  it('Everyone·Users 같은 광범위한 권한을 위반으로 본다', () => {
    // 상속으로 들어온 그룹 권한이 좌석에게 문을 열어 준다.
    for (const broad of ['BUILTIN\\Users:(RX)', 'Everyone:(R)']) {
      const out = `C:\\x\\a.json DESKTOP\\svc-broker:(M)\n  ${broad}`;
      expect(parseIcacls(out, 'svc-seats').verdict, broad).toBe('violation');
    }
  });

  it('출력이 비면 확인 불가다', () => {
    expect(parseIcacls('', 'svc-seats').verdict).toBe('unknown');
  });

  it('좌석 계정이 아예 없으면 닫힘', () => {
    const out = 'C:\\x\\a.json DESKTOP\\svc-broker:(M)\n  NT AUTHORITY\\SYSTEM:(F)';
    expect(parseIcacls(out, 'svc-seats').verdict).toBe('ok');
  });
});

describe('verifyZones', () => {
  it('열려 있는 자산을 잡는다', () => {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    const report = verifyZones({
      entries: [
        {
          label: '원장',
          path: file,
          access: { owner: 'read', broker: 'read-write', seats: 'none' },
        },
      ],
      platform: 'linux',
    });
    expect(report.ok).toBe(false);
    expect(report.counts.violation).toBe(1);
  });

  it('닫혀 있으면 통과한다', () => {
    const file = join(dir, 'events.jsonl');
    writePrivateFile(file, '');
    const report = verifyZones({
      entries: [
        { label: '원장', path: file, access: { owner: 'read', broker: 'read-write', seats: 'none' } },
      ],
      platform: 'linux',
    });
    expect(report.ok).toBe(true);
  });

  it('아무도 거부되지 않는 자산은 검사 대상이 아니다', () => {
    const report = verifyZones({
      entries: [
        {
          label: '공개',
          path: join(dir, 'x'),
          access: { owner: 'read', broker: 'read', seats: 'read' },
        },
      ],
      platform: 'linux',
    });
    expect(report.rows).toHaveLength(0);
  });

  it('없는 파일은 위반이 아니지만 통과로도 세지 않는다', () => {
    const report = verifyZones({
      entries: [
        {
          label: '아직',
          path: join(dir, 'nope.json'),
          access: { owner: 'read', broker: 'read-write', seats: 'none' },
        },
      ],
      platform: 'linux',
    });
    expect(report.counts.absent).toBe(1);
    expect(report.counts.ok).toBe(0);
    expect(report.ok).toBe(true);
  });
});

describe('scanForbidden — 2FA 시드는 이 기계에 없다 (R15.7)', () => {
  it('복구코드·시드 파일 이름을 잡는다', () => {
    const hits = scanForbidden([
      '/home/owner/recovery-codes.txt',
      '/home/owner/backup_codes.json',
      '/home/owner/2fa-seed.txt',
      '/home/owner/totp_secrets.json',
      '/home/owner/authenticator-backup-2026.csv',
    ]);
    expect(hits).toHaveLength(5);
  });

  it('평범한 파일은 잡지 않는다', () => {
    expect(scanForbidden(['/home/owner/notes.txt', '/home/owner/codes.js'])).toHaveLength(0);
  });
});

describe('layout — 정본 하나 (R15)', () => {
  it('브로커 자산은 전부 좌석에게 닫혀 있다', () => {
    for (const entry of brokerAssets('/state', '/home/o')) {
      expect(entry.access.seats, entry.label).toBe('none');
    }
  });

  it('단계별 인증 시크릿은 오너에게도 닫혀 있다', () => {
    const stepup = brokerAssets('/state', '/home/o').find((e) => e.label.includes('단계별'));
    expect(stepup?.access.owner).toBe('none');
  });

  it('좌석 OAuth 디렉터리는 브로커에게 닫혀 있다', () => {
    for (const entry of seatOauthDirs('/home/o')) {
      expect(entry.access.broker, entry.label).toBe('none');
      expect(entry.access.seats, entry.label).toBe('read');
    }
  });

  it('레이아웃이 두 묶음을 모두 담는다', () => {
    const all = zoneLayout('/state', '/home/o');
    expect(all.length).toBe(
      brokerAssets('/state', '/home/o').length + seatOauthDirs('/home/o').length,
    );
  });

  it('계정 셋이 정의되어 있다 (R15.1)', () => {
    expect(Object.keys(ZONE_ACCOUNTS).sort()).toEqual(['broker', 'owner', 'seats']);
    expect(ZONE_ACCOUNTS.broker).not.toBe(ZONE_ACCOUNTS.seats);
  });
});
