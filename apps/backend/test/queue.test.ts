import { test } from "node:test";
import assert from "node:assert/strict";
import { createFifoQueue } from "../src/queue";

test("jobs run strictly in FIFO order", async () => {
  const enqueue = createFifoQueue();
  const order: number[] = [];
  let release1!: () => void;
  const gate = new Promise<void>((resolve) => (release1 = resolve));

  const p1 = enqueue(async () => {
    await gate;
    order.push(1);
  });
  const p2 = enqueue(async () => {
    order.push(2);
  });

  release1();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});

test("a rejected job propagates to its caller without stalling the queue", async () => {
  // The demo script includes an on-chain revert on purpose — one rejected
  // relayer job must never wedge every later payment.
  const enqueue = createFifoQueue();
  const boom = new Error("simulated revert");

  const p1 = enqueue(async () => {
    throw boom;
  });
  const p2 = enqueue(async () => "alive");

  await assert.rejects(p1, boom);
  assert.equal(await p2, "alive");
});

test("results are returned per job", async () => {
  const enqueue = createFifoQueue();
  assert.equal(await enqueue(async () => 42), 42);
  assert.equal(await enqueue(async () => "next"), "next");
});
