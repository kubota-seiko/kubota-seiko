// CEO OS 入力エンドポイント(追加・更新・削除・完了トグル)
// ---------------------------------------------------------------------
// POST /api/ceo?fn=entry
//   {
//     "type":   "account" | "cash_event" | "task" | "setting",
//     "action": "create" | "update" | "delete" | "settle" | "unsettle" | "done" | "reopen",
//     "id":     "uuid",     // create 以外で必須(setting は key を使うため不要)
//     "data":   { ... }     // create / update / setting で使用
//   }
//
// 認証必須(署名付きCookie)。金額・日付・区分はすべてサーバー側で検証する。
// クライアントから来た値をそのまま DB に流さない。
//
// レスポンス整理:
//   POST以外                  → 405
//   未ログイン                 → 401
//   type/action が不正         → 400
//   必須項目の欠落・値が不正    → 400 (どの項目かは field で返す)
//   該当IDなし                → 404
//   SUPABASE 未設定            → 500
//   正常                      → 200 { ok:true, row: {...} }
'use strict';

const lib = require('./_ceo-lib.js');

const TYPES = ['account', 'cash_event', 'task', 'setting'];
const ACTIONS = ['create', 'update', 'delete', 'settle', 'unsettle', 'done', 'reopen'];

const DIRECTIONS = ['in', 'out'];
const CONFIDENCES = ['confirmed', 'high', 'low'];
const EVENT_STATUSES = ['scheduled', 'settled', 'cancelled'];
const CATEGORIES = ['card', 'tax', 'loan', 'rent', 'sales', 'subscription', 'other'];
const SETTING_KEYS = ['reserve_amount', 'safety_buffer'];

// --- 各 type のフィールド組み立て -------------------------------------

/** 口座。create では balance/name 必須、update は来た項目だけ更新 */
function buildAccount(data, isCreate) {
  const out = {};
  const name = lib.str(data.name, 60);
  if (name !== null) out.name = name;
  else if (isCreate) return { error: 'name_required', field: 'name' };

  if (data.balance !== undefined) {
    const balance = lib.parseAmount(data.balance);
    if (balance === null) return { error: 'invalid_amount', field: 'balance' };
    out.balance = balance;
  } else if (isCreate) {
    out.balance = 0;
  }

  // as_of は省略時「JSTの今日」。UTC の current_date に任せない。
  if (data.as_of !== undefined) {
    if (!lib.isValidDate(data.as_of)) return { error: 'invalid_date', field: 'as_of' };
    out.as_of = data.as_of;
  } else if (isCreate) {
    out.as_of = lib.todayJST();
  }

  if (data.is_active !== undefined) out.is_active = !!data.is_active;
  if (data.sort_order !== undefined) {
    const n = Number(data.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 999) return { error: 'invalid_sort_order', field: 'sort_order' };
    out.sort_order = n;
  }
  if (data.note !== undefined) out.note = lib.str(data.note, 500);
  return { value: out };
}

/** 入出金予定 */
function buildCashEvent(data, isCreate) {
  const out = {};

  if (data.direction !== undefined || isCreate) {
    const direction = lib.pickEnum(data.direction, DIRECTIONS);
    if (!direction) return { error: 'invalid_direction', field: 'direction' };
    out.direction = direction;
  }

  const label = lib.str(data.label, 120);
  if (label !== null) out.label = label;
  else if (isCreate) return { error: 'label_required', field: 'label' };

  if (data.amount !== undefined || isCreate) {
    const amount = lib.parseAmount(data.amount, { allowZero: false });
    if (amount === null) return { error: 'invalid_amount', field: 'amount' };
    out.amount = amount;
  }

  if (data.due_date !== undefined || isCreate) {
    if (!lib.isValidDate(data.due_date)) return { error: 'invalid_date', field: 'due_date' };
    out.due_date = data.due_date;
  }

  if (data.confidence !== undefined) {
    const confidence = lib.pickEnum(data.confidence, CONFIDENCES);
    if (!confidence) return { error: 'invalid_confidence', field: 'confidence' };
    out.confidence = confidence;
  }

  if (data.status !== undefined) {
    const status = lib.pickEnum(data.status, EVENT_STATUSES);
    if (!status) return { error: 'invalid_status', field: 'status' };
    out.status = status;
  }

  if (data.category !== undefined) {
    if (data.category === null || data.category === '') out.category = null;
    else {
      const category = lib.pickEnum(data.category, CATEGORIES);
      if (!category) return { error: 'invalid_category', field: 'category' };
      out.category = category;
    }
  }

  if (data.counterparty !== undefined) out.counterparty = lib.str(data.counterparty, 120);
  if (data.note !== undefined) out.note = lib.str(data.note, 500);

  // 金額の確からしさ（工程②）。'manual'=確定 / 'estimate'=予測。
  // 詳細は _ceo-lib.js の「金額の確からしさ」を参照。
  if (data.source !== undefined) {
    const source = lib.pickEnum(data.source, lib.AMOUNT_SOURCES);
    if (!source) return { error: 'invalid_source', field: 'source' };
    out.source = source;
  }

  // 支払(out)に「高/低」の確度は存在しない。DB制約より前にAPI側でも強制する。
  // update で direction を変えず confidence だけ 'high' にする経路も塞ぐため、
  // 呼び出し側で既存 direction を解決してから最終確定させる(下の handler 参照)。
  return { value: out };
}

