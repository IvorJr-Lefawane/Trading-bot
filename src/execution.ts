// Paper execution ONLY. This never calls a real broker/exchange order endpoint —
// it simulates a fill locally and returns the result for logging/state-tracking.
// There is no authenticated client, no order endpoint, and no signing code
// anywhere in this project. assertSimulatedFill() is the single checkpoint
// every simulated fill passes through.

import { assertSimulatedFill } from "./guardrails";

export interface PaperFill {
  action: "BUY" | "SELL";
  price: number;
  quantity: number;
  timestamp: number;
}

export function simulatePaperOrder(action: "BUY" | "SELL", price: number, quantity: number): PaperFill {
  assertSimulatedFill();
  return { action, price, quantity, timestamp: Date.now() };
}
