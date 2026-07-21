// 一時利用: LINE公式アカウントに届いたメッセージ送信者のuserIdをログに記録する
// (糸井さん・ダリさんのuserId取得用。取得後はLINE Developers側でWebhookをオフにする)
// 返信は一切行わないため、既存のチャット・自動応答運用には影響しない

module.exports = async (req, res) => {
  try {
    const events = (req.body && req.body.events) || [];
    for (const ev of events) {
      const userId = ev.source && ev.source.userId;
      const text = ev.message && ev.message.text;
      console.log('[line-webhook-id] userId:', userId, '| type:', ev.type, '| text:', text);
    }
  } catch (e) {
    console.error(e);
  }
  res.status(200).json({ ok: true });
};
