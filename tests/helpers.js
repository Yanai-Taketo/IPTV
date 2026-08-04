'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 外部通信をすべてローカルフィクスチャに差し替える(ハーメチックテスト用)。
 *  - iptv-org API → tests/fixtures/api/*.json
 *  - hls.js CDN → tests/fixtures/vendor/hls.min.js(同一バイトなので SRI も通る)
 *  - https://fixture.test/hls/* → ローカル HLS フィクスチャ(実再生できる)
 *  - dead.fixture.test / insecure.fixture.test → 接続拒否(死んだ配信のシミュレーション)
 */
async function routeApi(page) {
  // キャッチオール: フィクスチャで扱わない外部リクエストは遮断して「漏れ」を顕在化させる。
  // Playwright は後から登録したルートを先に評価するため、最初に登録しておくと
  // 以降の個別ルートが優先され、どれにも一致しないものだけがここに落ちる。
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.continue();
    return route.abort();
  });

  await page.route('https://iptv-org.github.io/api/*.json', (route) => {
    const name = route.request().url().split('/').pop();
    const file = path.join(FIXTURES, 'api', name);
    if (fs.existsSync(file)) {
      return route.fulfill({
        path: file,
        contentType: 'application/json; charset=utf-8',
        headers: { 'access-control-allow-origin': '*' },
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '[]' });
  });

  await page.route('https://cdn.jsdelivr.net/npm/hls.js@*/dist/hls.min.js', (route) =>
    route.fulfill({
      path: path.join(FIXTURES, 'vendor', 'hls.min.js'),
      contentType: 'application/javascript; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
    })
  );

  await page.route('https://fixture.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/hls/')) {
      const file = path.join(FIXTURES, 'hls', path.basename(url.pathname));
      if (fs.existsSync(file)) {
        return route.fulfill({
          path: file,
          contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
          headers: { 'access-control-allow-origin': '*' },
        });
      }
    }
    if (url.pathname.startsWith('/media/')) {
      const file = path.join(FIXTURES, 'media', path.basename(url.pathname));
      if (fs.existsSync(file)) {
        return route.fulfill({ path: file, contentType: 'video/webm' });
      }
    }
    if (url.pathname.startsWith('/logos/')) {
      return route.fulfill({ body: PNG_1X1, contentType: 'image/png' });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });

  await page.route('https://dead.fixture.test/**', (route) => route.abort('connectionrefused'));
  await page.route('http://insecure.fixture.test/**', (route) => route.abort('connectionrefused'));
}

module.exports = { routeApi, FIXTURES };
