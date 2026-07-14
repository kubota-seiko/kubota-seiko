// Vercel Serverless Function: PayPal注文確定(キャプチャ)
// 環境変数 PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET が必要(Vercelダッシュボードで設定)
// Misoca連携(任意): MISOCA_CLIENT_ID / MISOCA_CLIENT_SECRET / MISOCA_REFRESH_TOKEN が
// 設定されている場合のみ、決済完了後にMisoca上へ請求書(支払い済み)を自動作成します。
// Misoca側が未設定・エラーの場合でも、決済自体の成功レスポンスには影響しません。
// 重要: レスポンスを返した後の処理はVercel側で実行が保証されないため、
// Misoca連携は必ずレスポンスを返す前にawaitで完了させること。

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const MISOCA_API_BASE = 'https://app.misoca.jp/api/v3';
const MISOCA_OAUTH_BASE = 'https://app.misoca.jp/oauth2';

// 価格・品目名はサーバー側の固定マップから引く(paypal-create-order.jsと同じ内容)
const SERVICES = {
  'first-spot': { name: '初回スポット相談', amount: 5500 },
  'regular-spot': { name: '通常スポット相談', amount: 16500 },
  'monthly-1': { name: '月1回伴走プラン', amount: 33000 },
  'monthly-2': { name: '月2回伴走プラン', amount: 55000 }
};

async function getPaypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const auth = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch(PAYPAL_API_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('token request failed: ' + t);
  }
  const data = await res.json();
  return data.access_token;
}

async function getMisocaAccessToken() {
  const clientId = process.env.MISOCA_CLIENT_ID;
  const clientSecret = process.env.MISOCA_CLIENT_SECRET;
  const refreshToken = process.env.MISOCA_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return null; // Misoca未設定。連携をスキップする合図。
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
    // MisocaがリフレッシュトークンをローテーションさせるとVercelログにここが出ます。
    // 出た場合はVercelの環境変数 MISOCA_REFRESH_TOKEN を新しい値に更新してください。
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

async function createMisocaInvoice(accessToken, contactId, itemName, amount, markPaid) {
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
  const invoice = await res.json();
  if (markPaid) {
    await fetch(MISOCA_API_BASE + '/invoice/' + invoice.id + '/paid', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  }
  return invoice;
}

async function syncToMisoca(serviceId, payerName, payerEmail) {
  const service = SERVICES[serviceId];
  if (!service) return 'skipped-unknown-service';
  try {
    const misocaToken = await getMisocaAccessToken();
    if (!misocaToken) return 'skipped-not-configured';
    const contact = await createMisocaContact(misocaToken, payerName, payerEmail);
    await createMisocaInvoice(misocaToken, contact.id, service.name, service.amount, true);
    console.log('[misoca] paid invoice created for', serviceId, payerName);
    return 'created';
  } catch (err) {
    // Misoca連携の失敗は決済結果に影響させない(ログのみ)
    console.error('[misoca] sync failed:', err.message || err);
    return 'failed';
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const body = req.body || {};
    const orderID = body.orderID;
    const serviceId = body.serviceId;
    if (!orderID) {
      res.status(400).json({ error: 'missing orderID' });
      return;
    }
    const accessToken = await getPaypalAccessToken();
    const captureRes = await fetch(PAYPAL_API_BASE + '/v2/checkout/orders/' + orderID + '/capture', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      }
    });
    if (!captureRes.ok) {
      const errText = await captureRes.text();
      console.error('paypal capture failed', errText);
      res.status(502).json({ error: 'paypal capture failed' });
      return;
    }
    const captureData = await captureRes.json();

    // Misoca連携はレスポンスを返す前に完了させる(Vercelは応答後の処理継続を保証しないため)
    let misocaStatus = 'skipped-no-service';
    try {
      const payer = captureData.payer || {};
      const payerName = [payer.name && payer.name.surname, payer.name && payer.name.given_name].filter(Boolean).join(' ') || (payer.email_address || '');
      const payerEmail = payer.email_address || '';
      if (serviceId) {
        misocaStatus = await syncToMisoca(serviceId, payerName, payerEmail);
      }
    } catch (err) {
      console.error('[misoca] post-capture sync error:', err.message || err);
      misocaStatus = 'failed';
    }

    res.status(200).json({ status: captureData.status, id: captureData.id, misoca: misocaStatus });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error' });
    }
  }
};
