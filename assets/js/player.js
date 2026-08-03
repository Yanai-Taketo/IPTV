'use strict';

/**
 * プレイヤーモーダル。
 * hls.js (MSE) → Safari ネイティブ HLS の順でフォールバックし、
 * 失敗時はチャンネル内の別ストリームを自動で順に試す。
 * 全滅したらエラーパネル(URLコピー / .m3u ダウンロード / 公式サイト)を表示する。
 */
const IPTVPlayer = (() => {
  const DASH_CDN = 'https://cdn.jsdelivr.net/npm/dashjs@5/dist/modern/umd/dash.all.min.js';
  const WATCHDOG_MS = 25000;

  let dom = null;
  let hls = null;
  let dash = null;
  let entry = null;
  let currentIndex = -1;
  let autoAdvance = true;
  let tried = new Set();
  let failReasons = new Map();
  let mediaRecoveries = 0;
  let watchdog = 0;
  let playToken = 0;
  let lastFocus = null;
  let onCloseCallback = null;

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
    dom = {
      modal: document.getElementById('player-modal'),
      video: document.getElementById('player-video'),
      flag: document.getElementById('player-flag'),
      title: document.getElementById('player-title'),
      meta: document.getElementById('player-meta'),
      status: document.getElementById('player-status'),
      variants: document.getElementById('player-variants'),
      error: document.getElementById('player-error'),
      errorActions: document.getElementById('player-error-actions'),
      unmute: document.getElementById('player-unmute'),
      close: document.getElementById('player-close'),
    };

    dom.close.addEventListener('click', close);
    dom.modal.addEventListener('close', handleDialogClose);
    dom.modal.addEventListener('click', (e) => {
      if (e.target === dom.modal) close();
    });
    dom.unmute.addEventListener('click', () => {
      dom.video.muted = false;
      dom.unmute.hidden = true;
    });
    dom.video.addEventListener('playing', () => {
      clearWatchdog();
      const s = currentStream();
      setStatus('▶ 再生中' + (s && s.quality ? ` (${s.quality})` : ''), 'ok');
    });
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
    dom.video.pause();
    dom.video.removeAttribute('src');
    dom.video.load();
    mediaRecoveries = 0;
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
    lastFocus = document.activeElement;

    dom.flag.textContent = entry.flag || '🌐';
    dom.title.textContent = entry.name;
    const metaParts = [entry.countryName];
    if (entry.network) metaParts.push(entry.network);
    if (entry.closed) metaParts.push(`閉局: ${entry.closed}`);
    dom.meta.textContent = metaParts.join(' ・ ');
    dom.error.hidden = true;
    dom.unmute.hidden = true;

    renderVariants();
    if (!dom.modal.open) dom.modal.showModal();
    play(0, true);
  }

  function close() {
    if (dom.modal.open) dom.modal.close();
    else handleDialogClose();
  }

  function handleDialogClose() {
    teardown();
    entry = null;
    currentIndex = -1;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
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
      if (s.userAgent || s.referrer) btn.title = '特定の User-Agent / Referrer を要求する配信のため、ブラウザでは失敗する可能性があります';
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
      btn.classList.toggle('active', i === currentIndex);
      btn.classList.toggle('failed', failReasons.has(i));
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
    let note = '';
    if (stream.userAgent || stream.referrer) note = '(UA/Referrer 指定あり — 失敗する可能性があります)';
    setStatus(`接続中… ${stream.quality || ''} ${note}`.trim());

    switch (kind) {
      case 'mixed-content':
        fail('HTTPS ページからは HTTP 配信を再生できません(混在コンテンツ制限)');
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
        setStatus('▶ ボタンを押すと再生を開始します');
      });
    });
  }

  // ---- HLS ------------------------------------------------------------------

  function playHls(url, token) {
    if (window.Hls && Hls.isSupported()) {
      startWatchdog(token);
      hls = new Hls({
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
      });
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (token !== playToken) return;
        onHlsError(data);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== playToken) return;
        clearWatchdog();
        attemptAutoplay(token);
      });
      hls.attachMedia(dom.video);
      hls.loadSource(url);
    } else if (dom.video.canPlayType('application/vnd.apple.mpegurl')) {
      playNative(url, token);
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
    startWatchdog(token);
    dom.video.onerror = () => {
      if (token !== playToken) return;
      fail('接続できません(配信停止 / 地域制限の可能性)');
    };
    dom.video.src = url;
    dom.video.addEventListener('loadedmetadata', () => {
      if (token !== playToken) return;
      clearWatchdog();
      attemptAutoplay(token);
    }, { once: true });
  }

  let dashLoading = null;

  function loadDashJs() {
    if (window.dashjs) return Promise.resolve();
    if (dashLoading) return dashLoading;
    dashLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = DASH_CDN;
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
    setStatus('DASH プレイヤーを読み込み中…');
    startWatchdog(token);
    loadDashJs().then(() => {
      if (token !== playToken) return;
      dash = dashjs.MediaPlayer().create();
      dash.on('error', () => {
        if (token !== playToken) return;
        fail('DASH 配信に接続できません(配信停止 / CORS 未対応の可能性)');
      });
      dash.on('playbackMetaDataLoaded', () => {
        if (token !== playToken) return;
        clearWatchdog();
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
    copyBtn.textContent = '📋 ストリーム URL をコピー';
    copyBtn.addEventListener('click', () => {
      const s = currentStream() || entry.streams[0];
      copyText(s.url).then((ok) => {
        copyBtn.textContent = ok ? '✓ コピーしました' : 'コピーに失敗しました';
        setTimeout(() => { copyBtn.textContent = '📋 ストリーム URL をコピー'; }, 2000);
      });
    });
    dom.errorActions.appendChild(copyBtn);

    const m3uBtn = document.createElement('a');
    m3uBtn.className = 'action-btn';
    m3uBtn.textContent = '⬇ .m3u をダウンロード (VLC などで再生)';
    m3uBtn.href = URL.createObjectURL(new Blob([buildM3u(entry)], { type: 'audio/x-mpegurl' }));
    m3uBtn.download = `${entry.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u`;
    dom.errorActions.appendChild(m3uBtn);

    if (entry.website) {
      const site = document.createElement('a');
      site.className = 'action-btn';
      site.textContent = '🌐 公式サイトを開く';
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

  return { init, open, close, classifyUrl };
})();
