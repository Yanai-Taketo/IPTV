'use strict';

/**
 * お気に入り・視聴履歴の保存基盤(localStorage 共有)。
 * プライベートモード等で localStorage が使えない環境では
 * メモリ上だけで動作する(リロードで消えるが機能自体は壊れない)。
 *
 * 履歴は「実際に再生できた」記録として持つ(プレイヤーの playing イベントで
 * 記録する — 開いただけ・失敗した配信は残らない)。
 */
const IPTVStore = (() => {
  const FAV_KEY = 'iptv:favorites';
  const HISTORY_KEY = 'iptv:history';
  const HISTORY_LIMIT = 50;

  function read(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 保存不可でもメモリ上の状態で動き続ける */ }
  }

  const favorites = new Set(read(FAV_KEY).filter((k) => typeof k === 'string'));
  // 履歴: [{k: チャンネルキー, at: epoch ミリ秒}, …] 新しい順
  let history = read(HISTORY_KEY).filter((h) => h && typeof h.k === 'string');

  function isFavorite(key) {
    return favorites.has(key);
  }

  function favoriteCount() {
    return favorites.size;
  }

  /** お気に入りを切り替え、切り替え後の状態(true = お気に入り)を返す */
  function toggleFavorite(key) {
    if (favorites.has(key)) favorites.delete(key);
    else favorites.add(key);
    write(FAV_KEY, [...favorites]);
    return favorites.has(key);
  }

  /** 再生できたチャンネルを履歴の先頭に記録する(重複は 1 件に畳む) */
  function recordPlayed(key) {
    history = [{ k: key, at: Date.now() }, ...history.filter((h) => h.k !== key)].slice(
      0,
      HISTORY_LIMIT
    );
    write(HISTORY_KEY, history);
  }

  /** チャンネルキー → 履歴順位(0 が最新)。並べ替え用に一括で返す */
  function historyRanks() {
    const ranks = new Map();
    history.forEach((h, i) => ranks.set(h.k, i));
    return ranks;
  }

  function historyCount() {
    return history.length;
  }

  return { isFavorite, favoriteCount, toggleFavorite, recordPlayed, historyRanks, historyCount };
})();
