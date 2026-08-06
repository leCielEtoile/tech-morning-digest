# Tech Morning Digest — 実装計画(AI実装担当者向け)

このドキュメントは `spec.md` の内容を実装可能な単位に分解したものです。実装を開始するAI(Claude Code)は、まず `spec.md` を通読してから本計画に従って進めること。**spec.mdと本計画が矛盾する場合はspec.mdを正とし、疑問があればユーザーに確認する。**

各Phaseは独立してテスト・レビュー可能な単位に分割してある。Phase番号順に進めることを推奨するが、依存関係がなければ並行して着手してよい。

> **本ドキュメントはバックエンド(`apps/backend`)実装時の計画であり、全Phase完了済み。** その後追加したフロントエンド(`apps/frontend`、Astro)およびpnpm workspaceモノレポへの再構成は本ドキュメントには含まれていない。フロントエンドの設計判断はspec.md 0章「フロントエンド実装ログ」、セットアップ手順は[README.md](./README.md)、実装上の不変条件は[AI-CONTEXT.md](./AI-CONTEXT.md)を参照。

---

## Phase 0: プロジェクト基盤セットアップ

- [x] `git init`。`main`ブランチで開始
- [x] 言語はTypeScript(CLAUDE.mdのコーディング規約に準拠: `any`禁止、型を明示的に定義)。`tsx`でトランスパイル不要に実行
- [x] `package.json` 作成。`"type": "module"`、`engines.node >= 20`。**パッケージマネージャーはpnpm**(CLAUDE.mdの指定通り。当初npmで進めてしまい後から`pnpm-lock.yaml`へ切り替えた経緯あり)
- [x] `.gitignore` 作成(`node_modules/`, `.env`, `.envrc`, `dist/` 等)
- [x] `tsconfig.json` 作成(strict: true)
- [x] ディレクトリ構成を以下のように作成:

```
rss-summary/
├── .github/
│   └── workflows/
│       └── daily-digest.yml       # Phase 12
├── src/
│   ├── index.ts                   # メインオーケストレーター(Phase 11)
│   ├── config/
│   │   └── feeds.ts                # フィード定義・カテゴリ分類(Phase 1)
│   ├── fetch/
│   │   ├── feed-fetcher.ts         # フィード取得+リトライ(Phase 2)
│   │   └── feed-parser.ts          # RSS1.0/RSS2.0/Atom正規化(Phase 2)
│   ├── state/
│   │   └── read-state.ts           # 既読GUID管理・stateブランチ操作(Phase 3)
│   ├── ai/
│   │   └── gemini-client.ts        # プロンプト構築・Gemini API呼び出し(Phase 5)
│   ├── render/
│   │   └── render-digest.ts        # Markdown→HTML変換・ページ生成(Phase 7)
│   ├── publish/
│   │   ├── r2-client.ts            # R2アップロード(Phase 8)
│   │   └── deploy-hook.ts          # Deploy Hook POST(Phase 9)
│   └── utils/
│       └── retry.ts                # 汎用指数バックオフ+ジッター(Phase 10)
├── test/
│   └── fixtures/                   # サンプルXML(RSS1.0/2.0/Atom各1件以上)
├── package.json
├── tsconfig.json
├── .gitignore
├── spec.md
└── docs/
    └── IMPLEMENTATION_PLAN.md      # 本ファイル
```

- [ ] `state` 専用ブランチを作成する(**GitHubリモートリポジトリの作成後にユーザー側で実施が必要**。ローカルではfakeリモートを使い、下記コマンドの動作自体は検証済み):
  ```sh
  git checkout --orphan state
  git rm -rf .
  echo '{}' > read-guids.json
  git add read-guids.json
  git commit -m "chore: state ブランチ初期化"
  git push -u origin state
  git checkout main
  ```
  (`{}` はGUIDハッシュ→既読日時ISO8601のマップ。spec.md 6章参照)

---

## Phase 1: フィード定義・カテゴリ分類

`src/config/feeds.ts` に spec.md 3章・4章の内容をそのままコード化する。

