'use strict';

/**
 * モバイルでのフィルタ折りたたみ(ヘッダー圧縮)のハーメチックテスト。
 * 狭い画面ではフィルタ群を「絞り込み」トグルに畳み、検索 + ボタン行だけを
 * 常時表示する。デスクトップでは従来どおり全フィルタをインライン表示する。
 */
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

test.describe('モバイル: フィルタ折りたたみ', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('フィルタは折りたたまれ、ヘッダーはデータ部を圧迫しない', async ({ page }) => {
    await expect(page.locator('#filters-toggle')).toBeVisible();
    await expect(page.locator('#filter-country')).toBeHidden();
    await expect(page.locator('#https-only')).toBeHidden();
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('#shuffle-btn')).toBeVisible();

    // 固定ヘッダーは画面(844px)の 1/3 未満に収まり、最初のカードが初期画面に入る
    const masthead = await page.locator('.masthead').boundingBox();
    expect(masthead.height).toBeLessThan(260);
    const firstCard = await page.locator('.card').first().boundingBox();
    expect(firstCard.y).toBeLessThan(844 / 2);
  });

  test('トグルで開閉でき、閉じてもフィルタは効いたまま', async ({ page }) => {
    const toggle = page.locator('#filters-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#filter-country')).toBeVisible();

    await page.selectOption('#filter-country', 'JP');
    await expect(page.locator('#stats')).toHaveText('2 / 9 チャンネル');
    await expect(toggle).toContainText('絞り込み (1)');

    await toggle.click();
    await expect(page.locator('#filter-country')).toBeHidden();
    // 畳んでも絞り込みは維持され、件数バッジで状態が分かる
    await expect(page.locator('#stats')).toHaveText('2 / 9 チャンネル');
    await expect(toggle).toContainText('絞り込み (1)');
  });

  test('複数フィルタの適用数がトグルに表示される', async ({ page }) => {
    await page.click('#filters-toggle');
    await page.selectOption('#filter-country', 'US');
    await page.check('#fav-only');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (2)');
    // HTTPS のみは http ページでは既定オフ → オンにすると差分として数える
    await page.check('#https-only');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (3)');
  });
});

test.describe('デスクトップ: フィルタは常時表示', () => {
  test('トグルは現れず、全フィルタがインラインに並ぶ', async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#filters-toggle')).toBeHidden();
    await expect(page.locator('#filter-country')).toBeVisible();
    await expect(page.locator('#https-only')).toBeVisible();
    await expect(page.locator('#sort-order')).toBeVisible();
  });
});
