'use strict';

/**
 * テレビ欄(タイムライン)ビューのハーメチックテスト。
 * EPG フィクスチャ(tests/epg.spec.js 参照)を 2026-08-04T12:00:00Z の凍結時刻で使う。
 * 時間窓は 12:00(時境界に切り下げ)→ 18:00 の 6 時間:
 *   - NHK World Japan: 11:30–12:30(放送中・窓頭で切り詰め)/ 12:30–13:00 / 13:00–14:30
 *   - Multi Stream TV: 13:00–14:00
 *   - Http Only TV: 08:00–09:00(窓外 → 行ごと出ない)
 */
const path = require('path');
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

const NOW = new Date('2026-08-04T12:00:00Z');
const FIXTURES_EPG = path.join(__dirname, 'fixtures', 'epg');

async function routeEpg(page) {
  await page.route('**/data/epg/schedule.json', (route) =>
    route.fulfill({ path: path.join(FIXTURES_EPG, 'schedule.json'), contentType: 'application/json' })
  );
}

test.describe('テレビ欄(タイムライン)ビュー', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW });
    await page.clock.pauseAt(NOW);
    await routeApi(page);
    await routeEpg(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('切り替えボタンでカード一覧とテレビ欄を行き来できる', async ({ page }) => {
    const toggle = page.locator('#view-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText('テレビ欄で見る');

    await toggle.click();
    await expect(toggle).toHaveText('カード一覧に戻る');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#timeline')).toBeVisible();
    await expect(page.locator('#grid')).toBeHidden();

    await toggle.click();
    await expect(page.locator('#timeline')).toBeHidden();
    await expect(page.locator('#grid')).toBeVisible();
    await expect(page.locator('.card').first()).toBeVisible();
  });

  test('時間窓(今〜+6h)に番組がある行だけが番組ブロック付きで並ぶ', async ({ page }) => {
    await page.click('#view-toggle');

    // 窓内に番組があるのは NHK と Multi の 2 行(Http Only TV は全番組終了済み)
    await expect(page.locator('.tl-row')).toHaveCount(2);
    await expect(page.locator('.tl-row', { hasText: 'Http Only TV' })).toHaveCount(0);

    // 時刻目盛りは窓の開始 12:00 から 1 時間刻み
    await expect(page.locator('.tl-tick').first()).toHaveText('12:00');
    await expect(page.locator('.tl-tick')).toHaveCount(6);

    const nhk = page.locator('.tl-row', { hasText: 'NHK World Japan' });
    const blocks = nhk.locator('.tl-prog');
    await expect(blocks).toHaveCount(3);

    // 放送中の番組(11:30–12:30)は窓頭で切り詰められ、幅は 30 分 = 窓の 1/12
    const current = blocks.nth(0);
    await expect(current).toHaveClass(/tl-current/);
    await expect(current).toHaveAttribute('style', /left:\s*0(\.0+)?%/);
    await expect(current).toHaveAttribute('style', /width:\s*8\.33/);
    await expect(current).toContainText('World News Today');

    // 13:00–14:30 のブロックは left 1/6・幅 1/4
    const doc = blocks.nth(2);
    await expect(doc).toHaveAttribute('style', /left:\s*16\.66/);
    await expect(doc).toHaveAttribute('style', /width:\s*25(\.0+)?%/);
  });

  test('検索フィルタがテレビ欄の行にも適用される', async ({ page }) => {
    await page.click('#view-toggle');
    await page.fill('#search', 'NHK');
    await page.clock.fastForward(200); // 凍結クロックでは検索デバウンス(150ms)を手動で進める
    await expect(page.locator('.tl-row')).toHaveCount(1);
    await expect(page.locator('.tl-row', { hasText: 'NHK World Japan' })).toBeVisible();

    // 窓内に番組が無いチャンネルだけになると空メッセージを出す
    await page.fill('#search', 'Progressive');
    await page.clock.fastForward(200);
    await expect(page.locator('.tl-row')).toHaveCount(0);
    await expect(page.locator('#timeline-empty')).toBeVisible();
  });

  test('番組ブロックのクリックでそのチャンネルのプレイヤーが開く', async ({ page }) => {
    await page.click('#view-toggle');
    await page
      .locator('.tl-row', { hasText: 'NHK World Japan' })
      .locator('.tl-prog', { hasText: 'Asia Insight' })
      .click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
  });

  test('時間経過で現在時刻ラインと放送中ハイライトが追従する', async ({ page }) => {
    await page.click('#view-toggle');
    await expect(page.locator('.tl-body')).toHaveAttribute('style', /--now-pct:\s*0(\.0+)?[;\s]/);

    // 12:00 → 12:31: World News Today 終了、Asia Insight 放送中
    await page.clock.fastForward('31:00');
    const nhk = page.locator('.tl-row', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.tl-prog', { hasText: 'Asia Insight' })).toHaveClass(/tl-current/);
    await expect(nhk.locator('.tl-prog', { hasText: 'World News Today' })).not.toHaveClass(/tl-current/);
    // 31 分 / 6 時間 ≒ 8.6%
    await expect(page.locator('.tl-body')).toHaveAttribute('style', /--now-pct:\s*0\.086/);
  });
});

test.describe('テレビ欄(EPG が無い環境)', () => {
  test('EPG 404 では切り替えボタン自体が現れない', async ({ page }) => {
    await routeApi(page); // 既定で data/epg/* は 404
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#view-toggle')).toBeHidden();
    await expect(page.locator('#timeline')).toBeHidden();
  });
});
