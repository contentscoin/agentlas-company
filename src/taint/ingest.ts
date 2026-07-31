/**
 * 수집과 신뢰등급 태깅 (R16.1)
 *
 * 외부에서 들어온 모든 텍스트는 이 문을 통과한다.
 * 출처와 신뢰등급이 붙지 않은 콘텐츠가 좌석에 도달하는 경로를 만들지 않는다.
 *
 * 신뢰등급을 호출자가 자유롭게 정하게 두면 언젠가 누가 웹 스크랩을
 * 신뢰 2 로 올린다. 그래서 외부 출처는 목록으로 0 에 고정한다.
 */

import { randomUUID } from 'node:crypto';
import { digestPayload } from '../ledger/ledger.js';
import type { Ledger } from '../ledger/ledger.js';
import { detectInjection, summarizeSignals } from './detect.js';
import { UNTRUSTED_SOURCES, type IngestedItem, type SourceRef, type TrustLevel } from './types.js';

export interface IngestInput {
  source: SourceRef;
  text: string;
  /** 신뢰등급 힌트. 외부 출처면 무시되고 0 으로 고정된다. */
  trust?: TrustLevel;
  runId?: string;
}

/** 출처가 정하는 신뢰등급. 호출자 힌트로 올릴 수 없다. */
export function trustForSource(kind: SourceRef['kind'], hint?: TrustLevel): TrustLevel {
  if (UNTRUSTED_SOURCES.includes(kind)) return 0;
  if (kind === 'owner') return 2;
  if (kind === 'metrics') return 2;
  // 나머지(file, agent)는 힌트를 존중하되 기본은 파생 등급이다.
  return hint ?? 1;
}

export class Ingestor {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /**
   * 외부 콘텐츠를 수집한다. 원장에 출처·신뢰등급·탐지 신호가 남는다.
   *
   * 본문은 원장에 넣지 않고 digest 만 남긴다. 이유가 두 가지다.
   * 원장이 커지는 것을 막고, 공격자가 심은 문장을 원장에 실어 나르지 않는다.
   */
  ingest(input: IngestInput): IngestedItem {
    const trust = trustForSource(input.source.kind, input.trust);
    const signals = trust === 0 ? detectInjection(input.text) : [];

    const item: IngestedItem = {
      id: randomUUID(),
      source: input.source,
      trust,
      text: input.text,
      ingestedAt: new Date().toISOString(),
      digest: digestPayload(input.text),
      signals,
    };

    const counts = summarizeSignals(signals);
    const signalText =
      signals.length === 0
        ? '신호 없음'
        : `신호 ${signals.length}건 (${Object.entries(counts)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ')})`;

    this.ledger.append({
      actor: { kind: 'system', id: 'ingestor' },
      kind: 'ingest',
      tainted: trust === 0,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      payloadDigest: item.digest,
      summary: `${input.source.kind}:${input.source.ref} 신뢰 ${trust}, ${input.text.length}자, ${signalText}`,
    });

    return item;
  }
}
