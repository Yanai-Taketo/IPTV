'use strict';

/**
 * モバイルでのフィルタ折りたたみ(ヘッダー圧縮)のハーメチックテスト。
 * 狭い画面ではフィルタ群を「絞り込み」トグルに畳み、検索 + ボタン行だけを
 * 常時表示する。デスクトップでは従来どおり全フィルタをインライン表示する。
 */
const path = require('path');
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

const FIXTURES_EPG = path.join(__dirname, 'fixtures', 'epg');
const EPG_NOW = new Date('2026-08-04T12:00:00Z');

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

  test('複数フィルタの適用数がトグルに表示される(解除で減る)', async ({ page }) => {
    await page.click('#filters-toggle');
    await page.selectOption('#filter-country', 'US');
    await page.check('#fav-only');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (2)');
    // HTTPS のみは http ページでは既定オフ → オンにすると差分として数える
    await page.check('#https-only');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (3)');

    // 解除すると減り、全部戻すと件数表示自体が消える
    await page.uncheck('#https-only');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (2)');
    await page.uncheck('#fav-only');
    await page.selectOption('#filter-country', '');
    await expect(page.locator('#filters-toggle')).not.toContainText('(');
  });

  test('開いたパネルは検索行と左端が揃う(区切り線のはみ出しガード)', async ({ page }) => {
    await page.click('#filters-toggle');
    const search = await page.locator('#search').boundingBox();
    const country = await page.locator('#filter-country').boundingBox();
    expect(country.x).toBe(search.x);
  });

  test('トグルのアクセシブルネームに装飾矢印が混入しない', async ({ page }) => {
    const toggle = page.locator('#filters-toggle');
    // 開閉状態は aria-expanded が伝えるので、読み上げ名に ▾/▴ を含めない
    await expect(toggle).toHaveAccessibleName('絞り込み');
    await toggle.click();
    await page.check('#fav-only');
    await expect(toggle).toHaveAccessibleName('絞り込み (1)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('モバイル + 番組表(本番構成)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    // EPG があると常時表示行に「テレビ欄で見る」が加わり、パネルのフィルタも 1 つ増える
    await page.clock.install({ time: EPG_NOW });
    await page.clock.pauseAt(EPG_NOW);
    await routeApi(page);
    await page.route('**/data/epg/schedule.json', (route) =>
      route.fulfill({ path: path.join(FIXTURES_EPG, 'schedule.json'), contentType: 'application/json' })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('ボタンが 1 つ増えてもヘッダーはデータ部を圧迫しない', async ({ page }) => {
    await expect(page.locator('#view-toggle')).toBeVisible();
    await expect(page.locator('#shuffle-btn')).toBeVisible();
    await expect(page.locator('#filters-toggle')).toBeVisible();

    const masthead = await page.locator('.masthead').boundingBox();
    expect(masthead.height).toBeLessThan(260);
    const firstCard = await page.locator('.card').first().boundingBox();
    expect(firstCard.y).toBeLessThan(844 / 2);
  });

  test('番組表フィルタもパネル内に畳まれ、適用数に数えられる', async ({ page }) => {
    await expect(page.locator('#epg-only-label')).toBeHidden();
    await page.click('#filters-toggle');
    await expect(page.locator('#epg-only-label')).toBeVisible();
    await page.check('#epg-only');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (1)');
    await expect(page.locator('.card')).toHaveCount(3);
  });

  test('畳んだ状態からテレビ欄ビューへ切り替えられる', async ({ page }) => {
    await page.click('#view-toggle');
    await expect(page.locator('#timeline')).toBeVisible();
    await expect(page.locator('.tl-row').first()).toBeVisible();
    // ビューを変えてもフィルタは畳まれたまま(ヘッダーは圧縮されたまま)
    await expect(page.locator('#filter-country')).toBeHidden();
  });
});

test.describe('デスクトップ: フィルタは常時表示', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('トグルは現れず、全フィルタがインラインに並ぶ', async ({ page }) => {
    await expect(page.locator('#filters-toggle')).toBeHidden();
    await expect(page.locator('#filter-country')).toBeVisible();
    await expect(page.locator('#https-only')).toBeVisible();
    await expect(page.locator('#sort-order')).toBeVisible();
  });

  test('視覚順は 検索 → フィルタ → ボタン のまま(折りたたみ導入の回帰ガード)', async ({ page }) => {
    // 読み順(上の行 → 同一行なら左)でフィルタ群がボタンより先に来る
    // (幅によってはボタンが次の行へ折り返すため、行 → 列の順で比較する)
    const country = await page.locator('#filter-country').boundingBox();
    const shuffle = await page.locator('#shuffle-btn').boundingBox();
    const before =
      country.y < shuffle.y || (country.y === shuffle.y && country.x < shuffle.x);
    expect(before).toBe(true);
  });

  test('Tab のフォーカス順が視覚順と一致する(検索の次はフィルタ群)', async ({ page }) => {
    await page.locator('#search').focus();
    await page.keyboard.press('Tab');
    // 非表示のトグルは飛ばされ、視覚上隣の国フィルタへ移る(ボタンへ飛ばない)
    await expect(page.locator('#filter-country')).toBeFocused();
  });
});
