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
        if (ch && Array.isArray(ch.p) && ch.p.length) map.set(id, ch);
      }
      byChannel = map;
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
        .catch(() => null);
      shardPromises.set(ch.shard, promise);
    }
    return promise.then((shard) => (shard && shard[channelKey] ? shard[channelKey] : null));
  }

  // ---- 表示ヘルパ(閲覧者のローカル時刻で表示する) -------------------------

  function fmtTime(sec) {
    return new Date(sec * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtRange(start, dur) {
    return `${fmtTime(start)}–${fmtTime(start + dur)}`;
  }

  /** 番組の経過率 0–100(進捗バー用) */
  function progressPercent(start, dur, nowSec) {
    if (dur <= 0) return 0;
    const pct = ((nowSec - start) / dur) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  return { load, isLoaded, getMeta, get, nowNext, upcoming, details, fmtTime, fmtRange, progressPercent };
})();
