import type { WireDoor } from "@gantry/shared";

/**
 * How each door is described to the shop.
 *
 * The privacy rule this surface is built around: for an agent payment the
 * merchant sees the door, the payer address and the amount — never the agent's
 * identity, its spend policy, its caps, its balance or its owner. So the copy
 * describes the RAIL ("paid by software over the x402 door"), never the payer.
 * There is no declined variant here either: a payment an agent's own wallet
 * refused was never presented to the shop, so it does not belong in its books.
 */
export const DOOR_TITLE: Record<WireDoor, string> = {
  agent: "Agent · x402",
  human: "Human · scanned QR",
};

export const DOOR_HELP: Record<WireDoor, string> = {
  agent: "Paid by software over the x402 door",
  human: "Someone scanned the printed code",
};
