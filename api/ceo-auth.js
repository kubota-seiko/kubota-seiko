// CEO OS 認証エンドポイント
// ---------------------------------------------------------------------
// POST /api/ceo-auth          { passphrase: "..." }  → 署名付きCookieを発行
// POST /api/ceo-auth?action=logout                   → Cookieを失効
// GET  /api/ceo-auth                                 → ログイン状態の確認のみ
//
// 必要な環境変数(Vercelダッシュボードで設定・値はコードに書かない):
//   CEO_PASSPHRASE      … ログイン用パスフレーズ
//   CEO_SESSION_SECRET  … Cookie署名用のランダムな長い文字列
//
// レスポンス整理:
//   GET  かつ 未ログイン           → 401 { ok:false, error:'unauthorized' }
//   GET  かつ ログイン済み         → 200 { ok:true, authenticated:true }
//   環境変数 未設定                → 500 (どちらが未設定かは外に出さない)
//   パスフレーズ不一致              → 401 { ok:false, error:'invalid_passphrase' }
//   パスフレーズ一致                → 200 { ok:true } + Set-Cookie
//   POST 以外 かつ GET 以外        → 405
'use strict';

const lib = require('./_ceo-lib.js');

// 総当たりを現実的でなくするための最小限の遅延(ステートレス)。
// 本格的なレート制限は工程②以降で検討する。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async (req, res) => {
  try {
    // --- ログイン状態の確認(画面側のリダイレクト判定用) ---
    if (req.method === 'GET') {
      const secret = (process.env.CEO_SESSION_SECRET || '').trim();
      if (!secret) return lib.fail(res, 500, 'server_not_configured');
      const token = lib.readCookie(req, lib.COOKIE_NAME);
      if (!lib.verifyToken(token, secret)) return lib.fail(res, 401, 'unauthorized');
      return lib.json(res, 200, { ok: true, authenticated: true });
    }

    if (req.method !== 'POST') {
      return lib.fail(res, 405, 'method_not_allowed');
    }

    const secret = (process.env.CEO_SESSION_SECRET || '').trim();
    const passphrase = (process.env.CEO_PASSPHRASE || '').trim();

    // --- ログアウト(未設定時でも動くよう、環境変数チェックより先に処理) ---
    const action = (req.query && req.query.action) || '';
    if (action === 'logout') {
      lib.clearSession(res);
      return lib.json(res, 200, { ok: true, authenticated: false });
    }

    // 設定漏れは「通す」のではなく明示的に落とす(fail-closed)。
    // どちらの変数が未設定かは、攻撃者に情報を与えないため区別しない。
    if (!secret || !passphrase) {
      return lib.fail(res, 500, 'server_not_configured');
    }

    const body = await lib.readJson(req);
    const input = typeof body.passphrase === 'string' ? body.passphrase : '';

    // 定数時間比較。長さが違う時点で false になるため、長さは漏れうるが
    // パスフレーズ本体は漏れない。
    if (!input || !lib.safeEqual(input, passphrase)) {
      await sleep(700); // 総当たりの試行速度を落とす
      return lib.fail(res, 401, 'invalid_passphrase');
    }

    const exp = lib.issueSession(res, secret);
    return lib.json(res, 200, { ok: true, authenticated: true, expires_at: exp });
  } catch (err) {
    // 秘密値を含まない安全なログのみ
    try {
      console.error('[ceo-auth] error:', String((err && err.message) || err).slice(0, 200));
    } catch (_) { /* noop */ }
    return lib.fail(res, 500, 'internal_error');
  }
};
