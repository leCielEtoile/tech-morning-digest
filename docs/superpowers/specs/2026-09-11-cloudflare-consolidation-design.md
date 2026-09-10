# Cloudflareへの定期実行一本化 — 設計書

- 作成日: 2026-09-11
- ブランチ: `feat/cloudflare-consolidation`
- ステータス: レビュー反映済み(セルフレビュー2周目完了)

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
  実装時に Free プランの cron トリガー本数上限(1 Worker に 2 本)を確認する。
- Pages 単体ではスケジュール実行できない(スケジュールビルド機能なし、Pages Functions は
  `scheduled()` / Cron Triggers 非対応)。Cloudflare でネイティブに定期実行できるのは
  Worker の Cron Trigger のみ。
- R2 の追加バケット作成は無料。小オブジェクト1個/日の読み書きは Free 枠内。
- **spec.md 0章がWorkersを排除した理由(CPU 10ms制限)は本方式には影響しない**。
  生成処理が動くのは Workers ランタイムではなくビルドコンテナ(フルLinux + Node、
  `child_process`/`node:crypto`/`rss-parser` がそのまま動作)。

→ すべて無料枠内で成立する。

## 最終アーキテクチャ

```
Cron Trigger 23:30 UTC(フロントWorkerに同居する scheduled() ハンドラ)
      └─ POST → Deploy Hook
              └─ Workers Builds(既存フロントプロジェクトを流用)
                   1. pnpm install --frozen-lockfile
                   2. backend生成処理:
                        RSS取得 → Gemini要約 → R2にダイジェストJSON書き込み
                        → R2に既読state書き込み
                   3. astro build(R2からJSON読み込み)
                   4. wrangler deploy(Static Assets + scheduled ハンドラ + cron 登録)

Cron Trigger 02:00 UTC(同フロントWorker、ウォッチドッグ)
      └─ R2の当日分JSONを確認 → 欠損/古ければ通知Webhookへ POST
```

スケジューラ用の専用Workerは作らない。フロントは既に Workers Static Assets の Worker
なので、その `wrangler.jsonc` に `main`(`scheduled()` のみ)と `triggers.crons` を追加し、
cron コードを通常のフロントビルドで一緒にデプロイする。

**フロントの自動ビルドは Deploy Hook のみに限定する**(下記 決定事項5)。
GitHub Actions・`state` ブランチ・GitHub Secrets は不要になる。

## コンポーネント設計

### (a) フロントWorkerに cron を同居させる

`apps/frontend` は現状 `assets.directory` だけの純粋な静的配信 Worker。ここに `scheduled()`
ハンドラを持つ `main` スクリプトを追加する。`fetch` ハンドラは実装しない
→ HTTPリクエストは従来どおり自動的に静的アセットから配信される(挙動は変わらない)。

**配置: `apps/frontend/worker/` に隔離する(`src/` の外)**
Astro の `astro check` は `src/**` を対象にするため、Workers 型(`@cloudflare/workers-types`)を
`src/` に持ち込むと DOM/Astro の型と衝突しうる。これを避けるため worker コードは
`apps/frontend/worker/` に置き、専用 tsconfig で型検査する。

- `apps/frontend/worker/index.ts` — `scheduled(controller, env, ctx)` のみを export
- `apps/frontend/worker/tsconfig.json` — `@cloudflare/workers-types` を参照、`worker/**` のみ include
- `apps/frontend/worker/index.test.ts` — `isDigestFresh` と cron 分岐の単体テスト
- `Env` インターフェースは worker/index.ts 内に手書き(6フィールド、すべて `string`)。
  `wrangler types` 生成の d.ts は使わない(依存を増やさない)

**処理内容(`controller.cron` で分岐)**
- `"30 23 * * *"` → `env.DEPLOY_HOOK_URL` へ `fetch(url, { method: "POST" })`。
  失敗時は **worker/index.ts 内のインラインの軽いリトライ**(3回、指数バックオフ、数行)。
  backend の `utils/retry.ts` は共有しない(パッケージ跨ぎの refactor を避ける)。
