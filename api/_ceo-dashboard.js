// CEO OS ダッシュボードAPI(MONEY + TODAY をまとめて返す)
// ---------------------------------------------------------------------
// GET /api/ceo?fn=dashboard   → 画面に必要な全データを1リクエストで返す
//
// 設計方針:
//   - 計算はすべてサーバー側で完結させ、フロントには計算済みの数値を渡す。
//     (ロジックの二重実装を防ぐ。フロントは表示に徹する)
//   - 日付判定はすべて JST 基準(lib.todayJST)。UTC の new Date() を直接使わない。
//   - 外部APIは叩かない。Supabase の読み取りのみ(4クエリ)。
//   - 金額を含むため cache-control: no-store(lib.json が付与)。
//   - **数字が確定していなくても画面を止めない。** 未確定・古い・未分類は
//     pending(確認待ち)として可視化し、計算自体は続行する。
//
// レスポンス整理:
//   GET以外          → 405
//   未ログイン        → 401
//   SUPABASE 未設定   → 500
//   正常             → 200
'use strict';

const lib = require('./_ceo-lib.js');

const HORIZON_DAYS = 30;
const NEAR_DAYS = 7;
const STALE_BALANCE_DAYS = 3;   // これを超えたら「古い」
const OUTDATED_BALANCE_DAYS = 7; // これを超えたら「要更新」
const SHORT_TERM_DAYS = 4;       // 「直近」区切り = 今日+4日

// =====================================================================
// 計算ロジック(純粋関数・副作用なし)
// ---------------------------------------------------------------------
// テストしやすいよう I/O から切り離してある。
//
// 【今使えるお金 — 2種類】
//
//  A. 確定ベース (available_confirmed)
//       現預金 + 30日以内の確定入金 − 30日以内の【確定】支払い
//              − reserve_amount − safety_buffer
//     金額が確定しているものだけで計算した、動かない下限。
//
//  B. 予測ベース (available_forecast)
//       A から さらに 30日以内の【予測】支払い を引いたもの。
//     前月実績・計画値を含む、最悪寄りのシナリオ。
//
//   ※ どちらも確度「高」「低」の入金は加算しない。
//   ※ 予測の入金(高/低)は B にも加算しない。支払いだけを保守的に積む。
//
// 【期限超過の扱い】入金と支払いで意図的に非対称にしている。
//     - 支払い(out) の期限超過 → 集計に含める。払う義務は消えていないため。
//     - 入金(in)  の期限超過 → 集計に含めない。期日に入らなかった時点で
//       当てにできる金額ではないため。TODAY の「入金確認・回収」候補に回す。
//
// 【残高予測】今使えるお金とは別の数字。reserve/safety は引かない。
// =====================================================================

/** 空の集計器 */
function bucket() {
  return {
    cash: 0,
    payables_confirmed: 0,
    payables_estimated: 0,
    receivables_confirmed: 0,
    receivables_high: 0,
    overdue_out: 0,
    overdue_in: 0
  };
}

function finalize(b, reserve, safety) {
  const availableConfirmed =
    b.cash + b.receivables_confirmed - b.payables_confirmed - reserve - safety;
  return Object.assign({}, b, {
    payables_total: b.payables_confirmed + b.payables_estimated,
    reserve_amount: reserve,
    safety_buffer: safety,
    available_confirmed: availableConfirmed,
    available_forecast: availableConfirmed - b.payables_estimated
  });
}

