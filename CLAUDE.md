# RSS Summary - Claude Code プロジェクト指示

## プロジェクト概要

**RSS Summary** は、指定したRSSフィードから毎朝情報を取得し、AIがニュースレター風にまとめた「今日のダイジェスト」を静的サイトとして配信するサービスです。

---

## プロジェクト構造

pnpm workspaceモノレポ。

```
rss-summary/
├── apps/
│   ├── backend/                 # Workers Builds のビルドステップで実行する生成処理
│   │   ├── src/
│   │   │   ├── index.ts            # メインオーケストレーター
│   │   │   ├── config/feeds.ts     # RSSフィード定義・カテゴリ分類
│   │   │   ├── fetch/               # フィード取得・パース(RSS1.0/2.0/Atom正規化)
│   │   │   ├── state/read-state.ts # 既読GUID管理(R2オブジェクト `state/read-guids.json` の読み書き)
│   │   │   ├── ai/gemini-client.ts # Geminiプロンプト構築・API呼び出し
│   │   │   ├── digest/digest-payload.ts # R2保存用JSONペイロード構築
│   │   │   ├── publish/r2-client.ts # R2の署名付き読み書き(ダイジェスト・既読state)
│   │   │   └── utils/retry.ts        # 共通リトライユーティリティ
│   │   └── test/fixtures/            # RSS1.0/2.0/Atomのサンプルフィード
│   └── frontend/                # Astro(SSG、Workers Static Assets)
│       ├── src/
│       │   ├── content.config.ts       # digestsコレクション定義
│       │   ├── lib/digests-loader.ts   # R2からのビルド時データ取得(Content Layer API)
│       │   ├── pages/                  # トップ・アーカイブ一覧・個別ページ
│       │   ├── components/DigestBody.astro
│       │   └── layouts/BaseLayout.astro
│       ├── worker/                     # Cloudflare Worker(スケジュール実行・API/認証)
│       │   ├── index.ts                # scheduled()ハンドラ(Deploy Hook起動cron + R2欠損ウォッチドッグcron) + fetch()ルーター
│       │   ├── db/                     # D1(users/sessions/preferences/bookmarks/read-state)アクセス層
│       │   │   ├── schema.ts           # Drizzle ORMのテーブル定義(正はこちら。生SQLは廃止)
│       │   │   ├── users.ts、sessions.ts、preferences.ts、bookmarks.ts、read-state.ts
│       │   │   └── 各モジュールはDrizzle経由でD1にアクセスし、テスト込み
│       │   ├── auth/                   # Google OAuth認証(oauth4webapi利用)
│       │   │   ├── google-oauth.ts     # token交換・session作成・logout処理
│       │   │   └── google-oauth.test.ts
│       │   ├── api/                    # Honoベースのエンドポイント(/api/*)
│       │   │   ├── router.ts           # ルーティング(Hono。各handlerはFramework非依存のRequest/D1Database受け取り)
│       │   │   ├── auth-handlers.ts    # POST /api/auth/login/callback、/api/auth/logout
│       │   │   ├── preferences-handlers.ts # GET/PUT /api/preferences
│       │   │   ├── bookmarks-handlers.ts # GET/POST/DELETE /api/bookmarks(/:id)
│       │   │   ├── read-state-handlers.ts # GET/POST /api/read-state
│       │   │   └── 各ファイルはテスト込み
│       │   ├── digest-fresh.ts、retry.ts # ユーティリティ(ダイジェスト鮮度判定・リトライ)
│       │   └── tsconfig.json            # `**/*.ts`で配下全ファイルをカバー
│       ├── drizzle.config.ts           # drizzle-kit generate用設定(マイグレーション生成のみ。Cloudflare認証情報は持たない)
│       ├── migrations/                 # drizzle-kit generateが生成するマイグレーション(手書きしない)
│       └── wrangler.jsonc              # main=worker/index.ts、triggers.crons 2本(23:30 / 02:00 UTC)、D1バインディング(migrations_dir設定込み)
├── packages/
│   └── shared/               # apps/backend・apps/frontend共通のユーティリティ(@rss-summary/shared)
├── spec.md                   # 実装仕様書(要件・設計判断の正)
└── docs/                     # 技術ドキュメント
```

> **配信について**: フロントWorker(Workers Static Assets)に同居する`scheduled()`ハンドラが、毎朝のcron(`30 23 * * *` UTC)でDeploy HookをPOSTしてWorkers Buildsのビルドを起動します。Workers Buildsは1回のビルドで backend の生成処理(RSSフィード取得 → 既読GUIDと突き合わせ → Gemini要約 → R2へ`{date}.json`と`state/read-guids.json`を書き込み)→ Astro ビルド → `wrangler deploy` を実行します。HTML変換はAstroのビルド時に行います。もう1本のcron(`0 2 * * *` UTC)がウォッチドッグで、当日分の生成結果がR2にあるか確認し、欠損していればDiscord/SlackのWebhookへ通知します。既読GUIDの状態はR2オブジェクト`state/read-guids.json`に保存し、実行のたびに上書きします
>
> **API・認証について**: `/api/*`エンドポイントはHonoをルーティングフレームワークとして採用しており、エンドポイント数増加に対応しています。各APIハンドラー(`auth-handlers`・`preferences-handlers`・`bookmarks-handlers`・`read-state-handlers`)は設計上Honoフレームワークに依存しておらず、素の`Request`・`D1Database`のみを受け取り、純粋な処理ロジックとして実装されています。D1バインディング(`env.DB`、データベース名`tech-morning-digest-users`)を使用してセッション・ユーザー・ブックマーク・興味カテゴリ設定・個人既読状態を管理しています。

> **⚠️ デプロイ後のsecrets確認(重要)**: `apps/frontend`のWorker(`tech-morning-digest`)は、`wrangler.jsonc`に宣言していないsecrets(`DEPLOY_HOOK_URL` / `ALERT_WEBHOOK_URL` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)をCloudflareダッシュボード側で個別管理している(非機微な`CLOUDFLARE_ACCOUNT_ID`・`R2_BUCKET_NAME`のみ`wrangler.jsonc`の`vars`に宣言済み)。過去にこの4件(現在は6件)が消失し、毎晩のcronとwatchdogアラートの両方が無言で機能停止する障害が発生した(2026-09-13〜09-16、原因未特定)。**mainへのマージ・デプロイを伴う変更の後は、`GET /accounts/{account_id}/workers/scripts/tech-morning-digest/settings`の`bindings`に`ASSETS`以外の6件(secret_text型)が揃っているか確認すること。**欠けていれば`.envrc`の値で`wrangler secret put <NAME>`(またはBulk API `PATCH .../secrets-bulk`)で再投入し、必要なら手動でDeploy Hookを一度叩いて当日分の生成が通ることを確認する。

> **⚠️ 本番D1へのスキーマ適用(重要)**: `apps/frontend/wrangler.jsonc`の`d1_databases[0].database_id`は現在プレースホルダー(`REPLACE_WITH_REAL_DATABASE_ID`)。実際に`wrangler d1 create`でD1データベースを作成し`database_id`を実値に差し替えたら、`apps/frontend`ディレクトリで`npx wrangler d1 migrations apply tech-morning-digest-users --remote`を実行し、`migrations/`配下のマイグレーションを本番(リモート)D1に適用すること(`--local`版はローカル開発用でありリモートには反映されない)。スキーマの正は`worker/db/schema.ts`(Drizzle ORM)であり、変更時は生SQLを手で書かず`npx drizzle-kit generate`でマイグレーションを再生成してからコミットする(生SQLの`schema.sql`は廃止済み)。**この適用を忘れると`/api/*`の全ルートがD1クエリで500になるだけでなく、マストヘッドのログイン状態チェック(`BaseLayout.astro`)がその500を「ログイン中」と誤判定するリスクも残る(`response.ok`判定への修正で500は「未ログイン」表示に倒すようにはしたが、根本的にはスキーマを適用しないとAPIが機能しない)。**

---

## 開発環境・ツール

- **パッケージマネージャー**: pnpm(workspace構成。`apps/backend`・`apps/frontend`・`packages/shared`)
- **ランタイム**: 生成処理(バックエンド)はWorkers Builds のビルドコマンド内(Node.js)で実行し、フロントエンドはAstro(SSG)をビルドしてCloudflare Workers Static Assetsで配信。定期実行はフロントWorkerに同居する`scheduled()`ハンドラ(Cron Triggers)。CloudflareはR2(生成物・既読state保存)・Workers Builds(生成+ビルド)・Workers Static Assets(静的配信)・Cron Triggersを利用(WorkersランタイムのFreeプランCPU時間制限を避けるため、生成処理はビルド環境側で実行する。spec.md 0章)
- **言語**: TypeScript(`apps/frontend`のみ`astro check`の制約でTypeScript 6.0.3に固定。理由はdocs/AI-CONTEXT.md参照)

---

## コーディング規約

### TypeScript
- **型定義**: `any` を使用しない。すべての型を明示的に定義
- **型推論**: 可能な限り型推論を活用
- **null/undefined**: 明示的に型定義（`string | null`）

---

## 参考ドキュメント

- **[AI-CONTEXT.md](docs/AI-CONTEXT.md)** - 詳細な技術ドキュメント（型定義、パターン集、依存関係）
- **[README.md](docs/README.md)** - プロジェクト全体の説明

---

## 制約事項

- 日本語・簡潔に回答する
- 不確かな情報は断言せず公式ドキュメントを参照する
- 公式ドキュメントを参照するMCPがある場合検索やfetchより優先する
- 不明点や代替案実行前に必ずユーザーに確認する
- ユーザー化えらの質問には回答の見返し、実装は行わない
- 実装を行う際は必ず計画を立ててユーザーの承認を得る
- コマンド実行時はheredoc等を使用せず、/tmpにシェルを作成して実行する
- CLIから実行するget系コマンドは長文が予想される場合/tmpに一時ファイルを出し必要な情報のみ抽出する
- コンテキスト削減のためエージェントは積極的に活用する
- コミットメッセージは必ず日本語のConventional Commits形式にする

- Do not write chain-of-thought, internal reasoning, deliberation, or self-critique into source code comments.
- Do not leave exploratory notes, abandoned alternatives, or step-by-step thought process in code.
- Write comments only when they explain:
  - non-obvious constraints,
  - security or correctness invariants,
  - interoperability requirements,
  - reasons a simpler implementation is intentionally not used.
- Prefer clear naming, smaller functions, and tests over explanatory comments.

---

# 実装を終えたら必ずドキュメントの更新を行ってください
