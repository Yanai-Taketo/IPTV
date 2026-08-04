'use strict';

/**
 * EPG パイプラインの純粋ロジック(選定・channels.xml 生成・グラブ結果の変換)。
 * I/O は持たず、grab-epg.mjs(CLI)とテストの両方から使う。
 *
 * データの流れ:
 *   guides.json + feeds.json + 再生可能チャンネル集合
 *     → selectGuideRows()  … チャンネルごとに 1 つのグラブ元(site, site_id)を選ぶ
 *     → buildChannelsXml() … iptv-org/epg グラバーに渡す custom.channels.xml
 *     → (iptv-org/epg `npm run grab --- --json` を実行)
 *     → convertGuide()     … グラバーの JSON 出力を配信用のコンパクト形式に変換
 *
 * 配信フォーマット(フロントエンド assets/js/epg.js と対応):
 *   schedule.json  … { generated_at, days, shard_count, counts,
 *                      channels: { <channelId>: { site, feed, shard, p: [[開始秒, 長さ秒, タイトル], …] } } }
 *   details-<n>.json … { <channelId>: [[開始秒, 長さ秒, タイトル, サブタイトル, 説明, カテゴリ, 話数], …] }
 *   時刻はすべて UTC の epoch 秒。details のシャード番号は schedule 側に記録する
 *   (フロントエンドがハッシュ実装を持たなくて済むようにするため)。
 */

export const DEFAULTS = {
  maxSites: 40,
  maxChannels: 1500,
  shardCount: 24,
  descLimit: 240,
  maxDurationSec: 12 * 3600, // これを超える「番組」はサイト側のデータ不良とみなす
  pruneAgeSec: 3 * 3600, // 生成時点よりこれ以上前に終了した番組は配信しない(サイズ削減)
};

/**
 * GitHub Actions ランナーから番組が 0 件しか取れないサイト(2026-08 実測)。
 * グラブ自体は成功するが応答が空で、選定枠だけを消費してしまうため
 * 選定から除外し、代替ガイドを持つチャンネルは他サイトへ振り直す。
 * zuragt.mn は別 IP からは取得できたため、データセンター IP ブロックが濃厚
 * (docs/next-features.md §2-1)。回復が確認できたサイトはここから外すこと。
 */
export const EXCLUDED_SITES = [
  'chaines-tv.orange.fr',
  'clickthecity.com',
  'distro.tv',
  'm.tv.sms.cz',
  'sat.tv',
  'tvprofil.com',
  'tvtv.us',
  'wavve.com',
  'zuragt.mn',
];

// ---- 選定 -------------------------------------------------------------------

/**
 * チャンネルごとに使うガイド行を 1 つ選ぶ。
 *
 * 優先順位:
 *   1. メインフィード(feeds.json の is_main)に紐づく行
 *   2. カバレッジの大きいサイトの行(実行するサイト数を減らして CI を速くする)
 *   3. サイト名 → site_id → feed の辞書順(決定性の担保)
 *
 * その後、サイト数上限(maxSites)で選定チャンネル数の少ないサイトから落とし、
 * 落ちたサイトしか持たないチャンネルは残りサイトの行で再選定する。
 *
 * @param {Array} guideRows guides.json の行 {channel, feed, site, site_id, lang}
 * @param {Array} feeds     feeds.json の行 {channel, id, is_main}
 * @param {Set<string>} wantedIds 対象チャンネル id の集合
 * @param {object} opts {maxSites, maxChannels, excludedSites}
 * @returns {{rows: Array, stats: object}}
 */
