import { Router } from "express";
import { decodeCursor } from "@gantry/shared";
import { recentSettlements, settlementsAfter } from "../db";
import { settlementEventOf } from "../indexer";
import { cursorOf } from "../services/settlements";
import { addSseClient, removeSseClient, writeSseEvent } from "../sse";

export const eventsRouter = Router();

eventsRouter.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 2000\n\n");

  // Replay: rows after Last-Event-ID on reconnect, else the most recent 20.
  // The event id IS a feed cursor, so it is read with the reader `?before=`
  // uses rather than a second `\d+:\d+` of its own — that one accepted
  // "99999999999999999999:0", which `Number` rounds to 1e20, and a reconnecting
  // dashboard was told it sat past the head and silently replayed nothing.
  const lastEventId = req.get("Last-Event-ID");
  const resume = lastEventId === undefined ? null : decodeCursor(lastEventId);
  if (lastEventId !== undefined && resume === null) {
    // Deliberately not a 400: EventSource treats any non-200 as fatal and stops
    // reconnecting, so refusing an id the client invented would end the feed
    // instead of healing it. Replay the head — and say so, because that silently
    // drops whatever the client missed.
    console.warn(`sse: unusable Last-Event-ID ${JSON.stringify(lastEventId)} — replaying head`);
  }
  const rows = resume
    ? settlementsAfter(resume.blockNumber, resume.logIndex)
    : recentSettlements(20);
  for (const row of rows) {
    writeSseEvent(res, "settlement", cursorOf(row), settlementEventOf(row));
  }

  const clientId = addSseClient(res);
  req.on("close", () => removeSseClient(clientId));
});
