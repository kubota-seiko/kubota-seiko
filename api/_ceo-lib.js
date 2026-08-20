// CEO OS 共通ライブラリ
// ---------------------------------------------------------------------
// このファイルは先頭が "_" のため、Vercel はエンドポイントとして
// ルーティングしません(URLから直接叩けない)。
//
// 提供するもの:
//   - 日付ユーティリティ(JST基準)   … todayJST / addDays / isValidDate
//   - HMAC-SHA256 署名/検証          … sign / verifyToken  (tally-lp.js の実装を転用)
//   - セッションCookie               … issueSession / clearSession / requireAuth
//   - Supabase (PostgREST) 共通処理  … sbGet / sbInsert / sbPatch / sbDelete
//   - JSON レスポンスヘルパー        … json / fail
//   - リクエストボディ取得           … readJson
//
// 必要な環境変数(値はコードに書かない。Vercelダッシュボードで設定):
//   CEO_PASSPHRASE            … ログイン用パスフレーズ
//   CEO_SESSION_SECRET        … セッションCookie署名用のランダム文字列
//   SUPABASE_URL              … 既存と共用
//   SUPABASE_SERVICE_ROLE_KEY … 既存と共用(RLSバイパス・ブラウザに絶対露出させない)
'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'ceo_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30日

// =====================================================================
// 日付ユーティリティ — すべて JST 基準
// =====================================================================
// Vercel の実行環境は UTC。new Date() をそのまま使うと日本時間の朝9時まで
// 「昨日」として扱われ、今日/期限超過/30日計算が9時間ズレる。
// 日付が絡む判定は必ずこの関数群を通すこと。

/** JST の「今日」を 'YYYY-MM-DD' で返す */
function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' に n 日足した 'YYYY-MM-DD' を返す(負数も可) */
function addDays(dateStr, n) {
  // 'YYYY-MM-DD' を UTC 正午として解釈する。正午起点なので ±n 日しても
  // 夏時間やタイムゾーンで日付が転ぶことがない。
  const t = Date.parse(dateStr + 'T12:00:00Z');
  if (Number.isNaN(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 形式で、実在する日付かどうか */
function isValidDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + 'T12:00:00Z');
  if (Number.isNaN(t)) return false;
  // '2026-02-31' のような繰り上がりを弾く
  return new Date(t).toISOString().slice(0, 10) === v;
}

// =====================================================================
// HMAC-SHA256 署名 / 検証
// =====================================================================
// api/tally-lp.js の署名検証(createHmac + timingSafeEqual)と同じ方式。
// base64url を使うのは Cookie に安全に載せるため('+' '/' '=' を避ける)。

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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
 * '<expUnixSec>.<signature>' 形式のトークンを検証する。
 * 有効なら exp(number)、無効なら null を返す。
 */
function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d{1,12}$/.test(expStr)) return null;
  if (!safeEqual(sign(expStr, secret), sig)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null; // 期限切れ
  return exp;
}

// =====================================================================
// Cookie
// =====================================================================

/** Cookie ヘッダから名前で1つ取り出す(依存パッケージなし) */
function readCookie(req, name) {
  const header = (req && req.headers && req.headers.cookie) || '';
  if (!header) return '';
  const parts = String(header).split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch (_) {
      return part.slice(eq + 1).trim();
    }
  }
  return '';
}

/** ログイン成功時に署名付きセッションCookieを発行する */
function issueSession(res, secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const token = exp + '.' + sign(String(exp), secret);
  res.setHeader('Set-Cookie', [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'Max-Age=' + SESSION_MAX_AGE_SEC,
    'HttpOnly',   // JS から読めない = XSS でトークンを盗まれない
    'Secure',     // HTTPS のみ
    'SameSite=Strict' // CSRF 対策(別サイトからのリクエストにCookieを付けない)
  ].join('; '));
  return exp;
}

/** ログアウト用: Cookie を即時失効させる */
function clearSession(res) {
  res.setHeader('Set-Cookie', [
    COOKIE_NAME + '=',
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ].join('; '));
}

/**
 * 認証チェック。全ての ceo-* エンドポイントの先頭で呼ぶこと。
 * 認証OK   → true を返す(呼び出し側は処理を続行)
 * 認証NG   → 401 を返して false(呼び出し側は即 return する)
 * 秘密値はレスポンスにもログにも一切出さない。
 */
function requireAuth(req, res) {
  const secret = (process.env.CEO_SESSION_SECRET || '').trim();
  if (!secret) {
    // 設定漏れを「通す」のではなく明示的に落とす(fail-closed)
    json(res, 500, { ok: false, error: 'session_secret_not_set' });
    return false;
  }
  const token = readCookie(req, COOKIE_NAME);
  if (!verifyToken(token, secret)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

// =====================================================================
// Supabase (PostgREST) 共通処理
// =====================================================================
// @supabase/supabase-js は入れず、既存コード(shindan.js / tally-lp.js /
// lp.js / generate-lp.js)と同様に PostgREST を素の fetch で叩く。依存追加ゼロ。

function sbConfig() {
  const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !key) return null;
  return {
    base,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'content-type': 'application/json'
    }
  };
}

