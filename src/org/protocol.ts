/**
 * 회의 프로토콜 (R3.3, R3.5, R3.6)
 *
 * 업스트림 `ai-company-discord` 의 PROTOCOLS.md v1 문법을 그대로 따른다.
 * 우리가 새 문법을 만들지 않는 이유는 그쪽 `companyctl decision` 이 이미
 * 이 문법의 정규화 파서이고, 우리는 그것을 진실원천으로 소비하기 때문이다.
 *
 * 마감 블록:
 *   DECISION:            (필수)
 *   - 불릿
 *   OPEN:                (선택)
 *   - 불릿
 *   ACTIONS:             (선택)
 *   - @Owner : 할 일 (DUE: YYYY-MM-DD)
 *
 * Critic 판정:
 *   VERDICT: CLEAR | WATCH | BLOCK
 *   BLOCKERS:
 *   - ...
 *   WATCH:
 *   - ...
 *
 * VERDICT 값이 `CLEAR | WATCH | BLOCK` 인 것은 업스트림 계약이다.
 * 처음에 우리 정책 코드는 `PASS | CONCERN | BLOCK` 을 쓰고 있었는데
 * 실제 프로토콜을 확인하고 맞췄다. 계약이 둘로 갈리면 게이트가 헛돈다.
 */

export type Verdict = 'CLEAR' | 'WATCH' | 'BLOCK';

/**
 * 채용 요청 한 건 (R13.1).
 *
 * `borrow` 는 Hub 에서 가져오는 것, `build` 는 우리가 만드는 것이다. 둘을
 * 구분하는 이유는 권한 기본값이 다르기 때문이다 — 차용 패키지는 남이 쓴
 * 지시문을 실행하므로 무권한에서 시작한다 (R13.3).
 */
export interface HireRequest {
  mode: 'borrow' | 'build';
  /** Hub 패키지 식별자 또는 새 에이전트 이름. */
  target: string;
  /** 회의가 적은 사유. 승인 카드에 그대로 실린다. */
  reason: string;
}

export interface CloseBlock {
  decisions: string[];
  open: string[];
  actions: Array<{ owner: string; task: string; due: string | null }>;
  /** 회의가 채용을 결정했으면 여기 담긴다 (R13.1). */
  hires: HireRequest[];
}

export interface CriticVerdict {
  verdict: Verdict;
  blockers: string[];
  watch: string[];
}

const SECTION_RE = /^(DECISION|OPEN|ACTIONS|HIRE|BLOCKERS|WATCH|VERDICT)\s*:(.*)$/i;
const BULLET_RE = /^-\s+(.*)$/;
const ACTION_RE = /^-\s+@?([A-Za-z][\w-]*)\s*:\s*(.+?)(?:\s*\(DUE:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*\))?\s*$/;
/** `- borrow <대상> : 사유` 또는 `- build <이름> : 사유`. */
const HIRE_RE = /^-\s+(borrow|build)\s+(\S+)\s*:\s*(.+?)\s*$/i;

/**
 * 마감 블록을 파싱한다.
 *
 * 업스트림 파서와 같은 결과를 내되, 우리 쪽에서 먼저 검증해 잘못된 블록이
 * 서브프로세스까지 가지 않게 한다. 최종 정규화는 `companyctl` 이 한다.
 */
export function parseCloseBlock(text: string): CloseBlock {
  const out: CloseBlock = { decisions: [], open: [], actions: [], hires: [] };
  let section: 'decision' | 'open' | 'actions' | 'hire' | null = null;

  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    const sec = SECTION_RE.exec(line);
    if (sec) {
      const name = (sec[1] ?? '').toUpperCase();
      if (name === 'DECISION') {
        section = 'decision';
        // `DECISION: 한 줄 결정` 형태(컴팩트)도 허용한다.
        const inline = (sec[2] ?? '').trim();
        if (inline !== '') out.decisions.push(inline);
      } else if (name === 'OPEN') section = 'open';
      else if (name === 'ACTIONS') section = 'actions';
      else if (name === 'HIRE') section = 'hire';
      else section = null;
      continue;
    }

    if (section === 'hire') {
      const m = HIRE_RE.exec(line);
      // 형식이 아닌 줄은 조용히 버린다. 채용은 L3 이므로 오너가 카드에서
      // 다시 보고, 형식을 못 맞춘 요청은 카드가 만들어지지 않아 드러난다.
      if (m) {
        out.hires.push({
          mode: (m[1] ?? '').toLowerCase() as 'borrow' | 'build',
          target: (m[2] ?? '').trim(),
          reason: (m[3] ?? '').trim(),
        });
      }
      continue;
    }

    if (section === 'actions') {
      const m = ACTION_RE.exec(line);
      if (m) {
        out.actions.push({
          owner: (m[1] ?? '').toLowerCase(),
          task: (m[2] ?? '').trim(),
          due: m[3] ?? null,
        });
      }
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (!bullet) continue;
    const value = (bullet[1] ?? '').trim();
    if (section === 'decision') out.decisions.push(value);
    else if (section === 'open') out.open.push(value);
  }

  return out;
}

