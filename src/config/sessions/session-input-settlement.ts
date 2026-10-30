import { isDeepStrictEqual } from "node:util";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { isFinalInputCompletion } from "./session-pending-input-value.js";

/** Private identity retained by the accepted input owner, never a caller-supplied receipt. */
export type SessionInputSettlementIdentity = {
  idempotencyKey: string;
  runId: string;
  requestHash: string;
  lifecycleGeneration: string;
};
export type SessionInputSourceDelivery = {
  kind: "answer" | "failure-notice";
  responderRunId: string;
  intentId: string;
  deliveryId: string;
  context?: DeliveryContext;
  platformMessageId: string;
  resultCount: number;
  settledAt: number;
};
export type SessionInputSettlement = {
  processing?: AgentRunTerminalOutcome;
  sourceDelivery?: SessionInputSourceDelivery;
};

/** Legacy processing JSON remains readable; receipt-only rows do not invent processing. */
export function decodeSessionInputSettlement(json: string): SessionInputSettlement {
  // SAFETY: this feature owns both legacy terminal outcomes and the private versioned envelope.
  const stored = JSON.parse(json) as
    | AgentRunTerminalOutcome
    | (SessionInputSettlement & { version: 1 });
  return "version" in stored && stored.version === 1
    ? { processing: stored.processing, sourceDelivery: stored.sourceDelivery }
    : { processing: stored as AgentRunTerminalOutcome };
}
export function encodeSessionInputSettlement(value: SessionInputSettlement): string {
  return JSON.stringify(value.sourceDelivery ? { version: 1, ...value } : value.processing);
}

/** First identified terminal delivery is immutable; another route never adds coverage. */
export function mergeSessionInputSettlement(
  retained: SessionInputSettlement,
  incoming: SessionInputSettlement,
): SessionInputSettlement {
  if (
    retained.sourceDelivery &&
    incoming.sourceDelivery &&
    !isDeepStrictEqual(
      { ...retained.sourceDelivery, settledAt: 0 },
      { ...incoming.sourceDelivery, settledAt: 0 },
    )
  ) {
    throw new SessionPendingInputCustodyError("Input already has a different terminal delivery");
  }
  return {
    processing:
      retained.processing && isFinalInputCompletion(retained.processing)
        ? retained.processing
        : (incoming.processing ?? retained.processing),
    sourceDelivery: retained.sourceDelivery ?? incoming.sourceDelivery,
  };
}
