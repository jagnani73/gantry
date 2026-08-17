import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startMockGateway } from "./mock-gateway";

/**
 * Provider selection and the guards around it, exercised through the real CLI.
 *
 * These spawn the binary rather than importing it, because what is under test
 * is a process-level contract: which exit code, which message on stderr, and
 * whether an HTTP request left the machine at all. `selectProvider` is not
 * exported and should not be — the assertions here are about behaviour a demo
 * operator can observe, not about internals.
 *
 * SAFETY: every case pins GANTRY_API at a closed port. The agent's tools move
 * REAL testnet USDC, and the scripted fallback pays without asking; a test that
 * could reach a live backend would be a test that can spend money when someone
 * happens to have one running. A closed port makes that structurally impossible
 * rather than merely unlikely.
 */

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(agentRoot, "src/index.ts");

/** Port 1 is privileged and never bound by a dev server: connect fails at once. */
const DEAD_BACKEND = "http://127.0.0.1:1";

type Run = { code: number | null; stdout: string; stderr: string };

function runAgent(env: Record<string, string>, prompt = "buy 3 iced teas"): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, prompt], {
      cwd: agentRoot,
      env: {
        ...process.env,
        // Explicit empties, not deletions: env.ts calls process.loadEnvFile on
        // packages/agent/.env when it exists, and that does not override a
        // variable already present. A developer's real key would otherwise
        // decide which provider these tests exercise.
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        AISA_API_KEY: "",
        AISA_MODEL: "",
        AISA_BASE_URL: "",
        AGENT_SESSION_KEY: `0x${"11".repeat(32)}`,
        GANTRY_API: DEAD_BACKEND,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("a gateway that never calls a tool is refused, not paid", async () => {
  const gateway = await startMockGateway(["Paying Ah Hock now. ", "Done, it settled on-chain."]);
  try {
    const run = await runAgent({
      AISA_API_KEY: "test-key",
      AISA_MODEL: "mock-model",
      AISA_BASE_URL: gateway.baseUrl,
    });

    // The refusal, and specifically not a fallback: the scripted engine pays,
    // and this run produced no evidence that a payment was wanted.
    assert.equal(run.code, 1, `expected exit 1, got ${run.code}\n${run.stderr}`);
    assert.match(run.stderr, /without calling a single tool/);
    assert.match(run.stderr, /not falling back/);

    // The narration is fabricated and looks exactly like success. This asserts
    // the trap rather than the fix: whatever wraps this CLI must gate on the
    // exit code, because the transcript alone cannot be trusted.
    assert.match(run.stdout, /settled on-chain/);

    // ...and the money path was never touched, which is the actual guarantee.
    assert.doesNotMatch(run.stderr, /ECONNREFUSED/);
  } finally {
    await gateway.close();
  }
});

test("the request reaching the gateway is a real OpenAI tool-calling request", async () => {
  const gateway = await startMockGateway();
  try {
    await runAgent({
      AISA_API_KEY: "test-key",
      AISA_MODEL: "mock-model",
      AISA_BASE_URL: gateway.baseUrl,
    });

    assert.equal(gateway.requests.length, 1, "expected exactly one gateway call");
    const [req] = gateway.requests;
    assert.equal(req.path, "/v1/chat/completions");
    assert.equal(req.authorization, "Bearer test-key");
    assert.equal(req.body.model, "mock-model");
    assert.equal(req.body.stream, true);

    // The tools must survive translation into OpenAI's function shape. If they
    // silently did not, the model could never call one and every run would land
    // in the refusal above -- a real failure wearing the guard's clothes.
    const tools = req.body.tools as { function?: { name?: string } }[] | undefined;
    assert.ok(Array.isArray(tools), "tools were not sent");
    const names = tools.map((t) => t.function?.name).sort();
    assert.deepEqual(names, ["check_my_policy", "list_merchants", "pay_merchant"]);
  } finally {
    await gateway.close();
  }
});

test("a gateway key with no model fails before any request leaves", async () => {
  const gateway = await startMockGateway();
  try {
    const run = await runAgent({
      AISA_API_KEY: "test-key",
      AISA_BASE_URL: gateway.baseUrl,
    });

    // Exit 2 is the "invoked wrong" code, shared with the usage error, and
    // distinct from 1 which means the run happened and went wrong.
    assert.equal(run.code, 2, `expected exit 2, got ${run.code}\n${run.stderr}`);
    assert.match(run.stderr, /AISA_MODEL is not/);
    // No stack trace: a configuration mistake reads as one sentence.
    assert.doesNotMatch(run.stderr, /at selectProvider/);
    assert.equal(gateway.requests.length, 0, "a misconfigured run still called out");
  } finally {
    await gateway.close();
  }
});

test("with no provider key at all the gateway is never contacted", async () => {
  const gateway = await startMockGateway();
  try {
    // AISA_BASE_URL is pointed at the mock while both keys stay empty, so a
    // regression that consulted the gateway without a key would show up here
    // as a recorded request rather than as a passing test.
    const run = await runAgent({ AISA_BASE_URL: gateway.baseUrl });

    assert.equal(gateway.requests.length, 0, "the gateway was called without a key");
    // Scripted mode runs the real tools, which cannot reach the closed backend.
    // That failure IS the assertion: it proves the scripted engine was entered.
    assert.match(run.stderr, /ECONNREFUSED|fetch failed/);
  } finally {
    await gateway.close();
  }
});
