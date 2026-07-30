/**
 * 런타임 상태 경로
 *
 * 원장과 운영 상태는 저장소 안에 두지 않는다.
 * public 저장소이고, `.gitignore` 에 의존하는 것보다 애초에 밖에 두는 것이 안전하다.
 *
 * 능력 스위치 저장소(R15.8)는 나중에 브로커 구역 사용자만 접근 가능한
 * 경로로 분리된다. 지금은 상태 루트만 정의한다.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 상태 루트. 환경변수로 덮어쓸 수 있어야 테스트와 격리가 가능하다. */
export function resolveState(): string {
  const override = process.env.AGENTLAS_COMPANY_STATE;
  if (override && override.trim() !== '') return override;
  return join(homedir(), '.agentlas-company');
}

export function ledgerFile(): string {
  return join(resolveState(), 'events.jsonl');
}
