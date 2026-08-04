#!/usr/bin/env node
'use strict';

/**
 * README 用スクリーンショットを実データで撮り直す CLI。
 *
 *   npx http-server -p 8080 -c-1 .            # 別ターミナルで配信しておく
 *   node scripts/capture-screenshots.mjs
 *
 * 撮影するのは docs/ の 4 枚:
 *   screenshot.png          カード一覧(1512x900)
 *   screenshot-timeline.png テレビ欄(タイムライン、1512x900)
 *   screenshot-player.png   プレイヤー(実配信を再生した状態。モーダル全体が
 *                           入る高さへビューポートを広げてから撮る)
 *   screenshot-mobile.png   モバイル(390x844 @2x)
 *
 * プレイヤーのチャンネルは「再生確認済み × 番組表あり」の先頭から順に開き、
 * 実際に映像が出た最初の 1 局を使う(--channel <id> で固定もできる)。
 * ブラウザは H.264/AAC を含む Google Chrome を使う(Playwright 同梱の
 * Chromium はプロプライエタリコーデック非対応で、IPTV の大半が再生できない)。
 * 事前に `npx playwright install chrome` が必要。
 *
 * 番組表つきの画面を撮るには data/epg/ が要る(main には入っていない):
 *   git fetch --depth 1 origin epg-data && git checkout FETCH_HEAD -- data/epg
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const SHOT_NAMES = ['grid', 'timeline', 'player', 'mobile'];

const USAGE =
  'usage: capture-screenshots.mjs [--base <url>] [--outdir <dir>] [--channel <id>]\n' +
  `                              [--shots ${SHOT_NAMES.join(',')}] [--locale <l>] [--timezone <tz>]\n` +
  '                              [--browser-arg <chrome flag>]...';

// 1512x900 はツールバーが 2 段に収まりつつ検索欄のプレースホルダが切れない幅
const DESKTOP = { width: 1512, height: 900 };
const MOBILE = { width: 390, height: 844 };
const MOBILE_SCALE = 2;
// dialog の UA 既定スタイルは max-height: calc(100% - 6px - 2em) ≒ 100% - 38px。
// モーダル全体を写すため、この分と余白を足した高さのビューポートで撮る
const DIALOG_CHROME = 60;
const MAX_PLAYER_HEIGHT = 1600;

const APP_TIMEOUT = 120000; // 実 API(約 30 MB)の取得ぶん長めに取る
const PLAY_TIMEOUT = 15000;
const CANDIDATE_LIMIT = 40;

export function parseArgs(argv) {
  const rest = argv.slice(2);
  const args = {
    base: 'http://127.0.0.1:8080/',
    outdir: 'docs',
    channel: null,
    shots: [...SHOT_NAMES],
    browserArgs: [],
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
  };
  let i = 0;
  // 値そのものが --flag 形式になりうる --browser-arg 用。欠落だけを弾く
  const rawValue = (flag) => {
    const v = rest[++i];
    if (v === undefined) throw new Error(`${flag} には値が必要です`);
    return v;
  };
  const value = (flag) => {
    const v = rawValue(flag);
    if (v.startsWith('--')) throw new Error(`${flag} には値が必要です`);
    return v;
  };
  for (; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--base') args.base = value(flag);
    else if (flag === '--outdir') args.outdir = value(flag);
    else if (flag === '--channel') args.channel = value(flag);
    else if (flag === '--locale') args.locale = value(flag);
    else if (flag === '--timezone') args.timezone = value(flag);
    // プロキシ環境などで Chrome に追加フラグが要る場合に使う(複数指定可)
    else if (flag === '--browser-arg') args.browserArgs.push(rawValue(flag));
    else if (flag === '--shots') {
      args.shots = value(flag).split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = args.shots.filter((s) => !SHOT_NAMES.includes(s));
      if (unknown.length) throw new Error(`未知のショット: ${unknown.join(', ')}`);
    } else throw new Error(`未知のオプション: ${flag}\n${USAGE}`);
  }
  if (!args.base.endsWith('/')) args.base += '/';
  return args;
}

/** アプリの初期化(実 API の取得と初回描画)を待つ */
async function openApp(context, base) {
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: APP_TIMEOUT });
  return page;
}

/**
 * 一覧のロゴ画像が出そろうまで待つ。ロゴは外部ホスト任せで一定数は必ず
 * 失敗するため、待てない分は諦めて撮る(complete は失敗時も true になる)
 */
async function settleGrid(page) {
  await page
    .waitForFunction(() => {
      const imgs = [...document.querySelectorAll('#grid .card-logo img')];
      return imgs.length > 0 && imgs.every((img) => img.complete);
    }, null, { timeout: 20000 })
    .catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(1500); // 遅延描画とフォントの落ち着き待ち
}

