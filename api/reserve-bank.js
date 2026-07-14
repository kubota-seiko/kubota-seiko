// Vercel Serverless Function: 銀行振込予約の受付
// 予約モーダルで「銀行振込」を選び、氏名・メールアドレスを入力して確定した際に呼ばれます。
// Misoca連携(任意): MISOCA_CLIENT_ID / MISOCA_CLIENT_SECRET / MISOCA_REFRESH_TOKEN が
// 設定されている場合のみ、Misoca上へ請求書(未入金)を自動作成します。
// Misoca側が未設定・エラーの場合でも、予約自体は成功として扱います(顧客対応をブロックしない)。

const MISOCA_API_BASE = 'https://app.misoca.jp/api/v3';
const MISOCA_OAUTH_BASE = 'https://app.misoca.jp/oauth2';

const SERVICES = {
  'first-spot': { name: '初回スポット相談', amount: 5500 },
  'regular-spot': { name: '通常スポット相談', amount: 16500 },
  'monthly-1': { name: '月1回伴走プラン', amount: 33000 },
  'monthly-2': { name: '月2回伴走プラン', amount: 55000 }
};

async function getMisocaAccessToken() {
  const clientId = process.env.MISOCA_CLIENT_ID;
  const clientSecret = process.env.MISOCA_CLIENT_SECRET;
  const refreshToken = process.env.MISOCA_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }
  const res = await fetch(MISOCA_OAUTH_BASE + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('misoca token refresh failed: ' + t);
  }
  const data = await res.json();
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn('[misoca] refresh_token rotated. Update MISOCA_REFRESH_TOKEN to:', data.refresh_token);
  }
  return data.access_token;
}

async function createMisocaContact(accessToken, name, email) {
  const res = await fetch(MISOCA_API_BASE + '/contact', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient_name: name || '未入力',
      recipient_title: '様',
      recipient_mail_address: email || ''
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('misoca contact create failed: ' + t);
  }
  return res.json();
}

async function createMisocaInvoice(accessToken, contactId, itemName, amount) {
  const today = new Date();
  const issueDate = today.getFullYear() + '/' + String(today.getMonth() + 1).padStart(2, '0') + '/' + String(today.getDate()).padStart(2, '0');
  const res = await fetch(MISOCA_API_BASE + '/invoice', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      issue_date: issueDate,
      contact_id: contactId,
      subject: itemName,
      body: { tax_option: 'INCLUDE' },
      items: [{ name: itemName, quantity: 1, unit_price: amount, unit_name: '式', tax_type: 'STANDARD_TAX_10' }]
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('misoca invoice create failed: ' + t);
  }
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const bodyIn = req.body || {};
    const serviceId = bodyIn.serviceId;
    const name = (bodyIn.name || '').toString().trim();
    const email = (bodyIn.email || '').toString().trim();
    const service = SERVICES[serviceId];
    if (!service) {
      res.status(400).json({ error: 'invalid service' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    // まず予約受付は成功として返す(Misoca連携が原因で予約自体が失敗しないように)
    res.status(200).json({ ok: true });

    // レスポンス送信後にMisoca連携を試みる
    try {
      const misocaToken = await getMisocaAccessToken();
      if (!misocaToken) return;
      const contact = await createMisocaContact(misocaToken, name, email);
      await createMisocaInvoice(misocaToken, contact.id, service.name, service.amount);
      console.log('[misoca] unpaid invoice created for', serviceId, name);
    } catch (err) {
      console.error('[misoca] reserve-bank sync failed:', err.message || err);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error' });
    }
  }
};
