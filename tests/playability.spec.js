'use strict';

/**
 * 再生可能性インデックス (data/playability.json) 連携:
 *  - ✓ 確認済バッジ / 応答なし表示
 *  - 「再生確認済みのみ」フィルタ
 *  - 確認済みストリームを優先する並び替え(エントリ内・一覧)
 * インデックスが無い場合の挙動は既存テスト(routeApi 既定の 404)でカバー済み。
 */
const path = require('path');
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

test.describe('再生可能性インデックス連携', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.route('**/data/playability.json', (route) =>
      route.fulfill({
        path: path.join(__dirname, 'fixtures', 'playability.json'),
        contentType: 'application/json',
      })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('確認済みバッジと応答なし表示', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.badge.ok')).toHaveText('✓ 確認済');

    const us = page.locator('.card', { hasText: 'US News Channel' });
    await expect(us.locator('.badge.dead')).toHaveText('応答なし');
    await expect(us).toHaveClass(/card-dead/);
  });

  test('再生確認済みのみフィルタ', async ({ page }) => {
    // ok = NHK / Multi(バックアップが確認済)/ Progressive / Orphan / Adult(NHK と同一 URL)の 5 件
    await expect(page.locator('#checked-only-label')).toBeVisible();
    await page.check('#checked-only');
    await expect(page.locator('.card')).toHaveCount(5);
    await expect(page.locator('.card', { hasText: 'US News Channel' })).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'Http Only TV' })).toHaveCount(0);
  });

  test('一覧は確認済み → 未確認 → 応答なし → 配信なしの順に並ぶ', async ({ page }) => {
    await expect(page.locator('.card-name').first()).toHaveText('Adult Channel'); // 確認済み内で名前順
    await expect(page.locator('.card-name').last()).toHaveText('No Stream TV'); // 配信なしは最後尾
    // 応答なし(dead)は配信なしグループの直前
    await expect(page.locator('.card-name').nth(-2)).toHaveText('US News Channel');
  });

  test('チャンネル内では確認済みストリームを最初に試す', async ({ page }) => {
    // Multi Stream TV: 死んでいる 1080p (status 0) より確認済み WebM (status 1) が先に来る
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await expect(page.locator('.variant-btn').nth(0)).toContainText('Backup');
    await expect(page.locator('.variant-btn').nth(0)).toHaveClass(/active/);
    // フォールバック無しで即座に再生が始まる
    await expect(page.locator('#player-status')).toContainText('再生中', { timeout: 20000 });
    await expect(page.locator('.variant-btn.failed')).toHaveCount(0);
  });

  test('確認時刻がグリッドヘッダに表示される', async ({ page }) => {
    await expect(page.locator('#grid-head-note')).toContainText('再生確認');
  });
});
