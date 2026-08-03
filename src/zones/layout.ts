/**
 * 구역 레이아웃 — 정본 하나 (R15)
 *
 * 어떤 경로가 어느 구역 소유인지를 여기서 한 번 정한다. `icacls` 스크립트와
 * `company security verify` 가 **같은 표**를 읽는다.
 *
 * 정본을 하나로 두는 이유는 Task 10 에서 배웠다. 그때 Chrome 실행 파일 목록을
 * 런처와 company 가 각각 갖고 있었고 둘이 어긋나서, 실제로는 도는 기계에
 * "Chrome 없음" 을 보고할 수 있었다. 권한 표가 어긋나면 그보다 나쁘다 —
 * 스크립트는 열어 두고 검증기는 닫혔다고 보고하는 상태가 된다.
 *
 * 계정 셋의 역할은 설계 §구역과 프로세스 배치 그대로다.
 *   owner       사람. 승인과 스위치 변경. 2FA 시드는 여기에도 없다 (R15.7)
 *   svc-broker  Z1. 채널 토큰·브라우저 프로필·원장·능력 스위치
 *   svc-seats   Z2. 좌석 CLI. 자기 호스트 OAuth 디렉터리만
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ALL_SEATS } from '../seats/spec.js';

export const ZONE_ACCOUNTS = {
  owner: 'owner',
  broker: 'svc-broker',
  seats: 'svc-seats',
} as const;

export type ZoneAccount = keyof typeof ZONE_ACCOUNTS;

export type AccessMode = 'none' | 'read' | 'read-write';

export interface ZoneEntry {
  /** 사람이 읽는 이름. 보고서의 행 제목이다. */
  label: string;
  path: string;
  /** 없어도 되는 경로인가. 좌석 OAuth 디렉터리는 좌석을 안 쓰면 없다. */
  optional?: boolean;
  access: Record<ZoneAccount, AccessMode>;
}

/**
 * 좌석별 OAuth 디렉터리.
 *
 * **각 좌석은 자기 것만 읽는다 (R15.3).** 좌석끼리도 격리된다 — claude 좌석이
 * codex 의 토큰을 읽을 이유가 없고, 한 벤더가 뚫렸을 때 나머지를 함께 잃지
 * 않으려면 그 경계가 필요하다.
 *
 * 여기서는 좌석 사용자 전체(`svc-seats`)에 읽기를 주고, 좌석 간 격리는
 * `SeatProfile` 의 per-run 디렉터리가 담당한다. OS 계정을 좌석 수만큼
 * 만드는 것은 운영 부담이 크고, 실제 격리 효과는 프로필 분리로 대부분
 * 얻어진다 — 다만 그것은 **같은 계정 안의** 격리이므로 완전하지 않다.
 * 이 한계를 3.1 로 남긴다.
 */
export function seatOauthDirs(home = homedir()): ZoneEntry[] {
  return ALL_SEATS.filter((spec) => spec.configHomeEnv).map((spec) => ({
    label: `${spec.id} OAuth`,
    path: join(home, `.${spec.id}`),
    optional: true,
    access: { owner: 'read', broker: 'none', seats: 'read' } as Record<ZoneAccount, AccessMode>,
  }));
}

/** 브로커 자산. 좌석은 어느 것도 보지 못한다 (R15.2, R15.8). */
export function brokerAssets(stateRoot: string, home = homedir()): ZoneEntry[] {
  return [
    {
      label: '원장',
      path: join(stateRoot, 'events.jsonl'),
      access: { owner: 'read', broker: 'read-write', seats: 'none' },
    },
    {
      label: '능력 스위치',
      path: join(stateRoot, 'broker', 'capabilities.json'),
      access: { owner: 'read', broker: 'read-write', seats: 'none' },
    },
    {
      label: '승인 카드',
      path: join(stateRoot, 'broker', 'approvals.json'),
      access: { owner: 'read', broker: 'read-write', seats: 'none' },
    },
    {
      label: '오피스 기기 토큰',
      path: join(stateRoot, 'office', 'devices.json'),
      access: { owner: 'read', broker: 'read-write', seats: 'none' },
    },
    {
      label: '단계별 인증 시크릿',
      path: join(stateRoot, 'office', 'stepup.json'),
      // 오너도 읽을 이유가 없다. 등록 시 한 번 보고 인증 앱에 넣으면 끝이다.
      access: { owner: 'none', broker: 'read-write', seats: 'none' },
    },
    {
      label: '발행 멱등성 기록',
      path: join(stateRoot, 'publish', 'published.json'),
      access: { owner: 'read', broker: 'read-write', seats: 'none' },
    },
    {
      label: '브라우저 프로필',
      path: join(home, '.agentlas', 'chrome-cdp-profile'),
      optional: true,
      access: { owner: 'none', broker: 'read-write', seats: 'none' },
    },
  ];
}

export function zoneLayout(stateRoot: string, home = homedir()): ZoneEntry[] {
  return [...brokerAssets(stateRoot, home), ...seatOauthDirs(home)];
}

/**
 * 이 기계에 있어서는 안 되는 것 (R15.7).
 *
 * 2FA 시드와 복구코드는 Z0 — 사람 — 의 것이다. 기계에 두면 미니PC 한 대가
 * 뚫렸을 때 모든 계정을 동시에 잃는다. 그것이 R15 의 사용자 스토리 자체다.
 */
export const FORBIDDEN_PATTERNS = [
  /(?:^|[/\\])(?:recovery[-_]?codes?|backup[-_]?codes?)\.(?:txt|json|md|csv)$/i,
  /(?:^|[/\\])(?:2fa|mfa|totp)[-_]?(?:seed|secret)s?\.(?:txt|json|md)$/i,
  /(?:^|[/\\])authenticator[-_]?backup/i,
];