export function selectGuideRows(guideRows, feeds, wantedIds, opts = {}) {
  const maxSites = opts.maxSites ?? DEFAULTS.maxSites;
  const maxChannels = opts.maxChannels ?? DEFAULTS.maxChannels;
  const excludedSites = new Set(opts.excludedSites || []);

  const mainFeedByChannel = new Map();
  for (const f of feeds) {
    if (f && f.is_main && f.channel) mainFeedByChannel.set(f.channel, f.id);
  }

  // 対象チャンネルの有効なガイド行だけを集める(除外サイトの行はここで落とし、
  // 代替ガイドを持つチャンネルは残った行から通常どおり選定される)
  const rowsByChannel = new Map();
  const channelsWithAnyGuide = new Set();
  for (const g of guideRows) {
    if (!g || !g.channel || !g.site || !g.site_id) continue;
    if (!wantedIds.has(g.channel)) continue;
    channelsWithAnyGuide.add(g.channel);
    if (excludedSites.has(g.site)) continue;
    let rows = rowsByChannel.get(g.channel);
    if (!rows) rowsByChannel.set(g.channel, (rows = []));
    rows.push(g);
  }
  // 除外サイトにしかガイドが無く、選定から漏れたチャンネル数(ログ用)
  const droppedByExclusion = channelsWithAnyGuide.size - rowsByChannel.size;

  // サイトのカバレッジ = そのサイトがガイドを持つ対象チャンネル数
  const siteCoverage = new Map();
  for (const rows of rowsByChannel.values()) {
    for (const site of new Set(rows.map((r) => r.site))) {
      siteCoverage.set(site, (siteCoverage.get(site) || 0) + 1);
    }
  }

  const cmp = (a, b) =>
    (siteCoverage.get(b.site) || 0) - (siteCoverage.get(a.site) || 0) ||
    a.site.localeCompare(b.site) ||
    String(a.site_id).localeCompare(String(b.site_id)) ||
    String(a.feed || '').localeCompare(String(b.feed || ''));

  const pick = (rows, allowedSites) => {
    let pool = allowedSites ? rows.filter((r) => allowedSites.has(r.site)) : rows;
    if (!pool.length) return null;
    const channel = pool[0].channel;
    const mainFeed = mainFeedByChannel.get(channel);
    const mainRows = mainFeed ? pool.filter((r) => r.feed === mainFeed) : [];
    if (mainRows.length) pool = mainRows;
    return [...pool].sort(cmp)[0];
  };

  const channelIds = [...rowsByChannel.keys()].sort();
  let chosen = new Map(); // channel id → row
  for (const id of channelIds) {
    const row = pick(rowsByChannel.get(id), null);
    if (row) chosen.set(id, row);
  }

  // サイト数上限: 選定結果ベースで上位サイトを残し、外れたチャンネルは再選定
  const chosenPerSite = new Map();
  for (const row of chosen.values()) {
    chosenPerSite.set(row.site, (chosenPerSite.get(row.site) || 0) + 1);
  }
  let droppedBySiteCap = 0;
  if (chosenPerSite.size > maxSites) {
    const keptSites = new Set(
      [...chosenPerSite.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, maxSites)
        .map(([site]) => site)
    );
    const rechosen = new Map();
    for (const id of channelIds) {
      if (!chosen.has(id)) continue;
      const row = keptSites.has(chosen.get(id).site)
        ? chosen.get(id)
        : pick(rowsByChannel.get(id), keptSites);
      if (row) rechosen.set(id, row);
      else droppedBySiteCap++;
    }
    chosen = rechosen;
  }

  // チャンネル数上限(id 順で決定的に切る)
  let droppedByChannelCap = 0;
  if (chosen.size > maxChannels) {
    droppedByChannelCap = chosen.size - maxChannels;
    chosen = new Map([...chosen.entries()].slice(0, maxChannels));
  }

  const rows = [...chosen.values()].sort(
    (a, b) =>
      a.site.localeCompare(b.site) ||
      String(a.site_id).localeCompare(String(b.site_id)) ||
      a.channel.localeCompare(b.channel)
  );
  const sites = new Set(rows.map((r) => r.site));

  return {
    rows,
    stats: {
      wanted: wantedIds.size,
      withGuide: rowsByChannel.size,
      selected: rows.length,
      sites: sites.size,
      droppedByExclusion,
      droppedBySiteCap,
      droppedByChannelCap,
    },
  };
}

// ---- channels.xml -----------------------------------------------------------

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * iptv-org/epg グラバー用の custom.channels.xml を生成する。
 * xmltv_id は「<チャンネルID>@<フィードID>」(フィード無しはチャンネルID のみ)。
 * この id がグラブ結果の programs[].channel にそのまま現れる。
 */
export function buildChannelsXml(rows) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>'];
  for (const r of rows) {
    const xmltvId = r.feed ? `${r.channel}@${r.feed}` : r.channel;
    lines.push(
      `  <channel site="${escapeXml(r.site)}" lang="${escapeXml(r.lang || 'en')}" ` +
        `xmltv_id="${escapeXml(xmltvId)}" site_id="${escapeXml(r.site_id)}">` +
        `${escapeXml(r.site_name || r.channel)}</channel>`
    );
  }
  lines.push('</channels>', '');
  return lines.join('\n');
}

// ---- グラブ結果の変換 -------------------------------------------------------

