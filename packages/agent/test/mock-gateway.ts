import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal OpenAI-compatible chat-completions endpoint, streaming.
 *
 * It exists to reproduce the one failure the provider swap introduced and that
 * no real provider will reproduce on demand: a gateway that answers a tool call
 * as prose in `message.content` while `tool_calls` stays empty. Gemini calls
 * tools even when a prompt tells it not to, so without this there is no way to
 * reach `refuseSilentRun` at all.
 *
 * Deliberately hand-rolled rather than recorded: the point is the SHAPE of the
 * response, and a fixture captured from a real gateway would pin that gateway's
 * quirks instead.
 */
export type MockRequest = {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
};

export type MockGateway = {
  baseUrl: string;
  requests: MockRequest[];
  close: () => Promise<void>;
};

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @param texts prose deltas to stream back. No `tool_calls` is ever emitted —
 * that is the whole point of the double.
 */
export async function startMockGateway(texts: string[] = ["Paid it. "]): Promise<MockGateway> {
  const requests: MockRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // A malformed body is itself worth asserting on, so record and continue.
      }
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const text of texts) {
        res.write(
          sse({
            id: "mock",
            object: "chat.completion.chunk",
            created: 0,
            model: "mock-model",
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
          }),
        );
      }
      res.write(
        sse({
          id: "mock",
          object: "chat.completion.chunk",
          created: 0,
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  // Port 0: the OS picks a free one, so a stale listener from a previous run
  // can never make this suite fail for a reason unrelated to the code.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
