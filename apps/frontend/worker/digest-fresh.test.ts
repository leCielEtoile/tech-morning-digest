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
