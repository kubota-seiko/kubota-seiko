// 一度だけ使う、Misoca連携の認可開始エンドポイント。
// ブラウザでこのURLにアクセスすると、Misocaのログイン・認可画面にリダイレクトします。
// 環境変数 MISOCA_CLIENT_ID が必要です(Vercelダッシュボードで設定)。
// コールバック先は /api/misoca-oauth-callback です。

module.exports = async (req, res) => {
  const clientId = process.env.MISOCA_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('MISOCA_CLIENT_ID が設定されていません。Vercelの環境変数を確認してください。');
    return;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = proto + '://' + host + '/api/misoca-oauth-callback';

  const authorizeUrl = 'https://app.misoca.jp/oauth2/authorize'
    + '?client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&scope=write';

  res.writeHead(302, { Location: authorizeUrl });
  res.end();
};
