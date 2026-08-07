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
If a payment is rejected on-chain, the errorReason is a contract error name: report it verbatim (e.g. CategoryNotAllowed), explain it in plain words, state that no funds moved, and stop. If the result is transport_error or outcome_unknown, the payment MAY still have settled — say the outcome is unconfirmed and to check the dashboard; NEVER claim funds are safe in that case. Either way, never call pay_merchant again for the same purchase.
Report results faithfully: quote transaction URLs from tool results exactly; never invent hashes or amounts. Fields ending in Sgd are S$ display values.
Pay exactly the amount the user asked for; if no amount was given, use the merchant's stated price from context — never invent a bigger basket.`;

/**
 * Stream parts the SDK enqueues synchronously, before a byte leaves the
 * machine: `start` is pushed from the ReadableStream's own start() callback.
 * Counting them as liveness defuses the timeout ~5ms in and makes the fallback
 * unreachable — which is exactly what the M3→M4 SDK swap did, silently.
 * Everything else means the model or the transport actually answered.
 */
const SYNTHETIC_PARTS = new Set(["start", "start-step"]);

async function runLive(prompt: string): Promise<"done" | "timeout"> {
  const google = createGoogleGenerativeAI({ apiKey: env.googleApiKey });
  const controller = new AbortController();
  let sawStream = false;
  let abandoned = false;

  const consume = (async (): Promise<"done"> => {
    const result = streamText({
      model: google(env.llmModel),
      system: SYSTEM_PROMPT,
      prompt,
      tools: agentTools,
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      // Rehearsal consistency: greedy decoding keeps the tool sequence and
      // wording stable across runs (the chain, not the sampler, is the
      // authority on outcomes either way).
      temperature: 0,
    });
    for await (const part of result.fullStream) {
      // A model that opens with a silent tool call (no text preamble) must
      // still defuse the timeout, or the fallback could start while a tool is
      // executing — so every non-synthetic part counts, not just text.
      if (!SYNTHETIC_PARTS.has(part.type)) sawStream = true;
      if (abandoned) return "done";
      if (part.type === "text-delta") {
        narrator.write(part.text);
      } else if (part.type === "error") {
        // streamText folds errors into the stream instead of rejecting —
        // rethrow so the gated catch in main() owns the fallback decision.
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      } else if (part.type === "tool-error") {
        // The SDK swallows a thrown tool and hands its message to the model as
        // a result, which the model may paraphrase or ignore. The tools are
        // written not to throw, so reaching here is a bug the operator must
        // see — but it is not money-moving, so don't kill a live demo over it.
        console.error(
          `\n[agent] tool ${part.toolName} threw: ` +
            `${part.error instanceof Error ? part.error.message : String(part.error)}`,
        );
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
  if (outcome === "timeout") {
    abandoned = true;
    // A stalled request holds its socket, which holds the event loop open —
    // without this the process would never exit after the fallback finishes.
    controller.abort();
    // The abandoned consumer rejects (AbortError) after we've moved on; swallow
    // it so it can't surface as an unhandled rejection mid-fallback.
    void consume.catch(() => undefined);
  }
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
      announceFallback(`live model sent nothing in ${env.llmTimeoutMs}ms`);
      lockLiveTools();
      await runScripted(prompt);
    }
  } catch (err) {
    if (toolCallsStarted > 0) {
      console.error(`(${err instanceof Error ? err.message : String(err)})`);
      refuseFallback("live narration failed");
    }
    announceFallback(err instanceof Error ? err.message : String(err));
    lockLiveTools();
    await runScripted(prompt);
  }
}

/**
 * The scripted engine prints no banner by design (the two modes must look
 * identical to the audience), so without this the operator cannot tell a
 * free-tier 429 or a dead key from a genuine live run — and "live LLM tool-use
 * decisions" is on the honest-labels list. stderr keeps it off the demo output.
 */
function announceFallback(reason: string): void {
  console.error(`\n[agent] ${reason} — falling back to scripted narration; wire traffic is unchanged.`);
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exit(1);
});
