import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger/ledger.js';
import { SeatBroker } from '../seats/broker.js';
import type { SeatSpec } from '../seats/spec.js';
import type { RunResult } from '../proc/index.js';
import { ALL_PERSONAS, CRITIC, personaByHandle, personaById } from './personas.js';
import {
  isCriticalDissent,
  parseCloseBlock,
  parseVerdict,
  renderCloseBlock,
  validateCloseBlock,
} from './protocol.js';
import { Meeting, MeetingError, buildRound1Prompt, buildRound2Prompt, planSeating, summarize } from './meeting.js';
import { warRoomsFile, WarRoomStore } from './warroom.js';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlas-org-'));
  ledger = Ledger.open(join(dir, 'events.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeSeat(id: string, vendor: string, over: Partial<SeatSpec> = {}): SeatSpec {
  return {
    id,
    vendor,
    bin: 'fake',
    configHomeEnv: null,
    authFiles: [],
    promptVia: 'arg',
    spawnMode: 'direct',
    buildArgs: (prompt, outFile) => [prompt, outFile],
    readResult: (file, stdout) => (file ?? stdout).trim() || null,
    quota: { window: 'day', limit: null, resetAt: null },
    maxConcurrent: 1,
    verified: true,
    ...over,
  } as SeatSpec;
}

/** 임원마다 다른 답을 주는 가짜 실행기. 프롬프트에서 역할을 읽어 분기한다. */
function scriptedRunner(script: Record<string, string>, fallback = '의견 없음') {
  return async (_spec: SeatSpec, args: string[]): Promise<RunResult> => {
    const prompt = args[0] ?? '';
    const key = Object.keys(script).find((k) => prompt.includes(k));
    writeFileSync(args[1]!, key ? script[key]! : fallback, 'utf8');
    return { code: 0, stdout: '', stderr: '', timedOut: false, ms: 5 };
  };
}

const CLOSE_BLOCK = [
  'DECISION:',
  '- 8월 첫째 주는 리뷰 콘텐츠에 집중한다',
  'OPEN:',
  '- 발행 빈도 재검토',
  'ACTIONS:',
  '- @Growth : 리뷰 콘텐츠 3건 기획 (DUE: 2026-08-03)',
].join('\n');

describe('임원 정의', () => {
  it('핸들로 되짚을 수 있다', () => {
    expect(personaByHandle('@Growth')?.id).toBe('growth');
    expect(personaByHandle('cto')?.id).toBe('cto');
    expect(personaByHandle('@없는역할')).toBeUndefined();
  });

  it('id 로 찾고 없으면 던진다', () => {
    expect(personaById('ceo').handle).toBe('@CEO');
    expect(() => personaById('nope' as never)).toThrow();
  });

  it('모든 임원이 판단 기준을 갖는다', () => {
    for (const p of ALL_PERSONAS) {
      expect(p.charter.length, p.id).toBeGreaterThan(20);
    }
  });

  it('Critic 의 지시문에 업스트림 VERDICT 형식이 들어 있다', () => {
    expect(CRITIC.charter).toContain('VERDICT: CLEAR | WATCH | BLOCK');
    expect(CRITIC.charter).toContain('BLOCKERS:');
  });
});

describe('마감 블록 파싱 (R3.3, R3.6)', () => {
  it('업스트림 문법을 읽는다', () => {
    const b = parseCloseBlock(CLOSE_BLOCK);
    expect(b.decisions).toEqual(['8월 첫째 주는 리뷰 콘텐츠에 집중한다']);
    expect(b.open).toEqual(['발행 빈도 재검토']);
    expect(b.actions).toEqual([
      { owner: 'growth', task: '리뷰 콘텐츠 3건 기획', due: '2026-08-03' },
    ]);
  });

  it('DUE 없는 액션을 허용한다', () => {
    const b = parseCloseBlock('DECISION:\n- x\nACTIONS:\n- @Studio : 이미지 초안');
    expect(b.actions[0]).toEqual({ owner: 'studio', task: '이미지 초안', due: null });
  });

  it('컴팩트 형식(DECISION: 한 줄)도 읽는다', () => {
    expect(parseCloseBlock('DECISION: 스키마 확정').decisions).toEqual(['스키마 확정']);
  });

  it('BOM 을 흡수한다 — 실제로 업스트림 파서를 깨뜨린 문제다', () => {
    const b = parseCloseBlock('\uFEFFDECISION:\n- 결정');
    expect(b.decisions).toEqual(['결정']);
  });

  it('섹션 밖 텍스트를 무시한다', () => {
    const b = parseCloseBlock('안녕하세요 회의 결과입니다\nDECISION:\n- 결정');
    expect(b.decisions).toEqual(['결정']);
  });

  it('DECISION 이 비면 불완전으로 판정한다', () => {
    expect(validateCloseBlock(parseCloseBlock('OPEN:\n- 미결만 있다'))).toContain('DECISION 섹션이 비어 있다');
  });

  it('렌더 후 다시 파싱하면 같은 값이 나온다', () => {
    const b = parseCloseBlock(CLOSE_BLOCK);
    expect(parseCloseBlock(renderCloseBlock(b))).toEqual(b);
  });

  it('렌더 결과에 BOM 이 없다 — 업스트림 파서가 첫 줄을 읽어야 한다', () => {
    expect(renderCloseBlock(parseCloseBlock(CLOSE_BLOCK)).charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('Critic 판정 파싱 (R3.5)', () => {
  it('세 가지 판정을 읽는다', () => {
    expect(parseVerdict('VERDICT: CLEAR').verdict).toBe('CLEAR');
    expect(parseVerdict('VERDICT: WATCH').verdict).toBe('WATCH');
    expect(parseVerdict('VERDICT: BLOCK').verdict).toBe('BLOCK');
  });

  it('BLOCKERS 와 WATCH 목록을 모은다', () => {
    const v = parseVerdict(
      ['VERDICT: BLOCK', 'BLOCKERS:', '- 출처 없는 수치 3건', '- 브랜드 금지어', 'WATCH:', '- 발행 시각'].join('\n'),
    );
    expect(v.blockers).toHaveLength(2);
    expect(v.watch).toEqual(['발행 시각']);
  });

  it('VERDICT 가 없으면 BLOCK 으로 본다 — 형식 위반은 통과가 아니다', () => {
    const v = parseVerdict('제 생각에는 괜찮아 보입니다.');
    expect(v.verdict).toBe('BLOCK');
    expect(v.blockers[0]).toContain('VERDICT 를 찾을 수 없다');
  });

  it('BLOCKERS 가 있는데 CLEAR 라고 우기면 BLOCK 으로 강등한다', () => {
    const v = parseVerdict('VERDICT: CLEAR\nBLOCKERS:\n- 근거 없는 매출 추정');
    expect(v.verdict).toBe('BLOCK');
  });

  it('BLOCK 은 CRITICAL dissent 다', () => {
    expect(isCriticalDissent(parseVerdict('VERDICT: BLOCK'))).toBe(true);
    expect(isCriticalDissent(parseVerdict('VERDICT: WATCH'))).toBe(false);
    expect(isCriticalDissent(parseVerdict('VERDICT: CLEAR'))).toBe(false);
  });
});

describe('좌석 배치 (R3.4)', () => {
  it('벤더가 둘 이상이면 Critic 에게 본체 벤더를 금지한다', () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
    });
    const s = planSeating(broker);
    expect(s.criticForbids).toEqual([s.bodyVendor]);
    expect(s.criticForbids).toHaveLength(1);
  });

  it('벤더가 하나면 회의를 시작하지 않는다', () => {
    const broker = new SeatBroker({ ledger, seats: [fakeSeat('codex', 'openai')] });
    expect(() => planSeating(broker)).toThrow(MeetingError);
    expect(() => planSeating(broker)).toThrow(/R3\.4/);
  });

  it('미검증 좌석은 벤더로 세지 않는다', () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic', { verified: false })],
    });
    expect(() => planSeating(broker)).toThrow(MeetingError);
  });

  it('가용 좌석이 없으면 던진다', () => {
    const broker = new SeatBroker({ ledger, seats: [] });
    expect(() => planSeating(broker)).toThrow(/가용 좌석이 없다/);
  });
});

