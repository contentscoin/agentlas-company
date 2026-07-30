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
import { createProfile } from './seats/profile.js';
import { resolveState } from './paths.js';

const EXIT_OK = 0;
const EXIT_FINDING = 1;
const EXIT_CANNOT_RUN = 2;

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function jsonOut(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
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

  if (hasFlag(argv, '--json')) {
    jsonOut({ seats: rows, verifiedCount: rows.filter((r) => r.verified).length });
    return rows.some((r) => r.verified) ? EXIT_OK : EXIT_FINDING;
  }

  out('좌석      벤더        검증   격리          쿼터창    한도      동시성');
  out('-'.repeat(78));
  for (const r of rows) {
    const cells = [
      r.seat.padEnd(9),
      r.vendor.padEnd(11),
      (r.verified ? 'yes' : 'no').padEnd(6),
      (r.isolationWorks ? r.isolation : `${r.isolation}(미적용)`).padEnd(13),
      r.quotaWindow.padEnd(9),
      String(r.quotaLimit ?? 'unknown').padEnd(9),
      String(r.maxConcurrent ?? 'unknown(1로 취급)'),
    ];
    out(cells.join(''));
    if (r.note) out(`          └ ${r.note}`);
  }
  const verified = rows.filter((r) => r.verified).length;
  out('');
  out(`가동 가능 좌석 ${verified}/${rows.length}`);
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

function usage(): void {
  out('company — agentlas-company 오피스 CLI');
  out('');
  out('  company seats                       좌석 현황과 실측 상태');
  out('  company ask --persona ceo "질문"     좌석에 한 번 묻는다');
  out('  company history [--kind K] [--run R] 원장 타임라인');
  out('  company verify                      원장 해시체인 검사');
  out('');
  out('  공통: --json  --ledger <경로>');
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
