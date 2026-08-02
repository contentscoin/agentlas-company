/**
 * 레시피 로딩과 검증 (R12.1)
 *
 * 잘못된 레시피는 로딩에서 막는다. 실행 도중에 스텝 하나가 이상해서
 * 절반만 돌고 멈추는 것이 최악이다 — 좌석 예산은 이미 탔고 산출물은 미완이다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Recipe, Step } from './types.js';
import { isChannel } from '../verbs/types.js';

export class RecipeError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`레시피 오류 ${problems.length}건: ${problems.join(' / ')}`);
    this.name = 'RecipeError';
    this.problems = problems;
  }
}

const STEP_KINDS = ['seat', 'gate', 'approval', 'publish', 'retro'];

/** 레시피를 검증한다. 문제 목록을 모두 모아서 돌려준다. */
export function validateRecipe(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['레시피는 객체여야 한다'];

  const r = value as Record<string, unknown>;
  if (typeof r['name'] !== 'string' || r['name'] === '') problems.push('name 이 필요하다');
  if (!Array.isArray(r['steps']) || r['steps'].length === 0) {
    problems.push('steps 가 최소 하나 필요하다');
    return problems;
  }

  const ids = new Set<string>();
  const produced = new Set<string>();

  (r['steps'] as unknown[]).forEach((raw, i) => {
    const at = `steps[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      problems.push(`${at} 은 객체여야 한다`);
      return;
    }
    const s = raw as Record<string, unknown>;

    const id = s['id'];
    if (typeof id !== 'string' || id === '') problems.push(`${at}.id 가 필요하다`);
    else if (ids.has(id)) problems.push(`${at}.id 중복: ${id}`);
    else ids.add(id);

    const kind = s['kind'];
    if (typeof kind !== 'string' || !STEP_KINDS.includes(kind)) {
      problems.push(`${at}.kind 가 잘못됐다: ${String(kind)}`);
      return;
    }

    if (kind === 'seat') {
      for (const key of ['persona', 'instruction', 'produce']) {
        if (typeof s[key] !== 'string' || s[key] === '') problems.push(`${at}.${key} 가 필요하다`);
      }
      if (typeof s['produce'] === 'string') produced.add(s['produce']);
    }

    if (kind === 'gate' && (typeof s['command'] !== 'string' || s['command'] === '')) {
      problems.push(`${at}.command 가 필요하다`);
    }

    if (kind === 'approval') {
      for (const key of ['action', 'subject']) {
        if (typeof s[key] !== 'string' || s[key] === '') problems.push(`${at}.${key} 가 필요하다`);
      }
    }

    if (kind === 'publish') {
      for (const key of ['channel', 'subject']) {
        if (typeof s[key] !== 'string' || s[key] === '') problems.push(`${at}.${key} 가 필요하다`);
      }
      // 채널명을 실행 전에 막는다. 실행 중에 알면 앞 스텝의 좌석 호출이
      // 이미 소모된 뒤다 — 좌석 호출은 공짜가 아니다.
      if (typeof s['channel'] === 'string' && s['channel'] !== '' && !isChannel(s['channel'])) {
        problems.push(`${at}.channel 이 알 수 없는 채널이다: ${s['channel']}`);
      }
      for (const key of ['brandOk', 'dryRun']) {
        if (s[key] !== undefined && typeof s[key] !== 'boolean') {
          problems.push(`${at}.${key} 는 불리언이어야 한다`);
        }
      }
    }

    if (kind === 'retro') {
      if (typeof s['afterDays'] !== 'number') problems.push(`${at}.afterDays 가 필요하다`);
      if (typeof s['subject'] !== 'string') problems.push(`${at}.subject 가 필요하다`);
      // 예측을 실행 전에 요구한다. 실행 중에 없다는 것을 알면 앞 스텝의
      // 좌석 호출과 발행이 이미 끝난 뒤다 — 복기만 못 하는 상태가 된다.
      const expect = s['expect'];
      if (expect === undefined) {
        problems.push(`${at}.expect 가 필요하다 — 예측 없는 복기는 사후 소감이다 (R11.6)`);
      } else if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
        problems.push(`${at}.expect 는 "지표: 숫자" 객체여야 한다`);
      } else if (!Object.values(expect as Record<string, unknown>).every((v) => typeof v === 'number')) {
        problems.push(`${at}.expect 의 값은 전부 숫자여야 한다`);
      }
      // 채널을 적었으면 실제 채널이어야 한다. 실행 중에 알면 발행이 이미 끝난 뒤다.
      const ch = s['channel'];
      if (ch !== undefined && (typeof ch !== 'string' || !isChannel(ch))) {
        problems.push(`${at}.channel 이 알 수 없는 채널이다: ${String(ch)}`);
      }
    }
  });

  // 참조 검사. `subject` 의 의미가 스텝 종류마다 다르다.
  //
  //   seat/gate/approval/publish  이전 스텝이 만든 **산출물** 이름
  //   retro                       복기할 **발행 스텝의 id**
  //
  // 처음에는 전부 산출물로 검사했는데, 그러면 복기가 발행이 아니라 초안을
  // 가리키게 되고 "무엇의 성과인가" 가 흐려진다. R11 을 붙이면서 갈랐다.
  const stepIds = new Set(
    (r['steps'] as unknown[])
      .map((raw) => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : null))
      .filter((id): id is string => typeof id === 'string'),
  );

  (r['steps'] as unknown[]).forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return;
    const s = raw as Record<string, unknown>;
    const subject = s['subject'];
    if (typeof subject !== 'string') return;

    if (s['kind'] === 'retro') {
      if (!stepIds.has(subject)) {
        problems.push(`steps[${i}].subject 가 없는 스텝을 참조한다: ${subject}`);
      }
      return;
    }
    if (!produced.has(subject)) {
      problems.push(`steps[${i}].subject 가 만들어지지 않는 산출물을 참조한다: ${subject}`);
    }
  });

  return problems;
}

export function parseRecipe(value: unknown): Recipe {
  const problems = validateRecipe(value);
  if (problems.length > 0) throw new RecipeError(problems);
  const r = value as Record<string, unknown>;
  return {
    name: r['name'] as string,
    ...(typeof r['schedule'] === 'string' ? { schedule: r['schedule'] } : {}),
    ...(typeof r['description'] === 'string' ? { description: r['description'] } : {}),
    steps: r['steps'] as Step[],
  };
}

export function loadRecipe(file: string): Recipe {
  if (!existsSync(file)) throw new RecipeError([`레시피 파일이 없다: ${file}`]);
  return parseRecipe(parseYaml(readFileSync(file, 'utf8')));
}
