// Vercel Serverless Function: ホームページ導線診断
// 入力: POST { url, note? }
// 動作: 対象URLをサーバー側で取得 → 構造シグナルを抽出 →
//        画像中心で読めないサイトは thin:true を返す(安全弁) →
//        読めるサイトは Claude API で「総評+現状/影響/改善×3-4」を生成
// 必要な環境変数(Vercelダッシュボードで設定):
//   ANTHROPIC_API_KEY  … Anthropicの秘密鍵(必須)
//   SHINDAN_MODEL      … 省略可。既定 claude-haiku-4-5-20251001
'use strict';

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSignals(html) {
  const lower = html.toLowerCase();
  const text = stripTags(html);
  const imgCount = (html.match(/<img\b/gi) || []).length;
  const linkCount = (html.match(/<a\b/gi) || []).length;
  const hasViewport = /<meta[^>]+name=["']?viewport/i.test(html);
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]) : '';
  const descM = html.match(/<meta[^>]+name=["']?description["']?[^>]*content=["']([^"']*)["']/i);
  const desc = descM ? descM[1].slice(0, 300) : '';
  const h = [];
  const hre = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = hre.exec(html)) && h.length < 25) {
    const t = stripTags(m[2]);
    if (t) h.push('H' + m[1] + ': ' + t);
  }
  const hasForm = /<form\b/i.test(html);
  const contactHint = /(問い合わせ|お問合せ|お問い合わせ|contact|申込|申し込み|予約|相談)/i.test(text);
  const isWix = /(wix\.com|_wix|wixstatic|X-Wix)/i.test(lower);
  return {
    text, title, desc, imgCount, linkCount, hasViewport,
    headings: h, hasForm, contactHint, isWix,
    textLen: text.length, htmlLen: html.length
  };
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KubotaShindanBot/1.0; +https://kubota-seiko.com/)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const html = await r.text();
    return { status: r.status, html };
  } finally {
    clearTimeout(t);
  }
}

function parseJsonLoose(s) {
  if (!s) return null;
  let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {}
  }
  return null;
}

