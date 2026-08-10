"use client";

import { useCallback, useEffect, useState } from "react";
import { chime, enableSound, soundEnabled } from "@/lib/chime";

/**
 * The counter chime, as a preference the merchant owns.
 *
 * `lib/chime.ts` only knows how to start an AudioContext and play a tone — it
 * has no "off", because a shop that wants silence is a product decision rather
 * than an audio one. So the preference lives here, persists per browser, and
 * gates the call.
 *
 * The second half is the browser's autoplay rule: an AudioContext cannot start
 * without a user gesture, and it is suspended again by every reload. A merchant
 * who turned the chime on yesterday would otherwise reopen the dashboard to
 * silence with a toggle claiming "On". So while the preference is on but the
 * context is not running, the FIRST interaction anywhere on the page arms it.
 */

const STORAGE_KEY = "gantry.merchant.chime";

export interface ChimeControl {
  /** The merchant's preference. */
  on: boolean;
  /** Whether the browser will actually play it — false until a gesture arms it. */
  armed: boolean;
  set(next: boolean): Promise<void>;
  /** No-ops when off or unarmed; callers never have to check. */
  ring(): void;
}

export function useChime(): ChimeControl {
  // Starts false on both sides of hydration; localStorage is read in an effect
  // because the server cannot know it and a mismatch would blank the toggle.
  const [on, setOn] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch (err) {
      // ACCESSING `window.localStorage` throws SecurityError in a browser with
      // site data blocked — not just reading a key. Unguarded, that throw
      // propagates out of `MerchantProvider` and takes down the entire
      // back-office through the nearest error boundary, over a sound preference.
      console.warn("gantry: chime preference could not be read", err);
    }
  }, []);

  useEffect(() => {
    if (!on || armed) return;
    const arm = () => {
      void enableSound().then(() => setArmed(soundEnabled()));
    };
    // `once` on both: whichever the merchant does first is the gesture, and the
    // other listener is torn down by the cleanup below.
    document.addEventListener("pointerdown", arm, { once: true });
    document.addEventListener("keydown", arm, { once: true });
    return () => {
      document.removeEventListener("pointerdown", arm);
      document.removeEventListener("keydown", arm);
    };
  }, [on, armed]);

  const set = useCallback(async (next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch (err) {
      // The toggle has ALREADY flipped, so an unhandled throw here leaves a
      // switch claiming a preference that was never written — and it reverts on
      // the next reload, which on a back-office left open on a counter reads as
      // "it keeps forgetting" and is unreproducible for whoever gets the report.
      console.warn("gantry: chime preference could not be saved", err);
    }
    if (!next) return;
    try {
      // Called straight from the toggle's click handler, so this IS the gesture.
      await enableSound();
      setArmed(soundEnabled());
    } catch (err) {
      // A browser that refuses to start audio leaves the label at "On · waiting
      // for a tap", which is true — it just never becomes armed.
      console.warn("gantry: this browser refused to start audio", err);
    }
  }, []);

  const ring = useCallback(() => {
    if (on) chime();
  }, [on]);

  return { on, armed, set, ring };
}
