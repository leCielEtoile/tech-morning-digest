import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { handleCallback, handleLogin, handleLogout, parseSessionCookie } from "./auth-handlers.js";
import { handleGetPreferences, handlePutPreferences } from "./preferences-handlers.js";
import { handleAddBookmark, handleDeleteBookmark, handleListBookmarks } from "./bookmarks-handlers.js";
import { handleGetReadState, handleMarkRead } from "./read-state-handlers.js";
import { getSession, type Session } from "../db/sessions.js";
import type { GoogleAuthConfig } from "../auth/google-oauth.js";

const unauthorizedResponse = {
  description: "未ログイン",
  content: { "application/json": { schema: { type: "object", properties: { error: { type: "string", example: "unauthorized" } } } } },
} as const;

export interface ApiEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

function googleConfig(request: Request, env: ApiEnv): GoogleAuthConfig {
  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri };
}

/** 認証必須のAPIハンドラーが使う。有効なセッションがなければnullを返す(呼び出し元は401を返すこと)。 */
export async function requireSession(request: Request, db: D1Database): Promise<Session | null> {
  const sessionId = parseSessionCookie(request);
  if (!sessionId) return null;
  return getSession(db, sessionId);
}

/**
 * ルート定義本体。各ハンドラーは素のRequest/D1Databaseのみを受け取る設計を維持するため、
 * ここでは`c.req.raw`/`c.env`からそれらを取り出して渡すだけの薄い配線に徹する
 * (ハンドラー自体はHonoに依存させない。将来ルーティング層を差し替える際もハンドラーは無改修で済む)。
 * Task 7以降はこのファイルにルートを追記していく。
 */
const app = new Hono<{ Bindings: ApiEnv }>();

app.get(
  "/api/auth/login",
  describeRoute({
    tags: ["Auth"],
    summary: "Googleログインを開始する",
    description: "PKCE付きの認可リクエストを組み立て、Googleの認可エンドポイントへ302リダイレクトする。stateとcode_verifierは短命Cookieに保存される。",
    responses: { 302: { description: "Googleの認可URLへリダイレクト" } },
  }),
  (c) => handleLogin(googleConfig(c.req.raw, c.env)),
);
app.get(
  "/api/auth/google/callback",
  describeRoute({
    tags: ["Auth"],
    summary: "Googleからのコールバックを処理する",
    description: "認可コードをトークンと交換し、ユーザーのfind-or-create・セッション発行を行う。成功・失敗のいずれも/への302で終わる。",
    responses: {
      302: { description: "成功(セッションCookie発行) or 失敗(未認証のまま/へ)" },
      400: { description: "state/code_verifier不備、または認可コード交換失敗" },
    },
  }),
  (c) => handleCallback(c.req.raw, c.env.DB, googleConfig(c.req.raw, c.env)),
);
app.post(
  "/api/auth/logout",
  describeRoute({
    tags: ["Auth"],
    summary: "ログアウトする",
    description: "セッションCookieがあれば該当セッションをDBから削除し、Cookieを失効させる。未ログインでも200を返す。",
    responses: { 200: { description: "ログアウト完了" } },
  }),
  (c) => handleLogout(c.req.raw, c.env.DB),
);

app.get(
  "/api/preferences",
  describeRoute({
    tags: ["Preferences"],
    summary: "興味カテゴリ設定を取得する",
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: "設定一覧",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                prefs: {
                  type: "array",
                  items: { type: "object", properties: { category: { type: "string" }, enabled: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      401: unauthorizedResponse,
    },
  }),
  (c) => handleGetPreferences(c.req.raw, c.env.DB),
);
app.put(
  "/api/preferences",
  describeRoute({
    tags: ["Preferences"],
    summary: "興味カテゴリ設定を置き換える",
    description: "既存の設定を全削除してから渡された内容で置き換える。categoryは既定の6カテゴリのホワイトリストに含まれる文字列のみ許可される。",
    security: [{ cookieAuth: [] }],
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "array",
            items: { type: "object", required: ["category", "enabled"], properties: { category: { type: "string" }, enabled: { type: "boolean" } } },
          },
        },
      },
    },
    responses: {
      200: { description: "保存成功" },
      400: { description: "配列でない、categoryがホワイトリスト外、またはJSON解析失敗" },
      401: unauthorizedResponse,
    },
  }),
  (c) => handlePutPreferences(c.req.raw, c.env.DB),
);

