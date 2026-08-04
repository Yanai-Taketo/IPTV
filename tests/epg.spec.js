'use strict';

/**
 * 番組表(EPG)連携のハーメチックテスト。
 * フィクスチャ(tests/fixtures/epg/)は 2026-08-04T12:00:00Z を「現在」として
 * 構成しているため、Playwright の擬似クロックをその時刻で完全に停止させる
 * (install だけでは実時間で進み続け、進捗バー等の完全一致が秒境界で flake する)。
 *
 * フィクスチャ構成(時刻は UTC。テストブラウザのタイムゾーンも UTC):
 *   - NHK World Japan (shard 2): 10:00–11:00 Morning Brief(終了済み)
 *       11:30–12:30 World News Today(放送中) / 12:30–13:00 Asia Insight
 *       13:00–14:30 Documentary Hour
 *   - Multi Stream TV (shard 1): 13:00–14:00 Evening Show(現在番組なし・次番組のみ)
 *   - Http Only TV (shard 0): 08:00–09:00 Old Show(全て終了済み = 提供期間外)
 *   - その他のチャンネル: 番組表なし
 */
const path = require('path');
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

const NOW = new Date('2026-08-04T12:00:00Z');
const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURES_EPG = path.join(FIXTURES, 'epg');

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

async function freezeClock(page) {
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
}

test.describe('番組表(EPG)連携', () => {
  test.beforeEach(async ({ page }) => {
    await freezeClock(page);
    await routeApi(page);
    await routeEpg(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('カードに現在番組・時間帯・進捗バーが表示される', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.card-epg-title')).toHaveText('▶ World News Today');
    await expect(nhk.locator('.card-epg-time')).toHaveText('11:30–12:30');
    // 11:30–12:30 の番組を 12:00(凍結時刻)に見ている → 進捗ちょうど 50%
    await expect(nhk.locator('.epg-bar i')).toHaveAttribute('style', /width:\s*50%/);

    // 現在番組が無いチャンネルは次番組を表示する
    const multi = page.locator('.card', { hasText: 'Multi Stream TV' });
    await expect(multi.locator('.card-epg-title')).toHaveText('次 13:00 Evening Show');

    // 全番組が終了済み(提供期間外)のチャンネルは EPG 行ごと隠れる
    const stale = page.locator('.card', { hasText: 'Http Only TV' });
    await expect(stale.locator('.card-epg')).toBeHidden();

    // 番組表が無いチャンネルには EPG 行自体が無い
    const us = page.locator('.card', { hasText: 'US News Channel' });
    await expect(us.locator('.card-epg')).toHaveCount(0);
  });

  test('番組境界を越えると表示が次の番組へ切り替わる', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await expect(nhk.locator('.card-epg-title')).toHaveText('▶ World News Today');
    // 12:00 → 12:31(30 秒間隔の定期更新が発火する)
    await page.clock.fastForward('31:00');
    await expect(nhk.locator('.card-epg-title')).toHaveText('▶ Asia Insight');
    await expect(nhk.locator('.card-epg-time')).toHaveText('12:30–13:00');
  });

  test('番組表ありのみフィルタ', async ({ page }) => {
    await expect(page.locator('#epg-only-label')).toBeVisible();
    await expect(page.locator('#epg-only-label')).toContainText('番組表ありのみ (3)');
    await page.check('#epg-only');
    await expect(page.locator('.card')).toHaveCount(3);
    await expect(page.locator('.card', { hasText: 'US News Channel' })).toHaveCount(0);
  });

  test('番組表の取得時刻がグリッドヘッダに表示される', async ({ page }) => {
    await expect(page.locator('#grid-head-note')).toContainText('番組表 8/4 10:00');
  });

  test('プレイヤーに現在番組・説明文・この後の番組が表示される(正しいシャードのみ取得)', async ({ page }) => {
    const detailRequests = [];
    page.on('request', (req) => {
      const m = req.url().match(/data\/epg\/(details-\d+\.json)/);
      if (m) detailRequests.push(m[1]);
    });

    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    const epg = page.locator('#player-epg');
    await expect(epg).toBeVisible();
    await expect(epg.locator('.player-epg-nowtitle')).toHaveText('▶ World News Today');
    await expect(epg.locator('.player-epg-nowtime')).toHaveText('11:30–12:30');
    // 説明文は詳細シャード(schedule.json に記録された shard 2)から遅延取得される
    await expect(epg.locator('#player-epg-desc')).toContainText('世界の主要ニュース');
    await expect(epg.locator('#player-epg-desc')).toContainText('Morning Edition');
    expect(detailRequests).toEqual(['details-2.json']); // 他シャードは取得しない

    // この後の番組リスト(終了済みと現在番組は含まない)
    const rows = epg.locator('.player-epg-list li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('12:30');
    await expect(rows.nth(0)).toContainText('Asia Insight');
    await expect(rows.nth(1)).toContainText('13:00');
    await expect(rows.nth(1)).toContainText('Documentary Hour');
  });

  test('提供期間外のチャンネルではプレイヤーにその旨が表示される', async ({ page }) => {
    await page.locator('.card', { hasText: 'Http Only TV' }).click();
    const epg = page.locator('#player-epg');
    await expect(epg).toBeVisible();
    await expect(epg.locator('.player-epg-note')).toContainText('提供期間外');
    await expect(epg.locator('.player-epg-nowtitle')).toHaveCount(0);
  });

  test('詳細シャードの取得に失敗しても番組表は表示される', async ({ page }) => {
    // 上書き: details-2.json だけを 404 にする
    await page.route('**/data/epg/details-2.json', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: 'not found' })
    );
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    const epg = page.locator('#player-epg');
    await expect(epg).toBeVisible();
    await expect(epg.locator('.player-epg-nowtitle')).toHaveText('▶ World News Today');
    await expect(epg.locator('#player-epg-desc')).toBeHidden();
    await expect(epg.locator('.player-epg-list li')).toHaveCount(2);
  });

  test('番組表の無いチャンネルではプレイヤーの EPG パネルが出ない', async ({ page }) => {
    await page.locator('.card', { hasText: 'US News Channel' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-epg')).toBeHidden();
  });
});

test.describe('番組表(EPG)+ 再生可能性インデックス併用(本番構成)', () => {
  test.beforeEach(async ({ page }) => {
    await freezeClock(page);
    await routeApi(page);
    await routeEpg(page);
    await page.route('**/data/playability.json', (route) =>
      route.fulfill({ path: path.join(FIXTURES, 'playability.json'), contentType: 'application/json' })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('グリッドヘッダに再生確認と番組表の両方の時刻が並ぶ', async ({ page }) => {
    await expect(page.locator('#grid-head-note')).toContainText('再生確認');
    await expect(page.locator('#grid-head-note')).toContainText('番組表');
  });

  test('再生確認済みのみ + 番組表ありのみを同時に適用できる', async ({ page }) => {
    await page.check('#checked-only');
    await page.check('#epg-only');
    // 交差 = NHK(確認済み+EPG)と Multi Stream TV(確認済み+EPG)。
    // Http Only TV は EPG ありだが未確認(status 2)なので落ちる
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('.card', { hasText: 'Http Only TV' })).toHaveCount(0);
  });
});

test.describe('番組表(EPG)が無い環境', () => {
  test('schedule.json が 404 でもアプリは通常動作し EPG UI は現れない', async ({ page }) => {
    await routeApi(page); // 既定で data/epg/* は 404
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('.card-epg')).toHaveCount(0);
    await expect(page.locator('#epg-only-label')).toBeHidden();
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-epg')).toBeHidden();
  });
});