```ts
export type Category =
  | "クラウド・インフラ"
  | "開発・プログラミング"
  | "ガジェット・ハードウェア"
  | "総合IT・テックニュース"
  | "カルチャー・海外トレンド"
  | "個人ブログ・コラム";

export type FeedFormat = "rss1.0" | "rss2.0" | "atom";

export interface FeedDefinition {
  name: string;
  url: string;
  format: FeedFormat;
  category: Category;
}

export const FEEDS: FeedDefinition[] = [
  // spec.md 3章の17フィードをそのまま列挙。URLは2026-08-02確認済み。
  // 例:
  // { name: "AKIBA PC Hotline", url: "https://akiba-pc.watch.impress.co.jp/data/rss/1.0/ah/feed.rdf", format: "rss1.0", category: "ガジェット・ハードウェア" },
  // ...
];
```

- [x] spec.md 3章の17行すべてを転記(`src/config/feeds.ts`)
- [x] spec.md 4章のカテゴリ対応表をそのまま反映

---

## Phase 2: RSSフィード取得・パース

`src/fetch/feed-fetcher.ts` と `src/fetch/feed-parser.ts`。

### 正規化後のデータ型

```ts
export interface Article {
  title: string;
  link: string;
  guid: string;        // フィードのGUID、なければlinkを使用
  feedName: string;
  category: Category;
  summary: string;      // 概要(あれば)。プロンプトに渡す
  pubDate: string | null; // ISO8601、取得できなければnull
}
```

### 実装要件

- [x] RSS1.0(RDF)・RSS2.0・Atomの3フォーマットを`rss-parser`で正規化して`Article[]`を返すパーサーを実装。実データ(3フィード)で3フォーマットとも問題なく動作することを確認済み。RDFに`guid`/`id`がないため`link`にフォールバックする実装とした
- [x] フィード取得は spec.md 8章の表に従いリトライ実装(最大3回、初回1秒→上限8秒、指数バックオフ+ジッター)。`src/utils/retry.ts`の共通関数を利用
- [x] 1フィードが最終的に失敗しても他フィードの処理を継続する(失敗ログを残す)
- [x] **各フィードにつき取得件数を最新50件までに制限する**(spec.md 6章のフェイルセーフ設計)
- [x] テスト: `test/fixtures/`に3フォーマットそれぞれの実データXMLを用意し、パーサー単体でテスト(`src/fetch/feed-parser.test.ts`、ネットワーク不要)

---

## Phase 3: 既読状態管理(state file)

`src/state/read-state.ts`。

### データ形式

```ts
// read-guids.json (state ブランチ上)
type ReadState = Record<string, string>; // guidHash -> ISO8601 (最終既読記録日時)
```

- GUIDハッシュの生成: `sha256(feedName + "::" + guid)` を推奨(フィード間のGUID衝突を避ける)

### 実装要件

- [x] 実行開始時に`state`ブランチから`read-guids.json`を`git show origin/state:read-guids.json`で取得する(`loadReadState`)
- [x] 新着記事抽出: 取得記事のGUIDハッシュが`ReadState`に存在しなければ新着(`filterNewArticles`)
- [x] プルーニング: 記録日時が**14日**より古いエントリは削除する(`pruneReadState`。境界値テスト済み)
- [x] **重要な順序制約**: state fileの更新・コミットは、Gemini生成 + R2書き込みが両方成功した後にのみ行う(`index.ts`で実装)
- [x] `state`ブランチへのコミット・push処理を実装。git CLIを`child_process.execFile`で直接呼び、`git worktree add --detach`で`main`の作業ツリーを一切変更せずコミットする方式を採用(`commitReadState`)。fakeリモートでの実データ検証済み(読込→新着判定→コミット→再読込での反映→no-op時の安全性まで確認)
- [x] 同時実行防止: GitHub Actions側で`concurrency`設定(Phase 12)。モジュール自体に排他制御は不要

---

## Phase 4〜7: ダイジェスト生成

### Phase 4: カテゴリ別グルーピング

- [x] 新着記事を`Category`ごとにグルーピングし、Gemini向けプロンプトのJSON構造を組み立てるヘルパーを実装(`gemini-client.ts` 内 `groupArticlesByCategory`)

### Phase 5: Gemini API連携(`src/ai/gemini-client.ts`)

