// 게이트 공용 스캐너. 의존성 없음 (Node stdlib only).
//
// 종료 코드 규약은 업스트림 companyctl 과 동일하게 맞춘다.
//   0  통과 — 보고할 것 없음
//   1  게이트가 돌았고 위반을 찾았다
//   2  게이트를 돌릴 수 없었다 (인자 오류, 경로 없음 등)
//
// 보고는 종류와 위치만 낸다. 매칭된 값 자체를 출력하지 않는다 (R15.6).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const EXIT_CLEAN = 0;
export const EXIT_FINDING = 1;
export const EXIT_CANNOT_RUN = 2;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/** 스캔 대상 파일을 모은다. 기본은 소스 트리 — 문서는 금지 대상을 논의할 수 있어야 한다. */
export function collectFiles(roots, extensions) {
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, out, extensions);
  }
  return out;
}

function walk(dir, out, extensions) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out, extensions);
    } else if (extensions.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
}

/** 경로를 저장소 기준 POSIX 형태로 정규화한다 (Windows 백슬래시 흡수). */
export function repoPath(file, repoRoot) {
  return relative(repoRoot, file).split(sep).join('/');
}

/**
 * 파일들을 줄 단위로 검사한다.
 * rules: [{ kind, test(line) -> boolean, allow: string[] }]
 * allow 는 저장소 기준 경로의 접두사 목록이다.
 */
export function scan(files, repoRoot, rules) {
  const findings = [];
  for (const file of files) {
    const rel = repoPath(file, repoRoot);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const rule of rules) {
      if (rule.allow?.some((prefix) => rel === prefix || rel.startsWith(prefix))) continue;
      lines.forEach((line, i) => {
        if (rule.test(line)) findings.push({ kind: rule.kind, file: rel, line: i + 1 });
      });
    }
  }
  return findings;
}

/** 사람용 출력 + --json 지원. 종료 코드를 돌려준다. */
export function report(name, findings, opts = {}) {
  const asJson = process.argv.includes('--json');
  if (asJson) {
    process.stdout.write(JSON.stringify({ gate: name, findings }, null, 2) + '\n');
  } else if (findings.length === 0) {
    process.stdout.write(`[${name}] PASS — 위반 0건\n`);
  } else {
    process.stdout.write(`[${name}] FAIL — 위반 ${findings.length}건\n`);
    for (const f of findings) {
      process.stdout.write(`  ${f.file}:${f.line}  ${f.kind}\n`);
    }
    if (opts.hint) process.stdout.write(`\n  ${opts.hint}\n`);
  }
  return findings.length === 0 ? EXIT_CLEAN : EXIT_FINDING;
}
