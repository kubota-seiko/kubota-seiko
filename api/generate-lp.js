// Vercel Serverless Function: 即日LP AI 工程④ — LP(lp_json)生成エンドポイント
// 役割: session_id を受け取り、その診断(diagnoses)とTally回答(tally_responses)を
//       元に Claude で LP 構造(lp_json)を1本生成し lps テーブルへ保存する。
//       LP 表示・PayPal・LINE・Tally受信・フロントは扱わない(工程⑤以降)。
//
// 必要な環境変数(Vercelダッシュボードで設定・値はコードに書かない):
//   ANTHROPIC_API_KEY          … Anthropic の秘密鍵(必須・サーバー専用)
//   LP_MODEL                    … 省略可。既定は品質重視の Sonnet 系
//   SUPABASE_URL                … Supabase プロジェクト URL
//   SUPABASE_SERVICE_ROLE_KEY   … service_role キー(サーバー専用・RLSバイパス)
//
// レスポンス整理:
//   POST以外                              → 405
//   session_id 不正/sessions に不在        → 422
//   ANTHROPIC_API_KEY / SUPABASE 未設定    → 500
//   生成元データ(診断もTallyも)無し        → 422
//   AI生成失敗・JSON不正                    → 500 (lp を作らない)
//   lps insert 失敗                        → 500
//   正常                                   → 200 { ok, lp_id, slug, status:'draft' }
'use strict';

const crypto = require('crypto');

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// shindan.js と同手法: コードブロック等を剥がして JSON を厳密抽出
function parseJsonLoose(s) {
  if (!s) return null;
  let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {}
  }
  return null;
}

function supabaseHeaders(key) {
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'content-type': 'application/json'
  };
}

// Tally フィールドの value を表示用文字列へ(選択肢は options で text 解決)
function resolveFieldValue(f) {
  let v = f && f.value;
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) {
    if (Array.isArray(f.options)) {
      v = v.map((id) => {
        const o = f.options.find((o) => o.id === id);
        return o ? o.text : id;
      });
    }
    return v.join('、');
  }
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 500);
  return String(v);
}

// label / key のキーワードで商品情報を堅牢に対応づける
const SEMANTIC_MATCHERS = [
  ['productName', [/商品名/, /サービス名/, /product\s*name/, /^name$/, /タイトル/]],
  ['target',      [/ターゲット/, /対象/, /誰/, /target/, /audience/, /顧客/]],
  ['price',       [/価格/, /料金/, /値段/, /price/, /amount/, /金額/]],
  ['productDetail', [/商品内容/, /内容/, /詳細/, /description/, /detail/, /サービス概要/]],
  ['strengths',   [/実績/, /強み/, /特徴/, /selling/, /strength/, /achievement/, /差別化/]],
  ['cta',         [/cta/, /行動/, /誘導/, /申込/, /申し込み/, /予約/, /問い合わせ/, /お問合せ/]],
  ['freeText',    [/自由記述/, /備考/, /その他/, /free/, /note/, /memo/, /補足/]]
];

function extractTallyInfo(responseJson) {
  const data = (responseJson && responseJson.data) || {};
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const semantic = {};
  const pairs = [];
  for (const f of fields) {
    const label = String((f && (f.label || f.key)) || '').trim();
    const lower = label.toLowerCase();
    if (lower === 'session_id') continue; // 隠しフィールドは除外
    const val = resolveFieldValue(f);
    if (!val) continue;
    pairs.push({ label: label || '(無題)', value: val });
    for (const [canon, res] of SEMANTIC_MATCHERS) {
      if (semantic[canon]) continue;
      if (res.some((re) => re.test(lower))) { semantic[canon] = val; break; }
    }
  }
  return { semantic, pairs };
}

