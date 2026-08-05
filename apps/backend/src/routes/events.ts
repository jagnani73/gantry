import { Router } from "express";
import { recentSettlements, settlementsAfter } from "../db";
import { settlementEventOf } from "../indexer";
import { addSseClient, removeSseClient, writeSseEvent } from "../sse";

export const eventsRouter = Router();

eventsRouter.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 2000\n\n");

  // Replay: rows after Last-Event-ID on reconnect, else the most recent 20.
  const lastEventId = req.get("Last-Event-ID");
  const match = lastEventId ? /^(\d+):(\d+)$/.exec(lastEventId) : null;
  const rows = match
    ? settlementsAfter(Number(match[1]), Number(match[2]))
    : recentSettlements(20);
  for (const row of rows) {
    writeSseEvent(res, "settlement", `${row.block_number}:${row.log_index}`, settlementEventOf(row));
  }

  const clientId = addSseClient(res);
  req.on("close", () => removeSseClient(clientId));
});
