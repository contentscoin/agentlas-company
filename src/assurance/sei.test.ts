import { describe, expect, it } from 'vitest';
import type { RunResult } from '../proc/index.js';
import {
  SEI_NOT_FOR_TEXT,
  parseFindings,
  riskFrom,
  runSei,
  seiBin,
} from './sei.js';

/**
 * 실제 `sei inspect --json --no-report` 출력에서 가져온 조각이다
 * (agentlas-sei v0.3.0, 2026-08-03 실행).
 */
const REAL_INSPECT = JSON.stringify({
  clearedFindings: [],
  findings: [
    {
      createdAt: '2026-08-03T01:58:52.717218Z',
      evidenceRefs: [],
      findingId: 'finding:9de8c3927735cc8bd83c',
      limitations: [
        'A deterministic candidate is not a confirmed defect.',
        'Closure requires an oracle and post-change outcome evidence.',
      ],
      nextAction: 'Run `sei interview` and have an accountable owner accept the intent.',
      observation: 'No interview record exists, so success and prohibited states are unknown.',
      ruleId: 'rule:missing-intent-interview',
      schemaVersion: 'sei.finding.v1',
      severity: 'high',
      state: 'candidate',
      title: 'Product intent has not been interviewed',
      verdict: 'unknown',
    },
  ],
  toolVersion: '0.3.0',
});

function fakeRun(over: Partial<RunResult>): typeof import('../proc/index.js').runCmd {
  return (async () =>
    ({ code: 0, stdout: '', stderr: '', timedOut: false, ms: 1, ...over }) as RunResult) as never;
}

describe('종료 코드로 위험을 읽지 않는다', () => {
  /**
   * design.md 는 `sei` 가 "0 성공 / 1 발견 / 2 실행 불가" 를 낸다고 적었다.
   * 실물은 그렇지 않다 — `inspect` 는 **high 발견 4건에도 0** 으로 끝난다.
   * 실제로 확인했다. 종료 코드로 판정하면 그 상황이 "통과" 가 된다.
   */
  it('종료 코드 0 이어도 high 발견이 있으면 위험이다', async () => {
    const signal = await runSei({
      project: '/p',
      run: fakeRun({ code: 0, stdout: REAL_INSPECT }),
    });
    expect(signal.ran).toBe(true);
    if (!signal.ran) return;
    expect(signal.risk).toBe(true);
    expect(signal.findings).toHaveLength(1);
    expect(signal.toolVersion).toBe('0.3.0');
  });

  it('발견이 없으면 위험 아님', async () => {
    const signal = await runSei({
      project: '/p',
      run: fakeRun({ code: 0, stdout: JSON.stringify({ findings: [] }) }),
    });
    if (!signal.ran) throw new Error('돌았어야 한다');
    expect(signal.risk).toBe(false);
    expect(signal.detail).toBe('발견 없음');
  });

  it('medium·low 만 있으면 위험으로 올리지 않는다', () => {
    expect(riskFrom([{ findingId: 'a', ruleId: '', title: '', severity: 'medium', state: 'candidate' }])).toBe(false);
    expect(riskFrom([{ findingId: 'a', ruleId: '', title: '', severity: 'critical', state: 'candidate' }])).toBe(true);
  });

  it('후보라고 걸러 내지 않는다 — 전부 candidate 로 오므로 위험이 영영 안 켜진다', () => {
    const findings = parseFindings(JSON.parse(REAL_INSPECT));
    expect(findings[0]?.state).toBe('candidate');
    expect(riskFrom(findings)).toBe(true);
  });
});

describe('못 돌린 것을 통과로 보고하지 않는다', () => {
  it('실행 파일이 없으면 설치 문제라고 말한다', async () => {
    // 셸의 "명령 없음" 은 127 이다. 일반 실패로 뭉뚱그리면
    // "종료 코드 127" 이라는 쓸모없는 안내가 나간다.
    const signal = await runSei({ project: '/p', run: fakeRun({ code: 127 }) });
    if (signal.ran) throw new Error('돌면 안 된다');
    expect(signal.reason).toBe('not-installed');
    expect(signal.checklist.join()).toContain('설치');
  });

  it('attach 안 된 프로젝트는 설정 문제로 구분한다', async () => {
    const signal = await runSei({
      project: '/p',
      run: fakeRun({ code: 2, stderr: 'sei: /p is not attached. Run `sei init` first.' }),
    });
    if (signal.ran) throw new Error('돌면 안 된다');
    expect(signal.reason).toBe('not-attached');
    expect(signal.checklist[0]).toContain('sei init');
  });

  it('종료 코드 2 라도 attach 문제가 아니면 실패로 본다', async () => {
    const signal = await runSei({ project: '/p', run: fakeRun({ code: 2, stderr: '알 수 없는 오류' }) });
    if (signal.ran) throw new Error('돌면 안 된다');
    expect(signal.reason).toBe('failed');
  });

  it('JSON 이 아니면 통과로 보고하지 않는다', async () => {
    const signal = await runSei({ project: '/p', run: fakeRun({ code: 0, stdout: '사람이 읽는 출력' }) });
    if (signal.ran) throw new Error('돌면 안 된다');
    expect(signal.reason).toBe('bad-output');
  });

  it('타임아웃도 통과가 아니다', async () => {
    const signal = await runSei({ project: '/p', run: fakeRun({ timedOut: true, code: null }) });
    if (signal.ran) throw new Error('돌면 안 된다');
    expect(signal.reason).toBe('timeout');
  });

  it('못 돌린 신호에는 risk 필드가 아예 없다', async () => {
    // 헬퍼가 아니라 타입이 막는다. risk:false 를 쓸 수 있게 두면 언젠가 쓴다.
    const signal = await runSei({ project: '/p', run: fakeRun({ code: 127 }) });
    expect(signal).not.toHaveProperty('risk');
    expect(signal.ran).toBe(false);
  });
});

describe('대상 구분', () => {
  /**
   * SEI 는 코드 프로젝트를 검사한다. 본문을 받는 명령이 없다.
   * "설치되지 않았다" 로 적으면 설치하면 된다는 잘못된 기대를 남긴다.
   */
  it('본문 검증에 SEI 를 못 쓰는 이유가 설치 문제로 적히지 않는다', () => {
    expect(SEI_NOT_FOR_TEXT).toContain('코드 프로젝트');
    expect(SEI_NOT_FOR_TEXT).not.toContain('설치');
  });
});

describe('실행 파일 지정', () => {
  it('환경변수가 없으면 PATH 의 sei 를 쓴다', () => {
    expect(seiBin({})).toBe('sei');
    expect(seiBin({ AGENTLAS_SEI_BIN: '  ' })).toBe('sei');
    expect(seiBin({ AGENTLAS_SEI_BIN: '/opt/sei' })).toBe('/opt/sei');
  });

  it('하위 명령을 반드시 붙인다 — 맨 경로는 대화형 run 이 된다', async () => {
    let seen: string[] = [];
    await runSei({
      project: '/p',
      run: (async (_bin: string, args: string[]) => {
        seen = args;
        return { code: 0, stdout: '{"findings":[]}', stderr: '', timedOut: false, ms: 1 };
      }) as never,
    });
    expect(seen[0]).toBe('inspect');
    // 보고서 파일을 프로젝트에 남기지 않는다.
    expect(seen).toContain('--no-report');
    expect(seen).toContain('--json');
  });
});
