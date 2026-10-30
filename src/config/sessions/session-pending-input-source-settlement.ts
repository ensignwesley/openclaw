import { assertSessionPendingInputLifetimeCurrent } from "./session-accessor.sqlite-pending-inputs.js";
import type {
  SessionInputSettlementIdentity,
  SessionInputSourceDelivery,
} from "./session-input-settlement.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type { PendingInputCustodyGrant } from "./session-pending-input-operations.types.js";
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import type { preparePendingInputStore } from "./session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";

/** Project only the native source owner's private custody, not mutable receipt bytes. */
export function projectSessionPendingInputSettlements(owner: SessionPendingInputOwner | undefined) {
  return (owner?.sources ?? (owner ? [owner] : [])).map((source) => {
    assertSessionPendingInputLifetimeCurrent(source);
    return {
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      consumed: source.consumed === true,
      message: parseSessionPendingInputMessage(source.messageJson),
      origin: source.requesterOrigin,
      identity: source.settlement?.identity,
      read: source.settlement?.read,
      write: source.settlement?.write,
    };
  });
}
export function createSessionPendingInputSourceSettlement(params: {
  store: Awaited<ReturnType<typeof preparePendingInputStore>>;
  identity: () => SessionInputSettlementIdentity & {
    sessionKey: string;
    sessionId: string;
    authorityAgentId?: string;
  };
  assertCurrent: () => void;
  released: () => boolean;
  guard: (stage: "transaction" | "commit", facts?: PendingInputCustodyGrant) => void;
}) {
  return {
    get identity() {
      return params.identity();
    },
    async read() {
      params.assertCurrent();
      const identity = params.identity();
      const snapshot = await params.store.read({ ...identity, kind: "settlement" });
      params.assertCurrent();
      if (snapshot.kind !== "settlement" || !snapshot.current) {
        throw new SessionPendingInputCustodyError("Input source is no longer current");
      }
      const row = snapshot.row;
      if (row && (row.run_id !== identity.runId || row.request_hash !== identity.requestHash)) {
        throw new SessionPendingInputCustodyError("Input source identity changed");
      }
      return row?.sourceDelivery;
    },
    async write(delivery: SessionInputSourceDelivery) {
      if (params.released()) {
        throw new SessionPendingInputCustodyError("Input source owner has been released");
      }
      params.assertCurrent();
      await params.store.mutate(
        { ...params.identity(), kind: "source-delivery", delivery },
        params.guard,
      );
    },
  };
}
