# RSS Summary — Tech Morning Digest

指定したRSSフィードから毎朝情報を取得し、AIがニュースレター風にまとめた「今日のダイジェスト」を静的サイトとして配信するサービス。詳細な要件・設計判断は [`spec.md`](../spec.md)、実装の全体像は [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) を参照。

## リポジトリ構成(pnpm workspaceモノレポ)

```
rss-summary/
├── apps/
│   ├── backend/   # GitHub Actions生成処理
│   └── frontend/  # Astro(Workers Static Assets、SSG)
├── docs/
└── spec.md
```

## アーキテクチャ概要

```
GitHub Actions(毎朝 JST 8:30、cron)
  → RSSフィード取得(17件) → 既読(stateブランチ)と突き合わせ → 新着抽出
  → Gemini APIで構造化JSON(今日の3行・Today's Pick・カテゴリ別記事)を生成
  → Cloudflare R2へJSONペイロードとしてアップロード({date}.json) → Deploy Hook呼び出し
  → Astro(Workers Static Assets)がビルド時にR2から取得しHTML化して配信
```

生成処理(バックエンド)はGitHub Actions上のNode.jsで完結する。HTML変換はフロントエンド(Astro)のビルド時に行うため、バックエンドは構造化JSONをR2に保存するのみ(Markdown経由ではない、spec.md 5章参照)。

## バックエンドのセットアップ手順

作業は`apps/backend`が対象。コマンドはリポジトリルートから実行する。

### 1. 依存関係のインストール

```sh
pnpm install
```

### 2. `state`ブランチの初期化(初回のみ)

既読GUIDを管理する専用ブランチ。まだない場合は作成する。

```sh
git checkout --orphan state
git rm -rf .
echo '{}' > read-guids.json
git add read-guids.json
git commit -m "chore: state ブランチ初期化"
git push -u origin state
git checkout main
```

### 3. GitHub Secretsの登録

リポジトリの `Settings > Secrets and variables > Actions` で以下を登録する(spec.md 11章)。

| Secret名 | 説明 |
|---|---|
| `GEMINI_API_KEY` | Google Gemini APIキー |
| `CLOUDFLARE_ACCOUNT_ID` | CloudflareアカウントID(R2エンドポイントの組み立てに使用) |
| `R2_ACCESS_KEY_ID` | R2用APIトークンのAccess Key ID(`R2 > Manage API Tokens`から発行。通常のCloudflare APIトークンとは別種) |
| `R2_SECRET_ACCESS_KEY` | 同トークンのSecret Access Key |
| `R2_BUCKET_NAME` | 書き込み先R2バケット名 |
| `DEPLOY_HOOK_URL` | フロントエンドのWorkers Builds向けDeploy Hook URL(下記「フロントエンド」セクション参照) |

`state`ブランチへのpushは既定の`GITHUB_TOKEN`(ワークフローの`permissions.contents: write`)で行われるため、追加のSecretは不要。

### 4. R2バケットのライフサイクルルール設定(初回のみ)

ダイジェストのJSONファイルは30日でR2から自動削除されるようにする(フロントエンドでの表示自体は直近2週間分に絞るが、R2側のデータ保持は1ヶ月とする方針。カスタムの削除コードは書かず、R2のネイティブ機能を使う)。

```sh
npx wrangler r2 bucket lifecycle add <BUCKET_NAME> expire-after-30-days --expire-days 30
```

反映まで最大24時間程度かかる場合がある。

### 5. 動作確認

GitHub Actionsの `Actions` タブから `Backend Daily Digest` ワークフローを `workflow_dispatch` で手動実行し、以下を確認する。

- R2に当日ファイル(`{YYYY-MM-DD}.json`、`{date, generatedAt, hasNewArticles, threeLines, picks, categories}`形式)が生成されること
- フロントエンド(Workers Builds)が再ビルドされること
- `state`ブランチに新着GUIDが追記されること

## バックエンドのローカル開発

```sh
pnpm --filter @rss-summary/backend test        # ユニットテスト(node:test)。ネットワーク不要
pnpm --filter @rss-summary/backend typecheck    # 型チェック(tsc --noEmit)
pnpm --filter @rss-summary/backend start        # 実際に生成処理を実行(要環境変数。上記Secrets表と同じ変数名)
```

`start` をローカルで実行する場合は、上表のSecrets相当の値を環境変数として設定する必要がある(`.env`等は用意していないため、シェルの環境変数かdirenv等で設定すること)。

## フロントエンド(Astro)

