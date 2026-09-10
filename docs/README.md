# RSS Summary — Tech Morning Digest

指定したRSSフィードから毎朝情報を取得し、AIがニュースレター風にまとめた「今日のダイジェスト」を静的サイトとして配信するサービス。詳細な要件・設計判断は [`spec.md`](../spec.md)、実装の全体像は [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) を参照。

## リポジトリ構成(pnpm workspaceモノレポ)

```
rss-summary/
├── apps/
│   ├── backend/   # Workers Buildsのビルドステップで実行する生成処理
│   └── frontend/  # Astro(Workers Static Assets、SSG)+ worker/(定期実行のscheduledハンドラ)
├── docs/
└── spec.md
```

## アーキテクチャ概要

```
フロントWorkerの scheduled() ハンドラ(cron 30 23 * * * UTC)
  → Deploy Hook を POST → Workers Builds が起動
  → [ビルド内] backend 生成処理:
      RSSフィード取得(17件) → 既読(R2の state/read-guids.json)と突き合わせ → 新着抽出
      → Gemini APIで構造化JSON(今日の3行・Today's Pick・カテゴリ別記事)を生成
      → Cloudflare R2へアップロード({date}.json)、既読stateを state/read-guids.json へ上書き
  → [ビルド内] astro build がR2から取得しHTML化 → wrangler deploy で Workers Static Assets へ配信
  → もう1本の cron(0 2 * * * UTC)が当日分 {date}.json のR2欠損を監視し、欠損なら Webhook 通知
```

生成処理(バックエンド)はWorkers Buildsのビルドコマンド内のNode.jsで完結する。HTML変換はフロントエンド(Astro)のビルド時に行うため、バックエンドは構造化JSONをR2に保存するのみ(Markdown経由ではない、spec.md 5章参照)。

## デプロイ構成(Cloudflare一本化)

定期実行・生成処理・既読stateはすべて Cloudflare 上で動く。GitHub Actions は使わない。

### Workers Builds プロジェクト設定(既存の frontend プロジェクトを流用)

- Root directory: リポジトリルート
- Build command:
  `pnpm install --frozen-lockfile && pnpm --filter @rss-summary/backend start && pnpm --filter @rss-summary/frontend build`
- Deploy command: `pnpm --filter @rss-summary/frontend exec wrangler deploy`
- 自動ビルドのトリガー: **Deploy Hook のみ**(git push での自動デプロイは無効化する)

### ビルド時変数(Settings → Build → Variables and Secrets)

| 変数 | 種別 |
|---|---|
| GEMINI_API_KEY | Secret |
| GEMINI_MODEL | 通常(任意) |
| CLOUDFLARE_ACCOUNT_ID | 通常 |
| R2_ACCESS_KEY_ID | Secret |
| R2_SECRET_ACCESS_KEY | Secret |
| R2_BUCKET_NAME | 通常 |

### Worker ランタイム変数(Settings → Variables and Secrets)

| 変数 | 種別 |
|---|---|
| DEPLOY_HOOK_URL | Secret |
| ALERT_WEBHOOK_URL | Secret(Discord/Slack の Incoming Webhook) |
| CLOUDFLARE_ACCOUNT_ID | 通常 |
| R2_ACCESS_KEY_ID | Secret |
| R2_SECRET_ACCESS_KEY | Secret |
| R2_BUCKET_NAME | 通常 |

> ビルド時変数(Settings → Build)と Worker ランタイム変数(Settings → Variables and Secrets)はダッシュボード上の別セクション。両方に登録が必要な変数がある。

### R2 バケットのライフサイクルルール(初回のみ)

ダイジェストの JSON は 30 日で R2 から自動削除する(フロントエンドの表示は直近 2 週間だが、R2 側の保持は 1 ヶ月とする方針。カスタムの削除コードは書かず R2 のネイティブ機能を使う)。

```sh
pnpm --filter @rss-summary/frontend exec wrangler r2 bucket lifecycle add <BUCKET_NAME> expire-after-30-days --expire-days 30
```

反映まで最大 24 時間程度かかる場合がある。既読 state(`state/read-guids.json`)は毎実行書き換わるためこのルールでは消えないが、生成が 30 日以上止まると削除されうる(下記「既知の制約・運用上の注意」参照)。

### カットオーバー手順(順序厳守 — main へマージする前に 1〜5 を完了)

1. 上記の Workers Builds プロジェクト設定を変更する。
2. ビルド時変数を登録する。
3. Worker ランタイム変数を登録する。
4. 既読stateを移行する:
   `git show origin/state:read-guids.json > /tmp/read-guids.json`
   `pnpm --filter @rss-summary/frontend exec wrangler r2 object put <BUCKET>/state/read-guids.json --file /tmp/read-guids.json --content-type "application/json"`
   （初回 cron より前に必須。未実施だと全記事が新着扱いになる）
5. Discord/Slack の Incoming Webhook URL を発行し `ALERT_WEBHOOK_URL` に設定する。
6. このブランチを main にマージ → Deploy Hook を1回手動 POST(`curl -X POST <DEPLOY_HOOK_URL>`)。
7. ビルドログでビルド成功、`wrangler deployments` / ダッシュボードで cron 2本の登録を確認する。
8. 翌朝、cron 実行後に R2 の `{当日JST日付}.json` 生成とサイト反映を確認する。
9. 問題なければ、リポジトリの GitHub Secrets を削除し、`state` ブランチを削除する。

### ロールバック

