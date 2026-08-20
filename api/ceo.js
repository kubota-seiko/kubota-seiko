// CEO OS 単一エントリポイント
// ---------------------------------------------------------------------
// Vercel Hobby プランは1デプロイあたり Serverless Functions 12個までで、
// 既存12個で枠を使い切っている。CEO OS の3エンドポイントを1関数にまとめ、
// クエリ ?fn= で振り分けることで、追加する関数を1個に抑える。
//
//   GET  /api/ceo?fn=dashboard          … MONEY + TODAY をまとめて返す
//   POST /api/ceo?fn=entry              … 追加・更新・削除・完了トグル
//   POST /api/ceo?fn=auth               … ログイン(パスフレーズ → Cookie)
//   POST /api/ceo?fn=auth&action=logout … ログアウト
//   GET  /api/ceo?fn=auth               … ログイン状態の確認
//
// 実処理は api/_ceo-*.js に置いてある。先頭が "_" のファイルは Vercel が
// エンドポイントとしてルーティングしないため、関数の数に数えられない。
//
// 振り分けキーに ?action= ではなく ?fn= を使うのは、認証ハンドラが
// ?action=logout を既に使っており、意味が衝突するため。
'use strict';

const lib = require('./_ceo-lib.js');

const HANDLERS = {
  auth: require('./_ceo-auth.js'),
  dashboard: require('./_ceo-dashboard.js'),
  entry: require('./_ceo-entry.js')
};

module.exports = async (req, res) => {
  const fn = (req.query && req.query.fn) || '';
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, fn) ? HANDLERS[fn] : null;
  if (!handler) {
    return lib.fail(res, 404, 'unknown_function');
  }
  return handler(req, res);
};

// テスト用。個別ハンドラへ直接アクセスできるようにしておく。
// Vercel はデフォルトエクスポート(上の関数)をハンドラとして扱うため、
// プロパティを足してもルーティングには影響しない。
module.exports._handlers = HANDLERS;
