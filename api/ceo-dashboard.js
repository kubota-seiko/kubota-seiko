// CEO OS ダッシュボードAPI(MONEY + TODAY をまとめて返す)
// ---------------------------------------------------------------------
// GET /api/ceo-dashboard   → 画面に必要な全データを1リクエストで返す
//
// 設計方針:
//   - 計算はすべてサーバー側で完結させ、フロントには計算済みの数値を渡す。
//     (ロジックの二重実装を防ぐ。フロントは表示に徹する)
//   - 日付判定はすべて JST 基準(lib.todayJST)。UTC の new Date() を直接使わない。
//   - 外部APIは叩かない。Supabase の読み取りのみ(4クエリ)。
//   - 金額を含むため cache-control: no-store(lib.json が付与)。
//
// レスポンス整理:
//   GET以外          → 405
//   未ログイン        → 401
//   SUPABASE 未設定   → 500
//   正常             → 200 (下記 JSON)
'use strict';

const lib = require('./_ceo-lib.js');

const HORIZON_DAYS = 30;
const NEAR_DAYS = 7;
const STALE_BALANCE_DAYS = 3; // 残高が何日前なら「古い」と警告するか

// =====================================================================
// 計算ロジック(純粋関数・副作用なし)
// ---------------------------------------------------------------------
// テストしやすいよう I/O から切り離してある。
//
// 【今使えるお金】
//   現預金
//   + 30日以内の確定入金 (confidence='confirmed' のみ)
//   − 30日以内の確定支払い
//   − reserve_amount   (31日以降の支払いのための取り置き)
//   − safety_buffer    (最低安全残高)
//
//   ※ 確度「高」「低」の入金は加算しない。資金繰りの現実性を守るため。
//
//   ※ 期限超過の扱いは入金と支払いで意図的に非対称にしている。
//       - 支払い(out) の期限超過 → 集計に含める。払う義務は消えていないため。
//       - 入金(in)  の期限超過 → 集計に含めない。期日に入らなかった時点で
//         当てにできる金額ではないため。overdue_in として別表示し、
//         TODAY の「入金確認・回収」候補に回す。実際に入金され、口座残高を
//         更新して初めて現預金として扱う。
//
// 【残高予測】
//   今使えるお金とは別の数字。reserve_amount / safety_buffer は引かない。
//   その日に口座にいくら残っている見込みか、という素の額。
// =====================================================================
function compute(today, accounts, events, settings, tasks) {
  const horizon = lib.addDays(today, HORIZON_DAYS);
  const near = lib.addDays(today, NEAR_DAYS);

  // --- 現預金 ---
  let cash = 0;
  let oldestAsOf = null;
  const activeAccounts = [];
  for (const a of accounts) {
    if (a.is_active === false) continue;
    cash += Number(a.balance) || 0;
    if (a.as_of && (oldestAsOf === null || a.as_of < oldestAsOf)) oldestAsOf = a.as_of;
    activeAccounts.push({
      id: a.id,
      name: a.name,
      balance: Number(a.balance) || 0,
      as_of: a.as_of
    });
  }

  // --- 入出金予定(status='scheduled' のみを対象) ---
  let payables30 = 0;          // 30日以内の支払い(期限超過を含む)
  let payables7 = 0;
  let receivables30Confirmed = 0;
  let receivables7Confirmed = 0;
  let receivables30High = 0;   // 参考値。今使えるお金には加算しない
  let overdueOut = 0;
  let overdueIn = 0;           // 期限超過の入金。どの集計にも加算しない

  const collectionCandidates = []; // 期限超過の入金 = 回収アクションが必要なもの
  const dueToday = [];
  const overdue = [];
  const upcomingIn = [];
  const upcomingOut = [];

  for (const e of events) {
    if (e.status !== 'scheduled') continue;
    const amount = Number(e.amount) || 0;
    const due = e.due_date;
    if (!due || due > horizon) continue; // 30日より先は集計対象外

    const isOverdue = due < today;
    const withinNear = due <= near;
    const row = {
      id: e.id,
      direction: e.direction,
      label: e.label,
      counterparty: e.counterparty || null,
      amount: amount,
      due_date: due,
      confidence: e.confidence,
      category: e.category || null,
      overdue: isOverdue
    };

    if (e.direction === 'out') {
      payables30 += amount;
      if (withinNear) payables7 += amount;
      if (isOverdue) overdueOut += amount;
      upcomingOut.push(row);
    } else if (isOverdue) {
      // 期限超過の入金は「まだ入っていないお金」として扱う。
      // 今使えるお金にも残高予測にも一切加算しない(確度を問わない)。
      // 回収アクションが必要なものとして TODAY に回す。
      overdueIn += amount;
      collectionCandidates.push(row);
      upcomingIn.push(row);
    } else {
      if (e.confidence === 'confirmed') {
        receivables30Confirmed += amount;
        if (withinNear) receivables7Confirmed += amount;
      } else if (e.confidence === 'high') {
        receivables30High += amount;
      }
      upcomingIn.push(row);
    }

    // overdue は「支払いの期限超過」だけを入れる。
    // 入金の期限超過は性質が違う(こちらのアクションは督促・回収)ため、
    // collection_candidates に分けて TODAY で別扱いにする。
    if (isOverdue) { if (e.direction === 'out') overdue.push(row); }
    else if (due === today) dueToday.push(row);
  }

  // --- 設定値 ---
  const settingMap = {};
  for (const s of settings) settingMap[s.key] = Number(s.amount) || 0;
  const reserveAmount = settingMap.reserve_amount || 0;
  const safetyBuffer = settingMap.safety_buffer || 0;

  // --- 今使えるお金 ---
  const availableNow =
    cash + receivables30Confirmed - payables30 - reserveAmount - safetyBuffer;

  // --- 残高予測(確保額・安全残高は引かない) ---
  const forecast7 = cash + receivables7Confirmed - payables7;
  const forecast30 = cash + receivables30Confirmed - payables30;
  const forecast30Optimistic = forecast30 + receivables30High;

  // --- 残高の鮮度 ---
  const staleThreshold = lib.addDays(today, -STALE_BALANCE_DAYS);
  const balanceStale = oldestAsOf !== null && oldestAsOf < staleThreshold;

  // --- 今日やること(最大3件) ---
  // 並び順: ①期限超過 → ②今日が期限 → ③それ以外、の順に段階分けし、
  // 同じ段階の中で priority 昇順 → due_date 昇順 → 作成順。
  // 期限超過を priority より優先するのは、既に遅れているものを
  // 「優先度が低いから」という理由で埋もれさせないため。
  const tier = (t) => {
    if (!t.due_date) return 2;
    if (t.due_date < today) return 0;  // 期限超過
    if (t.due_date === today) return 1; // 今日が期限
    return 2;
  };
  const openTasks = tasks.filter((t) => t.status === 'open');
  openTasks.sort((a, b) => {
    const aDue = tier(a);
    const bDue = tier(b);
    if (aDue !== bDue) return aDue - bDue;
    const aP = Number(a.priority) || 3;
    const bP = Number(b.priority) || 3;
    if (aP !== bP) return aP - bP;
    const aD = a.due_date || '9999-12-31';
    const bD = b.due_date || '9999-12-31';
    if (aD !== bD) return aD < bD ? -1 : 1;
    return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
  });

  const byDue = (x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : 0);
  upcomingIn.sort(byDue);
  upcomingOut.sort(byDue);
  overdue.sort(byDue);
  dueToday.sort(byDue);
  // 回収候補は「最も長く遅れているもの」が先頭に来るよう古い順
  collectionCandidates.sort(byDue);

  return {
    as_of: today,
    horizon_date: horizon,
    money: {
      cash: cash,
      balance_as_of_oldest: oldestAsOf,
      balance_stale: balanceStale,
      payables_30d: payables30,
      receivables_30d_confirmed: receivables30Confirmed,
      receivables_30d_high: receivables30High,
      overdue_out: overdueOut,
      // overdue_in はどの集計にも含まれない参考値。
      // 実際に入金され、口座残高を更新して初めて現預金になる。
      overdue_in: overdueIn,
      reserve_amount: reserveAmount,
      safety_buffer: safetyBuffer,
      available_now: availableNow,
      forecast_7d: forecast7,
      forecast_30d: forecast30,
      forecast_30d_optimistic: forecast30Optimistic
    },
    today: {
      date: today,
      due_today: dueToday,
      // 支払いの期限超過のみ(入金は collection_candidates へ)
      overdue: overdue,
      overdue_count: overdue.length,
      // 期限超過の入金 = 「入金確認・回収」の優先タスク候補。
      // 遅れが長いものが先頭。金額は現預金に一切含まれていない。
      collection_candidates: collectionCandidates,
      collection_count: collectionCandidates.length,
      tasks: openTasks.slice(0, 3).map((t) => ({
        id: t.id,
        title: t.title,
        due_date: t.due_date || null,
        priority: Number(t.priority) || 3,
        overdue: !!(t.due_date && t.due_date < today)
      })),
      tasks_total_open: openTasks.length
    },
    lists: {
      accounts: activeAccounts,
      upcoming_in: upcomingIn,
      upcoming_out: upcomingOut
    }
  };
}