// 診断結果を Supabase に保存する(おまけ機能・失敗しても診断は止めない)。
//   - 使う環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (サーバー専用)
//   - @supabase/supabase-js は入れず、既存コード同様に PostgREST を素の
//     fetch で叩く(依存追加ゼロ)。service_role キーで RLS をバイパスして書込。
//   - どちらかの環境変数が未設定なら丸ごとスキップして null を返す。
//   - insert 失敗・タイムアウトは握りつぶし null を返す(診断は必ず返る)。
// 戻り値: 保存できた場合は session_id(uuid)、それ以外は null。
async function saveDiagnosisToSupabase({ url, diagnosis, utm, incomingSessionId }) {
  const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !key) return null; // 未設定 → 保存スキップ(従来通りの挙動)

  const headers = {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'content-type': 'application/json'
  };
  // 保存が診断レスポンスを大きく遅らせないための保険(4秒)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    // 呼び出し側から有効な session_id が来ていれば再利用(新規作成しない)
    let sessionId = (typeof incomingSessionId === 'string' &&
      /^[0-9a-fA-F-]{36}$/.test(incomingSessionId)) ? incomingSessionId : null;

    if (!sessionId) {
      const sres = await fetch(base + '/rest/v1/sessions', {
        method: 'POST', signal: ctrl.signal,
        headers: Object.assign({}, headers, { 'Prefer': 'return=representation' }),
        body: JSON.stringify(utm || {}) // UTM が無ければ {} → 各列 null で1行作成
      });
      if (!sres.ok) throw new Error('session insert http ' + sres.status);
      const srow = await sres.json();
      sessionId = srow && srow[0] && srow[0].id;
      if (!sessionId) throw new Error('session id missing');
    }

    const dres = await fetch(base + '/rest/v1/diagnoses', {
      method: 'POST', signal: ctrl.signal,
      headers: Object.assign({}, headers, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        session_id: sessionId,
        source_url: String(url || '').slice(0, 2000), // ユーザー入力の丸ごと保存を避ける最小健全化
        diagnosis_json: diagnosis
      })
    });
    if (!dres.ok) throw new Error('diagnosis insert http ' + dres.status);

    return sessionId;
  } catch (e) {
    // 秘密値を含めない安全なログのみ。診断の返却は妨げない。
    try { console.error('[shindan] supabase save skipped:', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  try {
    const body = req.body || {};
    let url = (body.url || '').trim();
    const note = (body.note || '').toString().slice(0, 500);
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let host;
    try { host = new URL(url); } catch (e) {
      res.status(400).json({ ok: false, error: 'invalid url' });
      return;
    }
    if (!/^https?:$/.test(host.protocol)) {
      res.status(400).json({ ok: false, error: 'invalid protocol' });
      return;
    }

    // 1) 対象サイトを取得
    let page;
    try {
      page = await fetchWithTimeout(url, 9000);
    } catch (e) {
      res.status(200).json({ ok: true, thin: true, reason: 'fetch_failed',
        message: 'サイトを読み込めませんでした。URLをご確認いただくか、個別診断をご利用ください。' });
      return;
    }

    const sig = extractSignals(page.html || '');

    // 2) 安全弁: 画像中心/JSアプリで本文が読めない場合は自動診断せず正直に返す
    if (sig.textLen < 400 || sig.isWix && sig.textLen < 800) {
      res.status(200).json({ ok: true, thin: true, reason: sig.isWix ? 'js_or_image_site' : 'thin_content',
        message: '画像中心のつくりのため、機械が本文を読み取れませんでした。こうしたサイトこそ、窪田による個別の導線診断をおすすめします。' });
      return;
    }

    // 3) Claude API で診断生成
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) {
      res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not set',
        message: '診断の準備が整っていません。しばらくしてからお試しください。' });
      return;
    }
    // 環境変数の値がAPIキー以外(日本語混入・異常な長さ)ならヘッダー例外を避けて明示的に返す
    if (!/^[\x21-\x7E]+$/.test(apiKey) || apiKey.length > 250) {
      res.status(500).json({ ok: false, error: 'bad_api_key',
        detail: 'len=' + apiKey.length + ' ascii=' + /^[\x21-\x7E]+$/.test(apiKey),
        message: '診断の設定に問題があります。運営者へご連絡ください。' });
      return;
    }
    const model = process.env.SHINDAN_MODEL || 'claude-haiku-4-5-20251001';

    const sysPrompt =
      'あなたは「思考整理の参謀・窪田成功」の、ホームページ導線診断アシスタントです。' +
      '渡されたサイトの本文抜粋と構造シグナルだけを根拠に、Web導線（誰に・何を・どの順番で伝え、どこで問い合わせに至るか）の観点で診断します。' +
      '推測で決めつけず、抜粋から読み取れる事実のみを述べ、断定しすぎないこと。誇張・煽り表現（売上◯倍・必ず成果 等）は禁止。丁寧語で簡潔に。' +
      '出力は日本語のJSONのみ。前置きやコードブロックは付けないこと。' +
      'スキーマ: {"summary": string, "findings": [{"title": string, "now": string, "eff": string, "fix": string}]}. ' +
      'summary=総評1〜2文。findings=3〜4件。title=短い課題名。now=現状（読み取れた事実）。eff=その影響。fix=改善アクション1つ。' +
      '本文が薄く判断が難しい場合は findings を減らしてよい。';

    const userContent =
      '【対象サイト】' + url + '\n' +
      '【タイトル】' + (sig.title || '(なし)') + '\n' +
      '【meta description】' + (sig.desc || '(なし)') + '\n' +
      '【構造シグナル】画像数=' + sig.imgCount + ' / リンク数=' + sig.linkCount +
        ' / スマホ対応(viewport)=' + (sig.hasViewport ? 'あり' : 'なし') +
        ' / フォーム=' + (sig.hasForm ? 'あり' : 'なし') +
        ' / 問い合わせ導線の語=' + (sig.contactHint ? 'あり' : '見当たらない') +
        ' / 本文文字数=' + sig.textLen + '\n' +
      '【見出し(H1/H2)】\n' + (sig.headings.join('\n') || '(抽出できず)') + '\n' +
      (note ? ('【相談者が気にしていること】' + note + '\n') : '') +
      '【本文抜粋】\n' + sig.text.slice(0, 9000);

    let apiRes;
    const aiCtrl = new AbortController();
    const aiTimer = setTimeout(() => aiCtrl.abort(), 30000); // AI応答が遅い/固まった場合の保険(30秒)
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: aiCtrl.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: 1400,
          system: sysPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
      res.status(200).json({ ok: false, error: aborted ? 'ai_timeout' : 'ai_request_failed',
        detail: String((e && e.message) || e).slice(0, 300),
        message: 'ただいま診断が混み合っています。少し時間をおいて、もう一度お試しください。' });
      return;
    } finally {
      clearTimeout(aiTimer);
    }

    if (!apiRes.ok) {
      const errTxt = await apiRes.text().catch(() => '');
      res.status(200).json({ ok: false, error: 'ai_error', detail: errTxt.slice(0, 300),
        message: 'うまく診断できませんでした。個別診断をご利用ください。' });
      return;
    }
    let aiJson;
    try { aiJson = await apiRes.json(); } catch (e) {
      res.status(200).json({ ok: false, error: 'ai_bad_json',
        message: 'うまく診断できませんでした。少し時間をおいてお試しいただくか、個別診断をご利用ください。' });
      return;
    }
    const textOut = (aiJson.content && aiJson.content[0] && aiJson.content[0].text) || '';
    const parsed = parseJsonLoose(textOut);
    if (!parsed || !Array.isArray(parsed.findings) || parsed.findings.length === 0) {
      res.status(200).json({ ok: false, error: 'parse_failed',
        message: 'うまく診断できませんでした。個別診断をご利用ください。' });
      return;
    }

    const findings = parsed.findings.slice(0, 4).map((f) => ({
      t: String(f.title || f.t || '').slice(0, 60),
      now: String(f.now || '').slice(0, 300),
      eff: String(f.eff || '').slice(0, 300),
      fix: String(f.fix || '').slice(0, 300)
    }));

    const diagnosis = {
      ok: true,
      url,
      summary: String(parsed.summary || '').slice(0, 500),
      findings
    };

    // --- Supabase 保存(おまけ)。失敗しても診断結果は必ず返す ---
    // リクエストに UTM が来ていれば sessions に記録(無ければ null)
    const utm = {};
    for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
      const v = body[k];
      if (typeof v === 'string' && v.trim()) utm[k] = v.trim().slice(0, 200);
    }
    let sessionId = null;
    try {
      sessionId = await saveDiagnosisToSupabase({
        url,
        diagnosis,
        utm,
        incomingSessionId: body.session_id
      });
    } catch (_) { sessionId = null; } // 二重の安全弁(ヘルパーは通常 throw しない)

    // 既存フィールドは一切壊さず session_id を1つ追加(保存できなければ null)
    diagnosis.session_id = sessionId || null;
    res.status(200).json(diagnosis);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error', message: String(e && e.message || e).slice(0, 200) });
  }
};
