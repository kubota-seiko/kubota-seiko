// Vercel Serverless Function: 即日LP AI 工程⑤ — LP(lp_json)表示エンドポイント
// 役割: 工程④で lps に保存された lp_json を、人が見られる1枚もの LP(HTML)として
//       サーバー側でレンダリングして返す。URL rewrite(/lp/:slug)・OGP・PayPal・
//       公開自動化は扱わない(工程⑥以降)。表示確認は /api/lp?slug=<slug>。
//
// 必要な環境変数(Vercelダッシュボードで設定・値はコードに書かない):
//   SUPABASE_URL                … Supabase プロジェクト URL
//   SUPABASE_SERVICE_ROLE_KEY   … service_role キー(サーバー専用・RLSバイパス)
//
// エラー整理: slug無し=400 / 該当slug無し=404 / SUPABASE未設定・取得失敗=500 / 正常=200(HTML)
'use strict';

// 公式LINE(既存サイトのCTA導線)。form/checkout は工程⑥で接続するため今は # 。
const LINE_URL = 'https://lin.ee/';

// HTML エスケープ(XSS対策)。lp_json は AI 生成テキストのため必ず通してから埋め込む。
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function supabaseHeaders(key) {
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Accept': 'application/json'
  };
}

function sendHtml(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}

// 秘密値を含まない簡易エラーページ
function errorPage(res, status, message) {
  const html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + esc(message) + '</title></head>' +
    '<body style="font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;max-width:640px;margin:80px auto;padding:0 24px;color:#333;line-height:1.8;text-align:center">' +
    '<p style="font-size:20px;font-weight:700;margin-bottom:8px">' + esc(message) + '</p>' +
    '<p style="color:#888"><a href="https://kubota-seiko.com/" style="color:#2563eb;text-decoration:none">kubota-seiko.com へ戻る</a></p>' +
    '</body></html>';
  sendHtml(res, status, html);
}

// 1セクションを HTML 文字列に(未知 type でも heading/body/items があれば汎用表示)
function renderSection(sec) {
  if (!sec || typeof sec !== 'object') return '';
  const heading = sec.heading ? '<h2 class="sec-h">' + esc(sec.heading) + '</h2>' : '';
  const body = sec.body ? '<p class="sec-b">' + esc(sec.body).replace(/\n/g, '<br>') + '</p>' : '';
  let items = '';
  if (Array.isArray(sec.items) && sec.items.length) {
    items = '<ul class="sec-list">' +
      sec.items.map((it) => '<li>' + esc(it) + '</li>').join('') +
      '</ul>';
  }
  if (!heading && !body && !items) return '';
  const type = typeof sec.type === 'string' ? esc(sec.type) : 'section';
  return '<section class="sec sec-' + type + '">' + heading + body + items + '</section>';
}