// =====================================================================
// ハンドラ
// =====================================================================
module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.fail(res, 405, 'method_not_allowed');
  if (!lib.requireAuth(req, res)) return; // 401/500 は requireAuth が返す

  const cfg = lib.sbConfig();
  if (!cfg) return lib.fail(res, 500, 'supabase_env_not_set');

  try {
    const today = lib.todayJST();
    const horizon = lib.addDays(today, HORIZON_DAYS);

    // 4クエリを並列に投げる(DB読み取りのみ・外部APIなし)
    const [accounts, events, settings, tasks] = await Promise.all([
      lib.sbGet(cfg, 'ceo_accounts',
        '?select=id,name,balance,as_of,is_active,sort_order&is_active=eq.true&order=sort_order.asc,name.asc'),
      // status='scheduled' かつ 30日以内。下限を付けないので期限超過も取得される。
      lib.sbGet(cfg, 'ceo_cash_events',
        '?select=id,direction,label,counterparty,amount,due_date,confidence,status,category'
        + '&status=eq.scheduled&due_date=lte.' + encodeURIComponent(horizon)
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

// テスト用に純粋関数だけ公開する。
// Vercel はモジュールのデフォルトエクスポート(=上の関数)をハンドラとして扱うため、
// プロパティを足してもルーティングには影響しない。
module.exports._compute = compute;
