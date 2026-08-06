import assert from "node:assert/strict";
import { test } from "node:test";
import { toJstDateString } from "./date.js";

test("toJstDateString: UTC 14:59はJSTでまだ同日", () => {
  // UTC 2026-08-02T14:59:00Z = JST 2026-08-02T23:59:00+09:00
  assert.equal(toJstDateString(new Date("2026-08-02T14:59:00.000Z")), "2026-08-02");
});

test("toJstDateString: UTC 15:00を超えるとJSTでは日付が繰り上がる", () => {
  // UTC 2026-08-02T15:00:00Z = JST 2026-08-03T00:00:00+09:00
  assert.equal(toJstDateString(new Date("2026-08-02T15:00:00.000Z")), "2026-08-03");
});

test("toJstDateString: cronの実行時刻(UTC 23:30)はJST翌日8:30になる", () => {
  assert.equal(toJstDateString(new Date("2026-08-01T23:30:00.000Z")), "2026-08-02");
});
