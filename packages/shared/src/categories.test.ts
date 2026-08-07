import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  categoryName,
  isKnownCategory,
} from "./categories";

test("known categories", () => {
  for (const id of Object.keys(CATEGORIES).map(Number)) {
    assert.ok(isKnownCategory(id), `expected known: ${id}`);
  }
});

test("unknown categories", () => {
  // 0 and 5..255 are accepted by the contract (uint16 < 256) but have no name
  // and no label, so they would render as `category_7` — registration refuses
  // them even though the on-chain bitmap could technically address them.
  for (const id of [0, 5, 255, 256, -1, 1.5, NaN, Infinity]) {
    assert.ok(!isKnownCategory(id), `expected unknown: ${id}`);
  }
});

test("every category id fits the on-chain uint16 < 256 constraint", () => {
  // GantryCore.registerMerchant reverts InvalidCategory at >= 256, and the id
  // doubles as a bit index in AgentPBMWallet's uint256 categoryBitmap.
  for (const id of Object.keys(CATEGORIES).map(Number)) {
    assert.ok(Number.isInteger(id) && id >= 0 && id < 256, `out of range: ${id}`);
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
    // Assert the LABEL exists, not that option.label is non-empty: label falls
    // back to the wire name, so the latter can never fail and a missing label
    // would silently ship "food_beverage" into the dropdown.
    assert.ok(CATEGORY_LABELS[option.id], `missing label: ${option.id}`);
  }
});

test("categoryName falls back for unlisted ids", () => {
  assert.equal(categoryName(1), "food_beverage");
  assert.equal(categoryName(7), "category_7");
});