- `git revert` で `.github/workflows/backend-daily-digest.yml` を復活させ、GitHub Secrets を再登録。
- `apps/frontend/wrangler.jsonc` から `main` と `triggers` を外して再デプロイ。
- Workers Builds のビルド設定を元(Root=`apps/frontend`、build=astroのみ、自動ビルド再有効化)に戻す。
- **state 乖離注意**: カットオーバー後は R2 が最新。数日以内に戻すか、戻す前に R2 の `state/read-guids.json` を `state` ブランチへ書き戻す。

## バックエンドのローカル開発

```sh
pnpm --filter @rss-summary/backend test        # ユニットテスト(node:test)。ネットワーク不要
pnpm --filter @rss-summary/backend typecheck    # 型チェック(tsc --noEmit)
pnpm --filter @rss-summary/backend start        # 実際に生成処理を実行(要環境変数。上記「ビルド時変数」表と同じ変数名)
```

`start` をローカルで実行する場合は、上記「ビルド時変数」表相当の値を環境変数として設定する必要がある(`.env`等は用意していないため、シェルの環境変数かdirenv等で設定すること)。ローカル実行でも既読stateはR2の`state/read-guids.json`を読み書きする。

## フロントエンド(Astro)

`apps/frontend`。Astroの静的サイト生成(SSG、アダプター不要)で、ビルド時にR2から直近14日分のダイジェストJSONを取得しHTML化する。デプロイ先はCloudflare Workers Static Assets(Cloudflareの今後の投資方向に合わせてPagesではなくこちらを採用)。

### アーキテクチャ

```
フロントWorkerの scheduled()(cron 30 23 * * * UTC)→ Deploy Hook を POST
  → Workers Builds が起動(Root=リポジトリルート)
  → backend 生成処理を実行(RSS取得 → Gemini要約 → R2へ {date}.json と state/read-guids.json)
  → astro build 実行時、R2から直近14日分の {date}.json を取得
    (存在しない日はスキップ。ビルド全体は失敗させない)
  → 構造化JSON(threeLines/picks/categories)をDigestBody.astroが直接テンプレートに埋め込みHTML化
  → wrangler deploy でWorkers Static Assetsへデプロイ
```

- トップページ(`/`): 最新のダイジェスト
- アーカイブ一覧(`/archive/`): 直近14日分へのリンク
- 個別ページ(`/archive/{date}/`): 各日のダイジェスト(新着なしの日は専用メッセージ)

### セットアップ手順

Workers Builds プロジェクトの設定・変数登録・カットオーバー手順は上記「デプロイ構成(Cloudflare一本化)」にまとめている。ここでは frontend 固有の補足のみ:

- `apps/frontend/wrangler.jsonc` の `main`(`worker/index.ts`)と `triggers.crons`(`30 23 * * *` / `0 2 * * *`、いずれもUTC)で定期実行を定義している。`wrangler deploy` 時に cron が登録される。
- Deploy Hook で毎日ビルドが走るため Build Watch Paths での絞り込みは行わない(git push 自動ビルドは無効化)。
- ドメインは当面 Cloudflare が割り当てる `workers.dev` サブドメインを使う。コード側にドメインをハードコードしていないため、独自ドメインへの変更は `wrangler.jsonc` とダッシュボード設定のみで対応できる。

### フロントエンドのローカル開発

```sh
pnpm --filter @rss-summary/frontend typecheck   # astro check
pnpm --filter @rss-summary/frontend build       # astro build(要R2環境変数)
pnpm --filter @rss-summary/frontend dev         # astro dev(要R2環境変数)
```

ローカルで`build`/`dev`を実行する場合、「ビルド時変数」表のR2関連変数(`CLOUDFLARE_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME`)をバックエンドと同様に環境変数として設定する必要がある(R2に到達できない場合はビルドが失敗する。意図的な挙動 — 空サイトを誤ってデプロイしないため)。

### 既知の制約

- TypeScript 7のネイティブコンパイラは`astro check`が依存するプログラム的Language Service APIをまだ提供していないため(2026-08-02時点、[公式ロードマップで追跡中](https://github.com/withastro/roadmap/discussions/1321))、`apps/frontend`のみTypeScript 6.0.3(JSベース実装が残る最後の安定版)に固定している。`apps/backend`は影響を受けないためTypeScript 7のまま
- R2オブジェクトが存在しない日(生成ビルド未実行等)はビルド時にスキップされ、アーカイブから抜ける(ビルド自体は失敗しない)

## 既知の制約・運用上の注意

- Cloudflare の Cron Triggers は実行時刻が数分ずれることがある(spec.md 9章)
- 既読GUIDは14日でプルーニングされる。低頻度フィードで生成ジョブが14日以上停止すると、復旧後に既読記事が再通知される可能性がある(spec.md 6章)
- 生成ジョブ(フロントWorkerの`scheduled()` + Workers Builds)が30日以上完全に停止すると、R2の`state/read-guids.json`がライフサイクルルールで削除され、復帰時に全記事が新着扱いになる。`MAX_ITEMS_PER_FEED=50`で各フィード最新50件までに限定されるため影響は有限(Cloudflare一本化前の「60日でscheduled workflow自動無効化」リスクと同クラス、spec.md 9章)
- R2上のダイジェストJSONは30日でライフサイクルルールにより自動削除される。フロントエンドでの表示範囲(直近2週間)より長く保持しているのは、将来のアーカイブ機能拡張の余地を残すため
- 定期実行はフロントWorkerの`scheduled()`(Cron Triggers)。Pages 単体ではスケジュール実行できず(Cron Triggers は Workers 専用)、生成結果のR2欠損はウォッチドッグcron(`0 2 * * *` UTC)が`ALERT_WEBHOOK_URL`へ通知する