/** 内部用: PostgREST を叩く。失敗時は秘密値を含まない Error を投げる */
async function sbFetch(cfg, path, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(cfg.base + path, Object.assign({ signal: ctrl.signal }, options, {
      headers: Object.assign({}, cfg.headers, (options && options.headers) || {})
    }));
    if (!r.ok) {
      // レスポンス本文には接続情報が含まれうるため、ステータスのみを伝える
      throw new Error('postgrest http ' + r.status);
    }
    const text = await r.text();
    if (!text) return [];
    try {
      return JSON.parse(text);
    } catch (_) {
      return [];
    }
  } finally {
    clearTimeout(timer);
  }
}

/** SELECT。query は '?select=*&status=eq.open' のような PostgREST クエリ文字列 */
function sbGet(cfg, table, query) {
  return sbFetch(cfg, '/rest/v1/' + table + (query || ''), { method: 'GET' });
}

/** INSERT。作成された行の配列を返す */
function sbInsert(cfg, table, body) {
  return sbFetch(cfg, '/rest/v1/' + table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
}

/** UPDATE。更新された行の配列を返す(0件なら該当なし) */
function sbPatch(cfg, table, query, body) {
  return sbFetch(cfg, '/rest/v1/' + table + (query || ''), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
}

/** DELETE。削除された行の配列を返す */
function sbDelete(cfg, table, query) {
  return sbFetch(cfg, '/rest/v1/' + table + (query || ''), {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' }
  });
}

// =====================================================================
// レスポンス / リクエスト ヘルパー
// =====================================================================

function json(res, status, body) {
  if (res.headersSent) return;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // 金額を含むレスポンスが中間キャッシュに残らないようにする
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
  res.status(status).send(JSON.stringify(body));
}

/** エラー応答。詳細を外に漏らさないため error コードのみ返す */
function fail(res, status, code) {
  json(res, status, { ok: false, error: code });
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
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

// =====================================================================
// 入力バリデーション
// =====================================================================

/** 金額: 0以上の整数のみ許可。上限あり(桁の打ち間違い検知)。不正なら null */
const AMOUNT_MAX = 1000000000; // 10億円
function parseAmount(v, { allowZero = true } = {}) {
  if (typeof v === 'string') v = v.replace(/[,\s¥￥]/g, '');
  // 空文字・null・空配列は Number() が 0 を返してしまう。
  // 未入力を「0円」として保存すると金額が静かに壊れるため、先に弾く。
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > AMOUNT_MAX) return null;
  if (!allowZero && n === 0) return null;
  return n;
}

/** 許可値ホワイトリスト照合。含まれなければ null */
function pickEnum(v, allowed) {
  return allowed.indexOf(v) >= 0 ? v : null;
}

/** 文字列を trim して長さ上限で切る。空なら null */
function str(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max || 200);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// =====================================================================
// 法人 / 個人 の判定（工程②）
// ---------------------------------------------------------------------
// DB スキーマを変更せず、口座名・ラベルの先頭タグ [法] [個] で区別する。
// 会社のお金と個人のお金を同一視しないための最小実装。
// 工程③で ceo_accounts / ceo_cash_events に entity 列を追加して置き換える。
const ENTITY_TAG = { '[法]': 'corporate', '[個]': 'personal' };

/** 'corporate' | 'personal' | 'unknown' を返す */
function entityOf(nameOrLabel) {
  const s = String(nameOrLabel || '').trim();
  for (const tag of Object.keys(ENTITY_TAG)) {
    if (s.indexOf(tag) === 0) return ENTITY_TAG[tag];
  }
  return 'unknown';
}

/** 表示用に先頭タグを取り除く */
function stripEntityTag(nameOrLabel) {
  const s = String(nameOrLabel || '').trim();
  for (const tag of Object.keys(ENTITY_TAG)) {
    if (s.indexOf(tag) === 0) return s.slice(tag.length).trim();
  }
  return s;
}

// =====================================================================
// 金額の確からしさ（工程②）
// ---------------------------------------------------------------------
// 「請求書が来ている確定額」と「前月実績からの予測額」を区別する。
// ceo_cash_events.source を流用する（schema 変更なし）:
//   'manual'   … 確定。自分で確認した実額
//   'estimate' … 予測。前月実績・計画値からの推定
// 将来の自動同期用に 'misoca' / 'paypal' も確定扱いとする。
//
// なぜ confidence を使わないか:
//   confidence は「入金が実現するか」を表す軸で、DB 制約
//   ck_ceo_cash_events_out_confirmed により支払い(out)では常に
//   'confirmed' に固定されている。金額の確からしさは別の軸なので
//   同じ列に載せられない。
const ESTIMATE_SOURCE = 'estimate';
const AMOUNT_SOURCES = ['manual', 'estimate', 'misoca', 'paypal'];

/** その入出金の金額が「予測」か */
function isEstimated(event) {
  return !!event && event.source === ESTIMATE_SOURCE;
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE_SEC,
  // 日付
  todayJST,
  addDays,
  isValidDate,
  // 署名 / 認証
  sign,
  safeEqual,
  verifyToken,
  readCookie,
  issueSession,
  clearSession,
  requireAuth,
  // Supabase
  sbConfig,
  sbGet,
  sbInsert,
  sbPatch,
  sbDelete,
  // レスポンス
  json,
  fail,
  readJson,
  // バリデーション
  parseAmount,
  pickEnum,
  str,
  isUuid,
  AMOUNT_MAX,
  // 法人 / 個人（工程②）
  entityOf,
  stripEntityTag,
  ENTITY_TAG,
  // 金額の確からしさ（工程②）
  isEstimated,
  ESTIMATE_SOURCE,
  AMOUNT_SOURCES
};
