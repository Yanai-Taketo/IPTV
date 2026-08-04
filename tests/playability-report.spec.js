'use strict';

/**
 * 再生可能性インデックスの前回比レポート(scripts/playability-report.mjs +
 * scripts/compare-playability.mjs)のユニットテスト。ブラウザは使わない。
 *
 * しきい値の根拠は実測(docs/next-features.md §3.5 / スクリプト冒頭のコメント):
 *   健全な実行同士      playable 5,846 → 5,428 (-7.2%)
 *   壊れた実行(実例)  playable 5,846 →   751 (-87.2%)
 * この 2 つを確実に分ける位置(fail 50% / warn 20%)に置いている。
 */
const fs = require('fs');
const os = require('os');
const pathm = require('path');
const { test, expect } = require('@playwright/test');

let lib;
let cli;
test.beforeAll(async () => {
  lib = await import('../scripts/playability-report.mjs');
  cli = await import('../scripts/compare-playability.mjs'); // 直接実行ガードがあるので import は安全
});

/** counts と(任意で)status マップを持つインデックスを作る */
function index({ playable, mixed = 0, cors = 0, dead, total, status }) {
  const counts = { 1: playable, 2: mixed, 3: cors, 0: dead };
  return {
    generated_at: '2026-08-04T03:17:00.000Z',
    total: total ?? playable + mixed + cors + dead,
    counts,
    ...(status ? { status } : {}),
  };
}

// 実際に起きた 3 連続実行(総 URL 数は 3 回とも 17,968 で同一)
const HEALTHY_A = index({ playable: 5846, mixed: 1958, cors: 148, dead: 10016 });
const BROKEN = index({ playable: 751, mixed: 1594, cors: 24, dead: 15599 });
const HEALTHY_B = index({ playable: 5428, mixed: 1921, cors: 145, dead: 10474 });

test.describe('comparePlayability', () => {
  test('健全な実行同士(-7.2%)は通す', () => {
    const r = lib.comparePlayability(HEALTHY_A, HEALTHY_B);
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([]);
    expect(r.rows.find((x) => x.status === 1)).toMatchObject({ prev: 5846, next: 5428, delta: -418 });
    expect(r.total).toMatchObject({ prev: 17968, next: 17968, delta: 0 });
  });

  test('壊れた実行(-87.2%)は fail させる', () => {
    const r = lib.comparePlayability(HEALTHY_A, BROKEN);
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => [c.id, c.level])).toEqual([['playable-rate', 'error']]);
    expect(r.checks[0].message).toContain('87.2%');
  });

  test('復旧(大幅増)は通す', () => {
    expect(lib.comparePlayability(BROKEN, HEALTHY_B).ok).toBe(true);
  });

  test('warn 帯(20〜50% の低下)は止めずに注意だけ出す', () => {
    const prev = index({ playable: 5000, dead: 5000 });
    const next = index({ playable: 3000, dead: 7000 }); // 率 50% → 30% = -40%
    const r = lib.comparePlayability(prev, next);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.id, c.level])).toEqual([['playable-rate', 'warn']]);
  });

  test('境界: ちょうど 50% の低下は通し、それを超えると落とす', () => {
    const prev = index({ playable: 5000, dead: 5000 });
    expect(lib.comparePlayability(prev, index({ playable: 2500, dead: 7500 })).ok).toBe(true);
    expect(lib.comparePlayability(prev, index({ playable: 2499, dead: 7501 })).ok).toBe(false);
  });

  test('上流が縮んでも率が変わらなければ再生可能率のチェックには掛からない', () => {
    // streams.json が 1/3 になり playable も 1/3 → 率(33.3%)は変わらない
    const prev = index({ playable: 6000, dead: 12000 });
    const next = index({ playable: 2000, dead: 4000 });
    const r = lib.comparePlayability(prev, next);
    expect(r.checks.some((c) => c.id === 'playable-rate')).toBe(false);
    // ただし上流の急減自体は壊れた入力の兆候なので総数側で捕まえる
    expect(r.checks.map((c) => [c.id, c.level])).toEqual([['total', 'error']]);
    expect(r.ok).toBe(false);
  });

  test('総数のゆるやかな減少は warn まで', () => {
    const prev = index({ playable: 3000, dead: 7000 });
    const next = index({ playable: 2100, dead: 4900 }); // 総数 -30%・率は同じ
    const r = lib.comparePlayability(prev, next);
    expect(r.checks.map((c) => [c.id, c.level])).toEqual([['total', 'warn']]);
    expect(r.ok).toBe(true);
  });

  test('前回が無ければ比較しない(初回実行)', () => {
    const r = lib.comparePlayability(null, HEALTHY_B);
    expect(r.hasPrev).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([]);
    expect(r.rows.every((row) => row.prev === null && row.delta === null)).toBe(true);
    expect(r.churn).toBe(null);
  });

  test('再生可能ゼロは前回が無くても異常として扱う', () => {
    const r = lib.comparePlayability(null, index({ playable: 0, dead: 100 }));
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => c.id)).toEqual(['empty']);
  });

  test('しきい値はオプションで変えられる(手動突破用)', () => {
    expect(lib.comparePlayability(HEALTHY_A, BROKEN, { failDropRatio: 0.95 }).ok).toBe(true);
    expect(lib.comparePlayability(HEALTHY_A, HEALTHY_B, { failDropRatio: 0.05 }).ok).toBe(false);
  });

  test('status マップの差分で新規死亡・復活・URL の増減を出す', () => {
    const prev = index({
      playable: 2, dead: 2,
      status: { 'a': 1, 'b': 1, 'c': 0, 'gone': 0 },
    });
    const next = index({
      playable: 2, dead: 2,
      status: { 'a': 1, 'b': 0, 'c': 1, 'fresh': 0 },
    });
    expect(lib.comparePlayability(prev, next).churn)
      .toEqual({ newlyDead: 1, revived: 1, added: 1, removed: 1 });
  });

  test('status マップが無ければ内訳は算出しない', () => {
    expect(lib.comparePlayability(HEALTHY_A, HEALTHY_B).churn).toBe(null);
  });

  test('counts が壊れていても落ちずに 0 として扱う', () => {
    const broken = { total: 10, counts: { 1: 'x' } };
    const r = lib.comparePlayability(null, broken);
    expect(r.rows.map((row) => row.next)).toEqual([0, 0, 0, 0]);
    expect(r.ok).toBe(false); // playable 0 = 異常
  });
});

