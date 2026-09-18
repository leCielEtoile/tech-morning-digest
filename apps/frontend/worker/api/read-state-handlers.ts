import { requireSession } from "./router.js";
import { getReadArticleHashes, markArticleRead } from "../db/read-state.js";

function isMarkReadBody(value: unknown): value is { articleGuidHash: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["articleGuidHash"] === "string"
  );
}

export async function handleGetReadState(request: Request, db: D1Database): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const readArticleHashes = await getReadArticleHashes(db, session.userId);
  return new Response(JSON.stringify({ readArticleHashes }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handleMarkRead(request: Request, db: D1Database): Promise<Response> {
  const session = await requireSession(request, db);
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const body: unknown = await request.json();
  if (!isMarkReadBody(body)) {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  await markArticleRead(db, session.userId, body.articleGuidHash);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}