- [x] spec.md 5章のプロンプトテンプレートに従い、記事データを埋め込んだプロンプトを構築(`buildPrompt`)
- [x] モデルは`gemini-3.6-flash`をデフォルトとし、環境変数`GEMINI_MODEL`で上書き可能にした(spec.md 7章。2026-08-02時点でモデル世代が2.5系→3.x系に進んでいることをcontext7経由で確認し、当初計画のgemini-2.5-flashから修正)
- [x] リトライ: spec.md 8章の表(最大3回、初回2秒→上限16秒)。429時は`Retry-After`ヘッダーを優先(`GEMINI_RETRY_OPTIONS`)
- [x] 全リトライ失敗時: 例外をthrowし、呼び出し元(`index.ts`)で「前日ページ維持・state更新なし」のフローに分岐させる

### Phase 6: 新着0件時のフォールバック

- [x] 新着記事が0件の場合、Gemini呼び出しをスキップし「本日は新着なし」の簡易HTMLを生成する処理を実装(`renderNoNewArticlesPage`)

### Phase 7: Markdown→HTML変換(`src/render/render-digest.ts`)

- [x] Geminiが返すMarkdownを`marked`でHTMLに変換
- [x] 最低限のHTMLシェルでラップ。デザインはスコープ外(spec.md 12章)のため装飾なし
- [x] 出力ファイル名は`{YYYY-MM-DD}.html`(JST日付基準。`utils/date.ts` の `toJstDateString` でUTC→JST変換、境界値テスト済み)

---

## Phase 8: R2アップロード(`src/publish/r2-client.ts`)

- [x] R2への書き込み方式を確定: **S3互換API + `aws4fetch`** を採用(フルの`@aws-sdk`は不使用)。Cloudflare公式ドキュメントでエンドポイント形式・認証方式(R2専用Access Key ID/Secret Access Keyペア)を確認済み(spec.md 10章・11章)
- [x] アップロード先キーは`{YYYY-MM-DD}.html`
- [x] リトライ: spec.md 8章の表(最大3回、初回1秒→上限8秒)

---

## Phase 9: Deploy Hook呼び出し(`src/publish/deploy-hook.ts`)

- [x] R2書き込み成功後、`DEPLOY_HOOK_URL`へ単純な`POST`(認証ヘッダー不要、spec.md 10章)
- [x] リトライ: spec.md 8章の表(最大3回、初回1秒→上限8秒)

---

## Phase 10: 共通リトライユーティリティ(`src/utils/retry.ts`)

- [x] spec.md 8章の疑似コードを実装した汎用関数を作成し、Phase 2・5・8・9すべてから利用する。429時の`Retry-After`ヘッダー優先、リトライ可否判定(`isTransientError`)も実装。ユニットテスト済み(`retry.test.ts`):

```ts
interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterHeader?: boolean; // 429時にRetry-Afterを優先するか
}

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> { /* ... */ }
```

---

## Phase 11: メインオーケストレーター(`src/index.ts`)

spec.md 2章のフロー図通りに以下を実装する。

1. `state`ブランチから既読GUID一覧を取得(Phase 3)
2. 全フィードを並行 or 逐次取得・パース(Phase 2)。**Free枠は関係ないが、対象サイトへの配慮として同時接続数は程よく制限する(例: 4〜6並行)**
3. 既読GUIDと突き合わせて新着記事を抽出(Phase 3)
4. 新着が0件 → Phase 6の「新着なしページ」を生成 → R2書き込み(Phase 8)→ Deploy Hook(Phase 9)→ state commit(実質no-op、Phase 3)
5. 新着がある場合:
   a. Gemini呼び出し(Phase 5)
   b. 成功 → Markdown→HTML変換(Phase 7)→ R2書き込み(Phase 8)→ Deploy Hook(Phase 9)→ state commit(新着GUIDを既読化・プルーニング、Phase 3)
   c. 失敗(リトライ全滅)→ 前日ページを変更しない(R2書き込みしない)。state commitも行わない(新着記事は翌日以降も新着扱いのまま)。ログを残し、非ゼロ終了コードでプロセスを終了させ、GitHub Actionsの失敗通知が飛ぶようにする(spec.md 7章・9章)

[x] 上記の全フローを`src/index.ts`に実装済み。concurrency=5での並行フィード取得、全フィード失敗時のフォールバック警告ログも実装。全体のデッドラインはGitHub Actionsワークフロー側の`timeout-minutes`(15分)で管理し、個々の処理の最大リトライ・上限遅延により壁時間は自然に頭打ちになる設計(spec.md 8章補足)。**mockしたGemini/R2/Deploy Hook + 実データ17フィードでのEnd-to-Endドライラン、および2回連続実行での既読化の冪等性を確認済み**

