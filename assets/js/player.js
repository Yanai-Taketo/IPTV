'use strict';

/**
 * プレイヤーモーダル。
 * hls.js (MSE) → Safari ネイティブ HLS の順でフォールバックし、
 * 失敗時はチャンネル内の別ストリームを自動で順に試す。
 * 全滅したらエラーパネル(URLコピー / .m3u ダウンロード / 公式サイト)を表示する。
 */
const IPTVPlayer = (() => {
  const DASH_CDN = 'https://cdn.jsdelivr.net/npm/dashjs@5.2.0/dist/modern/umd/dash.all.min.js';
  const DASH_SRI = 'sha384-DUqWPzOl/i7/DGF7SBoe4NrlZOMxxomlJsg3X0daS5SBeFxco3dmwWQPFr2oauXn';
  const WATCHDOG_MS = 25000;
  const PROXY_KEY = 'iptv:proxy-base';
  const VOLUME_PREF = 'volume';
  const VOLUME_STEP = 0.1;
  const OSD_MS = 1400;

  let dom = null;
  let hls = null;
  let dash = null;
  let entry = null;
  let currentIndex = -1;
  let autoAdvance = true;
  let tried = new Set();
  let failReasons = new Map();
  let mediaRecoveries = 0;
  let networkRecoveries = 0;
  let watchdog = 0;
  let playToken = 0;
  let lastFocus = null;
  let onCloseCallback = null;
  let onPlayingCallback = null;
  let onNavigateCallback = null;
  // ユーザーが意図して切ったミュート。自動再生フォールバックのミュート(一時的)と
  // 区別し、ザッピングで選局し直しても引き継ぐ
  let mutedByUser = false;
  let osdTimer = 0;
  let m3uUrl = null;
  let nativeRescueTried = false; // hls.js の CORS 失敗後に一度だけネイティブ HLS を試す
  let upgradedFromHttp = false;  // 混在コンテンツ回避の https 昇格を試行中か
  let currentPlayUrl = null;

  // ---- 任意プロキシ(既定 OFF・ユーザー自身のプロキシのみ想定) ---------------

  function getProxyBase() {
    try {
      return (localStorage.getItem(PROXY_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  }

  function setProxyBase(value) {
    try {
      if (value) localStorage.setItem(PROXY_KEY, value.trim());
      else localStorage.removeItem(PROXY_KEY);
    } catch (e) { /* プライベートモード等では保存不可 */ }
  }

  let proxyLoaderClass = null;

  // hls.js の全リクエスト(マニフェスト・セグメント・AES キー)をプロキシ経由にする。
  // 相対 URI の解決が壊れないよう、response.url は元のストリーム URL に戻す。
  function getProxyLoader() {
    if (proxyLoaderClass || !window.Hls) return proxyLoaderClass;
    class ProxyLoader extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        const upstream = context.url;
        context.url = getProxyBase() + encodeURIComponent(upstream);
        const onSuccess = callbacks.onSuccess;
        callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
          response.url = upstream;
          onSuccess(response, stats, ctx, networkDetails);
        };
        super.load(context, config, callbacks);
      }
    }
    proxyLoaderClass = ProxyLoader;
    return proxyLoaderClass;
  }

  // ---- Apple ネイティブ HLS(CORS 制約を受けない media 読み込み) -------------

  function canNativeHls() {
    return dom.video.canPlayType('application/vnd.apple.mpegurl') !== '';
  }

  function preferNativeHls() {
    // Safari/iOS ではネイティブ HLS を優先すると CORS 未対応の配信も再生できる。
    // プロキシ設定時はセグメント URL の書き換えが必要なため hls.js を使う。
    return canNativeHls() && !getProxyBase() &&
      (navigator.vendor === 'Apple Computer, Inc.' || /iPad|iPhone|iPod/.test(navigator.userAgent));
  }

  // ---- URL 分類 -------------------------------------------------------------

  function classifyUrl(url, pageIsHttps) {
    if (pageIsHttps === undefined) pageIsHttps = location.protocol === 'https:';
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return 'invalid';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'unsupported-protocol';
    if (pageIsHttps && u.protocol === 'http:') return 'mixed-content';
    const path = u.pathname.toLowerCase();
    if (path.endsWith('.mpd')) return 'dash';
    if (path.endsWith('.mp4') || path.endsWith('.webm')) return 'progressive';
    // 拡張子なしの URL も多いため、それ以外はまず HLS として試す
    return 'hls';
  }

  // ---- DOM ------------------------------------------------------------------

  function init(options) {
    onCloseCallback = options && options.onClose ? options.onClose : null;
    onPlayingCallback = options && options.onPlaying ? options.onPlaying : null;
    onNavigateCallback = options && options.onNavigate ? options.onNavigate : null;
    dom = {
      modal: document.getElementById('player-modal'),
      stage: document.getElementById('player-stage'),
      video: document.getElementById('player-video'),
      flag: document.getElementById('player-flag'),
      title: document.getElementById('player-title'),
      meta: document.getElementById('player-meta'),
      status: document.getElementById('player-status'),
      variants: document.getElementById('player-variants'),
      epg: document.getElementById('player-epg'),
      error: document.getElementById('player-error'),
      errorActions: document.getElementById('player-error-actions'),
      unmute: document.getElementById('player-unmute'),
      osd: document.getElementById('player-osd'),
      nav: document.getElementById('player-nav'),
      prev: document.getElementById('player-prev'),
      next: document.getElementById('player-next'),
      pos: document.getElementById('player-pos'),
      close: document.getElementById('player-close'),
    };

    dom.close.addEventListener('click', close);
    dom.modal.addEventListener('close', handleDialogClose);
    dom.modal.addEventListener('click', (e) => {
      if (e.target === dom.modal) close();
    });
    dom.unmute.addEventListener('click', () => {
      mutedByUser = false;
      dom.video.muted = false;
      dom.unmute.hidden = true;
    });
    dom.prev.addEventListener('click', () => navigate(-1));
    dom.next.addEventListener('click', () => navigate(1));
    document.addEventListener('keydown', handleKeydown);
    dom.video.addEventListener('playing', () => {
      clearWatchdog();
      const s = currentStream();
      setStatus('● 再生中' + (s && s.quality ? ` (${s.quality})` : ''), 'ok');
      if (onPlayingCallback && entry) onPlayingCallback(entry.key);
    });
  }

  // ---- ザッピング(前 / 次の選局) --------------------------------------------
  //
  // 一覧の並び(state.filtered)そのものを巡回する。どの位置にいるかは
  // アプリ側から setNav() で受け取る — プレイヤーはチャンネル一覧を持たない。

  function navigate(delta) {
    if (!onNavigateCallback || !entry) return;
    onNavigateCallback(delta);
  }

  /**
   * 現在位置を反映する。nav = {index(0 始まり), total} / 位置不明なら null
   * (一覧の外にあるチャンネルをディープリンクで開いた場合など)。
   * アプリ側はフィルタが変わるたびに呼び直す。
   */
  function setNav(nav) {
    if (!dom || !dom.nav) return;
    const usable = Boolean(onNavigateCallback && nav && nav.total > 1 && nav.index >= 0);
    dom.nav.hidden = !usable;
    if (!usable) return;
    dom.pos.textContent = `${nav.index + 1} / ${nav.total} ch`;
    dom.prev.disabled = nav.index <= 0;
    dom.next.disabled = nav.index >= nav.total - 1;
  }

  function isOpen() {
    return Boolean(dom && dom.modal.open);
  }

  function currentKey() {
    return entry ? entry.key : null;
  }

  // ---- 音量 / ミュート / 全画面 -----------------------------------------------

  function prefs() {
    return typeof IPTVStore !== 'undefined' ? IPTVStore : null;
  }

  /** 保存済み音量(0–1)。未保存・不正値なら null */
  function storedVolume() {
    const store = prefs();
    if (!store) return null;
    const v = store.getPref(VOLUME_PREF, null);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  }

  /** 画面上の一時表示(音量・ミュート)。再生状態のステータス行は潰さない */
  function showOsd(text) {
    if (!dom.osd) return;
    dom.osd.textContent = text;
    dom.osd.hidden = false;
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { dom.osd.hidden = true; }, OSD_MS);
  }

  function volumeLabel() {
    return `音量 ${Math.round(dom.video.volume * 100)}%`;
  }

  function adjustVolume(delta) {
    // 浮動小数の累積誤差で 0.30000000000000004 のような値にならないよう丸める
    const v = Math.max(0, Math.min(1, Math.round((dom.video.volume + delta) * 100) / 100));
    dom.video.volume = v;
    if (v > 0 && dom.video.muted) {
      mutedByUser = false;
      dom.video.muted = false;
      dom.unmute.hidden = true;
    }
    const store = prefs();
    if (store) store.setPref(VOLUME_PREF, v);
    showOsd(dom.video.muted ? 'ミュート' : volumeLabel());
  }

  function toggleMute() {
    mutedByUser = !dom.video.muted;
    dom.video.muted = mutedByUser;
    dom.unmute.hidden = !dom.video.muted;
    showOsd(dom.video.muted ? 'ミュート' : volumeLabel());
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      return;
    }
    // オーバーレイ(ミュート解除・OSD)ごと全画面にしたいのでステージを使う。
    // iOS Safari は video 要素の専用 API しか持たないためそちらへ落とす
    if (dom.stage && dom.stage.requestFullscreen) dom.stage.requestFullscreen().catch(() => {});
    else if (dom.video.webkitEnterFullscreen) dom.video.webkitEnterFullscreen();
  }

  // ---- キーボードショートカット ----------------------------------------------
  //
  // 対象はプレイヤーが開いている間だけ(閉じているときは一覧側の操作 —
  // 検索・矢印キーでのスクロール — を一切奪わない)。検索欄・プロキシ欄など
  // 入力中のキーも横取りしない。

  const EDITABLE_TAGS = /^(input|textarea|select)$/i;

  function isEditingTarget(el) {
    return Boolean(el && (EDITABLE_TAGS.test(el.tagName) || el.isContentEditable));
  }

  function handleKeydown(e) {
    if (!isOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditingTarget(e.target)) return;
    switch (e.key) {
      // 選局は押しっぱなしで連続実行しない(1 回ごとに接続をやり直すため)
      case 'ArrowLeft':
        if (e.repeat) return;
        navigate(-1);
        break;
      case 'ArrowRight':
        if (e.repeat) return;
        navigate(1);
        break;
      case 'ArrowUp':
        adjustVolume(VOLUME_STEP);
        break;
      case 'ArrowDown':
        adjustVolume(-VOLUME_STEP);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      default:
        return;
    }
    // ネイティブの video コントロール(矢印キーでのシーク・音量)と二重に
    // 効かないよう、扱ったキーだけ既定動作を止める
    e.preventDefault();
  }

  // ---- Media Session(ロック画面・メディアキー) -------------------------------

  function mediaSessionAvailable() {
    return typeof navigator !== 'undefined' && 'mediaSession' in navigator &&
      typeof window.MediaMetadata === 'function';
  }

  /** ロック画面等に出すメタデータ。現在番組があればそれを主役にする */
  function updateMediaSession() {
    if (!mediaSessionAvailable()) return;
    if (!entry) {
      navigator.mediaSession.metadata = null;
      return;
    }
    let title = entry.name;
    let artist = entry.countryName || '';
    if (epgAvailable()) {
      const { current } = IPTVEpg.nowNext(IPTVEpg.get(entry.key).p, Math.floor(Date.now() / 1000));
      if (current) {
        title = current.title;
        artist = entry.name;
      }
    }
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title,
        artist,
        album: entry.countryName || '',
        artwork: entry.logo ? [{ src: entry.logo }] : [],
      });
    } catch (err) { /* メタデータ生成に失敗しても再生自体は続ける */ }
  }

  function setMediaSessionHandlers(on) {
    if (!mediaSessionAvailable() || !navigator.mediaSession.setActionHandler) return;
    for (const [action, delta] of [['previoustrack', -1], ['nexttrack', 1]]) {
      try {
        navigator.mediaSession.setActionHandler(
          action,
          on && onNavigateCallback ? () => navigate(delta) : null
        );
      } catch (err) { /* 未対応アクションは無視(仕様上 TypeError になり得る) */ }
    }
  }

  function currentStream() {
    return entry && currentIndex >= 0 ? entry.streams[currentIndex] : null;
  }

  function setStatus(text, kind) {
    dom.status.textContent = text;
    dom.status.dataset.kind = kind || 'info';
  }

  // ---- 再生ライフサイクル ---------------------------------------------------

  function teardown() {
    playToken++;
    clearWatchdog();
    if (hls) {
      try { hls.destroy(); } catch (e) { /* noop */ }
      hls = null;
    }
    if (dash) {
      try { dash.reset(); } catch (e) { /* noop */ }
      dash = null;
    }
    dom.video.onerror = null;
    dom.video.onloadedmetadata = null;
    dom.video.pause();
    dom.video.removeAttribute('src');
    dom.video.load();
    mediaRecoveries = 0;
    networkRecoveries = 0;
  }

  function clearWatchdog() {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = 0;
    }
  }

  function startWatchdog(token) {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (token !== playToken) return;
      fail('応答がありません(タイムアウト)');
    }, WATCHDOG_MS);
  }

  function open(newEntry) {
    entry = newEntry;
    tried = new Set();
    failReasons = new Map();
    autoAdvance = true;
    // ザッピングで開き直したときに、モーダル内のボタンを復帰先として
    // 覚えてしまわない(閉じたあとフォーカスが行方不明になる)
    if (!dom.modal.open) lastFocus = document.activeElement;

    dom.flag.textContent = entry.flag || '🌐';
    dom.title.textContent = entry.name;
    renderMeta();
    dom.error.hidden = true;
    // 前回の自動再生フォールバックで残ったミュートは持ち越さず、
    // ユーザーが自分で切ったミュートだけを引き継ぐ
    dom.video.muted = mutedByUser;
    dom.unmute.hidden = !mutedByUser;
    const vol = storedVolume();
    if (vol !== null) dom.video.volume = vol;

    renderVariants();
    renderEpg();
    startEpgTimer();
    updateMediaSession();
    setMediaSessionHandlers(true);
    if (!dom.modal.open) dom.modal.showModal();
    if (!entry.streams.length) {
      // 配信 URL 未登録のチャンネル: 再生は試みず、情報表示のみ
      teardown();
      currentIndex = -1;
      setStatus('このチャンネルの配信 URL は未登録です(チャンネル情報のみ)', 'warn');
      return;
    }
    play(0, true);
  }

  function close() {
    if (dom.modal.open) dom.modal.close();
    else handleDialogClose();
  }

  function handleDialogClose() {
    teardown();
    stopEpgTimer();
    setMediaSessionHandlers(false);
    entry = null;
    updateMediaSession(); // entry を消してから呼ぶ = メタデータの解除
    currentIndex = -1;
    setNav(null);
    clearTimeout(osdTimer);
    if (dom.osd) dom.osd.hidden = true;
    if (dom.epg) {
      dom.epg.hidden = true;
      dom.epg.textContent = '';
    }
    if (m3uUrl) {
      URL.revokeObjectURL(m3uUrl);
      m3uUrl = null;
    }
    // <dialog> を閉じたときのフォーカス復帰はブラウザ側でも行われる。
    // close イベント(タスクキュー経由 = 非同期)で無条件に focus() し直すと、
    // 復帰済みのフォーカスをユーザーが既に別の場所へ移していた場合に
    // それを奪い返してしまう。復帰されなかったときだけ自前で戻す
    const active = document.activeElement;
    if (lastFocus && lastFocus.focus && (!active || active === document.body)) {
      lastFocus.focus();
    }
    if (onCloseCallback) onCloseCallback();
  }

  function renderVariants() {
    dom.variants.textContent = '';
    if (!entry || entry.streams.length <= 1) return;
    const label = document.createElement('span');
    label.className = 'variants-label';
    label.textContent = `配信ソース (${entry.streams.length}):`;
    dom.variants.appendChild(label);
    entry.streams.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'variant-btn';
      btn.dataset.index = String(i);
      const parts = [`#${i + 1}`];
      if (s.quality) parts.push(s.quality);
      if (s.label) parts.push(s.label);
      if (!IPTVData.isHttps(s.url)) parts.push('HTTP');
      btn.textContent = parts.join(' ');
      if (s.userAgent || s.referrer) {
        btn.dataset.baseTitle = '特定の User-Agent / Referrer を要求する配信のため、ブラウザでは失敗する可能性があります';
        btn.title = btn.dataset.baseTitle;
      }
      btn.addEventListener('click', () => {
        autoAdvance = false;
        play(i, false);
      });
      dom.variants.appendChild(btn);
    });
    updateVariantStates();
  }

  function updateVariantStates() {
    const btns = dom.variants.querySelectorAll('.variant-btn');
    btns.forEach((btn) => {
      const i = Number(btn.dataset.index);
      const active = i === currentIndex;
      const failed = failReasons.has(i);
      btn.classList.toggle('active', active);
      btn.classList.toggle('failed', failed);
      btn.setAttribute('aria-pressed', String(active));
      if (failed) {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = `再生失敗: ${failReasons.get(i)}`;
      } else {
        btn.removeAttribute('aria-disabled');
        btn.title = btn.dataset.baseTitle || '';
      }
    });
  }

  // ---- 番組表(EPG)パネル ---------------------------------------------------

  const EPG_UPCOMING_LIMIT = 6;
  const EPG_REFRESH_MS = 30000;
  let epgTimer = 0;

  /** ヘッダのメタ情報。現地時刻を含むため定期的に描き直す */
  function renderMeta() {
    if (!entry) return;
    const parts = [entry.countryName];
    if (entry.timezone) {
      const t = IPTVData.localTime(entry.timezone, new Date());
      if (t) parts.push(`現地 ${t}`);
    }
    if (entry.network) parts.push(entry.network);
    if (entry.closed) parts.push(`閉局: ${entry.closed}`);
    dom.meta.textContent = parts.join(' ・ ');
  }

  function startEpgTimer() {
    stopEpgTimer();
    epgTimer = setInterval(() => {
      renderMeta();
      renderEpg();
      updateMediaSession(); // 番組が変われば通知センター側の表示も追従させる
    }, EPG_REFRESH_MS);
  }

  function stopEpgTimer() {
    if (epgTimer) {
      clearInterval(epgTimer);
      epgTimer = 0;
    }
  }

  function epgAvailable() {
    // IPTVEpg は const 宣言のため window には生えない — typeof で存在確認する
    return Boolean(
      typeof IPTVEpg !== 'undefined' && IPTVEpg.isLoaded() && entry && IPTVEpg.get(entry.key)
    );
  }

  function renderEpg() {
    if (!dom.epg) return;
    if (!epgAvailable()) {
      dom.epg.hidden = true;
      dom.epg.textContent = '';
      return;
    }
    const ch = IPTVEpg.get(entry.key);
    const nowSec = Math.floor(Date.now() / 1000);
    const { current } = IPTVEpg.nowNext(ch.p, nowSec);
    const list = IPTVEpg.upcoming(ch.p, nowSec, EPG_UPCOMING_LIMIT);

    dom.epg.hidden = false;
    dom.epg.textContent = '';

    const label = document.createElement('span');
    label.className = 'player-epg-label';
    label.textContent = 'Programme ・ 番組表';
    dom.epg.appendChild(label);

    if (!list.length) {
      const note = document.createElement('p');
      note.className = 'player-epg-note';
      note.textContent = '現在時刻の番組情報はありません(番組表の提供期間外です)';
      dom.epg.appendChild(note);
      return;
    }

    if (current) {
      const now = document.createElement('div');
      now.className = 'player-epg-now';

      const title = document.createElement('p');
      title.className = 'player-epg-nowtitle';
      title.textContent = `▶ ${current.title}`;
      now.appendChild(title);

      const time = document.createElement('p');
      time.className = 'player-epg-nowtime';
      time.textContent = IPTVEpg.fmtRange(current.start, current.dur);
      now.appendChild(time);

      const bar = document.createElement('div');
      bar.className = 'epg-bar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i');
      fill.style.width = `${IPTVEpg.progressPercent(current.start, current.dur, nowSec)}%`;
      bar.appendChild(fill);
      now.appendChild(bar);

      const desc = document.createElement('p');
      desc.className = 'player-epg-desc';
      desc.id = 'player-epg-desc';
      desc.hidden = true;
      now.appendChild(desc);

      dom.epg.appendChild(now);
      fillEpgDescription(desc, current);
    }

    // 「この後の番組」は放送中を除いて最大 5 件
    const rest = list.filter((p) => !p.isCurrent).slice(0, 5);
    if (rest.length) {
      const ul = document.createElement('ul');
      ul.className = 'player-epg-list';
      for (const p of rest) {
        const li = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = IPTVEpg.fmtTime(p.start);
        li.appendChild(time);
        li.appendChild(document.createTextNode(p.title));
        ul.appendChild(li);
      }
      dom.epg.appendChild(ul);
    }
  }

  // 説明文は詳細シャードから遅延取得する(失敗しても番組表自体は出したまま)
  function fillEpgDescription(descEl, current) {
    const forEntry = entry;
    IPTVEpg.details(forEntry.key).then((det) => {
      if (entry !== forEntry || !det || !descEl.isConnected) return;
      const row = det.find((r) => r[0] === current.start && r[2] === current.title);
      if (!row) return;
      const [, , , sub, desc, category, episode] = row;
      const head = [sub, episode, category].filter(Boolean).join(' ・ ');
      const text = [head, desc].filter(Boolean).join(' — ');
      if (!text) return;
      descEl.textContent = text;
      descEl.hidden = false;
    });
  }

  function play(index, auto) {
    if (!entry || !entry.streams[index]) return;
    teardown();
    const token = playToken;
    currentIndex = index;
    autoAdvance = auto;
    tried.add(index);
    dom.error.hidden = true;
    updateVariantStates();

    const stream = entry.streams[index];
    const kind = classifyUrl(stream.url);
    nativeRescueTried = false;
    upgradedFromHttp = false;
    let note = '';
    if (stream.userAgent || stream.referrer) note = '(UA/Referrer 指定あり — 失敗する可能性があります)';
    setStatus(`接続中… ${stream.quality || ''} ${note}`.trim());

    switch (kind) {
      case 'mixed-content':
        if (getProxyBase()) {
          // プロキシ(https)経由なら混在コンテンツにならない
          playHls(stream.url, token);
          return;
        }
        // TLS を話せるサーバも少数ながら存在するため、一度だけ https 昇格を試す
        upgradedFromHttp = true;
        setStatus('HTTP 配信のため HTTPS へ昇格して試行しています…', 'warn');
        playHls(stream.url.replace(/^http:/i, 'https:'), token);
        return;
      case 'unsupported-protocol':
        fail('このプロトコル (rtmp/rtsp など) はブラウザで再生できません');
        return;
      case 'invalid':
        fail('ストリーム URL が不正です');
        return;
      case 'dash':
        playDash(stream.url, token);
        return;
      case 'progressive':
        playNative(stream.url, token);
        return;
      default:
        playHls(stream.url, token);
    }
  }

  function attemptAutoplay(token) {
    if (token !== playToken) return;
    dom.video.play().catch(() => {
      if (token !== playToken) return;
      dom.video.muted = true;
      dom.unmute.hidden = false;
      dom.video.play().catch(() => {
        if (token !== playToken) return;
        // ユーザー操作待ちの正当な停止なのでウォッチドッグは止める
        clearWatchdog();
        setStatus('再生ボタンを押すと開始します');
      });
    });
  }

  // ---- HLS ------------------------------------------------------------------

  function playHls(url, token) {
    currentPlayUrl = url;
    if (preferNativeHls()) {
      playNative(url, token);
      return;
    }
    if (window.Hls && Hls.isSupported()) {
      startWatchdog(token);
      const config = {
        backBufferLength: 90,
        capLevelToPlayerSize: true,
        // ザッピング時に数十秒待たせないための fail-fast 設定
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 15000,
            timeoutRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1000 },
            errorRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1000 },
          },
        },
      };
      if (getProxyBase() && getProxyLoader()) config.loader = getProxyLoader();
      hls = new Hls(config);
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (token !== playToken) return;
        onHlsError(data);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== playToken) return;
        // マニフェスト取得後もセグメントが死んでいる配信があるため、
        // 'playing' が発火するまでウォッチドッグを張り直して監視を続ける
        startWatchdog(token);
        attemptAutoplay(token);
      });
      hls.attachMedia(dom.video);
      hls.loadSource(url);
    } else if (dom.video.canPlayType('application/vnd.apple.mpegurl')) {
      playNative(url, token);
    } else if (!window.Hls && window.MediaSource) {
      // ブラウザは対応しているのに hls.js 自体が読み込めていない(CDN 障害など)
      fail('プレイヤーライブラリ (hls.js) を読み込めませんでした — ページを再読み込みしてください');
    } else {
      fail('このブラウザは HLS 再生に対応していません');
    }
  }

  function onHlsError(data) {
    if (!data || !data.fatal) return;
    const details = data.details || '';
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (mediaRecoveries < 1) {
        mediaRecoveries++;
        setStatus('映像エラーから復旧を試みています…');
        try { hls.recoverMediaError(); return; } catch (e) { /* fallthrough */ }
      }
      fail('メディアエラー(コーデック非対応の可能性)');
      return;
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // 一度は再生できていた配信が途中で切れた場合は 1 回だけ再接続を試す
      if (networkRecoveries < 1 && dom.video.currentTime > 0 && details.indexOf('manifest') !== 0) {
        networkRecoveries++;
        setStatus('ネットワークエラー — 再接続しています…', 'warn');
        startWatchdog(playToken);
        try { hls.startLoad(); return; } catch (e) { /* fallthrough */ }
      }
      // Safari 等ネイティブ HLS 対応ブラウザでは、CORS 起因の失敗を
      // media 読み込み(CORS 非適用)で救済できることがある
      if (!nativeRescueTried && canNativeHls() && !getProxyBase() && currentPlayUrl) {
        nativeRescueTried = true;
        setStatus('ネイティブ HLS で再試行しています…', 'warn');
        try { hls.destroy(); } catch (e) { /* noop */ }
        hls = null;
        playNative(currentPlayUrl, playToken);
        return;
      }
      const code = data.response && data.response.code;
      if (code === 403) fail('アクセス拒否 (403) — 地域制限の可能性');
      else if (code === 404) fail('配信が見つかりません (404)');
      else if (details.indexOf('manifest') === 0) fail('接続できません(配信停止 / CORS 未対応 / 地域制限)');
      else fail('ネットワークエラーで中断しました');
      return;
    }
    fail(`再生できませんでした (${details || data.type})`);
  }

  // ---- ネイティブ / DASH ----------------------------------------------------

  function playNative(url, token) {
    currentPlayUrl = url;
    startWatchdog(token);
    dom.video.onerror = () => {
      if (token !== playToken) return;
      fail('接続できません(配信停止 / 地域制限の可能性)');
    };
    // teardown() で確実に外せるよう、プロパティ代入でリスナーを登録する
    dom.video.onloadedmetadata = () => {
      if (token !== playToken) return;
      startWatchdog(token);
      attemptAutoplay(token);
    };
    dom.video.src = url;
  }

  let dashLoading = null;

  function loadDashJs() {
    if (window.dashjs) return Promise.resolve();
    if (dashLoading) return dashLoading;
    dashLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = DASH_CDN;
      s.integrity = DASH_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => {
        dashLoading = null;
        reject(new Error('dash.js の読み込みに失敗しました'));
      };
      document.head.appendChild(s);
    });
    return dashLoading;
  }

  function playDash(url, token) {
    currentPlayUrl = url;
    setStatus('DASH プレイヤーを読み込み中…');
    startWatchdog(token);
    loadDashJs().then(() => {
      if (token !== playToken) return;
      dash = dashjs.MediaPlayer().create();
      if (getProxyBase()) {
        dash.addRequestInterceptor((request) => {
          request.url = getProxyBase() + encodeURIComponent(request.url);
          return Promise.resolve(request);
        });
      }
      dash.on('error', () => {
        if (token !== playToken) return;
        fail('DASH 配信に接続できません(配信停止 / CORS 未対応の可能性)');
      });
      dash.on('playbackMetaDataLoaded', () => {
        if (token !== playToken) return;
        startWatchdog(token);
        attemptAutoplay(token);
      });
      dash.initialize(dom.video, url, true);
    }).catch((err) => {
      if (token !== playToken) return;
      fail(err.message);
    });
  }

  // ---- 失敗処理 --------------------------------------------------------------

  function fail(reason) {
    clearWatchdog();
    if (upgradedFromHttp) {
      reason = `HTTP 配信のため再生できません(HTTPS 昇格も失敗: ${reason})`;
      upgradedFromHttp = false;
    }
    if (currentIndex >= 0) failReasons.set(currentIndex, reason);
    updateVariantStates();

    if (autoAdvance) {
      const next = entry ? entry.streams.findIndex((s, i) => !tried.has(i)) : -1;
      if (next !== -1) {
        setStatus(`✕ ${reason} — 次の配信ソースを試します… (${next + 1}/${entry.streams.length})`, 'warn');
        const token = playToken;
        setTimeout(() => {
          if (token !== playToken) return;
          play(next, true);
        }, 400);
        return;
      }
    }
    setStatus(`✕ ${reason}`, 'error');
    showErrorPanel();
  }

  function showErrorPanel() {
    if (!entry) return;
    dom.error.hidden = false;
    dom.errorActions.textContent = '';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'action-btn';
    copyBtn.textContent = 'ストリーム URL をコピー';
    copyBtn.addEventListener('click', () => {
      const s = currentStream() || entry.streams[0];
      copyText(s.url).then((ok) => {
        copyBtn.textContent = ok ? '✓ コピーしました' : 'コピーに失敗しました';
        setTimeout(() => { copyBtn.textContent = 'ストリーム URL をコピー'; }, 2000);
      });
    });
    dom.errorActions.appendChild(copyBtn);

    const m3uBtn = document.createElement('a');
    m3uBtn.className = 'action-btn';
    m3uBtn.textContent = '.m3u をダウンロード(VLC 用)';
    if (m3uUrl) URL.revokeObjectURL(m3uUrl);
    m3uUrl = URL.createObjectURL(new Blob([buildM3u(entry)], { type: 'audio/x-mpegurl' }));
    m3uBtn.href = m3uUrl;
    m3uBtn.download = `${entry.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u`;
    dom.errorActions.appendChild(m3uBtn);

    if (entry.website) {
      const site = document.createElement('a');
      site.className = 'action-btn';
      site.textContent = '公式サイトを開く';
      site.href = entry.website;
      site.target = '_blank';
      site.rel = 'noopener noreferrer';
      dom.errorActions.appendChild(site);
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    return Promise.resolve(false);
  }

  function buildM3u(e) {
    const lines = ['#EXTM3U'];
    for (const s of e.streams) {
      const attrs = [`tvg-id="${(e.key.indexOf(' ') === -1 ? e.key : '').replace(/"/g, '')}"`];
      if (e.logo) attrs.push(`tvg-logo="${e.logo.replace(/"/g, '')}"`);
      const quality = s.quality ? ` (${s.quality})` : '';
      lines.push(`#EXTINF:-1 ${attrs.join(' ')},${e.name}${quality}`);
      if (s.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
      if (s.referrer) lines.push(`#EXTVLCOPT:http-referrer=${s.referrer}`);
      lines.push(s.url);
    }
    return lines.join('\n') + '\n';
  }

  return { init, open, close, setNav, isOpen, currentKey, classifyUrl, getProxyBase, setProxyBase };
})();
