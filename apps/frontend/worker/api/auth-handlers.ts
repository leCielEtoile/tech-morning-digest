import { exchangeGoogleCode, createGoogleAuthorizationRequest, type GoogleAuthConfig } from "../auth/google-oauth.js";
import { findOrCreateUserByGoogleSub } from "../db/users.js";
import { createSession, deleteSession, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "../db/sessions.js";

const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_CODE_VERIFIER_COOKIE = "oauth_code_verifier";

/** Cookieヘッダーから指定した名前の値を取り出す。存在しなければnull。 */
function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function parseSessionCookie(request: Request): string | null {
  return parseCookie(request, SESSION_COOKIE_NAME);
}

function shortLivedCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`;
}

function clearedCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Googleへのログインリダイレクトを返す。state・code_verifierは短命Cookieに保存する。 */
export async function handleLogin(config: GoogleAuthConfig): Promise<Response> {
  const { url, state, codeVerifier } = await createGoogleAuthorizationRequest(config);
  const headers = new Headers({ Location: url });
  headers.append("Set-Cookie", shortLivedCookie(OAUTH_STATE_COOKIE, state));
  headers.append("Set-Cookie", shortLivedCookie(OAUTH_CODE_VERIFIER_COOKIE, codeVerifier));
  return new Response(null, { status: 302, headers });
}

/**
 * Googleからのコールバックを処理し、ユーザーのfind-or-create・セッション発行を行う。
 * state検証・認可エラーの判定はexchangeGoogleCode(oauth.validateAuthResponse)側が
 * 例外を投げる形で行うため、ここでは短命Cookieの有無だけ確認してcatchする。
 * find-or-create・セッション発行(D1呼び出し)の失敗も未処理の500にはせず、"/"への302に丸める。
 */
export async function handleCallback(
  request: Request,
  db: D1Database,
  config: GoogleAuthConfig,
): Promise<Response> {
  const storedState = parseCookie(request, OAUTH_STATE_COOKIE);
  const codeVerifier = parseCookie(request, OAUTH_CODE_VERIFIER_COOKIE);

  if (!storedState || !codeVerifier) {
    return new Response("不正なリクエストです", { status: 400 });
  }

  let googleSub: string;
  try {
    googleSub = await exchangeGoogleCode(config, new URL(request.url), storedState, codeVerifier);
  } catch {
    return new Response("不正なリクエストです", { status: 400 });
  }

  // D1障害時もログインページに302で戻す(生のユーザーに500を見せない)。
  // 失敗時はセッションCookieを発行しないため、ユーザーは再度ログインを試みることになる。
  let sessionId: string;
  try {
    const user = await findOrCreateUserByGoogleSub(db, googleSub);
    const session = await createSession(db, user.id);
    sessionId = session.id;
  } catch {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie(sessionId));
  headers.append("Set-Cookie", clearedCookie(OAUTH_STATE_COOKIE));
  headers.append("Set-Cookie", clearedCookie(OAUTH_CODE_VERIFIER_COOKIE));
  return new Response(null, { status: 302, headers });
}

export async function handleLogout(request: Request, db: D1Database): Promise<Response> {
  const sessionId = parseSessionCookie(request);
  if (sessionId) {
    await deleteSession(db, sessionId);
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", clearedCookie(SESSION_COOKIE_NAME));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
