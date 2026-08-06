import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";
import * as narrator from "./narrator";
import { runScripted } from "./scripted";
import { agentTools, completedToolCalls } from "./tools";

/**
 * The Gantry demo agent CLI. Live mode streams claude-opus-5 through the beta
 * tool runner; if the first token hasn't arrived within AGENT_LLM_TIMEOUT_MS
 * (or the key is missing / the API dies before any tool ran), the scripted
 * engine takes over — same tools, same typewriter, visually identical.
 *
 * The load-bearing safety gate: the fallback may only start while NO tool has
 * completed. pay_merchant moves real money; after any tool ran, an LLM failure
 * prints the situation and exits instead of ever re-running the flow.
 */

const SYSTEM_PROMPT = `You are Gantry's purchasing agent in Singapore. You hold a session key to an on-chain AgentPBMWallet (purpose-bound money): the wallet enforces your spend policy in the contract itself — you only authorize payments.

Work briskly: check what you need with tools, then act. Narrate in one or two short sentences per step; no headers or lists.
When asked to buy something, ALWAYS attempt it with pay_merchant — the on-chain wallet is the authority on policy, not you. Never pre-refuse a purchase from check_my_policy alone.
If a payment is rejected, the errorReason is an on-chain contract error name: report it verbatim (e.g. CategoryNotAllowed), explain it in plain words, and stop — never retry a rejected payment.
Report results faithfully: quote transaction URLs from tool results exactly; never invent hashes or amounts. Fields ending in Sgd are S$ display values.`;

async function runLive(prompt: string): Promise<"done" | "timeout"> {
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  let firstTokenSeen = false;
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
        if (abandoned) return "done";
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          firstTokenSeen = true;
          narrator.write(event.delta.text);
        }
        if (event.type === "message_stop") narrator.newline();
      }
    }
    return "done";
  })();

  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => {
      if (!firstTokenSeen) resolve("timeout");
    }, env.llmTimeoutMs);
    timer.unref?.();
  });

  const outcome = await Promise.race([consume, timeout]);
  if (outcome === "timeout") abandoned = true;
  return outcome;
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
      // First token never arrived and no tool has run — the scripted engine
      // replays the same flow from scratch, visually identical.
      await runScripted(prompt);
    }
  } catch (err) {
    if (completedToolCalls === 0) {
      await runScripted(prompt);
      return;
    }
    // Money may already have moved — never re-run the flow. The tool-status
    // lines above carry the structured results; just state the narration died.
    console.error(
      `\n[agent] live narration failed after ${completedToolCalls} tool call(s) — ` +
        `see the tool results above; not re-running. (${err instanceof Error ? err.message : String(err)})`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exit(1);
});
