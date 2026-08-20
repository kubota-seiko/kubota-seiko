// 一度だけ使う、Misoca連携の認可コールバックエンドポイント。
// /api/misoca-oauth-start からのリダイレクト後、Misocaからこのエンドポイントに戻ってきます。
// 受け取った認可コードをアクセストークン・リフレッシュトークンに交換し、
// 画面にリフレッシュトークンを一度だけ表示します(コピーしてVercelの環境変数
// MISOCA_REFRESH_TOKEN に設定してください)。
// このページ自体はトークンを保存しません。表示されたリフレッシュトークンは
// このページを閉じると再表示できないため、必ずその場でコピーしてください。

module.exports = async (req, res) => {
  const clientId = process.env.MISOCA_CLIENT_ID;
  const clientSecret = process.env.MISOCA_CLIENT_SECRET;
  const code = req.query && req.query.code;

  if (!clientId || !clientSecret) {
    res.status(500).send('MISOCA_CLIENT_ID / MISOCA_CLIENT_SECRET が設定されていません。');
    return;
  }
  if (!code) {
    res.status(400).send('認可コードがありません。/api/misoca-oauth-start からやり直してください。');
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = proto + '://' + host + '/api/misoca-oauth-callback';

  try {
    const tokenRes = await fetch('https://app.misoca.jp/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret
      }).toString()
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      res.status(502).send('トークン取得に失敗しました: ' + t);
      return;
    }
    const data = await tokenRes.json();
    res.status(200).send(
      '<html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;line-height:1.8;">'
      + '<h2>Misoca連携が完了しました</h2>'
      + '<p>下記の値をコピーして、Vercelの環境変数に設定してください。このページを閉じると二度と表示できません。</p>'
      + '<p><b>MISOCA_REFRESH_TOKEN</b><br><textarea style="width:100%;height:60px;">' + (data.refresh_token || '') + '</textarea></p>'
      + '<p style="color:#666;font-size:13px;">アクセストークンは1日で失効するため保存不要です(refresh_tokenから自動取得されます)。</p>'
      + '</body></html>'
    );
  } catch (err) {
    console.error(err);
    res.status(500).send('内部エラーが発生しました: ' + (err.message || err));
  }
};
