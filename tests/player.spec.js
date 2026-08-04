'use strict';

const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

async function currentTime(page) {
  return page.evaluate(() => document.getElementById('player-video').currentTime);
}

test.describe('プレイヤー', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('HLS 再生パイプライン: マニフェスト解析とセグメント取得が行われる', async ({ page }) => {
    // 注: Playwright 同梱の Chromium には H.264/AAC デコーダが無いため、
    // hls.js のネットワーク層(マニフェスト→セグメント取得)までを検証し、
    // 最終状態は「再生中」(コーデック対応環境) or「メディアエラー」(非対応環境)の
    // いずれかであることを確認する。
    const segRequest = page.waitForRequest('https://fixture.test/hls/seg0.ts', { timeout: 20000 });
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await segRequest; // マニフェストが解析されセグメント取得まで到達した
    await expect(page.locator('#player-status')).toContainText(/再生中|メディアエラー/, { timeout: 30000 });
  });

  test('プログレッシブ配信 (WebM) が実際に再生される', async ({ page }) => {
    await page.locator('.card', { hasText: 'Progressive TV' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-status')).toContainText('再生中', { timeout: 20000 });
    await expect.poll(() => currentTime(page), { timeout: 20000 }).toBeGreaterThan(0.5);
    // 実際に映像がデコードされている
    const width = await page.evaluate(() => document.getElementById('player-video').videoWidth);
    expect(width).toBeGreaterThan(0);
  });

  test('死んだ配信は自動で次のソースにフォールバックして再生される', async ({ page }) => {
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    // 1 本目 (1080p, dead) が失敗 → 2 本目 (480p, WebM backup) で再生
    await expect(page.locator('.variant-btn').nth(0)).toHaveClass(/failed/, { timeout: 30000 });
    await expect(page.locator('.variant-btn').nth(1)).toHaveClass(/active/);
    await expect.poll(() => currentTime(page), { timeout: 20000 }).toBeGreaterThan(0.5);
  });

  test('全ソース失敗でエラーパネルとフォールバック操作が表示される', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.card', { hasText: 'US News Channel' }).click();
    await expect(page.locator('#player-error')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#player-status')).toContainText('✕');

    // URL コピー
    const copyBtn = page.locator('#player-error-actions button', { hasText: 'コピー' });
    await copyBtn.click();
    await expect(copyBtn).toContainText('コピーしました');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe('https://dead.fixture.test/us.m3u8');

    // .m3u ダウンロードリンク
    const m3u = page.locator('#player-error-actions a', { hasText: '.m3u' });
    await expect(m3u).toHaveAttribute('download', /US News Channel\.m3u/);
  });

  test('閉じるボタンでモーダルが閉じ、URL ハッシュも消える', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    expect(page.url()).toContain('#play=');
    await page.locator('#player-close').click();
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');
    // dialog の close イベントは仕様上タスクキュー経由(非同期)のため、
    // ハッシュ除去はクリック直後ではなくポーリングで検証する
    await expect.poll(() => page.url()).not.toContain('#play=');
  });

  test('URL 分類ロジック(混在コンテンツ / DASH / 非対応プロトコル)', async ({ page }) => {
    const results = await page.evaluate(() => ({
      httpsOnHttps: IPTVPlayer.classifyUrl('https://a.example/s.m3u8', true),
      httpOnHttps: IPTVPlayer.classifyUrl('http://a.example/s.m3u8', true),
      httpOnHttp: IPTVPlayer.classifyUrl('http://a.example/s.m3u8', false),
      dash: IPTVPlayer.classifyUrl('https://a.example/manifest.mpd', false),
      rtmp: IPTVPlayer.classifyUrl('rtmp://a.example/live', false),
      invalid: IPTVPlayer.classifyUrl('not a url', false),
      noExt: IPTVPlayer.classifyUrl('https://a.example/live/abc', false),
    }));
    expect(results.httpsOnHttps).toBe('hls');
    expect(results.httpOnHttps).toBe('mixed-content');
    expect(results.httpOnHttp).toBe('hls');
    expect(results.dash).toBe('dash');
    expect(results.rtmp).toBe('unsupported-protocol');
    expect(results.invalid).toBe('invalid');
    expect(results.noExt).toBe('hls');
  });

  test('DASH 配信は dash.js の読み込み失敗時にエラー処理へフォールバックする', async ({ page }) => {
    // キャッチオールルートが dash.js CDN を遮断するため、読み込み失敗 → 全ソース失敗の経路を通る
    await page.locator('.card', { hasText: 'ZZ Dash TV' }).click();
    await expect(page.locator('#player-status')).toContainText('dash.js の読み込みに失敗しました', { timeout: 20000 });
    await expect(page.locator('#player-error')).toBeVisible();
  });

  test('公式サイトのリンクは再生できるチャンネルにも常設される', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    const site = page.locator('#player-site');
    await expect(site).toBeVisible();
    await expect(site).toHaveText('公式サイトを開く');
    await expect(site).toHaveAttribute('href', 'https://www3.nhk.or.jp/nhkworld/');
    await expect(site).toHaveAttribute('target', '_blank');
    await expect(site).toHaveAttribute('rel', /noopener/);
  });

  test('配信なしチャンネルでも公式サイトのリンクが出る', async ({ page }) => {
    await page.locator('.card', { hasText: 'No Stream TV' }).click();
    await expect(page.locator('#player-status')).toContainText('配信 URL は未登録');
    await expect(page.locator('#player-site')).toHaveAttribute('href', 'https://nostream.example/watch');
  });

  test('website が無いチャンネルではリンクを出さず、切り替え時に持ち越さない', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await expect(page.locator('#player-site')).toBeVisible();
    await page.click('#player-close');
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');

    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-site')).toHaveCount(0);
  });

  test('http(s) 以外の website は無視する', async ({ page }) => {
    await page.locator('.card', { hasText: 'Http Only TV' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-site')).toHaveCount(0);
  });

  test('全ソース失敗時もリンクは 1 つだけ(エラーパネルに重複しない)', async ({ page }) => {
    await page.locator('.card', { hasText: 'US News Channel' }).click();
    await expect(page.locator('#player-error')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#player-site')).toHaveAttribute('href', 'https://usnews.example/live');
    await expect(page.locator('a', { hasText: '公式サイトを開く' })).toHaveCount(1);
    await expect(page.locator('#player-error-actions a', { hasText: '公式サイト' })).toHaveCount(0);
  });

  test('ランダム再生ボタンでプレイヤーが開く', async ({ page }) => {
    await page.locator('#shuffle-btn').click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
  });
});
