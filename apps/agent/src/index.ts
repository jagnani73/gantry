import { stepCountIs, streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "./env";
import * as narrator from "./narrator";
import { runScripted } from "./scripted";
import { agentTools, lockLiveTools, toolCallsStarted } from "./tools";

/**
 * The Gantry demo agent CLI. Live mode streams Gemini (free tier) through the
 * Vercel AI SDK's multi-step tool loop; if NOTHING has streamed within
 * AGENT_LLM_TIMEOUT_MS (or the key is missing / the API dies before any tool
 * started), the scripted engine takes over — same tools, same typewriter,
 * visually identical.
 *
 * The load-bearing safety gate, enforced on BOTH fallback paths (timeout and
 * error): the fallback may only start while `toolCallsStarted === 0` — the
 * counter increments before each effectful call, so a payMerchant that dies
 * mid-flight (money possibly moving) still counts. Engaging the fallback also
 * locks the live runner's tools, so an abandoned runner can never start a new
 * one. pay_merchant moves real money; it must never run twice.
 */

const SYSTEM_PROMPT = `You are Gantry's purchasing agent in Singapore. You hold a session key to an on-chain AgentPBMWallet (purpose-bound money): the wallet enforces your spend policy in the contract itself — you only authorize payments.

Work briskly: check what you need with tools, then act. Narrate in one or two short sentences per step; no headers or lists.
When asked to buy something, ALWAYS attempt it with pay_merchant — the on-chain wallet is the authority on policy, not you. Never pre-refuse a purchase from check_my_policy alone.
If a payment is rejected, the errorReason is an on-chain contract error name: report it verbatim (e.g. CategoryNotAllowed), explain it in plain words, state that no funds moved, and stop — never call pay_merchant again for the same purchase, including after transport errors or unknown outcomes.
Report results faithfully: quote transaction URLs from tool results exactly; never invent hashes or amounts. Fields ending in Sgd are S$ display values.
Pay exactly the amount the user asked for; if no amount was given, use the merchant's stated price from context — never invent a bigger basket.`;

async function runLive(prompt: string): Promise<"done" | "timeout"> {
  const google = createGoogleGenerativeAI({ apiKey: env.googleApiKey });
  let sawStream = false;
  let abandoned = false;

  const consume = (async (): Promise<"done"> => {
    const result = streamText({
      model: google(env.llmModel),
      system: SYSTEM_PROMPT,
      prompt,
      tools: agentTools,
      stopWhen: stepCountIs(8),
      // Rehearsal consistency: greedy decoding keeps the tool sequence and
      // wording stable across runs (the chain, not the sampler, is the
      // authority on outcomes either way).
      temperature: 0,
    });
    for await (const part of result.fullStream) {
      // ANY part counts as liveness — a model that opens with a silent tool
      // call (no text preamble) must still defuse the timeout, or the
      // fallback could start while a tool is executing.
      sawStream = true;
      if (abandoned) return "done";
      if (part.type === "text-delta") {
        narrator.write(part.text);
      } else if (part.type === "error") {
        // streamText folds errors into the stream instead of rejecting —
        // rethrow so the gated catch in main() owns the fallback decision.
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
    narrator.newline();
    return "done";
  })();

  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => {
      if (!sawStream) resolve("timeout");
    }, env.llmTimeoutMs);
    timer.unref?.();
  });

  const outcome = await Promise.race([consume, timeout]);
  if (outcome === "timeout") abandoned = true;
  return outcome;
}

function refuseFallback(context: string): never {
  // Money may already have moved — never re-run the flow. The tool-status
  // lines above carry the structured results; just state the narration died.
  console.error(
    `\n[agent] ${context} after ${toolCallsStarted} tool call(s) started — ` +
      "see the tool results above; not re-running the flow.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('usage: pnpm --filter @gantry/agent start "buy the team lunch (S$19.50) from Ah Hock"');
    process.exit(2);
  }

  narrator.headline("gantry agent");
  narrator.newline();

  if (!env.googleApiKey) {
    await runScripted(prompt);
    return;
  }

  try {
    const outcome = await runLive(prompt);
    if (outcome === "timeout") {
      if (toolCallsStarted > 0) refuseFallback("live stream stalled");
      lockLiveTools();
      await runScripted(prompt);
    }
  } catch (err) {
    if (toolCallsStarted > 0) {
      console.error(`(${err instanceof Error ? err.message : String(err)})`);
      refuseFallback("live narration failed");
    }
    lockLiveTools();
    await runScripted(prompt);
  }
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exit(1);
});
