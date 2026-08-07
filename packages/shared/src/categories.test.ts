import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, CATEGORY_OPTIONS, categoryName, isKnownCategory } from "./categories";

test("known categories", () => {
  for (const id of Object.keys(CATEGORIES).map(Number)) {
    assert.ok(isKnownCategory(id), `expected known: ${id}`);
  }
});

test("unknown categories", () => {
  // 0 and 5..255 are accepted by the contract (uint16 < 256) but have no name,
  // no label and no policy bit — registration must refuse them.
  for (const id of [0, 5, 255, 256, -1, 1.5, NaN, Infinity]) {
    assert.ok(!isKnownCategory(id), `expected unknown: ${id}`);
  }
});

test("options cover every category and carry a label", () => {
  const ids = Object.keys(CATEGORIES).map(Number);
  assert.deepEqual(
    CATEGORY_OPTIONS.map((o) => o.id),
    [...ids].sort((a, b) => a - b),
  );
  for (const option of CATEGORY_OPTIONS) {
    assert.equal(option.name, CATEGORIES[option.id]);
    assert.ok(option.label.length > 0, `missing label: ${option.id}`);
  }
});

test("categoryName falls back for unlisted ids", () => {
  assert.equal(categoryName(1), "food_beverage");
  assert.equal(categoryName(7), "category_7");
});
