import { expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { copySessionInputCompletionsForRepair } from "./session-accessor.sqlite-pending-inputs-repair.js";
import {
  readSessionInputCompletion,
  readSessionInputSettlementRow,
  writeSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import { createSessionActorMemoryState } from "./session-actor-memory-state.js";
import { applySessionActorPhaseWithBackend } from "./session-actor-phase.js";
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
    withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      if (backend === "sqlite") {
        expect(
          readSessionInputCompletion(f.database, { ...scope, idempotencyKey: "A" }),
        ).toBeUndefined();
      }
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

it("publishes a receipt only after every identified pending-final member settles", () => {
  const source = identity("A");
  const state = createSessionActorMemoryState({
    sessionKey: "agent:main:A",
    database: { kind: "memory", handle: "proof", incarnation: "one" },
  });
  state.hot.entry = {
    sessionId: "s",
    updatedAt: 1,
    pendingFinalDelivery: {
      kind: "transport-only",
      createdAt: 1,
      intentId: "intent",
      sourceRunId: "R",
      sourceInputs: [source],
      context: { channel: "test", to: "source" },
      deliveries: [
        { id: "one", state: "prepared" },
        { id: "two", state: "prepared" },
      ],
    },
  };
  const memory = createSessionActorMemoryPending(state, {
    agentId: "main",
    path: "memory",
    admit() {},
  });
  const settle = (deliveryId: string, status: "delivered" | "unknown", channel = "test") =>
    applySessionActorPhaseWithBackend(
      {
        type: "session.actor.deliverySettled",
        input: {
          target: state.hot.target,
          commandId: deliveryId,
          phaseId: deliveryId,
          settlement: {
            sessionId: "s",
            intentId: "intent",
            deliveryId,
            state: status,
            cleanup: { sessionKey: "agent:main:A", now: 10 },
          },
          evidence: {
            result: {
              channel,
              platformMessageId: `platform-${deliveryId}`,
              target: { id: "source" },
            },
          },
        },
      },
      state.hot,
      {
        agentId: "main",
        writeEntry(entry) {
          state.hot.entry = entry;
        },
        mutatePendingInput: memory.mutate,
        turn() {
          throw new Error("unexpected turn");
        },
        append() {
          throw new Error("unexpected append");
        },
        appendEvent() {
          throw new Error("unexpected event");
        },
        validateSources() {
          return { conversationMatches: [] };
        },
        admit() {},
      },
    );
  settle("one", "delivered");
  expect(state.completions.size).toBe(0);
  settle("two", "unknown");
  expect(state.completions.size).toBe(0);
  expect(state.hot.entry.pendingFinalDelivery?.deliveries?.[1]?.state).toBe("unknown");
  settle("two", "delivered", "wrong-route");
  expect(state.completions.size).toBe(0);
  expect(state.hot.entry.pendingFinalDelivery?.deliveries?.[1]?.state).toBe("unknown");
  settle("two", "delivered");
  expect(state.completions.get("A")?.sourceDelivery?.resultCount).toBe(2);
  expect(state.hot.entry.pendingFinalDelivery).toBeUndefined();
});

it("retains immutable native receipt bytes after the memory caller releases its projection", () => {
  const state = createSessionActorMemoryState({
    sessionKey: "agent:main:immutable",
    database: { kind: "memory", handle: "proof", incarnation: "one" },
  });
  state.hot.entry = { sessionId: "s", updatedAt: 1 };
  const memory = createSessionActorMemoryPending(state, {
    agentId: "main",
    path: "memory",
    admit() {},
  });
  const provided = delivery("A");
  memory.mutate({
    ...identity("A"),
    sessionKey: "agent:main:immutable",
    sessionId: "s",
    kind: "source-delivery",
    delivery: provided,
  });
  provided.platformMessageId = "mutated-projection";
  expect(state.completions.get("A")?.sourceDelivery?.platformMessageId).toBe("final-A");
});

it("canonical repair retains a receipt beside final processing and rejects divergent terminal receipts", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const destination = openOpenClawAgentDatabase({
      agentId: "main",
      path: `${f.database.path}.destination`,
    });
    const scope = { sessionKey: f.scope.sessionKey, sessionId: f.scope.sessionId };
    const sourceWrite = <T>(run: () => T) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: f.database.path });
    const destinationWrite = <T>(run: () => T) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: destination.path });
    sourceWrite(() => {
      ensureSessionPendingInputsSchema(f.database.db);
      ensureSessionInputCompletionsSchema(f.database.db);
      writeSessionInputSourceDelivery(f.database, { ...scope, ...identity("A") }, delivery("A"));
    });
    destinationWrite(() => {
      writeSessionEntry(destination, scope.sessionKey, {
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      ensureSessionPendingInputsSchema(destination.db);
      ensureSessionInputCompletionsSchema(destination.db);
      writeSessionInputCompletion(
        destination,
        { ...scope, ...identity("A") },
        buildAgentRunTerminalOutcome({ status: "ok" }),
      );
      copySessionInputCompletionsForRepair(
        f.database,
        destination,
        [scope.sessionKey],
        scope.sessionKey,
      );
    });
    expect(
      readSessionInputSettlementRow(destination, { ...scope, idempotencyKey: "A" }),
    ).toMatchObject({
      outcome: { reason: "completed" },
      sourceDelivery: { platformMessageId: "final-A" },
    });
    sourceWrite(() =>
      writeSessionInputSourceDelivery(
        f.database,
        { ...scope, ...identity("conflict") },
        delivery("A"),
      ),
    );
    destinationWrite(() =>
      writeSessionInputSourceDelivery(
        destination,
        { ...scope, ...identity("conflict") },
        delivery("B"),
      ),
    );
    expect(() =>
      destinationWrite(() =>
        copySessionInputCompletionsForRepair(
          f.database,
          destination,
          [scope.sessionKey],
          scope.sessionKey,
        ),
      ),
    ).toThrow("different terminal delivery");
  }));
