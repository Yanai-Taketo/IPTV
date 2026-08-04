'use strict';

/**
 * EPG パイプライン純粋ロジック(scripts/epg-lib.mjs)のユニットテスト。
 * ブラウザは使わず Node 上で直接検証する。
 */
const { test, expect } = require('@playwright/test');

let lib;
let cli;
test.beforeAll(async () => {
  lib = await import('../scripts/epg-lib.mjs');
  cli = await import('../scripts/grab-epg.mjs'); // 直接実行ガードがあるので import は安全
});

// ---- convertGuide -----------------------------------------------------------

function makeProgram(overrides) {
  return {
    site: 'i.mjh.nz',
    channel: 'Chan.jp@SD',
    start: 1785843000000,
    stop: 1785846600000,
    titles: [{ value: 'Show A', lang: 'ja' }],
    subTitles: [],
    descriptions: [],
    categories: [],
    episodeNumbers: [],
    ...overrides,
  };
}

// 実行時刻に依存しないよう生成時刻を固定する(プルーニング判定の基準になる)
const BASE = { generatedAt: '2026-08-04T10:00:00Z' };

test.describe('convertGuide', () => {
  test('xmltv_id の @feed を外してチャンネル id をキーにする', () => {
    const { schedule } = lib.convertGuide({ programs: [makeProgram({})] }, { ...BASE, shardCount: 4 });
    expect(Object.keys(schedule.channels)).toEqual(['Chan.jp']);
    expect(schedule.channels['Chan.jp'].feed).toBe('SD');
    expect(schedule.channels['Chan.jp'].site).toBe('i.mjh.nz');
    expect(schedule.channels['Chan.jp'].p).toEqual([[1785843000, 3600, 'Show A']]);
  });

  test('feed 無しの xmltv_id も扱える', () => {
    const { schedule } = lib.convertGuide(
      { programs: [makeProgram({ channel: 'Chan.jp' })] },
      { ...BASE, shardCount: 4 }
    );
    expect(schedule.channels['Chan.jp'].feed).toBeNull();
  });

  test('番組は開始時刻順に整列される', () => {
    const { schedule } = lib.convertGuide(
      {
        programs: [
          makeProgram({ start: 1785850000000, stop: 1785853600000, titles: [{ value: 'Late' }] }),
          makeProgram({ titles: [{ value: 'Early' }] }),
        ],
      },
      { ...BASE, shardCount: 1 }
    );
    expect(schedule.channels['Chan.jp'].p.map((p) => p[2])).toEqual(['Early', 'Late']);
  });

  test('日またぎで重複した同一番組(同じ開始時刻・タイトル)は 1 件に畳む', () => {
    const { schedule, stats } = lib.convertGuide(
      { programs: [makeProgram({}), makeProgram({})] },
      { ...BASE, shardCount: 1 }
    );
    expect(schedule.channels['Chan.jp'].p).toHaveLength(1);
    expect(stats.programs).toBe(1);
  });

  test('不正な番組(タイトル無し・時刻不正・長すぎ)はスキップして数える', () => {
    const { schedule, stats } = lib.convertGuide(
      {
        programs: [
          makeProgram({ titles: [] }), // タイトル無し
          makeProgram({ titles: [{ value: '   ' }] }), // 空白のみ
          makeProgram({ start: 'bad' }), // 時刻不正
          makeProgram({ stop: 1785843000000 }), // 長さ 0
          makeProgram({ stop: 1785843000000 + 13 * 3600 * 1000, titles: [{ value: 'TooLong' }] }), // 12h 超
          makeProgram({}), // 正常
        ],
      },
      { ...BASE, shardCount: 1 }
    );
    expect(stats.programs).toBe(1);
    expect(stats.skippedPrograms).toBe(5);
    expect(schedule.channels['Chan.jp'].p).toHaveLength(1);
  });

  test('生成時点より 3 時間以上前に終了した番組はプルーニングされる', () => {
    // 生成 10:00Z(BASE)→ 基準は 07:00Z。06:00Z 終了の番組は落ち、08:00Z 終了は残る
    const { schedule, stats } = lib.convertGuide(
      {
        programs: [
          makeProgram({
            start: Date.parse('2026-08-04T05:00:00Z'),
            stop: Date.parse('2026-08-04T06:00:00Z'),
            titles: [{ value: 'Old' }],
          }),
          makeProgram({
            start: Date.parse('2026-08-04T07:00:00Z'),
            stop: Date.parse('2026-08-04T08:00:00Z'),
            titles: [{ value: 'Recent' }],
          }),
        ],
      },
      { ...BASE, shardCount: 1 }
    );
    expect(schedule.channels['Chan.jp'].p.map((p) => p[2])).toEqual(['Recent']);
    expect(stats.prunedPrograms).toBe(1);
  });

  test('番組が 1 件も残らないチャンネルは出力されない', () => {
    const { schedule } = lib.convertGuide(
      { programs: [makeProgram({ channel: 'Empty.jp@SD', titles: [] })] },
      { ...BASE, shardCount: 1 }
    );
    expect(schedule.counts.channels).toBe(0);
    expect(schedule.channels).toEqual({});
  });

  test('説明文は上限で切り詰め、詳細シャードに入る', () => {
    const longDesc = 'あ'.repeat(500);
    const { schedule, shards } = lib.convertGuide(
      {
        programs: [
          makeProgram({
            subTitles: [{ value: 'Sub' }],
            descriptions: [{ value: longDesc }],
            categories: [{ value: 'News' }],
            episodeNumbers: [
              { system: 'xmltv_ns', value: '0.16.' },
              { system: 'SxxExx', value: 'S01E17' },
            ],
          }),
        ],
      },
      { ...BASE, shardCount: 4, descLimit: 100 }
    );
    const shard = schedule.channels['Chan.jp'].shard;
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(4);
    const detail = shards[shard]['Chan.jp'][0];
    expect(detail[0]).toBe(1785843000);
    expect(detail[2]).toBe('Show A');
    expect(detail[3]).toBe('Sub');
    expect(detail[4]).toHaveLength(100); // 99 文字 + 省略記号
    expect(detail[4].endsWith('…')).toBe(true);
    expect(detail[5]).toBe('News');
    expect(detail[6]).toBe('S01E17');
  });

  test('境界値: ちょうど 12 時間は残り、プルーニング基準ちょうどの終了時刻も残る', () => {
    const { schedule, stats } = lib.convertGuide(
      {
        programs: [
          // ちょうど 12 時間(maxDurationSec と等値)は許容される
          makeProgram({
            start: Date.parse('2026-08-04T08:00:00Z'),
            stop: Date.parse('2026-08-04T20:00:00Z'),
            titles: [{ value: 'HalfDay' }],
          }),
          // 生成 10:00Z − 3h = 07:00Z ちょうどに終わる番組は残る(< 判定)
          makeProgram({
            start: Date.parse('2026-08-04T06:00:00Z'),
            stop: Date.parse('2026-08-04T07:00:00Z'),
            titles: [{ value: 'EndsAtCutoff' }],
          }),
        ],
      },
      { ...BASE, shardCount: 1 }
    );
    expect(schedule.channels['Chan.jp'].p.map((p) => p[2]).sort()).toEqual(['EndsAtCutoff', 'HalfDay']);
    expect(stats.prunedPrograms).toBe(0);
  });

  test('同じ開始時刻でもタイトルが違えば両方残る', () => {
    const { schedule } = lib.convertGuide(
      {
        programs: [
          makeProgram({ titles: [{ value: 'Show A' }] }),
          makeProgram({ titles: [{ value: 'Show B' }] }),
        ],
      },
      { ...BASE, shardCount: 1 }
    );
    expect(schedule.channels['Chan.jp'].p).toHaveLength(2);
  });

  test('切り詰めがサロゲートペアを分断しない(不正な文字列を出力しない)', () => {
    const desc = 'x'.repeat(98) + '😀'.repeat(10); // 100 文字目がペアの中央に当たる
    const { schedule, shards } = lib.convertGuide(
      { programs: [makeProgram({ descriptions: [{ value: desc }] })] },
      { ...BASE, shardCount: 1, descLimit: 100 }
    );
    const detail = shards[schedule.channels['Chan.jp'].shard]['Chan.jp'][0];
    expect(detail[4].endsWith('…')).toBe(true);
    expect(detail[4].isWellFormed()).toBe(true); // 孤立サロゲートが無い
  });

  test('シャード割り当ては schedule に記録され shardIndex と一致する', () => {
    const ids = ['A.jp', 'B.us', 'C.fr', 'D.de', 'E.uk'];
    const { schedule } = lib.convertGuide(
      { programs: ids.map((id) => makeProgram({ channel: `${id}@SD` })) },
      { ...BASE, shardCount: 3 }
    );
    for (const id of ids) {
      expect(schedule.channels[id].shard).toBe(lib.shardIndex(id, 3));
    }
  });

  test('counts にチャンネル・番組・サイト数が入る', () => {
    const { schedule } = lib.convertGuide(
      {
        programs: [
          makeProgram({}),
          makeProgram({ channel: 'Other.us@HD', site: 'pluto.tv' }),
        ],
      },
      { ...BASE, shardCount: 2 }
    );
    expect(schedule.counts).toEqual({ channels: 2, programs: 2, sites: 2 });
    expect(schedule.shard_count).toBe(2);
  });
});