- `"0 2 * * *"`(ウォッチドッグ)→ R2 から当日JST日付の `${date}.json` を GET し、
  `isDigestFresh` が false なら `env.ALERT_WEBHOOK_URL`(Discord/Slack Incoming Webhook)へ POST。
- R2 アクセスは `aws4fetch`(既に frontend の依存)で直接署名 GET する。config は
  `scheduled` の `env` 引数から組み立てる(Worker ランタイムに `process.env` はない)。
  `apps/frontend/src/lib/r2-client.ts` は `process.env` に依存しているため worker からは import せず、
  worker/ 内に最小の署名 GET を書く。
- `isDigestFresh(rawJson: string | null, todayJst: string): boolean` — 純粋関数として切り出す。
  `rawJson` が null(404)なら false。JSON パースして `date === todayJst` かつ
  `generatedAt` が当日を示すなら true。

**`apps/frontend/wrangler.jsonc`(変更)**
```jsonc
{
  "name": "tech-morning-digest",
  "compatibility_date": "2026-08-02",
  "main": "worker/index.ts",
  "assets": { "directory": "./dist" },
  "triggers": { "crons": ["30 23 * * *", "0 2 * * *"] }
}
```

**確認事項(実装時)**: 公式ドキュメントで「static assets と Worker script は併用可能、
アセットに一致すればアセット優先、一致しなければ Worker を呼ぶ」ことは確認済み。
`fetch` ハンドラを持たない `main`(cron専用)が `wrangler deploy` で許容されるかは実機確認する。
許容されない場合のフォールバック: `assets.binding: "ASSETS"` を設定し、worker/index.ts に
`fetch: (req, env) => env.ASSETS.fetch(req)` を1行だけ追加する。

**`apps/frontend` のランタイム変数(Worker の「Variables and Secrets」セクション)**
`DEPLOY_HOOK_URL`(secret) / `ALERT_WEBHOOK_URL`(secret) / `CLOUDFLARE_ACCOUNT_ID` /
`R2_ACCESS_KEY_ID`(secret) / `R2_SECRET_ACCESS_KEY`(secret) / `R2_BUCKET_NAME`
- これは **Worker ランタイムの** 変数。下記 (b) の **ビルド時変数** とはダッシュボードの
  別セクションで、同じ Workers Builds プロジェクトに登録する。README で明確に分けて書く。
- `CLOUDFLARE_ACCOUNT_ID` / `R2_*` はビルド時とランタイムの両方で必要になり重複するが、
  登録は一度きりのセットアップ作業なので許容する。

### (b) 生成処理をビルドに統合(既存フロントの Workers Builds プロジェクト設定変更)

コード変更ではなく Cloudflare ダッシュボード設定の変更。

- **Root directory**: `apps/frontend` → リポジトリルート
- **Build command**:
  `pnpm install --frozen-lockfile && pnpm --filter @rss-summary/backend start && pnpm --filter @rss-summary/frontend build`
- **Deploy command**: `pnpm --filter @rss-summary/frontend exec wrangler deploy`
  (`worker/index.ts` と cron トリガーもこの deploy で登録される)
- **ビルド時変数(Build → Variables and Secrets)を追加**:
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

- state 用に汎用 GET/PUT を公開する:
  - `getR2Text(config, key): Promise<string | null>`(404 は null)
  - `putR2Text(config, key, body, contentType): Promise<void>`(既存 `R2_RETRY_OPTIONS` で withRetry)
  - 既存 `uploadDigestJson` は `putR2Text` を使う薄いラッパにする。

`apps/backend/src/index.ts`:

- `loadReadState()` → `loadReadState(config.r2)`、`commitReadState(...)` → `saveReadState(config.r2, ...)`。
- **`triggerDeployHook` 呼び出しを削除**。ビルド自体がデプロイなので backend から Deploy Hook を
  叩く必要がない。`config.deployHookUrl` と `requireEnv("DEPLOY_HOOK_URL")` を削除。
