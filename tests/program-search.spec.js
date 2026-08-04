'use strict';

/**
 * 番組タイトル検索(「番組名も検索」)のハーメチックテスト。
 * EPG フィクスチャ(tests/epg.spec.js 参照)を 2026-08-04T12:00:00Z の凍結時刻で使う。
 * 検索語のうちチャンネル情報で拾えなかったトークンだけを番組表に当てる:
 *   - "documentary" … どのチャンネル名にも無く NHK の 13:00–14:30 のみに一致
 *   - "marathon"    … Multi Stream TV の 20:00–21:00「Half &amp; Half Marathon」に一致
 *                     (配信データが未復号のままでも実体参照を解いて扱う)
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
  for (const shard of [1, 2]) {
    await page.route(`**/data/epg/details-${shard}.json`, (route) =>
      route.fulfill({ path: path.join(FIXTURES_EPG, `details-${shard}.json`), contentType: 'application/json' })
    );
  }
}

/** 凍結クロックでは検索デバウンス(150ms)を手で進める */
async function search(page, q) {
  await page.fill('#search', q);
  await page.clock.fastForward(200);
}

async function setupAt(page, now) {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await routeApi(page);
  await routeEpg(page);
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
}

test.describe('番組タイトル検索', () => {
  test.beforeEach(async ({ page }) => {
    await setupAt(page, NOW);
  });

  test('トグルは番組表がある環境にだけ出る', async ({ page }) => {
    await expect(page.locator('#prog-search-label')).toBeVisible();
    await expect(page.locator('#prog-search')).not.toBeChecked();
  });

  test('オフのままでは番組名に一致しても絞り込まれない', async ({ page }) => {
    await search(page, 'documentary');
    await expect(page.locator('.card')).toHaveCount(0);
    await expect(page.locator('#empty')).toBeVisible();
  });

  test('オンにすると番組名でチャンネルが見つかる', async ({ page }) => {
    await page.check('#prog-search');
    await search(page, 'documentary');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('NHK World Japan');

    // どの番組で一致したのかがカードに出る(現在番組とは別行)
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.card-epg-title').first()).toHaveText('▶ World News Today');
    await expect(nhk.locator('.card-epg-hit')).toHaveText('🔍 13:00 Documentary Hour');
  });

  test('チャンネル名と番組名のトークンを混ぜて絞り込める', async ({ page }) => {
    await page.check('#prog-search');
    // "japan"(チャンネル情報)+ "documentary"(番組名)の AND
    await search(page, 'japan documentary');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('NHK World Japan');

    // チャンネル側で外れると番組名が一致しても残らない
    await search(page, 'france documentary');
    await expect(page.locator('.card')).toHaveCount(0);
  });

  test('番組表を持たないチャンネルは番組名検索の対象外', async ({ page }) => {
    await page.check('#prog-search');
    await search(page, 'documentary hour');
    await expect(page.locator('.card')).toHaveCount(1);
    // 番組表のある 4 局以外(US News Channel など)は一切現れない
    await expect(page.locator('.card', { hasText: 'US News Channel' })).toHaveCount(0);
  });

  test('オフに戻すと番組名の一致表示も消える', async ({ page }) => {
    await page.check('#prog-search');
    await search(page, 'documentary');
    await expect(page.locator('.card-epg-hit')).toHaveCount(1);
    await page.uncheck('#prog-search');
    await expect(page.locator('.card')).toHaveCount(0);

    await search(page, 'nhk');
    await expect(page.locator('.card-epg-hit')).toHaveCount(0);
  });

  test('テレビ欄では一致した番組ブロックが目印付きで示される', async ({ page }) => {
    await page.check('#prog-search');
    await search(page, 'documentary');
    await page.click('#view-toggle');

    await expect(page.locator('.tl-row')).toHaveCount(1);
    const blocks = page.locator('.tl-prog');
    await expect(blocks).toHaveCount(3); // 窓内の 3 番組はすべて描かれる
    const hit = page.locator('.tl-prog', { hasText: 'Documentary Hour' });
    await expect(hit).toHaveClass(/tl-match/);
    await expect(hit.locator('.tl-prog-time')).toHaveText('🔍 13:00');
    await expect(hit).toHaveAttribute('title', /^検索一致 ・ 13:00–14:30 Documentary Hour$/);
    // 一致しない番組には目印が付かない
    await expect(page.locator('.tl-prog', { hasText: 'Asia Insight' })).not.toHaveClass(/tl-match/);
  });

  test('番組名検索の状態は絞り込みバッジに数えられる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#filters-toggle');
    await page.check('#prog-search');
    await expect(page.locator('#filters-toggle')).toContainText('絞り込み (1)');
    await page.uncheck('#prog-search');
    await expect(page.locator('#filters-toggle')).not.toContainText('(');
  });
});

test.describe('番組タイトルの HTML 実体参照', () => {
  test('未復号のまま配信されたタイトルでも検索・表示が壊れない', async ({ page }) => {
    await setupAt(page, NOW);
    await page.check('#prog-search');

    // 生データは "Half &amp; Half Marathon"。復号しないと "& half" は一致しない
    await search(page, '& half');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('Multi Stream TV');
    // 表示も復号済み(実体参照が画面に出ない)
    await expect(page.locator('.card-epg-hit')).toHaveText('🔍 20:00 Half & Half Marathon');
  });

  test('プレイヤーの現在番組と説明文も復号される(詳細シャードとの突き合わせも成立)', async ({ page }) => {
    // 20:30 に凍結: Multi Stream TV の 20:00–21:00 が放送中
    await setupAt(page, new Date('2026-08-04T20:30:00Z'));
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    const epg = page.locator('#player-epg');
    await expect(epg.locator('.player-epg-nowtitle')).toHaveText('▶ Half & Half Marathon');
    // 詳細シャード側のタイトルも復号しないとこの行は見つからない
    await expect(epg.locator('#player-epg-desc')).toHaveText('Music — Rock & roll のマラソン上映。');
  });

  test('復号ロジック: 数値参照・未知の実体・サロゲート単体', async ({ page }) => {
    await setupAt(page, NOW);
    expect(await page.evaluate(() => [
      IPTVEpg.decodeEntities('Half &amp; Half'),
      IPTVEpg.decodeEntities('AT&#38;T &#x26; Co'),
      IPTVEpg.decodeEntities('&hellip; &hearts; &amp'), // 表に無い実体・; 無しは残す
      IPTVEpg.decodeEntities('&#xD800; &#0; &#1114112;'), // 復号すると壊れる値は残す
      IPTVEpg.decodeEntities('&amp;amp;'), // 二重符号化は 1 回だけ解く
      IPTVEpg.decodeEntities('plain text'),
    ])).toEqual([
      'Half & Half',
      'AT&T & Co',
      '… &hearts; &amp',
      '&#xD800; &#0; &#1114112;',
      '&amp;',
      'plain text',
    ]);
  });
});

test.describe('番組タイトル検索(EPG が無い環境)', () => {
  test('トグル自体が現れず、通常のチャンネル検索は動く', async ({ page }) => {
    await routeApi(page); // 既定で data/epg/* は 404
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#prog-search-label')).toBeHidden();
    await page.fill('#search', 'NHK');
    await expect(page.locator('.card')).toHaveCount(1);
  });
});
