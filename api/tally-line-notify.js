// Vercel Serverless Function: Tallyフォーム送信をLINE(窪田さん個人)へ通知
// 環境変数 LINE_CHANNEL_ACCESS_TOKEN / LINE_NOTIFY_USER_ID が必要(Vercelダッシュボードで設定)
// Tally側: フォームのIntegrations > Webhooks でこのエンドポイントURLを登録する

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const to = process.env.LINE_NOTIFY_USER_ID;
    if (!token || !to) {
      res.status(500).json({ error: 'env not configured' });
      return;
    }

    const body = req.body || {};
    const data = body.data || {};
    const formName = data.formName || 'フォーム';
    const fields = Array.isArray(data.fields) ? data.fields : [];

    const lines = [];
    for (const f of fields) {
      let v = f.value;
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        if (Array.isArray(f.options)) {
          v = v
            .map((id) => {
              const opt = f.options.find((o) => o.id === id);
              return opt ? opt.text : id;
            })
            .join('、');
        } else {
          v = v.join('、');
        }
      }
      if (typeof v === 'object') v = JSON.stringify(v);
      lines.push('▼' + f.label + '\n' + v);
    }

    const text = (
      '【' + formName + '】新しい送信がありました\n\n' + lines.join('\n\n')
    ).slice(0, 4900);

    const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] })
    });

    if (!lineRes.ok) {
      const detail = await lineRes.text();
      console.error('LINE push failed:', detail);
      res.status(502).json({ error: 'line push failed' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
};
