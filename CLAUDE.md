# RSS Summary - Claude Code プロジェクト指示

## プロジェクト概要

**RSS Summary** は、指定したRSSフィードから毎朝情報を取得し、AIがニュースレター風にまとめた「今日のダイジェスト」を静的サイトとして配信するサービスです。

---

## プロジェクト構造

pnpm workspaceモノレポ。

```
rss-summary/
├── apps/
│   ├── backend/                 # GitHub Actions生成処理
│   │   ├── .github/... (実体はリポジトリ直下の.github/workflows/backend-daily-digest.yml)
│   │   ├── src/
│   │   │   ├── index.ts            # メインオーケストレーター
│   │   │   ├── config/feeds.ts     # RSSフィード定義・カテゴリ分類
│   │   │   ├── fetch/               # フィード取得・パース(RSS1.0/2.0/Atom正規化)
│   │   │   ├── state/read-state.ts # 既読GUID管理(stateブランチへのgit読み書き)
│   │   │   ├── ai/gemini-client.ts # Geminiプロンプト構築・API呼び出し
│   │   │   ├── digest/digest-payload.ts # R2保存用JSONペイロード構築
│   │   │   ├── publish/             # R2アップロード・Deploy Hook呼び出し
│   │   │   └── utils/retry.ts        # 共通リトライユーティリティ
│   │   └── test/fixtures/            # RSS1.0/2.0/Atomのサンプルフィード
│   └── frontend/                # Astro(SSG、Workers Static Assets)
│       ├── src/
│       │   ├── content.config.ts       # digestsコレクション定義
│       │   ├── lib/digests-loader.ts   # R2からのビルド時データ取得(Content Layer API)
│       │   ├── pages/                  # トップ・アーカイブ一覧・個別ページ
│       │   ├── components/DigestBody.astro
│       │   └── layouts/BaseLayout.astro
│       └── wrangler.jsonc
├── packages/
│   └── shared/               # apps/backend・apps/frontend共通のユーティリティ(@rss-summary/shared)
├── .github/workflows/backend-daily-digest.yml  # 毎朝の生成処理をスケジュール実行
├── spec.md                   # 実装仕様書(要件・設計判断の正)
└── docs/                     # 技術ドキュメント
```

> **配信について**: GitHub Actionsが生成処理を実行し、R2へJSON({date, generatedAt, hasNewArticles, markdown})を書き込んだ後、フロントエンド(Workers Builds)のDeploy Hookを呼び出してビルドをキックします。HTML変換はフロントエンドのビルド時に行います。既読GUIDの状態は`state`専用ブランチにgit管理で保存します

---

## 開発環境・ツール

- **パッケージマネージャー**: pnpm(workspace構成。`apps/backend`・`apps/frontend`・`packages/shared`)
- **ランタイム**: バックエンドはGitHub Actions(Node.js)、フロントエンドはAstro(SSG)をビルドしCloudflare Workers Static Assetsで配信。Cloudflareは R2(生成物保存)・Workers Static Assets(静的配信)のみを利用(spec.md 0章の実現可能性調査により、Cloudflare WorkersのFreeプランCPU時間制限を理由に生成処理からWorkersを排除したアーキテクチャ)
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