`apps/frontend`。Astroの静的サイト生成(SSG、アダプター不要)で、ビルド時にR2から直近14日分のダイジェストJSONを取得しHTML化する。デプロイ先はCloudflare Workers Static Assets(Cloudflareの今後の投資方向に合わせてPagesではなくこちらを採用)。

### アーキテクチャ

```
Backend Deploy Hook 呼び出し(またはfrontendコードへのgit push)
  → Workers Builds が起動
  → astro build 実行時、R2から直近14日分の {date}.json を取得
    (存在しない日はスキップ。ビルド全体は失敗させない)
  → 構造化JSON(threeLines/picks/categories)をDigestBody.astroが直接テンプレートに埋め込みHTML化
  → wrangler deploy でWorkers Static Assetsへデプロイ
```

- トップページ(`/`): 最新のダイジェスト
- アーカイブ一覧(`/archive/`): 直近14日分へのリンク
- 個別ページ(`/archive/{date}/`): 各日のダイジェスト(新着なしの日は専用メッセージ)

### セットアップ手順(Cloudflareダッシュボード)

1. **Workers & Pages > Create > Import a repository** からこのリポジトリを接続する
2. **Root directory** を `apps/frontend` に設定する(モノレポのため。[Workers Builds monorepoガイド](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/#monorepos)参照)
3. **Build command**: `pnpm run build`
4. **Deploy command**: `pnpm exec wrangler deploy`
5. **Build Watch Paths** を `apps/frontend/**` に設定し、バックエンドのみの変更でフロントエンドの不要な再ビルドが走らないようにする([Build Watch Paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)参照)
6. **Settings > Build > Variables & secrets** に以下を登録する(ビルド時のみ使用、ランタイムには渡らない)

   | 変数名 | 説明 |
   |---|---|
   | `CLOUDFLARE_ACCOUNT_ID` | CloudflareアカウントID |
   | `R2_ACCESS_KEY_ID` | R2用APIトークンのAccess Key ID(バックエンドと同じトークンを読み取り用途で共用可、または別途Read権限のみのトークンを発行) |
   | `R2_SECRET_ACCESS_KEY` | 同トークンのSecret Access Key |
   | `R2_BUCKET_NAME` | バックエンドと同じR2バケット名 |

7. **Settings > Builds > Deploy Hooks** でDeploy Hookを発行し、そのURLをバックエンド側のGitHub Secret `DEPLOY_HOOK_URL` に登録する(これでバックエンドの生成完了 → フロントエンド再ビルドが繋がる)
8. ドメインは当面Cloudflareが割り当てる`workers.dev`サブドメインを使う。コード側にドメインをハードコードしていないため、後から独自ドメインへ変更しても`wrangler.jsonc`やCloudflareダッシュボードの設定変更のみで対応できる

### フロントエンドのローカル開発

```sh
pnpm --filter @rss-summary/frontend typecheck   # astro check
pnpm --filter @rss-summary/frontend build       # astro build(要R2環境変数)
pnpm --filter @rss-summary/frontend dev         # astro dev(要R2環境変数)
```

ローカルで`build`/`dev`を実行する場合、上表の変数をバックエンドと同様に環境変数として設定する必要がある(R2に到達できない場合はビルドが失敗する。意図的な挙動 — 空サイトを誤ってデプロイしないため)。

### 既知の制約

- TypeScript 7のネイティブコンパイラは`astro check`が依存するプログラム的Language Service APIをまだ提供していないため(2026-08-02時点、[公式ロードマップで追跡中](https://github.com/withastro/roadmap/discussions/1321))、`apps/frontend`のみTypeScript 6.0.3(JSベース実装が残る最後の安定版)に固定している。`apps/backend`は影響を受けないためTypeScript 7のまま
- R2オブジェクトが存在しない日(ワークフロー未実行等)はビルド時にスキップされ、アーカイブから抜ける(ビルド自体は失敗しない)

## 既知の制約・運用上の注意

- GitHub Actionsの`schedule`は実行時刻が数分〜数十分ずれることがある(spec.md 9章)
- リポジトリに60日間コミットがないとscheduled workflowが自動無効化されるリスクを認識した上で、現時点では追加対策(keepaliveワークフロー等)を導入していない(spec.md 9章「既知のリスク」参照)
- 既読GUIDは14日でプルーニングされる。低頻度フィードでワークフローが14日以上停止すると、復旧後に既読記事が再通知される可能性がある(spec.md 6章)
- R2上のダイジェストJSONは30日でライフサイクルルールにより自動削除される。フロントエンドでの表示範囲(直近2週間)より長く保持しているのは、将来のアーカイブ機能拡張の余地を残すため