/** タスク */
function buildTask(data, isCreate) {
  const out = {};
  const title = lib.str(data.title, 200);
  if (title !== null) out.title = title;
  else if (isCreate) return { error: 'title_required', field: 'title' };

  if (data.due_date !== undefined) {
    if (data.due_date === null || data.due_date === '') out.due_date = null;
    else if (!lib.isValidDate(data.due_date)) return { error: 'invalid_date', field: 'due_date' };
    else out.due_date = data.due_date;
  }

  if (data.priority !== undefined) {
    const n = Number(data.priority);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: 'invalid_priority', field: 'priority' };
    out.priority = n;
  }

  if (data.status !== undefined) {
    const status = lib.pickEnum(data.status, ['open', 'done', 'dropped']);
    if (!status) return { error: 'invalid_status', field: 'status' };
    out.status = status;
  }

  if (data.linked_cash_event_id !== undefined) {
    if (data.linked_cash_event_id === null || data.linked_cash_event_id === '') {
      out.linked_cash_event_id = null;
    } else if (!lib.isUuid(data.linked_cash_event_id)) {
      return { error: 'invalid_id', field: 'linked_cash_event_id' };
    } else {
      out.linked_cash_event_id = data.linked_cash_event_id;
    }
  }

  if (data.note !== undefined) out.note = lib.str(data.note, 500);
  return { value: out };
}

