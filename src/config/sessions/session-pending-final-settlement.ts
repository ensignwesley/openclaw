import { isDeepStrictEqual } from "node:util";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { SessionActorDeliveryEvidence } from "./session-actor-delivery-evidence.types.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import type { InternalSessionEntry } from "./types.js";

type PendingFinalDelivery = NonNullable<InternalSessionEntry["pendingFinalDelivery"]>;
type PendingFinalDeliveryState = NonNullable<PendingFinalDelivery["deliveries"]>[number]["state"];

export type PendingFinalDeliverySettlementInput = {
  sessionId: string;
  intentId: string;
  deliveryId: string;
  state: PendingFinalDeliveryState;
  expectedStates?: readonly ("prepared" | "queued" | "unknown")[];
  /** Only the settled delivery owner may clear custody; pre-ACK receipts omit this. */
  cleanup?: {
    sessionKey: string;
    now: number;
    preserveActivity?: boolean;
  };
};

/** Harness claims are host-validated; ordinary sources belong to the persisted final intent. */
export function projectPendingFinalDeliverySettlement(
  entry: InternalSessionEntry,
  input: PendingFinalDeliverySettlementInput,
  evidence?: SessionActorDeliveryEvidence,
): {
  patch: Partial<InternalSessionEntry> | null;
  state: PendingFinalDeliveryState | "stale";
  sourceDelivery?: import("./session-input-settlement.js").SessionInputSourceDelivery;
} {
  const settlement = projectPendingFinalDeliveryState(entry, input, evidence);
  if (!input.cleanup) {
    return settlement;
  }
  const settledEntry = settlement.patch ? { ...entry, ...settlement.patch } : entry;
  const cleaned = projectSessionEntryPatch({
    existing: settledEntry,
    writeBase: settledEntry,
    sessionKey: input.cleanup.sessionKey,
    preserveActivity: input.cleanup.preserveActivity,
    operation: {
      kind: "pending-final-clear",
      sessionId: input.sessionId,
      intentId: input.intentId,
      now: input.cleanup.now,
    },
  });
  return { ...settlement, patch: cleaned ?? settlement.patch };
}

function projectPendingFinalDeliveryState(
  entry: InternalSessionEntry,
  input: PendingFinalDeliverySettlementInput,
  evidence: Parameters<typeof projectPendingFinalDeliverySettlement>[2],
): ReturnType<typeof projectPendingFinalDeliverySettlement> {
  const pending = entry.pendingFinalDelivery;
  const deliveries = pending?.deliveries;
  const index = deliveries?.findIndex(({ id }) => id === input.deliveryId) ?? -1;
  if (
    entry.sessionId !== input.sessionId ||
    pending?.intentId !== input.intentId ||
    !deliveries ||
    index < 0
  ) {
    return { patch: null, state: "stale" };
  }
  const current = deliveries[index]!.state;
  if (input.expectedStates && !input.expectedStates.some((expected) => expected === current)) {
    return { patch: null, state: "stale" };
  }
  const terminal =
    current === "delivered" ||
    current === "suppressed" ||
    (current === "unknown" && input.state === "unknown");
  let settled = terminal ? current : input.state;
  const result = evidence?.result;
  const platformMessageId = result?.platformMessageId?.trim();
  const context = pending.context;
  const validResult =
    result &&
    platformMessageId &&
    (result.resultCount === undefined ||
      (Number.isSafeInteger(result.resultCount) && result.resultCount > 0)) &&
    result.channel === context?.channel &&
    context?.to &&
    (!result.target || result.target.id === context.to) &&
    (!result.verifiedContext ||
      isDeepStrictEqual(
        normalizeDeliveryContext(result.verifiedContext),
        normalizeDeliveryContext(context),
      ));
  // An unverified "delivered" callback cannot discharge exact-input custody.
  if (!terminal && settled === "delivered" && pending.sourceInputs?.length && !validResult) {
    settled = "unknown";
  }
  const existingNotice = entry.pendingDeliveryNotice;
  const owedNotice =
    settled === "unknown" &&
    pending.context &&
    pending.intentId &&
    existingNotice?.intentId !== pending.intentId &&
    (!existingNotice || existingNotice.createdAt <= pending.createdAt)
      ? {
          pendingDeliveryNotice: {
            createdAt: pending.createdAt,
            context: pending.context,
            intentId: pending.intentId,
            state: "owed" as const,
          },
        }
      : undefined;
  const receipt = terminal
    ? deliveries[index]!.receipt
    : settled === "delivered" && validResult
      ? { platformMessageId, resultCount: result.resultCount ?? 1 }
      : undefined;
  const updatedDeliveries = deliveries.with(index, {
    id: input.deliveryId,
    state: settled,
    ...(receipt ? { receipt } : {}),
  });
  const complete =
    updatedDeliveries.length > 0 &&
    updatedDeliveries.every((member) => member.state === "delivered" && member.receipt);
  const sourceDelivery =
    complete && pending.sourceRunId
      ? {
          kind: pending.sourceOutcome ?? ("answer" as const),
          responderRunId: pending.sourceRunId,
          intentId: pending.intentId!,
          deliveryId: updatedDeliveries.map((member) => member.id).join(":"),
          context: pending.context,
          platformMessageId: updatedDeliveries.at(-1)!.receipt!.platformMessageId,
          resultCount: updatedDeliveries.reduce(
            (sum, member) => sum + member.receipt!.resultCount,
            0,
          ),
          settledAt: input.cleanup?.now ?? Date.now(),
        }
      : undefined;
  const clearsNotice =
    existingNotice?.state !== "acknowledged" &&
    !updatedDeliveries.some((delivery) => delivery.state === "unknown") &&
    settled !== "queued" &&
    settled !== "unknown" &&
    existingNotice?.intentId === pending.intentId;
  // One resolved sibling cannot erase another's ambiguity or owe an acknowledged notice again.
  if (settled === current && !owedNotice && !clearsNotice) {
    return { patch: null, state: settled, sourceDelivery };
  }
  return {
    state: settled,
    sourceDelivery,
    patch: {
      pendingFinalDelivery: { ...pending, deliveries: updatedDeliveries },
      ...(clearsNotice ? { pendingDeliveryNotice: undefined } : owedNotice),
    },
  };
}
