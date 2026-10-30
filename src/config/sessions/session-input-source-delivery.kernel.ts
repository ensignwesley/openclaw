import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionInputCompletionsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { readSessionInputSettlementRow } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  readSessionActorTransactionState,
  writableSessionActorMap,
} from "./session-actor-transaction.js";
import {
  encodeSessionInputSettlement,
  mergeSessionInputSettlement,
  type SessionInputSourceDelivery,
  type SessionInputSettlementIdentity,
} from "./session-input-settlement.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";

/** The existing actor transaction owns delivery publication and pending-final cleanup together. */
export function writeSessionInputSourceDelivery(
  database: OpenClawAgentDatabase,
  scope: SessionInputSettlementIdentity & { sessionKey: string; sessionId: string },
  delivery: SessionInputSourceDelivery,
): SessionInputSourceDelivery {
  ensureSessionInputCompletionsSchema(database.db);
  const retained = readSessionInputSettlementRow(database, scope);
  if (
    retained &&
    (retained.run_id !== scope.runId || retained.request_hash !== scope.requestHash)
  ) {
    throw new SessionPendingInputCustodyError("Source delivery conflicts with the accepted input");
  }
  const value = mergeSessionInputSettlement(
    { processing: retained?.outcome, sourceDelivery: retained?.sourceDelivery },
    { sourceDelivery: delivery },
  );
  const row = {
    session_key: scope.sessionKey,
    session_id: scope.sessionId,
    idempotency_key: scope.idempotencyKey,
    run_id: scope.runId,
    request_hash: scope.requestHash,
    outcome_json: encodeSessionInputSettlement(value),
    succeeded:
      value.processing && classifyAgentRunTerminalOutcome(value.processing) === "success" ? 1 : 0,
    completed_at: retained?.completed_at ?? delivery.settledAt,
  };
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_input_completions")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["session_id", "idempotency_key"]).doUpdateSet(row),
      ),
  );
  const actor = readSessionActorTransactionState(database, scope);
  if (actor) {
    actor.completions = writableSessionActorMap(actor.completions);
    actor.completions.set(scope.idempotencyKey, row);
  }
  return value.sourceDelivery!;
}