/** 마감 블록이 최소 요건을 갖췄는가. DECISION 이 비면 회의가 닫히지 않았다. */
export function validateCloseBlock(block: CloseBlock): string[] {
  const problems: string[] = [];
  if (block.decisions.length === 0) problems.push('DECISION 섹션이 비어 있다');
  for (const a of block.actions) {
    if (a.task === '') problems.push(`ACTION 의 할 일이 비어 있다 (owner ${a.owner})`);
  }
  return problems;
}

/** 블록을 텍스트로 되돌린다. BOM 없이 써야 업스트림 파서가 첫 줄을 읽는다. */
export function renderCloseBlock(block: CloseBlock): string {
  const lines: string[] = ['DECISION:'];
  for (const d of block.decisions) lines.push(`- ${d}`);
  if (block.open.length > 0) {
    lines.push('OPEN:');
    for (const o of block.open) lines.push(`- ${o}`);
  }
  if (block.actions.length > 0) {
    lines.push('ACTIONS:');
    for (const a of block.actions) {
      lines.push(`- @${a.owner} : ${a.task}${a.due ? ` (DUE: ${a.due})` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Critic 판정을 파싱한다.
 *
 * VERDICT 를 못 찾으면 `BLOCK` 으로 본다. 판정 없는 비평을 통과로 해석하면
 * Critic 을 무력화하는 가장 쉬운 방법이 "형식을 어기는 것" 이 된다.
 */
export function parseVerdict(text: string): CriticVerdict {
  const out: CriticVerdict = { verdict: 'BLOCK', blockers: [], watch: [] };
  let found = false;
  let section: 'blockers' | 'watch' | null = null;

  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    const sec = SECTION_RE.exec(line);
    if (sec) {
      const name = (sec[1] ?? '').toUpperCase();
      if (name === 'VERDICT') {
        const value = (sec[2] ?? '').trim().toUpperCase();
        const picked = /\bBLOCK\b/.test(value)
          ? 'BLOCK'
          : /\bWATCH\b/.test(value)
            ? 'WATCH'
            : /\bCLEAR\b/.test(value)
              ? 'CLEAR'
              : null;
        if (picked !== null) {
          out.verdict = picked;
          found = true;
        }
        section = null;
        continue;
      }
      if (name === 'BLOCKERS') section = 'blockers';
      else if (name === 'WATCH') section = 'watch';
      else section = null;
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (!bullet) continue;
    const value = (bullet[1] ?? '').trim();
    if (section === 'blockers') out.blockers.push(value);
    else if (section === 'watch') out.watch.push(value);
  }

  if (!found) {
    out.verdict = 'BLOCK';
    out.blockers.push('VERDICT 를 찾을 수 없다 — 형식 위반은 통과가 아니다');
  }
  // BLOCKERS 가 있는데 CLEAR 라고 우기는 경우를 막는다.
  if (out.blockers.length > 0 && out.verdict === 'CLEAR') out.verdict = 'BLOCK';
  return out;
}

/**
 * CRITICAL dissent 인가 (R3.5).
 *
 * BLOCK 은 다수결로 기각되지 않고 Board 승인 게이트로 올라간다.
 * 이 판정을 CEO 가 아니라 프로토콜이 하는 것이 요점이다 —
 * 집계하는 주체가 반대 의견의 무게를 정하면 그 반대는 장식이 된다.
 */
export function isCriticalDissent(verdict: CriticVerdict): boolean {
  return verdict.verdict === 'BLOCK';
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
