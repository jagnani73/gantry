/**
 * The one output surface both modes share: live LLM deltas and the scripted
 * fallback stream through the same typewriter, print the same dim tool-status
 * lines, and render results identically — which is what makes the 8s fallback
 * visually indistinguishable on stage.
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const CHAR_DELAY_MS = 12;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams pre-written text with an LLM-like cadence (scripted mode). */
export async function type(text: string): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    if (char !== " ") await sleep(CHAR_DELAY_MS);
  }
}

/** Live mode: deltas already arrive at model cadence — write straight through. */
export function write(text: string): void {
  process.stdout.write(text);
}

export function toolStatus(line: string): void {
  process.stdout.write(`\n${DIM}  ⚙ ${line}${RESET}\n`);
}

export function headline(line: string): void {
  process.stdout.write(`${BOLD}${line}${RESET}\n`);
}

export function newline(): void {
  process.stdout.write("\n");
}
