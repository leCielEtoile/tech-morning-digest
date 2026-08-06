# AI-CONTEXT

実装を継続・修正するAI(Claude Code)向けの技術リファレンス。要件・設計判断の正は [`spec.md`](../spec.md)。リポジトリはpnpm workspaceモノレポ(`apps/backend` + `apps/frontend` + `packages/shared`)。

## 共有パッケージ(`packages/shared`)

`apps/backend`・`apps/frontend`の両方が使う純粋関数のみを置く(`@rss-summary/shared`)。現状は`toJstDateString`のみ。**日付処理を新規に書く前に、まずここに既にないか確認すること**(2026-08-05のコードレビューで、backendとfrontendに同一実装が重複しているのが見つかり、ここへ統合した経緯がある)。両アプリの`package.json`に`"@rss-summary/shared": "workspace:*"`として依存を追加済み。

## バックエンド(`apps/backend`)モジュール依存関係

```
src/index.ts (メインオーケストレーター)
├── config/feeds.ts        (FEEDS, CATEGORY_ORDER, MAX_ITEMS_PER_FEED — 依存なし)
├── fetch/feed-fetcher.ts  → fetch/feed-parser.ts, utils/retry.ts
├── state/read-state.ts    (git worktreeでstateブランチを読み書き。依存なし)
├── ai/gemini-client.ts    → config/feeds.ts (CATEGORY_ORDER), utils/retry.ts
├── digest/digest-payload.ts (R2保存用JSONペイロード構築。依存なし)
├── publish/r2-client.ts   → aws4fetch, utils/retry.ts
├── publish/deploy-hook.ts → utils/retry.ts
├── utils/retry.ts          (共通リトライユーティリティ、他モジュールに依存しない)
└── @rss-summary/shared     (toJstDateString。旧utils/date.tsはここへ統合済み)
```

`types.ts` の `Article` 型が `feed-parser` → `feed-fetcher` → `index.ts` → `gemini-client`/`state` を横断する中心的なデータ構造。

**HTML変換はバックエンドの責務ではない**(旧`render/render-digest.ts`は削除済み)。バックエンドはGeminiの構造化出力(JSON)をそのままR2に保存するのみで、HTML化はフロントエンド(Astro)のビルド時に構造化データを直接テンプレートへ埋め込む形で行う(Markdown経由ではない。2026-08-05変更、詳細はspec.md 5章)。

## フロントエンド(`apps/frontend`)モジュール依存関係

```
src/content.config.ts (digestsコレクション定義)
└── src/lib/digests-loader.ts (Content Layer APIのカスタムローダー)
    ├── src/lib/r2-client.ts     → aws4fetch(読み取り専用のgetR2Object)
    └── src/lib/digest-dates.ts (recentJstDates。日付計算自体は @rss-summary/shared の toJstDateString を利用)

src/pages/index.astro          → src/components/DigestBody.astro, src/layouts/BaseLayout.astro
src/pages/archive/index.astro  → src/layouts/BaseLayout.astro, src/lib/format-date.ts
src/pages/archive/[date].astro → src/components/DigestBody.astro, src/layouts/BaseLayout.astro
```

## デザインシステム(`apps/frontend/src/styles/global.css`)

「Morning Wire」コンセプト(2026-08-05実装、spec.md 0章参照)。トークンは全てCSSカスタムプロパティで`:root`と`@media (prefers-color-scheme: dark)`に定義。

