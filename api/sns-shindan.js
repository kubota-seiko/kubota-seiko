// Vercel Serverless Function: SNSアカウント導線診断(貼り付け式)
// 入力: POST { platform, profile, posts, purpose, note }
//   URLは取りに行かない(IG/X/FBはサーバー取得できないため)。貼られたテキストのみを診断する。
// 必要な環境変数: ANTHROPIC_API_KEY / SHINDAN_MODEL(省略可)
'use strict';

function parseJsonLoose(s) {
  if (!s) return null;
  let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  try {
    const body = req.body || {};
    const platform = String(body.platform || '').slice(0, 40);
    const profile = String(body.profile || '').trim().slice(0, 2000);
    const posts = String(body.posts || '').trim().slice(0, 4000);
    const purpose = String(body.purpose || '').slice(0, 60);
    const note = String(body.note || '').trim().slice(0, 500);

    if (profile.length < 8 && posts.length < 8) {
      res.status(200).json({ ok: false, error: 'too_short',
        message: 'プロフィール文か投稿を、もう少し貼り付けてください（数行あれば診断できます）。' });
      return;
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) {
      res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not set',
        message: '診断の準備が整っていません。しばらくしてからお試しください。' });
      return;
    }
    if (!/^[\x21-\x7E]+$/.test(apiKey) || apiKey.length > 250) {
      res.status(500).json({ ok: false, error: 'bad_api_key',
        message: '診断の設定に問題があります。運営者へご連絡ください。' });
      return;
    }
    const model = process.env.SHINDAN_MODEL || 'claude-haiku-4-5-20251001';

    const sysPrompt =
      'あなたは「思考整理の参謀・窪田成功」の、SNSアカウント導線診断アシスタントです。' +
      '貼り付けられたプロフィール文と投稿だけを根拠に、SNS発信の導線（誰に・何の人かが一瞬で伝わるか／次の行動へ導けているか／発信の軸がぶれていないか）を診断します。' +
      '推測で決めつけず、貼られたテキストから読み取れる事実のみを述べ、断定しすぎないこと。誇張・煽り表現（フォロワー◯倍・必ずバズる 等）は禁止。丁寧語で簡潔に。' +
      '出力は日本語のJSONのみ。前置きやコードブロックは付けないこと。' +
      'スキーマ: {"summary": string, "findings": [{"title": string, "now": string, "eff": string, "fix": string}]}. ' +
      'summary=総評1〜2文。findings=ちょうど3件で、順に次の観点を扱う: ' +
      '1件目「プロフィールの解像度」=誰に向けた何の人かが一瞬で伝わる構造か。' +
      '2件目「導線・出口」=プロフィールのリンクや投稿から、次の行動（LINE・HP・予約など）へ迷わず導けているか。' +
      '3件目「発信の軸」=雑多な投稿に埋もれず、その人独自の強み・本質が伝わっているか。' +
      '各findingで title=短い課題名、now=現状（読み取れた事実）、eff=その影響、fix=改善アクション1つ。' +
      '情報が乏しい観点は、断定せず「貼られた情報からは読み取りにくい」と正直に書いてよい。';

    const userContent =
      '【プラットフォーム】' + (platform || '(未指定)') + '\n' +
      '【発信の目的】' + (purpose || '(未指定)') + '\n' +
      (note ? ('【気にしていること】' + note + '\n') : '') +
      '【プロフィール文】\n' + (profile || '(貼り付けなし)') + '\n\n' +
      '【投稿(2〜3個)】\n' + (posts || '(貼り付けなし)');

    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
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
      res.status(200).json({ ok: false, error: 'ai_request_failed',
        detail: String((e && e.message) || e).slice(0, 300),
        message: 'ただいま診断が混み合っています。少し時間をおいてお試しください。' });
      return;
    }
    if (!apiRes.ok) {
      const errTxt = await apiRes.text().catch(() => '');
      res.status(200).json({ ok: false, error: 'ai_error', detail: errTxt.slice(0, 300),
        message: 'うまく診断できませんでした。個別診断をご利用ください。' });
      return;
    }
    const aiJson = await apiRes.json();
    const textOut = (aiJson.content && aiJson.content[0] && aiJson.content[0].text) || '';
    const parsed = parseJsonLoose(textOut);
    if (!parsed || !Array.isArray(parsed.findings) || parsed.findings.length === 0) {
      res.status(200).json({ ok: false, error: 'parse_failed',
        message: 'うまく診断できませんでした。個別診断をご利用ください。' });
      return;
    }
    const findings = parsed.findings.slice(0, 3).map((f) => ({
      t: String(f.title || f.t || '').slice(0, 60),
      now: String(f.now || '').slice(0, 300),
      eff: String(f.eff || '').slice(0, 300),
      fix: String(f.fix || '').slice(0, 300)
    }));
    res.status(200).json({
      ok: true,
      platform,
      summary: String(parsed.summary || '').slice(0, 500),
      findings
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error', message: String((e && e.message) || e).slice(0, 200) });
  }
};