function renderLp(lp, status) {
  const meta = (lp && lp.meta) || {};
  const title = meta.title || lp.headline || 'ランディングページ';
  const description = meta.description || lp.subheadline || '';
  const cta = (lp && lp.cta) || {};
  const ctaLabel = cta.label || 'お問い合わせ';
  const ctaHref = cta.type === 'line' ? LINE_URL : '#'; // form/checkout は工程⑥で接続
  const isPublished = status === 'published';

  const sectionsHtml = Array.isArray(lp.sections)
    ? lp.sections.map(renderSection).join('')
    : '';

  const previewBar = isPublished ? '' :
    '<div class="preview-bar">PREVIEW（未公開）— このページはまだ公開されていません</div>';

  const robots = isPublished ? '' : '<meta name="robots" content="noindex">';

  return '<!doctype html><html lang="ja"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    robots +
    '<title>' + esc(title) + '</title>' +
    '<meta name="description" content="' + esc(description) + '">' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;color:#1f2933;line-height:1.85;background:#f8fafc}' +
    '.preview-bar{position:sticky;top:0;z-index:10;background:repeating-linear-gradient(45deg,#f59e0b,#f59e0b 12px,#d97706 12px,#d97706 24px);color:#fff;text-align:center;font-weight:700;font-size:13px;letter-spacing:.04em;padding:8px 12px;text-shadow:0 1px 2px rgba(0,0,0,.35)}' +
    '.wrap{max-width:720px;margin:0 auto;padding:0 20px 96px}' +
    '.hero{padding:56px 0 32px;text-align:center}' +
    '.headline{font-size:30px;font-weight:800;line-height:1.4;margin:0 0 16px;letter-spacing:.01em}' +
    '.subheadline{font-size:17px;color:#52606d;margin:0 auto;max-width:600px}' +
    '.sec{background:#fff;border:1px solid #e4e7eb;border-radius:14px;padding:28px 24px;margin:18px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}' +
    '.sec-h{font-size:21px;font-weight:700;margin:0 0 12px;color:#111827}' +
    '.sec-b{font-size:16px;margin:0 0 8px;color:#374151}' +
    '.sec-list{margin:12px 0 0;padding-left:1.2em}' +
    '.sec-list li{margin:6px 0}' +
    '.cta-wrap{position:sticky;bottom:0;background:linear-gradient(180deg,rgba(248,250,252,0),#f8fafc 40%);padding:20px;text-align:center}' +
    '.cta-btn{display:inline-block;background:#e8501e;color:#fff;font-weight:800;font-size:18px;text-decoration:none;padding:16px 40px;border-radius:999px;box-shadow:0 6px 18px rgba(232,80,30,.35);max-width:100%}' +
    '.cta-btn:active{transform:translateY(1px)}' +
    '.foot{text-align:center;color:#9aa5b1;font-size:12px;padding:24px 0}' +
    '@media(max-width:520px){.headline{font-size:24px}.hero{padding:40px 0 24px}.sec{padding:22px 18px}}' +
    '</style></head><body>' +
    previewBar +
    '<div class="wrap">' +
    '<header class="hero">' +
    '<h1 class="headline">' + esc(lp.headline || title) + '</h1>' +
    (lp.subheadline ? '<p class="subheadline">' + esc(lp.subheadline) + '</p>' : '') +
    '</header>' +
    '<main>' + sectionsHtml + '</main>' +
    '<div class="foot">© kubota-seiko.com</div>' +
    '</div>' +
    '<div class="cta-wrap"><a class="cta-btn" href="' + esc(ctaHref) + '"' +
    (ctaHref === '#' ? '' : ' target="_blank" rel="noopener"') + '>' + esc(ctaLabel) + '</a></div>' +
    '</body></html>';
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    errorPage(res, 405, 'このページは表示専用です');
    return;
  }
  try {
    const slug = String((req.query && req.query.slug) || '').trim();
    // 1) slug 無し → 400
    if (!slug || !/^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
      errorPage(res, 400, 'ページが指定されていません');
      return;
    }

    // SUPABASE 未設定 → 500(秘密値は出さない)
    const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!base || !key) {
      errorPage(res, 500, 'ただいま表示できません');
      return;
    }

    // 2) lps を1件取得
    let row;
    try {
      const url = base + '/rest/v1/lps?select=slug,lp_json,status&limit=1&slug=eq.' + encodeURIComponent(slug);
      const r = await fetch(url, { headers: supabaseHeaders(key) });
      if (!r.ok) throw new Error('lps get http ' + r.status);
      const rows = await r.json();
      row = Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (e) {
      console.error('[lp] fetch failed:', String((e && e.message) || e).slice(0, 200));
      errorPage(res, 500, 'ただいま表示できません');
      return;
    }

    // 該当 slug 無し → 404
    if (!row || !row.lp_json) {
      errorPage(res, 404, 'ページが見つかりませんでした');
      return;
    }

    // 3) HTML を組み立てて返す
    const html = renderLp(row.lp_json, row.status);
    sendHtml(res, 200, html);
  } catch (e) {
    console.error('[lp] server error:', String((e && e.message) || e).slice(0, 200));
    errorPage(res, 500, 'ただいま表示できません');
  }
};
