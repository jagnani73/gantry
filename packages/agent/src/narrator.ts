/**
 * The one output surface both modes share: live LLM deltas and the scripted
 * fallback stream through the same typewriter, print the same dim tool-status
 * lines, and render results identically — which is what makes the 8s fallback
 * visually indistinguishable on stage.
 *
 * The destination is injectable so the same run can drive a terminal or an HTTP
 * stream. The sink takes SEMANTIC events rather than pre-formatted strings:
 * putting the ANSI escapes in the terminal sink is what keeps them out of a
 * response body, and it is the reason a second consumer does not have to strip
 * anything.
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const CHAR_DELAY_MS = 12;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Sink {
  /** Narration, exactly as the model produced it. */
  text(chunk: string): void;
  /** A tool starting, named. */
  tool(line: string): void;
  /** The run's title. */
  headline(line: string): void;
}

const terminal: Sink = {
  text: (chunk) => process.stdout.write(chunk),
  tool: (line) => process.stdout.write(`\n${DIM}  ⚙ ${line}${RESET}\n`),
  headline: (line) => process.stdout.write(`${BOLD}${line}${RESET}\n`),
};

/**
 * Module-level, which is only sound because a run is single-flight.
 *
 * `tools.ts` already keeps this module's per-run state in module globals
 * (`toolCallsStarted`, the live-tool lock), so the agent has always been
 * one-run-per-process. A caller driving two runs at once would interleave them
 * into one sink AND share those counters — and the counters are what stop a
 * payment running twice. Any server MUST serialise; see `runAgent`.
 */
let sink: Sink = terminal;

export function setSink(next: Sink): void {
  sink = next;
}

export function resetSink(): void {
  sink = terminal;
}

/** Streams pre-written text with an LLM-like cadence (scripted mode). */
export async function type(text: string): Promise<void> {
  for (const char of text) {
    sink.text(char);
    if (char !== " ") await sleep(CHAR_DELAY_MS);
  }
}

/** Live mode: deltas already arrive at model cadence — write straight through. */
export function write(text: string): void {
  sink.text(text);
}

export function toolStatus(line: string): void {
  sink.tool(line);
}

export function headline(line: string): void {
  sink.headline(line);
}

export function newline(): void {
  sink.text("\n");
}
