'use strict';

const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

test.describe('チャンネル一覧 UI', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('NSFW・ストリーム無しも含む全チャンネルがグリッドに表示される', async ({ page }) => {
    // 8 チャンネル + 孤児ストリーム 1 件 → 9 エントリ(除外なし)
    await expect(page.locator('.card')).toHaveCount(9);
    await expect(page.locator('#stats')).toHaveText('9 / 9 チャンネル');
    await expect(page.locator('.card', { hasText: 'NHK World Japan' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Orphan Stream' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Adult Channel' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'No Stream TV' })).toBeVisible();
  });

  test('配信なしチャンネルは最後に並び、専用バッジ + 淡色表示になる', async ({ page }) => {
    const ns = page.locator('.card', { hasText: 'No Stream TV' });
    await expect(ns.locator('.badge', { hasText: '配信なし' })).toBeVisible();
    await expect(ns).toHaveClass(/card-dead/);
    // 配信を持つチャンネルより後ろ(最後尾グループ)に並ぶ
    await expect(page.locator('.card-name').last()).toHaveText('No Stream TV');
  });

  test('NSFW チャンネルには 18+ バッジが付く', async ({ page }) => {
    const adult = page.locator('.card', { hasText: 'Adult Channel' });
    await expect(adult.locator('.badge', { hasText: '18+' })).toBeVisible();
    // NSFW でも配信があれば通常どおり再生対象(このフィクスチャでは配信あり)
    await expect(adult.locator('.badge', { hasText: '配信なし' })).toHaveCount(0);
  });

  test('配信なしチャンネルのプレイヤーは情報のみ表示(エラーにしない)', async ({ page }) => {
    await page.locator('.card', { hasText: 'No Stream TV' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-status')).toContainText('配信 URL は未登録');
    await expect(page.locator('#player-error')).toBeHidden();
    await page.click('#player-close');
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');
  });

  test('ランダム選局は配信なしチャンネルを選ばない', async ({ page }) => {
    await page.fill('#search', 'No Stream');
    await expect(page.locator('.card')).toHaveCount(1);
    await page.click('#shuffle-btn');
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');
  });

  test('テキスト検索(別名にもマッチ)', async ({ page }) => {
    await page.fill('#search', 'NHK');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('NHK World Japan');

    // alt_names(NHKワールド)でもヒットする
    await page.fill('#search', 'ワールド');
    await expect(page.locator('.card')).toHaveCount(1);

    await page.fill('#search', '');
    await expect(page.locator('.card')).toHaveCount(9);
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
    // HTTP のみの配信を持つチャンネルは消えるが、配信なしチャンネルには適用しない
    await expect(page.locator('.card')).toHaveCount(8);
    await expect(page.locator('.card', { hasText: 'Http Only TV' })).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'No Stream TV' })).toBeVisible();
  });

  test('並び順を国順に切り替えられる', async ({ page }) => {
    await expect(page.locator('.card-name').first()).toHaveText('Adult Channel'); // 名前順
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
