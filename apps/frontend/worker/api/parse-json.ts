/** 空・不正なJSONボディをthrowせず`undefined`として返す。呼び出し側の型ガードがundefinedを弾く。 */
export async function readJsonBody(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
