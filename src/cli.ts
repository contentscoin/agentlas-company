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
import { readFileSync } from 'node:fs';
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
import { parseHandsPlan } from './hands/parse.js';
import { DEFAULT_HANDS_POLICY } from './hands/types.js';
import { HandsExecutor, planDigest } from './hands/executor.js';
import { OfficeServer } from './office/server.js';
import { DeviceStore } from './office/tokens.js';
import { RefuseAllStepUp, TotpStepUp } from './office/stepup.js';
import { PublicBindRefused } from './office/bind.js';
import { PublishBroker } from './publish/broker.js';
import { PublishStore } from './publish/ledgerstore.js';
import { NaverBlogAdapter } from './publish/adapters/naver-blog.js';
import { ThreadsAdapter } from './publish/adapters/threads.js';
import { parseVerb } from './verbs/parse.js';
import { zoneLayout } from './zones/layout.js';
import { currentAccount, verifyZones } from './zones/verify.js';
import { describeFinding, lint } from './zones/lint.js';
import { Studio } from './studio/studio.js';
import { describeSlots, publishReadiness, SLOT_KINDS, type SlotKind } from './studio/artifact.js';
import type { BrandPack } from './studio/brandpack.js';
import { HireBroker, hireDigest } from './hire/hire.js';
import { readBorrowed } from './hire/lock.js';
import { parseCloseBlock, type HireRequest } from './org/protocol.js';
import { ALL_PERSONAS } from './org/personas.js';
import { DEFAULT_VERB_POLICY } from './verbs/types.js';
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

/**
 * 하위 명령을 읽는다. 플래그는 하위 명령이 아니다.
 *
 * `argv[1]` 을 그대로 쓰면 `company approvals --json` 이 `--json` 을 하위
 * 명령으로 읽고 "알 수 없는 하위 명령" 으로 죽는다. usage 는 `--json` 을
 * 공통 플래그로 안내하고 있으므로 이건 계약 위반이다. Task 10 실측 중 밟았다.
 */
