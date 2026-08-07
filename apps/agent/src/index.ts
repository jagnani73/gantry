import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";
import * as narrator from "./narrator";
import { runScripted } from "./scripted";
import { agentTools, lockLiveTools, toolCallsStarted } from "./tools";

/**
 * The Gantry demo agent CLI. Live mode streams claude-opus-5 through the beta
 * tool runner; if NOTHING has streamed within AGENT_LLM_TIMEOUT_MS (or the
 * key is missing / the API dies before any tool started), the scripted engine
 * takes over — same tools, same typewriter, visually identical.
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
If a payment is rejected, the errorReason is an on-chain contract error name: report it verbatim (e.g. CategoryNotAllowed), explain it in plain words, and stop — never call pay_merchant again for the same purchase, including after transport errors or unknown outcomes.
Report results faithfully: quote transaction URLs from tool results exactly; never invent hashes or amounts. Fields ending in Sgd are S$ display values.`;

async function runLive(prompt: string): Promise<"done" | "timeout"> {
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  let sawStream = false;
  let abandoned = false;

  const consume = (async (): Promise<"done"> => {
    const runner = client.beta.messages.toolRunner({
      model: "claude-opus-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      tools: agentTools,
      stream: true,
    });
    for await (const messageStream of runner) {
      for await (const event of messageStream) {
        // ANY event counts as liveness — a model that opens with a silent
        // tool call (no text preamble) must still defuse the timeout, or the
        // fallback could start while a tool is executing.
        sawStream = true;
        if (abandoned) return "done";
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          narrator.write(event.delta.text);
        }
        if (event.type === "message_stop") narrator.newline();
      }
    }
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
    console.error('usage: pnpm --filter @gantry/agent start "buy the team lunch from Ah Hock"');
    process.exit(2);
  }

  narrator.headline("gantry agent");
  narrator.newline();

  if (!env.anthropicApiKey) {
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
