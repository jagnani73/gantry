import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_SEPOLIA_ADDRESSES,
  BASE_SEPOLIA_CHAIN_ID,
  DEMO_RATE,
  DEMO_RATE_EURC,
  OFFER_TOKEN_IDS,
  parseSgd,
  quoteAmountIn,
  type MerchantSummary,
} from "@gantry/shared";
import { SAMPLE_SGD, buildDiscoveryListing, parsePaging } from "../src/services/discovery-core";

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
  // Mirrors OFFER_TOKEN_IDS: default currency first, every payable one present.
  tokens: [
    { name: "USDC", version: "2", asset: BASE_SEPOLIA_ADDRESSES.realUsdc, rate: DEMO_RATE },
    { name: "EURC", version: "2", asset: BASE_SEPOLIA_ADDRESSES.realEurc, rate: DEMO_RATE_EURC },
  ],
  relayer: "0x82513007C7eB93b54dC555Bdb74341b3084FC47B",
  core: BASE_SEPOLIA_ADDRESSES.gantryCore,
  limit: 100,
  offset: 0,
  total: merchants.length,
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

test("exact in the default currency stays first, as on the pay link itself", () => {
  // Vanilla clients take accepts[0] without choosing, so it has to be both the
  // scheme they implement and a currency they hold. Leading with gantry-pbm
  // would hand them a scheme only our own agent speaks; leading with euros would
  // hand them a balance they do not have.
  const { items } = buildDiscoveryListing(inputs);
  for (const item of items) {
    assert.equal(item.accepts[0]!.scheme, "exact");
    assert.equal(item.accepts[0]!.extra["name"], "USDC");
    assert.equal(item.accepts[0]!.payTo, inputs.relayer, "exact collects to the relayer");
  }
});

test("a listing offers every currency the challenge does, in the same order", () => {
  // These describe the SAME resource. When only the 402 learned to fan out, this
  // listing still advertised dollars alone — so a euro-only agent reading the
  // rail would conclude the shop could not take its money and never fetch the
  // challenge that would have told it otherwise.
  const { items } = buildDiscoveryListing(inputs);
  const expected = [
    ...OFFER_TOKEN_IDS.map((t) => `exact/${t}`),
    ...OFFER_TOKEN_IDS.map((t) => `gantry-pbm/${t}`),
  ];
  for (const item of items) {
    assert.deepEqual(
      item.accepts.map((a) => `${a.scheme}/${String(a.extra["name"])}`),
      expected,
    );
  }
});

test("each currency carries its OWN quote, not the default one", () => {
  // A shared amount would be right for one currency and a number the settle
  // refuses for the rest, which turns "payable verbatim" into decoration.
  const { items } = buildDiscoveryListing(inputs);
  const byName = new Map(items[0]!.accepts.map((a) => [String(a.extra["name"]), a.amount]));
  assert.equal(byName.get("USDC"), "745101"); // S$1.00 at 1.3421
  assert.equal(byName.get("EURC"), "662252"); // S$1.00 at 1.5100
  assert.notEqual(byName.get("USDC"), byName.get("EURC"));
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

test("total is the registry's count, not the length of the rows handed in", () => {
  // `merchants` is itself a capped read, so measuring it made `total` describe
  // the page while claiming to describe the rail — a client paging by `offset`
  // would stop at the cap believing it had enumerated everything.
  const capped = buildDiscoveryListing({ ...inputs, total: 500 });
  assert.equal(capped.items.length, 2, "the page is what was handed in");
  assert.equal(capped.pagination.total, 500, "the total is what the caller counted");
});

test("the listed price is spelled once — quote, extra.sgd and the URL agree", () => {
  // These three used to be a derived amount and two "1.00" literals. Moving the
  // constant moved only the amount, publishing a quote for one figure against a
  // URL naming another; a vanilla client paying the listing verbatim is then
  // refused at settle for quoting wrong, which makes discovery decoration.
  const { items } = buildDiscoveryListing(inputs);
  for (const item of items) {
    const sgd = new URL(item.resource).searchParams.get("sgd");
    assert.equal(sgd, SAMPLE_SGD, "the URL names the listed price");
    for (const accept of item.accepts) {
      assert.equal(accept.extra["sgd"], sgd, "extra.sgd restates the same price");
      const token = inputs.tokens.find((t) => t.name === accept.extra["name"])!;
      assert.equal(
        accept.amount,
        quoteAmountIn(parseSgd(sgd!), token.rate).toString(),
        "the quote prices exactly the amount the URL asks for",
      );
    }
  }
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
  // limit=0 falls back rather than returning an empty page: an empty `items`
  // beside a non-zero `total` reads as the end of the rail and stops the walk.
  // offset=0 is a real position, so only `limit` floors at 1.
  assert.deepEqual(parsePaging("0", "0"), { limit: 100, offset: 0 });
  assert.deepEqual(parsePaging("1", "0"), { limit: 1, offset: 0 });
});
