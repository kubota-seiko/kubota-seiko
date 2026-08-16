# Supabase — 即日LP AI データ基盤（工程①）

将来「URL入力 → HP診断 → DB保存 → LP JSON生成 → LP表示 → PayPal決済 → 公開」
の縦一本を通すための、最小限のデータ保存基盤です。**工程①では DB のスキーマ
（テーブル / FK / RLS / index）のみ**を用意します。保存処理・API・アプリ
コードは含みません（工程②以降）。

このディレクトリは既存サイト（静的HTML + Vercel Serverless Functions）には
一切読み込まれません。Supabase 接続情報が未設定でも、既存HP・既存診断は
これまで通り動作します。

## ファイル

- `migrations/20260816000001_init_lp_ai_schema.sql`
  6テーブル（sessions / diagnoses / tally_responses / lps / payments /
  proof_assets）+ FK + RLS + index + updated_at トリガ。再実行可能。

## テーブル一覧

| テーブル | 役割 |
| --- | --- |
| `sessions` | 流入セッション（UTM 等）。全ての起点。 |
| `diagnoses` | HP 診断結果（`diagnosis_json`）。※保存処理は工程②。 |
| `tally_responses` | Tally フォーム回答（`response_json`）。※Webhook は後工程。 |
| `lps` | 生成 LP（`lp_json`）。`status` = draft/preview/paid/published。 |
| `payments` | 決済記録。`provider` + `provider_payment_id` は一意。 |
| `proof_assets` | 実績/推薦/事例の共有ライブラリ（セッション非依存）。 |

## 適用方法（どちらか）

**A) Supabase Dashboard（手作業だが確実）**
1. 対象プロジェクトの **SQL Editor** を開く
2. `migrations/20260816000001_init_lp_ai_schema.sql` の全文を貼り付けて実行

**B) Supabase CLI（再現可能・推奨）**
```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

いずれも冪等（再実行しても壊れない）設計です。

## 必要な環境変数（名前のみ / 値はここに書かない）

秘密値は **Vercel のダッシュボード**（＝本プロジェクト既存の環境変数管理方法）
に設定します。`.env` ファイルはリポジトリに置きません。

| 変数名 | 用途 | 公開可否 |
| --- | --- | --- |
| `SUPABASE_URL` | プロジェクト URL | サーバー用（工程②以降で使用） |
| `SUPABASE_ANON_KEY` | 公開鍵（RLS 前提） | 必要になるまで未使用 |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー専用の管理鍵。**RLS をバイパス**。ブラウザに絶対露出させない。 | 秘密 |

> 工程①ではアプリ側でこれらを読み込むコードは追加していません。実際に使うのは
> 工程②（`shindan.js` への session_id 発行＋診断保存）からです。

## RLS（アクセス制御）

- 全 6 テーブルで **RLS を有効化**。
- **Policy は意図的に作成しない** → `anon` / `authenticated` は既定拒否で
  読み書き不可。
- `service_role` キーは RLS をバイパスするため、サーバー側からのみ全操作が可能。

将来 `anon` に公開が必要な範囲が固まった段階で、最小権限の Policy を個別追加
します。

## 適用後の確認（例）

Supabase Dashboard の SQL Editor で:

```sql
-- 6テーブルが存在するか
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;

-- RLS が全テーブルで有効か（rowsecurity が全て true）
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('sessions','diagnoses','tally_responses','lps','payments','proof_assets');

-- Foreign Key の確認
select conname, conrelid::regclass as child, confrelid::regclass as parent
from pg_constraint
where contype = 'f' and connamespace = 'public'::regnamespace
order by child;
```
