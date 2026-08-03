'use strict';

const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

test.describe('チャンネル一覧 UI', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('ストリームを持つチャンネルだけがグリッドに表示される', async ({ page }) => {
    // 7 チャンネル中: NSFW 1 件・ストリーム無し 1 件を除外し、孤児ストリーム 1 件を追加 → 6 エントリ
    await expect(page.locator('.card')).toHaveCount(6);
    await expect(page.locator('#stats')).toHaveText('6 / 6 チャンネル');
    await expect(page.locator('.card', { hasText: 'NHK World Japan' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Orphan Stream' })).toBeVisible();
  });

  test('NSFW チャンネルとストリーム無しチャンネルは表示されない', async ({ page }) => {
    await expect(page.locator('.card', { hasText: 'Adult Channel' })).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'No Stream TV' })).toHaveCount(0);
  });

  test('テキスト検索(別名にもマッチ)', async ({ page }) => {
    await page.fill('#search', 'NHK');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('NHK World Japan');

    // alt_names(NHKワールド)でもヒットする
    await page.fill('#search', 'ワールド');
    await expect(page.locator('.card')).toHaveCount(1);

    await page.fill('#search', '');
    await expect(page.locator('.card')).toHaveCount(6);
  });

  test('国・カテゴリ・言語での絞り込み', async ({ page }) => {
    await page.selectOption('#filter-country', 'JP');
    await expect(page.locator('.card')).toHaveCount(2);

    await page.selectOption('#filter-country', '');
    await page.selectOption('#filter-category', 'news');
    await expect(page.locator('.card')).toHaveCount(2);

    // 未分類(categories が空のチャンネル + 孤児ストリーム)
    await page.selectOption('#filter-category', '__uncategorized');
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('.card', { hasText: 'Http Only TV' })).toBeVisible();

    await page.selectOption('#filter-category', '');
    await page.selectOption('#filter-language', 'jpn');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('Multi Stream TV');
  });

  test('HTTPS のみフィルタで HTTP 配信だけのチャンネルが消える', async ({ page }) => {
    // http ページ配信なので初期状態ではオフ
    await expect(page.locator('#https-only')).not.toBeChecked();
    await page.check('#https-only');
    await expect(page.locator('.card')).toHaveCount(5);
    await expect(page.locator('.card', { hasText: 'Http Only TV' })).toHaveCount(0);
  });

  test('並び順を国順に切り替えられる', async ({ page }) => {
    await expect(page.locator('.card-name').first()).toHaveText('Http Only TV'); // 名前順
    await page.selectOption('#sort-order', 'country');
    await expect(page.locator('.card-name').first()).toHaveText('Multi Stream TV'); // Japan が先頭
  });

  test('ロゴ取得失敗時はプレースホルダーに置き換わる', async ({ page }) => {
    // フィクスチャのロゴは 1x1 PNG を返すため NHK は img、それ以外はプレースホルダー
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.card-logo img')).toHaveCount(1);
    const multi = page.locator('.card', { hasText: 'Multi Stream TV' });
    await expect(multi.locator('.logo-placeholder')).toHaveCount(1);
  });

  test('ディープリンク (#play=) でプレイヤーが開く', async ({ page }) => {
    await page.goto('/#play=NHKWorldJapan.jp');
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
  });
});