function compute(today, accounts, events, settings, tasks) {
  const horizon = lib.addDays(today, HORIZON_DAYS);
  const near = lib.addDays(today, NEAR_DAYS);

  // --- 設定値 ---
  const settingMap = {};
  for (const s of settings) settingMap[s.key] = Number(s.amount) || 0;
  const reserveAmount = settingMap.reserve_amount || 0;
  const safetyBuffer = settingMap.safety_buffer || 0;

  // --- 現預金(法人 / 個人 / 未分類 別) ---
  const ent = { corporate: bucket(), personal: bucket(), unknown: bucket() };
  const all = bucket();

  let oldestAsOf = null;
  const activeAccounts = [];
  const staleAccounts = [];
  for (const a of accounts) {
    if (a.is_active === false) continue;
    const balance = Number(a.balance) || 0;
    const e = lib.entityOf(a.name);
    ent[e].cash += balance;
    all.cash += balance;
    if (a.as_of && (oldestAsOf === null || a.as_of < oldestAsOf)) oldestAsOf = a.as_of;

    const ageDays = a.as_of ? daysBetween(a.as_of, today) : null;
    const freshness = ageDays === null ? 'unknown'
      : ageDays > OUTDATED_BALANCE_DAYS ? 'outdated'
        : ageDays > STALE_BALANCE_DAYS ? 'stale' : 'fresh';

    const row = {
      id: a.id,
      name: lib.stripEntityTag(a.name),
      raw_name: a.name,
      entity: e,
      balance: balance,
      as_of: a.as_of,
      age_days: ageDays,
      freshness: freshness
    };
    activeAccounts.push(row);
    if (freshness === 'stale' || freshness === 'outdated') staleAccounts.push(row);
  }

  // --- 入出金予定(status='scheduled' のみ) ---
  const collectionCandidates = [];
  const dueToday = [];
  const overdue = [];
  const upcomingIn = [];
  const upcomingOut = [];
  const estimatedEvents = [];   // 予測金額のもの(確認待ちの材料)
  const unclassified = [];      // [法][個] が付いていないもの
  const scheduled = [];         // 区切り集計用に保持

  for (const ev of events) {
    if (ev.status !== 'scheduled') continue;
    const amount = Number(ev.amount) || 0;
    const due = ev.due_date;
    if (!due) continue;

    const e = lib.entityOf(ev.label);
    const estimated = lib.isEstimated(ev);
    const isOverdue = due < today;
    const row = {
      id: ev.id,
      direction: ev.direction,
      label: lib.stripEntityTag(ev.label),
      raw_label: ev.label,
      entity: e,
      counterparty: ev.counterparty || null,
      amount: amount,
      due_date: due,
      confidence: ev.confidence,
      category: ev.category || null,
      estimated: estimated,
      overdue: isOverdue,
      days_until: daysBetween(today, due)
    };
    scheduled.push(row);
    if (e === 'unknown') unclassified.push(row);
    if (estimated) estimatedEvents.push(row);

    // 30日ウィンドウ外は集計しない(区切り表示には使う)
    if (due > horizon) {
      if (ev.direction === 'out') upcomingOut.push(row); else upcomingIn.push(row);
      continue;
    }

    const targets = [ent[e], all];
    if (ev.direction === 'out') {
      for (const b of targets) {
        if (estimated) b.payables_estimated += amount;
        else b.payables_confirmed += amount;
        if (isOverdue) b.overdue_out += amount;
      }
      upcomingOut.push(row);
    } else if (isOverdue) {
      // 期限超過の入金は「まだ入っていないお金」。どの集計にも加算しない。
      for (const b of targets) b.overdue_in += amount;
      collectionCandidates.push(row);
      upcomingIn.push(row);
    } else {
      for (const b of targets) {
        if (ev.confidence === 'confirmed') b.receivables_confirmed += amount;
        else if (ev.confidence === 'high') b.receivables_high += amount;
      }
      upcomingIn.push(row);
    }

    // overdue は「支払いの期限超過」だけ。入金は collection_candidates へ。
    if (isOverdue) { if (ev.direction === 'out') overdue.push(row); }
    else if (due === today) dueToday.push(row);
  }

  // --- 法人/個人/総合 の確定額・予測額 ---
  // reserve / safety は法人・個人に按分できないため、総合にのみ適用する。
  // (どちらの財布から取り置くかは未定義。工程③で entity 別設定にする)
  const entities = {
    corporate: finalize(ent.corporate, 0, 0),
    personal: finalize(ent.personal, 0, 0),
    unknown: finalize(ent.unknown, 0, 0),
    total: finalize(all, reserveAmount, safetyBuffer)
  };

  // --- 7日/30日の残高予測(確保額・安全残高は引かない) ---
  let pay7Confirmed = 0, pay7Estimated = 0, rec7Confirmed = 0;
  for (const r of scheduled) {
    if (r.due_date > near) continue;
    if (r.direction === 'out') {
      if (r.estimated) pay7Estimated += r.amount; else pay7Confirmed += r.amount;
    } else if (!r.overdue && r.confidence === 'confirmed') {
      rec7Confirmed += r.amount;
    }
  }
  const forecast7 = all.cash + rec7Confirmed - pay7Confirmed - pay7Estimated;
  const forecast30 = all.cash + all.receivables_confirmed - all.payables_confirmed - all.payables_estimated;

  // --- 資金繰りの区切り(直近 / 今月末 / 翌月10日) ---
  const runway = buildRunway(today, all.cash, safetyBuffer, scheduled);

  // --- 確認待ち(数字が揃っていないこと自体を可視化する) ---
  const pending = buildPending({
    today, accounts: activeAccounts, staleAccounts, estimatedEvents,
    unclassified, overdue, collectionCandidates, tasks
  });

  // --- 今日やること / 今日確認すること ---
  const openTasks = tasks.filter((t) => t.status === 'open');
  const tier = (t) => {
    if (!t.due_date) return 2;
    if (t.due_date < today) return 0;
    if (t.due_date === today) return 1;
    return 2;
  };
  openTasks.sort((a, b) => {
    const aDue = tier(a), bDue = tier(b);
    if (aDue !== bDue) return aDue - bDue;
    const aP = Number(a.priority) || 3, bP = Number(b.priority) || 3;
    if (aP !== bP) return aP - bP;
    const aD = a.due_date || '9999-12-31', bD = b.due_date || '9999-12-31';
    if (aD !== bD) return aD < bD ? -1 : 1;
    return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
  });

  const toCheck = rankChecks(pending);

  const byDue = (x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : 0);
  upcomingIn.sort(byDue);
  upcomingOut.sort(byDue);
  overdue.sort(byDue);
  dueToday.sort(byDue);
  collectionCandidates.sort(byDue);

  const t = entities.total;
  return {
    as_of: today,
    horizon_date: horizon,
    money: {
      cash: all.cash,
      balance_as_of_oldest: oldestAsOf,
      balance_stale: staleAccounts.length > 0,
      // 既存キー(工程①互換): 確定+予測の合計
      payables_30d: t.payables_total,
      payables_30d_confirmed: t.payables_confirmed,
      payables_30d_estimated: t.payables_estimated,
      receivables_30d_confirmed: t.receivables_confirmed,
      receivables_30d_high: t.receivables_high,
      overdue_out: t.overdue_out,
      overdue_in: t.overdue_in,
      reserve_amount: reserveAmount,
      safety_buffer: safetyBuffer,
      // 工程②: 2種類の「今使えるお金」
      available_confirmed: t.available_confirmed,
      available_forecast: t.available_forecast,
      // 既存キー(工程①互換) = 予測ベースと同値
      available_now: t.available_forecast,
      forecast_7d: forecast7,
      forecast_30d: forecast30,
      forecast_30d_optimistic: forecast30 + t.receivables_high
    },
    entities: entities,
    runway: runway,
    pending: pending,
    today: {
      date: today,
      due_today: dueToday,
      overdue: overdue,
      overdue_count: overdue.length,
      collection_candidates: collectionCandidates,
      collection_count: collectionCandidates.length,
      tasks: openTasks.slice(0, 3).map((x) => ({
        id: x.id,
        title: x.title,
        due_date: x.due_date || null,
        priority: Number(x.priority) || 3,
        overdue: !!(x.due_date && x.due_date < today)
      })),
      tasks_total_open: openTasks.length,
      // 工程②: 今日確認すること(1〜3件・ルールベース)
      to_check: toCheck
    },
    lists: {
      accounts: activeAccounts,
      upcoming_in: upcomingIn,
      upcoming_out: upcomingOut
    }
  };
}