- 既読化のタイミング不変条件(R2書き込み成功後にのみ既読化)は維持。

## コード変更一覧

**追加**
- `apps/frontend/worker/index.ts` — `scheduled()` ハンドラ + `isDigestFresh` + インラインリトライ + 署名GET
- `apps/frontend/worker/index.test.ts` — `isDigestFresh` / cron 分岐の単体テスト
- `apps/frontend/worker/tsconfig.json` — worker 用の型検査設定

**変更**
- `apps/frontend/wrangler.jsonc` — `main` と `triggers.crons` を追加
- `apps/frontend/package.json` — `@cloudflare/workers-types`・`tsx` を devDep 追加、
  `test`(`tsx --test worker/**/*.test.ts`)と `typecheck:worker`(`tsc -p worker/tsconfig.json`)を追加
- `apps/backend/src/state/read-state.ts` — git実装 → R2実装、`commitReadState`→`saveReadState`
- `apps/backend/src/publish/r2-client.ts` — 汎用 `getR2Text` / `putR2Text` を追加
- `apps/backend/src/index.ts` — state関数の引数変更、Deploy Hook呼び出し削除
- `apps/backend/src/state/read-state.test.ts` — R2 load/save のテスト追加(`fetch` モック)
- `apps/backend/package.json` — `description` 更新(依存の増減なし)
- `docs/AI-CONTEXT.md` / `docs/README.md` — アーキテクチャ・セットアップ手順を更新
- `CLAUDE.md` — プロジェクト構造図の更新

**削除**
- `.github/workflows/backend-daily-digest.yml`
- `apps/backend/src/publish/deploy-hook.ts`(Deploy Hook呼び出しはフロントWorkerの `scheduled()` へ移動)
- `state` ブランチ(移行・動作確認後。当面は残置してロールバック用に保持)

## エラーハンドリング