describe('라운드 프롬프트 (R3.1, R3.2)', () => {
  it('1라운드는 다른 임원 발언을 담지 않는다', () => {
    const p = buildRound1Prompt(personaById('growth'), '8월 콘텐츠 방향');
    expect(p).toContain('1라운드');
    expect(p).toContain('다른 임원의 의견은 아직 없다');
    expect(p).not.toContain('다른 임원 1라운드');
  });

  it('2라운드는 다른 임원의 전문을 담는다', () => {
    const turns = [
      { persona: 'cto' as const, seat: 'codex', text: 'CTO 의 원래 발언 문장', ms: 1 },
      { persona: 'growth' as const, seat: 'claude', text: 'Growth 자기 발언', ms: 1 },
    ];
    const p = buildRound2Prompt(personaById('growth'), '안건', turns);
    expect(p).toContain('CTO 의 원래 발언 문장');
    // 자기 발언은 다시 주지 않는다
    expect(p).not.toContain('Growth 자기 발언');
    expect(p).toContain('요약이 아니라 원문');
  });

  it('2라운드에 동조 압력 경고가 들어 있다', () => {
    const p = buildRound2Prompt(personaById('cto'), '안건', []);
    expect(p).toContain('동조를 위해 입장을 바꾸지 마라');
  });
});

