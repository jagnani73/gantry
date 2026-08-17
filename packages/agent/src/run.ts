import { stepCountIs, streamText, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "./env";
import * as narrator from "./narrator";
import { runScripted } from "./scripted";
import { agentTools, lockLiveTools, resetRunState, toolCallsStarted } from "./tools";

/**
 * One agent run, independent of who is watching it.
 *
 * Lifted out of the CLI so a terminal and an HTTP stream can drive the same
 * code. The split is deliberate about where the decisions live: everything that
 * decides whether money may move stays HERE, and the caller only chooses how to
 * render the result. A second caller that re-implemented the fallback gate would
 * be a second chance to get it wrong.
 *
 * The gate, unchanged in substance: the scripted fallback may only start while
 * `toolCallsStarted === 0`, the counter increments BEFORE each effectful call so
 * a payMerchant that dies mid-flight still counts, and engaging the fallback
 * locks the live runner's tools so an abandoned runner cannot start a new one.
 * `pay_merchant` moves real money; it must never run twice.
 *
 * SINGLE-FLIGHT. `tools.ts` holds the counters in module state, so two runs at
 * once share them — and they are the thing standing between a stalled narration
 * and a double payment. A server must serialise runs, not merely rate-limit
 * them. `resetRunState()` below makes a run repeatable; it does not make one
 * concurrent.
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
 * How a run ended, as data rather than as an exit code.
 *
 * The CLI turns these into exit codes and the route will turn them into a
 * status; neither decides anything. `silent` and `abandoned` are separate
 * because they mean opposite things about money: `silent` proves nothing moved,
 * `abandoned` means something may have.
 */
export type RunOutcome =
  | { kind: "completed" }
  | { kind: "scripted"; reason: string }
  | { kind: "silent" }
  | { kind: "abandoned"; context: string; toolCalls: number; detail?: string }
  | { kind: "misconfigured"; message: string };

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
 * see the `silent` outcome below.
 */
function selectProvider(): Provider | null | { error: string } {
  if (env.aisaApiKey) {
    if (!env.aisaModel) {
      return {
        error:
          "AISA_API_KEY is set but AISA_MODEL is not. Name a model from AIsa's " +
          "catalog that supports native tool calling; there is no safe default.",
      };
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
    for await (const part of result.stream) {
      // A model that opens with a silent tool call (no text preamble) must
      // still defuse the timeout, or the fallback could start while a tool is
      // executing — so every non-synthetic part counts, not just text.
      if (!SYNTHETIC_PARTS.has(part.type)) sawStream = true;
      if (abandoned) return "done";
      if (part.type === "text-delta") {
        narrator.write(part.text);
      } else if (part.type === "error") {
        // streamText folds errors into the stream instead of rejecting —
        // rethrow so the gated catch below owns the fallback decision.
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
 * Run the agent once and say how it ended. Never exits the process.
 *
 * @param onProvider told which model answered, for operator-facing output. The
 * two providers are indistinguishable to the room by design, and must stay
 * distinguishable to whoever is running it.
 */
export async function runAgent(
  prompt: string,
  onProvider?: (label: string) => void,
): Promise<RunOutcome> {
  resetRunState();

  const selected = selectProvider();
  if (selected !== null && "error" in selected) {
    return { kind: "misconfigured", message: selected.error };
  }
  if (selected === null) {
    await runScripted(prompt);
    return { kind: "scripted", reason: "no provider key configured" };
  }
  onProvider?.(selected.label);

  try {
    const outcome = await runLive(prompt, selected);
    if (outcome === "timeout") {
      if (toolCallsStarted > 0) {
        return { kind: "abandoned", context: "live stream stalled", toolCalls: toolCallsStarted };
      }
      lockLiveTools();
      await runScripted(prompt);
      return { kind: "scripted", reason: `live model sent nothing in ${env.llmTimeoutMs}ms` };
    }
    // Clean stream, zero tools: the shape of a gateway answering a tool call as
    // prose. It does NOT fall back, even though the fallback's precondition is
    // satisfied and would be safe from double-spend — the scripted engine PAYS,
    // and the one thing this run told us is that the model chose not to.
    // Turning "it only talked" into "we sent money" is the worse failure.
    if (toolCallsStarted === 0) return { kind: "silent" };
    return { kind: "completed" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (toolCallsStarted > 0) {
      return {
        kind: "abandoned",
        context: "live narration failed",
        toolCalls: toolCallsStarted,
        detail,
      };
    }
    lockLiveTools();
    await runScripted(prompt);
    return { kind: "scripted", reason: detail };
  }
}
