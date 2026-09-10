# Cloudflareへの定期実行一本化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 毎朝のダイジェスト生成を GitHub Actions から Cloudflare(Workers Builds + フロントWorkerの Cron Trigger + R2)へ移し、GitHub Actions と `state` ブランチへの依存をなくす。

**Architecture:** 既存フロントの Workers Builds プロジェクトの build command に backend 生成処理を前置し、1回のビルドで「生成 → R2書き込み → Astroビルド → デプロイ」を完結させる。定期実行は既存フロントWorker(Static Assets)に `scheduled()` ハンドラと2本の Cron Trigger を同居させ、1本目が Deploy Hook を叩き、2本目(ウォッチドッグ)がR2の当日分を確認して失敗時に Webhook 通知する。既読stateは git の `state` ブランチから R2 オブジェクト `state/read-guids.json` へ移行する。

**Tech Stack:** TypeScript / pnpm workspace モノレポ / `tsx`(実行・テスト)/ node標準テストランナー / `aws4fetch`(R2 S3互換API)/ Astro(SSG)/ Cloudflare Workers(Static Assets + Cron Triggers)/ Workers Builds

**Spec:** `docs/superpowers/specs/2026-09-11-cloudflare-consolidation-design.md`

## Global Constraints

- `any` を使用しない。すべての型を明示的に定義する(CLAUDE.md コーディング規約)。
- null/undefined は明示的に型定義する(`string | null`)。
- 依存追加は exact バージョン(ルート `.npmrc` の `save-exact=true`)。
- コミットメッセージは日本語の Conventional Commits 形式。
- コミット末尾に以下を付ける:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ae9NBGrDXxvx6VaW5CdmsS
  ```
- ソースコメントに思考過程・検討過程・代替案の経緯を書かない。非自明な制約・不変条件・相互運用要件・「あえて単純な実装にしない理由」のみコメントする。
- ブランチ: `feat/cloudflare-consolidation`(作成済み)。作業はこのブランチで行う。
- backend の TypeScript は 7.0.2、frontend は 6.0.3 固定。frontend の型検査は `astro check`。
- JST は UTC+9 固定(DSTなし)。日付文字列は `@rss-summary/shared` の `toJstDateString(date: Date): string`(`YYYY-MM-DD`)。
- R2 エンドポイント形式: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>`。認証は R2 専用 Access Key ID / Secret Access Key、署名は `aws4fetch`。
- 既読state R2 オブジェクトキー: `state/read-guids.json`。ダイジェスト JSON と同じバケット。毎実行 PUT する(30日ライフサイクル削除の回避。差分チェックによる skip はしない)。
- Cron 式(UTC): ビルド起動 `30 23 * * *` / ウォッチドッグ `0 2 * * *`。

---

## File Structure

**backend(`apps/backend/src/`)**
- `publish/r2-client.ts`(変更)— R2 の汎用 `getR2Text` / `putR2Text` を追加、`uploadDigestJson` は `putR2Text` の薄いラッパへ。
- `publish/r2-client.test.ts`(新規)— R2 プリミティブの単体テスト(`fetch` モック)。
- `state/read-state.ts`(変更)— git 実装を削除し R2 実装へ。`commitReadState` → `saveReadState`。純粋関数は不変。
- `state/read-state.test.ts`(変更)— `loadReadState` / `saveReadState` のテストを追加。
- `index.ts`(変更)— state 関数の引数変更、Deploy Hook 呼び出しと `DEPLOY_HOOK_URL` を削除、関連コメント更新。
- `publish/deploy-hook.ts`(削除)。

**frontend(`apps/frontend/`)**
- `worker/digest-fresh.ts`(新規)— 純粋関数 `isDigestFresh`。依存なし。
- `worker/digest-fresh.test.ts`(新規)。
- `worker/retry.ts`(新規)— 純粋関数寄りの `postWithRetry`。
- `worker/retry.test.ts`(新規)。
- `worker/index.ts`(新規)— `scheduled()` ハンドラ。Cron 分岐 / R2 署名GET / Webhook通知。`Env` は手書き。
- `worker/tsconfig.json`(新規)— `@cloudflare/workers-types` を用いた worker 専用型検査。
- `wrangler.jsonc`(変更)— `main` と `triggers.crons` を追加。
- `tsconfig.json`(変更)— `exclude` に `worker` を追加(`astro check` の対象外にする)。
- `package.json`(変更)— `@cloudflare/workers-types` / `tsx` を devDep 追加、`test` / `typecheck:worker` スクリプト追加。

**リポジトリ直下**
- `.github/workflows/backend-daily-digest.yml`(削除)。

**ドキュメント**
- `CLAUDE.md` / `docs/AI-CONTEXT.md` / `docs/README.md`(変更)。

---

## Task 1: backend r2-client に getR2Text / putR2Text を追加

**Files:**
- Modify: `apps/backend/src/publish/r2-client.ts`
- Test: `apps/backend/src/publish/r2-client.test.ts`(新規)

**Interfaces:**
- Consumes: `RetryOptions` / `withRetry` / `assertOk`(`../utils/retry.js`、既存)、`R2Config`(同ファイル、既存)。
- Produces:
  - `getR2Text(config: R2Config, key: string): Promise<string | null>` — 404 は `null`。5xx/429 は `withRetry` でリトライ。それ以外の非2xxは throw。
  - `putR2Text(config: R2Config, key: string, body: string, contentType: string): Promise<void>` — `withRetry` でリトライ。
  - `uploadDigestJson(config: R2Config, key: string, json: string): Promise<void>` — 既存シグネチャ維持(内部で `putR2Text` を呼ぶ)。

- [ ] **Step 1: 失敗するテストを書く**

`apps/backend/src/publish/r2-client.test.ts` を新規作成:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { getR2Text, putR2Text } from "./r2-client.js";
import type { R2Config } from "./r2-client.js";

