-- =====================================================================
-- CEO OS — 工程① 最小スキーマ (Supabase / PostgreSQL)
-- =====================================================================
-- 目的:
--   「ログイン → 現預金を入力 → 支払予定を入力 → 確保額/安全残高を設定
--    → 今使えるお金が見える」を成立させるための最小限のデータ基盤。
--
-- 設計方針(既存 20260816000001_init_lp_ai_schema.sql と完全に統一):
--   - 主キーは UUID (gen_random_uuid)。
--   - 全テーブルに created_at / updated_at を付与し、updated_at は
--     既存の public.set_updated_at() トリガ関数で自動更新。
--     ※ 同関数は init_lp_ai_schema.sql で作成済み。本ファイルでも
--       create or replace で冪等に再定義する(適用順に依存しないため)。
--   - RLS を全テーブルで有効化し、Policy は「作らない」。
--     service_role キー(サーバー側)のみが RLS をバイパスして全操作可能。
--     anon / authenticated は Policy 不在 = 既定拒否で読み書き不可。
--   - 再実行可能(idempotent)。
--
-- 既存テーブル(sessions/diagnoses/tally_responses/lps/payments/
-- proof_assets)には一切変更を加えない。追加のみ。
--
-- 適用方法(どちらでも可):
--   A) Supabase Dashboard: SQL Editor にこのファイル全文を貼って実行
--   B) Supabase CLI:       supabase db push
-- =====================================================================

create extension if not exists pgcrypto;

-- 既存と同じトリガ関数(冪等・適用順に依存しないよう再定義)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- 1) ceo_accounts — 現預金(口座ごとに1行・上書き更新)
-- =====================================================================
-- 「現預金」= sum(balance) where is_active。
-- 履歴は持たない(MVPでは残高推移を作らないため)。必要になったら
-- ceo_balance_log を別途追加する(本テーブルに影響しない)。
create table if not exists public.ceo_accounts (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,                 -- '事業用' / '個人用' / '現金'
  balance    numeric(12, 0) not null default 0,
  as_of      date        not null default current_date,  -- いつ時点の残高か
  is_active  boolean     not null default true,
  sort_order integer     not null default 0,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 同名口座の重複登録を防ぐ
create unique index if not exists uq_ceo_accounts_name on public.ceo_accounts (name);
create index if not exists idx_ceo_accounts_active on public.ceo_accounts (is_active, sort_order);

-- =====================================================================
-- 2) ceo_cash_events — 入金予定 / 支払予定(in / out を1テーブルで管理)
-- =====================================================================
-- amount は常に正の数。符号は direction で表す(集計時の符号ミスを防ぐ)。
--
-- 【二重計上を防ぐ運用ルール】
--   - 30日以内に払う税金・返済・その他支払い → 本テーブルに out で登録
--   - 31日以降の支払いのために今から取り置く分 → ceo_settings.reserve_amount
--   両方に入れないこと。
create table if not exists public.ceo_cash_events (
  id           uuid primary key default gen_random_uuid(),
  direction    text not null check (direction in ('in', 'out')),
  label        text not null,                       -- '○○様 スポット相談' / '家賃'
  counterparty text,                                -- 入金元 / 支払先
  amount       numeric(12, 0) not null check (amount > 0),
  due_date     date not null,                       -- 入金予定日 / 支払期限
  -- 確度。direction='out' は常に 'confirmed'(API側でも強制上書きする)。
  confidence   text not null default 'confirmed'
               check (confidence in ('confirmed', 'high', 'low')),
  -- settled = 入金済み / 支払済み
  status       text not null default 'scheduled'
               check (status in ('scheduled', 'settled', 'cancelled')),
  category     text,                                -- 'card'/'tax'/'loan'/'rent'/'sales'/'other'
  settled_at   date,                                -- 実際に着金/支払った日
  note         text,                                -- カード未確定分の内訳メモ等
  source       text not null default 'manual',      -- 'manual' / 将来 'misoca' / 'paypal'
  external_id  text,                                -- Misoca invoice id 等
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- direction='out' に 'high'/'low' が入るのをDB側でも防ぐ
  constraint ck_ceo_cash_events_out_confirmed
    check (direction <> 'out' or confidence = 'confirmed')
);

