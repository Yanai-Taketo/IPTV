'use strict';

/**
 * お気に入り + 最近見た履歴(localStorage 保存基盤)のハーメチックテスト。
 * 履歴は「実際に再生できた」(video の playing イベント)ときだけ記録される。
 */
const { test, expect } = require('@playwright/test');
const { routeApi } = require('./helpers');

test.describe('お気に入りチャンネル', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('カードのトグルで追加・解除でき、件数表示が追従する', async ({ page }) => {
    await expect(page.locator('#fav-only-label')).toContainText('お気に入りのみ (0)');

    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    const btn = nhk.locator('.fav-btn');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveText('☆');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveText('★');
    await expect(page.locator('#fav-only-label')).toContainText('お気に入りのみ (1)');
    // トグルではプレイヤーは開かない
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#fav-only-label')).toContainText('お気に入りのみ (0)');
  });

  test('リロード後も保持され、並び順の先頭に来る', async ({ page }) => {
    // 名前順で最後尾のチャンネルをお気に入りにする
    await page.locator('.card', { hasText: 'ZZ Dash TV' }).locator('.fav-btn').click();
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#fav-only-label')).toContainText('お気に入りのみ (1)');
    await expect(page.locator('.card-name').first()).toHaveText('ZZ Dash TV');
    await expect(
      page.locator('.card', { hasText: 'ZZ Dash TV' }).locator('.fav-btn')
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('お気に入りのみフィルタ(適用中の解除で一覧から消える)', async ({ page }) => {
    await page.locator('.card', { hasText: 'NHK World Japan' }).locator('.fav-btn').click();
    await page.check('#fav-only');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card-name').first()).toHaveText('NHK World Japan');

    // フィルタ適用中に解除すると 0 件表示(グレースフルな空状態)になる
    await page.locator('.fav-btn').click();
    await expect(page.locator('.card')).toHaveCount(0);
    await expect(page.locator('#empty')).toBeVisible();
  });

  test('カードの読み上げ名はチャンネル名(トグルの「お気に入り」を含まない)', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    // role=button の名前を子孫から合成すると、全カードが「お気に入り」で始まってしまう
    await expect(nhk).toHaveAttribute('aria-label', 'NHK World Japan ・ Japan');
    await expect(nhk.locator('.fav-btn')).toHaveAttribute('aria-label', 'お気に入り');
  });

  test('お気に入りのみ表示中に解除してもキーボードフォーカスを失わない', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    const multi = page.locator('.card', { hasText: 'Multi Stream TV' });
    await nhk.locator('.fav-btn').click();
    await multi.locator('.fav-btn').click();
    await page.check('#fav-only');
    await expect(page.locator('.card')).toHaveCount(2);

    // 1 件目を解除 → 再描画後も残ったカードのトグルにフォーカスが残る
    await page.locator('.card .fav-btn').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card .fav-btn')).toBeFocused();

    // 最後の 1 件を解除して 0 件になったらフィルタ自体へフォーカスを戻す
    await page.keyboard.press('Enter');
    await expect(page.locator('.card')).toHaveCount(0);
    await expect(page.locator('#fav-only')).toBeFocused();
  });

  test('キーボード操作: カードは Enter で再生、トグルは独立して操作できる', async ({ page }) => {
    const nhk = page.locator('.card', { hasText: 'NHK World Japan' });
    await nhk.locator('.fav-btn').focus();
    await page.keyboard.press('Enter');
    await expect(nhk.locator('.fav-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#player-modal')).not.toHaveAttribute('open', '');

    await nhk.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#player-modal')).toHaveAttribute('open', '');
  });
});

test.describe('最近見たチャンネル履歴', () => {
  test.beforeEach(async ({ page }) => {
    await routeApi(page);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('再生できたチャンネルだけが記録され、最近見た順で先頭に並ぶ', async ({ page }) => {
    // 再生失敗のみのチャンネル(全ソース死亡)は履歴に残らない
    await page.locator('.card', { hasText: 'US News Channel' }).click();
    await expect(page.locator('#player-error')).toBeVisible();
    await page.click('#player-close');

    // 実際に再生できるチャンネル(プログレッシブ WebM)は記録される
    await page.locator('.card', { hasText: 'Progressive TV' }).click();
    await expect(page.locator('#player-status')).toContainText('● 再生中');
    await page.click('#player-close');

    await page.selectOption('#sort-order', 'recent');
    await expect(page.locator('.card-name').first()).toHaveText('Progressive TV');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv:history')));
    expect(stored.map((h) => h.k)).toEqual(['ProgressiveTV.us']);
  });

  test('履歴は先頭挿入・重複は 1 件に畳む・50 件で打ち止め', async ({ page }) => {
    // 保存ロジックは実再生に依存しないため、ストアを直接動かして検証する
    const ranks = await page.evaluate(() => {
      IPTVStore.recordPlayed('A.jp');
      IPTVStore.recordPlayed('B.us');
      IPTVStore.recordPlayed('A.jp'); // 再訪: 重複を作らず先頭へ
      const r = IPTVStore.historyRanks();
      return { a: r.get('A.jp'), b: r.get('B.us'), count: IPTVStore.historyCount() };
    });
    expect(ranks).toEqual({ a: 0, b: 1, count: 2 });

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv:history')));
    expect(stored.map((h) => h.k)).toEqual(['A.jp', 'B.us']);

    // 上限 50 件: 55 件記録すると古い 5 件が落ち、新しい順に並ぶ
    const capped = await page.evaluate(() => {
      for (let i = 0; i < 55; i++) IPTVStore.recordPlayed(`ch${i}.tv`);
      const r = IPTVStore.historyRanks();
      return {
        count: IPTVStore.historyCount(),
        newest: r.get('ch54.tv'),
        oldestKept: r.get('ch5.tv'),
        dropped: r.has('ch4.tv'),
      };
    });
    expect(capped).toEqual({ count: 50, newest: 0, oldestKept: 49, dropped: false });
  });

  test('履歴が無い状態でも最近見た順は通常の並びで動作する', async ({ page }) => {
    await page.selectOption('#sort-order', 'recent');
    await expect(page.locator('.card')).toHaveCount(7);
    await expect(page.locator('.card-name').first()).toHaveText('Http Only TV'); // 名前順にフォールバック
  });
});
