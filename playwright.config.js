'use strict';

const { defineConfig } = require('@playwright/test');

// 実 API を叩く live プロジェクトのみ、この実行環境の egress プロキシを経由させる
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || null;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 15000 },
  retries: 1,
  reporter: [['list']],
  webServer: {
    command: 'http-server -p 4173 -a 127.0.0.1 -c-1 --silent .',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    // 時刻・数値の表示は toLocale*() 経由でブラウザのタイムゾーン / ロケールに依存する。
    // 実行ホストの設定でテストが揺れないよう明示的に固定する
    // (page.clock は時刻を止めるがタイムゾーンまでは固定しない)
    timezoneId: 'UTC',
    locale: 'ja-JP',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    {
      name: 'hermetic',
      testIgnore: /live\.spec\.js/,
    },
    {
      name: 'live',
      testMatch: /live\.spec\.js/,
      use: {
        ignoreHTTPSErrors: true,
        proxy: proxyServer ? { server: proxyServer, bypass: 'localhost,127.0.0.1' } : undefined,
      },
    },
  ],
});
