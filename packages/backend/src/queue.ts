/**
 * Serial FIFO queue: jobs run one at a time in submission order, and a
 * rejected job never stalls the queue — the rejection propagates to that
 * job's caller only.
 */
export function createFifoQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
