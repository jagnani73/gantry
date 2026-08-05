/** Two-tone settlement chime via Web Audio — no asset file, no autoplay fetch. */

let ctx: AudioContext | null = null;

/** Must be called from a user gesture once (browser autoplay policy). */
export async function enableSound(): Promise<void> {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
}

export function soundEnabled(): boolean {
  return ctx !== null && ctx.state === "running";
}

export function chime(): void {
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const [freq, start] of [
    [880, 0],
    [1318.5, 0.12],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.18, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.4);
  }
}
