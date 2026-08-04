'use strict';

/**
 * ザッピング(前/次選局)+ Media Session API + キーボードショートカットの
 * ハーメチックテスト。
 *
 * 巡回する並びは state.filtered そのもの(お気に入り先頭・並べ替え・フィルタが
 * 効いた「画面に見えている順」)。フィクスチャの既定(名前順)は 9 件:
 *   1 Adult Channel / 2 Http Only TV / 3 Multi Stream TV / 4 NHK World Japan /
 *   5 Orphan Stream / 6 Progressive TV / 7 US News Channel / 8 ZZ Dash TV /
 *   9 No Stream TV(配信なしは最後尾グループ)
 */
const path = require('path');
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

const FIXTURES_EPG = path.join(__dirname, 'fixtures', 'epg');
const EPG_NOW = new Date('2026-08-04T12:00:00Z');

/**
 * Media Session のアクションハンドラは外から発火させる API が無いため、
 * 登録されたハンドラを記録してテストから呼べるようにする。
 * 併せて requestFullscreen も記録用に差し替える(ヘッドレスでは実際に
 * 全画面化できないため、配線されていることだけを検証する)。
 */
async function instrument(page) {
  await page.addInitScript(() => {
    window.__mediaHandlers = {};
    const orig = navigator.mediaSession && navigator.mediaSession.setActionHandler;
    if (orig) {
      navigator.mediaSession.setActionHandler = function (action, handler) {
        window.__mediaHandlers[action] = handler;
        return orig.call(navigator.mediaSession, action, handler);
      };
    }
    window.__fullscreenCalls = [];
    Element.prototype.requestFullscreen = function () {
      window.__fullscreenCalls.push(this.id || this.tagName);
      return Promise.resolve();
    };
  });
}

test.describe('ザッピング(前/次選局)', () => {
  test.beforeEach(async ({ page }) => {
    await instrument(page);
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('プレイヤーの前/次ボタンで一覧順に選局でき、位置表示が追従する', async ({ page }) => {
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await expect(page.locator('#player-nav')).toBeVisible();
    await expect(page.locator('#player-pos')).toHaveText('3 / 9 ch');

    await page.click('#player-next');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
    await expect(page.locator('#player-pos')).toHaveText('4 / 9 ch');
    // ザッピングでもディープリンク用のハッシュが追従する
    expect(page.url()).toContain('#play=NHKWorldJapan.jp');

    await page.click('#player-prev');
    await expect(page.locator('#player-title')).toHaveText('Multi Stream TV');
    await expect(page.locator('#player-pos')).toHaveText('3 / 9 ch');
  });

  test('一覧の端ではボタンが無効になる(巡回しない)', async ({ page }) => {
    await page.locator('.card', { hasText: 'Adult Channel' }).click(); // 先頭
    await expect(page.locator('#player-pos')).toHaveText('1 / 9 ch');
    await expect(page.locator('#player-prev')).toBeDisabled();
    await expect(page.locator('#player-next')).toBeEnabled();

    await page.locator('#player-close').click();
    await page.locator('.card', { hasText: 'No Stream TV' }).click(); // 末尾
    await expect(page.locator('#player-pos')).toHaveText('9 / 9 ch');
    await expect(page.locator('#player-next')).toBeDisabled();
    await expect(page.locator('#player-prev')).toBeEnabled();
  });

  test('矢印キー ← → で選局できる', async ({ page }) => {
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#player-title')).toHaveText('Multi Stream TV');
  });

  test('モーダルが閉じているときはショートカットが一切働かない', async ({ page }) => {
    // 一度開いて閉じたあと(= プレイヤーの状態は残っている)でも反応しない
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await page.locator('#player-close').click();
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');

    await page.locator('#shuffle-btn').blur();
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'm', 'f']) {
      await page.keyboard.press(key);
    }
    expect(await page.evaluate(() => {
      const v = document.getElementById('player-video');
      return { muted: v.muted, volume: v.volume, fullscreen: window.__fullscreenCalls.length };
    })).toEqual({ muted: false, volume: 1, fullscreen: 0 });
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');
  });

  test('ザッピング後に閉じても元のカードへフォーカスが戻る', async ({ page }) => {
    const multi = page.locator('.card', { hasText: 'Multi Stream TV' });
    await multi.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');

    await page.click('#player-next');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
    await page.locator('#player-close').click();
    // 開いた元のカードに戻る。プレイヤー側も復帰先(lastFocus)にモーダル内の
    // ボタンを覚えないようにしているが、Chromium は <dialog> のフォーカス復帰を
    // 自前で行うため、このテストが落ちるのは両方が壊れたときだけになる
    await expect(multi).toBeFocused();
  });

  // モーダル表示中はツールバーが不活性(inert)で操作できないため、検索の
  // input イベントを直接起こして applyFilters() の再同期経路だけを検証する
  async function filterWhileOpen(page, q) {
    await page.evaluate((value) => {
      const search = document.getElementById('search');
      search.value = value;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
  }

  test('フィルタが絞られると位置表示とボタン活性が再同期される', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await expect(page.locator('#player-pos')).toHaveText('4 / 9 ch');

    // 検索で 2 件(Multi Stream TV / NHK World Japan)に絞る
    await filterWhileOpen(page, 'japan');
    await expect(page.locator('#player-pos')).toHaveText('2 / 2 ch');
    await expect(page.locator('#player-next')).toBeDisabled();
    await expect(page.locator('#player-prev')).toBeEnabled();

    await page.click('#player-prev');
    await expect(page.locator('#player-title')).toHaveText('Multi Stream TV');
    await expect(page.locator('#player-pos')).toHaveText('1 / 2 ch');
  });

  test('再生中チャンネルが一覧から外れると前/次操作は無効になる', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await expect(page.locator('#player-nav')).toBeVisible();

    await filterWhileOpen(page, 'Progressive'); // NHK は結果に含まれない
    await expect(page.locator('#player-nav')).toBeHidden();
    // キーを押しても選局は起きない(開いているチャンネルはそのまま)
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
  });

  test('モーダルを閉じた状態では検索欄のキー入力を一切奪わない', async ({ page }) => {
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await page.locator('#player-close').click();

    // m / f はショートカットとして解釈されず、そのまま文字として入る
    await page.locator('#search').focus();
    await page.keyboard.type('mf');
    await expect(page.locator('#search')).toHaveValue('mf');
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');
  });
});

