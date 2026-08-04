// 診断リード受付: 窪田さんのLINEへ通知 + Googleスプレッドシート(Apps Script webhook)へ保存
// 必要env: LINE_CHANNEL_ACCESS_TOKEN / LINE_NOTIFY_USER_ID (既存) , LEAD_SHEET_WEBHOOK (任意・Apps ScriptのURL)
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const email = String(body.email || '').trim();
    if (!email || email.indexOf('@') < 1) { res.status(400).json({ ok: false, message: 'メールアドレスをご確認ください。' }); return; }
    const src = (body.source === 'hp') ? 'ホームページ導線診断' : 'SNS導線診断';
    const name = String(body.name || '').trim();
    const contact = String(body.contact || '').trim();
    const platform = String(body.platform || '').trim();
    const note = String(body.note || '').trim();
    const summary = String(body.summary || '').trim().slice(0, 500);

    // 1) LINE通知(窪田)
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const uid = process.env.LINE_NOTIFY_USER_ID;
    if (token && uid) {
      let t = '【' + src + ' / 無料提案リード】\n';
      t += 'お名前: ' + (name || '—') + '\n';
      t += 'メール: ' + email + '\n';
      t += 'SNS/URL: ' + (contact || '—') + '\n';
      if (platform) t += '対象: ' + platform + '\n';
      if (note) t += '悩み: ' + note + '\n';
      if (summary) t += '---\n診断要約: ' + summary + '\n';
      t += '---\n※この方へ、診断内容をもとにした改善提案を1つ送る約束です。';
      try {
        await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ to: uid, messages: [{ type: 'text', text: t.slice(0, 4900) }] })
        });
      } catch (e) { /* 通知失敗でもユーザー体験は止めない */ }
    }

    // 2) Googleスプレッドシート(Apps Script webhook)
    const hook = process.env.LEAD_SHEET_WEBHOOK;
    if (hook) {
      try {
        await fetch(hook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ts: new Date().toISOString(), source: src, name, email, contact, platform, note, summary })
        });
      } catch (e) { /* 保存失敗でもユーザー体験は止めない */ }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true }); // フロントは常に完了扱い(通知が主目的)
  }
}
