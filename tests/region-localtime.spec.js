'use strict';

/**
 * 地域(大陸・経済圏)フィルタ + チャンネル現地時刻表示のハーメチックテスト。
 * 時刻表示を検証するため擬似クロックを 2026-08-04T12:00:00Z で凍結する:
 *   Asia/Tokyo = 21:00(19–23 時)/ Europe/Moscow = 15:00 / America/New_York = 08:00
 *
 * regions.json フィクスチャ: Asia(JP,RU)・North America(US)・
 * Empty Region(FR: チャンネル 0 → 選択肢に出ない)・WW/UN(常に除外)
 */
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

const NOW = new Date('2026-08-04T12:00:00Z');

test.describe('地域フィルタ + 現地時刻', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW });
    await page.clock.pauseAt(NOW);
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('地域の選択肢: チャンネルのある地域のみ、WW/UN は出ない', async ({ page }) => {
    const region = page.locator('#filter-region');
    await expect(region).toBeVisible();
    const labels = await region.locator('option').allTextContents();
    expect(labels).toEqual(['すべての地域', 'Asia (3)', 'North America (3)']);
  });

  test('地域で絞り込める(国フィルタとは独立に併用可)', async ({ page }) => {
    await page.selectOption('#filter-region', 'ASIA');
    await expect(page.locator('.card')).toHaveCount(3); // JP 2 + RU 1
    await expect(page.locator('.card', { hasText: 'US News Channel' })).toHaveCount(0);

    // 地域 × 国の組み合わせ(Asia ∩ Japan = 2)
    await page.selectOption('#filter-country', 'JP');
    await expect(page.locator('.card')).toHaveCount(2);
  });

  test('カードとプレイヤーに現地時刻が表示される', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.card-local')).toHaveText(' · 現地 21:00');
    const us = page.locator('.card', { hasText: 'US News Channel' });
    await expect(us.locator('.card-local')).toHaveText(' · 現地 08:00');
    // タイムゾーン情報の無いチャンネル(孤児ストリーム)には表示しない
    await expect(page.locator('.card', { hasText: 'Orphan Stream' }).locator('.card-local')).toHaveCount(0);

    // 30 秒ごとの定期更新で時刻が追従する
    await page.clock.fastForward('01:00');
    await expect(nhk.locator('.card-local')).toHaveText(' · 現地 21:01');

    await nhk.click();
    await expect(page.locator('#player-meta')).toContainText('現地 21:01');
  });

  test('「現地 19–23 時」フィルタはゴールデンタイムのチャンネルだけを残す', async ({ page }) => {
    await expect(page.locator('#night-only-label')).toBeVisible();
    await page.check('#night-only');
    // 12:00 UTC 時点で 19–23 時なのは日本(21:00)のみ。tz 不明の孤児は対象外
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('.card', { hasText: 'NHK World Japan' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Multi Stream TV' })).toBeVisible();
  });
});

test.describe('地域・タイムゾーンデータが無い環境', () => {
  test('regions.json が 404 でも動作し、地域フィルタは現れない', async ({ page }) => {
    await routeApi(page);
    // routeApi より後に登録したルートが優先される(helpers.js 参照)
    await page.route('https://iptv-org.github.io/api/regions.json', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: 'not found' })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#filter-region')).toBeHidden();
    await expect(page.locator('.card')).toHaveCount(7);
  });

  test('feeds.json が 404 なら現地時刻 UI ごと消える(グレースフル)', async ({ page }) => {
    await routeApi(page);
    await page.route('https://iptv-org.github.io/api/feeds.json', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: 'not found' })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#night-only-label')).toBeHidden();
    await expect(page.locator('.card-local')).toHaveCount(0);
  });
});