test.describe('キーボードショートカット(音量・ミュート・全画面)', () => {
  test.beforeEach(async ({ page }) => {
    await instrument(page);
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
  });

  const volume = (page) => page.evaluate(() => document.getElementById('player-video').volume);
  const muted = (page) => page.evaluate(() => document.getElementById('player-video').muted);

  test('↑↓ で音量が変わり、localStorage に保存されて次回復元される', async ({ page }) => {
    expect(await volume(page)).toBe(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await volume(page)).toBeCloseTo(0.8, 5);
    await expect(page.locator('#player-osd')).toHaveText('音量 80%');
    expect(await page.evaluate(() => localStorage.getItem('iptv:pref:volume'))).toBe('0.8');

    await page.keyboard.press('ArrowUp');
    expect(await volume(page)).toBeCloseTo(0.9, 5);

    // リロード後の再生でも保存値から始まる(#play= のディープリンクで再度開く)
    await page.reload();
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#player-title')).toHaveText('Multi Stream TV');
    expect(await volume(page)).toBeCloseTo(0.9, 5);
  });

  test('音量は 0–1 に丸められ、下限・上限を超えない', async ({ page }) => {
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
    expect(await volume(page)).toBe(0);
    for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowUp');
    expect(await volume(page)).toBe(1);
  });

  test('m でミュートを切り替え、ザッピングしても引き継がれる', async ({ page }) => {
    await page.keyboard.press('m');
    expect(await muted(page)).toBe(true);
    await expect(page.locator('#player-osd')).toHaveText('ミュート');
    await expect(page.locator('#player-unmute')).toBeVisible();

    // 選局し直してもユーザーが切ったミュートは維持される
    await page.click('#player-next');
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
    expect(await muted(page)).toBe(true);

    await page.keyboard.press('m');
    expect(await muted(page)).toBe(false);
    await expect(page.locator('#player-unmute')).toBeHidden();
  });

  test('ミュート中に音量を上げるとミュートが解除される', async ({ page }) => {
    await page.keyboard.press('m');
    expect(await muted(page)).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(await muted(page)).toBe(false);
    await expect(page.locator('#player-unmute')).toBeHidden();
  });

  test('f で全画面 API が呼ばれる(対象はオーバーレイを含むステージ)', async ({ page }) => {
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.__fullscreenCalls)).toEqual(['player-stage']);
  });

  test('モーダル内の入力欄にフォーカスがあるときはキーを奪わない', async ({ page }) => {
    // モーダル外の検索欄・プロキシ欄は showModal 中は不活性(inert)なので、
    // 入力欄ガードそのものはモーダル内に入力欄を挿して検証する
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'probe-input';
      document.getElementById('player-modal').appendChild(input);
      input.focus();
    });
    await page.keyboard.type('mf');
    await page.keyboard.press('ArrowRight');
    expect(await muted(page)).toBe(false);
    await expect(page.locator('#probe-input')).toHaveValue('mf');
    await expect(page.locator('#player-title')).toHaveText('Multi Stream TV');
  });

  test('修飾キー付きの操作は横取りしない(ブラウザの標準操作を残す)', async ({ page }) => {
    await page.keyboard.press('Control+m');
    expect(await muted(page)).toBe(false);
  });
});

