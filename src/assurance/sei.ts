/**
 * SEI 연동 (R11.3, R16.4)
 *
 * **design.md 의 전제를 실물로 확인하고 정정한다 (2026-08-03).**
 * 설계 문서는 `sei` 가 "`--json` 출력과 균일한 종료 코드(0 성공 / 1 발견 /
 * 2 실행 불가)" 를 출하한다고 적었다. `contentscoin/agentlas-sei` v0.3.0 을
 * 붙여 실제로 돌려 보니 **그런 계약이 아니다.**
 *
 *   0  성공 — `inspect` 는 **high 심각도 발견이 있어도 0 이다**
 *   2  실행 불가 (SEIError/OSError) 또는 `validate` 상태 무효
 *   3  `self-audit` 미통과
 *   4  `gate`/`review` 미허가
 *
 * **`1` 은 없다.** 즉 종료 코드로 "발견 있음" 을 읽으면 SEI 가 high 심각도
 * 발견을 낸 상황을 "통과" 로 보고하게 된다. 그래서 이 어댑터는 **위험 신호를
 * 항상 JSON 본문에서 읽는다.** 종료 코드는 "돌았는가" 만 판정한다.
 *
 * 그리고 설계가 기대한 균일 계약은 우리가 **제공한다** — `company sei` 가
 * 0/1/2 로 나가므로 레시피 `gate` 스텝이 그대로 쓸 수 있다.
 *
 * **검사 대상은 코드 프로젝트다.** SEI 는 "local-first assurance agent for
 * existing software projects" 이고 모든 하위 명령이 프로젝트 디렉터리를
 * 받는다. 게시물 본문을 넣고 검사시킬 수 있는 명령이 없다 — 그래서
 * `company assure <본문>` 은 SEI 를 못 돌리는 것이 아니라 **대상이 아니다**.
 * 이 구분을 흐리면 "sei 를 설치하면 본문 검증이 강해진다" 는 잘못된 기대를
 * 남긴다.
 *
 * **발견은 후보다.** SEI 자신이 각 발견에 `limitations` 로 "A deterministic
 * candidate is not a confirmed defect" 를 달아 보낸다. 우리 `checks.ts` 의
 * 모순 후보 처리와 같은 규율이라 그대로 존중한다 — 후보를 확정으로 승격시키지
 * 않는다.
 */

import { runCmd } from '../proc/index.js';

/** 확인된 심각도 어휘 (`assurance.py` 의 severity_order). */
export type SeiSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 위험으로 볼 심각도. 후보라도 이 둘은 사람이 봐야 한다. */
const RISK_SEVERITIES: readonly string[] = ['critical', 'high'];

/** `sei.finding.v1` 중 우리가 쓰는 필드만. */
export interface SeiFinding {
  findingId: string;
  ruleId: string;
  title: string;
  severity: string;
  /** `candidate` 등. 확정 결함이 아니다. */
  state: string;
  nextAction?: string;
}

export type SeiUnavailable =
  | 'not-installed'
  | 'not-attached'
  | 'failed'
  | 'bad-output'
  | 'timeout';

/**
 * SEI 신호.
 *
 * **못 돌린 쪽에 `risk` 필드가 아예 없다.** 헬퍼로 걸러 내는 대신 타입으로
 * 막는다 — `risk: false` 를 쓸 수 있게 두면 언젠가 누가 쓴다. 확인하지 못한
 * 것을 통과로 보고할 방법이 없어야 한다.
 */
export type SeiSignal =
  | {
      ran: true;
      /** 위험 신호. **종료 코드가 아니라 JSON 본문에서 읽는다.** */
      risk: boolean;
      findings: SeiFinding[];
      detail: string;
      toolVersion?: string;
    }
  | {
      ran: false;
      reason: SeiUnavailable;
      detail: string;
      /** 사람이 이어받을 목록. 없는 것을 통과로 만들지 않는다 (R7.5 와 같은 규율). */
      checklist: string[];
    };

export interface SeiOptions {
  /** 검사 대상 프로젝트 디렉터리. SEI 의 모든 하위 명령이 이것을 받는다. */
  project: string;
  /** 실행 파일. 기본은 `AGENTLAS_SEI_BIN` 또는 PATH 의 `sei`. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 테스트가 실제 프로세스 없이 계약을 시험할 수 있게 열어 둔다. */
  run?: typeof runCmd;
}

export const SEI_BIN_ENV = 'AGENTLAS_SEI_BIN';

export function seiBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SEI_BIN_ENV];
  return override && override.trim() !== '' ? override : 'sei';
}

/**
 * 발견 목록에서 위험을 판정한다.
 *
 * critical·high 가 하나라도 있으면 위험이다. **`state` 로 거르지 않는다** —
 * SEI 의 발견은 전부 `candidate` 로 나오고, 후보라고 무시하면 위험 신호가
 * 영영 켜지지 않는다. 후보라는 사실은 보고 문구에 남긴다.
 */
export function riskFrom(findings: readonly SeiFinding[]): boolean {
  return findings.some((f) => RISK_SEVERITIES.includes(f.severity));
}