/** 「再生確認済み × 番組表あり」に絞って候補チャンネルを集め、絞り込みは元に戻す */
async function playerCandidates(page) {
  await page.check('#checked-only');
  await page.check('#epg-only');
  await page.waitForTimeout(500);
  const keys = await page.evaluate((limit) =>
    [...document.querySelectorAll('#grid .card')].slice(0, limit).map((c) => c.dataset.key),
  CANDIDATE_LIMIT);
  await page.uncheck('#checked-only');
  await page.uncheck('#epg-only');
  await page.waitForTimeout(500);
  return keys;
}

/**
 * チャンネルを開いて実際に映像が出たかを返す。番組表・公式サイトリンクまで
 * 揃った局だけを採用する(プレイヤーの機能がひと通り写るように)
 */
async function tryChannel(page, key) {
  await page.evaluate((k) => { location.hash = `#play=${encodeURIComponent(k)}`; }, key);
  const playing = await page
    .waitForFunction(() => {
      const v = document.getElementById('player-video');
      return v && v.readyState >= 3 && v.currentTime > 1 &&
        document.getElementById('player-error').hidden;
    }, null, { timeout: PLAY_TIMEOUT })
    .then(() => true)
    .catch(() => false);
  if (!playing) return null;
  return page.evaluate(() => ({
    title: document.getElementById('player-title').textContent,
    programme: document.querySelector('.player-epg-nowtitle')?.textContent || '',
    upcoming: document.querySelectorAll('.player-epg-list li').length,
    site: !!document.querySelector('#player-links a'),
  }));
}

async function closePlayer(page) {
  await page.click('#player-close');
  await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
  await page.waitForTimeout(300);
}

async function capturePlayer(page, args, outPath) {
  const candidates = args.channel ? [args.channel] : await playerCandidates(page);
  if (!candidates.length) throw new Error('プレイヤー用の候補チャンネルが見つかりません');

  let picked = null;
  for (const key of candidates) {
    const info = await tryChannel(page, key);
    if (info && info.programme && info.site) {
      picked = { key, info };
      break;
    }
    await closePlayer(page);
  }
  if (!picked) throw new Error('再生できるチャンネルが候補内に見つかりませんでした');

  // モーダルが縦に収まる高さまでビューポートを広げてから撮る
  const needed = await page.evaluate(() => document.getElementById('player-modal').scrollHeight);
  const height = Math.min(MAX_PLAYER_HEIGHT, Math.max(DESKTOP.height, needed + DIALOG_CHROME));
  if (height !== DESKTOP.height) {
    await page.setViewportSize({ width: DESKTOP.width, height });
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: outPath });
  await page.setViewportSize(DESKTOP);
  await closePlayer(page);
  return picked;
}

async function run() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outdir, { recursive: true });
  const out = (name) => path.join(args.outdir, name);
  const wanted = new Set(args.shots);

  const browser = await chromium.launch({ channel: 'chrome', args: args.browserArgs });
  const contextOptions = {
    ignoreHTTPSErrors: true,
    locale: args.locale,
    timezoneId: args.timezone,
    reducedMotion: 'reduce',
  };
  const written = [];
  try {
    if (wanted.has('grid') || wanted.has('timeline') || wanted.has('player')) {
      const context = await browser.newContext({ ...contextOptions, viewport: DESKTOP });
      const page = await openApp(context, args.base);
      await settleGrid(page);

      if (wanted.has('grid')) {
        await page.screenshot({ path: out('screenshot.png') });
        written.push('screenshot.png');
      }
      if (wanted.has('timeline')) {
        await page.click('#view-toggle');
        await page.waitForTimeout(2500);
        await page.evaluate(() => document.activeElement?.blur());
        await page.screenshot({ path: out('screenshot-timeline.png') });
        written.push('screenshot-timeline.png');
        await page.click('#view-toggle');
        await settleGrid(page);
      }
      if (wanted.has('player')) {
        const picked = await capturePlayer(page, args, out('screenshot-player.png'));
        written.push(`screenshot-player.png (${picked.key}: ${picked.info.programme})`);
      }
      await context.close();
    }

    if (wanted.has('mobile')) {
      const context = await browser.newContext({
        ...contextOptions,
        viewport: MOBILE,
        deviceScaleFactor: MOBILE_SCALE,
        isMobile: true,
        hasTouch: true,
      });
      const page = await openApp(context, args.base);
      await settleGrid(page);
      await page.screenshot({ path: out('screenshot-mobile.png') });
      written.push('screenshot-mobile.png');
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const kb = (name) => (fs.statSync(out(name.split(' ')[0])).size / 1024).toFixed(0);
  for (const name of written) console.log(`wrote ${path.join(args.outdir, name)} (${kb(name)} KB)`);
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
