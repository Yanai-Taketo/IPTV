#!/usr/bin/env node
'use strict';

/**
 * 再生可能性インデックスの前回比レポートを出力し、急落なら異常終了する。
 *
 *   node scripts/compare-playability.mjs --prev <前回の json> --next <今回の json> \
 *        [--summary $GITHUB_STEP_SUMMARY] [--fail-drop 0.5] [--warn-drop 0.2]
 *
 * --prev が無い・壊れている場合は「前回なし」として比較を省く(初回実行)。
 * 判定ロジックとしきい値の根拠は scripts/playability-report.mjs を参照。
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS,
  comparePlayability,
  formatSummary,
  formatAnnotations,
} from './playability-report.mjs';

export function parseArgs(argv) {
  const args = {
    prev: null,
    next: 'data/playability.json',
    summary: null,
    failDropRatio: DEFAULTS.failDropRatio,
    warnDropRatio: DEFAULTS.warnDropRatio,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[++i];
    // フラグの取り違え(--prev --next のような値の欠落)を黙って飲み込まない
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} には値が必要です`);
    if (flag === '--prev') args.prev = value;
    else if (flag === '--next') args.next = value;
    else if (flag === '--summary') args.summary = value;
    else if (flag === '--fail-drop' || flag === '--warn-drop') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n >= 1) {
        throw new Error(`${flag} は 0 < r < 1 の比率で指定してください`);
      }
      if (flag === '--fail-drop') args.failDropRatio = n;
      else args.warnDropRatio = n;
    } else throw new Error(`不明な引数: ${flag}`);
  }
  return args;
}

function readJson(file, { required }) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (required) throw new Error(`${file} を読めません: ${err.message}`);
    return null; // 前回分は無くてもよい(初回実行)
  }
}

export function run(argv) {
  const args = parseArgs(argv);
  const next = readJson(args.next, { required: true });
  const prev = readJson(args.prev, { required: false });

  const report = comparePlayability(prev, next, {
    failDropRatio: args.failDropRatio,
    warnDropRatio: args.warnDropRatio,
  });
  const summary = formatSummary(report, { generatedAt: next && next.generated_at });

  process.stdout.write(summary);
  for (const line of formatAnnotations(report)) console.log(line);
  if (args.summary) fs.appendFileSync(args.summary, summary);
  return report.ok ? 0 : 1;
}

// 直接実行されたときだけ走らせる(テストからは import して使う)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(run(process.argv));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