/** `sei.finding.v1` 배열을 우리 모양으로 좁힌다. 모르는 필드는 버린다. */
export function parseFindings(raw: unknown): SeiFinding[] {
  const list = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) return [];
  const out: SeiFinding[] = [];
  for (const item of list) {
    const f = item as Record<string, unknown>;
    if (typeof f['findingId'] !== 'string' || typeof f['severity'] !== 'string') continue;
    out.push({
      findingId: f['findingId'],
      ruleId: typeof f['ruleId'] === 'string' ? f['ruleId'] : '',
      title: typeof f['title'] === 'string' ? f['title'] : '',
      severity: f['severity'],
      state: typeof f['state'] === 'string' ? f['state'] : 'unknown',
      ...(typeof f['nextAction'] === 'string' ? { nextAction: f['nextAction'] } : {}),
    });
  }
  return out;
}

/** 사람이 읽는 한 줄. */
export function describeFinding(f: SeiFinding): string {
  return `[${f.severity.toUpperCase()}] ${f.title} (${f.ruleId}, ${f.state})`;
}

/**
 * SEI 를 돌려 위험 신호를 읽는다.
 *
 * `inspect --json --no-report` 를 쓴다. 보고서 파일을 쓰지 않는 이유는 우리가
 * 원장을 진실원천으로 쓰기 때문이고, 프로젝트 디렉터리에 부산물을 남기지
 * 않기 위해서다.
 *
 * **하위 명령을 반드시 명시한다.** `sei <경로>` 는 `normalize_argv` 가
 * `run <경로>` 로 바꾸고, 그것은 대화형 인터뷰와 대시보드 서버를 띄운다 —
 * 무인 운영에서 그대로 멈춘다.
 */
export async function runSei(opts: SeiOptions): Promise<SeiSignal> {
  const bin = opts.bin ?? seiBin(opts.env);
  const exec = opts.run ?? runCmd;

  const r = await exec(bin, ['inspect', opts.project, '--json', '--no-report'], {
    timeoutMs: opts.timeoutMs ?? 180_000,
  });

  if (r.timedOut) {
    return {
      ran: false,
      reason: 'timeout',
      detail: `sei inspect 가 ${opts.timeoutMs ?? 180_000}ms 안에 끝나지 않았다`,
      checklist: [`sei inspect ${opts.project} 를 직접 돌려 보세요`],
    };
  }

  // 127(POSIX 셸) 과 9009(Windows) 는 "명령을 못 찾았다" 다. 이것을 일반
  // 실패로 뭉뚱그리면 "종료 코드 127" 이라는 쓸모없는 안내가 나간다 —
  // 실제로 나갔다. 설치 문제는 설치 문제라고 말한다.
  if (r.code === null || r.code === 127 || r.code === 9009) {
    return {
      ran: false,
      reason: 'not-installed',
      detail: `${bin} 를 실행하지 못했다`,
      checklist: [
        `${bin} 가 설치되어 있는지 확인하세요 (agentlas-sei)`,
        `다른 경로면 ${SEI_BIN_ENV} 로 지정하세요`,
      ],
    };
  }

  // 2 는 실행 불가와 "프로젝트가 attach 되지 않음" 양쪽이다. 구분은
  // stderr 문구로만 가능하다 — SEI 가 종료 코드로 나누지 않는다.
  if (r.code === 2) {
    const notAttached = /not attached|sei init/i.test(r.stderr);
    return {
      ran: false,
      reason: notAttached ? 'not-attached' : 'failed',
      detail: r.stderr.trim() || 'sei 가 종료 코드 2 로 끝났다',
      checklist: notAttached
        ? [`sei init ${opts.project} 를 먼저 실행하세요`]
        : [`sei inspect ${opts.project} 를 직접 돌려 원인을 확인하세요`],
    };
  }

  if (r.code !== 0) {
    return {
      ran: false,
      reason: 'failed',
      detail: `sei 가 예상하지 못한 종료 코드 ${r.code} 로 끝났다`,
      checklist: [`sei inspect ${opts.project} 를 직접 돌려 원인을 확인하세요`],
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(r.stdout) as unknown;
  } catch {
    // 돌긴 했는데 읽지 못했다. 통과로 보고하지 않는다.
    return {
      ran: false,
      reason: 'bad-output',
      detail: 'sei 가 JSON 을 내지 않았다',
      checklist: [`sei inspect ${opts.project} --json 출력 형식을 확인하세요`],
    };
  }

  const findings = parseFindings(body);
  const risk = riskFrom(findings);
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return {
    ran: true,
    risk,
    findings,
    detail:
      findings.length === 0
        ? '발견 없음'
        : `발견 ${findings.length}건 (` +
          Object.entries(counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ') +
          ') — 전부 후보이며 확정 결함이 아니다',
    ...(typeof (body as { toolVersion?: unknown }).toolVersion === 'string'
      ? { toolVersion: (body as { toolVersion: string }).toolVersion }
      : {}),
  };
}

/**
 * 본문 검증에 SEI 를 붙일 수 없는 이유.
 *
 * "설치되지 않았다" 로 적으면 설치하면 된다는 잘못된 기대를 남긴다. SEI 의
 * 검사 대상은 코드 프로젝트이고 본문을 받는 명령이 없다.
 */
export const SEI_NOT_FOR_TEXT =
  'SEI 의 검사 대상은 코드 프로젝트다 — 게시물 본문을 받는 명령이 없다. ' +
  '프로젝트 위험 신호는 company sei 로 따로 봅니다';
