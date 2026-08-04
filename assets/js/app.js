'use strict';

/**
 * アプリ本体: データ読み込み → フィルタ UI 構築 → チャンネルグリッド描画。
 * 一覧は 60 件ずつの遅延描画(IntersectionObserver)で 1 万件超に対応する。
 */
(() => {
  const CHUNK_SIZE = 60;
  const OBSERVER_MARGIN = 600;
  const PAGE_HTTPS = location.protocol === 'https:';

  const state = {
    data: null,
    q: '',
    country: '',
    category: '',
    language: '',
    httpsOnly: PAGE_HTTPS, // HTTPS ページでは HTTP 配信は再生不可のため既定でオン
    sort: 'name',
    filtered: [],
    rendered: 0,
  };

  const $ = (id) => document.getElementById(id);
  let dom = null;
  let observer = null;

  function initDom() {
    dom = {
      loading: $('loading'),
      loadingList: $('loading-list'),
      loadError: $('load-error'),
      loadErrorMsg: $('load-error-msg'),
      retry: $('retry-btn'),
      app: $('app'),
      search: $('search'),
      country: $('filter-country'),
      category: $('filter-category'),
      language: $('filter-language'),
      sort: $('sort-order'),
      httpsOnly: $('https-only'),
      stats: $('stats'),
      grid: $('grid'),
      sentinel: $('sentinel'),
      empty: $('empty'),
      shuffle: $('shuffle-btn'),
    };
  }

  // ---- 読み込み画面 ----------------------------------------------------------

  function progressItem(name) {
    const li = document.createElement('li');
    li.id = `progress-${name}`;
    li.textContent = `${name}.json …`;
    dom.loadingList.appendChild(li);
    return li;
  }

  async function loadData() {
    dom.loading.hidden = false;
    dom.loadError.hidden = true;
    dom.loadingList.textContent = '';
    const items = {};
    for (const name of ['channels', 'streams', 'feeds', 'logos', 'countries', 'categories', 'languages']) {
      items[name] = progressItem(name);
    }
    try {
      const data = await IPTVData.loadAll((name, ok) => {
        const li = items[name];
        if (li) li.textContent = `${name}.json ${ok ? '✓' : '✕ (スキップ)'}`;
      });
      state.data = data;
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
    dom.category.textContent = '';
    dom.language.textContent = '';
    addOption(dom.country, '', `すべての国・地域 (${d.totals.countries})`);
    for (const c of d.countryOptions) addOption(dom.country, c.code, `${c.flag} ${c.name} (${c.count})`);

    addOption(dom.category, '', 'すべてのカテゴリ');
    for (const c of d.categoryOptions) addOption(dom.category, c.id, `${c.name} (${c.count})`);

    addOption(dom.language, '', 'すべての言語');
    for (const l of d.languageOptions) addOption(dom.language, l.code, `${l.name} (${l.count})`);

    dom.httpsOnly.checked = state.httpsOnly;
  }

  // ---- フィルタリング --------------------------------------------------------

  function applyFilters() {
    const d = state.data;
    if (!d) return;
    const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);

    state.filtered = d.entries.filter((e) => {
      if (state.country && e.country !== state.country) return false;
      if (state.category && !e.categories.includes(state.category)) return false;
      if (state.language && !e.languages.includes(state.language)) return false;
      if (state.httpsOnly && !e.hasHttps) return false;
      for (const t of tokens) {
        if (e.haystack.indexOf(t) === -1) return false;
      }
      return true;
    });

    if (state.sort === 'country') {
      state.filtered.sort((a, b) => a.countryName.localeCompare(b.countryName, 'en') || a.sortKey.localeCompare(b.sortKey, 'en'));
    } else {
      state.filtered.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'en'));
    }

    dom.stats.textContent = `${state.filtered.length.toLocaleString('ja-JP')} / ${d.totals.channels.toLocaleString('ja-JP')} チャンネル`;
    dom.empty.hidden = state.filtered.length > 0;

    dom.grid.textContent = '';
    state.rendered = 0;
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
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.key = entry.key;

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
    body.appendChild(meta);

    const badges = document.createElement('div');
    badges.className = 'card-badges';
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
    return card;
  }

  function renderChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(state.rendered + CHUNK_SIZE, state.filtered.length);
    for (let i = state.rendered; i < end; i++) {
      frag.appendChild(createCard(state.filtered[i]));
    }
    state.rendered = end;
    dom.grid.appendChild(frag);
    dom.sentinel.hidden = state.rendered >= state.filtered.length;
    // IntersectionObserver は交差状態の「変化」しか通知しないため、
    // 広い画面で 1 チャンクが番兵を観測圏外へ押し出せない場合は続けて描画する
    if (
      state.rendered < state.filtered.length &&
      dom.sentinel.getBoundingClientRect().top < window.innerHeight + OBSERVER_MARGIN
    ) {
      requestAnimationFrame(renderChunk);
    }
  }

  function initObserver() {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && state.rendered < state.filtered.length) {
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
    dom.category.addEventListener('change', () => { state.category = dom.category.value; applyFilters(); });
    dom.language.addEventListener('change', () => { state.language = dom.language.value; applyFilters(); });
    dom.sort.addEventListener('change', () => { state.sort = dom.sort.value; applyFilters(); });
    dom.httpsOnly.addEventListener('change', () => { state.httpsOnly = dom.httpsOnly.checked; applyFilters(); });
    dom.shuffle.addEventListener('click', () => {
      if (!state.filtered.length) return;
      const entry = state.filtered[Math.floor(Math.random() * state.filtered.length)];
      openEntry(entry);
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
    IPTVPlayer.init({ onClose: clearHash });
    bindEvents();
    initObserver();
    startClock();
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