function subcommand(argv: string[]): string | undefined {
  const value = argv[1];
  return value === undefined || value.startsWith('--') ? undefined : value;
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
  const sub = subcommand(argv);
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
  // 발행기를 함께 물린다. 레시피에 발행 스텝이 있는데 발행기가 없으면
  // 그 자리에서 멈추므로(조용한 성공 금지), 항상 붙여 두는 편이 맞다.
  const publisher = new PublishBroker({
    ledger,
    approvals,
    policy,
    store: new PublishStore({ file: join(resolveState(), 'publish', 'published.json') }),
    adapters: [
      new ThreadsAdapter(),
      new NaverBlogAdapter({ hands: new HandsExecutor({ ledger }) }),
    ],
    evidenceRoot: join(resolveState(), 'evidence'),
    notify: (m) => note(`  알림 → 오너: ${m}`),
  });
  const engine = new RecipeEngine({
    ledger,
    broker,
    approvals,
    policy,
    stateDir: resolveState(),
    publisher,
  });
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

/**
 * Hands — 브라우저 조작 (R7).
 *
 * 계획은 **파일로만** 받는다. 명령줄에서 자연어를 받는 인자는 없다.
 * 계획 전체가 하나의 digest 로 승인에 묶이므로, 한 단계만 바뀌어도 승인은
 * 다시 받아야 한다 (R4.6).
 */
async function cmdHands(argv: string[]): Promise<number> {
  const planFile = flagValue(argv, '--plan');
  if (!planFile) {
    process.stderr.write(
      '사용법: company hands --plan <계획.json> [--domains a.com,b.com] [--tainted] [--run <runId>]\n' +
        '        계획은 파일로만 받습니다. 자연어 지시를 받는 인자는 없습니다.\n',
    );
    return EXIT_CANNOT_RUN;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`계획을 읽지 못했습니다: ${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }

  const domains = (flagValue(argv, '--domains') ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const parsed = parseHandsPlan(raw, { ...DEFAULT_HANDS_POLICY, allowedDomains: domains });
  if (!parsed.ok) {
    if (hasFlag(argv, '--json')) jsonOut({ ok: false, reason: 'invalid-plan', errors: parsed.errors });
    else for (const e of parsed.errors) process.stderr.write(`거부: ${e}\n`);
    return EXIT_FINDING;
  }

  const ledger = Ledger.open(ledgerPath(argv));
  const { policy } = loadPolicy(policyFile(argv));
  const { svc } = approvalService(argv);
  const tainted = hasFlag(argv, '--tainted');
  const runId = flagValue(argv, '--run') ?? randomUUID();
  const digest = planDigest(parsed.steps);

  // 게이트를 먼저 통과해야 표면에 닿는다. 오염은 게이트가 등급을 올리고,
  // 실행기가 그와 별개로 한 번 더 막는다.
  const decision = resolveGate(
    { policy, approvals: svc, ledger },
    {
      action: 'hands.run',
      payloadDigest: digest,
      summary: `hands ${parsed.steps.length}단계 (${parsed.steps.map((s) => s.op).join('→')})`,
      ...(tainted ? { tainted: true } : {}),
      runId,
    },
  );

  const executor = new HandsExecutor({ ledger });
  const result = await executor.run({
    steps: parsed.steps,
    gateAllowed: decision.allowed,
    ...(decision.allowed ? {} : { gateReason: decision.reason }),
    ...(tainted ? { tainted: true } : {}),
    runId,
  });

  if (hasFlag(argv, '--json')) {
    jsonOut({ runId, planDigest: digest, gate: decision, ...result });
    return result.ok ? EXIT_OK : EXIT_FINDING;
  }

  out(`run     ${runId}`);
  out(`계획    ${parsed.steps.length}단계  digest ${digest.slice(0, 12)}`);
  out(`게이트  ${decision.allowed ? '인가' : `거부 — ${decision.reason}`}`);
  for (const s of result.steps) {
    out(`  [${s.index}] ${s.op.padEnd(14)} ${s.ok ? 'ok' : `실패 — ${s.reason ?? ''}`}`);
  }
  if (!result.ok) {
    out(`결과    실패 — ${result.reason}${result.detail ? `: ${result.detail}` : ''}`);
    for (const d of result.surface?.detail ?? []) out(`        ${d}`);
    if (decision.approvalId && decision.reason === 'approval-pending') {
      out(`        company approvals approve ${decision.approvalId} --digest ${digest}`);
    }
    if (result.checklist && result.checklist.length > 0) {
      out('');
      out('사람이 이어받을 단계:');
      for (const line of result.checklist) out(`  ${line}`);
    }
  } else {
    out(`결과    성공 — ${result.steps.length}단계 완료`);
  }
  return result.ok ? EXIT_OK : EXIT_FINDING;
}

function officeDeps(argv: string[]): {
  ledger: Ledger;
  devices: DeviceStore;
  totp: TotpStepUp;
} {
  const ledger = Ledger.open(ledgerPath(argv));
  const devices = new DeviceStore({ file: join(resolveState(), 'office', 'devices.json'), ledger });
  const totp = new TotpStepUp({ file: join(resolveState(), 'office', 'stepup.json') });
  return { ledger, devices, totp };
}

/**
 * 오피스 API (R10, R14).
 *
 * 하위 명령: (없음)=기동, `device add|list|revoke`, `enroll`
 */
async function cmdOffice(argv: string[]): Promise<number> {
  const sub = subcommand(argv);
  const { ledger, devices, totp } = officeDeps(argv);

  if (sub === 'device') {
    const op = argv[2];
    if (op === 'add') {
      const label = flagValue(argv, '--label') ?? '이름 없는 기기';
      const kind = flagValue(argv, '--kind') === 'desktop' ? 'desktop' : 'mobile';
      const issued = devices.issue(label, kind);
      if (hasFlag(argv, '--json')) jsonOut({ device: issued.record, token: issued.token });
      else {
        out(`기기 등록 — ${issued.record.label} (${issued.record.id})`);
        out('');
        out(`  토큰: ${issued.token}`);
        out('');
        out('  이 토큰은 지금 한 번만 보입니다. 저장되는 것은 해시뿐입니다.');
      }
      return EXIT_OK;
    }
    if (op === 'revoke') {
      const id = argv[3];
      if (!id) {
        process.stderr.write('사용법: company office device revoke <기기ID>\n');
        return EXIT_CANNOT_RUN;
      }
      const ok = devices.revoke(id);
      out(ok ? `폐기 완료 — ${id}` : `폐기할 기기가 없습니다 — ${id}`);
      return ok ? EXIT_OK : EXIT_FINDING;
    }
    const list = devices.list();
    if (hasFlag(argv, '--json')) {
      jsonOut({ devices: list });
      return EXIT_OK;
    }
    if (list.length === 0) {
      out('등록된 기기 없음');
      return EXIT_OK;
    }
    for (const d of list) {
      const state = d.revokedAt ? `폐기 ${d.revokedAt}` : '활성';
      out(`${d.id}  ${d.kind.padEnd(8)} ${d.label.padEnd(16)} ${state}`);
    }
    return EXIT_OK;
  }

  if (sub === 'enroll') {
    const id = argv[2];
    if (!id) {
      process.stderr.write('사용법: company office enroll <기기ID>\n');
      return EXIT_CANNOT_RUN;
    }
    if (!devices.list().some((d) => d.id === id)) {
      process.stderr.write(`등록되지 않은 기기입니다: ${id}\n`);
      return EXIT_CANNOT_RUN;
    }
    const { secret, uri } = totp.enroll(id);
    if (hasFlag(argv, '--json')) jsonOut({ deviceId: id, secret, uri });
    else {
      out(`단계별 인증 등록 — ${id}`);
      out('');
      out(`  시크릿: ${secret}`);
      out(`  URI:    ${uri}`);
      out('');
      out('  인증 앱에 넣으세요. L3 승인과 능력 스위치 변경에 이 코드가 필요합니다.');
    }
    return EXIT_OK;
  }

  // 기동
  const host = flagValue(argv, '--host') ?? '127.0.0.1';
  const port = Number(flagValue(argv, '--port') ?? '0');
  const { policy } = loadPolicy(policyFile(argv));
  const { svc } = approvalService(argv);
  const enrolledAny = devices.list().some((d) => !d.revokedAt && totp.enrolled(d.id));

  const server = new OfficeServer({
    ledger,
    approvals: svc,
    capabilities: capStore(argv),
    devices,
    // 등록된 기기가 하나도 없으면 전부 거부하는 검증기를 쓴다. 자리표시자가
    // 통과시키던 자리를 거부가 대신한다 (Task 8.1).
    stepUp: enrolledAny ? totp : new RefuseAllStepUp(),
    host,
    port,
  });

  try {
    const bound = await server.listen();
    out(`오피스 API — http://${bound.host}:${bound.port}`);
    out(`  기기 ${devices.list().filter((d) => !d.revokedAt).length}대 활성`);
    out(`  단계별 인증 ${enrolledAny ? '등록됨' : '미등록 — L3 승인은 거부됩니다'}`);
    out(`  정책 ${policy.ownerIdentities.join(', ')}`);
    out('  Ctrl-C 로 종료');
    await new Promise<void>((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
    });
    server.close();
    return EXIT_OK;
  } catch (err) {
    if (err instanceof PublicBindRefused) {
      process.stderr.write(`${err.message}\n`);
      process.stderr.write('  loopback 또는 사설망 주소로만 기동합니다 (R14.1, R14.2)\n');
      return EXIT_CANNOT_RUN;
    }
    process.stderr.write(`기동 실패: ${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }
}

/**
 * 발행 (R6).
 *
 * 동사는 **파일로만** 받는다. `company publish --verb <파일>` 이고, 명령줄에서
 * 자유 텍스트를 받는 인자는 없다 — Hands 와 같은 이유다 (R16.7).
 */
async function cmdPublish(argv: string[]): Promise<number> {
  const verbFile = flagValue(argv, '--verb');
  if (!verbFile) {
    process.stderr.write(
      '사용법: company publish --verb <동사.json> [--key <멱등키>] [--dry-run] [--tainted]\n' +
        '        동사는 파일로만 받습니다. 자유 텍스트를 받는 인자는 없습니다.\n',
    );
    return EXIT_CANNOT_RUN;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(verbFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`동사를 읽지 못했습니다: ${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }

  const domains = (flagValue(argv, '--domains') ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const parsed = parseVerb(raw, {
    ...DEFAULT_VERB_POLICY,
    allowedLinkDomains: domains,
    allowedTemplateIds: (flagValue(argv, '--templates') ?? '').split(',').filter(Boolean),
  });
  if (!parsed.ok) {
    if (hasFlag(argv, '--json')) jsonOut({ ok: false, reason: 'invalid-verb', errors: parsed.errors });
    else for (const e of parsed.errors) process.stderr.write(`거부: ${e}\n`);
    return EXIT_FINDING;
  }

  const ledger = Ledger.open(ledgerPath(argv));
  const { policy } = loadPolicy(policyFile(argv));
  const { svc } = approvalService(argv);
  const store = new PublishStore({ file: join(resolveState(), 'publish', 'published.json') });
  const runId = flagValue(argv, '--run') ?? randomUUID();

  const hands = new HandsExecutor({ ledger });
  const writeUrl = flagValue(argv, '--write-url');
  const broker = new PublishBroker({
    ledger,
    approvals: svc,
    policy,
    store,
    evidenceRoot: join(resolveState(), 'evidence'),
    adapters: [
      new ThreadsAdapter(),
      new NaverBlogAdapter({ hands, ...(writeUrl ? { writeUrl } : {}) }),
    ],
    notify: (m) => note(`  알림 → 오너: ${m}`),
  });

  const result = await broker.publish({
    channel: parsed.verb.channel,
    verb: parsed.verb,
    idempotencyKey: flagValue(argv, '--key') ?? `${parsed.verb.channel}:${runId}`,
    ...(hasFlag(argv, '--dry-run') ? { dryRun: true } : {}),
    ...(hasFlag(argv, '--tainted') ? { tainted: true } : {}),
    // 브랜드 대조는 Studio 가 한다. CLI 로 직접 발행할 때는 오너가 책임을
    // 진다고 명시해야 통과한다 (R5.5) — 기본값으로 열어 두지 않는다.
    ...(hasFlag(argv, '--brand-ok') ? { brandPass: true } : {}),
    runId,
  });

  if (hasFlag(argv, '--json')) {
    jsonOut({ runId, ...result });
    return result.ok ? EXIT_OK : EXIT_FINDING;
  }

  out(`채널    ${result.channel}`);
  out(`멱등키  ${result.idempotencyKey}`);
  if (result.payload !== undefined) {
    out('드라이런 — 실제로 나가지 않았습니다. 최종 페이로드:');
    out(JSON.stringify(result.payload, null, 2));
    return EXIT_OK;
  }
  if (result.reason === 'duplicate') {
    out('이미 발행됨 — 다시 내보내지 않았습니다');
    if (result.original?.url) out(`  ${result.original.url}`);
    return EXIT_OK;
  }
  if (!result.ok) {
    out(`결과    실패 — ${result.reason}${result.detail ? `: ${result.detail}` : ''}`);
    if (result.checklist && result.checklist.length > 0) {
      out('');
      out('사람이 이어받을 단계:');
      for (const line of result.checklist) out(`  ${line}`);
    }
    return EXIT_FINDING;
  }
  out('결과    발행 완료');
  if (result.evidence?.url) out(`  URL         ${result.evidence.url}`);
  for (const shot of result.evidence?.screenshots ?? []) out(`  스크린샷    ${shot}`);
  for (const n of result.evidence?.notes ?? []) out(`  ${n}`);
  return EXIT_OK;
}

/**
 * 구역 검증과 비밀 린트 (R15).
 *
 * 하위 명령: `verify`(기본), `lint <파일>`
 */
function cmdSecurity(argv: string[]): number {
  const sub = subcommand(argv) ?? 'verify';

  if (sub === 'lint') {
    const target = argv[2];
    if (!target) {
      process.stderr.write('사용법: company security lint <파일>\n');
      return EXIT_CANNOT_RUN;
    }
    let text: string;
    try {
      text = readFileSync(target, 'utf8');
    } catch (err) {
      process.stderr.write(`읽지 못했습니다: ${(err as Error).message}\n`);
      return EXIT_CANNOT_RUN;
    }
    const result = lint(text, target);
    if (hasFlag(argv, '--json')) {
      // 값은 담기지 않는다 (R15.6). Finding 에 담을 필드 자체가 없다.
      jsonOut(result);
      return result.ok ? EXIT_OK : EXIT_FINDING;
    }
    if (result.ok) {
      out(`${target} — 검출 없음`);
      return EXIT_OK;
    }
    out(`${target} — ${result.findings.length}건 검출`);
    for (const f of result.findings) out(`  ${describeFinding(f)}`);
    out('');
    out('검출된 값은 출력하지 않습니다 (R15.6). 위치를 보고 원문을 확인하세요.');
    return EXIT_FINDING;
  }

  if (sub !== 'verify') {
    process.stderr.write(`알 수 없는 하위 명령: ${sub}\n`);
    return EXIT_CANNOT_RUN;
  }

  const state = resolveState();
  const entries = zoneLayout(state);
  const report = verifyZones({
    entries,
    candidatePaths: entries.map((e) => e.path),
  });

  if (hasFlag(argv, '--json')) {
    jsonOut({ account: currentAccount(), ...report });
    return report.ok ? EXIT_OK : EXIT_FINDING;
  }

  out(`구역 검증 — ${report.platform}, 현재 계정 ${currentAccount()}`);
  out('');
  out('판정    자산                     경로');
  out('-'.repeat(78));
  const mark: Record<string, string> = {
    ok: '닫힘',
    violation: '열림!',
    unknown: '미확인',
    absent: '없음',
  };
  for (const row of report.rows) {
    out(`${(mark[row.verdict] ?? row.verdict).padEnd(7)} ${row.label.padEnd(24)} ${row.path}`);
    if (row.verdict !== 'ok') out(`        └ ${row.detail}`);
  }
  out('');
  out(
    `닫힘 ${report.counts.ok} · 열림 ${report.counts.violation} · ` +
      `미확인 ${report.counts.unknown} · 없음 ${report.counts.absent}`,
  );

  if (report.forbidden.length > 0) {
    out('');
    out('이 기계에 있어서는 안 되는 파일 (R15.7):');
    for (const f of report.forbidden) out(`  ${f.path} — ${f.detail}`);
  }

  if (report.counts.unknown > 0) {
    out('');
    out('미확인은 통과가 아닙니다. 확인하지 못한 것을 닫혔다고 보고하지 않습니다.');
  }
  if (report.platform !== 'win32') {
    out('');
    out('운영 대상은 Windows 입니다. 여기 판정은 POSIX 모드 기준이며,');
    out('실제 배치에서는 setup-zones.ps1 적용 후 다시 확인하세요.');
  }
  return report.ok ? EXIT_OK : EXIT_FINDING;
}

/**
 * Studio — 산출물 생성과 브랜드 대조 (R5).
 *
 * 이미지·영상은 desktop 표면이 없어 **막힌 슬롯**으로 남는다. 그 사실을
 * 표에 그대로 보여준다 — 조용히 비워 두면 발행 직전에야 알게 된다.
 */
async function cmdStudio(argv: string[]): Promise<number> {
  const brief = flagValue(argv, '--brief');
  const title = flagValue(argv, '--title') ?? '제목 없음';
  if (!brief) {
    process.stderr.write(
      '사용법: company studio --brief "<기획 의도>" [--title <제목>] [--want copy,plan]\n' +
        '        --pack <브랜드팩.json> 으로 브랜드 규칙을 지정합니다.\n',
    );
    return EXIT_CANNOT_RUN;
  }

  const packFile = flagValue(argv, '--pack');
  let pack: BrandPack = {
    masterSheet: { forbidden: [], required: [] },
    characters: [],
    contentBase: { claims: [] },
  };
  if (packFile) {
    try {
      pack = JSON.parse(readFileSync(packFile, 'utf8')) as BrandPack;
    } catch (err) {
      process.stderr.write(`브랜드 팩을 읽지 못했습니다: ${(err as Error).message}\n`);
      return EXIT_CANNOT_RUN;
    }
  } else {
    note('  알림: 브랜드 팩이 지정되지 않아 규칙 없이 대조합니다 (--pack)');
  }

  const wantRaw = (flagValue(argv, '--want') ?? 'copy,plan').split(',').map((w) => w.trim());
  const want = wantRaw.filter((w): w is SlotKind => (SLOT_KINDS as readonly string[]).includes(w));
  const unknown = wantRaw.filter((w) => w && !(SLOT_KINDS as readonly string[]).includes(w));
  if (unknown.length > 0) {
    process.stderr.write(`알 수 없는 슬롯: ${unknown.join(', ')} (허용: ${SLOT_KINDS.join(', ')})\n`);
    return EXIT_CANNOT_RUN;
  }

  const ledger = Ledger.open(ledgerPath(argv));
  const studio = new Studio({ broker: new SeatBroker({ ledger }), ledger, pack });
  const artifact = await studio.produce({
    title,
    brief,
    want,
    ...(hasFlag(argv, '--tainted') ? { tainted: true } : {}),
  });

  const readiness = publishReadiness(artifact, want);

  if (hasFlag(argv, '--json')) {
    jsonOut({ artifact, readiness });
    return readiness.ready ? EXIT_OK : EXIT_FINDING;
  }

  out(`산출물  ${artifact.title}  (${artifact.id})`);
  out('');
  for (const row of describeSlots(artifact)) out(`  ${row}`);
  out('');
  out(`브랜드  ${artifact.brandPass ? 'PASS' : 'FAIL'}`);
  for (const note_ of artifact.brandNotes) out(`  ${note_}`);
  out('');
  if (readiness.ready) {
    out('발행 가능');
  } else {
    out('발행 불가:');
    for (const reason of readiness.reasons) out(`  ${reason}`);
  }
  return readiness.ready ? EXIT_OK : EXIT_FINDING;
}

/**
 * 채용 (R13).
 *
 * 회의 마감 블록의 `HIRE:` 를 읽어 채용을 진행한다. 명령줄에서 대상을 직접
 * 받는 인자도 두는데, 회의 없이 오너가 직접 들이는 경우가 있기 때문이다 —
 * 어느 쪽이든 L3 승인은 같다.
 */
async function cmdHire(argv: string[]): Promise<number> {
  const sub = subcommand(argv);
  const lockFile = flagValue(argv, '--lock') ?? join(process.cwd(), 'vendor.lock');

  let lockText: string;
  try {
    lockText = readFileSync(lockFile, 'utf8');
  } catch (err) {
    process.stderr.write(`vendor.lock 을 읽지 못했습니다: ${(err as Error).message}\n`);
    return EXIT_CANNOT_RUN;
  }

  if (sub === 'list') {
    const agents = readBorrowed(lockText);
    if (hasFlag(argv, '--json')) {
      jsonOut({ borrowed: agents });
      return EXIT_OK;
    }
    if (agents.length === 0) {
      out('차용된 에이전트 없음');
      return EXIT_OK;
    }
    for (const a of agents) {
      out(`${a.id}`);
      out(`  digest  ${a.digest.slice(0, 16)}`);
      out(`  권한    ${a.permissions.granted.join(', ') || '없음'}`);
      out(`  사유    ${a.reason}`);
    }
    return EXIT_OK;
  }

  // 요청을 모은다 — 마감 블록 파일 또는 명령줄.
  const requests: HireRequest[] = [];
  const fromFile = flagValue(argv, '--from-meeting');
  if (fromFile) {
    try {
      requests.push(...parseCloseBlock(readFileSync(fromFile, 'utf8')).hires);
    } catch (err) {
      process.stderr.write(`마감 블록을 읽지 못했습니다: ${(err as Error).message}\n`);
      return EXIT_CANNOT_RUN;
    }
  }
  const target = flagValue(argv, '--borrow') ?? flagValue(argv, '--build');
  if (target) {
    requests.push({
      mode: flagValue(argv, '--borrow') ? 'borrow' : 'build',
      target,
      reason: flagValue(argv, '--reason') ?? '사유 없음',
    });
  }

  if (requests.length === 0) {
    process.stderr.write(
      '사용법: company hire --from-meeting <마감블록.txt>\n' +
        '        company hire --borrow <패키지> --reason "<사유>"\n' +
        '        company hire list\n',
    );
    return EXIT_CANNOT_RUN;
  }

  const ledger = Ledger.open(ledgerPath(argv));
  const { policy } = loadPolicy(policyFile(argv));
  const { svc } = approvalService(argv);

  // 정원은 검증된 좌석의 동시성 합이다. 실측되지 않은 좌석은 세지 않는다.
  const capacity = ALL_SEATS.filter((sp) => sp.verified).reduce(
    (n, sp) => n + effectiveConcurrency(sp),
    0,
  );
  const occupied = readBorrowed(lockText).length + ALL_PERSONAS.length;

  const broker = new HireBroker({
    ledger,
    approvals: svc,
    policy,
    lockFile,
    budget: { capacity: Math.max(capacity, occupied + 1), occupied },
    // Hub 차용은 desktop 이 한다. 여기서는 확보 경로가 없다는 사실을 그대로 알린다.
    acquire: async () => ({
      ok: false as const,
      reason:
        'Hub 차용 경로가 이 프로세스에 없다 — desktop 이 확보하고 company 는 판정·기록한다 ' +
        '(Task 16.0 게이트 훅 참조)',
    }),
  });

  let worst = EXIT_OK;
  for (const req of requests) {
    const result = await broker.hire(req, lockText);
    if (hasFlag(argv, '--json')) {
      jsonOut(result);
    } else {
      out(`채용  ${req.mode} ${req.target}`);
      if (result.ok) {
        out(`  완료 — 권한 [${result.agent?.permissions.granted.join(', ') || '없음'}]`);
      } else {
        out(`  거부 — ${result.reason}: ${result.detail}`);
        for (const line of result.proposal ?? []) out(`  ${line}`);
        if (result.approvalId) {
          out(`  승인: company approvals approve ${result.approvalId} --digest ${hireDigest(req)}`);
        }
      }
    }
    if (!result.ok) worst = EXIT_FINDING;
  }
  return worst;
}

/** 승인 대기 목록과 결정 (R4). */
function cmdApprovals(argv: string[]): number {
  const sub = subcommand(argv);
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
  out('  Hands (R7) — 브라우저 조작. 실행 표면은 agentlas-desktop 의 CDP 런처');
  out('  company hands --plan <계획.json> --domains blog.naver.com [--tainted]');
  out('      계획은 파일로만 받습니다. 자연어 지시를 받는 인자는 없습니다');
  out('');
  out('  오피스 API (R10, R14) — 데스크톱·모바일이 같은 API 를 본다');
  out('  company office [--host 127.0.0.1] [--port 0]   기동 (공개 인터페이스 거부)');
  out('  company office device add --label "내 폰"       기기 토큰 발급');
  out('  company office device list | revoke <ID>');
  out('  company office enroll <기기ID>                  단계별 인증(TOTP) 등록');
  out('');
  out('  Studio (R5) — 좌석 산출 + 브랜드 대조. 이미지·영상은 표면 부재로 막힘');
  out('  company studio --brief "<기획 의도>" [--want copy,plan] [--pack <팩.json>]');
  out('');
  out('  발행 (R6) — OAuth API 든 브라우저 조작이든 같은 계약');
  out('  company publish --verb <동사.json> [--key <멱등키>] [--dry-run] [--brand-ok]');
  out('      동사는 파일로만 받습니다. 자유 텍스트를 받는 인자는 없습니다');
  out('');
  out('  채용 (R13) — 회의가 결정하고 오너가 L3 로 승인한다');
  out('  company hire --from-meeting <마감블록.txt> | --borrow <패키지> --reason "<사유>"');
  out('  company hire list                차용된 에이전트와 권한');
  out('');
  out('  구역·비밀 (R15) — 좌석은 브로커 자산을 보지 못한다');
  out('  company security verify          권한 표와 실제 권한을 대조');
  out('  company security lint <파일>     비밀·PII 검출 (값은 출력하지 않음)');
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
      case 'hands':
        return await cmdHands(argv);
      case 'office':
        return await cmdOffice(argv);
      case 'publish':
        return await cmdPublish(argv);
      case 'security':
        return cmdSecurity(argv);
      case 'studio':
        return await cmdStudio(argv);
      case 'hire':
        return await cmdHire(argv);
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
