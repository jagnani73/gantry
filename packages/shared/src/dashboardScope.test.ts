import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScope, shouldChime, visibleRows } from "./dashboardScope";

test("resolveScope collapses no-op params to unscoped", () => {
  // Each of these would otherwise filter the feed to nothing while rendering
  // the normal "waiting for payments" empty state.
  for (const param of [null, undefined, "", "   ", "\t"]) {
    assert.equal(resolveScope(param), null, `expected unscoped: ${JSON.stringify(param)}`);
  }
});

test("resolveScope normalizes case and surrounding space", () => {
  assert.equal(resolveScope("ah-hock-chicken-rice"), "ah-hock-chicken-rice");
  assert.equal(resolveScope("  Ah-Hock-Chicken-Rice  "), "ah-hock-chicken-rice");
});

const rows = [
  { handle: "ah-hock-chicken-rice", id: 1 },
  { handle: "gadgethub-sg", id: 2 },
  { handle: "ah-hock-chicken-rice", id: 3 },
];

test("visibleRows returns everything when unscoped", () => {
  assert.equal(visibleRows(rows, null), rows);
});

test("visibleRows keeps only the scoped merchant", () => {
  assert.deepEqual(
    visibleRows(rows, "ah-hock-chicken-rice").map((r) => r.id),
    [1, 3],
  );
  assert.deepEqual(visibleRows(rows, "nobody-here"), []);
});

test("shouldChime respects both liveness and scope", () => {
  assert.equal(shouldChime(true, "gadgethub-sg", null), true);
  assert.equal(shouldChime(true, "gadgethub-sg", "gadgethub-sg"), true);
  // Hidden row: the feed would not show it, so it must not ring either.
  assert.equal(shouldChime(true, "gadgethub-sg", "ah-hock-chicken-rice"), false);
  // Replayed history is never live, regardless of scope.
  assert.equal(shouldChime(false, "gadgethub-sg", null), false);
});