describe('회의 실행', () => {
  function build(script: Record<string, string>): Meeting {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: scriptedRunner(script),
    });
    return new Meeting({ ledger, broker, stateDir: dir });
  }

  const baseScript = {
    'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: CLEAR',
    '너는 CEO': CLOSE_BLOCK,
  };

  it('2라운드를 돌고 마감 블록을 낸다', async () => {
    const m = build(baseScript);
    const r = await m.run({ agenda: '8월 콘텐츠 방향', attendees: ['cto', 'growth'], runId: 'r1' });

    expect(r.status).toBe('closed');
    expect(r.round1).toHaveLength(2);
    expect(r.round2).toHaveLength(2);
    expect(r.verdict?.verdict).toBe('CLEAR');
    expect(r.block?.decisions).toHaveLength(1);
  });

  it('발언이 원장에 라운드별로 남는다', async () => {
    const m = build(baseScript);
    await m.run({ agenda: '안건', attendees: ['cto', 'growth'], runId: 'r2' });

    const turns = ledger.query({ kind: 'meeting.turn', runId: 'r2' });
    expect(turns).toHaveLength(4);
    expect(turns.filter((t) => (t.summary ?? '').startsWith('1라운드'))).toHaveLength(2);
    expect(turns.filter((t) => (t.summary ?? '').startsWith('2라운드'))).toHaveLength(2);
    // 발언 본문은 원장에 넣지 않고 digest 만 남긴다
    expect(turns[0]?.payloadDigest).toHaveLength(64);
  });

  it('Critic 판정이 gate.verdict 로 남는다', async () => {
    const m = build(baseScript);
    await m.run({ agenda: '안건', attendees: ['cto'], runId: 'r3' });
    const v = ledger.query({ kind: 'gate.verdict', runId: 'r3' });
    expect(v).toHaveLength(1);
    expect(v[0]?.summary).toContain('CLEAR');
  });

  it('Critic BLOCK 이면 War Room 으로 간다 (R3.5, R3.7)', async () => {
    const m = build({
      ...baseScript,
      'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: BLOCK\nBLOCKERS:\n- 출처 없는 매출 추정',
    });
    const r = await m.run({ agenda: '안건', attendees: ['cto', 'growth'], runId: 'r4' });

    expect(r.status).toBe('war-room');
    expect(r.reason).toContain('출처 없는 매출 추정');
    // 마감 블록 자체는 만들어졌지만 상태가 war-room 이다
    expect(r.block?.decisions).toHaveLength(1);

    const events = ledger.query({ runId: 'r4' });
    const warRoom = events.find((e) => (e.summary ?? '').includes('War Room'));
    expect(warRoom?.level).toBe('L3');
    expect(warRoom?.summary).toContain('다수결로 기각하지 않는다');
    expect(warRoom?.summary).toContain('오너만 종결');
  });

  it('WATCH 는 War Room 을 부르지 않는다', async () => {
    const m = build({
      ...baseScript,
      'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: WATCH\nWATCH:\n- 발행 시각 재검토',
    });
    const r = await m.run({ agenda: '안건', attendees: ['cto'], runId: 'r5' });
    expect(r.status).toBe('closed');
    expect(r.verdict?.watch).toEqual(['발행 시각 재검토']);
  });

  it('CEO 가 마감 블록 형식을 어기면 실패한다', async () => {
    const m = build({
      ...baseScript,
      '너는 CEO': '회의 결과를 요약하면 리뷰 콘텐츠에 집중하기로 했습니다.',
    });
    const r = await m.run({ agenda: '안건', attendees: ['cto'], runId: 'r6' });
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('DECISION 섹션이 비어 있다');
  });

  it('Critic 이 형식을 어기면 BLOCK 으로 처리되어 War Room 으로 간다', async () => {
    const m = build({ ...baseScript, 'VERDICT: CLEAR | WATCH | BLOCK': '괜찮아 보입니다' });
    const r = await m.run({ agenda: '안건', attendees: ['cto'], runId: 'r7' });
    expect(r.status).toBe('war-room');
  });

  it('벤더가 하나면 회의를 시작조차 하지 않는다', async () => {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai')],
      runner: scriptedRunner(baseScript),
    });
    const m = new Meeting({ ledger, broker, stateDir: dir });
    await expect(m.run({ agenda: '안건', attendees: ['cto'], runId: 'r8' })).rejects.toThrow(MeetingError);
  });

  it('companyctl 경로가 없으면 정규화를 건너뛰되 그 사실을 남긴다', async () => {
    const m = build(baseScript);
    const r = await m.run({ agenda: '안건', attendees: ['cto'], runId: 'r9' });
    expect(r.normalized).toBeUndefined();
    expect(r.normalizationSkipped).toContain('companyctl');
  });

  it('원장 체인이 온전하다', async () => {
    const m = build(baseScript);
    await m.run({ agenda: '안건', attendees: ['cto', 'growth', 'loop'], runId: 'r10' });
    expect(ledger.verify().ok).toBe(true);
  });
});

