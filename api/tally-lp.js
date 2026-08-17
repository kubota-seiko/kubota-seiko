// Vercel Serverless Function: 即日LP AI 工程③ — Tally Webhook 受信エンドポイント
// 役割: Tally からの Webhook を「署名検証 → session_id 検証 → 冪等チェック →
//       tally_responses へ保存」する。LP 生成・表示・決済・LINE 等は行わない。
//
// 必要な環境変数(Vercelダッシュボードで設定・値はコードに書かない):
//   TALLY_SIGNING_SECRET        … Tally Webhook の署名シークレット(サーバー専用)
//   SUPABASE_URL                … Supabase プロジェクト URL
//   SUPABASE_SERVICE_ROLE_KEY   … service_role キー(サーバー専用・RLSバイパス)
//
// レスポンス整理:
//   POST以外                         → 405
//   TALLY_SIGNING_SECRET 未設定       → 500
//   署名不一致/欠如                   → 401 (保存しない)
//   生ボディがJSONでない/冪等キー無し  → 400
//   session_id が不正/sessions に無い → 422 (保存しない)
//   SUPABASE_URL/KEY 未設定          → 500
//   重複(冪等キー既存)                → 200 { ok:true, duplicate:true }
//   正常保存                         → 200 { ok:true, duplicate:false }
//   insert 失敗など                   → 500 (ログのみ・秘密値は出さない)
'use strict';

const crypto = require('crypto');

// この関数だけ Vercel の自動ボディパースを無効化し、署名検証用の生ボディを得る
const config = { api: { bodyParser: false } };

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// リクエストの生ボディ(署名対象)を文字列で取得する
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    // 万一 Vercel 側で既にバッファ/文字列化されていた場合のフォールバック
    if (typeof req.body === 'string') return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString('utf8'));
    const chunks = [];
    let settled = false;
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    // ストリームが既に消費済みで 'end' が来ないケースへの保険
    setTimeout(() => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } }, 3000);
  });
}

// 生ボディを TALLY_SIGNING_SECRET で HMAC-SHA256 → base64 し、ヘッダ値と定数時間比較
function verifySignature(rawBody, secret, headerSig) {
  if (!headerSig) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(headerSig), 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual は同長必須
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

// data.fields の隠しフィールドから session_id を取り出す
function extractSessionId(payload) {
  const data = (payload && payload.data) || {};
  const fields = Array.isArray(data.fields) ? data.fields : [];
  for (const f of fields) {
    const label = String((f && (f.label || f.key)) || '').trim().toLowerCase();
    if (label === 'session_id' && f.value != null) {
      return String(Array.isArray(f.value) ? f.value[0] : f.value).trim();
    }
  }
  if (data.session_id != null) return String(data.session_id).trim();
  return '';
}

// 冪等キーと、response_json 上でそのキーを照合するための PostgREST パス
function pickIdempotency(payload) {
  const data = (payload && payload.data) || {};
  if (data.responseId != null && String(data.responseId).trim()) {
    return { key: String(data.responseId).trim(), path: 'response_json->data->>responseId' };
  }
  if (data.submissionId != null && String(data.submissionId).trim()) {
    return { key: String(data.submissionId).trim(), path: 'response_json->data->>submissionId' };
  }
  if (payload && payload.eventId != null && String(payload.eventId).trim()) {
    return { key: String(payload.eventId).trim(), path: 'response_json->>eventId' };
  }
  return null;
}

function supabaseHeaders(key) {
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'content-type': 'application/json'
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  try {
    // 1) 署名シークレット未設定は曖昧に通さず 500
    const secret = (process.env.TALLY_SIGNING_SECRET || '').trim();
    if (!secret) {
      res.status(500).json({ ok: false, error: 'signing_secret_not_set' });
      return;
    }

    // 2) 生ボディ取得 → 署名検証(不一致は保存せず 401)
    const rawBody = await readRawBody(req);
    const headerSig = req.headers['tally-signature'];
    if (!verifySignature(rawBody, secret, headerSig)) {
      res.status(401).json({ ok: false, error: 'invalid_signature' });
      return;
    }

    // 3) 生ボディから自前で JSON パース
    let payload;
    try { payload = JSON.parse(rawBody); } catch (_) {
      res.status(400).json({ ok: false, error: 'invalid_json' });
      return;
    }

    // 4) 冪等キー(無ければ 400)
    const idem = pickIdempotency(payload);
    if (!idem) {
      res.status(400).json({ ok: false, error: 'missing_idempotency_key' });
      return;
    }

    // 5) session_id 抽出 + 形式検証(不正は 422・曖昧に保存しない)
    const sessionId = extractSessionId(payload);
    if (!UUID_RE.test(sessionId)) {
      res.status(422).json({ ok: false, error: 'invalid_session_id' });
      return;
    }

    // 6) Supabase 接続情報(未設定は 500)
    const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!base || !key) {
      res.status(500).json({ ok: false, error: 'supabase_env_not_set' });
      return;
    }
    const headers = supabaseHeaders(key);

    // 7) session_id が sessions に存在するか(無ければ紐づけ不可で 422)
    try {
      const sUrl = base + '/rest/v1/sessions?select=id&limit=1&id=eq.' + encodeURIComponent(sessionId);
      const sRes = await fetch(sUrl, { headers: Object.assign({}, headers, { 'Accept': 'application/json' }) });
      if (!sRes.ok) throw new Error('session lookup http ' + sRes.status);
      const sRows = await sRes.json();
      if (!Array.isArray(sRows) || sRows.length === 0) {
        res.status(422).json({ ok: false, error: 'session_not_found' });
        return;
      }
    } catch (e) {
      console.error('[tally-lp] session lookup failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'session_lookup_failed' });
      return;
    }

    // 8) 冪等チェック(アプリ層 check-then-insert)。既存なら insert せず 200 duplicate
    try {
      const dUrl = base + '/rest/v1/tally_responses?select=id&limit=1&' +
        idem.path + '=eq.' + encodeURIComponent(idem.key);
      const dRes = await fetch(dUrl, { headers: Object.assign({}, headers, { 'Accept': 'application/json' }) });
      if (!dRes.ok) throw new Error('dup check http ' + dRes.status);
      const dRows = await dRes.json();
      if (Array.isArray(dRows) && dRows.length > 0) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
    } catch (e) {
      console.error('[tally-lp] duplicate check failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'duplicate_check_failed' });
      return;
    }

    // 9) 保存: tally_responses に insert(session_id + 受信ペイロード全体)
    try {
      const iRes = await fetch(base + '/rest/v1/tally_responses', {
        method: 'POST',
        headers: Object.assign({}, headers, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ session_id: sessionId, response_json: payload })
      });
      if (!iRes.ok) throw new Error('insert http ' + iRes.status);
    } catch (e) {
      console.error('[tally-lp] insert failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'insert_failed' });
      return;
    }

    res.status(200).json({ ok: true, duplicate: false });
  } catch (e) {
    // 予期せぬ例外。秘密値を含めない安全なメッセージのみ。
    console.error('[tally-lp] server error:', String((e && e.message) || e).slice(0, 200));
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};

// Vercel に自動ボディパース無効化(config)を認識させる
module.exports.config = config;
