import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor } from "./cursor";

test("encodes the SSE event id grammar", () => {
  // Byte-identical to what routes/events.ts writes as the event id, which is
  // what lets a live client hand its Last-Event-ID straight back as `before`.
  assert.equal(encodeCursor({ blockNumber: 30123456, logIndex: 7 }), "30123456:7");
  assert.equal(encodeCursor({ blockNumber: 0, logIndex: 0 }), "0:0");
});

test("round-trips", () => {
  const position = { blockNumber: 29876543, logIndex: 12 };
  assert.deepEqual(decodeCursor(encodeCursor(position)), position);
});

test("encode refuses a position that could never match a row", () => {
  for (const bad of [
    { blockNumber: Number.NaN, logIndex: 0 },
    { blockNumber: -1, logIndex: 0 },
    { blockNumber: 1, logIndex: -1 },
    { blockNumber: 1.5, logIndex: 0 },
    { blockNumber: Number.MAX_SAFE_INTEGER + 2, logIndex: 0 },
  ]) {
    assert.throws(() => encodeCursor(bad), `expected throw: ${JSON.stringify(bad)}`);
  }
});

test("decode returns null only for malformed input", () => {
  for (const bad of [
    "",
    "   ",
    "123",
    "123:",
    ":4",
    "123:4:5",
    "0x1f:4",
    "-1:4",
    "1.5:4",
    "abc",
    // Past 2^53 Number() rounds, so this would decode to a plausible block
    // that no row has and page from the wrong place.
    "99999999999999999999:4",
  ]) {
    assert.equal(decodeCursor(bad), null, `expected null: ${JSON.stringify(bad)}`);
  }
});

test("decode tolerates query-param whitespace and leading zeros", () => {
  assert.deepEqual(decodeCursor("  123:4\n"), { blockNumber: 123, logIndex: 4 });
  assert.deepEqual(decodeCursor("0000123:04"), { blockNumber: 123, logIndex: 4 });
});
