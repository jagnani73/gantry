"use client";

import { useEffect, useState } from "react";

/**
 * The wall clock, in unix seconds, or null until the component has mounted.
 *
 * Null rather than `Date.now()` because the server cannot know the browser's
 * clock: rendering a date during SSR that the client disagrees with a moment
 * later is a hydration error bought for nothing, and every screen that wants a
 * date here has data that only arrives in the browser anyway.
 *
 * It ticks so that a dashboard left open on a counter rolls into the next day on
 * its own — "today's takings" that silently keep yesterday's rows would be the
 * worst possible number to get wrong.
 */
export function useNowSeconds(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
