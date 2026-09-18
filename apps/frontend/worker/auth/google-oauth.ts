import * as arctic from "arctic";

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleAuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

function buildClient(config: GoogleAuthConfig): arctic.Google {
  return new arctic.Google(config.clientId, config.clientSecret, config.redirectUri);
}

/** Googleへのログインリダイレクト先URLと、コールバック検証に必要なstate・codeVerifierを生成する。 */
export function createGoogleAuthorizationRequest(config: GoogleAuthConfig): GoogleAuthorizationRequest {
  const google = buildClient(config);
  const state = arctic.generateState();
  const codeVerifier = arctic.generateCodeVerifier();
  const url = google.createAuthorizationURL(state, codeVerifier, ["openid"]);
  return { url: url.toString(), state, codeVerifier };
}

interface GoogleIdTokenClaims {
  sub: string;
}

function isGoogleIdTokenClaims(value: unknown): value is GoogleIdTokenClaims {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["sub"] === "string";
}

/**
 * 認可コードをトークンに交換し、ID token(openidスコープで発行される)から`sub`(不変の識別子)のみを取り出す。
 * ID tokenはGoogleのトークンエンドポイントから直接(クライアントシークレット認証済みのバックチャネルで)
 * 取得したものであり署名検証は行わない。userinfoエンドポイントへの追加fetchは不要なため呼ばない
 * (Arctic公式ドキュメント https://arcticjs.dev/providers/google の`decodeIdToken`パターンに準拠)。
 * email/display_nameは意図的に取得しない(データ最小化方針)。
 */
export async function exchangeGoogleCode(
  config: GoogleAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const google = buildClient(config);
  const tokens = await google.validateAuthorizationCode(code, codeVerifier);
  const claims: unknown = arctic.decodeIdToken(tokens.idToken());
  if (!isGoogleIdTokenClaims(claims)) {
    throw new Error("Google ID tokenのclaimsが期待する形式と一致しません");
  }
  return claims.sub;
}
