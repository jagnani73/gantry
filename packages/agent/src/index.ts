import { stepCountIs, streamText, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "./env";
import * as narrator from "./narrator";
import { runScripted } from "./scripted";
import { agentTools, lockLiveTools, toolCallsStarted } from "./tools";

/**
 * The Gantry demo agent CLI. Live mode streams a model through the Vercel AI
 * SDK's multi-step tool loop (see `selectProvider`); if NOTHING has streamed within
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
If a payment is rejected on-chain, the errorReason is a contract error name: report it verbatim (e.g. CategoryNotAllowed), explain it in plain words, state that no funds moved, and stop. If the result is transport_error, the failure happened BEFORE the payment request went out — nothing was paid, say so plainly. If the result is outcome_unknown, the payment MAY still have settled — say the outcome is unconfirmed and to check the dashboard; NEVER claim funds are safe in that case. Either way, never call pay_merchant again for the same purchase.
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

/** Google AI Studio free tier. Fixed: swapping models is a code change with
 * prompt implications, not a deployment knob. */
const GOOGLE_MODEL = "gemini-flash-latest";

/** The model plus a name for the operator, who otherwise cannot tell which
 * provider answered — the audience-facing output is identical by design. */
type Provider = { model: LanguageModel; label: string };

/**
 * Which model narrates. AIsa first when configured, then Google, else scripted.
 *
 * Both are the same `streamText` surface — `tools`, `stopWhen`, `toolChoice`
 * and the stream parts are provider-independent, so this is a
 * model-construction swap and nothing else.
 *
 * The risk it introduces is NOT in the SDK. "OpenAI-compatible" is a claim
 * about the HTTP shape, not about function-calling fidelity: gateways are
 * documented to proxy models that answer a tool call as prose in
 * `message.content` while `tool_calls` stays empty. That failure is silent
 * HERE in the worst way — text streams, so the timeout never fires; no tool
 * runs, so `toolCallsStarted` stays 0; the stream ends clean. The agent would
 * narrate a purchase it never made. Pick a model with native tool calling, and
 * see the zero-tool guard in `main`.
 */
function selectProvider(): Provider | null {
  if (env.aisaApiKey) {
    if (!env.aisaModel) {
      throw new Error(
        "AISA_API_KEY is set but AISA_MODEL is not. Name a model from AIsa's " +
          "catalog that supports native tool calling — there is no safe default.",
      );
    }
    const aisa = createOpenAICompatible({
      name: "aisa",
      apiKey: env.aisaApiKey,
      baseURL: env.aisaBaseUrl,
    });
    return { model: aisa.chatModel(env.aisaModel), label: `aisa/${env.aisaModel}` };
  }
  if (env.googleApiKey) {
    const google = createGoogleGenerativeAI({ apiKey: env.googleApiKey });
    return { model: google(GOOGLE_MODEL), label: `google/${GOOGLE_MODEL}` };
  }
  return null;
}

async function runLive(prompt: string, provider: Provider): Promise<"done" | "timeout"> {
  const controller = new AbortController();
  let sawStream = false;
  let abandoned = false;

  const consume = (async (): Promise<"done"> => {
    const result = streamText({
      model: provider.model,
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

/**
 * The stream ended cleanly and not one tool ran.
 *
 * This is the shape a gateway takes when it answers a tool call as prose in
 * `message.content` while `tool_calls` stays empty: text streams, so the
 * timeout never fires; nothing executes, so no error is raised; the run
 * "succeeds" having checked nothing and paid nothing, while the narration says
 * otherwise. Silent, and on a stage indistinguishable from a real payment.
 *
 * It deliberately does NOT fall back. The fallback's own precondition
 * (`toolCallsStarted === 0`) is satisfied here, so it would be safe from
 * double-spend and is the obvious move — but the scripted engine PAYS, and the
 * one thing we know about this run is that the model chose not to. Turning "it
 * only talked" into "we sent money" is a worse failure than the one being
 * reported, so this stops and says so.
 */
function refuseSilentRun(): never {
  console.error(
    "\n[agent] the model finished without calling a single tool: nothing was " +
      "checked and nothing was paid, whatever the narration above implied.\n" +
      "[agent] not falling back, because the scripted engine would pay and " +
      "this run gave no evidence that was wanted. Check the model supports " +
      "native tool calling, then re-run.",
  );
  process.exit(1);
}

function refuseFallback(context: string): never {
  // Money may already have moved — never re-run the flow. The tool-status
  // lines above carry the structured results; just state the narration died.
  console.error(
    `\n[agent] ${context} after ${toolCallsStarted} tool call(s) started. ` +
      "See the tool results above; not re-running the flow.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('usage: pnpm --filter @gantry/agent start "buy 3 iced teas for the team (S$4.50) from Ah Hock"');
    process.exit(2);
  }

  narrator.headline("gantry agent");
  narrator.newline();

  const provider = selectProvider();
  if (!provider) {
    await runScripted(prompt);
    return;
  }
  // Operator-only, like announceFallback: the two providers must be
  // indistinguishable to the room, and distinguishable to us.
  console.error(`[agent] narrating with ${provider.label}`);

  try {
    const outcome = await runLive(prompt, provider);
    if (outcome === "timeout") {
      if (toolCallsStarted > 0) refuseFallback("live stream stalled");
      announceFallback(`live model sent nothing in ${env.llmTimeoutMs}ms`);
      lockLiveTools();
      await runScripted(prompt);
    } else if (toolCallsStarted === 0) {
      refuseSilentRun();
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
  console.error(`\n[agent] falling back to scripted narration (${reason}); wire traffic is unchanged.`);
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exit(1);
});
