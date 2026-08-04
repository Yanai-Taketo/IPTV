#!/usr/bin/env node
'use strict';

/**
 * EPG(電子番組表)データパイプラインの CLI。iptv-org は番組データ自体を
 * ホストしていないため、公式グラバー iptv-org/epg を CI で実行して
 * 静的 JSON(data/epg/)を自前生成する。2 段階で使う:
 *
 *   1) node scripts/grab-epg.mjs prepare --out data/epg/channels.xml --split-dir <dir>
 *      iptv-org API の guides.json / feeds.json / streams.json と
 *      ローカルの data/playability.json から「再生確認済み × ガイドあり」の
 *      チャンネルを選定し、グラバー用 channels.xml を生成する。
 *      --split-dir を指定するとサイトごとの <site>.channels.xml も出力する
 *      (全サイトを単一プロセスでグラブすると、全チャンネル分の XMLTV を
 *      一括返却するサイトが重なった時点でヒープが枯渇するため、
 *      CI ではサイト単位でグラバーを起動する)。
 *
 *   2) (iptv-org/epg 側で)サイトごとに
 *      npm run grab --- --channels=<site>.channels.xml --json=<site>.json
 *
 *   3) node scripts/grab-epg.mjs convert --indir <dir> --outdir data/epg
 *      全サイトのグラブ結果をマージし、フロントエンド配信用のコンパクト形式へ
 *      変換する(schedule.json + details-<n>.json。フォーマットは epg-lib.mjs 参照)。
 *      単一ファイルの場合は --in <file> も使える。
 *
 * 番組が 1 件も得られなかった場合 convert は失敗する(空データで
 * 既存の配信データを上書きしないための安全弁)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS,
  EXCLUDED_SITES,
  selectGuideRows,
  buildChannelsXml,
  convertGuide,
  formatGrabSummary,
} from './epg-lib.mjs';

const API_BASE = 'https://iptv-org.github.io/api';

export function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const args = {
    command,
    out: 'data/epg/channels.xml',
    splitDir: null,
    in: 'guide.json',
    indir: null,
    outdir: 'data/epg',
    playability: 'data/playability.json',
    summary: null,       // ジョブサマリの出力先(GITHUB_STEP_SUMMARY)
    attemptedDir: null,  // グラブを試みたサイト一覧(prepare の --split-dir)
    maxSites: DEFAULTS.maxSites,
    maxChannels: DEFAULTS.maxChannels,
    shards: DEFAULTS.shardCount,
    days: null,
    // ランナー IP からデータが取れないサイトの除外リスト(epg-lib.mjs 参照)。
    // --exclude-sites "a,b" で上書き、--exclude-sites "" で無効化できる
    excludeSites: EXCLUDED_SITES,
  };
  let i = 0;
  // 値を取るフラグの値。欠落やフラグの誤消費を黙って通さない
  const value = (flag) => {
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} には値が必要です`);
    return v;
  };
  const positiveInt = (flag) => {
    const v = value(flag);
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== v.trim()) {
      throw new Error(`${flag} には正の整数を指定してください: ${v}`);
    }
    return n;
  };
  for (; i < rest.length; i++) {
    if (rest[i] === '--out') args.out = value('--out');
    else if (rest[i] === '--split-dir') args.splitDir = value('--split-dir');
    else if (rest[i] === '--in') args.in = value('--in');
    else if (rest[i] === '--indir') args.indir = value('--indir');
    else if (rest[i] === '--outdir') args.outdir = value('--outdir');
    else if (rest[i] === '--playability') args.playability = value('--playability');
    else if (rest[i] === '--summary') args.summary = value('--summary');
    else if (rest[i] === '--attempted-dir') args.attemptedDir = value('--attempted-dir');
    else if (rest[i] === '--max-sites') args.maxSites = positiveInt('--max-sites');
    else if (rest[i] === '--max-channels') args.maxChannels = positiveInt('--max-channels');
    else if (rest[i] === '--shards') args.shards = positiveInt('--shards');
    else if (rest[i] === '--days') args.days = positiveInt('--days');
    else if (rest[i] === '--exclude-sites') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--exclude-sites には値が必要です');
      args.excludeSites = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else throw new Error(`unknown argument: ${rest[i]}`);
  }
  return args;
}

async function fetchJson(name) {
  const res = await fetch(`${API_BASE}/${name}.json`);
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}

/** 再生確認済み(status=1 のストリームを持つ)チャンネル id の集合を作る */
function wantedChannels(streams, playability) {
  const status = playability && playability.status ? playability.status : null;
  const wanted = new Set();
  for (const s of streams) {
    if (!s.channel || !s.url) continue;
    if (status) {
      if (status[s.url] === 1) wanted.add(s.channel);
    } else {
      wanted.add(s.channel); // インデックスが無い環境ではストリームを持つ全チャンネル
    }
  }
  return { wanted, verified: Boolean(status) };
}

