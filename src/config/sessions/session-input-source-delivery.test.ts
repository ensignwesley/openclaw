import { expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readSessionInputCompletion,
  readSessionInputSettlementRow,
  writeSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import { createSessionActorMemoryState } from "./session-actor-memory-state.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { writeSessionInputSourceDelivery } from "./session-input-source-delivery.kernel.js";

const identity = (key: string) => ({
  idempotencyKey: key,
  runId: `original-${key}`,
  requestHash: `request-${key}`,
  lifecycleGeneration: "native",
});
const delivery = (key: string) => ({
  kind: "answer" as const,
  responderRunId: "shared-R",
  intentId: `native-${key}`,
  deliveryId: key,
  platformMessageId: `final-${key}`,
  resultCount: 1,
  settledAt: 100,
});

it.each(["sqlite", "memory"])(
  "keeps exact A/B receipts under one responder and separates receipt-first processing (%s)",
  (backend) =>
    withOpenClawTestState({ scenario: "minimal" }, () => {
      const f = createSessionCompoundWorkerFixture();
      const scope = { sessionKey: f.scope.sessionKey, sessionId: f.scope.sessionId };
      const state = createSessionActorMemoryState({
        sessionKey: scope.sessionKey,
        database: { kind: "memory", handle: "proof", incarnation: "one" },
      });
      state.hot.entry = { sessionId: scope.sessionId, updatedAt: 1 };
      const memory = createSessionActorMemoryPending(state, {
        agentId: "main",
        path: "memory",
        admit() {},
      });
      const write = <T>(operation: () => T) =>
        runOpenClawAgentWriteTransaction(operation, { agentId: "main", path: f.database.path });
      write(() => {
        ensureSessionInputCompletionsSchema(f.database.db);
        ensureSessionPendingInputsSchema(f.database.db);
      });
      const attach = (key: string) =>
        backend === "sqlite"
          ? write(() =>
              writeSessionInputSourceDelivery(
                f.database,
                { ...scope, ...identity(key) },
                delivery(key),
              ),
            )
          : memory.mutate({
              ...scope,
              ...identity(key),
              kind: "source-delivery",
              delivery: delivery(key),
            }).sourceDelivery;
      const read = (key: string) =>
        backend === "sqlite"
          ? readSessionInputSettlementRow(f.database, { ...scope, idempotencyKey: key })
          : state.completions.get(key);
      const complete = (key: string) =>
        backend === "sqlite"
          ? write(() =>
              writeSessionInputCompletion(
                f.database,
                { ...scope, ...identity(key) },
                buildAgentRunTerminalOutcome({ status: "ok" }),
              ),
            )
          : memory.mutate({
              ...scope,
              ...identity(key),
              kind: "complete",
              outcome: buildAgentRunTerminalOutcome({ status: "ok" }),
            }).outcome;
      attach("A");
      attach("B");
      expect(read("A")?.sourceDelivery?.platformMessageId).toBe("final-A");
      expect(read("B")?.sourceDelivery?.platformMessageId).toBe("final-B");
      expect(read("A")?.outcome).toBeUndefined();
      if (backend === "sqlite")
        expect(
          readSessionInputCompletion(f.database, { ...scope, idempotencyKey: "A" }),
        ).toBeUndefined();
      complete("A");
      attach("A");
      expect(read("A")?.outcome?.reason).toBe("completed");
      expect(read("A")?.sourceDelivery?.platformMessageId).toBe("final-A");
      const conflict = { ...delivery("A"), platformMessageId: "different-route" };
      expect(() =>
        backend === "sqlite"
          ? write(() =>
              writeSessionInputSourceDelivery(f.database, { ...scope, ...identity("A") }, conflict),
            )
          : memory.mutate({
              ...scope,
              ...identity("A"),
              kind: "source-delivery",
              delivery: conflict,
            }),
      ).toThrow("different terminal delivery");
    }),
);