test.describe('formatSummary', () => {
  test('表・率・内訳・判定が Markdown で並ぶ', () => {
    // 率 40.0% → 35.0%(-12.5%)= warn(20%)にも届かない通常の変動
    const prev = index({ playable: 40, mixed: 10, cors: 10, dead: 40, status: { a: 1, b: 1, c: 0 } });
    const next = index({ playable: 35, mixed: 10, cors: 10, dead: 45, status: { a: 1, b: 0, c: 1 } });
    const md = lib.formatSummary(lib.comparePlayability(prev, next), { generatedAt: '2026-08-04T03:17:00Z' });
    expect(md).toContain('## 再生可能性インデックス');
    expect(md).toContain('| 再生可能 (1) | 40 | 35 | -5 (-12.5%) |');
    expect(md).toContain('| **合計** | 100 | 100 | ±0 |'); // 増減ゼロは比率を出さない
    expect(md).toContain('再生可能率: 40.0% → 35.0% (-5.0pt)');
    expect(md).toContain('内訳: 新規に応答なし 1 ・ 復活 1 ・ 新規 URL 0 ・ 消滅 0');
    expect(md).toContain('✅ 前回比の急落はありません');
    expect(md).toContain('しきい値: fail 50.0% / warn 20.0%');
  });

  test('急落時は判定行とログ注釈がエラーになる', () => {
    const report = lib.comparePlayability(HEALTHY_A, BROKEN);
    expect(lib.formatSummary(report)).toContain('❌ 再生可能率が 87.2% 低下しました');
    expect(lib.formatAnnotations(report)).toEqual([
      expect.stringMatching(/^::error::再生可能率が 87\.2% 低下しました/),
    ]);
    // 注釈は 1 行に畳む(改行が入ると Actions 側で切れる)
    expect(lib.formatAnnotations(report)[0]).not.toContain('\n');
  });

  test('前回が無いときは比較なしと明示する', () => {
    const md = lib.formatSummary(lib.comparePlayability(null, HEALTHY_B));
    expect(md).toContain('| 再生可能 (1) | — | 5,428 | — |');
    expect(md).toContain('前回のインデックスが無いため比較なし');
  });

  test('3 桁区切りはロケール設定に依存しない', () => {
    expect(lib.fmt(17968)).toBe('17,968');
    expect(lib.fmt(-5095)).toBe('-5,095');
    expect(lib.fmt(0)).toBe('0');
  });
});

