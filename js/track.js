/* ============================================================
 kubota-seiko.com 共通トラッキング (GA4: G-HQKZ2M8B6S)
 - 既存gtagを利用(二重設置なし)。個人情報は一切送信しない。
 - data-track-event / data-track-name によるクリック計測(委譲)
 - IntersectionObserverによる section_view(1PV1回)
 - UTM保存(first=初回のみ / last=毎回更新)
 - ?exclude_me=1 で自分を除外 / ?debug_mode=1 でGA4デバッグ
 - Tally FormSubmitted を検知しサンクスページへ遷移
============================================================ */
(function () {
  if (window.__ksTrackInit) return;
  window.__ksTrackInit = true;

  var LS = window.localStorage;
  var PAGE_VERSION = (document.querySelector('meta[name="page-version"]') || {}).content || '202607_v1_launch';

  /* ---- 自分の除外 / デバッグ ---- */
  var params = new URLSearchParams(window.location.search);
  if (params.get('exclude_me') === '1') { try { LS.setItem('ks_exclude', '1'); } catch (e) {} }
  var EXCLUDED = false;
  try { EXCLUDED = LS.getItem('ks_exclude') === '1'; } catch (e) {}
  var DEBUG = params.get('debug_mode') === '1';

  /* ---- UTM保存 ---- */
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  function getStored(k) { try { return LS.getItem(k) || ''; } catch (e) { return ''; } }
  function setStored(k, v) { try { LS.setItem(k, v); } catch (e) {} }

  var hasUtm = UTM_KEYS.some(function (k) { return params.get(k); });
  if (hasUtm) {
    // last_* は毎回更新
    UTM_KEYS.forEach(function (k) { setStored('last_' + k, params.get(k) || ''); });
    setStored('last_landing_page', window.location.pathname);
    // first_* は初回のみ(上書きしない)
    if (!getStored('first_utm_source') && !getStored('first_utm_medium') &&
        !getStored('first_utm_campaign') && !getStored('first_utm_content')) {
      UTM_KEYS.forEach(function (k) { setStored('first_' + k, params.get(k) || ''); });
      setStored('first_landing_page', window.location.pathname);
    }
  }

  function utmDims() {
    return {
      first_utm_source: getStored('first_utm_source'),
      first_utm_medium: getStored('first_utm_medium'),
      first_utm_campaign: getStored('first_utm_campaign'),
      last_utm_source: getStored('last_utm_source'),
      last_utm_medium: getStored('last_utm_medium'),
      last_utm_campaign: getStored('last_utm_campaign')
    };
  }
  function trafficSource() { return getStored('last_utm_source') || 'direct'; }

  /* ---- GA送信ラッパー(gtag経由・beacon) ---- */
  function send(eventName, extra) {
    if (EXCLUDED || typeof window.gtag !== 'function') return;
    var payload = Object.assign({
      transport_type: 'beacon',
      page_path: window.location.pathname,
      page_version: PAGE_VERSION
    }, utmDims(), extra || {});
    if (DEBUG) payload.debug_mode = true;
    window.gtag('event', eventName, payload);
  }
  window.ksTrack = send; // 手動送信用(サンクスページ等)

  /* ---- クリック計測(委譲) ---- */
  var EMBED_PATHS = ['/monitor-entry/', '/feedback/', '/stress-check/'];
  function isInternalEmbed(href) {
    try {
      var u = new URL(href, window.location.origin);
      return u.origin === window.location.origin && EMBED_PATHS.indexOf(u.pathname) !== -1;
    } catch (e) { return false; }
  }
  // 内部の埋め込みページへ飛ぶリンクには、保存済みUTMを引き継ぐ(TallyのHidden fields用)
  function withUtm(href) {
    try {
      var u = new URL(href, window.location.origin);
      UTM_KEYS.forEach(function (k) {
        var v = getStored('last_' + k);
        if (v && !u.searchParams.get(k)) u.searchParams.set(k, v);
      });
      return u.pathname + u.search + u.hash;
    } catch (e) { return href; }
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-track-event]');
    if (!el) return;
    var eventName = el.getAttribute('data-track-event');
    var section = el.closest('[data-section]');
    var extra = {
      link_name: el.getAttribute('data-track-name') || '',
      link_url: el.getAttribute('href') || '',
      link_text: (el.textContent || '').trim().slice(0, 80),
      section_name: section ? section.getAttribute('data-section') : '',
      link_position: el.getAttribute('data-track-position') || ''
    };
    send(eventName, extra);
    // 内部埋め込みページへのリンクはUTMを付与してから遷移
    var href = el.getAttribute('href');
    if (href && isInternalEmbed(href) && !el.hasAttribute('data-utm-appended')) {
      el.setAttribute('href', withUtm(href));
      el.setAttribute('data-utm-appended', '1');
    }
  }, true);

  /* ---- section_view(1PVにつき各1回) ---- */
  var seen = {};
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var name = e.target.getAttribute('data-section');
        if (!name || seen[name]) return;
        seen[name] = true;
        send('section_view', { section_name: name, traffic_source: trafficSource() });
        io.unobserve(e.target);
      });
    }, { threshold: 0.5 });
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('[data-section]').forEach(function (s) { io.observe(s); });
    });
  }

  /* ---- Tally 送信完了 → サンクスページ遷移 ---- */
  // formId → { path, kind }  (kind: lead=generate_lead / stress=stress_check_complete)
  var FORM_MAP = {
    'Np9V4B': { path: '/thanks/sokujitsu-lp/' },
    'KYND97': { path: '/thanks/feedback/' },
    'zxog7M': { path: '/thanks/stress-check/' }
  };
  window.addEventListener('message', function (e) {
    if (typeof e.data !== 'string' || e.data.indexOf('Tally.FormSubmitted') === -1) return;
    var formId = '';
    try { formId = (JSON.parse(e.data).payload || {}).formId || ''; } catch (err) {}
    var map = FORM_MAP[formId];
    if (!map) return;
    // 現ページ(埋め込みページ)のクエリを引き継いでサンクスページへ
    var cur = new URLSearchParams(window.location.search);
    var q = new URLSearchParams();
    ['entry_intent', 'button_position', 'source_page'].forEach(function (k) {
      if (cur.get(k)) q.set(k, cur.get(k));
    });
    var dest = map.path + (q.toString() ? '?' + q.toString() : '');
    window.location.href = dest;
  });
})();
