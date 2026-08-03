'use strict';

/**
 * 実際の iptv-org API に対するスモークテスト。
 * ネットワーク(egress ポリシー)の都合で API に届かない環境では自動スキップする。
 */
const { test, expect } = require('@playwright/test');

test('実 API から全世界のチャンネル一覧を読み込める @live', async ({ page }) => {
  test.slow();
  await page.goto('/');
  try {
    await expect(page.locator('#app')).toBeVisible({ timeout: 120000 });
  } catch (err) {
    if (await page.locator('#load-error').isVisible()) {
      test.skip(true, 'ネットワーク到達不可のため live テストをスキップ');
    }
    throw err;
  }
  const totals = await page.evaluate(() => window.__IPTV__.state.data.totals);
  expect(totals.channels).toBeGreaterThan(3000);
  expect(totals.countries).toBeGreaterThan(100);
  await expect(page.locator('.card').first()).toBeVisible();

  // 検索がライブデータでも機能する
  await page.fill('#search', 'NHK');
  await expect
    .poll(() => page.locator('.card').count(), { timeout: 10000 })
    .toBeGreaterThan(0);
});
