import * as oauth from "oauth4webapi";

/**
 * discoveryRequestは使わず固定値で構成する。Googleのこれらのエンドポイントは
 * 安定して公開されているOIDC標準の値であり、ログイン毎に.well-known discoveryへ
 * 追加fetchする必要はない。
 */
const GOOGLE_AUTHORIZATION_SERVER: oauth.AuthorizationServer = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
};

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

/** Googleへのログインリダイレクト先URLと、コールバック検証に必要なstate・codeVerifierを生成する。 */
export async function createGoogleAuthorizationRequest(
  config: GoogleAuthConfig,
): Promise<GoogleAuthorizationRequest> {
  const state = oauth.generateRandomState();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

  const url = new URL(GOOGLE_AUTHORIZATION_SERVER.authorization_endpoint as string);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return { url: url.toString(), state, codeVerifier };
}

interface GoogleIdTokenClaims {
  sub: string;
}

function isGoogleIdTokenClaims(value: unknown): value is GoogleIdTokenClaims {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["sub"] === "string";
}

/**
 * コールバックURLのstateを検証したうえで認可コードをトークンに交換し、ID token
 * (openidスコープで発行される)から`sub`(不変の識別子)のみを取り出す。ID tokenは
 * Googleのトークンエンドポイントから直接(TLS + client_secretで認証済みのバックチャネルで)
 * 取得したものであり署名検証は行わない(oauth4webapi公式ドキュメントも、TLS保護された
 * エンドポイントとの直接通信で受け取ったJWTの署名検証は必須ではないとしている)。
 * state不一致・認可エラーレスポンスはoauth4webapi側(validateAuthResponse)が例外を
 * 投げるので、呼び出し元(auth-handlers.ts)でまとめて捕捉する。email/display_nameは
 * 意図的に取得しない(データ最小化方針)。
 */
export async function exchangeGoogleCode(
  config: GoogleAuthConfig,
  callbackUrl: URL,
  expectedState: string,
  codeVerifier: string,
): Promise<string> {
  const client: oauth.Client = { client_id: config.clientId };
  const clientAuth = oauth.ClientSecretPost(config.clientSecret);

  const params = oauth.validateAuthResponse(GOOGLE_AUTHORIZATION_SERVER, client, callbackUrl, expectedState);

  const response = await oauth.authorizationCodeGrantRequest(
    GOOGLE_AUTHORIZATION_SERVER,
    client,
    clientAuth,
    params,
    config.redirectUri,
    codeVerifier,
  );
  const result = await oauth.processAuthorizationCodeResponse(GOOGLE_AUTHORIZATION_SERVER, client, response);
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!isGoogleIdTokenClaims(claims)) {
    throw new Error("Google ID tokenのclaimsが期待する形式と一致しません");
  }
  return claims.sub;
}
