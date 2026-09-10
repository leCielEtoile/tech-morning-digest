# Cloudflareへの定期実行一本化 — 設計書

- 作成日: 2026-09-11
- ブランチ: `feat/cloudflare-consolidation`
- ステータス: レビュー待ち

## 背景・目的

現在、毎朝のダイジェスト生成は GitHub Actions の scheduled workflow
(`.github/workflows/backend-daily-digest.yml`)が実行している。以下の課題がある。

1. **scheduled workflow の実行が不安定**: GitHub の cron はベストエフォートで遅延・スキップが起きうる。
2. **60日自動無効化**: GitHub は60日間コミットがないと scheduled workflow を自動停止する。
   `state` ブランチへのコミットがこの判定に含まれるか公式に断定できず、デッドマンズスイッチも未導入
   (AI-CONTEXT.md「既知のリスク」)。

定期実行・生成処理・既読state管理を Cloudflare(Workers Builds + Cron Trigger + R2)へ一本化し、
GitHub Actions と `state` ブランチへの依存をなくす。

## 実現可能性(2026-09、Cloudflare公式ドキュメントで確認)

| 項目 | Workers Builds Freeプラン | 本ジョブの想定消費 |
|---|---|---|
| ビルド時間 | 3,000分/月 | 1日約5分 × 31日 ≈ 155分/月(約5%) |
| 同時ビルド数 | 1 | 1日1回 |
| ビルドタイムアウト | 20分 | 生成+Astroビルドで十分 |
| リソース | 2 vCPU / 8 GB RAM / 20 GB disk | 余裕 |
| 環境変数 | 64個・各5 KB | 使用は7個程度 |
| Deploy Hooks | 10回/分・Worker | 1日1回 |

- Cron Triggers は Workers Free プランで利用可(UTC実行、設定変更の伝播は最大15分)。
  `scheduled()` ハンドラで `fetch` 1回のCPU消費は約1ms、Free上限10msに対し余裕。
- R2 の追加バケット作成は無料。小オブジェクト1個/日の読み書きは Free 枠内。
- **spec.md 0章がWorkersを排除した理由(CPU 10ms制限)は本方式には影響しない**。
  生成処理が動くのは Workers ランタイムではなくビルドコンテナ(フルLinux + Node、
  `child_process`/`node:crypto`/`rss-parser` がそのまま動作)。

→ すべて無料枠内で成立する。

## 最終アーキテクチャ

```
Cron Trigger 23:30 UTC(無料スケジューラWorker)
      └─ POST → Deploy Hook
              └─ Workers Builds(既存フロントプロジェクトを流用)
                   1. pnpm install --frozen-lockfile
                   2. backend生成処理:
                        RSS取得 → Gemini要約 → R2にダイジェストJSON書き込み
                        → R2に既読state書き込み
                   3. astro build(R2からJSON読み込み)
                   4. wrangler deploy(Workers Static Assets)

Cron Trigger 02:00 UTC(同スケジューラWorker、ウォッチドッグ)
      └─ R2の当日分JSONを確認 → 欠損/古ければ通知Webhookへ POST
```

GitHub Actions・`state` ブランチ・GitHub Secrets は不要になる。

## コンポーネント設計

### (a) スケジューラWorker(新規 `apps/scheduler/`)

`scheduled()` ハンドラのみを持つ最小Worker(`assets` なし、`main` のみ)。

- **cron `30 23 * * *`**: `env.DEPLOY_HOOK_URL` へ `fetch(url, { method: "POST" })`。
  失敗時は軽いリトライ(2〜3回、指数バックオフ)。
- **cron `0 2 * * *`(ウォッチドッグ)**: R2 から当日JST日付の `${date}.json` を GET し、
  取得できない、または `generatedAt` が当日でない場合、`env.ALERT_WEBHOOK_URL`
  (Discord/Slack の Incoming Webhook)へ失敗通知を POST。
- `controller.cron` の値で2つの処理を分岐。
- デプロイはCIに載せず `pnpm --filter @rss-summary/scheduler deploy` を手動実行
  (このWorkerはほとんど変更されないため)。

