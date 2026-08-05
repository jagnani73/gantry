import type { Response } from "express";

const clients = new Map<number, Response>();
let nextClientId = 1;

const HEARTBEAT_MS = 15_000;
setInterval(() => {
  for (const res of clients.values()) res.write(": ping\n\n");
}, HEARTBEAT_MS).unref();

export function addSseClient(res: Response): number {
  const id = nextClientId++;
  clients.set(id, res);
  return id;
}

export function removeSseClient(id: number): void {
  clients.delete(id);
}

export function sseClientCount(): number {
  return clients.size;
}

export function writeSseEvent(
  res: Response,
  event: string,
  id: string | null,
  data: unknown,
): void {
  if (id) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function broadcast(event: string, id: string | null, data: unknown): void {
  for (const res of clients.values()) writeSseEvent(res, event, id, data);
}
