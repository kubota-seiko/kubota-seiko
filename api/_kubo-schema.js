// くぼちゃっと 構造化出力スキーマ（Kubota OS v0.1）
// ---------------------------------------------------------------------
// 先頭が "_" のファイルは Vercel がルーティングしないため、Serverless Function
// の個数に数えられない。関数数は 12/12 のまま。
//
// 仕様書: docs/KUBOTA_OS_SPEC.md
//   §5  DECOMPOSE  … 事実 / 解釈 / 仮説 を分離する
//   §6  REFRAME    … surface_problem と root_problem を分ける
//   §9  MATERIALIZE… Artifact Router（何に形にすると進むか）
//   §19            … FACT / INTERPRETATION / HYPOTHESIS を混ぜない
//   §21            … reply は「①今起きていること ②本質 ③次にやること」
//
// 取り扱い方針（v0.1）:
//   facts / interpretations / hypotheses は「内部分析」としてモデルに考えさせるが、
//   ブラウザへは返さず、永続化もしない。回答の質を上げるための思考材料であり、
//   利用者に見せる前提の情報ではないため。
'use strict';

// §9 Artifact Router。自由記述させると集計が割れるため列挙で固定する。
// 'none' は §16「今は作らない」判断を表す正当な選択肢。
const ARTIFACT_KINDS = [
  'none',    // 今は何も作らなくてよい
  'lp',      // 集客課題
  'hp',      // 会社全体の信用
  'pdf',     // 営業説明・提案書
  'manual',  // 教育課題（マニュアル / 動画台本）
  'mvv',     // 組織文化（MVV / 評価基準）
  'sop',     // 繰り返し業務（SOP / 自動化）
  'system',  // 大量データ管理（DB / システム）
  'sns',     // 発信
  'speech',  // スピーチ原稿
  'agent'    // 繰り返し同じ判断（AIエージェント）
];

// Responses API の Structured Outputs（strict）は
//   ・全プロパティを required にする
//   ・全オブジェクトに additionalProperties:false を付ける
// ことを要求する。空でよい項目は「空文字 / 空配列を許す」と指示側で伝える。
//
// プロパティの並び順に意味がある: reply を先頭に置くことで、
// max_output_tokens に達して打ち切られても本文が残りやすくなる。
const KUBO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'analysis', 'artifact'],
  properties: {
    reply: {
      type: 'string',
      description: '利用者に表示する日本語の回答本文。これだけが画面に出る。'
    },
    analysis: {
      type: 'object',
      additionalProperties: false,
      required: [
        'surface_problem', 'root_problem',
        'facts', 'interpretations', 'hypotheses',
        'desired_state', 'next_actions'
      ],
      properties: {
        surface_problem: { type: 'string', description: '相談者が言葉にした表面的な問題' },
        root_problem:    { type: 'string', description: '再定義した本当の課題' },
        facts:           { type: 'array', items: { type: 'string' }, description: '相談文から確認できる事実のみ' },
        interpretations: { type: 'array', items: { type: 'string' }, description: '相談者側の解釈・受け取り方' },
        hypotheses:      { type: 'array', items: { type: 'string' }, description: '未確認の推測。事実として扱わない' },
        desired_state:   { type: 'string', description: '相談者が本当はどうなってほしいか' },
        next_actions:    { type: 'array', items: { type: 'string' }, description: '最小の次の一手。最大3件' }
      }
    },
    artifact: {
      type: 'object',
      additionalProperties: false,
      required: ['recommended', 'reason', 'confidence'],
      properties: {
        recommended: { type: 'string', enum: ARTIFACT_KINDS },
        reason:      { type: 'string', description: 'なぜそれにすると進むのか。1文' },
        confidence:  { type: 'number', description: '0.0〜1.0' }
      }
    }
  }
};

/** Responses API の text.format に渡す指定（response_format ではない） */
const TEXT_FORMAT = {
  format: {
    type: 'json_schema',
    name: 'kubota_os_v1',
    strict: true,
    schema: KUBO_SCHEMA
  }
};

/**
 * 寛容なJSON抽出。
 * 既存の api/shindan.js / generate-lp.js / sns-shindan.js と同じ方式。
 * 構造化出力が使えなかった場合のフォールバックに用いる。
 */
function parseJsonLoose(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (_) { /* 次へ */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* 次へ */ }
  }
  return null;
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function arr(v, max) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
          .slice(0, max || 10);
}

/**
 * モデル出力を安全な形へ正規化する。
 * 形が崩れていても落とさず、取れたところだけ返す。
 * 返り値の analysis には facts / interpretations / hypotheses も含むが、
 * これらは呼び出し側でブラウザへ返さないこと（内部分析専用）。
 */
function normalizeResult(parsed, rawText) {
  const p = (parsed && typeof parsed === 'object') ? parsed : {};
  const a = (p.analysis && typeof p.analysis === 'object') ? p.analysis : {};
  const f = (p.artifact && typeof p.artifact === 'object') ? p.artifact : {};

  // reply が取れないときは、生テキストを本文として扱う（利用者を空応答にしない）
  const reply = str(p.reply) || str(rawText);

  let conf = Number(f.confidence);
  if (!Number.isFinite(conf) || conf < 0) conf = 0;
  if (conf > 1) conf = 1;

  const kind = str(f.recommended);

  return {
    reply: reply,
    analysis: {
      surface_problem: str(a.surface_problem),
      root_problem:    str(a.root_problem),
      facts:           arr(a.facts),
      interpretations: arr(a.interpretations),
      hypotheses:      arr(a.hypotheses),
      desired_state:   str(a.desired_state),
      next_actions:    arr(a.next_actions, 3)
    },
    artifact: {
      recommended: ARTIFACT_KINDS.indexOf(kind) !== -1 ? kind : 'none',
      reason:      str(f.reason),
      confidence:  conf
    }
  };
}

/**
 * ブラウザへ返してよい範囲だけを取り出す。
 * facts / interpretations / hypotheses は未確認の推測を含むため返さない。
 */
function toPublic(result) {
  return {
    reply: result.reply,
    artifact: result.artifact
  };
}

module.exports = {
  ARTIFACT_KINDS,
  KUBO_SCHEMA,
  TEXT_FORMAT,
  parseJsonLoose,
  normalizeResult,
  toPublic
};
