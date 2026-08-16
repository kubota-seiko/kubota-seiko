-- =====================================================================
-- 即日LP AI — 工程① 最小スキーマ (Supabase / PostgreSQL)
-- =====================================================================
-- 目的:
--   「URL入力 → HP診断 → DB保存 → LP JSON生成 → LP表示 →
--    PayPal決済 → 公開」の縦一本を将来通すための、最小限の
--   データ保存基盤。今回(工程①)は "テーブル + FK + RLS + index" のみ。
--   保存処理・API・アプリコードは含まない(工程②以降)。
--
-- 設計方針:
--   - 主キーは UUID (gen_random_uuid)。
--   - 監査用に created_at / updated_at を全テーブルに付与し、
--     updated_at はトリガで自動更新。
--   - 参照整合性は Foreign Key で担保。削除挙動は安全優先で
--     すべて ON DELETE RESTRICT (親を消す前に子の存在を検知して
--     ブロック)。不用意な CASCADE DELETE による重要データ(診断/
--     決済)喪失を防ぐ。
--   - RLS を全テーブルで有効化し、Policy は「作らない」。
--     Supabase の service_role キーは RLS をバイパスするため、
--     サーバー側 service_role からのみ全操作が可能。anon /
--     authenticated は Policy 不在 = 既定拒否で読み書き不可。
--   - 再実行可能(idempotent): create ... if not exists /
--     create or replace / drop trigger if exists を使用。
--
-- 適用方法(どちらでも可):
--   A) Supabase CLI:      supabase db push
--   B) Dashboard:         SQL Editor にこのファイル全文を貼り付けて実行
-- =====================================================================

-- UUID 生成関数 gen_random_uuid() を保証(Supabase では既定で利用可能)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 共通: updated_at 自動更新トリガ関数
-- ---------------------------------------------------------------------
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
-- 1) sessions — 流入セッション(UTM 等)。全ての起点。
-- =====================================================================
create table if not exists public.sessions (
  id         uuid primary key default gen_random_uuid(),
  source     text,
  medium     text,
  campaign   text,
  content    text,
  term       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- 2) diagnoses — HP 診断結果(JSON)。※工程①では保存処理は作らない。
-- =====================================================================
create table if not exists public.diagnoses (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.sessions (id) on delete restrict,
  source_url     text,
  diagnosis_json jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- =====================================================================
-- 3) tally_responses — Tally フォーム回答(JSON)。※Webhook 接続は後工程。
-- =====================================================================
create table if not exists public.tally_responses (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.sessions (id) on delete restrict,
  response_json jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- =====================================================================
-- 4) lps — 生成 LP(JSON)。status で draft/preview/paid/published を扱う。
--    ※LP 生成機能は作らない。
-- =====================================================================
create table if not exists public.lps (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete restrict,
  slug       text unique,
  lp_json    jsonb,
  status     text not null default 'draft'
             check (status in ('draft', 'preview', 'paid', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- 5) payments — 決済記録。※PayPal 処理は変更しない(記録先だけ用意)。
--    provider_payment_id は provider 単位で一意(Webhook 重複挿入防止)。
-- =====================================================================
create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.sessions (id) on delete restrict,
  lp_id               uuid references public.lps (id) on delete restrict,
  provider            text,
  provider_payment_id text,
  amount              numeric(12, 2),
  currency            text not null default 'JPY',
  status              text not null default 'pending',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- =====================================================================
-- 6) proof_assets — 実績/推薦/事例の共有ライブラリ(セッション非依存)。
--    ※登録画面・AI 連携は作らない。
-- =====================================================================
create table if not exists public.proof_assets (
  id           uuid primary key default gen_random_uuid(),
  type         text,  -- 例: testimonial / case_study / achievement
  name         text,
  company_name text,
  role         text,
  industry     text,
  quote        text,
  content      text,
  source_url   text,
  asset_url    text,
  is_public    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- インデックス(最低限)
-- ---------------------------------------------------------------------
create index if not exists idx_diagnoses_session_id       on public.diagnoses (session_id);
create index if not exists idx_tally_responses_session_id on public.tally_responses (session_id);
create index if not exists idx_lps_session_id             on public.lps (session_id);
-- lps.slug は列制約 unique により自動で索引化される
create index if not exists idx_payments_session_id        on public.payments (session_id);
create index if not exists idx_payments_lp_id             on public.payments (lp_id);
create index if not exists idx_proof_assets_type          on public.proof_assets (type);

-- provider + provider_payment_id の一意性(値がある行のみ)。決済 Webhook の
-- 二重挿入を防ぐ冪等キー。
create unique index if not exists uq_payments_provider_payment
  on public.payments (provider, provider_payment_id)
  where provider_payment_id is not null;

-- ---------------------------------------------------------------------
-- updated_at 自動更新トリガ(各テーブル)
-- ---------------------------------------------------------------------
drop trigger if exists trg_sessions_updated_at        on public.sessions;
create trigger trg_sessions_updated_at        before update on public.sessions        for each row execute function public.set_updated_at();

drop trigger if exists trg_diagnoses_updated_at       on public.diagnoses;
create trigger trg_diagnoses_updated_at       before update on public.diagnoses       for each row execute function public.set_updated_at();

drop trigger if exists trg_tally_responses_updated_at on public.tally_responses;
create trigger trg_tally_responses_updated_at before update on public.tally_responses for each row execute function public.set_updated_at();

drop trigger if exists trg_lps_updated_at             on public.lps;
create trigger trg_lps_updated_at             before update on public.lps             for each row execute function public.set_updated_at();

drop trigger if exists trg_payments_updated_at        on public.payments;
create trigger trg_payments_updated_at        before update on public.payments        for each row execute function public.set_updated_at();

drop trigger if exists trg_proof_assets_updated_at    on public.proof_assets;
create trigger trg_proof_assets_updated_at    before update on public.proof_assets    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS — 全テーブルで有効化。Policy は作らない = anon/authenticated は
-- 既定拒否。service_role キー(サーバー側)は RLS をバイパスして全操作可。
-- ---------------------------------------------------------------------
alter table public.sessions        enable row level security;
alter table public.diagnoses       enable row level security;
alter table public.tally_responses enable row level security;
alter table public.lps             enable row level security;
alter table public.payments        enable row level security;
alter table public.proof_assets    enable row level security;

-- (意図的に Policy を定義しない。将来 anon に公開が必要な範囲が固まった
--  段階で、最小権限の Policy を個別に追加する。)
