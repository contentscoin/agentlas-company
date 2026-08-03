/**
 * 측정 기록 보관 (R10.3, R11.6)
 *
 * 지표와 복기는 지금까지 터미널에 찍히고 사라졌다. 원장에는 요약과 digest 만
 * 남기므로(R9) 값이 어디에도 없고, 그래서 "지난주 대비 어땠나" 를 화면으로
 * 보여 줄 방법이 없었다.
 *
 * **여기 담기는 것은 이미 경계를 넘은 값뿐이다.** 집계값은 브로커가
 * 화이트리스트로 걸러 좌석까지 내보내는 값이고(R7.6), 막힌 필드와 미수집은
 * **이름만**이다. 즉 이 파일에 새로 노출되는 정보는 없다 — 터미널에 찍히던
 * 것을 오너 전용 파일에 남길 뿐이다. 원문·스냅샷·고객 정보는 들어오지 않는다.
 *
 * **실패도 기록한다.** 수집이 실패한 사실이 남지 않으면 화면에 "최근 측정
 * 없음" 만 보이고, 측정이 고장 난 것과 측정할 일이 없었던 것이 구분되지
 * 않는다.
 *
 * 무한히 쌓지 않는다. 오래된 것은 잘라 낸다 — 이 파일은 감사 기록이 아니라
 * 화면용 캐시이고, 감사 기록은 원장이다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePrivateDir, writePrivateFile } from '../zones/private.js';
import type { Aggregate } from '../publish/aggregate.js';
import type { MetricsFailure, MetricsWindow } from './types.js';

/** 수집 한 건. 성공이든 실패든 남는다. */
export type CollectionRecord =
  | {
      at: string;
      channel: string;
      window: MetricsWindow;
      ok: true;
      aggregate: Aggregate;
      /** 경계에서 막힌 필드 **이름**. 값은 없다. */
      dropped: string[];
      /** 채널이 내지 못한 지표 **이름**. 0 이 아니다. */
      uncollected: string[];
    }
  | {
      at: string;
      channel: string;
      window: MetricsWindow;
      ok: false;
      reason: MetricsFailure;
      detail: string;
    };

/** 복기 한 건. 예측과 실측을 나란히 남긴다. */
export interface RetroRecord {
  at: string;
  runId: string;
  /** 무엇의 성과인가. 발행 스텝 id 또는 채널. */
  subject: string;
  gaps: { metric: string; expected: number; actual: number | null; ratio: number | null }[];
  uncollected: string[];
  amendments: string[];
  /** 제안된 레시피 편집 건수. diff 원문은 담지 않는다 — 화면은 건수만 쓴다. */
  editCount: number;
}

export interface MetricsStoreOptions {
  file: string;
  /** 종류별 보관 개수. 화면이 쓰는 만큼만 둔다. */
  keep?: number;
}

interface Shape {
  collections: CollectionRecord[];
  retros: RetroRecord[];
}

const EMPTY: Shape = { collections: [], retros: [] };

export class MetricsStore {
  private readonly file: string;
  private readonly keep: number;

  constructor(opts: MetricsStoreOptions) {
    this.file = opts.file;
    this.keep = opts.keep ?? 50;
    ensurePrivateDir(dirname(this.file));
  }

  /** 읽는다. 손상되면 빈 것으로 본다 — 화면용 캐시라 복구할 것이 없다. */
  read(): Shape {
    if (!existsSync(this.file)) return { ...EMPTY };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Shape>;
      return {
        collections: Array.isArray(raw.collections) ? raw.collections : [],
        retros: Array.isArray(raw.retros) ? raw.retros : [],
      };
    } catch {
      return { ...EMPTY };
    }
  }

  private write(next: Shape): void {
    writePrivateFile(this.file, JSON.stringify(next, null, 2));
  }

  /** 최신이 앞이다. 화면이 그 순서로 읽는다. */
  recordCollection(record: CollectionRecord): void {
    const next = this.read();
    next.collections = [record, ...next.collections].slice(0, this.keep);
    this.write(next);
  }

  recordRetro(record: RetroRecord): void {
    const next = this.read();
    next.retros = [record, ...next.retros].slice(0, this.keep);
    this.write(next);
  }

  /** 채널별 마지막 수집. 화면의 "지금" 이 이것이다. */
  latestByChannel(): CollectionRecord[] {
    const seen = new Set<string>();
    const out: CollectionRecord[] = [];
    for (const c of this.read().collections) {
      if (seen.has(c.channel)) continue;
      seen.add(c.channel);
      out.push(c);
    }
    return out;
  }
}
