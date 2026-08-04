'use strict';

/**
 * アプリ本体: データ読み込み → フィルタ UI 構築 → チャンネルグリッド描画。
 * 一覧は 60 件ずつの遅延描画(IntersectionObserver)で 1 万件超に対応する。
 */
(() => {
  const CHUNK_SIZE = 60;
  const OBSERVER_MARGIN = 600;
  const PAGE_HTTPS = location.protocol === 'https:';
  // テレビ欄(タイムライン)の時間窓。全番組・全期間を描くと行数×番組数が
  // 膨れ上がるため「今〜+6 時間」に固定する(docs/next-features.md §3.2)
  const TIMELINE_HOURS = 6;

  const state = {
    data: null,
    q: '',
    country: '',
    region: '',
    category: '',
    language: '',
    httpsOnly: PAGE_HTTPS, // HTTPS ページでは HTTP 配信は再生不可のため既定でオン
    checkedOnly: false,
    epgOnly: false,
    favOnly: false,
    sort: 'name',
    view: 'cards', // 'cards' | 'timeline'(テレビ欄)
    filtered: [],
    timelineRows: [], // フィルタ適用後、時間窓内に番組があるエントリのみ
    timelineStart: 0, // 時間窓の開始(UTC 秒、時境界に切り下げ)
    rendered: 0,
    entriesByKey: null, // 番組表の定期更新でカード → エントリを引くための索引
    epgCount: 0,
  };

  const $ = (id) => document.getElementById(id);
  let dom = null;
  let observer = null;

  function initDom() {
    dom = {
      toolbar: $('toolbar'),
      filtersToggle: $('filters-toggle'),
      loading: $('loading'),
      loadingList: $('loading-list'),
      loadError: $('load-error'),
      loadErrorMsg: $('load-error-msg'),
      retry: $('retry-btn'),
      app: $('app'),
      search: $('search'),
      country: $('filter-country'),
      region: $('filter-region'),
      category: $('filter-category'),
      language: $('filter-language'),
      sort: $('sort-order'),
      httpsOnly: $('https-only'),
      checkedOnly: $('checked-only'),
      checkedOnlyLabel: $('checked-only-label'),
      epgOnly: $('epg-only'),
      epgOnlyLabel: $('epg-only-label'),
      favOnly: $('fav-only'),
      favOnlyLabel: $('fav-only-label'),
      gridHeadNote: $('grid-head-note'),
      proxyBase: $('proxy-base'),
      proxySave: $('proxy-save'),
      proxyStatus: $('proxy-status'),
      stats: $('stats'),
      grid: $('grid'),
      timeline: $('timeline'),
      timelineEmpty: $('timeline-empty'),
      sentinel: $('sentinel'),
      empty: $('empty'),
      shuffle: $('shuffle-btn'),
      viewToggle: $('view-toggle'),
    };
  }

  // ---- 読み込み画面 ----------------------------------------------------------

  // 読み込み画面に出す表示名(epg のみ実ファイル名がモジュール名と異なる)
  const LOAD_LABELS = { epg: 'epg/schedule.json' };
  const loadLabel = (name) => LOAD_LABELS[name] || `${name}.json`;

  function progressItem(name) {
    const li = document.createElement('li');
    li.id = `progress-${name}`;
    li.textContent = `${loadLabel(name)} …`;
    dom.loadingList.appendChild(li);
    return li;
  }

  async function loadData() {
    dom.loading.hidden = false;
    dom.loadError.hidden = true;
    dom.loadingList.textContent = '';
    const items = {};
    for (const name of ['channels', 'streams', 'feeds', 'logos', 'countries', 'categories', 'languages', 'regions', 'playability', 'epg']) {
      items[name] = progressItem(name);
    }
    const onProgress = (name, ok) => {
      const li = items[name];
      if (li) li.textContent = `${loadLabel(name)} ${ok ? '✓' : '✕ (スキップ)'}`;
    };
    try {
      // 番組表(EPG)は任意データ: 取得失敗(未生成の環境)でもアプリは動く
      const [data] = await Promise.all([IPTVData.loadAll(onProgress), IPTVEpg.load(onProgress)]);
      state.data = data;
      state.entriesByKey = new Map(data.entries.map((e) => [e.key, e]));
      state.epgCount = IPTVEpg.isLoaded()
        ? data.entries.reduce((n, e) => n + (IPTVEpg.get(e.key) ? 1 : 0), 0)
        : 0;
      dom.loading.hidden = true;
      dom.app.hidden = false;
      buildFilters();
      applyFilters();
    } catch (err) {
      dom.loading.hidden = true;
      dom.loadError.hidden = false;
      dom.loadErrorMsg.textContent = err.message;
      return;
    }
    // ディープリンク起因のエラーがデータ読み込み失敗として表示されないよう try の外で開く
    openFromHash();
  }

  // ---- フィルタ UI ----------------------------------------------------------

  function addOption(select, value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }

  function buildFilters() {
    const d = state.data;
    // 再試行時に選択肢が重複しないよう毎回作り直す
    dom.country.textContent = '';
    dom.region.textContent = '';
    dom.category.textContent = '';
    dom.language.textContent = '';
    addOption(dom.country, '', `すべての国・地域 (${d.totals.countries})`);
    for (const c of d.countryOptions) addOption(dom.country, c.code, `${c.flag} ${c.name} (${c.count})`);

    // 地域(大陸・経済圏)フィルタは regions.json が取得できた場合のみ表示
    dom.region.hidden = !d.regionOptions.length;
    if (d.regionOptions.length) {
      addOption(dom.region, '', 'すべての地域');
      for (const r of d.regionOptions) addOption(dom.region, r.code, `${r.name} (${r.count})`);
    }


    addOption(dom.category, '', 'すべてのカテゴリ');
    for (const c of d.categoryOptions) addOption(dom.category, c.id, `${c.name} (${c.count})`);

    addOption(dom.language, '', 'すべての言語');
    for (const l of d.languageOptions) addOption(dom.language, l.code, `${l.name} (${l.count})`);

    dom.httpsOnly.checked = state.httpsOnly;

    const fmtStamp = (at) =>
      at.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const noteParts = [];

    // 再生可能性インデックスがある場合のみフィルタと確認時刻を表示
    if (d.playabilityMeta) {
      dom.checkedOnlyLabel.hidden = false;
      dom.checkedOnlyLabel.lastChild.textContent = ` 再生確認済みのみ (${d.totals.checkedOk.toLocaleString('ja-JP')})`;
      dom.checkedOnly.checked = state.checkedOnly;
      const at = new Date(d.playabilityMeta.generatedAt);
      if (!Number.isNaN(at.getTime())) noteParts.push(`再生確認 ${fmtStamp(at)}`);
    } else {
      dom.checkedOnlyLabel.hidden = true;
    }

    // 番組表(EPG)データがある場合のみテレビ欄ビューを提供する
    dom.viewToggle.hidden = !(state.epgCount > 0);
    if (state.epgCount === 0) state.view = 'cards';
    updateViewToggle();

    // 番組表(EPG)データがある場合のみフィルタと取得時刻を表示
    if (state.epgCount > 0) {
      dom.epgOnlyLabel.hidden = false;
      dom.epgOnlyLabel.lastChild.textContent = ` 番組表ありのみ (${state.epgCount.toLocaleString('ja-JP')})`;
      dom.epgOnly.checked = state.epgOnly;
      const meta = IPTVEpg.getMeta();
      if (meta && meta.generatedAt && !Number.isNaN(meta.generatedAt.getTime())) {
        noteParts.push(`番組表 ${fmtStamp(meta.generatedAt)}`);
      }
    } else {
      dom.epgOnlyLabel.hidden = true;
    }

    dom.favOnly.checked = state.favOnly;
    updateFavLabel();

    if (noteParts.length) dom.gridHeadNote.textContent = noteParts.join(' ・ ');
  }

  function updateFavLabel() {
    dom.favOnlyLabel.lastChild.textContent = ` お気に入りのみ (${IPTVStore.favoriteCount().toLocaleString('ja-JP')})`;
  }

  // ---- フィルタ折りたたみ(モバイル) ----------------------------------------
  //
  // 狭い画面ではフィルタ群を折りたたむ(CSS 側で切替)。適用中のフィルタ数を
  // トグルに表示し、畳んだままでも絞り込み状態が分かるようにする。

  /** 一覧を絞り込んでいる操作の数(既定値から変えたものだけを数える) */
  function activeFilterCount() {
    let n = 0;
    if (state.country) n++;
    if (state.region) n++;
    if (state.category) n++;
    if (state.language) n++;
    if (state.httpsOnly !== PAGE_HTTPS) n++; // HTTPS ページでは既定オンなので差分のみ数える
    if (state.checkedOnly) n++;
    if (state.epgOnly) n++;
    if (state.favOnly) n++;
    return n;
  }

  function updateFiltersToggle() {
    const open = dom.toolbar.classList.contains('filters-open');
    const n = activeFilterCount();
    // 矢印は装飾なので aria-hidden に隔離し、SR には「絞り込み (n)」だけを読ませる
    // (開閉状態は aria-expanded で伝わる)
    dom.filtersToggle.textContent = `絞り込み${n ? ` (${n})` : ''}`;
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = open ? ' ▴' : ' ▾';
    dom.filtersToggle.appendChild(arrow);
    dom.filtersToggle.setAttribute('aria-expanded', String(open));
  }

  // ---- フィルタリング --------------------------------------------------------

  function applyFilters() {
    const d = state.data;
    if (!d) return;
    const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);

    const regionCountries = state.region
      ? (d.regionOptions.find((r) => r.code === state.region) || { countries: new Set() }).countries
      : null;

    state.filtered = d.entries.filter((e) => {
      if (state.country && e.country !== state.country) return false;
      if (regionCountries && !regionCountries.has(e.country)) return false;
      if (state.category && !e.categories.includes(state.category)) return false;
      if (state.language && !e.languages.includes(state.language)) return false;
      // HTTPS のみ: 再生手段の絞り込みなので、配信を持たないチャンネルには適用しない
      if (state.httpsOnly && e.streams.length && !e.hasHttps) return false;
      if (state.checkedOnly && e.playability !== 'ok') return false;
      if (state.epgOnly && !IPTVEpg.get(e.key)) return false;
      if (state.favOnly && !IPTVStore.isFavorite(e.key)) return false;
      for (const t of tokens) {
        if (e.haystack.indexOf(t) === -1) return false;
      }
      return true;
    });

    // お気に入りを常に先頭へ。その中では再生確認済み → 未確認 → 応答なし → 配信なし、の順
    const frank = (e) => (IPTVStore.isFavorite(e.key) ? 0 : 1);
    const prank = (e) =>
      !e.streams.length ? 3 : e.playability === 'ok' ? 0 : e.playability === 'dead' ? 2 : 1;
    if (state.sort === 'recent') {
      // 最近見た順: 再生できた履歴が新しいものから。履歴が無いものは通常の名前順
      const ranks = IPTVStore.historyRanks();
      const hrank = (e) => (ranks.has(e.key) ? ranks.get(e.key) : Infinity);
      state.filtered.sort((a, b) => (frank(a) - frank(b)) || (hrank(a) - hrank(b)) || (prank(a) - prank(b)) || a.sortKey.localeCompare(b.sortKey, 'en'));
    } else if (state.sort === 'country') {
      state.filtered.sort((a, b) => (frank(a) - frank(b)) || (prank(a) - prank(b)) || a.countryName.localeCompare(b.countryName, 'en') || a.sortKey.localeCompare(b.sortKey, 'en'));
    } else {
      state.filtered.sort((a, b) => (frank(a) - frank(b)) || (prank(a) - prank(b)) || a.sortKey.localeCompare(b.sortKey, 'en'));
    }

    dom.stats.textContent = `${state.filtered.length.toLocaleString('ja-JP')} / ${d.totals.channels.toLocaleString('ja-JP')} チャンネル`;
    updateFiltersToggle();

    dom.grid.textContent = '';
    dom.timeline.textContent = '';
    tlBody = null;
    state.rendered = 0;
    if (state.view === 'timeline') {
      prepareTimeline();
    } else {
      dom.grid.hidden = false;
      dom.timeline.hidden = true;
      dom.timelineEmpty.hidden = true;
      dom.empty.hidden = state.filtered.length > 0;
    }
    renderChunk();
  }

  // ---- グリッド描画 ----------------------------------------------------------

  function logoPlaceholder(entry) {
    const ph = document.createElement('div');
    ph.className = 'logo-placeholder';
    ph.textContent = entry.name.slice(0, 2);
    return ph;
  }

  function createCard(entry) {
    // お気に入りトグル(button)を内包するため、カード自体は button にできない
    // (button のネストは不正)。div + role=button + キーボード操作で代替する
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = entry.key;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'fav-btn';
    updateFavButton(fav, IPTVStore.isFavorite(entry.key));
    fav.addEventListener('click', (e) => {
      e.stopPropagation(); // プレイヤーを開かない
      const on = IPTVStore.toggleFavorite(entry.key);
      updateFavButton(fav, on);
      updateFavLabel();
      // お気に入りフィルタ適用中は結果が変わるため再描画(通常時は並びを乱さない)
      if (state.favOnly) applyFilters();
    });
    card.appendChild(fav);

    const logoWrap = document.createElement('div');
    logoWrap.className = 'card-logo';
    if (entry.logo) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = entry.logo;
      img.addEventListener('error', () => {
        img.remove();
        logoWrap.appendChild(logoPlaceholder(entry));
      }, { once: true });
      logoWrap.appendChild(img);
    } else {
      logoWrap.appendChild(logoPlaceholder(entry));
    }
    card.appendChild(logoWrap);

    const body = document.createElement('div');
    body.className = 'card-body';

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = entry.name;
    body.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const catNames = entry.categories
      .slice(0, 2)
      .map((id) => {
        const c = state.data.categoryOptions.find((o) => o.id === id);
        return c ? c.name : id;
      })
      .join(', ');
    meta.textContent = `${entry.flag} ${entry.countryName}${catNames ? ' · ' + catNames : ''}`;
    if (entry.timezone) {
      const t = IPTVData.localTime(entry.timezone, new Date());
      if (t) {
        const local = document.createElement('span');
        local.className = 'card-local';
        local.dataset.tz = entry.timezone;
        local.textContent = ` · 現地 ${t}`;
        meta.appendChild(local);
      }
    }
    body.appendChild(meta);

    if (IPTVEpg.get(entry.key)) {
      const epg = document.createElement('div');
      epg.className = 'card-epg';
      updateCardEpg(epg, entry);
      body.appendChild(epg);
    }

    if (entry.playability === 'dead' || !entry.streams.length) card.classList.add('card-dead');

    const badges = document.createElement('div');
    badges.className = 'card-badges';
    if (!entry.streams.length) {
      const ns = document.createElement('span');
      ns.className = 'badge';
      ns.textContent = '配信なし';
      ns.title = '配信 URL が未登録のチャンネルです(チャンネル情報のみ)';
      badges.appendChild(ns);
    }
    if (entry.isNsfw) {
      const nb = document.createElement('span');
      nb.className = 'badge warn';
      nb.textContent = '18+';
      nb.title = 'アダルトコンテンツを含む可能性のあるチャンネルです';
      badges.appendChild(nb);
    }
    if (entry.playability === 'ok') {
      const okb = document.createElement('span');
      okb.className = 'badge ok';
      okb.textContent = '✓ 確認済';
      okb.title = '直近のチェックでブラウザから再生できることを確認済みの配信があります';
      badges.appendChild(okb);
    } else if (entry.playability === 'dead') {
      const db = document.createElement('span');
      db.className = 'badge dead';
      db.textContent = '応答なし';
      db.title = '直近のチェックでどの配信からも応答がありませんでした';
      badges.appendChild(db);
    }
    if (entry.bestQuality) {
      const q = document.createElement('span');
      q.className = 'badge quality';
      q.textContent = `${entry.bestQuality}p`;
      badges.appendChild(q);
    }
    if (entry.streams.length > 1) {
      const n = document.createElement('span');
      n.className = 'badge';
      n.textContent = `${entry.streams.length} 配信`;
      badges.appendChild(n);
    }
    if (PAGE_HTTPS && !entry.hasHttps) {
      const w = document.createElement('span');
      w.className = 'badge warn';
      w.textContent = 'HTTP のみ';
      w.title = 'HTTPS ページからは再生できない可能性が高い配信です';
      badges.appendChild(w);
    }
    body.appendChild(badges);
    card.appendChild(body);

    card.addEventListener('click', () => openEntry(entry));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return; // お気に入りボタン上のキー操作はそちらに任せる
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEntry(entry);
      }
    });
    return card;
  }

  function updateFavButton(btn, on) {
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', 'お気に入り');
    btn.title = on ? 'お気に入りから外す' : 'お気に入りに追加';
  }

  // ---- カードの番組表(現在番組 / 次番組) -----------------------------------

  function updateCardEpg(el, entry) {
    const ch = IPTVEpg.get(entry.key);
    if (!ch) {
      el.hidden = true;
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const { current, next } = IPTVEpg.nowNext(ch.p, nowSec);
    el.textContent = '';
    el.hidden = false;

    if (current) {
      const title = document.createElement('span');
      title.className = 'card-epg-title';
      title.textContent = `▶ ${current.title}`;
      el.appendChild(title);

      const time = document.createElement('span');
      time.className = 'card-epg-time';
      time.textContent = IPTVEpg.fmtRange(current.start, current.dur);
      el.appendChild(time);

      const bar = document.createElement('div');
      bar.className = 'epg-bar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i');
      fill.style.width = `${IPTVEpg.progressPercent(current.start, current.dur, nowSec)}%`;
      bar.appendChild(fill);
      el.appendChild(bar);
    } else if (next) {
      const title = document.createElement('span');
      title.className = 'card-epg-title card-epg-next';
      title.textContent = `次 ${IPTVEpg.fmtTime(next.start)} ${next.title}`;
      el.appendChild(title);
    } else {
      // 番組表はあるが提供期間外(データが古い)— 行ごと隠す
      el.hidden = true;
    }
  }

  // 描画済みカードの現地時刻表示を現在時刻に追従させる
  function refreshLocalTimes() {
    const now = new Date();
    for (const el of dom.grid.querySelectorAll('.card-local')) {
      const t = IPTVData.localTime(el.dataset.tz, now);
      if (t) el.textContent = ` · 現地 ${t}`;
    }
  }

  // 描画済みカードの現在番組表示を定期更新する(番組境界・進捗バーの追従)
  function refreshEpgCards() {
    if (!state.entriesByKey || !IPTVEpg.isLoaded()) return;
    for (const el of dom.grid.querySelectorAll('.card-epg')) {
      const card = el.closest('.card');
      const entry = card ? state.entriesByKey.get(card.dataset.key) : null;
      if (entry) updateCardEpg(el, entry);
    }
  }

  // ---- テレビ欄(タイムライン)ビュー ----------------------------------------
  //
  // フィルタ適用後のエントリのうち、時間窓(今〜+TIMELINE_HOURS)に番組がある
  // 行だけを描画する。行はカード一覧と同じ遅延チャンク描画に乗せる。

  let tlBody = null; // 横スクロール内の実描画コンテナ(applyFilters ごとに作り直す)

  function updateViewToggle() {
    const on = state.view === 'timeline';
    dom.viewToggle.setAttribute('aria-pressed', String(on));
    dom.viewToggle.textContent = on ? 'カード一覧に戻る' : 'テレビ欄で見る';
  }

  function timelineWindow() {
    const start = state.timelineStart;
    return { start, span: TIMELINE_HOURS * 3600, end: start + TIMELINE_HOURS * 3600 };
  }

  function prepareTimeline() {
    // 時刻目盛りが揃うよう、窓の開始は時境界に切り下げる
    state.timelineStart = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const w = timelineWindow();
    state.timelineRows = state.filtered.filter((e) => {
      const ch = IPTVEpg.get(e.key);
      return ch && ch.p.some((p) => p[0] < w.end && p[0] + p[1] > w.start);
    });

    dom.grid.hidden = true;
    dom.empty.hidden = true;
    dom.timeline.hidden = false;
    dom.timelineEmpty.hidden = state.timelineRows.length > 0;

    tlBody = document.createElement('div');
    tlBody.className = 'tl-body';

    const head = document.createElement('div');
    head.className = 'tl-head';
    const corner = document.createElement('div');
    corner.className = 'tl-corner';
    corner.textContent = 'CHANNEL ・ 番組';
    head.appendChild(corner);
    const scale = document.createElement('div');
    scale.className = 'tl-scale';
    scale.setAttribute('aria-hidden', 'true');
    for (let h = 0; h < TIMELINE_HOURS; h++) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = `${((h / TIMELINE_HOURS) * 100).toFixed(4)}%`;
      tick.textContent = IPTVEpg.fmtTime(w.start + h * 3600);
      scale.appendChild(tick);
    }
    head.appendChild(scale);
    tlBody.appendChild(head);

    const nowline = document.createElement('i');
    nowline.className = 'tl-nowline';
    nowline.setAttribute('aria-hidden', 'true');
    tlBody.appendChild(nowline);

    dom.timeline.appendChild(tlBody);
    updateTimelineNow();
  }

  function createTimelineRow(entry) {
    const w = timelineWindow();
    const nowSec = Math.floor(Date.now() / 1000);
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.key = entry.key;

    const ch = document.createElement('button');
    ch.type = 'button';
    ch.className = 'tl-ch';
    ch.title = `${entry.name} を再生`;
    const name = document.createElement('span');
    name.className = 'tl-ch-name';
    name.textContent = entry.name;
    ch.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'tl-ch-meta';
    meta.textContent = `${entry.flag} ${entry.countryName}`;
    ch.appendChild(meta);
    ch.addEventListener('click', () => openEntry(entry));
    row.appendChild(ch);

    const track = document.createElement('div');
    track.className = 'tl-track';
    for (const [start, dur, title] of IPTVEpg.get(entry.key).p) {
      const end = start + dur;
      if (end <= w.start || start >= w.end) continue;
      const clipStart = Math.max(start, w.start);
      const clipEnd = Math.min(end, w.end);
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'tl-prog';
      block.dataset.start = String(start);
      block.dataset.end = String(end);
      if (start <= nowSec && nowSec < end) block.classList.add('tl-current');
      block.style.left = `${(((clipStart - w.start) / w.span) * 100).toFixed(4)}%`;
      block.style.width = `${(((clipEnd - clipStart) / w.span) * 100).toFixed(4)}%`;
      block.title = `${IPTVEpg.fmtRange(start, dur)} ${title}`;
      const t = document.createElement('span');
      t.className = 'tl-prog-title';
      t.textContent = title;
      block.appendChild(t);
      const time = document.createElement('span');
      time.className = 'tl-prog-time';
      time.textContent = IPTVEpg.fmtTime(start);
      block.appendChild(time);
      block.addEventListener('click', () => openEntry(entry));
      track.appendChild(block);
    }
    row.appendChild(track);
    return row;
  }

  /** 現在時刻ライン(--now-pct)と「放送中」ハイライトを現在時刻に追従させる */
  function updateTimelineNow() {
    if (state.view !== 'timeline' || !tlBody) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const w = timelineWindow();
    const pct = Math.max(0, Math.min(1, (nowSec - w.start) / w.span));
    tlBody.style.setProperty('--now-pct', pct.toFixed(4));
    for (const block of tlBody.querySelectorAll('.tl-prog')) {
      const s = Number(block.dataset.start);
      const e = Number(block.dataset.end);
      block.classList.toggle('tl-current', s <= nowSec && nowSec < e);
    }
  }

  function renderChunk() {
    const timeline = state.view === 'timeline';
    const list = timeline ? state.timelineRows : state.filtered;
    const container = timeline ? tlBody : dom.grid;
    if (!container) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(state.rendered + CHUNK_SIZE, list.length);
    for (let i = state.rendered; i < end; i++) {
      frag.appendChild(timeline ? createTimelineRow(list[i]) : createCard(list[i]));
    }
    state.rendered = end;
    container.appendChild(frag);
    dom.sentinel.hidden = state.rendered >= list.length;
    // IntersectionObserver は交差状態の「変化」しか通知しないため、
    // 広い画面で 1 チャンクが番兵を観測圏外へ押し出せない場合は続けて描画する
    if (
      state.rendered < list.length &&
      dom.sentinel.getBoundingClientRect().top < window.innerHeight + OBSERVER_MARGIN
    ) {
      requestAnimationFrame(renderChunk);
    }
  }

  function initObserver() {
    observer = new IntersectionObserver((entries) => {
      const list = state.view === 'timeline' ? state.timelineRows : state.filtered;
      if (entries.some((e) => e.isIntersecting) && state.rendered < list.length) {
        renderChunk();
      }
    }, { rootMargin: `${OBSERVER_MARGIN}px` });
    observer.observe(dom.sentinel);
  }

  // ---- プレイヤー連携 / ディープリンク ---------------------------------------

  function openEntry(entry) {
    history.replaceState(null, '', `#play=${encodeURIComponent(entry.key)}`);
    IPTVPlayer.open(entry);
  }

  function openFromHash() {
    const m = location.hash.match(/^#play=(.+)$/);
    if (!m) return;
    let key;
    try {
      key = decodeURIComponent(m[1]);
    } catch (err) {
      return; // 壊れたパーセントエンコーディングは黙って無視する
    }
    const entry = state.data.entries.find((e) => e.key === key);
    if (entry) IPTVPlayer.open(entry);
  }

  function clearHash() {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  // ---- イベント --------------------------------------------------------------

  function debounce(fn, ms) {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function bindEvents() {
    dom.search.addEventListener('input', debounce(() => {
      state.q = dom.search.value.trim();
      applyFilters();
    }, 150));
    dom.country.addEventListener('change', () => { state.country = dom.country.value; applyFilters(); });
    dom.region.addEventListener('change', () => { state.region = dom.region.value; applyFilters(); });
    dom.category.addEventListener('change', () => { state.category = dom.category.value; applyFilters(); });
    dom.language.addEventListener('change', () => { state.language = dom.language.value; applyFilters(); });
    dom.sort.addEventListener('change', () => { state.sort = dom.sort.value; applyFilters(); });
    dom.httpsOnly.addEventListener('change', () => { state.httpsOnly = dom.httpsOnly.checked; applyFilters(); });
    dom.checkedOnly.addEventListener('change', () => { state.checkedOnly = dom.checkedOnly.checked; applyFilters(); });
    dom.epgOnly.addEventListener('change', () => { state.epgOnly = dom.epgOnly.checked; applyFilters(); });
    dom.favOnly.addEventListener('change', () => { state.favOnly = dom.favOnly.checked; applyFilters(); });
    dom.proxyBase.value = IPTVPlayer.getProxyBase();
    dom.proxySave.addEventListener('click', () => {
      const v = dom.proxyBase.value.trim();
      IPTVPlayer.setProxyBase(v);
      dom.proxyStatus.textContent = v ? `プロキシを設定しました: ${v}` : 'プロキシ設定を解除しました';
    });
    dom.shuffle.addEventListener('click', () => {
      // ランダム選局は「再生できる可能性のある」チャンネルから選ぶ(配信なしは除く)
      const pool = state.filtered.filter((e) => e.streams.length);
      if (!pool.length) return;
      openEntry(pool[Math.floor(Math.random() * pool.length)]);
    });
    dom.filtersToggle.addEventListener('click', () => {
      dom.toolbar.classList.toggle('filters-open');
      updateFiltersToggle();
    });
    dom.viewToggle.addEventListener('click', () => {
      state.view = state.view === 'timeline' ? 'cards' : 'timeline';
      updateViewToggle();
      applyFilters();
    });
    dom.retry.addEventListener('click', loadData);
    window.addEventListener('hashchange', () => {
      if (state.data) openFromHash();
    });
  }

  // ---- 時計(マストヘッドの UTC 表示) ---------------------------------------

  function startClock() {
    const el = $('clock');
    if (!el) return;
    const tick = () => {
      el.textContent = `UTC ${new Date().toISOString().slice(11, 19)}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---- 起動 ------------------------------------------------------------------

  function start() {
    initDom();
    IPTVPlayer.init({
      onClose: clearHash,
      // 「実際に再生できた」ときだけ履歴に残す(開いただけ・失敗は記録しない)
      onPlaying: (key) => IPTVStore.recordPlayed(key),
    });
    bindEvents();
    initObserver();
    startClock();
    setInterval(() => {
      refreshEpgCards();
      refreshLocalTimes();
      updateTimelineNow();
    }, 30000);
    loadData();
    // テスト・デバッグ用フック
    window.__IPTV__ = { state };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