app.get(
  "/api/bookmarks",
  describeRoute({
    tags: ["Bookmarks"],
    summary: "ブックマーク一覧を取得する(保存日時降順)",
    security: [{ cookieAuth: [] }],
    responses: { 200: { description: "ブックマーク一覧" }, 401: unauthorizedResponse },
  }),
  (c) => handleListBookmarks(c.req.raw, c.env.DB),
);
app.post(
  "/api/bookmarks",
  describeRoute({
    tags: ["Bookmarks"],
    summary: "ブックマークを追加する",
    description: "無料プランの上限は10件。上限到達時は409を返す。articleLinkはhttp(s)スキームのみ許可。",
    security: [{ cookieAuth: [] }],
    requestBody: {
      content: {
        "application/json": {
          schema: { type: "object", required: ["articleLink", "articleTitle"], properties: { articleLink: { type: "string" }, articleTitle: { type: "string" } } },
        },
      },
    },
    responses: {
      201: { description: "追加成功" },
      400: { description: "不正なbody、またはhttp(s)以外のURLスキーム" },
      401: unauthorizedResponse,
      409: { description: "上限(10件)に到達" },
    },
  }),
  (c) => handleAddBookmark(c.req.raw, c.env.DB),
);
app.delete(
  "/api/bookmarks/:id",
  describeRoute({
    tags: ["Bookmarks"],
    summary: "ブックマークを削除する",
    description: "id・user_idの両方をWHERE条件にするため、他人のブックマークIDを指定しても削除されない(その場合も200を返す。存在有無を漏らさないため)。",
    security: [{ cookieAuth: [] }],
    responses: { 200: { description: "削除完了(対象が存在しない/他人の所有物でも200)" }, 401: unauthorizedResponse },
  }),
  (c) => handleDeleteBookmark(c.req.raw, c.env.DB, c.req.param("id")),
);

app.get(
  "/api/read-state",
  describeRoute({
    tags: ["ReadState"],
    summary: "既読記事のハッシュ一覧を取得する",
    security: [{ cookieAuth: [] }],
    responses: { 200: { description: "既読ハッシュ一覧" }, 401: unauthorizedResponse },
  }),
  (c) => handleGetReadState(c.req.raw, c.env.DB),
);
app.post(
  "/api/read-state",
  describeRoute({
    tags: ["ReadState"],
    summary: "記事を既読登録する(冪等)",
    security: [{ cookieAuth: [] }],
    requestBody: {
      content: { "application/json": { schema: { type: "object", required: ["articleGuidHash"], properties: { articleGuidHash: { type: "string" } } } } },
    },
    responses: { 200: { description: "登録完了(既に既読でも200)" }, 400: { description: "不正なbody" }, 401: unauthorizedResponse },
  }),
  (c) => handleMarkRead(c.req.raw, c.env.DB),
);

app.get(
  "/api/openapi.json",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Tech Morning Digest API",
        version: "1.0.0",
        description: "アカウント機能(Google OAuthログイン・興味カテゴリ設定・ブックマーク・既読管理)のAPI。",
      },
      components: {
        securitySchemes: {
          cookieAuth: { type: "apiKey", in: "cookie", name: "session_id" },
        },
      },
    },
  }),
);
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

app.notFound((c) => c.json({ error: "not_found" }, 404));

/**
 * `/api/`配下のリクエストをルーティングする。該当しないパスはnullを返し、
 * 呼び出し元(index.ts)が静的アセット配信にフォールバックする。
 */
export async function handleApiRequest(request: Request, env: ApiEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  return app.fetch(request, env);
}
