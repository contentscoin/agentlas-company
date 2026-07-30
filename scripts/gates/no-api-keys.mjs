#!/usr/bin/env node
// 게이트: 소스 트리에서 LLM API 키 경로를 금지한다 (R1.2)
//
// 오너의 절대 제약은 "모든 LLM 은 구독 계정 OAuth 로만 구동한다" 이다.
// 그 제약을 문서가 아니라 이 게이트가 지킨다.
//
// 규칙이 두 겹인 이유:
//   좌석 브로커는 API 키를 *삭제*하기 위해 그 변수 이름을 알아야 한다.
//   그래서 이름의 등장 자체는 단 하나의 정본 파일에서만 허용하고,
//   어디서든 그 값을 *읽는* 행위는 예외 없이 금지한다.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectFiles, scan, report, EXIT_CANNOT_RUN } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// 정본 삭제 목록 파일. 이 파일만 키 이름을 나열할 수 있다.
const STRIP_LIST = 'src/seats/strip-env.ts';
const ALLOW_NAMES = [STRIP_LIST, 'src/seats/strip-env.test.ts', 'scripts/gates/no-api-keys.mjs'];

// 벤더 키 변수 이름. 이름을 조각으로 조립해 이 게이트 자신이 자기 규칙에 걸리지 않게 한다.
const SUFFIX = '_API_KEY';
const VENDOR_PREFIXES = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'GOOGLE', 'CURSOR', 'AZURE_OPENAI', 'GROQ', 'MISTRAL'];
const KEY_NAMES = VENDOR_PREFIXES.map((p) => p + SUFFIX).concat(['ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL']);

const NAME_RE = new RegExp('\\b(' + KEY_NAMES.join('|') + ')\\b');

// 값을 읽는 행위: process.env.X / process.env['X'] / env.X / env["X"]
const READ_RE = new RegExp(
  '(process\\.)?env(\\.(' + KEY_NAMES.join('|') + ')\\b|\\[\\s*[\'"`](' + KEY_NAMES.join('|') + ')[\'"`]\\s*\\])',
);

try {
  const files = collectFiles([join(REPO, 'src'), join(REPO, 'scripts')], ['.ts', '.mts', '.mjs', '.js', '.cjs']);

  const findings = scan(files, REPO, [
    {
      kind: `api-key-name (정본 ${STRIP_LIST} 밖에서 키 이름 등장)`,
      test: (line) => NAME_RE.test(line),
      allow: ALLOW_NAMES,
    },
    {
      kind: 'api-key-read (키 값을 읽는 경로 — 예외 없이 금지)',
      test: (line) => READ_RE.test(line),
      allow: ['scripts/gates/no-api-keys.mjs'],
    },
  ]);

  process.exit(
    report('gate:apikey', findings, {
      hint: `키 이름은 ${STRIP_LIST} 에만 두고, 값은 어디서도 읽지 않는다. 좌석은 OAuth 로만 인증한다.`,
    }),
  );
} catch (err) {
  process.stderr.write(`[gate:apikey] 실행 불가: ${err.message}\n`);
  process.exit(EXIT_CANNOT_RUN);
}