const R2: R2Config = {
  accountId: "acc",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret_test",
  bucketName: "bucket",
};

/** globalThis.fetch を差し替え、渡された Request を検査できるようにする */
function mockFetch(handler: (req: Request) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("getR2Text: 404はnullを返す", async () => {
  const restore = mockFetch(() => new Response("", { status: 404 }));
  try {
    assert.equal(await getR2Text(R2, "state/read-guids.json"), null);
  } finally {
    restore();
  }
});

test("getR2Text: 200は本文をそのまま返す", async () => {
  const restore = mockFetch(() => new Response('{"h":"2026-09-01T00:00:00.000Z"}', { status: 200 }));
  try {
    assert.equal(await getR2Text(R2, "state/read-guids.json"), '{"h":"2026-09-01T00:00:00.000Z"}');
  } finally {
    restore();
  }
});

test("getR2Text: 403など非リトライ対象の非2xxはthrowする", async () => {
  const restore = mockFetch(() => new Response("denied", { status: 403 }));
  try {
    await assert.rejects(() => getR2Text(R2, "k"));
  } finally {
    restore();
  }
});

test("putR2Text: PUTメソッド・本文・Content-Typeを送る", async () => {
  let captured: Request | undefined;
  const restore = mockFetch(async (req) => {
    captured = req;
    return new Response("", { status: 200 });
  });
  try {
    await putR2Text(R2, "state/read-guids.json", "body-text", "application/json; charset=utf-8");
    assert.ok(captured);
    assert.equal(captured.method, "PUT");
    assert.match(captured.url, /\/bucket\/state\/read-guids\.json$/);
    assert.equal(await captured.text(), "body-text");
    assert.equal(captured.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @rss-summary/backend exec tsx --test src/publish/r2-client.test.ts`
Expected: FAIL(`getR2Text` / `putR2Text` が export されていない)

- [ ] **Step 3: 実装する**

`apps/backend/src/publish/r2-client.ts` を次の内容に書き換える(既存の `R2Config` / `R2_RETRY_OPTIONS` は維持):

```ts
import { AwsClient } from "aws4fetch";
import { assertOk, withRetry } from "../utils/retry.js";

// spec.md 8章: R2アクセスは最大3回、初回1秒→上限8秒
const R2_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export interface R2Config {
  accountId: string;
  /** R2用APIトークン(通常のCloudflare APIトークンとは別種。r2/api/tokens/ で発行するAccess Key ID) */
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

function objectUrl(config: R2Config, key: string): string {
  return `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}/${key}`;
}

function r2Client(config: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
}

/**
 * R2から指定キーのテキストを取得する。存在しない(404)場合は null。
 * 5xx/429 はリトライし、その他の非2xxは例外を投げる。
 */
export async function getR2Text(config: R2Config, key: string): Promise<string | null> {
  const client = r2Client(config);
  const url = objectUrl(config, key);
  return withRetry(async () => {
    const response = await client.fetch(url, { method: "GET" });
    if (response.status === 404) {
      return null;
    }
    assertOk(response);
    return response.text();
  }, R2_RETRY_OPTIONS);
}

/** R2へテキストをPUTする(spec.md 10章)。5xx/429 はリトライする。 */
export async function putR2Text(
  config: R2Config,
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  const client = r2Client(config);
  const url = objectUrl(config, key);
  await withRetry(async () => {
    const response = await client.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    assertOk(response);
  }, R2_RETRY_OPTIONS);
}

/**
 * R2へダイジェストのJSONペイロードをアップロードする(spec.md 10章)。
 * HTML変換はフロントエンド(Astro、ビルド時)側の責務のため、バックエンドは構造化データのみを書き込む。
 */
export async function uploadDigestJson(config: R2Config, key: string, json: string): Promise<void> {
  await putR2Text(config, key, json, "application/json; charset=utf-8");
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @rss-summary/backend exec tsx --test src/publish/r2-client.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: backend 全体のテストと型検査**

Run: `pnpm --filter @rss-summary/backend test && pnpm --filter @rss-summary/backend typecheck`
Expected: すべて PASS(既存テストも緑のまま)

- [ ] **Step 6: コミット**

```bash
git add apps/backend/src/publish/r2-client.ts apps/backend/src/publish/r2-client.test.ts
git commit -m "feat(backend): R2の汎用get/put関数を追加しuploadDigestJsonを再構成"
```

---

## Task 2: read-state を git から R2 へ移行

**Files:**
- Modify: `apps/backend/src/state/read-state.ts`
- Test: `apps/backend/src/state/read-state.test.ts`

**Interfaces:**
- Consumes: `getR2Text` / `putR2Text` / `R2Config`(`../publish/r2-client.js`、Task 1)。`createHash`(`node:crypto`、既存)。
- Produces:
  - `STATE_OBJECT_KEY = "state/read-guids.json"`(定数)。
  - `loadReadState(r2: R2Config): Promise<ReadState>` — オブジェクトなし(null)なら `{}`。オブジェクト・配列でない JSON は throw。
  - `saveReadState(r2: R2Config, state: ReadState): Promise<void>` — 常に PUT。
  - 変更なし: `ReadState` 型、`computeGuidHash`、`PRUNE_AFTER_DAYS`、`pruneReadState`、`filterNewArticles`、`markAsRead`。
- 削除: `STATE_BRANCH`、`STATE_FILE_NAME`、`runGit`、`commitReadState`、`node:child_process` / `node:fs/promises` / `node:os` / `node:path` / `node:util` の import。

- [ ] **Step 1: 失敗するテストを追加**

`apps/backend/src/state/read-state.test.ts` の import 行を更新し、末尾にテストを追加する。

import 部を次に置き換え:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { R2Config } from "../publish/r2-client.js";
import {
  computeGuidHash,
  filterNewArticles,
  loadReadState,
  markAsRead,
  pruneReadState,
  saveReadState,
  type ReadState,
} from "./read-state.js";

const R2: R2Config = {
  accountId: "acc",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret_test",
  bucketName: "bucket",
};

function mockFetch(handler: (req: Request) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
```

ファイル末尾に追加:

```ts
test("loadReadState: R2にオブジェクトが無ければ空stateを返す", async () => {
  const restore = mockFetch(() => new Response("", { status: 404 }));
  try {
    assert.deepEqual(await loadReadState(R2), {});
  } finally {
    restore();
  }
});

test("loadReadState: 保存済みJSONをReadStateとして返す", async () => {
  const stored = { [computeGuidHash("FeedA", "guid-1")]: "2026-09-01T00:00:00.000Z" };
  const restore = mockFetch(() => new Response(JSON.stringify(stored), { status: 200 }));
  try {
    assert.deepEqual(await loadReadState(R2), stored);
  } finally {
    restore();
  }
});

test("loadReadState: 配列など不正な形式はthrowする", async () => {
  const restore = mockFetch(() => new Response("[1,2,3]", { status: 200 }));
  try {
    await assert.rejects(() => loadReadState(R2));
  } finally {
    restore();
  }
});

test("saveReadState: state/read-guids.json へ整形済みJSONをPUTする", async () => {
  let captured: Request | undefined;
  const restore = mockFetch(async (req) => {
    captured = req;
    return new Response("", { status: 200 });
  });
  try {
    const state: ReadState = { abc: "2026-09-01T00:00:00.000Z" };
    await saveReadState(R2, state);
    assert.ok(captured);
    assert.equal(captured.method, "PUT");
    assert.match(captured.url, /\/bucket\/state\/read-guids\.json$/);
    assert.deepEqual(JSON.parse(await captured.text()), state);
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @rss-summary/backend exec tsx --test src/state/read-state.test.ts`
Expected: FAIL(`loadReadState` の引数不一致 / `saveReadState` 未export)

- [ ] **Step 3: read-state.ts を書き換える**

`apps/backend/src/state/read-state.ts` を次の内容に:

```ts
import { createHash } from "node:crypto";
import { getR2Text, putR2Text, type R2Config } from "../publish/r2-client.js";

/** guidHash -> 最終既読日時(ISO8601)。spec.md 6章のデータ形式 */
export type ReadState = Record<string, string>;

/** 既読stateを保存するR2オブジェクトキー。ダイジェストJSONと同じバケット。 */
export const STATE_OBJECT_KEY = "state/read-guids.json";
export const PRUNE_AFTER_DAYS = 14; // spec.md 6章(90日→14日に短縮済み)

export function computeGuidHash(feedName: string, guid: string): string {
  return createHash("sha256").update(`${feedName}::${guid}`).digest("hex");
}

/**
 * R2から既読stateを読み込む。オブジェクトが存在しなければ空stateを返す
 * (初回実行・移行前などは正常系)。
 */
export async function loadReadState(r2: R2Config): Promise<ReadState> {
  const content = await getR2Text(r2, STATE_OBJECT_KEY);
  if (content === null) {
    return {};
  }
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${STATE_OBJECT_KEY} の形式が不正です`);
  }
  return parsed as ReadState;
}

/** 記録から PRUNE_AFTER_DAYS 日以上経過したエントリを取り除く(spec.md 6章) */
export function pruneReadState(state: ReadState, now = new Date()): ReadState {
  const cutoffMs = now.getTime() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const pruned: ReadState = {};
  for (const [hash, readAt] of Object.entries(state)) {
    const readAtMs = Date.parse(readAt);
    if (!Number.isNaN(readAtMs) && readAtMs >= cutoffMs) {
      pruned[hash] = readAt;
    }
  }
  return pruned;
}

/** 既読状態に存在しない記事(=新着)のみを返す */
export function filterNewArticles<T extends { feedName: string; guid: string }>(
  articles: T[],
  state: ReadState,
): T[] {
  return articles.filter((article) => !(computeGuidHash(article.feedName, article.guid) in state));
}

/** 指定した記事群を既読化した新しいReadStateを返す(引数のstateは変更しない) */
export function markAsRead<T extends { feedName: string; guid: string }>(
  state: ReadState,
  articles: T[],
  now = new Date(),
): ReadState {
  const nowIso = now.toISOString();
  const updated: ReadState = { ...state };
  for (const article of articles) {
    updated[computeGuidHash(article.feedName, article.guid)] = nowIso;
  }
  return updated;
}

/**
 * 更新後の既読stateをR2へ書き込む。
 *
 * 呼び出しタイミングの制約(実装上の必須事項):
 * この書き込みはGemini生成+ダイジェストのR2書き込みが両方成功した後にのみ実行すること。
 * 失敗時に既読化してしまうと、その記事が二度と新着として扱われなくなるため。
 *
 * 差分の有無に関わらず毎回PUTする。毎日書き換わることでR2の30日ライフサイクル削除を回避する。
 */
export async function saveReadState(r2: R2Config, state: ReadState): Promise<void> {
  await putR2Text(
    r2,
    STATE_OBJECT_KEY,
    `${JSON.stringify(state, null, 2)}\n`,
    "application/json; charset=utf-8",
  );
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @rss-summary/backend exec tsx --test src/state/read-state.test.ts`
Expected: PASS(既存の純粋関数テスト + 追加4件)

- [ ] **Step 5: backend 全体のテストと型検査**

Run: `pnpm --filter @rss-summary/backend test && pnpm --filter @rss-summary/backend typecheck`
Expected: `index.ts` が `commitReadState` を参照しておりここでは **型検査は FAIL する**(Task 3 で解消)。テストは PASS。
→ このステップでは「テストが PASS」「typecheck のエラーが `index.ts` の `commitReadState` / `loadReadState()` 引数のみ」であることを確認する。

- [ ] **Step 6: コミット**

```bash
git add apps/backend/src/state/read-state.ts apps/backend/src/state/read-state.test.ts
git commit -m "feat(backend): 既読stateをstateブランチからR2オブジェクトへ移行"
```

---

## Task 3: index.ts をR2 state化し Deploy Hook 呼び出しを削除、旧ワークフローを削除

**Files:**
- Modify: `apps/backend/src/index.ts`
- Delete: `apps/backend/src/publish/deploy-hook.ts`
- Delete: `.github/workflows/backend-daily-digest.yml`
- Modify: `apps/backend/package.json`(`description` 更新)

**Interfaces:**
- Consumes: `loadReadState(r2)` / `saveReadState(r2, state)`(Task 2)、`uploadDigestJson`(Task 1)。
- Produces: 変更なし(`main` を export、CLI 実行時に起動)。

- [ ] **Step 1: deploy-hook.ts を削除**

```bash
git rm apps/backend/src/publish/deploy-hook.ts
```

- [ ] **Step 2: index.ts を修正**

`apps/backend/src/index.ts` に対し以下を行う:

1. import 行の置き換え:

```ts
import { generateDigestData } from "./ai/gemini-client.js";
import { FEEDS } from "./config/feeds.js";
import { buildDigestPayload } from "./digest/digest-payload.js";
import { fetchAllFeeds } from "./fetch/feed-fetcher.js";
import { uploadDigestJson, type R2Config } from "./publish/r2-client.js";
import {
  filterNewArticles,
  loadReadState,
  markAsRead,
  pruneReadState,
  saveReadState,
} from "./state/read-state.js";
import type { Article } from "./types.js";
import { toJstDateString } from "@rss-summary/shared";
```

2. `Config` インターフェースから `deployHookUrl` を削除:

```ts
interface Config {
  geminiApiKey: string;
  r2: R2Config;
}
```

3. `loadConfig()` から `deployHookUrl` 行を削除:

```ts
function loadConfig(): Config {
  return {
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    r2: {
      accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      bucketName: requireEnv("R2_BUCKET_NAME"),
    },
  };
}
```

4. `main()` 冒頭のコメントブロックを更新:

```ts
// 全体の壁時間の上限は Workers Builds のビルドタイムアウト(20分)で頭打ちになる。
// 個々の処理は各モジュールで最大リトライ・上限遅延が設定済み。
```

5. `loadReadState()` の呼び出しを修正:

```ts
  console.log("[digest] R2から既読状態を読み込み中...");
  const state = await loadReadState(config.r2);
```

6. 新着0件の分岐を修正(`commitReadState` → `saveReadState`、`triggerDeployHook` 行と直前ログを削除):

```ts
  if (newArticles.length === 0) {
    console.log("[digest] 新着0件。hasNewArticles: falseのペイロードを書き込みます(spec.md 6章)");
    const payload = buildDigestPayload({ dateLabel, now, digest: null });
    await uploadDigestJson(config.r2, objectKey, JSON.stringify(payload));
    // R2書き込みが成功した時点でデータは確定しているため既読状態を更新する。
    // 既読化する新着GUIDはないが、プルーニングは実施する。
    await saveReadState(config.r2, pruneReadState(state, now));
    console.log("[digest] 完了(新着なし)");
    return;
  }
```

7. Gemini 失敗分岐のコメントを更新:

```ts
  } catch (error) {
    // Gemini生成が全リトライ失敗した場合、前日ページを維持し既読化もしない(spec.md 7章)。
    // 新着記事は翌日以降も新着として再評価される。プロセスを非ゼロ終了させてビルドを失敗させ、
    // ウォッチドッグcron(翌02:00 UTC)がR2の当日分欠損を検知してWebhook通知する。
    console.error("[digest] Gemini API呼び出しが全リトライ失敗。前日ページを維持します。", error);
    process.exitCode = 1;
    return;
  }
```

8. main 分岐の末尾を修正(`commitReadState` → `saveReadState`、`triggerDeployHook` と直前ログを削除):

```ts
  // R2書き込みが成功した時点でその日の記事内容は確定しているため、既読化を行う。
  console.log("[digest] 既読状態を更新中...");
  const updatedState = pruneReadState(markAsRead(state, newArticles, now), now);
  await saveReadState(config.r2, updatedState);

  console.log(`[digest] 完了。新着${newArticles.length}件を掲載しました`);
```

- [ ] **Step 3: package.json の description を更新**

`apps/backend/package.json` の `description` を:

```json
  "description": "Tech Morning Digest - 生成処理(RSS取得・Gemini要約・R2書き込み・既読state管理)。Workers Buildsのビルドステップで実行する",
```

- [ ] **Step 4: 旧ワークフローを削除**

```bash
git rm .github/workflows/backend-daily-digest.yml
```

- [ ] **Step 5: 参照が残っていないことを確認**

Run: `grep -rn "deploy-hook\|triggerDeployHook\|DEPLOY_HOOK_URL\|commitReadState\|STATE_BRANCH" apps/backend`
Expected: 出力なし(exit 1)

- [ ] **Step 6: backend 全体のテストと型検査**

Run: `pnpm --filter @rss-summary/backend test && pnpm --filter @rss-summary/backend typecheck`
Expected: すべて PASS

- [ ] **Step 7: コミット**

```bash
git add apps/backend/src/index.ts apps/backend/package.json
git commit -m "feat(backend): 既読stateをR2化しビルド内完結のためDeploy Hook呼び出しと定期実行ワークフローを撤去"
```

---

## Task 4: frontend worker — isDigestFresh 純粋関数

**Files:**
- Create: `apps/frontend/worker/digest-fresh.ts`
- Test: `apps/frontend/worker/digest-fresh.test.ts`

**Interfaces:**
- Produces: `isDigestFresh(rawJson: string | null, todayJst: string): boolean` — `rawJson` が `null` / パース不能 / `date !== todayJst` なら `false`。`date === todayJst` なら `true`。依存 import なし。

- [ ] **Step 1: 失敗するテストを書く**

`apps/frontend/worker/digest-fresh.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDigestFresh } from "./digest-fresh.js";

test("isDigestFresh: nullは古い扱い", () => {
  assert.equal(isDigestFresh(null, "2026-09-11"), false);
});

test("isDigestFresh: パース不能なテキストは古い扱い", () => {
  assert.equal(isDigestFresh("not json", "2026-09-11"), false);
});

test("isDigestFresh: dateが当日と一致すれば新鮮", () => {
  assert.equal(isDigestFresh(JSON.stringify({ date: "2026-09-11", generatedAt: "x" }), "2026-09-11"), true);
});

test("isDigestFresh: dateが前日なら古い扱い", () => {
  assert.equal(isDigestFresh(JSON.stringify({ date: "2026-09-10" }), "2026-09-11"), false);
});

test("isDigestFresh: dateフィールドが無ければ古い扱い", () => {
  assert.equal(isDigestFresh(JSON.stringify({ foo: 1 }), "2026-09-11"), false);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @rss-summary/frontend exec tsx --test worker/digest-fresh.test.ts`
Expected: FAIL(`tsx` 未導入なら先に `pnpm --filter @rss-summary/frontend add -D tsx@4.23.1` を実行してからこのステップをやり直す)。導入済みなら「`isDigestFresh` が無い」で FAIL。

- [ ] **Step 3: 実装する**

`apps/frontend/worker/digest-fresh.ts`:

```ts
/**
 * R2から取得した当日分ダイジェストJSONが「当日生成されたもの」かを判定する。
 * オブジェクトキーは `{date}.json` で当日日付のはずだが、ペイロード内の `date` も突き合わせる。
 * 取得失敗(null)・パース不能・日付不一致はすべて「古い(=生成が走っていない)」とみなす。
 */
export function isDigestFresh(rawJson: string | null, todayJst: string): boolean {
  if (rawJson === null) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawJson) as { date?: unknown };
    return parsed.date === todayJst;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @rss-summary/frontend exec tsx --test worker/digest-fresh.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/frontend/worker/digest-fresh.ts apps/frontend/worker/digest-fresh.test.ts apps/frontend/package.json apps/frontend/pnpm-lock.yaml
git commit -m "feat(frontend): ウォッチドッグ用のisDigestFresh判定を追加"
```

(注: `pnpm-lock.yaml` はリポジトリルートに1つ。`git add pnpm-lock.yaml` はルートのものを指す。パスが違えば調整する)

---

## Task 5: frontend worker — postWithRetry

**Files:**
- Create: `apps/frontend/worker/retry.ts`
- Test: `apps/frontend/worker/retry.test.ts`

**Interfaces:**
- Produces: `postWithRetry(url: string, attempts?: number): Promise<void>` — `fetch(url, { method: "POST" })` を実行。2xx で成功。429/5xx とネットワーク例外はリトライ(指数バックオフ、`attempts` 回まで、既定3)。それ以外の非2xxは即 throw。全滅時は最後のエラーを throw。

- [ ] **Step 1: 失敗するテストを書く**

`apps/frontend/worker/retry.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { postWithRetry } from "./retry.js";

function mockFetch(responses: Array<Response | (() => never)>): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const entry = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof entry === "function") entry();
    return entry as Response;
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls: () => i };
}

test("postWithRetry: 初回200で成功し1回だけ呼ぶ", async () => {
  const m = mockFetch([new Response("", { status: 200 })]);
  try {
    await postWithRetry("https://example.test/hook", 3);
    assert.equal(m.calls(), 1);
  } finally {
    m.restore();
  }
});

test("postWithRetry: 500が続くと指定回数リトライして最後にthrow", async () => {
  const m = mockFetch([new Response("", { status: 500 })]);
  try {
    await assert.rejects(() => postWithRetry("https://example.test/hook", 3));
    assert.equal(m.calls(), 3);
  } finally {
    m.restore();
  }
});

test("postWithRetry: 500の後に200なら成功", async () => {
  const m = mockFetch([new Response("", { status: 500 }), new Response("", { status: 200 })]);
  try {
    await postWithRetry("https://example.test/hook", 3);
    assert.equal(m.calls(), 2);
  } finally {
    m.restore();
  }
});

test("postWithRetry: 400は即throw(リトライしない)", async () => {
  const m = mockFetch([new Response("", { status: 400 })]);
  try {
    await assert.rejects(() => postWithRetry("https://example.test/hook", 3));
    assert.equal(m.calls(), 1);
  } finally {
    m.restore();
  }
});
```

（注: 3件目・4件目テスト名の typo は気にせず、コードはそのまま使ってよい。バックオフ待機で各リトライテストは最大数秒かかる。）

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @rss-summary/frontend exec tsx --test worker/retry.test.ts`
Expected: FAIL(`postWithRetry` が無い)

- [ ] **Step 3: 実装する**

`apps/frontend/worker/retry.ts`:

```ts
/**
 * URLへPOSTし、429/5xx とネットワーク例外のみ指数バックオフでリトライする。
 * それ以外の非2xxは恒久的失敗として即 throw。全試行が失敗したら最後のエラーを throw。
 */
export async function postWithRetry(url: string, attempts = 3): Promise<void> {
  let lastError: unknown = new Error(`POST ${url} が実行されませんでした`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: "POST" });
      if (response.ok) {
        return;
      }
      lastError = new Error(`POST ${url}: HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @rss-summary/frontend exec tsx --test worker/retry.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/frontend/worker/retry.ts apps/frontend/worker/retry.test.ts
git commit -m "feat(frontend): worker用のPOSTリトライユーティリティを追加"
```

---

## Task 6: frontend worker — scheduled ハンドラ本体と型検査設定

**Files:**
- Create: `apps/frontend/worker/index.ts`
- Create: `apps/frontend/worker/tsconfig.json`
- Modify: `apps/frontend/package.json`(devDeps・scripts)
- Modify: `apps/frontend/tsconfig.json`(`exclude` に `worker`)

**Interfaces:**
- Consumes: `isDigestFresh`(Task 4)、`postWithRetry`(Task 5)、`toJstDateString`(`@rss-summary/shared`)、`AwsClient`(`aws4fetch`、frontend の既存依存)。
- Produces: default export `{ scheduled }`。cron `"30 23 * * *"` → Deploy Hook POST。cron `"0 2 * * *"` → R2の当日分を確認し `isDigestFresh` が false なら `ALERT_WEBHOOK_URL` へ POST。

- [ ] **Step 1: devDeps を追加**

Run:
```bash
pnpm --filter @rss-summary/frontend add -D @cloudflare/workers-types
# tsx が未追加なら:
pnpm --filter @rss-summary/frontend add -D tsx@4.23.1
```

- [ ] **Step 2: worker/tsconfig.json を作成**

`apps/frontend/worker/tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["index.ts", "digest-fresh.ts", "retry.ts"]
}
```

- [ ] **Step 3: worker/index.ts を実装**

`apps/frontend/worker/index.ts`:

```ts
import { AwsClient } from "aws4fetch";
import { toJstDateString } from "@rss-summary/shared";
import { isDigestFresh } from "./digest-fresh.js";
import { postWithRetry } from "./retry.js";

/** Worker ランタイムに注入する変数・シークレット。ダッシュボードの Variables and Secrets で設定する。 */
interface Env {
  DEPLOY_HOOK_URL: string;
  ALERT_WEBHOOK_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

const BUILD_CRON = "30 23 * * *";
const WATCHDOG_CRON = "0 2 * * *";

/** R2から当日分ダイジェストJSONを署名付きGETで取得する。404はnull。 */
async function fetchDigestJson(env: Env, key: string): Promise<string | null> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  const url = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
  const response = await client.fetch(url, { method: "GET" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`R2 GET ${key} 失敗: HTTP ${response.status}`);
  }
  return response.text();
}

/** Discord(content)・Slack(text)どちらのIncoming Webhookでも読めるよう両キーを送る。ベストエフォート。 */
async function sendAlert(env: Env, message: string): Promise<void> {
  await fetch(env.ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: message, text: message }),
  });
}

async function runWatchdog(env: Env): Promise<void> {
  const todayJst = toJstDateString(new Date());
  const raw = await fetchDigestJson(env, `${todayJst}.json`);
  if (isDigestFresh(raw, todayJst)) {
    return;
  }
  await sendAlert(
    env,
    `[tech-morning-digest] ${todayJst} のダイジェストがR2に見つかりません。生成ビルドが失敗した可能性があります。`,
  );
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === BUILD_CRON) {
      await postWithRetry(env.DEPLOY_HOOK_URL);
      return;
    }
    if (controller.cron === WATCHDOG_CRON) {
      await runWatchdog(env);
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: astro check の対象から worker を外す**

`apps/frontend/tsconfig.json` の `exclude` を更新:

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist", "worker"]
}
```

- [ ] **Step 5: package.json に scripts を追加**

`apps/frontend/package.json` の `scripts` に追加(既存キーは残す):

```json
    "test": "tsx --test worker/**/*.test.ts",
    "typecheck:worker": "tsc -p worker/tsconfig.json"
```

- [ ] **Step 6: 型検査とテスト**

Run:
```bash
pnpm --filter @rss-summary/frontend typecheck:worker
pnpm --filter @rss-summary/frontend test
pnpm --filter @rss-summary/frontend typecheck
```
Expected: いずれも PASS。
- `typecheck:worker` が `@rss-summary/shared` を解決できず失敗する場合のフォールバック:
  `worker/index.ts` の `import { toJstDateString } from "@rss-summary/shared";` を削除し、
  `packages/shared/src/date.ts` の `toJstDateString`(6行、DSTなし)を `worker/index.ts` 内にコピーする。
- `main` に `fetch` ハンドラが無いことを `wrangler` が拒否するのは Task 7 で確認する。

- [ ] **Step 7: コミット**

```bash
git add apps/frontend/worker/index.ts apps/frontend/worker/tsconfig.json apps/frontend/tsconfig.json apps/frontend/package.json
git add pnpm-lock.yaml apps/frontend/package.json
git commit -m "feat(frontend): 定期実行のscheduledハンドラ(ビルド起動+ウォッチドッグ)を追加"
```

---

## Task 7: wrangler.jsonc に main と cron トリガーを追加

**Files:**
- Modify: `apps/frontend/wrangler.jsonc`

**Interfaces:**
- Produces: フロントWorker が `worker/index.ts` を実行し、2本の Cron Trigger で `scheduled()` が起動する構成。

- [ ] **Step 1: wrangler.jsonc を更新**

`apps/frontend/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "tech-morning-digest",
  // ビルド日ごとに更新する(spec.md参照)
  "compatibility_date": "2026-08-02",
  "main": "worker/index.ts",
  "assets": {
    "directory": "./dist"
  },
  "triggers": {
    // UTC。23:30 = JST 08:30(前日) にビルド起動、02:00 に当日分の生成結果を確認
    "crons": ["30 23 * * *", "0 2 * * *"]
  }
}
```

- [ ] **Step 2: ビルドして dry-run で検証**

Run:
```bash
pnpm --filter @rss-summary/frontend build
pnpm --filter @rss-summary/frontend exec wrangler deploy --dry-run --outdir /tmp/wrangler-dry
```
Expected:
- エラーなく完了する。
- 出力に cron トリガー2本(`30 23 * * *`, `0 2 * * *`)が表示される。
- `fetch` ハンドラ不在の警告が出るが deploy 自体は成立する想定。
  **もし `fetch` ハンドラ必須でエラーになる場合のフォールバック**:
  1. `wrangler.jsonc` の `assets` に `"binding": "ASSETS"` を追加。
  2. `worker/index.ts` の `Env` に `ASSETS: Fetcher;` を追加。
  3. default export に `fetch(request: Request, env: Env): Response | Promise<Response> { return env.ASSETS.fetch(request); }` を追加。
  4. Step 6(Task 6)の型検査を再実行してから Step 2 をやり直す。

- [ ] **Step 3: コミット**

```bash
git add apps/frontend/wrangler.jsonc
git commit -m "feat(frontend): wrangler設定にscheduledハンドラとcronトリガー2本を追加"
```

---

## Task 8: ドキュメント更新

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/AI-CONTEXT.md`
- Modify: `docs/README.md`

**Interfaces:** なし(ドキュメントのみ)。

- [ ] **Step 1: CLAUDE.md の「プロジェクト構造」と「配信について」を更新**

- `apps/backend/` の説明を「GitHub Actions生成処理」→「Workers Builds のビルドステップで実行する生成処理」に。
- 構造ツリーから `.github/... backend-daily-digest.yml` の行を削除し、`apps/frontend/worker/`(scheduledハンドラ)を追記。
- `apps/backend/src/state/read-state.ts` の説明を「既読GUID管理(stateブランチへのgit読み書き)」→「既読GUID管理(R2オブジェクト `state/read-guids.json` の読み書き)」に。
- `.github/workflows/backend-daily-digest.yml` の行を削除。
- 「> **配信について**」の段落を次の趣旨に書き換え:
  「フロントWorker(Static Assets)に同居する `scheduled()` ハンドラが毎朝 Deploy Hook を叩く。
  Workers Builds が1回のビルドで backend 生成処理(RSS取得→Gemini要約→R2へ `{date}.json` と
  `state/read-guids.json` を書き込み)→ Astro ビルド → `wrangler deploy` を実行する。
  もう1本の cron(02:00 UTC)が当日分の生成結果をR2で確認し、欠損なら Webhook 通知する。」

- [ ] **Step 2: docs/AI-CONTEXT.md を更新**

- アーキテクチャ説明・依存関係の記述を Step 1 と同じ趣旨に更新。
- 不変条件のうち read-state.ts の git worktree に関する記述があれば削除。
- 不変条件「Gemini呼び出し失敗時はプロセス非ゼロ終了 → GitHub Actions の失敗通知」を
  「→ ビルド失敗 → ウォッチドッグcronがR2の当日分欠損を検知しWebhook通知」に更新。
- 「既知のリスク」:
  - 「GitHub Actionsは60日間コミットがないと…」の項目を削除(本移行で解消)。
  - 追加: 「生成ジョブが30日以上完全停止すると R2 の `state/read-guids.json` が
    ライフサイクルで削除され、復帰時に全記事が新着扱いになる(`MAX_ITEMS_PER_FEED=50` で
    各フィード50件までに限定)。14日プルーニング・旧60日リスクと同クラス。」
- 「外部連携先の確認済み仕様」に追記:
  - Workers Builds Free枠: ビルド3,000分/月・同時1・タイムアウト20分・ビルド時変数64個。
  - Deploy Hook はフロントWorkerの `scheduled()`(cron `30 23 * * *`)から呼ぶ。
  - Pages 単体はスケジュール実行不可(Cron Triggers は Workers 専用)。

- [ ] **Step 3: docs/README.md のセットアップ手順を更新**

GitHub Secrets / Actions を前提にした記述を、次のセットアップ手順(カットオーバー runbook)に置き換える:

```markdown
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
- **state 乖離注意**: カットオーバー後は R2 が最新。数日以内に戻すか、戻す前に
  R2 の `state/read-guids.json` を `state` ブランチへ書き戻す。
```

- [ ] **Step 4: ドキュメントの相互整合を確認**

Run: `grep -rn "GitHub Actions\|stateブランチ\|state ブランチ\|backend-daily-digest\|Deploy Hook" CLAUDE.md docs/`
Expected: 残った記述がすべて「旧構成の説明」または「ロールバック手順」の文脈になっている(現行手順として GitHub Actions を指していない)。

- [ ] **Step 5: コミット**

```bash
git add CLAUDE.md docs/AI-CONTEXT.md docs/README.md
git commit -m "docs: Cloudflare一本化に合わせてアーキテクチャとセットアップ手順を更新"
```

---

## Task 9: ブランチを push して Pull Request を作成

**Files:** なし。

- [ ] **Step 1: 全パッケージの最終チェック**

Run:
```bash
pnpm --filter @rss-summary/backend test && pnpm --filter @rss-summary/backend typecheck
pnpm --filter @rss-summary/frontend test && pnpm --filter @rss-summary/frontend typecheck && pnpm --filter @rss-summary/frontend typecheck:worker
pnpm --filter @rss-summary/shared test && pnpm --filter @rss-summary/shared typecheck
```
Expected: すべて PASS

- [ ] **Step 2: push**

```bash
git push -u origin feat/cloudflare-consolidation
```

- [ ] **Step 3: PR 作成**

```bash
gh pr create --base main --head feat/cloudflare-consolidation \
  --title "feat: 定期実行・生成処理・既読stateをCloudflareに一本化" \
  --body "$(cat <<'EOF'
## 背景

GitHub Actions の scheduled workflow は実行が不安定で、かつ60日間コミットがないと自動無効化される(`state` ブランチのコミットが判定に含まれるか不明、デッドマンズスイッチ未導入)。定期実行・生成処理・既読state管理を Cloudflare に寄せてこの2点を解消する。

## 変更内容

- **定期実行**: 既存フロントWorker(Static Assets)に `scheduled()` ハンドラと cron 2本を同居。専用Workerは作らない。
  - `30 23 * * *` (UTC) → Deploy Hook を POST してビルド起動
  - `0 2 * * *` (UTC) → R2の当日分を確認し、欠損なら Discord/Slack Webhook へ通知(GitHub Actions の失敗メール代替)
- **生成処理**: Workers Builds の build command に `@rss-summary/backend` の生成処理を前置。1回のビルドで 生成 → R2書き込み → Astroビルド → deploy が完結。backend からの Deploy Hook 呼び出しは不要になり削除。
- **既読state**: git の `state` ブランチ → R2 オブジェクト `state/read-guids.json`(同一バケット・毎回上書き)。`read-state.ts` から `child_process`/`git worktree` 依存を除去。
- `.github/workflows/backend-daily-digest.yml` と `apps/backend/src/publish/deploy-hook.ts` を削除。

## 無料枠

Workers Builds Free: ビルド3,000分/月に対し想定消費 約155分/月。Cron Triggers は Free プランで利用可。

## マージ後の手動作業

`docs/README.md` の「カットオーバー手順」を参照(Workers Builds 設定変更・変数登録・state初回移行・Webhook発行 → マージ → Deploy Hook 手動起動 → cron 登録確認)。**マージ前に手順1〜5の完了が必要。**

## 設計・計画

- 設計書: `docs/superpowers/specs/2026-09-11-cloudflare-consolidation-design.md`
- 実装計画: `docs/superpowers/plans/2026-09-11-cloudflare-consolidation.md`

## 既知の限界

- ウォッチドッグは「生成がR2にデータを書いたか」までしか見ない。R2書き込み後の `astro build`/`deploy` 失敗は無検知。
- 生成ジョブが30日以上完全停止すると R2 の state がライフサイクル削除される(`MAX_ITEMS_PER_FEED=50` で被害限定)。

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Ae9NBGrDXxvx6VaW5CdmsS
EOF
)"
```

- [ ] **Step 4: PR URL を報告**

`gh pr view --json url --jq .url` の出力をユーザーに伝える。

---

## Self-Review

**1. Spec coverage**

| Spec 項目 | 対応タスク |
|---|---|
| (a) フロントWorkerに cron 同居 / `worker/` 隔離 / `Env` 手書き / インラインリトライ | Task 4,5,6,7 |
| (a) `isDigestFresh` 純粋関数 | Task 4 |
| (a) `wrangler.jsonc` に `main` + `triggers.crons` | Task 7 |
| (a) `fetch` ハンドラ無し `main` のフォールバック | Task 7 Step 2 |
| (a) astro check と worker 型検査の分離 | Task 6 Step 2,4,5 |
| (a) ランタイム変数6項目 | Task 8(README)・Task 6(`Env`) |
| (b) Workers Builds 設定変更・ビルド時変数 | Task 8(README、手動作業) |
| (b) 生成ステップ非ゼロ終了でビルド失敗 | Task 3 Step 2-7(コメント)・既存 `process.exitCode` 維持 |
| (c) `read-state.ts` git → R2、`saveReadState` 毎回PUT | Task 2 |
| (c) `r2-client.ts` に `getR2Text`/`putR2Text` | Task 1 |
| (c) `index.ts` state引数変更・Deploy Hook削除 | Task 3 |
| 削除: workflow / `deploy-hook.ts` / `state` ブランチ | Task 3(前2つ)・Task 8 README(ブランチはカットオーバー後手動) |
| エラーハンドリング表 | Task 1,2(リトライ)・Task 3(コメント)・Task 6(ウォッチドッグ) |
| 監視の限界 | Task 8(AI-CONTEXT・PR本文) |
| 決定事項5(自動ビルド無効化) | Task 8(README) |
| カットオーバー手順 | Task 8(README) |
| ロールバック | Task 8(README) |
| テスト方針 | 各タスクの Step、Task 9 |

ギャップなし。`state` ブランチ削除と Cloudflare ダッシュボード操作はコード側で完結できないため Task 8 の README runbook に落とし、Task 9 の PR 本文でマージ後作業として明示している。

**2. Placeholder scan**

コード steps はすべて実コードを掲載。「適切なエラーハンドリングを追加」等の曖昧指示なし。Task 8 は文章編集タスクのため差分の「趣旨」を箇条書きで指定(対象ファイル・見出し・置換後の文面を明記)しており、プレースホルダではない。

**3. Type consistency**

- `R2Config`: Task 1 で参照(既存定義)、Task 2 で import。フィールド `accountId/accessKeyId/secretAccessKey/bucketName` で一貫。
- `getR2Text(config, key): Promise<string | null>` / `putR2Text(config, key, body, contentType): Promise<void>`: Task 1 定義、Task 2 で使用、引数順一致。
- `loadReadState(r2: R2Config)` / `saveReadState(r2: R2Config, state: ReadState)`: Task 2 定義、Task 3 で使用。旧 `commitReadState` / 引数なし `loadReadState()` は Task 3 で完全に除去。
- `isDigestFresh(rawJson: string | null, todayJst: string): boolean`: Task 4 定義、Task 6 で使用。
- `postWithRetry(url: string, attempts?: number): Promise<void>`: Task 5 定義、Task 6 で使用。
- `toJstDateString(date: Date): string`: 既存、Task 6 で使用。

不整合なし。
