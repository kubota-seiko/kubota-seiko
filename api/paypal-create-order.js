// Vercel Serverless Function: PayPal注文作成
// 環境変数 PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET が必要(Vercelダッシュボードで設定)

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

// 価格はクライアントから受け取らず、サーバー側の固定マップから引く(改ざん防止)
const SERVICES = {
  'first-spot': { name: '初回スポット相談', amount: '5500' },
  'regular-spot': { name: '通常スポット相談', amount: '16500' },
  'monthly-1': { name: '月1回伴走プラン', amount: '33000' },
  'monthly-2': { name: '月2回伴走プラン', amount: '55000' }
};

async function getAccessToken() {
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const body = req.body || {};
    const serviceId = body.serviceId;
    const service = SERVICES[serviceId];
    if (!service) {
      res.status(400).json({ error: 'invalid service' });
      return;
    }
    const accessToken = await getAccessToken();
    const orderRes = await fetch(PAYPAL_API_BASE + '/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: service.name,
          amount: { currency_code: 'JPY', value: service.amount }
        }]
      })
    });
    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error('paypal create order failed', errText);
      res.status(502).json({ error: 'paypal order creation failed' });
      return;
    }
    const orderData = await orderRes.json();
    res.status(200).json({ id: orderData.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
};
