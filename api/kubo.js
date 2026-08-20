// くぼちゃっと 単一エントリポイント
// ---------------------------------------------------------------------
// Vercel Hobby プランは1デプロイあたり Serverless Functions 12個まで。
// 本ファイル追加で 12/12 となり空き枠はゼロ。以後くぼちゃっとに機能を足す場合は
// 必ずここへ ?fn= を追加する形にし、api/ 直下に新しい .js を置かないこと。
// (先頭 "_" のファイルはルーティングされないため関数数に数えられない)
//
//   POST /api/kubo?fn=chat     … 相談を受け取り OpenAI Responses API で回答
//   GET  /api/kubo?fn=verify   … 利用権トークンの有効性だけを確認(画面の入口判定用)
//   GET  /api/kubo?fn=config   … その環境の PayPal Client ID を返す(Sandbox検証用)
//
// 必要な環境変数(Vercelダッシュボードで設定・値はコードに書かない):
//   OPENAI_API_KEY        … OpenAI APIキー。ブラウザへは絶対に返さない
//   KUBO_SESSION_SECRET   … 利用権トークンの署名鍵(長いランダム文字列)
//   KUBO_MODEL            … 任意。既定 'gpt-5.6-terra'。luna/sol へ差し替え可能
//
// ログ方針: 相談本文・APIキー・トークンは一切出力しない。エラー種別のみ記録する。
'use strict';

const lib = require('./_kubo-lib.js');
const { KUBO_OS } = require('./_kubo-os.js');
const schema = require('./_kubo-schema.js');

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-terra';
// reply に加えて内部分析JSONも出力するため、旧900から引き上げる。
// スキーマは reply を先頭に置いており、打ち切られても本文が残りやすい。
const MAX_OUTPUT_TOKENS = 1600;
const OPENAI_TIMEOUT_MS = 45000;

// 利用者向けの文言(内部エラーの詳細は出さない)
const MSG = {
  unauthorized: 'ご利用にはご購入が必要です。お手数ですが、購入時の画面からもう一度お進みください。',
  expired: 'ご利用期間が終了しています。継続をご希望の場合は、あらためてお申し込みください。',
  empty: '相談内容を入力してください。',
  tooLong: '入力が長すぎます。お手数ですが、要点を分けて送ってください。',
  timeout: 'ただいま混み合っています。少し時間をおいて、もう一度お試しください。',
  aiError: 'うまく応答できませんでした。時間をおいて再度お試しいただくか、LINEからご相談ください。',
  server: '設定に問題が発生しました。お手数ですがLINEからご連絡ください。'
};

// =====================================================================
// OpenAI Responses API
// =====================================================================

/**
 * レスポンスから本文テキストを取り出す。
 * output[] の type:'message' → content[] の type:'output_text' を連結する。
 * SDKの output_text ショートカットがある場合はそれを優先する。
 */
function extractText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const out = Array.isArray(data.output) ? data.output : [];
  const text = out
    .filter((o) => o && o.type === 'message')
    .reduce((acc, o) => {
      const parts = Array.isArray(o.content) ? o.content : [];
      return acc + parts
        .filter((c) => c && c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
    }, '');
  return String(text || '').trim();
}

/**
 * 安全上の理由でモデルが応答を拒否した場合、content に type:'refusal' が入る。
 * これを本文なしと同一視すると原因が分からなくなるため、別扱いで検出する。
 */
function extractRefusal(data) {
  const out = (data && Array.isArray(data.output)) ? data.output : [];
  for (const o of out) {
    const parts = (o && Array.isArray(o.content)) ? o.content : [];
    for (const c of parts) {
      if (c && c.type === 'refusal' && typeof c.refusal === 'string' && c.refusal.trim()) {
        return c.refusal.trim();
      }
    }
  }
  return '';
}

async function callOpenAI(apiKey, model, history, message, useSchema) {
  // 会話履歴 + 今回の入力。instructions(developer相当)はユーザー入力より優先される。
  const input = history.concat([{ role: 'user', content: message }]);

  // Structured Outputs。モデルが未対応の場合は呼び出し側が useSchema=false で再試行する。
  const payload = {
    model: model,
    instructions: KUBO_OS,
    input: input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: 'low' }
  };
  if (useSchema) payload.text = schema.TEXT_FORMAT;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);
  let apiRes;
  try {
    apiRes = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String((e && e.message) || '')));
    return { ok: false, code: aborted ? 'ai_timeout' : 'ai_request_failed' };
  } finally {
    clearTimeout(timer);
  }

  if (!apiRes.ok) {
    // 本文は相談内容を含みうるため保存しない。ステータスと種別のみ記録する。
    let kind = '';
    try {
      const errBody = await apiRes.json();
      kind = (errBody && errBody.error && (errBody.error.type || errBody.error.code)) || '';
    } catch (_) { /* 解析できなくても致命ではない */ }
    console.error('[kubo] openai http', apiRes.status, kind ? 'type=' + kind : '');
    return { ok: false, code: 'ai_error', status: apiRes.status };
  }

  let data;
  try {
    data = await apiRes.json();
  } catch (_) {
    return { ok: false, code: 'ai_bad_response' };
  }

  // 安全上の拒否は空応答と区別する
  const refusal = extractRefusal(data);
  if (refusal) {
    console.error('[kubo] openai refusal');
    return { ok: false, code: 'ai_refusal' };
  }

  const text = extractText(data);
  if (!text) {
    console.error('[kubo] openai empty output');
    return { ok: false, code: 'ai_empty' };
  }

  // 構造化出力なら素直にparseできる。崩れていても parseJsonLoose が拾う。
  // それでも駄目なら本文そのものを reply として扱い、利用者を空応答にしない。
  const parsed = schema.parseJsonLoose(text);
  if (!parsed) console.warn('[kubo] structured output not parsed; falling back to raw text');
  const result = schema.normalizeResult(parsed, text);

  if (!result.reply) {
    console.error('[kubo] empty reply after normalize');
    return { ok: false, code: 'ai_empty' };
  }
  return { ok: true, result: result, structured: !!parsed };
}

