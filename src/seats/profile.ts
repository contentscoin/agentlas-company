/**
 * 좌석 프로필 격리
 *
 * 좌석이 오너의 개인 개발 환경을 상속하면 두 가지가 깨진다.
 *
 * 1. 재현성. 실측에서 확인했다 — 개인 `config.toml` 이 좌석의 모델과
 *    추론 강도를 바꿨다 (gpt-5.5/xhigh → gpt-5.6-sol/none). 오너가 자기
 *    에디터 설정을 만지면 회사 임원의 두뇌가 조용히 교체된다.
 *
 * 2. 컨텍스트 위생. 개인 스킬·MCP 서버가 좌석 프롬프트에 실린다.
 *    실측 절감폭은 21,068 → 19,357 토큰으로 8% 수준이라 쿼터 측면에서는
 *    작지만, 실패 노이즈(연결 실패, 인증 요구 프롬프트)를 없애는 값이 크다.
 *
 * 격리 방식은 설정 홈을 임시 디렉터리로 돌리고 **인증 파일만** 복사하는 것이다.
 * codex 의 `--ignore-user-config` 도움말이 "auth still uses CODEX_HOME" 이라고
 * 명시하므로, 인증 파일만 있으면 OAuth 세션이 유지된다. 실측으로 확인했다.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeatSpec } from './spec.js';
import { stripOverrides } from './strip-env.js';

export interface SeatProfile {
  /** 격리 설정 홈. 격리 수단이 없는 좌석은 null. */
  configHome: string | null;
  /** 좌석 프로세스가 쓸 수 있는 유일한 경로 (R2.5). */
  workDir: string;
  /** 좌석 스폰에 넘길 환경 오버라이드. undefined 값은 변수 삭제를 뜻한다. */
  env: Record<string, string | undefined>;
  /** 격리를 실제로 적용했는가. false 면 개인 환경을 상속한다. */
  isolated: boolean;
  /** 정리. */
  dispose: () => void;
}

/** 좌석의 기본 설정 홈 후보. `~/.codex` 처럼 홈 아래 점 디렉터리를 찾는다. */
function defaultConfigDir(spec: SeatSpec): string | null {
  const guesses = [join(homedir(), `.${spec.id}`), join(homedir(), `.${spec.bin}`)];
  return guesses.find((p) => existsSync(p)) ?? null;
}

/**
 * 좌석 실행용 격리 프로필을 만든다.
 *
 * 인증 파일을 복사하지 못하면 격리를 포기하고 `isolated: false` 로 알린다.
 * 격리를 시도했다고 거짓 보고하지 않는다 — 조용한 성공은 만들지 않는다.
 */
export function createProfile(spec: SeatSpec): SeatProfile {
  const root = mkdtempSync(join(tmpdir(), `agentlas-seat-${spec.id}-`));
  const workDir = join(root, 'work');
  mkdirSync(workDir, { recursive: true });

  const env: Record<string, string | undefined> = { ...stripOverrides() };
  let configHome: string | null = null;
  let isolated = false;

  if (spec.configHomeEnv && spec.authFiles.length > 0) {
    const source = defaultConfigDir(spec);
    if (source) {
      const home = join(root, 'config');
      mkdirSync(home, { recursive: true });

      // 인증 파일만 가져온다. 스킬·플러그인·설정은 남겨둔다.
      const present = new Set(readdirSync(source));
      const copied = spec.authFiles.filter((name) => present.has(name));
      for (const name of copied) copyFileSync(join(source, name), join(home, name));

      if (copied.length === spec.authFiles.length) {
        configHome = home;
        env[spec.configHomeEnv] = home;
        isolated = true;
      }
    }
  }

  return {
    configHome,
    workDir,
    env,
    isolated,
    dispose: () => disposeQuietly(root),
  };
}

/**
 * 정리에 실패한 프로필 경로. 진단 명령이 읽는다.
 *
 * 조용히 흘리지 않으려고 목록으로 남긴다. 다만 정리 실패로 예외를 던지지는
 * 않는다 — 실제로 겪은 일이 근거다. claude 좌석이 답을 정상적으로 돌려준 뒤
 * 임시 디렉터리 삭제가 EPERM 으로 실패했고, `finally` 의 그 예외가 성공한
 * 호출을 "실행 불가" 로 뒤집었다. 성공을 실패로 바꾸는 정리는 정리가 아니다.
 */
export const leakedProfiles: string[] = [];

function disposeQuietly(root: string): void {
  // 좌석 프로세스가 작업 디렉터리 핸들을 늦게 놓는 경우가 있어 짧게 재시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 2) sleepBriefly(60);
    }
  }
  leakedProfiles.push(root);
}

function sleepBriefly(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 동기 대기 — dispose 는 동기 API 다 */
  }
}
