import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** guidHash -> 最終既読日時(ISO8601)。spec.md 6章のデータ形式 */
export type ReadState = Record<string, string>;

export const STATE_BRANCH = "state";
export const STATE_FILE_NAME = "read-guids.json";
export const PRUNE_AFTER_DAYS = 14; // spec.md 6章(90日→14日に短縮済み)

export function computeGuidHash(feedName: string, guid: string): string {
  return createHash("sha256").update(`${feedName}::${guid}`).digest("hex");
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * `state`ブランチのread-guids.jsonを読み込む。読み取り専用のため作業ツリー(main)には触れない。
 */
export async function loadReadState(cwd = process.cwd(), remote = "origin"): Promise<ReadState> {
  await runGit(["fetch", remote, STATE_BRANCH], cwd);
  const content = await runGit(["show", `${remote}/${STATE_BRANCH}:${STATE_FILE_NAME}`], cwd);
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${STATE_FILE_NAME} の形式が不正です`);
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
 * 更新後のread-guids.jsonを`state`ブランチへコミット・pushする。
 * git worktreeを使い、呼び出し元(main作業ツリー)を一切変更せずに独立した場所でコミットする。
 *
 * 呼び出しタイミングの制約(spec.mdに明記なし、実装上の必須事項):
 * このコミットはGemini生成+R2書き込みが両方成功した後にのみ実行すること。
 * 失敗時に既読化してしまうと、その記事が二度と新着として扱われなくなるため。
 */
export async function commitReadState(
  state: ReadState,
  cwd = process.cwd(),
  remote = "origin",
): Promise<void> {
  const worktreeDir = await mkdtemp(join(tmpdir(), "state-branch-"));
  try {
    await runGit(["fetch", remote, STATE_BRANCH], cwd);
    await runGit(["worktree", "add", "--detach", worktreeDir, `${remote}/${STATE_BRANCH}`], cwd);
    await writeFile(join(worktreeDir, STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const status = await runGit(["status", "--porcelain"], worktreeDir);
    if (status.trim() === "") {
      return; // 差分なし(新着0件など)。コミット不要
    }

    await runGit(["add", STATE_FILE_NAME], worktreeDir);
    await runGit(
      [
        "-c",
        "user.name=digest-bot",
        "-c",
        "user.email=digest-bot@users.noreply.github.com",
        "commit",
        "-m",
        "chore: 既読GUIDを更新",
      ],
      worktreeDir,
    );
    await runGit(["push", remote, `HEAD:${STATE_BRANCH}`], worktreeDir);
  } finally {
    await runGit(["worktree", "remove", "--force", worktreeDir], cwd).catch(() => {});
    await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
  }
}
