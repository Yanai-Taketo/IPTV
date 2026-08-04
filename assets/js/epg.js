'use strict';

/**
 * EPG(電子番組表)クライアント。
 * CI(.github/workflows/grab-epg.yml)が生成する静的データを読む:
 *   data/epg/schedule.json    … 全対象チャンネルの [開始秒, 長さ秒, タイトル] 一覧(一括取得)
 *   data/epg/details-<n>.json … 説明文などの詳細シャード(プレイヤーを開いたとき遅延取得)
 * シャード番号は schedule.json のチャンネルごとに記録されているため、
 * クライアント側はハッシュ計算を持たない。データが無い環境(404)では
 * isLoaded() が false になり、EPG 関連 UI は一切表示されない。
 */
const IPTVEpg = (() => {
  const SCHEDULE_URL = 'data/epg/schedule.json';
  const DETAILS_BASE = 'data/epg';

  let meta = null;      // { generatedAt: Date|null, days, counts }
  let byChannel = null; // Map(チャンネルid → { site, feed, shard, p: [[s, d, title], …] })
  const shardPromises = new Map();
  const titleHaystacks = new Map(); // チャンネルid → 全番組タイトルを繋いだ小文字列

  // ---- HTML 実体参照の復号 ---------------------------------------------------
  //
  // 生成側(scripts/epg-lib.mjs の decodeEntities)と同じ復号をここでも行う。
  // 配信データは日次で作り直されるため、生成側の修正が入る前の
  // 「未復号のタイトル」(`Half &amp; Half` 等)にも耐える必要がある。
  // 生成側で復号済みのデータに対しては何もしない(& を含まなければ即 return)。

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    bull: '•', middot: '·', deg: '°', trade: '™',
    copy: '©', reg: '®', laquo: '«', raquo: '»',
    eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
    uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', szlig: 'ß',
  };

  const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

  function decodeEntities(text) {
    if (typeof text !== 'string' || text.indexOf('&') === -1) return text;
    return text.replace(ENTITY_RE, (match, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        if (code >= 0xd800 && code <= 0xdfff) return match;
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body];
      return named === undefined ? match : named;
    });
  }

  async function load(onProgress) {
    try {
      const res = await fetch(SCHEDULE_URL, { cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || typeof json.channels !== 'object' || json.channels === null) {
        throw new Error('unexpected schedule format');
      }
      const map = new Map();
      for (const id of Object.keys(json.channels)) {
        const ch = json.channels[id];
        if (!ch || !Array.isArray(ch.p) || !ch.p.length) continue;
        for (const p of ch.p) p[2] = decodeEntities(p[2]);
        map.set(id, ch);
      }
      byChannel = map;
      titleHaystacks.clear();
      meta = {
        generatedAt: json.generated_at ? new Date(json.generated_at) : null,
        days: json.days || null,
        counts: json.counts || null,
      };
      if (onProgress) onProgress('epg', true);
      return true;
    } catch (err) {
      byChannel = null;
      meta = null;
      if (onProgress) onProgress('epg', false);
      return false;
    }
  }

  function isLoaded() {
    return byChannel !== null;
  }

  function getMeta() {
    return meta;
  }

  /** チャンネルの番組表( schedule.json のエントリ)。無ければ null */
  function get(channelKey) {
    return byChannel ? byChannel.get(channelKey) || null : null;
  }

  /** 現在放送中の番組と次番組。programs は開始時刻順の [[s, d, title], …] */
  function nowNext(programs, nowSec) {
    let current = null;
    let next = null;
    for (let i = 0; i < programs.length; i++) {
      const s = programs[i][0];
      const d = programs[i][1];
      if (s <= nowSec && nowSec < s + d) {
        current = { start: s, dur: d, title: programs[i][2], index: i };
      } else if (s > nowSec) {
        next = { start: s, dur: d, title: programs[i][2], index: i };
        break;
      }
    }
    return { current, next };
  }

  /** 放送中 + これからの番組を最大 limit 件(プレイヤーの番組表用) */
  function upcoming(programs, nowSec, limit) {
    const out = [];
    for (let i = 0; i < programs.length && out.length < limit; i++) {
      const s = programs[i][0];
      const d = programs[i][1];
      if (s + d <= nowSec) continue; // 終了済み
      out.push({ start: s, dur: d, title: programs[i][2], isCurrent: s <= nowSec });
    }
    return out;
  }

  /**
   * 詳細シャードからこのチャンネルの詳細番組リストを返す。
   * 形式: [[開始秒, 長さ秒, タイトル, サブタイトル, 説明, カテゴリ, 話数], …]
   * シャードはセッション中キャッシュし、取得失敗時は null(致命的でない)。
   */
  function details(channelKey) {
    const ch = get(channelKey);
    if (!ch || typeof ch.shard !== 'number') return Promise.resolve(null);
    let promise = shardPromises.get(ch.shard);
    if (!promise) {
      promise = fetch(`${DETAILS_BASE}/details-${ch.shard}.json`, { cache: 'default' })
        .then((res) => (res.ok ? res.json() : null))
        .then((shard) => {
          // schedule 側のタイトルは復号済みなので、突き合わせる詳細側も揃える
          // (揃えないと説明文の行が見つからなくなる)
          if (shard) {
            for (const id of Object.keys(shard)) {
              for (const row of shard[id]) {
                for (let i = 2; i < row.length; i++) row[i] = decodeEntities(row[i]);
              }
            }
          }
          return shard;
        })
        .catch(() => null);
      shardPromises.set(ch.shard, promise);
    }
    return promise.then((shard) => (shard && shard[channelKey] ? shard[channelKey] : null));
  }

  /**
   * 番組タイトル検索用の照合文字列(全番組タイトルを改行で繋いだ小文字列)。
   * 番組表はセッション中変わらないためチャンネル単位でキャッシュする
   * (改行で繋ぐのは、隣り合うタイトルをまたいだ誤一致を防ぐため)。
   */
  function titleHaystack(channelKey) {
    let h = titleHaystacks.get(channelKey);
    if (h === undefined) {
      const ch = get(channelKey);
      h = ch ? ch.p.map((p) => p[2]).join('\n').toLowerCase() : '';
      titleHaystacks.set(channelKey, h);
    }
    return h;
  }

  // ---- 表示ヘルパ(閲覧者のローカル時刻で表示する) -------------------------

  function fmtTime(sec) {
    return new Date(sec * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtRange(start, dur) {
    return `${fmtTime(start)}–${fmtTime(start + dur)}`;
  }

  /** 当日は HH:MM、別日なら「M/D HH:MM」。検索一致は最大 2 日先まで出る */
  function fmtDayTime(sec) {
    const at = new Date(sec * 1000);
    if (at.toDateString() === new Date().toDateString()) return fmtTime(sec);
    const day = at.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
    return `${day} ${fmtTime(sec)}`;
  }

  /** 番組の経過率 0–100(進捗バー用) */
  function progressPercent(start, dur, nowSec) {
    if (dur <= 0) return 0;
    const pct = ((nowSec - start) / dur) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  return {
    load, isLoaded, getMeta, get, nowNext, upcoming, details, titleHaystack,
    fmtTime, fmtRange, fmtDayTime, progressPercent, decodeEntities,
  };
})();
