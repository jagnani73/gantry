import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDEX_LAG_TOLERANCE_BLOCKS,
  categoryParam,
  directoryHaystack,
  isIndexBehind,
  matchesDirectory,
  resolveCategoryFilter,
  resolveDirectoryQuery,
  resolveShopParam,
} from "./directory";
import { CATEGORY_OPTIONS } from "./categories";

test("resolveDirectoryQuery collapses no-op params to no search", () => {
  for (const param of [null, undefined, "", "   ", "\t"]) {
    assert.equal(resolveDirectoryQuery(param), "", `expected no search: ${JSON.stringify(param)}`);
  }
});

test("resolveDirectoryQuery lowercases once, at the boundary", () => {
  assert.equal(resolveDirectoryQuery("  Ah HOCK  "), "ah hock");
});

test("resolveCategoryFilter reads the registry's slug, not the id or the label", () => {
  const food = CATEGORY_OPTIONS.find((option) => option.name === "food_beverage");
  assert.ok(food, "the registry must still carry food_beverage");
  assert.equal(resolveCategoryFilter("food_beverage"), food.id);
  assert.equal(resolveCategoryFilter("  Food_Beverage "), food.id);
  // The display label is prose and may be reworded; it is not the URL contract.
  assert.equal(resolveCategoryFilter(food.label), null);
});

test("resolveCategoryFilter fails open on anything it cannot place", () => {
  // Failing CLOSED would render an empty grid indistinguishable from a rail
  // with no shops on it, which is the outcome this must never produce.
  for (const param of [null, undefined, "", "   ", "not_a_category", "1"]) {
    assert.equal(resolveCategoryFilter(param), null, `expected All: ${JSON.stringify(param)}`);
  }
});

test("categoryParam round-trips a known id and refuses an unknown one", () => {
  for (const option of CATEGORY_OPTIONS) {
    assert.equal(categoryParam(option.id), option.name);
    assert.equal(resolveCategoryFilter(categoryParam(option.id)), option.id);
  }
  assert.equal(categoryParam(null), null);
  // No segment would render `category_250` as selected, so it must read as All.
  assert.equal(categoryParam(250), null);
});

test("directoryHaystack covers name, handle and location, and tolerates absent text", () => {
  assert.equal(
    directoryHaystack({
      handle: "ah-hock-chicken-rice",
      displayName: "Ah Hock Chicken Rice",
      location: "Maxwell Food Centre",
    }),
    "ah hock chicken rice ah-hock-chicken-rice maxwell food centre",
  );
  // resolveProfile omits blank, deceptive and invisible fields entirely, so a
  // nameless merchant must still be findable by the handle it definitely has.
  // Asserted through the predicate rather than on the exact join string, which
  // is an implementation detail the property does not depend on.
  assert.equal(
    matchesDirectory(
      { haystack: directoryHaystack({ handle: "kopi-corner-sg" }), categoryId: 1 },
      { query: "kopi", categoryId: null },
    ),
    true,
  );
});

const ahHock = { haystack: directoryHaystack({
  handle: "ah-hock-chicken-rice",
  displayName: "Ah Hock Chicken Rice",
  location: "Maxwell Food Centre",
}), categoryId: 1 };

const gadgetHub = { haystack: directoryHaystack({
  handle: "gadgethub-sg",
  displayName: "GadgetHub SG",
  location: "Sim Lim Square",
}), categoryId: 2 };

test("matchesDirectory matches across all three fields, case-insensitively", () => {
  for (const query of ["ah hock", "chicken-rice", "maxwell"]) {
    assert.equal(matchesDirectory(ahHock, { query, categoryId: null }), true, query);
  }
  assert.equal(matchesDirectory(ahHock, { query: "sim lim", categoryId: null }), false);
});

test("matchesDirectory ANDs the category with the search", () => {
  assert.equal(matchesDirectory(gadgetHub, { query: "", categoryId: 2 }), true);
  assert.equal(matchesDirectory(gadgetHub, { query: "", categoryId: 1 }), false);
  // Both must hold: a search hit in the wrong category is not a result.
  assert.equal(matchesDirectory(gadgetHub, { query: "gadget", categoryId: 1 }), false);
  assert.equal(matchesDirectory(gadgetHub, { query: "gadget", categoryId: 2 }), true);
});

test("resolveShopParam normalizes a shared link's handle", () => {
  // Handles are lowercase on-chain, so a link that was auto-capitalised by a
  // messaging app, or typed by hand, must still open the right shop.
  assert.equal(resolveShopParam("ah-hock-chicken-rice"), "ah-hock-chicken-rice");
  assert.equal(resolveShopParam("  Ah-Hock-Chicken-Rice "), "ah-hock-chicken-rice");
  // Nothing to open, rather than a handle that matches nothing.
  for (const param of [null, undefined, "", "   "]) {
    assert.equal(resolveShopParam(param), null, `expected no shop: ${JSON.stringify(param)}`);
  }
});

test("an unknown head means the index cannot be claimed from", () => {
  // Before the first successful head read there is no basis for "this shop is
  // not registered", which is the sentence the empty state would otherwise
  // print. Absent must fail the same way as far-behind, not the same way as
  // caught-up.
  assert.equal(isIndexBehind(null), true);
  assert.equal(isIndexBehind(undefined), true);
});

test("a healthy host is never labelled as catching up", () => {
  // The sweep runs every 15s against ~2s blocks, so a few blocks behind is the
  // normal resting state. Warning there would put a caveat on a current page and
  // teach the reader to ignore it.
  assert.equal(isIndexBehind(0), false);
  assert.equal(isIndexBehind(INDEX_LAG_TOLERANCE_BLOCKS), false);
  assert.equal(isIndexBehind(INDEX_LAG_TOLERANCE_BLOCKS + 1), true);
  // The case this exists for: a cold or failing host, thousands of blocks back.
  assert.equal(isIndexBehind(430_000), true);
});

test("an empty filter matches every merchant", () => {
  const filter = { query: "", categoryId: null };
  assert.equal(matchesDirectory(ahHock, filter), true);
  assert.equal(matchesDirectory(gadgetHub, filter), true);
});