create index if not exists idx_ceo_cash_events_status_due
  on public.ceo_cash_events (status, due_date);
create index if not exists idx_ceo_cash_events_dir_status_due
  on public.ceo_cash_events (direction, status, due_date);

-- 将来の自動同期(Misoca/PayPal)の冪等キー。既存 payments と同じ設計。
create unique index if not exists uq_ceo_cash_events_source_external
  on public.ceo_cash_events (source, external_id)
  where external_id is not null;

-- =====================================================================
-- 3) ceo_settings — 確保額 / 最低安全残高(key-value)
-- =====================================================================
-- 新しい確保項目が増えてもマイグレーション不要にするため key-value 形式。
create table if not exists public.ceo_settings (
  key        text primary key,
  amount     numeric(12, 0) not null default 0,
  label      text,
  note       text,                                  -- 根拠メモ('住民税 第2期 10月末' 等)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 初期値(既に存在すれば何もしない)
insert into public.ceo_settings (key, amount, label, note) values
  ('reserve_amount', 0, '税金・返済などの確保額', '31日以降に払う分のために今から取り置く金額。30日以内の支払いは ceo_cash_events に入れること(二重計上防止)'),
  ('safety_buffer',  0, '最低安全残高',           'これ以上は減らしたくない下限額')
on conflict (key) do nothing;

-- =====================================================================
-- 4) ceo_tasks — 今日やること
-- =====================================================================
create table if not exists public.ceo_tasks (
  id                   uuid primary key default gen_random_uuid(),
  title                text not null,
  due_date             date,
  priority             integer not null default 3 check (priority between 1 and 5), -- 1が最優先
  status               text not null default 'open'
                       check (status in ('open', 'done', 'dropped')),
  linked_cash_event_id uuid references public.ceo_cash_events (id) on delete set null,
  done_at              date,
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_ceo_tasks_open
  on public.ceo_tasks (status, priority, due_date);
create index if not exists idx_ceo_tasks_linked
  on public.ceo_tasks (linked_cash_event_id);

-- ---------------------------------------------------------------------
-- updated_at 自動更新トリガ
-- ---------------------------------------------------------------------
drop trigger if exists trg_ceo_accounts_updated_at on public.ceo_accounts;
create trigger trg_ceo_accounts_updated_at
  before update on public.ceo_accounts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_ceo_cash_events_updated_at on public.ceo_cash_events;
create trigger trg_ceo_cash_events_updated_at
  before update on public.ceo_cash_events
  for each row execute function public.set_updated_at();

drop trigger if exists trg_ceo_settings_updated_at on public.ceo_settings;
create trigger trg_ceo_settings_updated_at
  before update on public.ceo_settings
  for each row execute function public.set_updated_at();

drop trigger if exists trg_ceo_tasks_updated_at on public.ceo_tasks;
create trigger trg_ceo_tasks_updated_at
  before update on public.ceo_tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS — 全テーブルで有効化。Policy は作らない = anon/authenticated 既定拒否。
-- service_role キー(サーバー専用)のみ全操作可。
-- ---------------------------------------------------------------------
alter table public.ceo_accounts    enable row level security;
alter table public.ceo_cash_events enable row level security;
alter table public.ceo_settings    enable row level security;
alter table public.ceo_tasks       enable row level security;

-- (意図的に Policy を定義しない。CEO OS はサーバー側 service_role 経由でのみ
--  アクセスする設計のため、ブラウザから直接 Supabase を叩くことはない。)

-- =====================================================================
-- 適用後の確認(SQL Editor で実行)
-- =====================================================================
-- -- 4テーブルが存在するか
-- select table_name from information_schema.tables
-- where table_schema = 'public' and table_name like 'ceo\_%'
-- order by table_name;
--
-- -- RLS が全て有効か(rowsecurity が全て true)
-- select relname, relrowsecurity from pg_class
-- where relnamespace = 'public'::regnamespace
--   and relname in ('ceo_accounts','ceo_cash_events','ceo_settings','ceo_tasks');
--
-- -- 初期設定2行が入っているか
-- select key, amount, label from public.ceo_settings order by key;
