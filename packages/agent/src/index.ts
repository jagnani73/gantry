import * as narrator from "./narrator";
import { runAgent, type RunOutcome } from "./run";

/**
 * The Gantry demo agent CLI.
 *
 * A thin wrapper now: `run.ts` owns the model, the tools and every decision
 * about whether money may move, and this file only turns the outcome into
 * terminal output and an exit code. That split exists so a second caller — an
 * HTTP route streaming the same run — cannot reimplement the fallback gate
 * slightly differently.
 *
 * Exit codes: 2 means invoked or configured wrong, 1 means the run happened and
 * did not end well, 0 means it completed or fell back cleanly. Anything wrapping
 * this must gate on the CODE, never on the transcript — a run that narrates a
 * purchase it never made exits 1 while its stdout reads like success.
 */

function report(outcome: RunOutcome): number {
  switch (outcome.kind) {
    case "completed":
      return 0;

    case "scripted":
      // The scripted engine prints no banner by design (the two modes must look
      // identical to the audience), so without this the operator cannot tell a
      // free-tier 429 or a dead key from a genuine live run — and "live LLM
      // tool-use decisions" is on the honest-labels list. stderr keeps it off
      // the demo output.
      console.error(
        `\n[agent] falling back to scripted narration (${outcome.reason}); wire traffic is unchanged.`,
      );
      return 0;

    case "silent":
      console.error(
        `\n[agent] the model ${outcome.detail ? "failed mid-stream" : "finished"} without ` +
          "calling a single tool: nothing was checked and nothing was paid, whatever the " +
          "narration above implied.\n" +
          "[agent] not falling back, because the scripted engine would pay and " +
          "this run gave no evidence that was wanted. Check the model supports " +
          "native tool calling, then re-run.",
      );
      // The stream error, when there was one. Kept separate from the sentence
      // above because that sentence is the operator's instruction and this is
      // the machine detail behind it.
      if (outcome.detail) console.error(`[agent] (${outcome.detail})`);
      return 1;

    case "abandoned":
      // Money may already have moved — never re-run the flow. The tool-status
      // lines above carry the structured results; just state the narration died.
      if (outcome.detail) console.error(`(${outcome.detail})`);
      console.error(
        `\n[agent] ${outcome.context} after ${outcome.toolCalls} tool call(s) started. ` +
          "See the tool results above; not re-running the flow.",
      );
      return 1;

    case "misconfigured":
      console.error(`\n[agent] ${outcome.message}`);
      return 2;
  }
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('usage: pnpm --filter @gantry/agent start "buy 3 iced teas for the team (S$4.50) from Ah Hock"');
    process.exit(2);
  }

  narrator.headline("gantry agent");
  narrator.newline();

  const outcome = await runAgent(prompt, (label) => {
    console.error(`[agent] narrating with ${label}`);
  });
  // `exitCode`, not `exit()`. stdout/stderr are ASYNC when piped, and
  // process.exit() truncates whatever has not flushed — which is exactly the
  // operator-facing `[agent]` lines above, including the `silent` refusal and
  // the scripted-fallback notice. This repo has already been bitten once by a
  // pipe hiding an outcome; the exit code is the thing to gate on, and it
  // survives either way.
  process.exitCode = report(outcome);
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exitCode = 1;
});
