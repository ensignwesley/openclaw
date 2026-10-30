import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
  SESSION_INPUT_COMPLETIONS_TABLE,
  SESSION_PENDING_INPUTS_TABLE,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { readSessionPendingInputByKey } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  decodeSessionInputSettlement,
  encodeSessionInputSettlement,
  mergeSessionInputSettlement,
} from "./session-input-settlement.js";
import { isFinalInputCompletion } from "./session-pending-input-value.js";

type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

/** Canonical repair preserves accepted text without transferring its old execution authority. */
export function copySessionPendingInputsForRepair(
  source: PendingInputDatabase,
  destination: PendingInputDatabase,
  sourceKeys: readonly string[],
  canonicalKey: string,
): void {
  if (!sourceKeys.length || !tableExists(source.db, SESSION_PENDING_INPUTS_TABLE)) {
    return;
  }
  const db = getSessionKysely(destination.db);
  if (source.db === destination.db) {
    executeSqliteQuerySync(
      destination.db,
      db
        .updateTable("session_pending_inputs")
        .set((eb) => ({
          session_key: canonicalKey,
          state: eb
            .case()
            .when("state", "=", "cancelled")
            .then("cancelled")
            .else("interrupted")
            .end(),
        }))
        .where("session_key", "in", sourceKeys),
    );
    return;
  }
  const rows = iterateSqliteQuerySync(
    source.db,
    getSessionKysely(source.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_key", "in", sourceKeys)
      .orderBy("seq", "asc"),
  );
  let initialized = false;
  for (const row of rows) {
    if (!initialized) {
      ensureSessionPendingInputsSchema(destination.db);
      initialized = true;
    }
    const existing = readSessionPendingInputByKey(
      destination,
      { sessionKey: canonicalKey, sessionId: row.session_id },
      row.idempotency_key,
    );
    if (existing) {
      if (
        existing.request_hash !== row.request_hash ||
        existing.message_json !== row.message_json ||
        existing.run_id !== row.run_id ||
        (existing.consumed_event_id != null &&
          row.consumed_event_id != null &&
          existing.consumed_event_id !== row.consumed_event_id)
      ) {
        throw new Error("Canonical repair found conflicting accepted inputs");
      }
      executeSqliteQuerySync(
        destination.db,
        db
          .updateTable("session_pending_inputs")
          .set({
            consumed_event_id: existing.consumed_event_id ?? row.consumed_event_id ?? null,
            state:
              existing.state === "cancelled" || row.state === "cancelled"
                ? "cancelled"
                : "interrupted",
          })
          .where("input_id", "=", existing.input_id),
      );
      continue;
    }
    const { seq: _seq, ...record } = row;
    executeSqliteQuerySync(
      destination.db,
      db.insertInto("session_pending_inputs").values({
        ...record,
        session_key: canonicalKey,
        state: row.state === "cancelled" ? "cancelled" : "interrupted",
      }),
    );
  }
}

/** Transfer terminal facts without transferring the old admission's execution authority. */
export function copySessionInputCompletionsForRepair(
  source: PendingInputDatabase,
  destination: PendingInputDatabase,
  sourceKeys: readonly string[],
  canonicalKey: string,
): void {
  if (!sourceKeys.length || !tableExists(source.db, SESSION_INPUT_COMPLETIONS_TABLE)) {
    return;
  }
  const db = getSessionKysely(destination.db);
  if (source.db === destination.db) {
    // Rekey the same physical receipt without replacing any terminal fact.
    executeSqliteQuerySync(
      destination.db,
      db
        .updateTable("session_input_completions")
        .set({ session_key: canonicalKey })
        .where("session_key", "in", sourceKeys),
    );
    return;
  }
  const rows = iterateSqliteQuerySync(
    source.db,
    getSessionKysely(source.db)
      .selectFrom("session_input_completions")
      .selectAll()
      .where("session_key", "in", sourceKeys),
  );
  let initialized = false;
  for (const row of rows) {
    if (!initialized) {
      ensureSessionInputCompletionsSchema(destination.db);
      initialized = true;
    }
    // Conflict identity excludes session_key: another logical owner must never
    // be overwritten just because it shares the physical generation/input key.
    const existing = executeSqliteQueryTakeFirstSync(
      destination.db,
      db
        .selectFrom("session_input_completions")
        .selectAll()
        .where("session_id", "=", row.session_id)
        .where("idempotency_key", "=", row.idempotency_key),
    );
    if (existing) {
      if (
        existing.session_key !== canonicalKey ||
        existing.run_id !== row.run_id ||
        existing.request_hash !== row.request_hash
      ) {
        throw new Error("Canonical repair found conflicting input completions");
      }
      const previous = decodeSessionInputSettlement(existing.outcome_json);
      const incoming = decodeSessionInputSettlement(row.outcome_json);
      const processing =
        previous.processing && isFinalInputCompletion(previous.processing)
          ? previous.processing
          : incoming.processing &&
              (isFinalInputCompletion(incoming.processing) ||
                row.completed_at > existing.completed_at)
            ? incoming.processing
            : previous.processing;
      const merged = mergeSessionInputSettlement(
        { ...previous, processing: undefined },
        { ...incoming, processing },
      );
      row.outcome_json = encodeSessionInputSettlement(merged);
      row.succeeded = processing
        ? classifyAgentRunTerminalOutcome(processing) === "success"
          ? 1
          : 0
        : 0;
      row.completed_at = Math.max(existing.completed_at, row.completed_at);
    }
    const canonical = { ...row, session_key: canonicalKey };
    executeSqliteQuerySync(
      destination.db,
      db
        .insertInto("session_input_completions")
        .values(canonical)
        .onConflict((conflict) =>
          conflict.columns(["session_id", "idempotency_key"]).doUpdateSet(canonical),
        ),
    );
  }
}

export function readSessionInputArtifactRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const db = getSessionKysely(database.db);
  return {
    pendingInputs: tableExists(database.db, SESSION_PENDING_INPUTS_TABLE)
      ? iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_pending_inputs")
            .selectAll()
            .where("session_id", "=", sessionId)
            .orderBy("seq"),
        )
      : [],
    inputCompletions: tableExists(database.db, SESSION_INPUT_COMPLETIONS_TABLE)
      ? iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_input_completions")
            .selectAll()
            .where("session_id", "=", sessionId)
            .orderBy("idempotency_key"),
        )
      : [],
  };
}
