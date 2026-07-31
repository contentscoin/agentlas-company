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

// 이름을 열거하지 않고 **패턴**으로 잡는다.
//
// 처음에는 벤더 이름을 목록으로 뒀는데 구멍이 있었다. OPENROUTER_API_KEY 를
// 소스에 넣고 게이트를 돌렸더니 통과했다 — 목록에 없는 벤더였기 때문이다.
// 프로바이더는 계속 늘어나므로 허용목록 방식은 언젠가 반드시 뚫린다.
// 그래서 `<대문자>_API_KEY` 형태 전부와 알려진 토큰 변형을 패턴으로 막는다.
const SUFFIX = '_API_KEY';
const GENERIC_KEY = '\\b[A-Z][A-Z0-9_]*' + SUFFIX + '\\b';
const EXTRA_NAMES = [
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'OPENROUTER_BASE_URL',
  'HF_TOKEN',
  'REPLICATE_API_TOKEN',
  'TOGETHER_API_TOKEN',
  'DEEPSEEK_TOKEN',
];

const NAME_RE = new RegExp('(' + GENERIC_KEY + '|\\b(' + EXTRA_NAMES.join('|') + ')\\b)');

// 값을 읽는 행위: process.env.X / process.env['X'] / env.X / env["X"]
const KEY_IN_ACCESS = '(?:[A-Z][A-Z0-9_]*' + SUFFIX + '|' + EXTRA_NAMES.join('|') + ')';
const READ_RE = new RegExp(
  '(process\\.)?env(\\.' + KEY_IN_ACCESS + '\\b|\\[\\s*[\'"`]' + KEY_IN_ACCESS + '[\'"`]\\s*\\])',
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
