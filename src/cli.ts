#!/usr/bin/env node
/**
 * company — 오피스 CLI
 *
 * 종료 코드는 업스트림 companyctl 규약을 따른다.
 *   0  성공 (게이트성 명령은 "보고할 것 없음")
 *   1  돌았고 무언가를 찾았다 / 실패했다
 *   2  돌릴 수 없었다
 *
 * 모든 명령이 `--json` 을 지원한다. 스크립트는 사람용 텍스트가 아니라
 * 이 JSON 계약에 바인딩한다.
 */

import { join } from 'node:path';
import { Ledger } from './ledger/ledger.js';
import type { EventKind, QueryFilter } from './ledger/types.js';
import { SeatBroker } from './seats/broker.js';
import { ALL_SEATS, effectiveConcurrency } from './seats/spec.js';
import { distinctVendors, providerFor } from './seats/providers.js';
import { createProfile } from './seats/profile.js';
import { resolveState } from './paths.js';
import { CapabilityStore } from './capabilities/store.js';
import { RISKY_CAPABILITIES, isRiskyCapability, type Caller } from './capabilities/types.js';
import { humanRemaining, parseTtl } from './capabilities/ttl.js';
import { classify, loadPolicy } from './policy/policy.js';
import { resolveGate } from './policy/gate.js';
import { ApprovalService } from './policy/approval.js';
import type { Submitter } from './policy/types.js';
import { randomUUID } from 'node:crypto';
import { Meeting } from './org/meeting.js';
import { RecipeEngine } from './recipes/engine.js';
import { loadRecipe } from './recipes/load.js';
import { currentPlatform, emitForPlatform, parseSchedule } from './recipes/schedule.js';

