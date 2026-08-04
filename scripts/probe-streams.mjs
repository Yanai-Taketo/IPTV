#!/usr/bin/env node
'use strict';

/**
 * iptv-org の全ストリームをプローブして「再生可能性インデックス」を生成する。
 *
 *   node scripts/probe-streams.mjs [--sample N] [--local <streams.json>] [--out data/playability.json]
 *
 * ステータス分類(ブラウザ(https ページ + hls.js)から見た再生可能性):
 *   1 = 再生可能見込み   (https / 最終応答 2xx / CORS ヘッダあり)
 *   2 = 生存だが混在コンテンツ (http:// のため https ページから読めない)
 *   3 = 生存だが CORS なし
 *   0 = 応答なし(死亡・タイムアウト・4xx/5xx)
 *
 * 注意: CORS 判定は最終応答の Access-Control-Allow-Origin のみを見る簡易版
 * (リダイレクト中間ホップの CORS までは検査しない)。Origin ヘッダを送るため
 * 動的 CORS(Origin エコー)のサーバも正しく検出できる。
 */

import fs from 'node:fs';
import path from 'node:path';

const API_STREAMS = 'https://iptv-org.github.io/api/streams.json';
const ORIGIN = 'https://example.github.io'; // 動的 CORS 判定用の代表オリジン
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CONCURRENCY = 100;
const TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const args = { sample: 0, local: null, out: 'data/playability.json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--sample') args.sample = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--local') args.local = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

async function loadStreams(local) {
  if (local) return JSON.parse(fs.readFileSync(local, 'utf8'));
  const res = await fetch(API_STREAMS);
  if (!res.ok) throw new Error(`streams.json: HTTP ${res.status}`);
  return res.json();
}

async function probe(url) {
  if (!/^https?:\/\//i.test(url)) return 0; // rtmp 等はブラウザ再生不可
  const isHttp = /^http:\/\//i.test(url);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Origin: ORIGIN, Range: 'bytes=0-1023', 'User-Agent': UA },
    });
    // ボディは読まずに切断(帯域節約)
    try { await res.body?.cancel(); } catch { /* noop */ }
    if (!(res.status >= 200 && res.status < 300)) return 0;
    if (isHttp || /^http:\/\//i.test(res.url)) return 2;
    return res.headers.get('access-control-allow-origin') ? 1 : 3;
  } catch {
    return 0;
  }
}

async function run() {
  const args = parseArgs(process.argv);
  const streams = await loadStreams(args.local);
  let urls = [...new Set(streams.map((s) => s.url).filter(Boolean))];
  if (args.sample > 0 && args.sample < urls.length) {
    // 決定的なサンプリング(検証用)
    urls = urls.filter((_, i) => i % Math.ceil(urls.length / args.sample) === 0).slice(0, args.sample);
  }
  console.log(`probing ${urls.length} urls (concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms)`);

  const status = {};
  let done = 0;
  let cursor = 0;
  const started = Date.now();
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      status[url] = await probe(url);
      done++;
      if (done % 500 === 0) console.log(`  ${done}/${urls.length} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const v of Object.values(status)) counts[v]++;
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s:`,
    `playable=${counts[1]} mixed=${counts[2]} cors=${counts[3]} dead=${counts[0]}`);

  const out = {
    generated_at: new Date().toISOString(),
    total: urls.length,
    sampled: args.sample > 0,
    counts,
    status,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(out));
  console.log(`wrote ${args.out} (${(fs.statSync(args.out).size / 1024).toFixed(0)} KB)`);
}

run().catch((err) => { console.error(err); process.exit(1); });
