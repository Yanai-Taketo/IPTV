'use strict';

/**
 * iptv-org API の実データスナップショット(約 4 万チャンネル)をオフラインで
 * 注入し、実スケールでの動作を検証する。
 *
 * スナップショットは容量が大きいためリポジトリには含めない
 * (tests/fixtures/realdata/ は gitignore 済み)。以下で取得できる:
 *
 *   mkdir -p tests/fixtures/realdata && cd tests/fixtures/realdata
 *   for f in channels streams feeds logos countries categories languages; do
 *     curl -sSO https://iptv-org.github.io/api/$f.json
 *   done
 *
 * スナップショットが無い環境では自動スキップする。
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const REALDATA = path.join(__dirname, 'fixtures', 'realdata');
const AVAILABLE = fs.existsSync(path.join(REALDATA, 'channels.json'));

test.describe('実データスナップショット(4 万チャンネル)', () => {
  test.skip(!AVAILABLE, 'tests/fixtures/realdata/ にスナップショットが無いためスキップ');

  test.beforeEach(async ({ page }) => {
    await page.route('https://iptv-org.github.io/api/*.json', (route) => {
      const name = route.request().url().split('/').pop();
      const file = path.join(REALDATA, name);
      if (fs.existsSync(file)) {
        return route.fulfill({
          path: file,
          contentType: 'application/json; charset=utf-8',
          headers: { 'access-control-allow-origin': '*' },
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' });
    });
    await page.route('https://cdn.jsdelivr.net/npm/hls.js@*/dist/hls.min.js', (route) =>
      route.fulfill({
        path: path.join(__dirname, 'fixtures', 'vendor', 'hls.min.js'),
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'access-control-allow-origin': '*' },
      })
    );
  });

  test('全世界のチャンネルが読み込まれ、検索・絞り込み・再生画面が機能する', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });

    // 規模の検証: ストリーム未登録も含む全チャンネル(約 4 万件)を表示する
    const totals = await page.evaluate(() => window.__IPTV__.state.data.totals);
    expect(totals.channels).toBeGreaterThan(30000);
    expect(totals.countries).toBeGreaterThan(100);

    // グリッドは遅延描画でも最初のチャンクが表示される
    await expect(page.locator('.card').first()).toBeVisible();
    const rendered = await page.locator('.card').count();
    expect(rendered).toBeLessThanOrEqual(60); // 一度に全件描画しない(性能ガード)

    // 検索
    await page.fill('#search', 'NHK');
    await expect
      .poll(() => page.locator('.card').count(), { timeout: 10000 })
      .toBeGreaterThan(0);
    // 検索は名前だけでなくネットワーク名・別名にもマッチするため、
    // 「NHK」を名前に含むカードが結果に含まれることを確認する
    await expect(page.locator('.card', { hasText: /NHK/i }).first()).toBeVisible();

    // 国絞り込み(日本)
    await page.fill('#search', '');
    await page.selectOption('#filter-country', 'JP');
    await expect
      .poll(() => page.locator('.card').count(), { timeout: 10000 })
      .toBeGreaterThan(10);

    // チャンネルを開くとプレイヤーが起動する(実ストリームへの接続可否は環境依存のため
    // 再生自体は検証せず、モーダルとステータス表示までを確認する)
    await page.locator('.card').first().click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-status')).not.toHaveText('');
    await page.locator('#player-close').click();

    // NSFW チャンネルも表示対象に含まれ、18+ バッジ用のフラグが立っている
    const nsfwCount = await page.evaluate(() => {
      const entries = window.__IPTV__.state.data.entries;
      return entries.filter((e) => e.isNsfw).length;
    });
    expect(nsfwCount).toBeGreaterThan(0);
  });

  /**
   * 本番の data/epg/(epg-data ブランチから展開したもの)がワークツリーにある
   * ときだけ走る。API はスナップショットを route で注入し、番組表はローカル
   * 配信の実データをそのまま読む — 本番相当の構成での確認になる。
   */
  test('番組タイトル検索が実スケール(945ch / 33,811 番組)でデバウンス内に収まる', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
    const epgLoaded = await page.evaluate(() => IPTVEpg.isLoaded());
    test.skip(!epgLoaded, 'data/epg/ が無いためスキップ(git fetch origin epg-data で展開できる)');

    const perf = await page.evaluate(() => {
      const entries = window.__IPTV__.state.data.entries;
      const measure = (q) => {
        const t0 = performance.now();
        let hits = 0;
        for (const e of entries) {
          const h = IPTVEpg.titleHaystack(e.key);
          if (h && h.indexOf(q) !== -1) hits++;
        }
        return { ms: performance.now() - t0, hits };
      };
      const cold = measure('news'); // 初回は照合文字列の構築を含む
      const warm = measure('football'); // 2 回目以降(キャッシュ済み)
      return { cold, warm, entries: entries.length, channels: IPTVEpg.getMeta().counts };
    });

    expect(perf.channels.channels).toBeGreaterThan(500);
    expect(perf.channels.programs).toBeGreaterThan(10000);
    expect(perf.cold.hits).toBeGreaterThan(0);
    // 検索デバウンスは 150ms。構築込みでも 1 回分の予算に収まる
    expect(perf.cold.ms).toBeLessThan(150);
    expect(perf.warm.ms).toBeLessThan(50);
    console.log(
      `番組タイトル検索: 初回 ${perf.cold.ms.toFixed(1)}ms (${perf.cold.hits} ch) / ` +
        `2 回目 ${perf.warm.ms.toFixed(1)}ms — ${perf.channels.channels}ch ・ ${perf.channels.programs} 番組`
    );

    // UI 経路でも実際に絞り込める
    await page.check('#prog-search');
    await page.fill('#search', 'football');
    await expect.poll(() => page.locator('.card').count(), { timeout: 10000 }).toBeGreaterThan(0);
    await expect(page.locator('.card-epg-hit').first()).toBeVisible();
  });

  test('実データの HTML 実体参照が画面に出ない(次回グラブ前でも復号される)', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
    const epgLoaded = await page.evaluate(() => IPTVEpg.isLoaded());
    test.skip(!epgLoaded, 'data/epg/ が無いためスキップ');

    const raw = await page.evaluate(() => {
      // 復号後のタイトルに実体参照らしき並びが残っていないことを全番組で確認する
      const re = /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/;
      const bad = [];
      for (const e of window.__IPTV__.state.data.entries) {
        const ch = IPTVEpg.get(e.key);
        if (!ch) continue;
        for (const p of ch.p) if (re.test(p[2])) bad.push(`${e.key}: ${p[2]}`);
      }
      return bad;
    });
    expect(raw).toEqual([]);
  });

  test('ザッピングが実データの一覧順で動く', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });

    await page.selectOption('#filter-country', 'JP');
    await expect.poll(() => page.locator('.card').count(), { timeout: 10000 }).toBeGreaterThan(10);
    const names = await page.evaluate(() => window.__IPTV__.state.filtered.slice(0, 3).map((e) => e.name));

    await page.locator('.card').first().click();
    await expect(page.locator('#player-title')).toHaveText(names[0]);
    await expect(page.locator('#player-prev')).toBeDisabled(); // 先頭
    await page.click('#player-next');
    await expect(page.locator('#player-title')).toHaveText(names[1]);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#player-title')).toHaveText(names[2]);
    await expect(page.locator('#player-pos')).toContainText('3 / ');
  });

  test('スクロールで追加チャンクが遅延描画される', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
    const before = await page.locator('.card').count();
    await page.locator('#sentinel').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.locator('.card').count(), { timeout: 10000 })
      .toBeGreaterThan(before);
  });
});

test.describe('実データ + ワイドビューポート', () => {
  test.skip(!AVAILABLE, 'tests/fixtures/realdata/ にスナップショットが無いためスキップ');
  test.use({ viewport: { width: 3000, height: 2000 } });

  test('広い画面でも最初のチャンクで止まらず画面が埋まるまで描画される', async ({ page }) => {
    test.slow();
    await page.route('https://iptv-org.github.io/api/*.json', (route) => {
      const name = route.request().url().split('/').pop();
      const file = path.join(REALDATA, name);
      if (fs.existsSync(file)) {
        return route.fulfill({ path: file, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' });
    });
    await page.route('https://cdn.jsdelivr.net/npm/hls.js@*/dist/hls.min.js', (route) =>
      route.fulfill({ path: path.join(__dirname, 'fixtures', 'vendor', 'hls.min.js'), contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 60000 });
    // 3000x2000 ではビューポート + 観測マージンを満たすまで複数チャンク描画される
    await expect
      .poll(() => page.locator('.card').count(), { timeout: 15000 })
      .toBeGreaterThan(120);
  });
});