- **配色**: `--paper`(背景)・`--ink`(本文)・`--ink-muted`(メタ情報)・`--rule`(罫線)・`--signal`(アクセント、この1色のみ)。ライト/ダーク両方でWCAG AA(4.5:1以上)を計算済み。**新しい色を追加する前に、まず`--signal`一色という制約を崩さなくて済まないか検討すること**(意図的な設計判断)。
- **フォント**: 和文本文はシステムフォント(Webフォント負荷を避ける判断)。見出し・日付・カテゴリラベルなど欧文/数字要素のみ`@fontsource/space-grotesk`(見出し)・`@fontsource/jetbrains-mono`(メタ情報)のラテン文字サブセット(`latin-*.css`)を自己ホスト。
- **重要な罠**: `global.css`はAstroのスコープ付き`<style>`ブロックではなく素のグローバルCSSとしてインポートしているため、**`:global()`疑似クラスは無効**(黙って無視される)。`.digest-content`配下のセレクタは全て`:global()`なしのプレーンなセレクタで書くこと。
- **ダイジェスト本文のスタイリングは実クラスベース**(2026-08-05変更): 旧来はGemini出力Markdownの見出し出現順に依存する`h2:nth-of-type()`セレクタだったが、構造化JSON出力への移行に伴い`DigestBody.astro`が`.three-lines`(今日の3行)・`.picks-heading`/`.picks-list`(Today's Pick、シグネチャー要素)・`.category-list`(カテゴリ別)を直接テンプレートで出し分けるようになったため、CSSも実クラス名を直接セレクタにしている。順序依存の脆さは解消済み。
- **各ページの実質的なh1**: `DigestBody.astro`が日付(`.digest-date`)を`<h1>`として描画する。構造化データへの移行でGemini生成の定型文h1自体が存在しなくなったため、非表示化のハックは不要になったが、日付をh1とする構造自体は踏襲している。ページに新しい見出し構造を足す場合、h1が二重にならないよう注意すること。

`digests-loader.ts`の設計(2026-08-05のコードレビューで修正): 各日の取得(`loadOneDay`)は取得失敗・JSON不正・スキーマ不一致のいずれでも例外を投げずnullを返す。取得自体は`Promise.all`で並行実行する。**1日分の異常でビルド全体を失敗させないという設計意図を壊さないよう、ここに`try/catch`なしの`JSON.parse`や素のawaitループを書き足さないこと。**

- ビルド時、`digestsLoader`がR2から直近14日分(`ARCHIVE_DAYS`)の`{date}.json`を取得し、`digests`コンテンツコレクションとして公開する。存在しない日(404)はスキップし、ビルド全体は失敗させない。不正な形式のJSONも同様にスキップ(warn ログを出す)。
- **Markdownレンダリングは廃止**(2026-08-05): R2のJSONペイロード自体が構造化データ(`threeLines`/`picks`/`categories`)なので、`renderMarkdown`ヘルパーや`render(entry)`/`<Content />`は使わない。`DigestBody.astro`が`entry.data`のフィールドを直接テンプレートに埋め込んで描画する。

## 主要な型

```ts
// apps/backend/src/types.ts
interface Article {
  title: string;
  link: string;
  guid: string;          // RDFにはguidがないためlinkにフォールバック(feed-parser.ts)
  feedName: string;
  summary: string;
  pubDate: string | null; // ISO8601
}
// 2026-08-05変更: category フィールドは削除。カテゴリはフィード単位の静的マッピングではなく
// Geminiが記事ごとに判定する(spec.md 4章)。フィード側(FeedDefinition)もcategoryを持たない。

// apps/backend/src/config/feeds.ts
type Category = "クラウド・インフラ" | "開発・プログラミング" | "ガジェット・ハードウェア"
  | "総合IT・テックニュース" | "カルチャー・海外トレンド" | "個人ブログ・コラム";
// CATEGORY_ORDER: Category[] — Geminiの構造化出力(responseSchema)のenum制約として使う
type FeedFormat = "rss1.0" | "rss2.0" | "atom";

// apps/backend/src/state/read-state.ts
type ReadState = Record<string, string>; // guidHash(sha256) -> 最終既読日時(ISO8601)

// apps/backend/src/ai/gemini-client.ts (Geminiの構造化出力をパースした後の結果)
interface GeminiDigestResult {
  threeLines: string[];
  picks: { article: Article; reason: string }[];
  categories: { category: Category; articles: { article: Article; gist: string }[] }[]; // 空カテゴリはフィルタ済み、CATEGORY_ORDER順
}
// gist: 記事内容を一行(30〜50文字程度)で要約したあらすじ。Geminiが記事のsummaryから生成する(2026-08-06追加)。

// apps/backend/src/digest/digest-payload.ts (= apps/frontend/src/lib/digests-loader.ts の DigestPayload と一致させること)
interface DigestPayload {
  date: string;          // JST日付(YYYY-MM-DD)。R2オブジェクトキー {date}.json と一致
  generatedAt: string;   // ISO8601
  hasNewArticles: boolean;
  threeLines: string[];                                                 // 新着なしの場合は空配列
  picks: { title: string; link: string; feedName: string; reason: string }[];
  categories: { category: Category; articles: { title: string; link: string; feedName: string; gist: string }[] }[];
}
// 2026-08-05変更: markdown: string を廃止し、構造化フィールドに置き換えた(spec.md 5章)。
// title/link/feedNameはGeminiの出力ではなく、バックエンドが持つArticleデータから復元したもの。
```

## 実装上の重要な不変条件

これらはspec.mdに明記されていないか簡潔にしか触れられていない、実装時に発見・決定した制約。**変更する際は理由を理解した上で行うこと。**

1. **state commitのタイミング**(`apps/backend/src/index.ts`): `commitReadState()` はGemini生成 + R2書き込みが両方成功した後にのみ呼ぶ。Gemini失敗時に既読化すると、その記事が二度と新着として扱われなくなるため。**さらに、`commitReadState()`は`triggerDeployHook()`より必ず先に呼ぶこと**(2026-08-05の実運用検証で発見・修正: 逆順だとDeploy Hook失敗時にstateが未更新のまま終了し、翌日以降に同じ記事群を再度Geminiへ渡す無駄打ちが発生する。R2書き込みが成功した時点でその日の内容は確定しているため、既読化を先に行うのが正しい。spec.md 2章のフロー図の順序と一致させること)。
2. **GUIDハッシュのフィード名混入**(`state/read-state.ts` の `computeGuidHash`): `sha256(feedName + "::" + guid)` としているのは、異なるフィード間でGUIDが偶然一致した場合の衝突を避けるため。
3. **state操作はgit worktreeで実施**(`state/read-state.ts` の `commitReadState`): `main`ブランチの作業ツリーを一切変更せずに`state`ブランチへコミットするため、`--detach`な一時worktreeを使う。ここを素朴な`git checkout state`に書き換えると、CI実行中の`main`チェックアウトを破壊する。
4. **フィード取得は最新50件まで**(`config/feeds.ts` の `MAX_ITEMS_PER_FEED`): stateが失われた/古くなった場合でも過去記事を無限に新着扱いしないためのフェイルセーフ。
5. **既読GUIDのプルーニングは14日**(`state/read-state.ts` の `PRUNE_AFTER_DAYS`): 低頻度フィードでワークフローが14日以上停止すると再通知が起きうるが、個人用途では許容(spec.md 6章)。
6. **Gemini呼び出し失敗時はプロセスを非ゼロ終了**(`index.ts`): GitHub Actionsの標準失敗通知(ワークフロー作成者へのメール)に検知を委ねている。ここを握りつぶすと運用上の異常に誰も気づけなくなる。
7. **R2オブジェクトが存在しない日はビルドエラーにしない**(`apps/frontend/src/lib/digests-loader.ts`): ワークフロー未実行日・stateなし初回デプロイ等で該当日のJSONが無いのは正常系。404を握りつぶしてスキップする設計を崩さないこと。
8. **フロントエンドのR2アクセスは読み取り専用**(`apps/frontend/src/lib/r2-client.ts`): バックエンドの`r2-client.ts`(書き込み用)とは別モジュール。GETのみで、PUTする権限をフロントエンドのビルド環境に持たせる必要はない(最小権限の原則。R2トークンを分ける場合はRead-onlyで発行する)。
9. **R2の30日ライフサイクルとフロントエンド表示の14日は別軸**: R2側の自動削除(`wrangler r2 bucket lifecycle`)はストレージコスト管理、フロントエンドの`ARCHIVE_DAYS`は表示範囲の方針。どちらか一方だけを変更しても他方に自動連動しないため、意図的に変える場合は両方を確認すること。

## バージョン固定方針(2026-08-02、LLM学習データのカットオフ対策として実施)

依存関係・CI環境は全て`npm view`/GitHub API等で実際に最新版を再検索した上でexact pin(範囲指定`^`/`~`を使わない)している。学習データにある古いバージョン想定でコードを書かないこと。

- **npm依存**: 各`apps/*/package.json`の`dependencies`/`devDependencies`は全てexactバージョン。ルートの`.npmrc`に`save-exact=true`を設定し、今後`pnpm add`する際も自動でexact pinになるようにしてある
- **パッケージマネージャー**: ルート`package.json`の`packageManager`フィールドで`pnpm@11.18.0`を固定。`pnpm/action-setup`はこのフィールドを自動で読むため、ワークフロー側に`version`指定は不要
  - **2026-08-06変更**: 当初はCorepack方式のintegrity hash付き(`pnpm@11.18.0+sha512-...`)で固定していたが、Cloudflare Workers Buildsの実機検証で「Invalid package manager specification...expected a semver version」エラーが発生することを確認した。Workers Buildsのツール検出処理は`packageManager`フィールドをhashサフィックスなしの単純なsemverとして解析するため、`PNPM_VERSION`ビルド環境変数を設定しても回避できない(検出結果が`pnpm@10.11.1`のまま変わらないことを実際のビルドログで確認済み)。そのためhashサフィックスを外し`pnpm@11.18.0`のみに変更した。GitHub Actions側(`pnpm/action-setup`)はhashなしの形式でも問題なく動作する。
- **ビルドスクリプト承認**: pnpm 11は依存パッケージのpostinstallスクリプトを既定でブロックする。許可リストは`package.json`ではなく**`pnpm-workspace.yaml`の`allowBuilds`**に書く(pnpm 10→11で設定の置き場所が変わった。`package.json`の`pnpm`フィールドは11ではもう読まれない)。`esbuild`(tsx用)・`workerd`(wrangler用)を許可済み
- **GitHub Actions**: `.github/workflows/backend-daily-digest.yml`内の各ActionはコミットSHAで固定(タグは可変なため)。バージョンはインラインコメントに明記。`runs-on`も`ubuntu-latest`ではなく`ubuntu-24.04`と明示固定(2026-08-02時点で`ubuntu-latest`が指す安定版。`ubuntu-26.04`はまだpublic preview)
- **Node.js**: ワークフローの`node-version`は`"lts/*"`のような可変指定ではなく`"24.18.1"`(2026-08-02時点のNode 24 LTS最新パッチ)を明示

### TypeScript 7へのメジャーアップグレードで踏んだ罠

TypeScriptは5.9系から**6系を飛ばして7.0.2**へ移行している(Microsoft公式のネイティブ移植版、`microsoft/TypeScript`リポジトリで確認済み)。このメジャーアップグレードで、`tsconfig.json`に`"types": ["node"]`を明示しないと`@types/node`のグローバル型(`process`, `console`, `fetch`, `Response`, `URL`, `node:*`モジュール等)が一切解決されなくなった(`apps/backend`で対応済み)。旧バージョンでは`node_modules/@types`配下が暗黙的に読み込まれていたが、その挙動に依存しないこと。

**さらに`apps/frontend`では、`@astrojs/check`が依存する言語サーバーがTypeScript 7の programmatic API(Language Service API)にまだ対応していない**(2026-08-02時点、[公式ロードマップで追跡中](https://github.com/withastro/roadmap/discussions/1321))。この非互換は`astro check`実行時にのみ顕在化し、`astro build`自体は影響を受けない可能性があるが、切り分けの手間を避けるため`apps/frontend`は`typescript@6.0.3`(安定版として存在する最後のJSベース実装)に固定している。**この制約が解消されたことを確認できるまで、`apps/frontend`のtypescriptを7系へ揃えないこと。** `apps/backend`は`astro check`を使わないため7.0.2のまま問題ない。

## 既知のリスク(未対応、意図的に見送り)

- GitHub Actionsは60日間コミットがないとscheduled workflowを自動無効化する。`state`ブランチへのコミットがこの判定に含まれるかは公式ドキュメントで断定できなかった。keepaliveワークフローや外部デッドマンズスイッチは未導入(spec.md 9章)。

## 外部連携先の確認済み仕様(2026-08-02時点)

- **Gemini API**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`、認証は`x-goog-api-key`ヘッダー。デフォルトモデルは`gemini-3.6-flash`(環境変数`GEMINI_MODEL`で上書き可)。モデル世代・無料枠は変動するため実装変更時は要再確認。
- **R2 S3互換API**: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>`。認証はR2専用のAccess Key ID/Secret Access Keyペア(通常のCloudflare APIトークンとは別種)。署名は`aws4fetch`(軽量、`@aws-sdk`不使用)。バックエンド(書き込み)・フロントエンド(読み取り)の両方で同じライブラリ・同じ認証方式を使う。
- **R2 Object Lifecycle Rules**: `npx wrangler r2 bucket lifecycle add <BUCKET> <NAME> --expire-days 30` のようにCLIで一度設定するだけで、カスタムの削除コード不要でオブジェクトを自動削除できる(反映まで最大24時間程度)。
- **rss-parser**: RSS1.0(RDF)/RSS2.0/Atomいずれも実データで動作確認済み。RDFには`guid`/`id`が存在しないため`link`へのフォールバックが必須。Atomの`id`は型定義に含まれないため`Parser<{}, {id?: string}>`のカスタムフィールド指定で型を補っている(`fetch/feed-parser.ts`)。
- **Astro Content Layer API**: `defineCollection({ loader })`のカスタムローダーはビルド時にのみ実行される。`load()`コンテキストは`renderMarkdown`ヘルパーも提供する(Markdown→HTMLの事前レンダリング、`marked`等の追加ライブラリ不要)が、本プロジェクトではR2から取得するのが最初から構造化JSONのため使用していない(2026-08-05のMarkdown廃止に伴い不要になった)。SSG出力(`output: "static"`、デフォルト)でCloudflare Workersにデプロイする場合、`@astrojs/cloudflare`アダプターは不要で、`wrangler.jsonc`の`assets.directory`のみで完結する。
- **Workers Builds**: モノレポでは「Root directory」でサブディレクトリを指定し、「Build Watch Paths」で該当ディレクトリ配下の変更時のみビルドをトリガーできる。Deploy Hooksにも対応済み(2026年4月〜)。
