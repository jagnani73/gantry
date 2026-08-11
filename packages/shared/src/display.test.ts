import { test } from "node:test";
import assert from "node:assert/strict";
import { basescanAddress, basescanTx, checksummed, formatBps, shortAddress } from "./display";
import { CARD_FEE_BPS, GANTRY_FEE_BPS } from "./constants";

test("shortAddress keeps both ends and the 0x", () => {
  assert.equal(shortAddress("0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0"), "0x6F02…5Ce0");
});

test("shortAddress preserves EIP-55 casing", () => {
  // The checksum lives in the capitalisation; normalising it here would discard
  // the only thing that makes a truncated address verifiable by eye.
  const eip55 = "0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713";
  assert.equal(shortAddress(eip55), "0xEdcD…b713");
  assert.notEqual(shortAddress(eip55), shortAddress(eip55.toLowerCase()));
});

test("checksummed restores the casing a lowercasing store dropped", () => {
  const eip55 = "0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713";
  assert.equal(checksummed(eip55.toLowerCase()), eip55);
  assert.equal(checksummed(eip55), eip55);
  assert.equal(checksummed(eip55.toUpperCase().replace("0X", "0x")), eip55);
});

test("checksummed passes anything that is not an address through untouched", () => {
  // Row→wire mappers on the live feed's only path call this. One unrecognisable
  // value must cost that one field, never the whole page — so no throw, and no
  // invented address either.
  const tooLong = "0x00000000000000000000000000000000000c0ffee";
  assert.equal(checksummed(tooLong), tooLong);
  assert.equal(checksummed(""), "");
  // A hash is not an address and keeps its own canonical (lower) form.
  const txHash = `0x${"ab".repeat(32)}`;
  assert.equal(checksummed(txHash), txHash);
});

test("shortAddress leaves anything too short to truncate alone", () => {
  assert.equal(shortAddress("0x1234"), "0x1234");
  assert.equal(shortAddress(""), "");
});

test("formatBps renders the real fee constants", () => {
  assert.equal(formatBps(GANTRY_FEE_BPS), "0.5%");
  assert.equal(formatBps(CARD_FEE_BPS), "2.8%");
});

test("formatBps trims trailing zeros rather than padding", () => {
  assert.equal(formatBps(100), "1%");
  assert.equal(formatBps(0), "0%");
  assert.equal(formatBps(1), "0.01%");
});

test("formatBps refuses a non-finite rate instead of rendering NaN%", () => {
  assert.throws(() => formatBps(Number.NaN));
});

test("basescan helpers build explorer URLs from the shared base", () => {
  assert.equal(
    basescanAddress("0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0"),
    "https://sepolia.basescan.org/address/0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0",
  );
  assert.equal(basescanTx("0xabc"), "https://sepolia.basescan.org/tx/0xabc");
});
