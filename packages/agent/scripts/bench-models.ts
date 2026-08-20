/**
 * Measure candidate models on AIsa's gateway, before one of them narrates a demo.
 *
 * `AISA_MODEL` is required and undefaulted precisely because the catalog belongs
 * to a third party and a wrong id fails mid-run rather than at startup. This is
 * how that choice gets made on measurements instead of on a guess.
 *
 * MOCK EXECUTES, REAL EVERYTHING ELSE. The tools keep their real descriptions
 * and zod schemas -- imported from `src/tools.ts`, with only `execute` swapped
 * for a canned result -- so the bench cannot drift from the agent it is choosing
 * a model for, and cannot move USDC. `payMerchant` is never reached.
 *
 * What it measures, and what each one decides:
 *
 *  - ttfp    ms to the first non-synthetic stream part, against `SYNTHETIC_PARTS`
 *            imported from run.ts. This is the ONLY thing AGENT_LLM_TIMEOUT_MS
 *            gates on: `runLive` resolves "timeout" iff nothing streamed by then,
 *            and a timeout with zero tool calls routes the run into the scripted
 *            engine -- which PAYS. A model over that budget is disqualified
 *            however well it narrates.
 *  - tools   the call sequence. Empty is the `silent` outcome -- a gateway
 *            answering a tool call as prose in `message.content`. Unusable.
 *  - payArgs whether it extracted the asked amount. A model that pays a number
 *            it invented is worse than one that refuses.
 *  - total   full wall time. Not a gate; the finals demo is 3 minutes long.
 *
 * One run per model at temperature 0 -- enough to disqualify, not enough to
 * rank two models a few hundred ms apart.
 *
 *   npx tsx scripts/bench-models.ts qwen-flash qwen3.7-flash
 */