// PostgREST GET(1件)ヘルパー
async function pgGetOne(base, headers, path) {
  const res = await fetch(base + path, {
    headers: Object.assign({}, headers, { 'Accept': 'application/json' })
  });
  if (!res.ok) throw new Error('pg get http ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// 推測困難な URL セーフ slug(12〜16文字)
function makeSlug() {
  return crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// その session の最新 LP(あれば)を返す。冪等化・GET の存在確認に使用。
async function getExistingLp(base, headers, sessionId) {
  return pgGetOne(base, headers,
    '/rest/v1/lps?select=id,slug,status&session_id=eq.' + encodeURIComponent(sessionId) +
    '&order=created_at.desc&limit=1');
}

// その session の最新 Tally 回答(あれば)を返す。
async function getLatestTally(base, headers, sessionId) {
  return pgGetOne(base, headers,
    '/rest/v1/tally_responses?select=response_json&session_id=eq.' + encodeURIComponent(sessionId) +
    '&order=created_at.desc&limit=1');
}

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sendHtml(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}

// 秘密値を含まない簡易 HTML(GET のエラー等)
function simpleHtml(title) {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + escHtml(title) + '</title></head>' +
    '<body style="font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;max-width:600px;margin:80px auto;padding:0 24px;text-align:center;color:#333;line-height:1.9">' +
    '<p style="font-size:19px;font-weight:700;margin-bottom:8px">' + escHtml(title) + '</p>' +
    '<p><a href="https://kubota-seiko.com/" style="color:#2563eb;text-decoration:none">kubota-seiko.com へ戻る</a></p>' +
    '</body></html>';
}

// 「作成中」ページ。同一オリジンの POST /api/generate-lp を1回投げ、
// 成功 {ok,slug} で /api/lp?slug=... へ遷移。失敗時は「もう一度」ボタン。
function waitingPage(sessionId) {
  const sid = JSON.stringify(sessionId); // sessionId は UUID 検証済み
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>あなた専用のLPを作成しています…</title><style>' +
    'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",Meiryo,sans-serif;background:#f8fafc;color:#1f2933;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}' +
    '.box{max-width:480px;padding:32px 24px}' +
    '.spinner{width:52px;height:52px;margin:0 auto 24px;border:5px solid #e4e7eb;border-top-color:#e8501e;border-radius:50%;animation:spin 1s linear infinite}' +
    '@keyframes spin{to{transform:rotate(360deg)}}' +
    'h1{font-size:20px;font-weight:800;margin:0 0 10px}' +
    'p{color:#52606d;font-size:15px;line-height:1.85;margin:0 0 8px}' +
    '.retry{display:none;margin-top:18px}' +
    '.btn{display:inline-block;background:#e8501e;color:#fff;font-weight:700;text-decoration:none;border:0;font-size:15px;padding:13px 28px;border-radius:999px;cursor:pointer}' +
    '</style></head><body><div class="box">' +
    '<div class="spinner" id="sp"></div>' +
    '<h1 id="ttl">あなた専用のLPを作成しています</h1>' +
    '<p id="msg">診断内容をもとに、AIがLPを組み立てています。30〜60秒ほどお待ちください…</p>' +
    '<div class="retry" id="retry"><p>時間がかかっています。もう一度お試しください。</p>' +
    '<button class="btn" id="retryBtn">もう一度作成する</button></div>' +
    '<script>(function(){var SID=' + sid + ';' +
    'function fail(){document.getElementById("sp").style.display="none";' +
    'document.getElementById("ttl").textContent="うまく作成できませんでした";' +
    'document.getElementById("msg").style.display="none";' +
    'document.getElementById("retry").style.display="block";}' +
    'function go(){fetch("/api/generate-lp",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({session_id:SID})}).then(function(r){return r.json();})' +
    '.then(function(d){if(d&&d.ok&&d.slug){location.href="/api/lp?slug="+encodeURIComponent(d.slug);}else{fail();}})' +
    '.catch(fail);}' +
    'document.getElementById("retryBtn").addEventListener("click",function(){' +
    'document.getElementById("sp").style.display="block";' +
    'document.getElementById("ttl").textContent="あなた専用のLPを作成しています";' +
    'document.getElementById("msg").style.display="block";' +
    'document.getElementById("retry").style.display="none";go();});' +
    'go();})();</script></div></body></html>';
}

// (A) GET /api/generate-lp?session_id=<uuid>
//   既存LPあり → 302 /api/lp?slug=... / 無し → 作成中HTML(ブラウザがPOSTを発火)
async function handleGet(req, res) {
  try {
    const sessionId = String((req.query && req.query.session_id) || '').trim();
    if (!UUID_RE.test(sessionId)) {
      sendHtml(res, 400, simpleHtml('リンクが正しくありません'));
      return;
    }
    const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!base || !key) {
      sendHtml(res, 500, simpleHtml('ただいま準備中です'));
      return;
    }
    const headers = supabaseHeaders(key);
    let lp;
    try {
      lp = await getExistingLp(base, headers, sessionId);
    } catch (e) {
      console.error('[generate-lp GET] lp lookup failed:', String((e && e.message) || e).slice(0, 200));
      sendHtml(res, 500, simpleHtml('ただいま表示できません'));
      return;
    }
    if (lp && lp.slug) {
      // 再訪は同じLPへ(二重生成なし)
      res.statusCode = 302;
      res.setHeader('Location', '/api/lp?slug=' + encodeURIComponent(lp.slug));
      res.end();
      return;
    }
    sendHtml(res, 200, waitingPage(sessionId));
  } catch (e) {
    console.error('[generate-lp GET] error:', String((e && e.message) || e).slice(0, 200));
    sendHtml(res, 500, simpleHtml('ただいま表示できません'));
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') { return handleGet(req, res); }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const startedAt = Date.now();
    const body = req.body || {};
    const sessionId = String(body.session_id || '').trim();

    // 1) session_id 形式検証
    if (!UUID_RE.test(sessionId)) {
      res.status(422).json({ ok: false, error: 'invalid_session_id' });
      return;
    }

    // 環境変数(未設定は 500)
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey || !/^[\x21-\x7E]+$/.test(apiKey) || apiKey.length > 250) {
      res.status(500).json({ ok: false, error: 'anthropic_key_not_set' });
      return;
    }
    const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!base || !key) {
      res.status(500).json({ ok: false, error: 'supabase_env_not_set' });
      return;
    }
    const headers = supabaseHeaders(key);

    // 1b) sessions 存在確認(無ければ 422)
    let sessionRow;
    try {
      sessionRow = await pgGetOne(base, headers,
        '/rest/v1/sessions?select=id&limit=1&id=eq.' + encodeURIComponent(sessionId));
    } catch (e) {
      console.error('[generate-lp] session lookup failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'session_lookup_failed' });
      return;
    }
    if (!sessionRow) {
      res.status(422).json({ ok: false, error: 'session_not_found' });
      return;
    }

    // 1c) 冪等化: 既にこの session の LP があれば生成せず既存を返す(二重生成防止)
    let existingLp;
    try {
      existingLp = await getExistingLp(base, headers, sessionId);
    } catch (e) {
      console.error('[generate-lp] existing lp lookup failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'lp_lookup_failed' });
      return;
    }
    if (existingLp && existingLp.slug) {
      res.status(200).json({ ok: true, lp_id: existingLp.id, slug: existingLp.slug, status: existingLp.status || 'draft' });
      return;
    }

    // 2) 最新の診断 / Tally 回答を取得(service_role)
    let diagnosisJson = null, tallyJson = null;
    try {
      const d = await pgGetOne(base, headers,
        '/rest/v1/diagnoses?select=diagnosis_json&session_id=eq.' + encodeURIComponent(sessionId) +
        '&order=created_at.desc&limit=1');
      diagnosisJson = d ? d.diagnosis_json : null;
      let t = await getLatestTally(base, headers, sessionId);
      if (!t) {
        // Tally 保存待ち: 最大12秒(2秒間隔)。timeout しても診断のみで生成を続行。
        for (let i = 0; i < 6 && !t; i++) {
          await sleep(2000);
          t = await getLatestTally(base, headers, sessionId);
        }
      }
      tallyJson = t ? t.response_json : null;
    } catch (e) {
      console.error('[generate-lp] source fetch failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'source_fetch_failed' });
      return;
    }

    // 生成元が診断もTallyも無ければ、事実を創作せず 422
    if (!diagnosisJson && !tallyJson) {
      res.status(422).json({ ok: false, error: 'no_source_data' });
      return;
    }

    // 3) Tally 商品情報を抽出
    const tally = tallyJson ? extractTallyInfo(tallyJson) : { semantic: {}, pairs: [] };

    // 4) Claude で lp_json を生成
    const model = (process.env.LP_MODEL || 'claude-sonnet-4-5').trim();

    const sysPrompt =
      'あなたは「思考整理の参謀・窪田成功」のLP設計アシスタントです。与えられた「診断結果」と「Tallyの回答」から読み取れる情報だけを根拠に、9,800円の商品として通用する、完成された1本のランディングページ構造(lp_json)を設計します。' +
      '【窪田式の原則】誰に・何を・どの順で伝えるかを明確にし、導線は1本・CTAは1つに絞る。心理順(現在地→課題→望む未来→解決→証拠→価格→行動)で構成する。誇張・断定・煽り(売上◯倍・必ず成果 等)は禁止。丁寧語で、簡潔かつ具体的に書く。' +
      '【事実の扱い】社名・数値・実績・経歴・引用などの事実は創作しない。回答や診断から読み取れない情報は書かない。一方で、Tallyや診断に実在する実績・数値・経歴(例:経験年数・実績件数・保有スキル)は、証拠として具体的に活用する。' +
      '【構成】根拠がある範囲で、次の構成を可能な限りそろえた"痩せていないLP"にする。根拠が全く無いセクションのみ省く: 1 problem(現状・お悩み) / 2 solution(解決策) / 3 benefits(得られる変化・最大4件) / 4 service(内容・特徴・他との違い＝差別化点) / 5 voice(実績・証拠。実在する実績や数値があれば必ず具体的に載せる) / 6 price(価格・提供内容。価格が分かる場合は必ず入れる) / 7 faq(想定される不安を解消) / 8 cta(行動を後押しする一文＋CTA)。' +
      '【具体性】ターゲットの状況・言葉に寄せ、一般論を避ける。他の選択肢との違いを明確にする。各セクションの body は2〜4文でしっかり書き、薄い一文で終わらせない。' +
      '【ファーストビュー】headline は「誰が・どんな未来を得られるか」が伝わる具体的な訴求(約40字)。subheadline は課題→解決の流れが伝わるよう約90〜120字で書く。' +
      '【出力】日本語。指定JSONスキーマの純粋なJSONのみを出力(前置き・コードブロック・説明なし)。sections の type は列挙値のみ。順番は心理順を基本に最適化。items は各約80字、不要なセクションは空配列で可。' +
      'スキーマ: {"meta":{"title":string,"description":string},"headline":string,"subheadline":string,' +
      '"cta":{"label":string,"type":"line"|"form"|"checkout"},' +
      '"sections":[{"type":"problem"|"solution"|"benefits"|"service"|"price"|"voice"|"faq"|"cta","heading":string,"body":string,"items":[string]}]}. ';

    const diagText = diagnosisJson
      ? ('総評: ' + String(diagnosisJson.summary || '(なし)') + '\n' +
         '課題: ' + (Array.isArray(diagnosisJson.findings)
           ? diagnosisJson.findings.map((f) =>
               '・' + [f.t, f.now, f.eff, f.fix].filter(Boolean).join(' / ')).join('\n')
           : '(なし)'))
      : '(診断データなし)';

    const sem = tally.semantic;
    const tallyText = tally.pairs.length
      ? ('【抽出した商品情報】\n' +
         '商品名: ' + (sem.productName || '(不明)') + '\n' +
         'ターゲット: ' + (sem.target || '(不明)') + '\n' +
         '価格: ' + (sem.price || '(不明)') + '\n' +
         '商品内容: ' + (sem.productDetail || '(不明)') + '\n' +
         '実績・強み: ' + (sem.strengths || '(不明)') + '\n' +
         '希望CTA: ' + (sem.cta || '(不明)') + '\n' +
         '自由記述: ' + (sem.freeText || '(なし)') + '\n\n' +
         '【Tally回答の全項目】\n' +
         tally.pairs.map((p) => '▼' + p.label + '\n' + p.value).join('\n').slice(0, 6000))
      : '(Tally回答なし。商品情報は空。診断から読み取れる範囲で、事実を創作せず設計してください)';

    const userContent =
      '【診断結果】\n' + diagText + '\n\n' + tallyText + '\n\n' +
      '上記だけを根拠に lp_json を生成してください。根拠の無い事実は書かないでください。';

    let apiRes;
    const aiCtrl = new AbortController();
    // maxDuration(60s)内に必ず収める。Tally待機で使った時間を差し引いた残り予算で
    // AIを打ち切る(プラットフォームの504ではなくクリーンな500で返すため)。最低20秒は確保。
    const aiBudgetMs = Math.max(20000, 57000 - (Date.now() - startedAt));
    const aiTimer = setTimeout(() => aiCtrl.abort(), aiBudgetMs);
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
          max_tokens: 4000,
          system: sysPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });
    } catch (e) {
      console.error('[generate-lp] ai request failed:', String((e && e.message) || e).slice(0, 200));
      res.status(500).json({ ok: false, error: 'ai_request_failed' });
      return;
    } finally {
      clearTimeout(aiTimer);
    }

    if (!apiRes.ok) {
      const errTxt = await apiRes.text().catch(() => '');
      console.error('[generate-lp] ai error http', apiRes.status, errTxt.slice(0, 200));
      res.status(500).json({ ok: false, error: 'ai_error' });
      return;
    }
    let aiJson;
    try { aiJson = await apiRes.json(); } catch (e) {
      res.status(500).json({ ok: false, error: 'ai_bad_json' });
      return;
    }
    const textOut = (aiJson.content && aiJson.content[0] && aiJson.content[0].text) || '';
    const parsed = parseJsonLoose(textOut);
    if (!parsed || typeof parsed !== 'object' || !parsed.headline || !Array.isArray(parsed.sections)) {
      res.status(500).json({ ok: false, error: 'lp_parse_failed' });
      return;
    }

    // lp_json を安定形へ正規化(表示側が壊れないよう最低限を保証)
    const CTA_TYPES = ['line', 'form', 'checkout'];
    const SEC_TYPES = ['problem', 'solution', 'benefits', 'service', 'price', 'voice', 'faq', 'cta'];
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    const lpJson = {
      meta: {
        title: s(parsed.meta && parsed.meta.title, 120) || s(parsed.headline, 120),
        description: s(parsed.meta && parsed.meta.description, 200)
      },
      headline: s(parsed.headline, 60),
      subheadline: s(parsed.subheadline, 120),
      cta: {
        label: s(parsed.cta && parsed.cta.label, 40) || 'お問い合わせ',
        type: CTA_TYPES.includes(parsed.cta && parsed.cta.type) ? parsed.cta.type : 'form'
      },
      sections: (parsed.sections || [])
        .filter((sec) => sec && SEC_TYPES.includes(sec.type))
        .slice(0, 10)
        .map((sec) => ({
          type: sec.type,
          heading: s(sec.heading, 80),
          body: s(sec.body, 800),
          items: Array.isArray(sec.items) ? sec.items.slice(0, 6).map((it) => s(it, 100)) : []
        }))
    };

    // 5-6) slug を生成して lps に insert(unique 衝突は再生成)。毎回新規行。
    let lpRow = null;
    for (let attempt = 0; attempt < 5 && !lpRow; attempt++) {
      const slug = makeSlug();
      let iRes;
      try {
        iRes = await fetch(base + '/rest/v1/lps', {
          method: 'POST',
          headers: Object.assign({}, headers, { 'Prefer': 'return=representation' }),
          body: JSON.stringify({ session_id: sessionId, slug, lp_json: lpJson, status: 'draft' })
        });
      } catch (e) {
        console.error('[generate-lp] lp insert request failed:', String((e && e.message) || e).slice(0, 200));
        res.status(500).json({ ok: false, error: 'lp_insert_failed' });
        return;
      }
      if (iRes.status === 409) continue; // slug unique 衝突 → 再生成
      if (!iRes.ok) {
        const errTxt = await iRes.text().catch(() => '');
        console.error('[generate-lp] lp insert http', iRes.status, errTxt.slice(0, 200));
        res.status(500).json({ ok: false, error: 'lp_insert_failed' });
        return;
      }
      const rows = await iRes.json().catch(() => null);
      lpRow = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!lpRow) {
        res.status(500).json({ ok: false, error: 'lp_insert_no_row' });
        return;
      }
    }
    if (!lpRow) {
      res.status(500).json({ ok: false, error: 'slug_conflict_retry_exhausted' });
      return;
    }

    // 7) lp_json 全文は返さない
    res.status(200).json({ ok: true, lp_id: lpRow.id, slug: lpRow.slug, status: lpRow.status || 'draft' });
  } catch (e) {
    console.error('[generate-lp] server error:', String((e && e.message) || e).slice(0, 200));
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
