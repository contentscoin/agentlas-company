/**
 * Studio — 좌석 산출과 브랜드 게이트 (R5)
 *
 * **재정의(2026-08-02)로 범위가 좁혀졌다.** desktop 의 Studio 계열
 * (`creative-pack/`·`document/`·`oberon/`)은 전부 `ipcMain` 뒤에 있어
 * 헤드리스로 닿지 않는다. 그래서 여기서 만드는 것은 좌석으로 낼 수 있는
 * 것 — 카피와 기획 — 뿐이고, 이미지·영상은 **막힌 슬롯으로 남긴다**.
 *
 * 막힌 것을 막혔다고 적는 것이 이 태스크의 핵심 산출이다. 슬롯을 조용히
 * 비워 두면 발행 직전에야 없다는 것을 알게 되고, 더 나쁘면 빈 자리로 나간다.
 *
 * 브랜드 대조는 company 가 소유한다. desktop 의 `shared/brand-safety.ts` 는
 * 별도 배포 단위라 import 하지 않고 교훈만 가져왔다 (한국어 낱말 경계).
 */

import { randomUUID } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.js';
import type { SeatBroker } from '../seats/broker.js';
import { checkBrand, describeViolation, findUnsupportedClaims, type BrandPack } from './brandpack.js';
import { publishReadiness, type Artifact, type Slot, type SlotKind } from './artifact.js';

/** 이미지·영상이 막힌 이유. 한 곳에 두어 문구가 갈라지지 않게 한다. */
export const BLOCKED_BY_DESKTOP =
  'desktop 이 Studio 외부 표면을 노출하지 않는다 (ipcMain 뒤). Task 11.1 참조';

export const BLOCKED_BY_SEAT = (seat: string): string =>
  `${seat} 좌석이 가동 가능하지 않다 — 설치·인증 후 다시 시도하세요`;

export interface StudioOptions {
  broker: SeatBroker;
  ledger: Ledger;
  pack: BrandPack;
}

export interface ProduceRequest {
  title: string;
  /** 무엇을 만들지. 좌석에 전달할 기획 의도. */
  brief: string;
  /** 채울 슬롯. 여기 없는 것은 요청되지 않은 것이다. */
  want: SlotKind[];
  runId?: string;
  tainted?: boolean;
}

/**
 * 좌석 응답에서 근거 인용을 뽑는다 (R5.1).
 *
 * 형식을 강제하지 않고 흔한 두 형태를 받는다 — `[출처] ...` 줄과 URL.
 * 하나도 없으면 빈 배열이다. **인용을 지어내지 않는다** — 없으면 없는 것이고,
 * 그 사실이 슬롯에 그대로 남아 오너가 판단할 수 있어야 한다.
 */
export function extractCitations(text: string): string[] {
  const cites = new Set<string>();
  for (const line of text.split('\n')) {
    const tagged = /^\s*\[(?:출처|근거|source|ref)\]\s*(.+)$/i.exec(line);
    if (tagged?.[1]) cites.add(tagged[1].trim());
  }
  const urls = text.match(/https?:\/\/[^\s)\]]+/g) ?? [];
  for (const url of urls) cites.add(url);
  return [...cites];
}

export class Studio {
  private readonly opts: StudioOptions;

  constructor(opts: StudioOptions) {
    this.opts = opts;
  }

  /**
   * 산출물을 만든다.
   *
   * 슬롯마다 경로가 다르다. 카피·기획은 좌석으로, 이미지·영상은 막힘,
   * 프로그램은 Cursor 좌석이 필요한데 아직 미검증이다 (Task 1.4).
   */
  async produce(req: ProduceRequest): Promise<Artifact> {
    const runId = req.runId ?? randomUUID();
    const slots: Slot[] = [];

    for (const kind of req.want) {
      slots.push(await this.fill(kind, req, runId));
    }

    const artifact: Artifact = {
      id: runId,
      title: req.title,
      slots,
      brandNotes: [],
    };

    this.applyBrandCheck(artifact);

    this.opts.ledger.append({
      actor: { kind: 'system', id: 'studio' },
      kind: 'seat.call',
      runId,
      ...(req.tainted ? { tainted: true } : {}),
      summary:
        `산출물 "${req.title}" — 충족 ${slots.filter((s) => s.state === 'filled').length}/${slots.length}` +
        `, 브랜드 ${artifact.brandPass ? 'PASS' : 'FAIL'}`,
    });

    return artifact;
  }

  private async fill(kind: SlotKind, req: ProduceRequest, runId: string): Promise<Slot> {
    if (kind === 'image' || kind === 'video') {
      // R5.2 는 OAuth 생성 경로를 요구하지만 그 경로가 아직 없다.
      // 없는 것을 있는 척하지 않는다.
      return { kind, state: 'blocked', reason: BLOCKED_BY_DESKTOP };
    }

    if (kind === 'program') {
      // R5.3 은 Cursor 좌석을 지정한다. SEAT-CONTRACT 실측에서 Cursor 는
      // 에이전트 CLI 가 없고 GUI 셔틀만 있었다 (Task 1.4).
      return { kind, state: 'blocked', reason: BLOCKED_BY_SEAT('cursor') };
    }

    const persona = kind === 'copy' ? 'cmo' : 'cpo';
    const prompt =
      kind === 'copy'
        ? `다음 기획으로 게시물 본문을 써라. 사실 주장에는 [출처] 줄을 붙여라.\n\n${req.brief}`
        : `다음 주제의 콘텐츠 기획안을 써라. 근거에는 [출처] 줄을 붙여라.\n\n${req.brief}`;

    const result = await this.opts.broker.ask({
      persona,
      prompt,
      ...(req.tainted ? { tainted: true } : {}),
    });

    if (!result.ok || !result.text) {
      return {
        kind,
        state: 'unmet',
        reason: `좌석 호출 실패 — ${result.reason ?? '응답 없음'}`,
      };
    }

    return {
      kind,
      state: 'filled',
      content: result.text,
      citations: extractCitations(result.text),
      ...(result.seat ? { seat: result.seat } : {}),
      // runId 는 원장이 들고 있으므로 슬롯에 중복해 담지 않는다.
    } satisfies Slot & { kind: SlotKind };
  }

  /**
   * 브랜드 대조 (R5.4, R5.5).
   *
   * 채워진 슬롯의 본문만 본다. 막힌 슬롯에는 검사할 것이 없고, 그것을
   * 위반으로 세면 "이미지가 없어서 브랜드 위반" 이라는 엉뚱한 보고가 된다.
   */
  private applyBrandCheck(artifact: Artifact): void {
    const text = artifact.slots
      .filter((s): s is Extract<Slot, { state: 'filled' }> => s.state === 'filled')
      .map((s) => s.content)
      .join('\n\n');

    if (text.length === 0) {
      // 검사할 본문이 없다. 통과로 두지 않는다 — 검사하지 않은 것이다.
      artifact.brandNotes.push('검사할 본문이 없다 — 채워진 슬롯이 없다');
      artifact.brandPass = false;
      return;
    }

    const verdict = checkBrand(text, this.opts.pack);
    const claims = findUnsupportedClaims(text, this.opts.pack.contentBase);
    const all = [...verdict.violations, ...claims];

    artifact.brandPass = all.length === 0;
    artifact.brandNotes = all.map(describeViolation);
  }
}

export { publishReadiness };
