// くぼちゃっと 共通ライブラリ
// ---------------------------------------------------------------------
// 先頭が "_" のファイルは Vercel がエンドポイントとしてルーティングしないため、
// Serverless Function の個数に数えられない。実処理はここに置き、
// 公開エンドポイントは api/kubo.js の1本だけに保つ。
//
// 署名方式は api/_ceo-lib.js / api/tally-lp.js と同じ
// (crypto.createHmac('sha256') + timingSafeEqual)。新しい暗号実装は持ち込まない。
'use strict';

const crypto = require('crypto');

// 利用権トークンの有効期間。商品「くぼちゃっと 31日利用」と同じ31日。
const TOKEN_TTL_SEC = 60 * 60 * 24 * 31;

// 1回の入力の上限文字数。課金暴走と極端に長い入力を防ぐ。
const MAX_INPUT_CHARS = 4000;

// サーバーへ送る会話履歴の上限(往復数)。これより古い分は切り捨てる。
// 入力トークンが際限なく伸びてコストが逓増するのを防ぐ。
const MAX_HISTORY_TURNS = 10;

// 許可するオリジン。ここに無いオリジンからのAPI利用は拒否する。
const ALLOWED_ORIGIN_HOSTS = [
  'kubota-seiko.com',
  'www.kubota-seiko.com'
];

// =====================================================================
// base64url
// =====================================================================

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '==='.slice((s.length + 3) % 4), 'base64').toString('utf8');
}

// =====================================================================
// HMAC-SHA256 署名 / 検証
// =====================================================================

/** value を secret で HMAC-SHA256 署名し base64url で返す */
function sign(value, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(String(value), 'utf8').digest());
}

/** 署名を定数時間で比較する(タイミング攻撃対策) */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false; // timingSafeEqual は同長必須
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

/**
 * 利用権トークンを発行する。形式: '<b64url(payload JSON)>.<signature>'
 * payload には注文ID・プラン・有効期限(Unix秒)だけを入れる。個人情報は入れない。
 */
function issueToken(payload, secret, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + (ttlSec || TOKEN_TTL_SEC);
  const body = JSON.stringify({
    oid: String(payload.oid || '').slice(0, 64),
    plan: String(payload.plan || '').slice(0, 32),
    exp: exp
  });
  const encoded = b64url(body);
  return { token: encoded + '.' + sign(encoded, secret), exp: exp };
}

/**
 * 利用権トークンを検証する。
 * 有効なら payload オブジェクト、無効(改ざん・期限切れ・形式不正)なら null。
 */
function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) return null;
  // 署名検証を先に行う。ここを通らないものは JSON.parse すらしない。
  if (!safeEqual(sign(encoded, secret), sig)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encoded));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null; // 期限切れ
  return payload;
}

// =====================================================================
// 入力検証
// =====================================================================

/**
 * クライアントから来た会話履歴を、安全な形へ正規化する。
 * - role は 'user' / 'assistant' のみ許可(developer/system の混入を防ぐ)
 * - content は文字列のみ・長さ上限あり
 * - 直近 MAX_HISTORY_TURNS 往復ぶんだけ残す
 */
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : null);
    if (!role) continue;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    out.push({ role: role, content: content.slice(0, MAX_INPUT_CHARS) });
  }
  return out.slice(-(MAX_HISTORY_TURNS * 2));
}

/** ユーザーの入力本文を検証する。{ ok, value } または { ok:false, error } */
function validateMessage(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: 'empty_message' };
  if (text.length > MAX_INPUT_CHARS) return { ok: false, error: 'message_too_long' };
  return { ok: true, value: text };
}

// =====================================================================
// オリジン検証
// =====================================================================

/**
 * 自サイト以外からのAPI利用を拒否する。
 * Origin が無いリクエスト(同一オリジンの一部・curl等)は通す。ブラウザからの
 * クロスオリジン利用を防ぐのが目的で、これ単体を認証の代わりにはしない。
 * Vercel の *.vercel.app プレビューも許可する(本番前検証のため)。
 */
function isAllowedOrigin(req) {
  const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || '';
  if (!origin) return true;
  let host;
  try {
    host = new URL(String(origin)).hostname;
  } catch (_) {
    return false;
  }
  if (ALLOWED_ORIGIN_HOSTS.indexOf(host) !== -1) return true;
  if (/\.vercel\.app$/.test(host)) return true;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return false;
}

// =====================================================================
// レスポンス / リクエスト ヘルパー
// =====================================================================

function json(res, status, body) {
  if (res.headersSent) return;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
  res.status(status).send(JSON.stringify(body));
}

/** エラー応答。内部詳細は外に出さず、コードと利用者向け文言だけ返す */
function fail(res, status, code, message) {
  json(res, status, { ok: false, error: code, message: message || null });
}

/** リクエストボディを JSON オブジェクトとして得る(Vercelのパース有無に依存しない) */
async function readJson(req) {
  let body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body !== 'string') {
    body = await new Promise((resolve) => {
      const chunks = [];
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => done(''));
      setTimeout(() => done(Buffer.concat(chunks).toString('utf8')), 3000);
    });
  }
  try {
    return JSON.parse(body || '{}');
  } catch (_) {
    return {};
  }
}

/**
 * Authorization ヘッダ(Bearer)またはボディから利用権トークンを取り出す。
 */
function readToken(req, body) {
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
  if (m) return m[1].trim();
  if (body && typeof body.token === 'string') return body.token.trim();
  return '';
}

module.exports = {
  TOKEN_TTL_SEC,
  MAX_INPUT_CHARS,
  MAX_HISTORY_TURNS,
  issueToken,
  verifyToken,
  sign,
  safeEqual,
  normalizeHistory,
  validateMessage,
  isAllowedOrigin,
  json,
  fail,
  readJson,
  readToken
};