/**
 * R3.7 은 트리거가 둘인데("동일 과제 2회 실패" 또는 "Critic BLOCK") 뒤쪽만
 * 구현돼 있었다. `MeetingOptions.stateDir` 주석은 "실패 카운터가 여기 쓰인다"
 * 고 약속했지만 그 카운터를 쓰는 코드가 없었다 — 메모리에 있던 것이 아니라
 * 아예 없었고, 같은 안건이 몇 번을 실패하든 오너에게 올라가지 않았다.
 *
 * 아래에서 새 `Meeting` 인스턴스가 새 프로세스의 대역이다. 회의는 매번 새
 * 프로세스에서 돌므로, 카운터가 프로세스 안에 있으면 "2회 연속" 이 성립할 수 없다.
 */
describe('동일 과제 2회 실패 → War Room (Task 6.2, R3.7)', () => {
  /** 1라운드에서 아무 발언도 못 받는 회의. 실패 경로다. */
  function failing(): Meeting {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, ms: 2 }),
    });
    return new Meeting({ ledger, broker, stateDir: dir });
  }

  const AGENDA = '가격 정책을 정하자';

  it('첫 실패는 실패다', async () => {
    const r = await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    expect(r.status).toBe('failed');
    expect(r.failureStreak).toBe(1);
  });

  it('다른 프로세스의 두 번째 실패가 War Room 을 부른다', async () => {
    await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    const r = await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r2' });
    expect(r.status).toBe('war-room');
    expect(r.warRoomCause).toBe('repeat-failure');
    expect(r.failureStreak).toBe(2);
  });

  it('다른 안건은 따로 센다', async () => {
    await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    const r = await failing().run({ agenda: '채용 계획', attendees: ['cto'], runId: 'r2' });
    expect(r.status).toBe('failed');
    expect(r.failureStreak).toBe(1);
  });

  /**
   * 끊지 않으면 한 번 어긋난 안건이 다음 실패마다 영구히 경보를 낸다.
   */
  it('소집하면 연속이 끊긴다', async () => {
    await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r2' }); // War Room
    const r = await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r3' });
    expect(r.status).toBe('failed');
    expect(r.failureStreak).toBe(1);
  });

  /**
   * 몇 달 전 실패 한 번이 다음 실패와 이어지면 엉뚱한 시점에 소집된다.
   */
  it('성공하면 연속이 끊긴다', async () => {
    await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });

    const okBroker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: scriptedRunner({
        'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: CLEAR',
        '너는 CEO': CLOSE_BLOCK,
      }),
    });
    const okRun = await new Meeting({ ledger, broker: okBroker, stateDir: dir }).run({
      agenda: AGENDA, attendees: ['cto'], runId: 'r2',
    });
    expect(okRun.status).toBe('closed');

    const r = await failing().run({ agenda: AGENDA, attendees: ['cto'], runId: 'r3' });
    expect(r.failureStreak).toBe(1);
  });

  it('Critic BLOCK 과 반복 실패를 구분해 남긴다', async () => {
    const blockBroker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: scriptedRunner({
        'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: BLOCK\nBLOCKERS:\n- 근거 없음',
        '너는 CEO': CLOSE_BLOCK,
      }),
    });
    const r = await new Meeting({ ledger, broker: blockBroker, stateDir: dir }).run({
      agenda: AGENDA, attendees: ['cto'], runId: 'r1',
    });
    expect(r.status).toBe('war-room');
    expect(r.warRoomCause).toBe('critic-block');
  });

  it('원장에 안건 원문을 남기지 않는다 (R9)', async () => {
    await failing().run({ agenda: '영업비밀 프로젝트 X 인수', attendees: ['cto'], runId: 'r1' });
    const raw = JSON.stringify(ledger.query({}));
    expect(raw).not.toContain('영업비밀');
    expect(raw).toContain('동일 과제 연속 1회');
  });
});