async function prepare(args) {
  console.log('fetching iptv-org api (guides/feeds/streams)...');
  const [guides, feeds, streams] = await Promise.all([
    fetchJson('guides'),
    fetchJson('feeds'),
    fetchJson('streams'),
  ]);

  let playability = null;
  try {
    playability = JSON.parse(fs.readFileSync(args.playability, 'utf8'));
  } catch {
    console.log(`note: ${args.playability} が読めないため全チャンネルを候補にします`);
  }

  const { wanted, verified } = wantedChannels(streams, playability);
  console.log(`candidate channels: ${wanted.size} (${verified ? '再生確認済みのみ' : '未確認を含む'})`);

  if (args.excludeSites.length) {
    console.log(`excluding ${args.excludeSites.length} runner-blocked sites: ${args.excludeSites.join(', ')}`);
  }
  const { rows, stats } = selectGuideRows(guides, feeds, wanted, {
    maxSites: args.maxSites,
    maxChannels: args.maxChannels,
    excludedSites: args.excludeSites,
  });
  if (!rows.length) {
    throw new Error('グラブ対象が 0 件です(選定条件が厳しすぎるか、入力データが不正です)');
  }
  console.log(
    `selected ${stats.selected} channels over ${stats.sites} sites ` +
      `(guide coverage ${stats.withGuide}/${stats.wanted}, ` +
      `excluded-site-only ${stats.droppedByExclusion}, ` +
      `site-capped ${stats.droppedBySiteCap}, channel-capped ${stats.droppedByChannelCap})`
  );

  const perSite = new Map();
  for (const r of rows) perSite.set(r.site, (perSite.get(r.site) || 0) + 1);
  for (const [site, n] of [...perSite.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${site}: ${n}`);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, buildChannelsXml(rows));
  console.log(`wrote ${args.out} (${rows.length} channels)`);

  // CI 用: サイト単位でグラバーを起動できるよう、サイトごとにも分割して書き出す
  if (args.splitDir) {
    fs.mkdirSync(args.splitDir, { recursive: true });
    const bySite = new Map();
    for (const r of rows) {
      let list = bySite.get(r.site);
      if (!list) bySite.set(r.site, (list = []));
      list.push(r);
    }
    for (const [site, siteRows] of bySite) {
      const name = site.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(args.splitDir, `${name}.channels.xml`), buildChannelsXml(siteRows));
    }
    console.log(`wrote ${bySite.size} per-site channel lists to ${args.splitDir}`);
  }
}

/** グラブ結果(単一ファイルまたは --indir 内の全 *.json)を読み込んでマージする */
function loadGrabJson(args) {
  if (!args.indir) return JSON.parse(fs.readFileSync(args.in, 'utf8'));
  const files = fs
    .readdirSync(args.indir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error(`${args.indir} に *.json がありません`);
  const programs = [];
  for (const f of files) {
    const json = JSON.parse(fs.readFileSync(path.join(args.indir, f), 'utf8'));
    if (Array.isArray(json.programs)) programs.push(...json.programs);
  }
  console.log(`merged ${files.length} site guides (${programs.length} programs)`);
  return { programs };
}

export async function convert(args) {
  const grabJson = loadGrabJson(args);
  const { schedule, shards, stats } = convertGuide(grabJson, {
    shardCount: args.shards,
    days: args.days,
  });

  if (!stats.programs) {
    throw new Error('グラブ結果に番組が 1 件もありません(既存データを保護するため中断)');
  }

  fs.mkdirSync(args.outdir, { recursive: true });
  const schedulePath = path.join(args.outdir, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify(schedule));
  shards.forEach((shard, i) => {
    fs.writeFileSync(path.join(args.outdir, `details-${i}.json`), JSON.stringify(shard));
  });
  // シャード数を減らした場合に古いシャードが残らないよう掃除する
  for (const file of fs.readdirSync(args.outdir)) {
    const m = file.match(/^details-(\d+)\.json$/);
    if (m && Number(m[1]) >= shards.length) fs.unlinkSync(path.join(args.outdir, file));
  }

  const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0);
  console.log(
    `wrote ${schedulePath} (${kb(schedulePath)} KB): ` +
      `${stats.channels} channels, ${stats.programs} programs, ${stats.sites} sites, ` +
      `${shards.length} detail shards, skipped ${stats.skippedPrograms} bad / ` +
      `${stats.prunedPrograms} ended programs`
  );

  // サイト別実績のジョブサマリ。0 件のサイトは選定枠だけを消費するため、
  // 人が気づけるよう別立てで並べる(自動デナイリストの入力にもなる)
  const attempted = args.attemptedDir ? attemptedSites(args.attemptedDir) : [];
  for (const site of attempted) {
    if (!stats.perSite.some((r) => r.site === site)) console.log(`::warning::no programmes from ${site}`);
  }
  if (args.summary) fs.appendFileSync(args.summary, formatGrabSummary(stats, attempted));
}

/**
 * グラブを試みたサイト名の一覧。prepare が --split-dir に出す
 * `<site>.channels.xml` のファイル名から復元する(ファイル名は
 * 英数と ._- 以外を _ に置換してあるため、その形のサイト名で照合する)。
 */
function attemptedSites(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.channels.xml'))
      .map((f) => f.slice(0, -'.channels.xml'.length))
      .sort();
  } catch (err) {
    console.log(`note: ${dir} を読めないためサイト別の 0 件判定を省きます`);
    return [];
  }
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.command === 'prepare') return prepare(args);
  if (args.command === 'convert') return convert(args);
  throw new Error('usage: grab-epg.mjs <prepare|convert> [options]');
}

// テストから parseArgs を import できるよう、直接実行時のみ起動する
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