// =====================================================================
// ハンドラ
// =====================================================================

/** 利用権トークンを検証し、payload または null を返す */
function authenticate(req, body, secret) {
  const token = lib.readToken(req, body);
  if (!token) return null;
  return lib.verifyToken(token, secret);
}

async function handleChat(req, res) {
  if (req.method !== 'POST') return lib.fail(res, 405, 'method_not_allowed');

  const secret = (process.env.KUBO_SESSION_SECRET || '').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  // 設定漏れは通さず明示的に落とす(fail-closed)。どちらが未設定かは外に出さない。
  if (!secret || !apiKey) {
    console.error('[kubo] server not configured');
    return lib.fail(res, 500, 'server_not_configured', MSG.server);
  }
  // 環境変数にAPIキー以外(日本語混入・異常な長さ)が入っている場合を早期検出する
  if (!/^[\x21-\x7E]+$/.test(apiKey) || apiKey.length > 250) {
    console.error('[kubo] bad api key format');
    return lib.fail(res, 500, 'bad_api_key', MSG.server);
  }

  const body = await lib.readJson(req);

  const payload = authenticate(req, body, secret);
  if (!payload) return lib.fail(res, 401, 'unauthorized', MSG.unauthorized);

  const check = lib.validateMessage(body.message);
  if (!check.ok) {
    return lib.fail(res, 400, check.error,
      check.error === 'message_too_long' ? MSG.tooLong : MSG.empty);
  }

  const history = lib.normalizeHistory(body.history);
  const model = (process.env.KUBO_MODEL || '').trim() || DEFAULT_MODEL;

  // まず Structured Outputs で試す。モデル/APIが未対応で 400 が返った場合だけ、
  // スキーマなしで1度だけ再試行する(OS側でもJSON形式を指示しているため成立する)。
  let out = await callOpenAI(apiKey, model, history, check.value, true);
  if (!out.ok && out.status === 400) {
    console.warn('[kubo] structured output rejected (400); retrying without schema');
    out = await callOpenAI(apiKey, model, history, check.value, false);
  }

  if (!out.ok) {
    // 決済済みユーザーの体験を止めないため、HTTPは200で文言を返す
    return lib.json(res, 200, {
      ok: false,
      error: out.code,
      message: out.code === 'ai_timeout' ? MSG.timeout : MSG.aiError
    });
  }

  // facts / interpretations / hypotheses は未確認の推測を含む内部分析のため、
  // ブラウザへ返さない。永続化もしない(v0.1ではDBを使わない)。
  return lib.json(res, 200, Object.assign({ ok: true }, schema.toPublic(out.result)));
}

async function handleVerify(req, res) {
  const secret = (process.env.KUBO_SESSION_SECRET || '').trim();
  if (!secret) {
    console.error('[kubo] server not configured');
    return lib.fail(res, 500, 'server_not_configured', MSG.server);
  }
  const body = req.method === 'POST' ? await lib.readJson(req) : {};
  const payload = authenticate(req, body, secret);
  if (!payload) return lib.fail(res, 401, 'unauthorized', MSG.unauthorized);
  return lib.json(res, 200, { ok: true, plan: payload.plan || null, expires_at: payload.exp });
}

/**
 * その環境の PayPal Client ID を返す。
 * Client ID は公開前提の値(既に各ページのHTMLに平文で入っている)。
 * 秘匿すべき PAYPAL_CLIENT_SECRET はここから一切返さない。
 *
 * 用途: Preview(Sandbox)で、本番用にハードコードされた Client ID ではなく
 * その環境の Sandbox Client ID を使わせるため。Production の画面はこの
 * エンドポイントを呼ばない(ハードコード値をそのまま使う)。
 */
async function handleConfig(req, res) {
  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  return lib.json(res, 200, {
    ok: true,
    paypalClientId: clientId || null,
    env: process.env.VERCEL_ENV || null
  });
}

const HANDLERS = {
  chat: handleChat,
  verify: handleVerify,
  config: handleConfig
};

module.exports = async (req, res) => {
  try {
    // 自サイト以外のページからの利用を拒否する(認証の代わりではなく多層防御の一枚)
    if (!lib.isAllowedOrigin(req)) {
      return lib.fail(res, 403, 'forbidden_origin');
    }
    const fn = (req.query && req.query.fn) || '';
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, fn) ? HANDLERS[fn] : null;
    if (!handler) return lib.fail(res, 404, 'unknown_function');
    return await handler(req, res);
  } catch (err) {
    // 相談本文・秘密値を含まない安全なログのみ
    try {
      console.error('[kubo] error:', String((err && err.message) || err).slice(0, 200));
    } catch (_) { /* noop */ }
    return lib.fail(res, 500, 'internal_error', MSG.aiError);
  }
};

// テスト用。Vercel はデフォルトエクスポートをハンドラとして扱うため、
// プロパティを足してもルーティングには影響しない。
module.exports._handlers = HANDLERS;
module.exports._extractText = extractText;
