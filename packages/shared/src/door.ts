/** Mirrors GantryCore's `enum Door { Human, Agent }`. */
export const Door = { Human: 0, Agent: 1 } as const;
export type Door = (typeof Door)[keyof typeof Door];

/** Mirrors GantryCore's `enum IntentStatus { None, Pending, Settled, Cancelled }`. */
export const IntentStatus = { None: 0, Pending: 1, Settled: 2, Cancelled: 3 } as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

export type WireDoor = "human" | "agent";

export function doorToWire(door: Door): WireDoor {
  return door === Door.Agent ? "agent" : "human";
}

export function doorFromWire(door: WireDoor | undefined): Door {
  return door === "agent" ? Door.Agent : Door.Human;
}