// ---------------------------------------------------------------------
// 補助: 日数差(from → to)。同日なら 0、to が過去なら負。
// ---------------------------------------------------------------------
function daysBetween(from, to) {
  const a = Date.parse(from + 'T12:00:00Z');
  const b = Date.parse(to + 'T12:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** 'YYYY-MM-DD' の当月末 */
function endOfMonth(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const last = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 86400000);
  return last.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' の翌月10日 */
function tenthOfNextMonth(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return ny + '-' + String(nm).padStart(2, '0') + '-10';
}

// ---------------------------------------------------------------------
// 資金繰りの区切り
// ---------------------------------------------------------------------
// 「直近5日」「今月末」「翌月10日」の3点で、その日までに何が起きるかを出す。
// 日付を決め打ちせず今日から算出するので、いつ開いても意味のある区切りになる。
// 翌月10日を入れているのは、カード・公庫・税の引き落としが集中しやすいため。
// 区切りは累積(その日まで)。金額が重複しないよう、常に today 起点で数える。
// ---------------------------------------------------------------------
function buildRunway(today, cash, safetyBuffer, scheduled) {
  const raw = [
    { key: 'short', label: '直近', date: lib.addDays(today, SHORT_TERM_DAYS) },
    { key: 'month_end', label: '今月末', date: endOfMonth(today) },
    { key: 'next_10th', label: '翌月10日', date: tenthOfNextMonth(today) }
  ];

  // 日付が前後したり重複したりしないよう整理する
  const seen = new Set();
  const points = [];
  for (const p of raw) {
    if (!p.date || p.date < today) continue;
    if (seen.has(p.date)) continue;
    seen.add(p.date);
    points.push(p);
  }
  points.sort((a, b) => (a.date < b.date ? -1 : 1));

  return points.map((p) => {
    const agg = { corporate: bucket(), personal: bucket(), unknown: bucket() };
    let payC = 0, payE = 0, recC = 0;
    for (const r of scheduled) {
      if (r.due_date > p.date) continue;
      const b = agg[r.entity];
      if (r.direction === 'out') {
        if (r.estimated) { payE += r.amount; b.payables_estimated += r.amount; }
        else { payC += r.amount; b.payables_confirmed += r.amount; }
      } else if (!r.overdue && r.confidence === 'confirmed') {
        recC += r.amount;
        b.receivables_confirmed += r.amount;
      }
    }
    const balanceConfirmed = cash + recC - payC;
    const balanceForecast = balanceConfirmed - payE;
    return {
      key: p.key,
      label: p.label,
      date: p.date,
      days_until: daysBetween(today, p.date),
      payables_confirmed: payC,
      payables_estimated: payE,
      receivables_confirmed: recC,
      balance_confirmed: balanceConfirmed,
      balance_forecast: balanceForecast,
      // 不足見込み = 最低安全残高を割り込む額(割らないなら0)
      shortfall_confirmed: Math.max(0, safetyBuffer - balanceConfirmed),
      shortfall_forecast: Math.max(0, safetyBuffer - balanceForecast),
      by_entity: {
        corporate: agg.corporate,
        personal: agg.personal,
        unknown: agg.unknown
      }
    };
  });
}

// ---------------------------------------------------------------------
// 確認待ちの検出
// ---------------------------------------------------------------------
// 「まだ分かっていないこと」を数えて可視化する。ここが埋まらなくても
// 画面は止めず、計算は続行する。
//
// 2系統ある:
//   ① 自動検出 … 古い残高 / 予測金額 / 未分類 / 期限超過 など、
//                 データから機械的に分かるもの
//   ② 手動登録 … タイトルが「[確認]」で始まる ceo_tasks。
//                 「8/25の支払いが何か分からない」のような、
//                 データとして存在しないことは自動検出できないため。
// ---------------------------------------------------------------------
const CHECK_TASK_PREFIX = '[確認]';

function buildPending(ctx) {
  const { today, accounts, staleAccounts, estimatedEvents,
    unclassified, overdue, collectionCandidates, tasks } = ctx;
  const out = [];

  if (accounts.length === 0) {
    out.push({
      key: 'no_accounts', kind: 'setup', severity: 'high',
      title: '口座が未登録です',
      detail: 'まず現預金を1件登録してください。すべての計算の起点になります。',
      amount: 0, due_date: null, age_days: null
    });
  }

  for (const a of staleAccounts) {
    out.push({
      key: 'stale_balance:' + a.id, kind: 'stale', ref_id: a.id,
      severity: a.freshness === 'outdated' ? 'high' : 'medium',
      title: a.name + ' の残高が' + (a.freshness === 'outdated' ? '古すぎます' : '古い可能性'),
      detail: a.as_of + ' 時点（' + a.age_days + '日前）。実残高を確認してください。',
      amount: a.balance, due_date: null, age_days: a.age_days
    });
  }

  // 予測金額は、期限が近く金額が大きいものほど資金繰りへの影響が大きい
  for (const e of estimatedEvents) {
    out.push({
      key: 'estimated:' + e.id, kind: 'estimate', ref_id: e.id, severity: 'medium',
      title: e.label + ' は予測金額です',
      detail: (e.due_date) + ' / ' + e.amount.toLocaleString('ja-JP')
        + '円（前月実績・計画値）。実額を確認してください。',
      amount: e.amount, due_date: e.due_date, age_days: null
    });
  }

  if (unclassified.length > 0) {
    out.push({
      key: 'unclassified', kind: 'setup', severity: 'low',
      title: '法人／個人が未分類の項目が ' + unclassified.length + ' 件',
      detail: 'ラベルの先頭に [法] または [個] を付けると、法人・個人を分けて見られます。',
      amount: unclassified.reduce((s, x) => s + x.amount, 0), due_date: null, age_days: null
    });
  }

  for (const o of overdue) {
    out.push({
      key: 'overdue_out:' + o.id, kind: 'overdue_out', ref_id: o.id, severity: 'high',
      title: o.label + ' の支払期限が過ぎています',
      detail: o.due_date + '（' + Math.abs(o.days_until) + '日超過） / '
        + o.amount.toLocaleString('ja-JP') + '円',
      amount: o.amount, due_date: o.due_date, age_days: Math.abs(o.days_until)
    });
  }

  for (const c of collectionCandidates) {
    out.push({
      key: 'collect:' + c.id, kind: 'collect', ref_id: c.id, severity: 'medium',
      title: c.label + ' の入金を確認・回収',
      detail: c.due_date + '（' + Math.abs(c.days_until) + '日超過） / '
        + c.amount.toLocaleString('ja-JP') + '円。今使えるお金には含めていません。',
      amount: c.amount, due_date: c.due_date, age_days: Math.abs(c.days_until)
    });
  }

  // 手動の確認待ち（[確認] で始まるタスク）
  for (const t of tasks) {
    if (t.status !== 'open') continue;
    const title = String(t.title || '');
    if (title.indexOf(CHECK_TASK_PREFIX) !== 0) continue;
    out.push({
      key: 'task:' + t.id, kind: 'manual', ref_id: t.id,
      severity: Number(t.priority) <= 2 ? 'high' : 'medium',
      title: title.slice(CHECK_TASK_PREFIX.length).trim(),
      detail: t.due_date ? ('期限 ' + t.due_date) : '期限なし',
      amount: 0,
      due_date: t.due_date || null,
      age_days: t.due_date ? -daysBetween(today, t.due_date) : null,
      priority: Number(t.priority) || 3
    });
  }

  return out;
}

// ---------------------------------------------------------------------
// 「今日確認すること」の優先順位付け（ルールベース・AIは使わない）
// ---------------------------------------------------------------------
// 4つの観点を 0〜1 に正規化して重み付き合計する。
//   A. 期限が近い        (40点) 超過=満点、近いほど高い
//   B. 金額が大きい      (30点) 10万円で満点
//   C. 資金繰りへの影響  (20点) 予測金額・期限超過は影響大
//   D. データが古い      (10点) 14日で満点
// AIを使わない理由: 毎朝1〜2秒待たされる割に、この4観点の
// 重み付けで十分に納得できる順序が出るため。
// ---------------------------------------------------------------------
const CHECK_WEIGHTS = { urgency: 40, magnitude: 30, impact: 20, staleness: 10 };
const IMPACT_BY_KIND = {
  overdue_out: 1.0,   // 延滞は最優先(信用に関わる)
  manual: 0.9,        // 本人が「分からない」と登録したもの
  estimate: 0.8,      // 金額が動くと資金繰りが変わる
  collect: 0.7,       // 入るはずのお金
  stale: 0.6,         // 起点の数字が古い
  setup: 0.4
};

function urgencyScore(item) {
  if (item.due_date == null) return item.kind === 'stale' ? 0.5 : 0.3;
  const d = item.age_days;
  if (item.kind === 'overdue_out' || item.kind === 'collect') return 1.0; // 既に超過
  if (typeof d !== 'number') return 0.3;
  const daysLeft = -d; // age_days は「超過日数」の符号で持っている
  if (daysLeft <= 0) return 1.0;
  if (daysLeft <= 2) return 0.9;
  if (daysLeft <= 5) return 0.75;
  if (daysLeft <= 10) return 0.5;
  if (daysLeft <= 20) return 0.3;
  return 0.15;
}

function scoreCheck(item) {
  const urgency = urgencyScore(item);
  const magnitude = Math.min(1, (Number(item.amount) || 0) / 100000);
  const impact = IMPACT_BY_KIND[item.kind] != null ? IMPACT_BY_KIND[item.kind] : 0.5;
  const staleness = item.kind === 'stale'
    ? Math.min(1, (Number(item.age_days) || 0) / 14) : 0;
  return Math.round(
    urgency * CHECK_WEIGHTS.urgency
    + magnitude * CHECK_WEIGHTS.magnitude
    + impact * CHECK_WEIGHTS.impact
    + staleness * CHECK_WEIGHTS.staleness
  );
}

function rankChecks(pending) {
  return pending
    .map((p) => Object.assign({}, p, { score: scoreCheck(p) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.key) < String(b.key) ? -1 : 1; // 同点は安定した順序に
    })
    .slice(0, 3);
}

// =====================================================================
// ハンドラ
// =====================================================================
module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.fail(res, 405, 'method_not_allowed');
  if (!lib.requireAuth(req, res)) return;

  const cfg = lib.sbConfig();
  if (!cfg) return lib.fail(res, 500, 'supabase_env_not_set');

  try {
    const today = lib.todayJST();
    const horizon = lib.addDays(today, HORIZON_DAYS);
    // 区切り表示のため、翌月10日が30日より先でも取得しておく
    const nextTenth = tenthOfNextMonth(today);
    const queryEnd = nextTenth > horizon ? nextTenth : horizon;

    const [accounts, events, settings, tasks] = await Promise.all([
      lib.sbGet(cfg, 'ceo_accounts',
        '?select=id,name,balance,as_of,is_active,sort_order&is_active=eq.true&order=sort_order.asc,name.asc'),
      lib.sbGet(cfg, 'ceo_cash_events',
        '?select=id,direction,label,counterparty,amount,due_date,confidence,status,category,source'
        + '&status=eq.scheduled&due_date=lte.' + encodeURIComponent(queryEnd)
        + '&order=due_date.asc&limit=500'),
      lib.sbGet(cfg, 'ceo_settings', '?select=key,amount,label,note'),
      lib.sbGet(cfg, 'ceo_tasks',
        '?select=id,title,due_date,priority,status,created_at&status=eq.open'
        + '&order=priority.asc,due_date.asc&limit=200')
    ]);

    const result = compute(
      today,
      Array.isArray(accounts) ? accounts : [],
      Array.isArray(events) ? events : [],
      Array.isArray(settings) ? settings : [],
      Array.isArray(tasks) ? tasks : []
    );

    return lib.json(res, 200, Object.assign({ ok: true }, result));
  } catch (err) {
    try {
      console.error('[ceo-dashboard] error:', String((err && err.message) || err).slice(0, 200));
    } catch (_) { /* noop */ }
    return lib.fail(res, 500, 'internal_error');
  }
};

// テスト用に純粋関数を公開する。
// Vercel はデフォルトエクスポート(上の関数)をハンドラとして扱うため、
// プロパティを足してもルーティングには影響しない。
module.exports._compute = compute;
module.exports._helpers = { endOfMonth, tenthOfNextMonth, daysBetween, scoreCheck };