test.describe('Media Session API', () => {
  test.beforeEach(async ({ page }) => {
    await instrument(page);
    await page.clock.install({ time: EPG_NOW });
    await page.clock.pauseAt(EPG_NOW);
    await routeApi(page);
    await page.route('**/data/epg/schedule.json', (route) =>
      route.fulfill({ path: path.join(FIXTURES_EPG, 'schedule.json'), contentType: 'application/json' })
    );
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  const metadata = (page) =>
    page.evaluate(() => {
      const m = navigator.mediaSession.metadata;
      return m ? { title: m.title, artist: m.artist, album: m.album, art: [...m.artwork].map((a) => a.src) } : null;
    });

  test('現在番組名・チャンネル名・ロゴがメタデータになる', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    expect(await metadata(page)).toEqual({
      title: 'World News Today', // 11:30–12:30 放送中
      artist: 'NHK World Japan',
      album: 'Japan',
      art: ['https://fixture.test/logos/nhk.png'],
    });
  });

  test('番組境界を越えるとメタデータも次の番組に切り替わる', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    await page.clock.fastForward('31:00'); // 12:31 → Asia Insight
    await expect.poll(async () => (await metadata(page)).title).toBe('Asia Insight');
  });

  test('番組表が無いチャンネルではチャンネル名がタイトルになる', async ({ page }) => {
    await page.locator('.card', { hasText: 'US News Channel' }).click();
    const m = await metadata(page);
    expect(m.title).toBe('US News Channel');
    expect(m.artist).toBe('United States');
  });

  test('previoustrack / nexttrack がザッピングに配線されている', async ({ page }) => {
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();
    await page.evaluate(() => window.__mediaHandlers.nexttrack());
    await expect(page.locator('#player-title')).toHaveText('NHK World Japan');
    await page.evaluate(() => window.__mediaHandlers.previoustrack());
    await expect(page.locator('#player-title')).toHaveText('Multi Stream TV');
  });

  test('閉じるとメタデータとハンドラが解除される', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).click();
    expect(await metadata(page)).not.toBeNull();
    await page.locator('#player-close').click();
    await expect.poll(() => metadata(page)).toBeNull();
    expect(await page.evaluate(() => window.__mediaHandlers.nexttrack)).toBeNull();
  });
});

test.describe('モバイル: プレイヤーのザッピング操作', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('狭い画面でも前/次と閉じるが同じ行に収まる', async ({ page }) => {
    await instrument(page);
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await page.locator('.card', { hasText: 'Multi Stream TV' }).click();

    await expect(page.locator('#player-prev')).toBeVisible();
    await expect(page.locator('#player-next')).toBeVisible();
    await expect(page.locator('#player-close')).toBeVisible();
    // 位置表示と凡例は畳んでヘッダーを 1 行に保つ
    await expect(page.locator('#player-pos')).toBeHidden();
    await expect(page.locator('#player-shortcuts')).toBeHidden();

    const head = await page.locator('.player-head').boundingBox();
    const close = await page.locator('#player-close').boundingBox();
    const prev = await page.locator('#player-prev').boundingBox();
    expect(head.height).toBeLessThan(72); // 折り返して 2 段になっていない
    expect(Math.abs(close.y - prev.y)).toBeLessThan(4);
    // 横スクロールが出ていない
    const overflow = await page.evaluate(() => {
      const m = document.getElementById('player-modal');
      return m.scrollWidth - m.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