/**
 * R3.7 은 "War Room 을 소집하고 **오너만이 종결할 수 있게**" 이다. 소집이
 * 반환값으로만 존재하던 동안에는 닫을 대상 자체가 없어서 뒷문장이 구현되지
 * 않았다 — 원장에 소집 기록만 남고 회사는 아무 일 없다는 듯 지나갔다.
 */
describe('War Room 이 열린 채로 남는다 (Task 6.1, R3.7)', () => {
  const AGENDA = '가격 정책을 정하자';

  function failing(warRooms?: WarRoomStore): Meeting {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, ms: 2 }),
    });
    return new Meeting({ ledger, broker, stateDir: dir, ...(warRooms ? { warRooms } : {}) });
  }

  function blocking(warRooms: WarRoomStore): Meeting {
    const broker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: scriptedRunner({
        'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: BLOCK\nBLOCKERS:\n- 근거 없음',
        '너는 CEO': CLOSE_BLOCK,
      }),
    });
    return new Meeting({ ledger, broker, stateDir: dir, warRooms });
  }

  it('반복 실패 소집이 방을 연다', async () => {
    const rooms = new WarRoomStore({ file: warRoomsFile(dir) });
    await failing(rooms).run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    const r = await failing(rooms).run({ agenda: AGENDA, attendees: ['cto'], runId: 'r2' });
    expect(r.warRoomId).toBeDefined();
    const open = rooms.open();
    expect(open).toHaveLength(1);
    expect(open[0]?.cause).toBe('repeat-failure');
    expect(open[0]?.closedAt).toBeNull();
  });

  it('Critic BLOCK 소집도 방을 연다', async () => {
    const rooms = new WarRoomStore({ file: warRoomsFile(dir) });
    const r = await blocking(rooms).run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    expect(r.status).toBe('war-room');
    expect(rooms.open()[0]?.cause).toBe('critic-block');
  });

  /** 소집이 쌓이면 목록이 소음이 되고, 소음이 되면 오너가 목록을 안 본다. */
  it('같은 안건에 방이 쌓이지 않는다', async () => {
    const rooms = new WarRoomStore({ file: warRoomsFile(dir) });
    const first = await blocking(rooms).run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });
    const again = await blocking(rooms).run({ agenda: AGENDA, attendees: ['cto'], runId: 'r2' });
    expect(again.warRoomId).toBe(first.warRoomId);
    expect(rooms.open()).toHaveLength(1);
  });

  it('회의가 성공해도 열린 방이 저절로 닫히지 않는다 — 닫는 것은 사람이다', async () => {
    const rooms = new WarRoomStore({ file: warRoomsFile(dir) });
    await blocking(rooms).run({ agenda: AGENDA, attendees: ['cto'], runId: 'r1' });

    const okBroker = new SeatBroker({
      ledger,
      seats: [fakeSeat('codex', 'openai'), fakeSeat('claude', 'anthropic')],
      runner: scriptedRunner({
        'VERDICT: CLEAR | WATCH | BLOCK': 'VERDICT: CLEAR',
        '너는 CEO': CLOSE_BLOCK,
      }),
    });
    const ok = await new Meeting({ ledger, broker: okBroker, stateDir: dir, warRooms: rooms }).run({
      agenda: AGENDA, attendees: ['cto'], runId: 'r2',
    });
    expect(ok.status).toBe('closed');
    expect(rooms.open()).toHaveLength(1);
  });

  it('원장에 소집이 남고 안건 원문은 남지 않는다', async () => {
    const rooms = new WarRoomStore({ file: warRoomsFile(dir) });
    await blocking(rooms).run({ agenda: '영업비밀 프로젝트 X 인수', attendees: ['cto'], runId: 'r1' });
    const raw = JSON.stringify(ledger.query({}));
    expect(raw).toContain('소집');
    expect(raw).toContain('오너만 종결할 수 있다');
    expect(raw).not.toContain('영업비밀');
  });
});

describe('안건 제목 줄이기', () => {
  it('첫 줄만, 정해진 길이까지', () => {
    expect(summarize('  가격 정책을 정하자  \n둘째 줄')).toBe('가격 정책을 정하자');
    expect(summarize('가나다라마바사', 5)).toBe('가나다라…');
    expect(summarize('')).toBe('');
  });
});