**ファイル構成**
- `apps/scheduler/src/index.ts` — `scheduled()` ハンドラ
- `apps/scheduler/wrangler.jsonc` — `name`, `compatibility_date`, `main`, `triggers.crons`
- `apps/scheduler/package.json` — `@rss-summary/scheduler`。依存: `aws4fetch`
  (ウォッチドッグのR2署名付きGET用)。devDeps: `wrangler`, `typescript`, `@cloudflare/workers-types`
- `apps/scheduler/tsconfig.json`

**シークレット(`wrangler secret put` またはダッシュボード)**
`DEPLOY_HOOK_URL` / `ALERT_WEBHOOK_URL` / `CLOUDFLARE_ACCOUNT_ID` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME`

### (b) 生成処理をビルドに統合(既存フロントの Workers Builds プロジェクト設定変更)

コード変更ではなく Cloudflare ダッシュボード設定の変更。

- **Root directory**: `apps/frontend` → リポジトリルート
- **Build command**:
  `pnpm install --frozen-lockfile && pnpm --filter @rss-summary/backend start && pnpm --filter @rss-summary/frontend build`
- **Deploy command**: `pnpm --filter @rss-summary/frontend exec wrangler deploy`
- **ビルド環境変数を追加**:
  `GEMINI_API_KEY`(secret) / `GEMINI_MODEL`(任意) / `CLOUDFLARE_ACCOUNT_ID` /
  `R2_ACCESS_KEY_ID`(secret) / `R2_SECRET_ACCESS_KEY`(secret) / `R2_BUCKET_NAME`

生成ステップが非ゼロ終了すると `&&` で連鎖が止まりビルド失敗 → デプロイされず前日サイトが残る
(現行の「Gemini失敗時は前日ページ維持」と同じ挙動)。

### (c) 既読state を git → R2 に移行

`apps/backend/src/state/read-state.ts`:

- `loadReadState()` / `commitReadState()` の中身を R2 の GET / PUT に置換。
  オブジェクトキー: `state/read-guids.json`(ダイジェストJSONと同じバケット)。
- 純粋関数(`computeGuidHash` / `pruneReadState` / `filterNewArticles` / `markAsRead`)は変更なし。
- `node:child_process` / `node:fs/promises` / `node:os` / `node:path` の import、
  `runGit`、worktree ロジック、`STATE_BRANCH` を削除。
- 初回(オブジェクトが存在せず R2 が 404)は空 state `{}` を返す。
- `commitReadState` は「差分がなければ何もしない」をやめ、**毎回 PUT する**
  (毎日書き換わることで30日ライフサイクル削除を回避する。決定事項参照)。
  関数名は `saveReadState` に変更。

`apps/backend/src/publish/r2-client.ts`:

- state 用に汎用 GET/PUT を公開する。案:
  - `getR2Text(config, key): Promise<string | null>`(404 は null)
  - `putR2Text(config, key, body, contentType): Promise<void>`(リトライ付き)
  - 既存 `uploadDigestJson` は `putR2Text` を使う薄いラッパにするか、そのまま残す。
- フロントエンドの `apps/frontend/src/lib/r2-client.ts` は変更しない(読み取り専用のまま)。

`apps/backend/src/index.ts`:

- `loadReadState()` → `loadReadState(config.r2)`、`commitReadState(...)` → `saveReadState(config.r2, ...)`。
- **`triggerDeployHook` 呼び出しを削除**。ビルド自体がデプロイなので backend から Deploy Hook を
  叩く必要がない。`config.deployHookUrl` と `requireEnv("DEPLOY_HOOK_URL")` を削除。
- 既読化のタイミング不変条件(R2書き込み成功後にのみ既読化)は維持。

## コード変更一覧

**追加**
- `apps/scheduler/`(`src/index.ts` / `wrangler.jsonc` / `package.json` / `tsconfig.json`)
- `apps/scheduler/src/index.test.ts`(`scheduled()` の分岐・Webhook判定の単体テスト)

**変更**
- `apps/backend/src/state/read-state.ts` — git実装 → R2実装、`commitReadState`→`saveReadState`
- `apps/backend/src/publish/r2-client.ts` — 汎用 `getR2Text` / `putR2Text` を追加
- `apps/backend/src/index.ts` — state関数の引数変更、Deploy Hook呼び出し削除
- `apps/backend/src/state/read-state.test.ts` — R2 load/save のテスト追加(`fetch` モック)
- `apps/backend/package.json` — `description` 更新(依存の増減なし)
- `pnpm-workspace.yaml` — 必要なら scheduler を追加(`apps/*` グロブで自動包含なら不要)
- ルート `package.json` — `scheduler:deploy` / `scheduler:typecheck` スクリプト追加
- `docs/AI-CONTEXT.md` / `docs/README.md` — アーキテクチャ・セットアップ手順を更新
- `CLAUDE.md` — プロジェクト構造図の更新

**削除**
- `.github/workflows/backend-daily-digest.yml`
- `apps/backend/src/publish/deploy-hook.ts`(Deploy Hook呼び出しはスケジューラWorkerへ移動)
- `state` ブランチ(移行・動作確認後。当面は残置してロールバック用に保持)

## エラーハンドリング

| 事象 | 挙動 |
|---|---|
| Gemini全リトライ失敗 | `process.exitCode=1` → ビルド失敗 → デプロイされず前日サイト維持(現行同等)。ウォッチドッグが翌02:00 UTCに検知し通知 |
| 全フィード取得失敗 | 新着0件として続行(現行同等) |
| R2書き込み失敗 | `withRetry` で最大3回、それでも失敗ならビルド失敗 |
| Deploy Hook POST失敗(スケジューラ側) | スケジューラWorkerで軽リトライ。失敗すればその日ビルドされず、ウォッチドッグが検知 |
| 1日分のR2オブジェクト欠損 | フロントのローダーが従来どおり握りつぶす(AI-CONTEXT 不変条件 #7) |

## 決定事項

1. **既読stateの保存先**: 既存バケットに毎回上書き。
   - 新バケット・新トークン不要。`state/read-guids.json` を毎実行 PUT するため、
     30日ライフサイクル削除(untouched 30日で削除)は事実上発生しない。
   - **既知のリスク**: ジョブが30日以上完全停止すると state が消え、再通知が起きうる。
     既存の14日プルーニング・60日リスクと同クラスとして README / AI-CONTEXT に明記する。
2. **失敗通知**: ウォッチドッグ cron + Webhook。
   - スケジューラWorkerに2本目の cron(02:00 UTC)。当日分R2オブジェクトの
     `generatedAt` が当日でなければ `ALERT_WEBHOOK_URL`(Discord/Slack Incoming Webhook)へ通知。
   - 完全無料。GitHub Actions の失敗メール通知の代替。
3. **生成処理の実行場所**: 既存フロントの Workers Builds プロジェクトに統合(専用の2つ目の
   ビルドプロジェクトは作らない)。ビルド1回で生成+デプロイが完結し、Deploy Hook / ビルドが1系統で済む。

## 手動セットアップ(コード外、READMEに手順を記載)

1. Workers Builds プロジェクト設定変更(上記 b)+ ビルド環境変数登録
2. 既読state初回移行: `state` ブランチの `read-guids.json` を
   `wrangler r2 object put <bucket>/state/read-guids.json --file=...` で投入
3. スケジューラWorkerを1回デプロイ + シークレット設定
4. Discord/Slack の Incoming Webhook URL を発行し `ALERT_WEBHOOK_URL` に設定
5. 動作確認後、GitHub Secrets とワークフローを撤去、`state` ブランチ削除

## テスト

- `pnpm --filter @rss-summary/backend test`(node標準テストランナー。R2 state の新規テスト含む、`fetch` をモック)
- `pnpm --filter @rss-summary/scheduler test` / `typecheck`
- 全パッケージ `typecheck`
- `wrangler dev --test-scheduled` でスケジューラの `scheduled()` をローカル確認
- 手動E2E: Deploy Hook を POST → ビルドログ → R2オブジェクト生成 → サイト反映を確認

## ロールバック

- ワークフローファイルはgit履歴に残るため復元可能。
- `state` ブランチは移行後しばらく残置。
- Workers Builds のビルド設定を元(`apps/frontend` ルート、astro buildのみ)に戻せば旧構成へ即復帰。

## スコープ外(YAGNI)

- Workers Builds Event Subscriptions(Queue経由)での高度な通知。将来必要になれば追加。
- 専用のバックエンド用 Workers Builds プロジェクト。
- state の履歴管理(git履歴の代替)。state はキャッシュ用途のため不要。
