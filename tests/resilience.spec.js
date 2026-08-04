'use strict';

/**
 * データ取得の障害耐性:
 *  - 任意エンドポイント (feeds/logos/languages) が落ちてもアプリは動く
 *  - 必須エンドポイントが落ちたらエラー画面 → 再試行で復帰し、フィルタ選択肢が重複しない
 */
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

test('任意エンドポイントの取得失敗時はロゴ・言語なしで動作する', async ({ page }) => {
  await routeApi(page);
  // routeApi より後に登録したルートが優先される
  for (const name of ['feeds', 'logos', 'languages']) {
    await page.route(`https://iptv-org.github.io/api/${name}.json`, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: 'not found', headers: { 'access-control-allow-origin': '*' } })
    );
  }
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(9);
  // 言語データが無いため言語フィルタは「すべての言語」のみ
  await expect(page.locator('#filter-language option')).toHaveCount(1);
  // ロゴが無いため全カードがプレースホルダー表示
  await expect(page.locator('.card-logo img')).toHaveCount(0);
  await expect(page.locator('.logo-placeholder')).toHaveCount(9);
});

test('必須エンドポイント失敗でエラー画面、再試行で復帰しフィルタが重複しない', async ({ page }) => {
  await routeApi(page);
  let failChannels = true;
  await page.route('https://iptv-org.github.io/api/channels.json', (route) => {
    if (failChannels) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: 'error', headers: { 'access-control-allow-origin': '*' } });
    }
    return route.fallback();
  });

  await page.goto('/');
  await expect(page.locator('#load-error')).toBeVisible();
  await expect(page.locator('#load-error-msg')).toContainText('channels.json');

  failChannels = false;
  await page.locator('#retry-btn').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(9);

  // 再試行後もフィルタ選択肢が重複していない
  const values = await page.$$eval('#filter-country option', (opts) => opts.map((o) => o.value));
  expect(values.length).toBe(new Set(values).size);
  await expect(page.locator('#filter-country option')).toHaveCount(6); // 全て + JP/US/FR/RU/不明
});