---

## Phase 12: GitHub Actionsワークフロー(`.github/workflows/daily-digest.yml`)

- [x] `schedule: cron: '30 23 * * *'`(spec.md 9章)
- [x] `permissions: contents: write`(`state`ブランチへのpushに必要)
- [x] `concurrency:` グループを設定し、前回実行が長引いた場合の重複実行を防ぐ
- [x] `workflow_dispatch:` トリガーも追加し、手動での動作確認を可能にする
- [x] `timeout-minutes: 15` を明示的に設定(spec.md 8章補足、ジョブ全体の暴走防止)
- [x] ステップ: checkout(`main`)→ pnpmセットアップ → Node.jsセットアップ → 依存インストール(`pnpm install --frozen-lockfile`)→ `pnpm start`実行 → 環境変数はすべて`secrets.*`から注入
- [x] YAML構文を`js-yaml`でパース検証済み

---

## Phase 13: GitHub Secrets設定(値はユーザーが登録、コードには含めない)

| Secret名 | 用途 |
|---|---|
| `GEMINI_API_KEY` | Gemini API認証 |
| `CLOUDFLARE_ACCOUNT_ID` | R2エンドポイント(`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)の組み立てに使用 |
| `R2_ACCESS_KEY_ID` | R2専用APIトークンのAccess Key ID(通常のCloudflare APIトークンとは別種。spec.md 11章) |
| `R2_SECRET_ACCESS_KEY` | 同トークンのSecret Access Key |
| `R2_BUCKET_NAME` | 書き込み先バケット名 |
| `DEPLOY_HOOK_URL` | Cloudflare Pages/Workers Builds Deploy Hook URL |

- [x] `state`ブランチへのpushは既定の`GITHUB_TOKEN`(`contents: write`権限)で足りるため追加シークレット不要(spec.md 11章)
- [ ] **上記Secretの値自体の発行・登録はユーザー側の作業として未実施**(GitHubリポジトリ作成後に対応)

---

## Phase 14: テスト・検証

- [x] Phase 2のパーサーを`test/fixtures/`の実データXMLでユニットテスト(`feed-parser.test.ts`、ネットワーク不要)
- [x] Phase 3の新着判定・プルーニングロジックをユニットテスト(`read-state.test.ts`。14日ちょうど/14日+1msの境界値を確認)
- [x] `retry.ts`・`date.ts`もユニットテスト追加(計19テスト、全パス)
- [x] Gemini/R2/Deploy Hookをモックした、実データ17フィードでのEnd-to-Endドライランをローカルで実施(fetchをインターセプトする方式)。stateブランチへの実際のコミット・pushもfakeリモートで検証済み
- [ ] `workflow_dispatch`での実際の手動実行確認(GitHubリポジトリ・Secrets登録後にユーザー側で実施が必要):
  - R2に当日ファイルが生成されること
  - Cloudflare Pagesが再ビルドされ、サイトに反映されること
  - `state`ブランチに正しくGUIDが追記されること
  - 新着0件を意図的に発生させた場合に「新着なしページ」が生成されること
  - Gemini呼び出しを意図的に失敗させた場合に前日ページが維持されること

---

## Phase 15: ドキュメント更新

実装完了後、CLAUDE.mdの指示(「実装を終えたら必ずドキュメントの更新を行ってください」)に従い以下を行う。

- [x] `CLAUDE.md`の「ランタイム: Cloudflare Workers」という記述を実態(GitHub Actions + Cloudflare R2/Pages)に合わせて更新した。プロジェクト構造・パッケージマネージャー(pnpm)の記述も更新
- [x] `spec.md` 13章のチェックリストのうち実装により解消した項目にチェックを入れた
- [x] `docs/README.md`を新規作成し、セットアップ手順(Secrets登録、stateブランチ初期化、初回手動実行の方法)をまとめた
- [x] `docs/AI-CONTEXT.md`を新規作成し、型定義・主要モジュールの依存関係・実装上の重要な不変条件を記載した

---

## 実装順序のサマリ

依存関係を考慮した推奨実装順: **Phase 0 → 1 → 2 → 10 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 11 → 12 → 13 → 14 → 15**

(Phase 10の共通リトライは Phase 2 の直後に作っておくと、以降のPhaseで使い回せる)