// FNV-1a 32bit。details のシャード割り当てに使う(schedule.json に記録して配る)
export function shardIndex(channelId, shardCount) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < channelId.length; i++) {
    hash ^= channelId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

/**
 * 番組名・説明文に残る HTML 実体参照(`Half &amp; Half` など)を復号する。
 * グラバーのサイト別スクレイパは HTML 由来のテキストをそのまま返すため、
 * XML パーサを通ったあとも実体参照が残ることがある(本番データ実測では
 * `&amp;` が 902 件・`&nbsp;` が 1 件)。復号しないと表示が崩れ、
 * 番組タイトル検索で「half & half」が一致しない。
 *
 * 表は XML の 5 実体 + 番組表で現実に現れる範囲に絞る。未知の実体は
 * 元の文字列のまま残す(取りこぼしても壊さない方を選ぶ)。二重符号化
 * (`&amp;amp;`)は 1 回だけ復号する — 繰り返すと本来 `&amp;` と書きたい
 * タイトルを壊すため。
 * クライアント側にも同じ復号が必要(assets/js/epg.js)。生成データが
 * 入れ替わるのは次回グラブ後なので、既存データにも耐えるようにしてある。
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', deg: '°', trade: '™',
  copy: '©', reg: '®', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', szlig: 'ß',
};

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(text) {
  if (typeof text !== 'string' || text.indexOf('&') === -1) return text;
  return text.replace(ENTITY_RE, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // 範囲外・サロゲート単体は復号すると壊れた文字になるので元のまま残す
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

function firstValue(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const v = list[0] && list[0].value != null ? String(list[0].value) : '';
  // 復号してから trim する(`&nbsp;` だけの値を空文字に畳むため)
  return decodeEntities(v).trim();
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);
  // UTF-16 コード単位で切るためサロゲートペアの中央に当たり得る。
  // 孤立した上位サロゲートを残すと表示側で U+FFFD になるため取り除く
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function episodeLabel(episodeNumbers) {
  if (!Array.isArray(episodeNumbers)) return '';
  const found = episodeNumbers.find((e) => e && e.system === 'SxxExx' && e.value);
  return found ? String(found.value).trim() : '';
}

/**
 * iptv-org/epg の `--json` 出力(date / channels / programs)を配信形式へ変換する。
 *
 * - programs[].channel は「<チャンネルID>@<フィードID>」→ チャンネルID をキーに戻す
 * - タイトル無し・時刻不正・長すぎる番組はデータ不良としてスキップ
 * - 生成時点より pruneAgeSec 以上前に終了した番組は落とす(配信サイズ削減)
 * - 同一 (開始時刻, タイトル) の重複(日またぎで両日に現れる番組)は 1 つに畳む
 *
 * @param {object} grabJson {channels: [...], programs: [...]}
 * @param {object} opts {generatedAt, days, shardCount, descLimit, maxDurationSec, pruneAgeSec}
 * @returns {{schedule: object, shards: object[], stats: object}}
 */
export function convertGuide(grabJson, opts = {}) {
  const shardCount = opts.shardCount ?? DEFAULTS.shardCount;
  const descLimit = opts.descLimit ?? DEFAULTS.descLimit;
  const maxDurationSec = opts.maxDurationSec ?? DEFAULTS.maxDurationSec;
  const pruneAgeSec = opts.pruneAgeSec ?? DEFAULTS.pruneAgeSec;
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const generatedSec = Math.round(Date.parse(generatedAt) / 1000);
  const pruneBeforeSec = Number.isFinite(generatedSec) ? generatedSec - pruneAgeSec : null;

  const perChannel = new Map(); // channelId → {site, feed, byStart: Map(start → program)}
  let skippedPrograms = 0;
  let prunedPrograms = 0;

  for (const p of grabJson.programs || []) {
    const xmltvId = p && p.channel ? String(p.channel) : '';
    if (!xmltvId) {
      skippedPrograms++;
      continue;
    }
    const at = xmltvId.indexOf('@');
    const channelId = at === -1 ? xmltvId : xmltvId.slice(0, at);
    const feed = at === -1 ? null : xmltvId.slice(at + 1);

    const title = firstValue(p.titles);
    const startMs = Number(p.start);
    const stopMs = Number(p.stop);
    if (!title || !Number.isFinite(startMs) || !Number.isFinite(stopMs)) {
      skippedPrograms++;
      continue;
    }
    const start = Math.round(startMs / 1000);
    const dur = Math.round(stopMs / 1000) - start;
    if (dur <= 0 || dur > maxDurationSec) {
      skippedPrograms++;
      continue;
    }
    if (pruneBeforeSec !== null && start + dur < pruneBeforeSec) {
      prunedPrograms++;
      continue;
    }

    let ch = perChannel.get(channelId);
    if (!ch) perChannel.set(channelId, (ch = { site: p.site || '', feed, byStart: new Map() }));

    const key = `${start} ${title}`;
    if (ch.byStart.has(key)) continue; // 日またぎ重複
    ch.byStart.set(key, {
      start,
      dur,
      title,
      sub: firstValue(p.subTitles),
      desc: truncate(firstValue(p.descriptions), descLimit),
      category: firstValue(p.categories),
      episode: episodeLabel(p.episodeNumbers),
    });
  }

  const channels = {};
  const shards = Array.from({ length: shardCount }, () => ({}));
  const sites = new Set();
  let programCount = 0;

  for (const channelId of [...perChannel.keys()].sort()) {
    const ch = perChannel.get(channelId);
    const programs = [...ch.byStart.values()].sort((a, b) => a.start - b.start || a.dur - b.dur);
    if (!programs.length) continue;
    const shard = shardIndex(channelId, shardCount);
    channels[channelId] = {
      site: ch.site,
      feed: ch.feed,
      shard,
      p: programs.map((p) => [p.start, p.dur, p.title]),
    };
    shards[shard][channelId] = programs.map((p) => [
      p.start,
      p.dur,
      p.title,
      p.sub,
      p.desc,
      p.category,
      p.episode,
    ]);
    if (ch.site) sites.add(ch.site);
    programCount += programs.length;
  }

  const schedule = {
    generated_at: generatedAt,
    days: opts.days ?? null,
    shard_count: shardCount,
    counts: { channels: Object.keys(channels).length, programs: programCount, sites: sites.size },
    channels,
  };

  return {
    schedule,
    shards,
    stats: { ...schedule.counts, skippedPrograms, prunedPrograms },
  };
}