| 事象 | 挙動 |
|---|---|
| Gemini全リトライ失敗 | `process.exitCode=1` → ビルド失敗 → デプロイされず前日サイト維持(現行同等)。ウォッチドッグが翌02:00 UTCに検知し通知 |
| 全フィード取得失敗 | 新着0件として続行(現行同等) |
| R2書き込み失敗 | `withRetry` で最大3回、それでも失敗ならビルド失敗 |
| Deploy Hook POST失敗(フロントWorkerの `scheduled()` 側) | worker 内で軽リトライ。失敗すればその日ビルドされず、ウォッチドッグが検知 |
| 1日分のR2オブジェクト欠損 | フロントのローダーが従来どおり握りつぶす(AI-CONTEXT 不変条件 #7) |

### 監視の限界(既知)

ウォッチドッグは「生成処理が R2 に当日分データを書いたか」までしか確認しない。
R2 書き込み成功後に `astro build` / `wrangler deploy` が失敗した場合は**無検知でサイトが古いまま**になる。
今回はスコープ外とし、必要なら後日ウォッチドッグをライブサイト(公開URL)の当日日付確認まで拡張する。

## 決定事項

1. **既読stateの保存先**: 既存バケットに毎回上書き。
   - 新バケット・新トークン不要。`state/read-guids.json` を毎実行 PUT するため、
     30日ライフサイクル削除(最終更新から30日で削除)は事実上発生しない。
   - **既知のリスク**: ジョブが30日以上完全停止すると state が消え、再通知が起きうる。
     既存の14日プルーニング・60日リスクと同クラスとして README / AI-CONTEXT に明記する。
2. **失敗通知**: ウォッチドッグ cron + Webhook(フロントWorkerの2本目 cron、02:00 UTC)。
   GitHub Actions の失敗メール通知の代替。完全無料。
3. **スケジューラの置き場所**: 専用Workerを作らず、既存フロントWorker(Static Assets)に
   `scheduled()` ハンドラと cron を同居させる。新規デプロイ対象ゼロ。
4. **生成処理の実行場所**: 既存フロントの Workers Builds プロジェクトに統合。
5. **フロントの自動ビルドは Deploy Hook のみに限定する**。
   - 理由: git push でもビルドが走ると、無関係なコミット1つでも生成処理(Gemini呼び出し・
     R2/state 書き換え・記事の既読化)が実行され、同日中に複数回ダイジェストが再生成されうる。
   - Workers Builds の設定で「push時の自動デプロイ」を無効化し、トリガーを Deploy Hook に一本化する
     (実装時に無効化の具体手段を確認: プロジェクト設定のブランチ制御 / 自動デプロイのオフ)。
   - トレードオフ: フロントのコード変更(CSS・レイアウト等)は翌朝の日次ビルドで反映される。
     即時反映したい場合は Deploy Hook を手動 POST するか、ローカルで
     `pnpm --filter @rss-summary/frontend deploy` する。個人用途のため許容。

## カットオーバー手順(順序厳守)

このPRを main にマージすると新しい build command でビルドが走るため、**マージ前に 1〜4 を完了させる**。

1. Workers Builds のプロジェクト設定変更(Root directory・Build command・Deploy command、決定事項5の自動ビルド無効化)
2. ビルド時変数の登録(上記 b)
3. フロントWorker のランタイム変数の登録(上記 a、6項目)
4. 既読state初回移行: `state` ブランチの `read-guids.json` を
   `wrangler r2 object put <bucket>/state/read-guids.json --file=...` で R2 へ投入
   (**初回 cron より前に必須**。未実施だと全記事が新着扱いになり巨大ダイジェストが1本出る。
   `MAX_ITEMS_PER_FEED=50` で被害は各フィード50件までに限定される)
5. Discord/Slack の Incoming Webhook URL を発行し `ALERT_WEBHOOK_URL` に設定
6. PR を main にマージ → Deploy Hook を1回手動 POST(または Workers Builds で再デプロイ)
   → ビルド成功で `worker/index.ts` がデプロイされ cron トリガーが登録される
7. `wrangler deployments` / ダッシュボードで cron 2本の登録を確認
8. 翌朝、cron 実行 → R2 に当日分JSON生成 → サイト反映を確認
9. 問題なければ GitHub Secrets と `.github/workflows/backend-daily-digest.yml` を撤去、`state` ブランチ削除

## テスト

- `pnpm --filter @rss-summary/backend test`(node標準テストランナー。R2 state の新規テスト含む、`fetch` をモック)
- `pnpm --filter @rss-summary/frontend test`(`isDigestFresh` / cron 分岐)
- 全パッケージ typecheck(`astro check` + `tsc -p apps/frontend/worker/tsconfig.json` + backend/shared)
- `wrangler dev --test-scheduled` でフロントWorkerの `scheduled()` をローカル確認
  (`?cron=` で 2 つのスケジュールを個別に検証)
- 手動E2E: Deploy Hook を POST → ビルドログ → R2オブジェクト生成 → サイト反映を確認

## ロールバック

- `.github/workflows/backend-daily-digest.yml` はgit履歴から復元可能。GitHub Secrets を再設定。
- `apps/frontend/wrangler.jsonc` から `main` と `triggers` を外して再デプロイ + Workers Builds の
  ビルド設定を元(`apps/frontend` ルート、astro buildのみ、自動ビルド再有効化)に戻す。
- **state の乖離に注意**: カットオーバー後 `state` ブランチは凍結され R2 が最新になる。
  数日以内に戻すか、戻す前に R2 の `state/read-guids.json` を `state` ブランチへ再同期する
  (しないと GH Actions が古い state を読んで数日分を再通知する)。
- `state` ブランチは移行後しばらく残置する。

## スコープ外(YAGNI)

- 専用のスケジューラWorker / 専用のバックエンド用 Workers Builds プロジェクト。
- Workers Builds Event Subscriptions(Queue経由)での高度な通知。
- ウォッチドッグのライブサイト確認への拡張。
- state の履歴管理(git履歴の代替)。state はキャッシュ用途のため不要。
