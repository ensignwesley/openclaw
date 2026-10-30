import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { MAX_SESSION_ACTOR_COMPLETIONS } from "./session-actor-hydration.types.js";
import {
  readSessionActorTransactionState,
  writableSessionActorMap,
} from "./session-actor-transaction.js";
import {
  decodeSessionInputSettlement,
  encodeSessionInputSettlement,
} from "./session-input-settlement.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { isFinalInputCompletion } from "./session-pending-input-value.js";
import type { SessionInputCompletion } from "./session-pending-input.types.js";
type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

type SessionInputCompletionScope = Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey"> & {
  idempotencyKey: string;
};

export function readSessionInputSettlementRow(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
  forWrite = false,
):
  | (Omit<SessionInputCompletion, "outcome"> & {
      outcome?: AgentRunTerminalOutcome;
      sourceDelivery?: import("./session-input-settlement.js").SessionInputSourceDelivery;
    })
  | undefined {
  const actor = readSessionActorTransactionState(database, scope);
  let row = actor?.completions.get(scope.idempotencyKey);
  if (!row && (forWrite || !actor?.completionsComplete)) {
    row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_input_completions")
        .selectAll()
        .$if(!forWrite, (query) => query.where("session_key", "=", scope.sessionKey))
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey),
    );
  }
  if (!row) {
    return undefined;
  }
  // The existing completion owner decodes processing outcomes and private source receipts.
  const value = decodeSessionInputSettlement(row.outcome_json);
  return { ...row, outcome: value.processing, sourceDelivery: value.sourceDelivery };
}

export function readSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
): SessionInputCompletion | undefined {
  const row = readSessionInputSettlementRow(database, scope);
  if (!row?.outcome) {
    return undefined;
  }
  const { sourceDelivery: _sourceDelivery, ...processing } = row;
  return { ...processing, outcome: row.outcome };
}

/** The caller holds the write transaction and has revalidated the exact live admission owner. */
export function writeSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope & {
    runId: string;
    requestHash: string;
    lifecycleGeneration: string;
  },
  outcome: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  const retained = readSessionInputSettlementRow(database, scope, true);
  if (
    retained &&
    (retained.session_key !== scope.sessionKey ||
      retained.run_id !== scope.runId ||
      retained.request_hash !== scope.requestHash)
  ) {
    throw new SessionPendingInputCustodyError("Input completion conflicts with the accepted input");
  }
  if (retained?.outcome && isFinalInputCompletion(retained.outcome)) {
    return retained.outcome;
  }
  const succeeded = classifyAgentRunTerminalOutcome(outcome) === "success";
  const completedAt = Date.now();
  const completionState = {
    outcome_json: encodeSessionInputSettlement({
      processing: outcome,
      sourceDelivery: retained?.sourceDelivery,
    }),
    succeeded: succeeded ? 1 : 0,
    completed_at: completedAt,
  };
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_input_completions")
      .values({
        session_key: scope.sessionKey,
        session_id: scope.sessionId,
        idempotency_key: scope.idempotencyKey,
        run_id: scope.runId,
        request_hash: scope.requestHash,
        ...completionState,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_id", "idempotency_key"])
          .doUpdateSet(completionState)
          .where("session_input_completions.succeeded", "=", 0),
      ),
  );
  const actor = readSessionActorTransactionState(database, scope);
  if (actor && (!retained || retained.succeeded === 0)) {
    actor.completions = writableSessionActorMap(actor.completions);
    actor.completions.set(scope.idempotencyKey, {
      session_key: scope.sessionKey,
      session_id: scope.sessionId,
      idempotency_key: scope.idempotencyKey,
      run_id: retained?.run_id ?? scope.runId,
      request_hash: retained?.request_hash ?? scope.requestHash,
      ...completionState,
    });
    if (actor.completions.size > MAX_SESSION_ACTOR_COMPLETIONS) {
      actor.completions.delete(actor.completions.keys().next().value!);
      actor.completionsComplete = false;
    }
  }
  if (isFinalInputCompletion(outcome)) {
    // Handled hooks can finish without appending a user message. The completion
    // receipt retires that exact custody atomically in the caller's transaction.
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey)
        .where("run_id", "=", scope.runId)
        .where("request_hash", "=", scope.requestHash)
        .where("lifecycle_generation", "=", scope.lifecycleGeneration)
        .where("consumed_event_id", "is", null),
    );
    const pending = actor?.pendingInputs.get(scope.idempotencyKey);
    if (
      pending &&
      pending.run_id === scope.runId &&
      pending.request_hash === scope.requestHash &&
      pending.lifecycle_generation === scope.lifecycleGeneration &&
      pending.consumed_event_id === null
    ) {
      if (actor) {
        actor.pendingInputs = writableSessionActorMap(actor.pendingInputs);
        actor.pendingInputs.delete(scope.idempotencyKey);
      }
    }
  }
  return outcome;
}