// ---- selectGuideRows --------------------------------------------------------

const FEEDS = [
  { channel: 'A.jp', id: 'SD', is_main: true },
  { channel: 'B.us', id: 'HD', is_main: true },
];

function guideRow(overrides) {
  return { channel: 'A.jp', feed: 'SD', site: 'site1.com', site_id: 'x1', lang: 'ja', ...overrides };
}

test.describe('selectGuideRows', () => {
  test('対象外チャンネル・不完全な行は無視される', () => {
    const { rows, stats } = lib.selectGuideRows(
      [
        guideRow({}),
        guideRow({ channel: 'NotWanted.us' }),
        guideRow({ channel: null }),
        guideRow({ site_id: null }),
      ],
      FEEDS,
      new Set(['A.jp']),
      {}
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('A.jp');
    expect(stats.withGuide).toBe(1);
  });

  test('メインフィードの行を優先する', () => {
    const { rows } = lib.selectGuideRows(
      [
        guideRow({ feed: 'Regional', site: 'big.com', site_id: 'r1' }),
        guideRow({ feed: 'SD', site: 'small.com', site_id: 's1' }),
      ],
      FEEDS,
      new Set(['A.jp']),
      {}
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].feed).toBe('SD'); // メインフィードならサイト規模より優先
  });

  test('同条件ならカバレッジの大きいサイトを選ぶ', () => {
    const rowsIn = [
      guideRow({ site: 'small.com', site_id: 's1' }),
      guideRow({ site: 'big.com', site_id: 'b1' }),
      // big.com のカバレッジを増やすためのダミーチャンネル
      guideRow({ channel: 'B.us', feed: 'HD', site: 'big.com', site_id: 'b2' }),
    ];
    const { rows } = lib.selectGuideRows(rowsIn, FEEDS, new Set(['A.jp', 'B.us']), {});
    expect(rows.find((r) => r.channel === 'A.jp').site).toBe('big.com');
  });

  test('maxSites で選定数下位のサイトを落とし、そこにしか無いチャンネルは除外される', () => {
    const rowsIn = [
      guideRow({ channel: 'C1.jp', feed: null, site: 'big.com', site_id: 'b1' }),
      guideRow({ channel: 'C2.jp', feed: null, site: 'big.com', site_id: 'b2' }),
      // C3 は tiny.com にしかない
      guideRow({ channel: 'C3.jp', feed: null, site: 'tiny.com', site_id: 't3' }),
    ];
    const wanted = new Set(['C1.jp', 'C2.jp', 'C3.jp']);
    const { rows, stats } = lib.selectGuideRows(rowsIn, [], wanted, { maxSites: 1 });
    expect(stats.sites).toBe(1);
    expect(rows.map((r) => r.channel).sort()).toEqual(['C1.jp', 'C2.jp']);
    expect(stats.droppedBySiteCap).toBe(1);
  });

  test('選定サイトが落ちても、残ったサイトに行があるチャンネルは再選定される', () => {
    const feeds = [{ channel: 'C1.jp', id: 'MAIN', is_main: true }];
    const rowsIn = [
      // C1 のメインフィード行は small.com にしかない(初回はこちらが選ばれる)
      guideRow({ channel: 'C1.jp', feed: 'MAIN', site: 'small.com', site_id: 'm1' }),
      guideRow({ channel: 'C1.jp', feed: 'ALT', site: 'big.com', site_id: 'b0' }),
      guideRow({ channel: 'C2.jp', feed: null, site: 'big.com', site_id: 'b2' }),
      guideRow({ channel: 'C3.jp', feed: null, site: 'big.com', site_id: 'b3' }),
      guideRow({ channel: 'C4.jp', feed: null, site: 'only.com', site_id: 'o4' }),
    ];
    const wanted = new Set(['C1.jp', 'C2.jp', 'C3.jp', 'C4.jp']);
    const { rows, stats } = lib.selectGuideRows(rowsIn, feeds, wanted, { maxSites: 2 });
    // 選定数: big.com=2, small.com=1, only.com=1 → big.com と(名前順で)only.com が残る
    // small.com が落ちた C1 は big.com の ALT フィード行で救済される
    expect(stats.sites).toBe(2);
    expect(stats.droppedBySiteCap).toBe(0);
    const c1 = rows.find((r) => r.channel === 'C1.jp');
    expect(c1.site).toBe('big.com');
    expect(c1.feed).toBe('ALT');
    expect(rows.map((r) => r.channel).sort()).toEqual(['C1.jp', 'C2.jp', 'C3.jp', 'C4.jp']);
  });

  test('excludedSites の行は選ばれず、代替ガイドを持つチャンネルは振り直される', () => {
    const rowsIn = [
      // C1 はブロックサイトが第一候補(カバレッジ最大)だが alt.com にもガイドがある
      guideRow({ channel: 'C1.jp', feed: null, site: 'blocked.example', site_id: 'b1' }),
      guideRow({ channel: 'C1.jp', feed: null, site: 'alt.com', site_id: 'a1' }),
      // C2 はブロックサイトにしかガイドが無い → 選定から漏れる
      guideRow({ channel: 'C2.jp', feed: null, site: 'blocked.example', site_id: 'b2' }),
    ];
    const wanted = new Set(['C1.jp', 'C2.jp']);
    const { rows, stats } = lib.selectGuideRows(rowsIn, [], wanted, {
      excludedSites: ['blocked.example'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('C1.jp');
    expect(rows[0].site).toBe('alt.com');
    expect(stats.droppedByExclusion).toBe(1);
  });

  test('既定ではブロックサイトを除外しない(明示オプトイン)', () => {
    const rowsIn = [guideRow({ site: lib.EXCLUDED_SITES[0], site_id: 'x' })];
    const { rows } = lib.selectGuideRows(rowsIn, FEEDS, new Set(['A.jp']), {});
    expect(rows).toHaveLength(1);
  });

  test('maxChannels で決定的に切り詰める', () => {
    const rowsIn = ['C1.jp', 'C2.jp', 'C3.jp'].map((id) =>
      guideRow({ channel: id, feed: null, site: 'big.com', site_id: id })
    );
    const wanted = new Set(['C1.jp', 'C2.jp', 'C3.jp']);
    const a = lib.selectGuideRows(rowsIn, [], wanted, { maxChannels: 2 });
    const b = lib.selectGuideRows(rowsIn, [], wanted, { maxChannels: 2 });
    expect(a.rows).toHaveLength(2);
    expect(a.stats.droppedByChannelCap).toBe(1);
    expect(a.rows).toEqual(b.rows); // 決定性
  });
});

// ---- parseArgs(CLI 引数検証) ----------------------------------------------

test.describe('parseArgs', () => {
  const argv = (...rest) => ['node', 'grab-epg.mjs', ...rest];

  test('既定値と正常系', () => {
    const args = cli.parseArgs(argv('convert', '--in', 'g.json', '--outdir', 'out', '--shards', '8'));
    expect(args.command).toBe('convert');
    expect(args.in).toBe('g.json');
    expect(args.outdir).toBe('out');
    expect(args.shards).toBe(8);
    expect(args.maxSites).toBe(lib.DEFAULTS.maxSites);
  });

  test('数値フラグは正の整数のみ受け付ける', () => {
    expect(() => cli.parseArgs(argv('convert', '--shards', '-1'))).toThrow('正の整数');
    expect(() => cli.parseArgs(argv('convert', '--shards', '0'))).toThrow('正の整数');
    expect(() => cli.parseArgs(argv('prepare', '--max-sites', 'abc'))).toThrow('正の整数');
    expect(() => cli.parseArgs(argv('prepare', '--max-channels', '-5'))).toThrow('正の整数');
  });

  test('値の欠落・フラグの誤消費はエラーになる', () => {
    expect(() => cli.parseArgs(argv('prepare', '--out'))).toThrow('--out には値が必要です');
    expect(() => cli.parseArgs(argv('convert', '--in', '--outdir', 'out'))).toThrow('--in には値が必要です');
  });

  test('--exclude-sites: 既定はランナーブロックサイト一覧、上書き・無効化できる', () => {
    // 既知の 9 サイト(docs/next-features.md §2-1)が既定で除外対象になっている
    expect(lib.EXCLUDED_SITES).toContain('tvtv.us');
    expect(lib.EXCLUDED_SITES).toContain('zuragt.mn');
    expect(lib.EXCLUDED_SITES).toHaveLength(9);
    expect(cli.parseArgs(argv('prepare')).excludeSites).toEqual(lib.EXCLUDED_SITES);
    expect(cli.parseArgs(argv('prepare', '--exclude-sites', 'a.com, b.com')).excludeSites).toEqual([
      'a.com',
      'b.com',
    ]);
    expect(cli.parseArgs(argv('prepare', '--exclude-sites', '')).excludeSites).toEqual([]);
    expect(() => cli.parseArgs(argv('prepare', '--exclude-sites'))).toThrow('値が必要です');
  });

  test('--split-dir と --indir を受け付ける', () => {
    const args = cli.parseArgs(argv('prepare', '--split-dir', 'sites', '--out', 'c.xml'));
    expect(args.splitDir).toBe('sites');
    const args2 = cli.parseArgs(argv('convert', '--indir', 'guides'));
    expect(args2.indir).toBe('guides');
  });

  test('未知の引数はエラーになる', () => {
    expect(() => cli.parseArgs(argv('convert', '--nope'))).toThrow('unknown argument');
  });
});

// ---- convert(--indir でのサイト別グラブ結果のマージ) -----------------------

test.describe('convert --indir', () => {
  test('複数サイトの guide JSON をマージして 1 つの schedule にする', async () => {
    const fs = require('fs');
    const os = require('os');
    const pathm = require('path');
    const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'epg-merge-'));
    const indir = pathm.join(tmp, 'guides');
    const outdir = pathm.join(tmp, 'out');
    fs.mkdirSync(indir, { recursive: true });
    // 番組が現在時刻近傍になるよう動的に生成(プルーニングを受けないため)
    const start = Date.now();
    const stop = start + 3600 * 1000;
    const prog = (channel, site, title) => ({
      site,
      channel,
      start,
      stop,
      titles: [{ value: title }],
    });
    fs.writeFileSync(
      pathm.join(indir, 'site-a.json'),
      JSON.stringify({ programs: [prog('AAA.jp@SD', 'site-a.com', 'Show A')] })
    );
    fs.writeFileSync(
      pathm.join(indir, 'site-b.json'),
      JSON.stringify({ programs: [prog('BBB.us@HD', 'site-b.com', 'Show B')] })
    );
    await cli.convert({ indir, outdir, in: null, shards: 2, days: 2 });
    const schedule = JSON.parse(fs.readFileSync(pathm.join(outdir, 'schedule.json'), 'utf8'));
    expect(Object.keys(schedule.channels).sort()).toEqual(['AAA.jp', 'BBB.us']);
    expect(schedule.counts).toMatchObject({ channels: 2, programs: 2, sites: 2 });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('JSON が 1 つも無いディレクトリはエラーになる', async () => {
    const fs = require('fs');
    const os = require('os');
    const pathm = require('path');
    const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'epg-empty-'));
    await expect(cli.convert({ indir: tmp, outdir: tmp, in: null, shards: 2, days: 2 })).rejects.toThrow(
      'json がありません'
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---- buildChannelsXml -------------------------------------------------------

test.describe('buildChannelsXml', () => {
  test('xmltv_id は channel@feed、XML 特殊文字はエスケープされる', () => {
    const xml = lib.buildChannelsXml([
      {
        channel: 'AandB.us',
        feed: 'East',
        site: 'example.com',
        site_id: 'a&b<c>"d"',
        lang: 'en',
        site_name: "A & B's TV",
      },
      { channel: 'Solo.jp', feed: null, site: 'example.com', site_id: 'solo', lang: 'ja' },
    ]);
    expect(xml).toContain('xmltv_id="AandB.us@East"');
    expect(xml).toContain('site_id="a&amp;b&lt;c&gt;&quot;d&quot;"');
    expect(xml).toContain("A &amp; B&apos;s TV");
    expect(xml).toContain('xmltv_id="Solo.jp"'); // feed 無しはチャンネル id のみ
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml.trim().endsWith('</channels>')).toBe(true);
  });
});
