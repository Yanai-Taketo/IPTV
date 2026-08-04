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

    // 規模の検証: ストリームを持つチャンネルは 1 万件前後
    const totals = await page.evaluate(() => window.__IPTV__.state.data.totals);
    expect(totals.channels).toBeGreaterThan(5000);
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

    // NSFW チャンネルが含まれていない
    const nsfwLeak = await page.evaluate(() => {
      const entries = window.__IPTV__.state.data.entries;
      return entries.filter((e) => /xxx|porn|adult tv/i.test(e.name)).length;
    });
    expect(nsfwLeak).toBe(0);
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