import { stepCountIs, streamText, type Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { SYNTHETIC_PARTS, SYSTEM_PROMPT } from "../src/run";
import { agentTools } from "../src/tools";
import { env } from "../src/env";

/** The canonical demo ask. Benching a different prompt benches a different
 * model than the one the demo runs -- and this one carries its amount, which
 * is the rule an amount-less prompt exists to break. */
const PROMPT = "buy 3 iced teas for the team (S$4.50) from Ah Hock";

const EXPECT_HANDLE = "ah-hock-chicken-rice";
const EXPECT_SGD = /^4\.50?0*$/;

/** Generous against the agent's 8s: a slow model must be reported WITH its
 * number, not collapsed into an indistinguishable timeout. */
const HARD_ABORT_MS = 60_000;

type Call = { name: string; args: unknown };

/**
 * The real tools with their executes replaced. Descriptions and input schemas
 * come from `agentTools`, so a change there is measured here automatically --
 * which is the point, since tool descriptions are most of what a model is being
 * judged on.
 */
function benchTools(calls: Call[]): Record<string, Tool> {
  const canned: Record<string, unknown> = {
    list_merchants: [
      {
        handle: EXPECT_HANDLE,
        displayName: "Ah Hock Chicken Rice",
        location: "Maxwell Food Centre",
        category: "food_beverage",
      },
      {
        handle: "gadgethub-sg",
        displayName: "GadgetHub SG",
        location: "Sim Lim Square",
        category: "electronics",
      },
    ],
    check_my_policy: {
      dailyCap: "37255800",
      spentToday: "0",
      perTxCap: "14902320",
      categories: ["food_beverage"],
      expiry: 1789790400,
      balance: "10000000",
      rate: "1342100",
      dailyCapSgd: "50.000000",
      spentTodaySgd: "0.000000",
      balanceSgd: "13.421000",
    },
    pay_merchant: {
      settled: true,
      amountIn: "3352955",
      token: "USDC",
      xsgdOut: "4.500000",
      // Obviously fake, so a narration quoting it can never be mistaken for a
      // real receipt in a transcript.
      txHash: "0xBENCH_MOCK_NOT_A_REAL_TRANSACTION",
      explorer: "https://sepolia.basescan.org/tx/0xBENCH_MOCK_NOT_A_REAL_TRANSACTION",
    },
  };

  return Object.fromEntries(
    Object.entries(agentTools).map(([name, real]) => [
      name,
      {
        ...real,
        execute: async (args: unknown) => {
          calls.push({ name, args });
          return JSON.stringify(canned[name]);
        },
      },
    ]),
  ) as Record<string, Tool>;
}

type Row = {
  model: string;
  ttfp: number | null;
  total: number;
  calls: string[];
  payArgs: { handle?: string; sgd?: string } | null;
  paidRight: boolean;
  silent: boolean;
  error: string | null;
  text: string;
  verdict: string;
};

async function bench(model: string): Promise<Row> {
  const calls: Call[] = [];
  const aisa = createOpenAICompatible({
    name: "aisa",
    apiKey: env.aisaApiKey!,
    baseURL: env.aisaBaseUrl,
  });

  const controller = new AbortController();
  const hard = setTimeout(() => controller.abort(), HARD_ABORT_MS);
  const t0 = Date.now();
  let ttfp: number | null = null;
  let text = "";
  let error: string | null = null;

  try {
    const result = streamText({
      model: aisa.chatModel(model),
      system: SYSTEM_PROMPT,
      prompt: PROMPT,
      tools: benchTools(calls),
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      temperature: 0,
    });
    for await (const part of result.stream) {
      if (ttfp === null && !SYNTHETIC_PARTS.has(part.type)) ttfp = Date.now() - t0;
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "error") {
        // streamText folds errors into the stream rather than rejecting.
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(hard);
  }

  const total = Date.now() - t0;
  const payArgs = (calls.find((c) => c.name === "pay_merchant")?.args ?? null) as Row["payArgs"];
  const paidRight = payArgs?.handle === EXPECT_HANDLE && EXPECT_SGD.test(payArgs?.sgd ?? "");
  // A clean stream that called nothing: the shape run.ts refuses rather than
  // falling back, because the scripted engine pays and this model chose not to.
  const silent = error === null && calls.length === 0;
  const withinBudget = ttfp !== null && ttfp < env.llmTimeoutMs;

  const verdict = error
    ? "ERROR"
    : silent
      ? "SILENT"
      : !paidRight
        ? "WRONG"
        : withinBudget
          ? "OK"
          : "SLOW";

  return {
    model,
    ttfp,
    total,
    calls: calls.map((c) => c.name),
    payArgs,
    paidRight,
    silent,
    error: error ? error.slice(0, 200) : null,
    text: text.trim(),
    verdict,
  };
}

async function main(): Promise<number> {
  const models = process.argv.slice(2);
  if (models.length === 0) {
    console.error("usage: tsx scripts/bench-models.ts <model> [model...]");
    return 2;
  }
  if (!env.aisaApiKey) {
    console.error("AISA_API_KEY is not set (packages/agent/.env)");
    return 2;
  }

  console.error(`prompt: ${JSON.stringify(PROMPT)}`);
  console.error(`budget: ttfp < ${env.llmTimeoutMs}ms (AGENT_LLM_TIMEOUT_MS)\n`);

  const rows: Row[] = [];
  for (const model of models) {
    process.stderr.write(`  ${model} ... `);
    // Serial on purpose: concurrent runs would contend for the same gateway
    // rate limit and the latency figures are the whole point.
    const row = await bench(model);
    process.stderr.write(`${row.verdict} ttfp=${row.ttfp ?? "-"}ms total=${row.total}ms\n`);
    rows.push(row);
  }

  const col = [30, 9, 9, 40, 9] as const;
  const line = (cells: (string | number)[]) =>
    cells.map((c, i) => String(c).padEnd(col[i] ?? 0)).join(" ");

  console.log("\n" + line(["model", "ttfp", "total", "tools", "verdict"]));
  console.log("-".repeat(col.reduce((a, b) => a + b + 1, 0)));
  for (const r of rows) {
    console.log(
      line([
        r.model,
        r.ttfp === null ? "-" : `${r.ttfp}ms`,
        `${r.total}ms`,
        r.calls.join(">") || "(none)",
        r.verdict,
      ]),
    );
  }

  for (const r of rows) {
    if (r.verdict === "OK") continue;
    const why =
      r.error ??
      (r.silent
        ? "clean stream, zero tool calls -- answered the tool call as prose"
        : !r.paidRight
          ? `paid ${JSON.stringify(r.payArgs)}, expected ${EXPECT_HANDLE} / 4.50`
          : `first part at ${r.ttfp}ms, over the ${env.llmTimeoutMs}ms budget`);
    console.log(`\n  ${r.model}: ${r.verdict} -- ${why}`);
  }

  console.log("\n--- narration ---");
  for (const r of rows) console.log(`\n[${r.model}]\n${r.text || "(no text)"}`);

  return rows.some((r) => r.verdict === "OK") ? 0 : 1;
}

process.exitCode = await main();
