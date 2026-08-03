/**
 * 사용자 전용 쓰기 (R15.4, R15.8)
 *
 * 브로커 자산은 만들어지는 순간부터 소유자 전용이어야 한다. `icacls`
 * 스크립트나 `chmod` 를 나중에 돌려서 조이는 것에 의존하면, **스크립트를
 * 돌리기 전까지의 창**이 열려 있다. 그 창은 첫 실행 직후이고, 하필 그때
 * 원장과 토큰이 처음 생긴다.
 *
 * Task 3 실측에서 실제로 이 상태를 발견했다 — `company security verify` 가
 * 원장과 기기 토큰을 `mode 644 — 소유자 외 접근 가능` 으로 보고했다.
 * 검증기를 먼저 만들었기 때문에 잡힌 것이다.
 *
 * Windows 에는 POSIX 모드가 없다. `chmod` 호출이 무해하게 무시되므로 그냥
 * 부르되, 실제 권한은 `setup-zones.ps1` 의 ACL 이 담당한다. 즉 두 플랫폼
 * 모두에서 "만들 때 좁게" 가 성립하지만 수단이 다르다.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 소유자만 읽고 쓴다. */
export const PRIVATE_FILE_MODE = 0o600;
/** 소유자만 들어간다. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * 디렉터리를 만든다. 이미 있으면 권한만 조인다.
 *
 * 이미 있는 디렉터리도 조이는 이유는, 이전 버전이 느슨하게 만들어 둔 것을
 * 그대로 두면 고쳐지지 않기 때문이다.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Windows 는 POSIX 모드가 없다. ACL 이 담당한다.
  }
}

/**
 * 파일을 소유자 전용으로 쓴다.
 *
 * `writeFileSync` 의 `mode` 는 **새로 만들 때만** 적용된다. 이미 있는 파일은
 * 기존 권한을 유지하므로, 느슨하게 만들어진 파일이 영원히 느슨하게 남는다.
 * 그래서 쓰고 나서 한 번 더 조인다.
 */
export function writePrivateFile(file: string, data: string | Buffer): void {
  ensurePrivateDir(dirname(file));
  writeFileSync(file, data, { mode: PRIVATE_FILE_MODE });
  try {
    chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // 위와 같다.
  }
}

/** 이미 있는 파일의 권한만 조인다. append 로 쓰는 원장에 쓴다. */
export function tightenFile(file: string): void {
  try {
    chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // 파일이 없거나 Windows 다. 둘 다 여기서 할 일이 없다.
  }
}