const EXIT_OK = 0;
const EXIT_FINDING = 1;
const EXIT_CANNOT_RUN = 2;

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function jsonOut(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/**
 * 사람에게 보여줄 곁가지 알림.
 *
 * stdout 이 아니라 stderr 로 나간다. stdout 은 `--json` 계약이 차지하고 있고,
 * 알림 한 줄이 섞이면 호출자의 `JSON.parse` 가 깨진다. 실제로 `company gate`
 * 를 만들면서 이 문제를 밟았다 — 승인 카드 생성 알림이 JSON 앞에 붙었다.
 * 터미널 사용자에게는 여전히 보인다.
 */
function note(text: string): void {
  process.stderr.write(text + '\n');
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function ledgerPath(argv: string[]): string {
  return flagValue(argv, '--ledger') ?? join(resolveState(), 'events.jsonl');
}

/** 좌석 현황. 실측되지 않은 것은 unknown 으로 보인다. */
function cmdSeats(argv: string[]): number {
  const rows = ALL_SEATS.map((spec) => {
    const profile = createProfile(spec);
    const isolated = profile.isolated;
    profile.dispose();
    return {
      seat: spec.id,
      vendor: spec.vendor,
      auth: providerFor(spec.id)?.auth ?? 'unknown',
      bin: spec.bin,
      verified: spec.verified,
      isolation: spec.configHomeEnv ?? 'unknown',
      isolationWorks: isolated,
      quotaWindow: spec.quota.window,
      quotaLimit: spec.quota.limit,
      quotaResetAt: spec.quota.resetAt,
      maxConcurrent: spec.maxConcurrent,
      effectiveConcurrent: effectiveConcurrency(spec),
      note: spec.note ?? null,
    };
  });

  const verifiedSpecs = ALL_SEATS.filter((s) => s.verified);
  const vendors = distinctVendors(verifiedSpecs);

  if (hasFlag(argv, '--json')) {
    jsonOut({
      seats: rows,
      verifiedCount: rows.filter((r) => r.verified).length,
      distinctVendors: vendors,
      crossVendorPossible: vendors.length >= 2,
    });
    return rows.some((r) => r.verified) ? EXIT_OK : EXIT_FINDING;
  }

  out('좌석      벤더        인증    검증   격리          쿼터창    한도');
  out('-'.repeat(76));
  for (const r of rows) {
    const cells = [
      r.seat.padEnd(9),
      r.vendor.padEnd(11),
      r.auth.padEnd(7),
      (r.verified ? 'yes' : 'no').padEnd(6),
      (r.isolationWorks ? r.isolation : `${r.isolation}(미적용)`).padEnd(13),
      r.quotaWindow.padEnd(9),
      String(r.quotaLimit ?? 'unknown'),
    ];
    out(cells.join(''));
    if (r.note) out(`          └ ${r.note}`);
  }
  const verified = rows.filter((r) => r.verified).length;
  out('');
  out(`가동 가능 좌석 ${verified}/${rows.length}`);
  out(`서로 다른 벤더 ${vendors.length}종 (${vendors.join(', ') || '없음'})`);
  out(
    vendors.length >= 2
      ? '크로스벤더 회의 가능 — Critic 을 다른 벤더 좌석에 앉힐 수 있다 (R3.4)'
      : '크로스벤더 회의 불가 — Critic 이 본체와 같은 벤더가 되어 회의(Task 6)가 막혀 있다',
  );
  return verified > 0 ? EXIT_OK : EXIT_FINDING;
}

/** 좌석에 한 번 묻는다. */
async function cmdAsk(argv: string[]): Promise<number> {
  const persona = flagValue(argv, '--persona') ?? 'owner';
  const prompt = argv.filter((a) => !a.startsWith('--')).slice(1).join(' ');
  if (!prompt) {
    process.stderr.write('사용법: company ask [--persona <이름>] [--seat <좌석>] "<프롬프트>"\n');
    return EXIT_CANNOT_RUN;
  }

  const ledger = Ledger.open(ledgerPath(argv));
  const broker = new SeatBroker({ ledger });
  const seat = flagValue(argv, '--seat');
  const forbid = flagValue(argv, '--forbid-vendor');

  const result = await broker.ask({
    persona,
    prompt,
    ...(seat ? { preferSeat: seat as never } : {}),
    ...(forbid ? { forbidVendor: forbid.split(',') as never } : {}),
    ...(hasFlag(argv, '--allow-unverified') ? { allowUnverified: true } : {}),
    ...(hasFlag(argv, '--tainted') ? { tainted: true } : {}),
  });

  if (hasFlag(argv, '--json')) {
    jsonOut(result);
  } else if (result.ok) {
    out(`[${result.seat}] ${result.ranMs}ms (대기 ${result.queuedMs}ms)${result.tainted ? ' · 오염' : ''}`);
    out('');
    out(result.text ?? '');
  } else {
    process.stderr.write(`실패: ${result.reason}\n`);
  }
  return result.ok ? EXIT_OK : EXIT_FINDING;
}

/** 히스토리 조회 (R9.4). */
function cmdHistory(argv: string[]): number {
  const ledger = Ledger.open(ledgerPath(argv));
  const limitRaw = flagValue(argv, '--limit');
  const kind = flagValue(argv, '--kind');
  const runId = flagValue(argv, '--run');

  const filter: QueryFilter = { limit: limitRaw ? Number(limitRaw) : 30 };
  if (kind !== undefined) filter.kind = kind as EventKind;
  if (runId !== undefined) filter.runId = runId;

  const events = ledger.query(filter);

  if (hasFlag(argv, '--json')) {
    jsonOut({ events });
    return EXIT_OK;
  }
  if (events.length === 0) {
    out('이벤트 없음');
    return EXIT_OK;
  }
  for (const e of events) {
    const tag = e.tainted ? ' [오염]' : '';
    out(`#${e.seq} ${e.at} ${e.kind.padEnd(13)} ${e.actor.id}${tag}`);
    if (e.summary) out(`    ${e.summary}`);
  }
  return EXIT_OK;
}

/** 원장 무결성 검사 (R9.2). */
function cmdVerify(argv: string[]): number {
  const ledger = Ledger.open(ledgerPath(argv));
  const r = ledger.verify();
  if (hasFlag(argv, '--json')) {
    jsonOut(r);
  } else if (r.ok) {
    out(`원장 정상 — 이벤트 ${r.count}건, head ${ledger.head.slice(0, 12)}`);
  } else {
    out(`원장 손상 — 마지막 온전한 seq ${r.lastGoodSeq}`);
    for (const p of r.problems) out(`  줄 ${p.at}: ${p.problem} — ${p.detail}`);
  }
  return r.ok ? EXIT_OK : EXIT_FINDING;
}

function capStore(argv: string[]): CapabilityStore {
  const ledger = Ledger.open(ledgerPath(argv));
  const file = flagValue(argv, '--switches') ?? join(resolveState(), 'broker', 'capabilities.json');
  return new CapabilityStore({
    file,
    ledger,
    notify: (message) => note(`  알림 → 등록 기기 전체: ${message}`),
  });
}

/**
 * 오너 신원.
 *
 * CLI 의 `--step-up` 은 실물 단계별 인증의 자리표시자다.
 * 진짜 인증(기기 토큰 + 기기 잠금 해제)은 Task 14 의 콘솔·PWA 가 맡는다.
 * 지금 이것을 인증이라고 부르지 않는다.
 */
function ownerCaller(argv: string[]): Caller {
  return {
    zone: 'owner',
    id: 'owner',
    device: flagValue(argv, '--device') ?? 'cli',
    stepUp: hasFlag(argv, '--step-up'),
  };
}

/** 능력 스위치 (R8). */
function cmdCaps(argv: string[]): number {
  const sub = argv[1];
  const store = capStore(argv);

  if (sub === undefined || sub === 'list') {
    const rows = store.view({ zone: 'owner', id: 'owner' });
    if (hasFlag(argv, '--json')) {
      jsonOut({ capabilities: rows });
      return EXIT_OK;
    }
    out('능력                       상태   남은시간      범위                 사용  거부');
    out('-'.repeat(80));
    for (const r of rows) {
      const scope =
        r.scope.channels.length === 0 && r.scope.accounts.length === 0
          ? '전체'
          : [...r.scope.channels, ...r.scope.accounts].join(',');
      out(
        [
          r.capability.padEnd(26),
          (r.enabled ? 'ON' : 'off').padEnd(6),
          humanRemaining(r.remainingMs).padEnd(13),
          scope.padEnd(20),
          String(r.recentUses).padEnd(5),
          String(r.recentDenials),
        ].join(''),
      );
    }
    const on = rows.filter((r) => r.enabled).length;
    out('');
    out(on === 0 ? '켜진 위험 능력 없음 — 기본 차단 상태' : `켜진 위험 능력 ${on}종`);
    return EXIT_OK;
  }

  if (sub === 'on') {
    const cap = argv[2];
    const ttlRaw = flagValue(argv, '--ttl');
    if (!cap || !isRiskyCapability(cap)) {
      process.stderr.write(`능력 이름이 필요합니다. 가능한 값:\n  ${RISKY_CAPABILITIES.join('\n  ')}\n`);
      return EXIT_CANNOT_RUN;
    }
    if (!ttlRaw) {
      process.stderr.write('--ttl 은 필수입니다 (예: --ttl 2h). 무기한 ON 은 만들 수 없습니다.\n');
      return EXIT_CANNOT_RUN;
    }
    const ttlMs = parseTtl(ttlRaw);
    if (ttlMs === null) {
      process.stderr.write(`--ttl 형식 오류: ${ttlRaw} (예: 90s, 30m, 2h, 1d)\n`);
      return EXIT_CANNOT_RUN;
    }

    const channels = flagValue(argv, '--channel')?.split(',') ?? [];
    const accounts = flagValue(argv, '--account')?.split(',') ?? [];
    const state = store.enable(ownerCaller(argv), {
      capability: cap,
      ttlMs,
      scope: { channels, accounts },
    });
    if (hasFlag(argv, '--json')) jsonOut(state);
    else {
      out(`${cap} ON — 만료 ${state.expiresAt}`);
      out('  스위치 ON 은 승인을 대체하지 않습니다. 개별 실행마다 L3 승인이 필요합니다.');
      out('  재부팅하면 자동으로 OFF 로 돌아갑니다.');
    }
    return EXIT_OK;
  }

  if (sub === 'off') {
    const cap = argv[2];
    if (!cap || !isRiskyCapability(cap)) {
      process.stderr.write('능력 이름이 필요합니다.\n');
      return EXIT_CANNOT_RUN;
    }
    store.disable(ownerCaller(argv), cap);
    out(`${cap} OFF`);
    return EXIT_OK;
  }

  if (sub === 'panic') {
    const reason = flagValue(argv, '--reason') ?? '오너 전체 차단';
    store.panicDisableAll({ zone: 'owner', id: 'owner', device: flagValue(argv, '--device') ?? 'cli' }, reason);
    out(`전체 차단 완료 — ${reason}`);
    out('  진행 중 작업에 중단 신호를 보냈습니다.');
    return EXIT_OK;
  }

  process.stderr.write(`알 수 없는 하위 명령: ${sub}\n`);
  return EXIT_CANNOT_RUN;
}

/** 레시피 실행에 필요한 것을 한 번에 조립한다. */
function engineFor(argv: string[]): { engine: RecipeEngine; approvals: ApprovalService } {
  const { policy } = loadPolicy(policyFile(argv));
  const ledger = Ledger.open(ledgerPath(argv));
  const broker = new SeatBroker({ ledger });
  const approvals = new ApprovalService({
    policy,
    ledger,
    file: join(resolveState(), 'broker', 'approvals.json'),
    notify: (devices, message) => note(`  알림 → [${devices.join(', ')}]: ${message}`),
  });
  const engine = new RecipeEngine({ ledger, broker, approvals, policy, stateDir: resolveState() });
  return { engine, approvals };
}

/** 레시피를 실행한다 (R12). */
async function cmdRun(argv: string[]): Promise<number> {
  const file = argv[1];
  if (!file) {
    process.stderr.write('사용법: company run <레시피.yaml> [--resume <runId>]\n');
    return EXIT_CANNOT_RUN;
  }

  let recipe;
  try {
    recipe = loadRecipe(file);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }

  const { engine } = engineFor(argv);
  const resumeId = flagValue(argv, '--resume');
  const outcome = resumeId ? await engine.resume(recipe, resumeId) : await engine.start(recipe);

  if (hasFlag(argv, '--json')) {
    jsonOut(outcome);
  } else {
    out(`${recipe.name} → ${outcome.status}  (run ${outcome.runId})`);
    if (outcome.stoppedAt) out(`  멈춘 지점: ${outcome.stoppedAt}`);
    if (outcome.reason) out(`  사유: ${outcome.reason}`);
    const state = engine.loadRun(outcome.runId);
    for (const s of state?.steps ?? []) {
      out(`  ${s.status.padEnd(18)} ${s.id}${s.detail ? `  ${s.detail}` : ''}`);
    }
    if (outcome.status === 'paused') {
      out('');
      out(`  승인 후 이어서: company run ${file} --resume ${outcome.runId}`);
    }
  }
  return outcome.status === 'completed' || outcome.status === 'paused' ? EXIT_OK : EXIT_FINDING;
}

/** 상시 기동 등록 명령문을 출력한다. 실제 등록은 오너가 실행한다 (R12.6). */
function cmdSchedule(argv: string[]): number {
  const file = argv[1];
  if (!file) {
    process.stderr.write('사용법: company schedule <레시피.yaml> [--user svc-broker]\n');
    return EXIT_CANNOT_RUN;
  }

  let recipe;
  try {
    recipe = loadRecipe(file);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }
  if (!recipe.schedule) {
    process.stderr.write(`${recipe.name} 에 schedule 이 없습니다.\n`);
    return EXIT_CANNOT_RUN;
  }

  const parsed = parseSchedule(recipe.schedule);
  if (!parsed) {
    process.stderr.write(`schedule 형식 오류: ${recipe.schedule} (예: 'MON 09:00')\n`);
    return EXIT_CANNOT_RUN;
  }

  const platform = currentPlatform();
  const user = flagValue(argv, '--user');
  const spec = {
    name: `agentlas-${recipe.name}`,
    command: `company run ${file}`,
    at: parsed.at,
    ...(parsed.weekday ? { weekday: parsed.weekday } : {}),
    ...(user ? { user } : {}),
    workingDir: process.cwd(),
  };

  const emitted = emitForPlatform(platform, spec);
  if (hasFlag(argv, '--json')) {
    jsonOut({ platform, spec, emitted });
    return EXIT_OK;
  }
  out(`플랫폼 ${platform} · ${recipe.name} · ${recipe.schedule}`);
  out('');
  out('아래를 직접 실행해 등록하세요. 시스템 스케줄러 변경은 코드가 조용히 하지 않습니다.');
  out('');
  out(emitted);
  return EXIT_OK;
}

/** 임원 회의 (R3). */
async function cmdMeeting(argv: string[]): Promise<number> {
  const agenda = flagValue(argv, '--agenda');
  if (!agenda) {
    process.stderr.write('사용법: company meeting --agenda "안건" [--attendees cto,growth] [--companyctl <경로>]\n');
    return EXIT_CANNOT_RUN;
  }

  const attendees = (flagValue(argv, '--attendees') ?? 'cto,growth').split(',').map((s) => s.trim());
  const ledger = Ledger.open(ledgerPath(argv));
  const broker = new SeatBroker({ ledger });
  const companyctl = flagValue(argv, '--companyctl');

  const meeting = new Meeting({
    ledger,
    broker,
    stateDir: resolveState(),
    ...(companyctl ? { companyctl } : {}),
  });

  const runId = flagValue(argv, '--run') ?? randomUUID();
  let result;
  try {
    result = await meeting.run({ agenda, attendees: attendees as never, runId });
  } catch (err) {
    process.stderr.write(`회의를 시작할 수 없습니다: ${(err as Error).message}\n`);
    return EXIT_FINDING;
  }

  if (hasFlag(argv, '--json')) {
    jsonOut(result);
    return result.status === 'closed' ? EXIT_OK : EXIT_FINDING;
  }

  out(`회의 ${result.status}  (run ${result.runId})`);
  out('');
  for (const round of [
    { label: '1라운드', turns: result.round1 },
    { label: '2라운드', turns: result.round2 },
  ]) {
    for (const t of round.turns) {
      out(`${round.label} ${t.persona} → ${t.seat} (${t.ms}ms)`);
      for (const line of t.text.split('\n').slice(0, 4)) out(`    ${line}`);
      out('');
    }
  }

  if (result.verdict) {
    out(`Critic  ${result.verdict.verdict}`);
    for (const b of result.verdict.blockers) out(`    BLOCK  ${b}`);
    for (const w of result.verdict.watch) out(`    WATCH  ${w}`);
    out('');
  }

  if (result.block) {
    out('마감 블록');
    for (const d of result.block.decisions) out(`    DECISION  ${d}`);
    for (const o of result.block.open) out(`    OPEN      ${o}`);
    for (const a of result.block.actions) {
      out(`    ACTION    @${a.owner} : ${a.task}${a.due ? ` (DUE: ${a.due})` : ''}`);
    }
    out('');
  }

  if (result.normalized !== undefined) {
    out('companyctl 정규화 완료');
  } else if (result.normalizationSkipped) {
    out(`companyctl 정규화 건너뜀 — ${result.normalizationSkipped}`);
  }

  if (result.status === 'war-room') {
    out('');
    out('War Room 소집 — Critic 이 BLOCK 했습니다. 다수결로 기각되지 않습니다.');
    out(`사유: ${result.reason}`);
    out('오너만 종결할 수 있습니다.');
  }
  if (result.status === 'failed') {
    out('');
    out(`실패: ${result.reason}`);
  }

  return result.status === 'closed' ? EXIT_OK : EXIT_FINDING;
}

function policyFile(argv: string[]): string {
  return flagValue(argv, '--policy') ?? join(resolveState(), 'policy.yaml');
}

function approvalService(argv: string[]): { svc: ApprovalService; source: 'file' | 'default' } {
  const { policy, source } = loadPolicy(policyFile(argv));
  const ledger = Ledger.open(ledgerPath(argv));
  const svc = new ApprovalService({
    policy,
    ledger,
    file: join(resolveState(), 'broker', 'approvals.json'),
    notify: (devices, message) => note(`  알림 → [${devices.join(', ')}]: ${message}`),
  });
  return { svc, source };
}

function submitter(argv: string[]): Submitter {
  return {
    identity: flagValue(argv, '--as') ?? 'owner',
    device: flagValue(argv, '--device') ?? 'cli',
    stepUp: hasFlag(argv, '--step-up'),
  };
}

/** 작업의 등급 판정을 보여준다 (R4.1 ~ R4.4). */
function cmdClassify(argv: string[]): number {
  const action = argv[1];
  if (!action) {
    process.stderr.write('사용법: company classify <작업> [--tainted] [--critic BLOCK] [--sei-risk]\n');
    return EXIT_CANNOT_RUN;
  }
  const { policy, source } = loadPolicy(policyFile(argv));
  const critic = flagValue(argv, '--critic');
  const c = classify(policy, {
    action,
    ...(critic ? { criticVerdict: critic.toUpperCase() as 'CLEAR' | 'WATCH' | 'BLOCK' } : {}),
    ...(hasFlag(argv, '--sei-risk') ? { seiRisk: true } : {}),
    ...(hasFlag(argv, '--tainted') ? { tainted: true } : {}),
  });

  if (hasFlag(argv, '--json')) {
    jsonOut({ policySource: source, ...c });
    return EXIT_OK;
  }
  out(`작업        ${c.action}`);
  out(`정책        ${source === 'file' ? policyFile(argv) : '기본 정책 (policy.yaml 없음)'}`);
  out(`기본 등급   ${c.baseLevel}`);
  out(`최종 등급   ${c.level}${c.escalatedBy.length > 0 ? `  ← 승격: ${c.escalatedBy.join(', ')}` : ''}`);
  out(`승인 필요   ${c.needsApproval ? 'yes' : 'no'}`);
  out(`단계별 인증 ${c.needsStepUp ? 'yes' : 'no'}`);
  out(`비가역      ${c.irreversible ? 'yes (유예 창 적용)' : 'no'}`);
  return EXIT_OK;
}

/**
 * 실행 게이트 — 외부 실행 표면이 위험 작업 직전에 묻는 자리 (R4, R13.3).
 *
 * `agentlas-desktop` 이 Hub 에이전트를 차용하기 전에 이걸 호출한다. 종료 코드가
 * 계약이다: 0 인가, 1 거부, 2 돌릴 수 없었다. 호출자는 `--json` 의 `allowed` 를
 * 읽거나 종료 코드만 봐도 된다.
 *
 * 2 를 1 과 구분하는 이유는 실행 표면이 이 둘을 다르게 다뤄야 하기 때문이다.
 * 1 은 "물어봤고 안 된다는 답을 받았다" 이고, 2 는 "묻지 못했다" 이다.
 * 후자를 통과로 해석하면 게이트를 끄는 방법이 게이트를 고장내는 것이 된다.
 */
function cmdGate(argv: string[]): number {
  const action = flagValue(argv, '--action');
  const digest = flagValue(argv, '--digest');
  if (!action || !digest) {
    process.stderr.write(
      '사용법: company gate --action <작업> --digest <sha256> [--summary "..."] [--tainted] [--critic BLOCK] [--sei-risk] [--run <runId>]\n',
    );
    return EXIT_CANNOT_RUN;
  }

  const { policy } = loadPolicy(policyFile(argv));
  const ledger = Ledger.open(ledgerPath(argv));
  const { svc } = approvalService(argv);
  const critic = flagValue(argv, '--critic');
  const runId = flagValue(argv, '--run');

  const decision = resolveGate(
    { policy, approvals: svc, ledger },
    {
      action,
      payloadDigest: digest,
      summary: flagValue(argv, '--summary') ?? action,
      ...(critic ? { criticVerdict: critic.toUpperCase() as 'CLEAR' | 'WATCH' | 'BLOCK' } : {}),
      ...(hasFlag(argv, '--sei-risk') ? { seiRisk: true } : {}),
      ...(hasFlag(argv, '--tainted') ? { tainted: true } : {}),
      ...(runId ? { runId } : {}),
    },
  );

  if (hasFlag(argv, '--json')) {
    jsonOut(decision);
    return decision.allowed ? EXIT_OK : EXIT_FINDING;
  }

  out(`작업    ${decision.action}`);
  out(`등급    ${decision.level}${decision.irreversible ? ' [비가역]' : ''}`);
  out(`판정    ${decision.allowed ? '인가' : '거부'} — ${decision.reason}${decision.detail ? ` (${decision.detail})` : ''}`);
  if (decision.approvalId) {
    out(`승인    ${decision.approvalId}`);
    if (decision.reason === 'approval-pending') {
      out(`        company approvals approve ${decision.approvalId} --digest ${digest}${decision.needsStepUp ? ' --step-up' : ''}`);
    }
  }
  return decision.allowed ? EXIT_OK : EXIT_FINDING;
}

/** 승인 대기 목록과 결정 (R4). */
function cmdApprovals(argv: string[]): number {
  const sub = argv[1];
  const { svc } = approvalService(argv);

  if (sub === undefined || sub === 'list') {
    const rows = svc.pending();
    if (hasFlag(argv, '--json')) {
      jsonOut({ pending: rows });
      return EXIT_OK;
    }
    if (rows.length === 0) {
      out('대기 중인 승인 없음');
      return EXIT_OK;
    }
    for (const r of rows) {
      out(`${r.id}  ${r.level}  ${r.action}${r.irreversible ? ' [비가역]' : ''}`);
      out(`    ${r.summary}`);
      out(`    만료 ${r.expiresAt}  digest ${r.payloadDigest.slice(0, 12)}`);
    }
    return EXIT_OK;
  }

  const id = argv[2];
  if (!id) {
    process.stderr.write('승인 요청 id 가 필요합니다.\n');
    return EXIT_CANNOT_RUN;
  }

  if (sub === 'approve') {
    const digest = flagValue(argv, '--digest');
    if (!digest) {
      process.stderr.write('--digest 는 필수입니다. 승인은 정확한 페이로드에 묶입니다.\n');
      return EXIT_CANNOT_RUN;
    }
    const outcome = svc.approve(id, submitter(argv), digest);
    if (!outcome.ok) {
      process.stderr.write(`승인 실패: ${outcome.reason}\n`);
      return EXIT_FINDING;
    }
    out(`승인 완료 — ${outcome.request.action}`);
    const remaining = svc.coolingRemainingMs(id);
    if (remaining !== null && remaining > 0) {
      out(`  유예 창 ${Math.round(remaining / 1000)}초. 이 사이에 다른 기기에서 중단할 수 있습니다.`);
      out(`  중단: company approvals abort ${id}`);
    }
    return EXIT_OK;
  }

  if (sub === 'reject') {
    const outcome = svc.reject(id, submitter(argv), flagValue(argv, '--reason') ?? '오너 거부');
    if (!outcome.ok) {
      process.stderr.write(`거부 실패: ${outcome.reason}\n`);
      return EXIT_FINDING;
    }
    out(`거부 완료 — ${outcome.request.action}`);
    return EXIT_OK;
  }

  if (sub === 'abort') {
    const s = submitter(argv);
    const outcome = svc.abort(id, { identity: s.identity, device: s.device }, flagValue(argv, '--reason') ?? '유예 창 중단');
    if (!outcome.ok) {
      process.stderr.write(`중단 실패: ${outcome.reason}\n`);
      return EXIT_FINDING;
    }
    out(`중단 완료 — ${outcome.request.action}`);
    return EXIT_OK;
  }

  process.stderr.write(`알 수 없는 하위 명령: ${sub}\n`);
  return EXIT_CANNOT_RUN;
}

function usage(): void {
  out('company — agentlas-company 오피스 CLI');
  out('');
  out('  company seats                       좌석 현황과 실측 상태');
  out('  company ask --persona ceo "질문"     좌석에 한 번 묻는다');
  out('  company history [--kind K] [--run R] 원장 타임라인');
  out('  company verify                      원장 해시체인 검사');
  out('');
  out('  능력 스위치 (R8) — 위험한 능력은 기본으로 꺼져 있습니다');
  out('  company caps                        현재 상태와 남은 시간');
  out('  company caps on <능력> --ttl 2h --step-up [--channel c] [--account a]');
  out('  company caps off <능력> --step-up');
  out('  company caps panic [--reason 사유]   전체 차단 (인증 요구 없음)');
  out('');
  out('  정책과 승인 (R4)');
  out('  company classify <작업> [--tainted] [--critic BLOCK] [--sei-risk]');
  out('  company approvals                   대기 중인 승인 카드');
  out('  company approvals approve <id> --digest <d> --step-up --device phone-1');
  out('  company approvals reject <id> [--reason 사유]');
  out('  company approvals abort <id>        유예 창 안에서 중단');
  out('');
  out('  실행 게이트 (R4, R13.3) — 외부 실행 표면이 위험 작업 직전에 묻는 자리');
  out('  company gate --action <작업> --digest <sha256> [--summary "..."] [--tainted]');
  out('      종료 0=인가  1=거부  2=묻지 못함. 2 를 통과로 해석하면 안 됩니다');
  out('');
  out('  회의 (R3) — 2라운드 턴제, Critic 은 다른 벤더 좌석');
  out('  company meeting --agenda "안건" [--attendees cto,growth] [--companyctl <경로>]');
  out('');
  out('  반복 업무 (R12)');
  out('  company run <레시피.yaml>            레시피 실행');
  out('  company run <레시피.yaml> --resume <runId>   멈춘 지점부터 재개');
  out('  company schedule <레시피.yaml>       상시 기동 등록 명령문 출력');
  out('');
  out('  공통: --json  --ledger <경로>  --switches <경로>  --policy <경로>');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  try {
    switch (cmd) {
      case 'seats':
        return cmdSeats(argv);
      case 'ask':
        return await cmdAsk(argv);
      case 'history':
        return cmdHistory(argv);
      case 'verify':
        return cmdVerify(argv);
      case 'caps':
        return cmdCaps(argv);
      case 'classify':
        return cmdClassify(argv);
      case 'gate':
        return cmdGate(argv);
      case 'approvals':
        return cmdApprovals(argv);
      case 'run':
        return await cmdRun(argv);
      case 'schedule':
        return cmdSchedule(argv);
      case 'meeting':
        return await cmdMeeting(argv);
      case undefined:
      case '-h':
      case '--help':
        usage();
        return EXIT_OK;
      default:
        process.stderr.write(`알 수 없는 명령: ${cmd}\n`);
        usage();
        return EXIT_CANNOT_RUN;
    }
  } catch (err) {
    process.stderr.write(`실행 불가: ${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }
}

main().then((code) => process.exit(code));
