import { Hono } from "hono";
import { handleCallback, handleLogin, handleLogout, parseSessionCookie } from "./auth-handlers.js";
import { handleGetPreferences, handlePutPreferences } from "./preferences-handlers.js";
import { getSession, type Session } from "../db/sessions.js";
import type { GoogleAuthConfig } from "../auth/google-oauth.js";

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

app.get("/api/auth/login", (c) => handleLogin(googleConfig(c.req.raw, c.env)));
app.get("/api/auth/google/callback", (c) => handleCallback(c.req.raw, c.env.DB, googleConfig(c.req.raw, c.env)));
app.post("/api/auth/logout", (c) => handleLogout(c.req.raw, c.env.DB));

app.get("/api/preferences", (c) => handleGetPreferences(c.req.raw, c.env.DB));
app.put("/api/preferences", (c) => handlePutPreferences(c.req.raw, c.env.DB));

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
