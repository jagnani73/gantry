import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_SEPOLIA_ADDRESSES, BASE_SEPOLIA_CHAIN_ID, DEMO_RATE, type MerchantSummary } from "@gantry/shared";
import { buildDiscoveryListing, parsePaging } from "../src/services/discovery-core";

const merchants: MerchantSummary[] = [
  {
    handle: "ah-hock-chicken-rice",
    merchantId: `0x${"11".repeat(32)}`,
    categoryId: 1,
    categoryName: "food_beverage",
    displayName: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre",
    registeredAt: 1_786_000_000,
    blockNumber: 45_000_000,
  },
  {
    handle: "gadgethub-sg",
    merchantId: `0x${"22".repeat(32)}`,
    categoryId: 2,
    categoryName: "electronics",
    displayName: "GadgetHub SG",
    registeredAt: 1_786_100_000,
    blockNumber: 45_000_100,
  },
];

const inputs = {
  merchants,
  origin: "https://gantry-backend.onrender.com",
  chainId: BASE_SEPOLIA_CHAIN_ID,
  rate: DEMO_RATE,
  asset: BASE_SEPOLIA_ADDRESSES.realUsdc,
  relayer: "0x82513007C7eB93b54dC555Bdb74341b3084FC47B",
  core: BASE_SEPOLIA_ADDRESSES.gantryCore,
  limit: 100,
  offset: 0,
};

test("every listing is payable exactly as written", () => {
  // The point of the endpoint: an agent takes the string and pays it. A
  // resource URL missing its amount would 400 on the machine door.
  const { items } = buildDiscoveryListing(inputs);
  assert.equal(items[0]!.resource, "https://gantry-backend.onrender.com/pay/ah-hock-chicken-rice?sgd=1.00");
  assert.ok(items.every((i) => i.resource.includes("?sgd=")));
});

test("the listed amount is a real quote, not a placeholder", () => {
  // S$1.00 at the demo rate. If this were invented, a client paying the listing
  // verbatim would be refused for quoting the wrong amount.
  const { items } = buildDiscoveryListing(inputs);
  assert.equal(items[0]!.accepts[0]!.amount, "745101");
});

test("exact stays first, as it is on the pay link itself", () => {
  // Vanilla clients take accepts[0]. A discovery listing that led with
  // gantry-pbm would hand them a scheme only our own agent implements.
  const { items } = buildDiscoveryListing(inputs);
  for (const item of items) {
    assert.equal(item.accepts[0]!.scheme, "exact");
    assert.equal(item.accepts[1]!.scheme, "gantry-pbm");
    assert.equal(item.accepts[0]!.payTo, inputs.relayer, "exact collects to the relayer");
    assert.equal(item.accepts[1]!.payTo, inputs.core, "gantry-pbm pushes into the core");
  }
});

test("lastUpdated is the shop's registration, not now", () => {
  // A timestamp that moved every request would tell a caching client that every
  // shop had changed, on a list that changes only when someone registers.
  const first = buildDiscoveryListing(inputs).items[0]!.lastUpdated;
  const second = buildDiscoveryListing(inputs).items[0]!.lastUpdated;
  assert.equal(first, second);
  assert.equal(first, new Date(1_786_000_000 * 1000).toISOString());
});

test("total counts the whole registry, so a capped page announces itself", () => {
  const page = buildDiscoveryListing({ ...inputs, limit: 1, offset: 0 });
  assert.equal(page.items.length, 1);
  assert.equal(page.pagination.total, 2);
  const second = buildDiscoveryListing({ ...inputs, limit: 1, offset: 1 });
  assert.equal(second.items[0]!.serviceName, "GadgetHub SG");
  assert.equal(buildDiscoveryListing({ ...inputs, offset: 99 }).items.length, 0);
});

test("a shop with no display name still lists under something", () => {
  // displayName is optional on-chain; an entry named "" would be unusable.
  const bare: MerchantSummary = { ...merchants[0]!, displayName: undefined };
  const { items } = buildDiscoveryListing({ ...inputs, merchants: [bare] });
  assert.equal(items[0]!.serviceName, "ah-hock-chicken-rice");
  assert.match(items[0]!.description, /^Pay ah-hock-chicken-rice/);
});

test("the category leads the tags, for a client filtering by kind of shop", () => {
  const { items } = buildDiscoveryListing(inputs);
  assert.equal(items[0]!.tags[0], "food_beverage");
  assert.equal(items[1]!.tags[0], "electronics");
});

test("a trailing slash on the origin never doubles up in a resource URL", () => {
  const { items } = buildDiscoveryListing({ ...inputs, origin: "https://example.test///" });
  assert.equal(items[0]!.resource, "https://example.test/pay/ah-hock-chicken-rice?sgd=1.00");
});

test("paging clamps rather than trusting or throwing", () => {
  assert.deepEqual(parsePaging("10", "5"), { limit: 10, offset: 5 });
  assert.deepEqual(parsePaging(undefined, undefined), { limit: 100, offset: 0 });
  assert.deepEqual(parsePaging("99999", "0"), { limit: 100, offset: 0 }, "capped");
  // Junk must not empty the registry — a discovery endpoint that lists nothing
  // because a query param was malformed helps nobody.
  assert.deepEqual(parsePaging("abc", "-4"), { limit: 100, offset: 0 });
});