test.describe('compare-playability CLI', () => {
  test('parseArgs: 既定値と正常系', () => {
    expect(cli.parseArgs(['node', 'x'])).toEqual({
      prev: null, next: 'data/playability.json', summary: null,
      failDropRatio: 0.5, warnDropRatio: 0.2,
    });
    const args = cli.parseArgs(['node', 'x', '--prev', 'p.json', '--next', 'n.json', '--summary', 's.md', '--fail-drop', '0.7']);
    expect(args).toMatchObject({ prev: 'p.json', next: 'n.json', summary: 's.md', failDropRatio: 0.7 });
  });

  test('parseArgs: 値の欠落・不正な比率・未知の引数はエラー', () => {
    expect(() => cli.parseArgs(['node', 'x', '--prev'])).toThrow('--prev には値が必要です');
    expect(() => cli.parseArgs(['node', 'x', '--prev', '--next'])).toThrow('--prev には値が必要です');
    expect(() => cli.parseArgs(['node', 'x', '--fail-drop', '1.5'])).toThrow('比率で指定してください');
    expect(() => cli.parseArgs(['node', 'x', '--fail-drop', '0'])).toThrow('比率で指定してください');
    expect(() => cli.parseArgs(['node', 'x', '--bogus', 'v'])).toThrow('不明な引数: --bogus');
  });

  test('急落を検出すると終了コード 1 を返し、サマリファイルに追記する', () => {
    const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'playability-'));
    const prev = pathm.join(tmp, 'prev.json');
    const next = pathm.join(tmp, 'next.json');
    const summary = pathm.join(tmp, 'summary.md');
    fs.writeFileSync(prev, JSON.stringify(HEALTHY_A));
    fs.writeFileSync(next, JSON.stringify(BROKEN));

    expect(cli.run(['node', 'x', '--prev', prev, '--next', next, '--summary', summary])).toBe(1);
    expect(fs.readFileSync(summary, 'utf8')).toContain('❌ 再生可能率が 87.2% 低下しました');

    // 健全なら 0。サマリは追記される(既存の内容を消さない)
    fs.writeFileSync(next, JSON.stringify(HEALTHY_B));
    expect(cli.run(['node', 'x', '--prev', prev, '--next', next, '--summary', summary])).toBe(0);
    const md = fs.readFileSync(summary, 'utf8');
    expect(md).toContain('❌ 再生可能率が 87.2% 低下しました');
    expect(md).toContain('✅ 前回比の急落はありません');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('前回のファイルが無い・壊れていても初回として続行する', () => {
    const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'playability-'));
    const next = pathm.join(tmp, 'next.json');
    const broken = pathm.join(tmp, 'broken.json');
    fs.writeFileSync(next, JSON.stringify(HEALTHY_B));
    fs.writeFileSync(broken, 'not json');
    expect(cli.run(['node', 'x', '--prev', pathm.join(tmp, 'missing.json'), '--next', next])).toBe(0);
    expect(cli.run(['node', 'x', '--prev', broken, '--next', next])).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('今回のファイルが読めないときはエラーで止まる(黙って通さない)', () => {
    expect(() => cli.run(['node', 'x', '--next', '/nonexistent/playability.json']))
      .toThrow('を読めません');
  });
});

// ---- ワークフローへの組み込み ------------------------------------------------
//
// 判定はコミット・デプロイの「前」に置かないと意味が無い(壊れたインデックスが
// 配信されてしまう)。手順の並べ替えで安全弁が無効化されるのを防ぐ。

test.describe('probe-playability.yml の手順', () => {
  const workflow = () =>
    fs.readFileSync(pathm.join(__dirname, '..', '.github', 'workflows', 'probe-playability.yml'), 'utf8');

  test('前回の退避 → プローブ → 前回比の判定 → コミット の順に並ぶ', () => {
    const yml = workflow();
    const at = (name) => {
      const i = yml.indexOf(`- name: ${name}`);
      expect(i, `${name} の手順が見つからない`).toBeGreaterThan(-1);
      return i;
    };
    const snapshot = at('Snapshot previous index');
    const probe = at('Probe all streams');
    const report = at('Report change vs previous run');
    const commit = at('Commit updated index');
    expect(snapshot).toBeLessThan(probe); // 上書き前に退避する
    expect(probe).toBeLessThan(report);
    expect(report).toBeLessThan(commit); // 壊れたインデックスをコミットさせない
  });

  test('判定はジョブサマリへ出力し、スクリプト変更でも実行される', () => {
    const yml = workflow();
    expect(yml).toContain('--summary "$GITHUB_STEP_SUMMARY"');
    expect(yml).toContain("scripts/compare-playability.mjs'");
    expect(yml).toContain("scripts/playability-report.mjs'");
  });
});
