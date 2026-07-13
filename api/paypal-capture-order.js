// Vercel Serverless Function: PayPal注文確定(キャプチャ)
// 環境変数 PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET が必要(Vercelダッシュボードで設定)

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

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
    const orderID = body.orderID;
    if (!orderID) {
      res.status(400).json({ error: 'missing orderID' });
      return;
    }
    const accessToken = await getAccessToken();
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
    res.status(200).json({ status: captureData.status, id: captureData.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
};
