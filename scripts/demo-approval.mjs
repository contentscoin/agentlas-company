#!/usr/bin/env node
/**
 * 승인 흐름 시연 (R4)
 *
 * CLI 만으로는 "승인 카드가 만들어지는" 순간을 보여줄 수 없다.
 * 카드는 작업 엔진이 만들기 때문이다. 이 스크립트가 그 자리를 대신해
 * 판정 → 카드 → 승인 → 유예 창 → 실행 인가까지를 한 번에 보여준다.
 *
 * 실행: node scripts/demo-approval.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Ledger, digestPayload } = await import('../dist/ledger/ledger.js');
const { classify, loadPolicy } = await import('../dist/policy/policy.js');
const { ApprovalService } = await import('../dist/policy/approval.js');

const dir = mkdtempSync(join(tmpdir(), 'agentlas-demo-'));
const say = (s) => process.stdout.write(s + '\n');

try {
  const ledger = Ledger.open(join(dir, 'events.jsonl'));
  const { policy } = loadPolicy('policy.example.yaml');
  // 시연을 위해 짧은 유예 창과 등록 기기 2대를 쓴다
  const tuned = {
    ...policy,
    approval: { ...policy.approval, coolingWindowMs: 1500 },
    ownerIdentities: ['owner'],
    devices: ['phone-1', 'desktop-1'],
  };

  const svc = new ApprovalService({
    policy: tuned,
    ledger,
    file: join(dir, 'approvals.json'),
    notify: (devices, message) => say(`   알림 → [${devices.join(', ')}] ${message}`),
  });

  const body = '환불 3건 처리';
  const digest = digestPayload(body);
  const c = classify(tuned, { action: 'order_cancel_refund' });

  say('1. 판정');
  say(`   ${c.action} → ${c.level} (비가역 ${c.irreversible}, 인증 필요 ${c.needsStepUp})`);

  say('');
  say('2. 승인 카드 생성');
  const card = svc.create({ classification: c, payloadDigest: digest, summary: body });
  say(`   id ${card.id}`);

  say('');
  say('3. 허용목록에 없는 신원이 승인 시도');
  const intruder = svc.approve(card.id, { identity: 'attacker', device: 'unknown', stepUp: true }, digest);
  say(`   결과: ${intruder.ok ? '통과' : '거부'} — ${intruder.reason}`);

  say('');
  say('4. 오너가 단계별 인증 없이 승인 시도 (L3)');
  const noStepUp = svc.approve(card.id, { identity: 'owner', device: 'phone-1', stepUp: false }, digest);
  say(`   결과: ${noStepUp.ok ? '통과' : '거부'} — ${noStepUp.reason}`);

  say('');
  say('5. 내용이 바뀐 상태로 승인 시도');
  const changed = svc.approve(card.id, { identity: 'owner', device: 'phone-1', stepUp: true }, digestPayload('환불 30건 처리'));
  say(`   결과: ${changed.ok ? '통과' : '거부'} — ${changed.reason} (상태 ${changed.request.status})`);

  say('');
  say('6. 새 카드로 정상 승인 (폰, 인증 통과)');
  const card2 = svc.create({ classification: c, payloadDigest: digest, summary: body });
  const okApprove = svc.approve(card2.id, { identity: 'owner', device: 'phone-1', stepUp: true }, digest);
  say(`   결과: ${okApprove.ok ? '승인' : '거부'}`);

  say('');
  say('7. 유예 창 안에서 실행 시도');
  const early = svc.consume(card2.id, digest);
  say(`   결과: ${early.allowed ? '허용' : '거부'} — ${early.reason} (${svc.coolingRemainingMs(card2.id)}ms 남음)`);

  say('');
  say('8. 다른 기기(desktop-1)가 유예 창 안에서 중단');
  svc.abort(card2.id, { identity: 'owner', device: 'desktop-1' }, '내가 누른 게 아니다');
  await new Promise((r) => setTimeout(r, 1600));
  const afterAbort = svc.consume(card2.id, digest);
  say(`   유예 창이 지난 뒤 실행 시도: ${afterAbort.allowed ? '허용' : '거부'} — ${afterAbort.reason}`);

  say('');
  say('9. 만료는 취소다');
  // 카드를 짧은 TTL 서비스로 직접 만든다.
  // 다른 서비스로 만든 카드는 이미 긴 만료 시각을 갖고 있어서 만료를 시연할 수 없다.
  const shortLived = new ApprovalService({
    policy: { ...tuned, approval: { ...tuned.approval, cardTtlMs: 20 } },
    ledger,
    file: join(dir, 'approvals-short.json'),
  });
  const card3 = shortLived.create({ classification: c, payloadDigest: digest, summary: body });
  await new Promise((r) => setTimeout(r, 60));
  const expired = shortLived.consume(card3.id, digest);
  say(`   결과: ${expired.allowed ? '허용' : '거부'} — ${expired.reason} (침묵은 승인이 아니다)`);
  const tooLate = shortLived.approve(card3.id, { identity: 'owner', device: 'phone-1', stepUp: true }, digest);
  say(`   만료 후 승인 시도: ${tooLate.ok ? '통과' : '거부'} — 상태 ${tooLate.request.status}`);

  say('');
  say('10. 원장');
  const v = ledger.verify();
  say(`   이벤트 ${v.count}건, 체인 ${v.ok ? '정상' : '손상'}`);
  for (const e of ledger.query({ limit: 12 })) {
    say(`   #${e.seq} ${e.kind.padEnd(9)} ${e.summary ?? ''}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