// --- ハンドラ ---------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.fail(res, 405, 'method_not_allowed');
  if (!lib.requireAuth(req, res)) return; // 401/500 は requireAuth が返す

  const cfg = lib.sbConfig();
  if (!cfg) return lib.fail(res, 500, 'supabase_env_not_set');

  try {
    const body = await lib.readJson(req);
    const type = lib.pickEnum(body.type, TYPES);
    const action = lib.pickEnum(body.action, ACTIONS);
    if (!type) return lib.fail(res, 400, 'invalid_type');
    if (!action) return lib.fail(res, 400, 'invalid_action');

    const data = (body.data && typeof body.data === 'object') ? body.data : {};
    const today = lib.todayJST();

    // ================= setting =================
    // key-value。upsert 相当(初期2行は migration で作成済みなので UPDATE)。
    if (type === 'setting') {
      const key = lib.pickEnum(data.key || body.id, SETTING_KEYS);
      if (!key) return lib.fail(res, 400, 'invalid_setting_key');
      const amount = lib.parseAmount(data.amount);
      if (amount === null) return lib.json(res, 400, { ok: false, error: 'invalid_amount', field: 'amount' });

      const patch = { amount };
      if (data.note !== undefined) patch.note = lib.str(data.note, 500);

      const rows = await lib.sbPatch(cfg, 'ceo_settings', '?key=eq.' + encodeURIComponent(key), patch);
      if (!Array.isArray(rows) || rows.length === 0) {
        // migration が未適用など、行が無いケース。作って返す。
        const created = await lib.sbInsert(cfg, 'ceo_settings', Object.assign({ key }, patch));
        return lib.json(res, 200, { ok: true, row: (created && created[0]) || null });
      }
      return lib.json(res, 200, { ok: true, row: rows[0] });
    }

    const table = type === 'account' ? 'ceo_accounts'
      : type === 'cash_event' ? 'ceo_cash_events'
        : 'ceo_tasks';

    // ================= create =================
    if (action === 'create') {
      let built;
      if (type === 'account') built = buildAccount(data, true);
      else if (type === 'cash_event') built = buildCashEvent(data, true);
      else built = buildTask(data, true);
      if (built.error) return lib.json(res, 400, { ok: false, error: built.error, field: built.field });

      // 支払(out)は確度を必ず confirmed に固定する
      if (type === 'cash_event' && built.value.direction === 'out') {
        built.value.confidence = 'confirmed';
      }

      const rows = await lib.sbInsert(cfg, table, built.value);
      return lib.json(res, 200, { ok: true, row: (rows && rows[0]) || null });
    }

    // ここから先は id 必須
    if (!lib.isUuid(body.id)) return lib.fail(res, 400, 'invalid_id');
    const idQuery = '?id=eq.' + encodeURIComponent(body.id);

    // ================= delete =================
    if (action === 'delete') {
      const rows = await lib.sbDelete(cfg, table, idQuery);
      if (!Array.isArray(rows) || rows.length === 0) return lib.fail(res, 404, 'not_found');
      return lib.json(res, 200, { ok: true, row: rows[0] });
    }

    // ============ settle / unsettle (cash_event 専用) ============
    // 画面から最も頻繁に叩かれるワンタップ操作。data 不要。
    if (action === 'settle' || action === 'unsettle') {
      if (type !== 'cash_event') return lib.fail(res, 400, 'action_not_allowed_for_type');
      const patch = action === 'settle'
        ? { status: 'settled', settled_at: lib.isValidDate(data.settled_at) ? data.settled_at : today }
        : { status: 'scheduled', settled_at: null };
      const rows = await lib.sbPatch(cfg, table, idQuery, patch);
      if (!Array.isArray(rows) || rows.length === 0) return lib.fail(res, 404, 'not_found');
      return lib.json(res, 200, { ok: true, row: rows[0] });
    }

    // ============ done / reopen (task 専用) ============
    if (action === 'done' || action === 'reopen') {
      if (type !== 'task') return lib.fail(res, 400, 'action_not_allowed_for_type');
      const patch = action === 'done'
        ? { status: 'done', done_at: today }
        : { status: 'open', done_at: null };
      const rows = await lib.sbPatch(cfg, table, idQuery, patch);
      if (!Array.isArray(rows) || rows.length === 0) return lib.fail(res, 404, 'not_found');
      return lib.json(res, 200, { ok: true, row: rows[0] });
    }

    // ================= update =================
    let built;
    if (type === 'account') built = buildAccount(data, false);
    else if (type === 'cash_event') built = buildCashEvent(data, false);
    else built = buildTask(data, false);
    if (built.error) return lib.json(res, 400, { ok: false, error: built.error, field: built.field });
    if (Object.keys(built.value).length === 0) return lib.fail(res, 400, 'no_fields_to_update');

    // 支払(out)に確度が付かないよう、既存行の direction も見て最終確定する。
    // (direction を送らず confidence だけ 'high' にする更新を塞ぐ)
    if (type === 'cash_event') {
      let direction = built.value.direction;
      if (!direction) {
        const current = await lib.sbGet(cfg, table, idQuery + '&select=direction&limit=1');
        direction = Array.isArray(current) && current[0] ? current[0].direction : null;
        if (!direction) return lib.fail(res, 404, 'not_found');
      }
      if (direction === 'out') built.value.confidence = 'confirmed';
    }

    const rows = await lib.sbPatch(cfg, table, idQuery, built.value);
    if (!Array.isArray(rows) || rows.length === 0) return lib.fail(res, 404, 'not_found');
    return lib.json(res, 200, { ok: true, row: rows[0] });
  } catch (err) {
    // 秘密値・接続情報を含まない安全なログのみ
    try {
      console.error('[ceo-entry] error:', String((err && err.message) || err).slice(0, 200));
    } catch (_) { /* noop */ }
    return lib.fail(res, 500, 'internal_error');
  }
};
