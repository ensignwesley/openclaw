import { afterEach, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { setRuntimeConfigSnapshot, resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readUserTurnSourceInputs,
  readUserTurnSourceDelivery,
} from "./user-turn-source-delivery.js";
import { completeUserTurnProcessing } from "./user-turn-transcript-processing.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";

afterEach(() => resetConfigRuntimeState());

it.each([false, true])(
  "reads exact durable receipt through a fresh native recorder (processing=%s)",
  (processing) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const target = {
        agentId: "main",
        sessionKey: "agent:main:receipt",
        sessionId: "receipt",
        sessionEntry: { sessionId: "receipt", updatedAt: 1 },
      };
      runOpenClawAgentWriteTransaction(
        () => writeSessionEntry(database, target.sessionKey, target.sessionEntry),
        { agentId: "main", path: database.path },
      );
      const message = {
        role: "user" as const,
        content: "Synthetic receipt source",
        timestamp: 1,
        idempotencyKey: "source:user",
      };
      const make = () =>
        createUserTurnTranscriptRecorder({ target, message, trackInputCompletion: processing });
      const first = make();
      await first.stageApproved!({ runId: "source", assertCurrent() {} });
      await first.persistApproved();
      const originals = await readUserTurnSourceInputs(first, () => {});
      expect(originals).toHaveLength(1);
      const receipt = {
        kind: "answer" as const,
        responderRunId: "shared-R",
        intentId: "native-final",
        deliveryId: "final",
        platformMessageId: "final",
        resultCount: 1,
        settledAt: 10,
      };
      await originals[0]!.write!(receipt);
      expect(first.getProcessingCompletion?.()).toBeUndefined();
      if (processing) {
        await completeUserTurnProcessing(first, buildAgentRunTerminalOutcome({ status: "ok" }));
      }
      first.finishPendingInput!("interrupted");
      await first.waitForPendingInputSettlement!();
      const fresh = make();
      await fresh.stageApproved!({ runId: "source", assertCurrent() {} });
      expect(await readUserTurnSourceDelivery(fresh, () => {})).toEqual([receipt]);
      expect(await readUserTurnSourceInputs({ ...fresh }, () => {})).toEqual([]);
      fresh.finishPendingInput!("interrupted");
      await fresh.waitForPendingInputSettlement!();
    }),
);

it("associates every native collected original with its one committed aggregate admission", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const target = {
      agentId: "main",
      sessionKey: "agent:main:collected-receipt",
      sessionId: "collected",
      sessionEntry: { sessionId: "collected", updatedAt: 1 },
    };
    runOpenClawAgentWriteTransaction(
      () => writeSessionEntry(database, target.sessionKey, target.sessionEntry),
      { agentId: "main", path: database.path },
    );
    const make = (key: string) =>
      createUserTurnTranscriptRecorder({
        target,
        message: {
          role: "user",
          content: `Synthetic ${key}`,
          timestamp: 1,
          idempotencyKey: `${key}:user`,
        },
      });
    const a = make("A"),
      b = make("B");
    await a.stageApproved!({ runId: "A", assertCurrent() {} });
    await b.stageApproved!({ runId: "B", assertCurrent() {} });
    const aggregate = createUserTurnTranscriptRecorder({
      target,
      message: {
        role: "user",
        content: "Collected synthetic A and B",
        timestamp: 2,
        idempotencyKey: "aggregate:user",
      },
      pendingInputSources: [a, b],
    });
    await aggregate.persistApproved();
    const originals = await readUserTurnSourceInputs(aggregate, () => {});
    expect(originals).toHaveLength(2);
    expect(originals.every((input) => input.consumed)).toBe(true);
    expect(originals.map((input) => input.admission?.entryId)).toEqual([
      aggregate.getAdmissionReceipt()!.entryId,
      aggregate.getAdmissionReceipt()!.entryId,
    ]);
    aggregate.finishPendingInput!("interrupted");
    await aggregate.waitForPendingInputSettlement!();
  }));

it("reuses canonical admission identity for a native input that was never staged", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const target = {
      agentId: "main",
      sessionKey: "agent:main:unstaged-receipt",
      sessionId: "unstaged",
      sessionEntry: { sessionId: "unstaged", updatedAt: 1 },
    };
    runOpenClawAgentWriteTransaction(
      () => writeSessionEntry(database, target.sessionKey, target.sessionEntry),
      { agentId: "main", path: database.path },
    );
    const make = () =>
      createUserTurnTranscriptRecorder({
        target,
        message: {
          role: "user",
          content: "Synthetic unstaged native input",
          timestamp: 1,
          idempotencyKey: "unstaged:user",
        },
      });
    const original = make();
    await original.persistApproved();
    const inputs = await readUserTurnSourceInputs(original, () => {});
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.identity?.runId).toBe(`input:${original.getAdmissionReceipt()!.entryId}`);
    const receipt = {
      kind: "answer" as const,
      responderRunId: "R",
      intentId: "final",
      deliveryId: "final",
      platformMessageId: "native-final",
      resultCount: 1,
      settledAt: 10,
    };
    await inputs[0]!.write!(receipt);
    original.finishPendingInput!("interrupted");
    await original.waitForPendingInputSettlement!();
    const fresh = make();
    await fresh.persistApproved();
    expect(await readUserTurnSourceDelivery(fresh, () => {})).toEqual([receipt]);
    expect(fresh.getProcessingCompletion?.()).toBeUndefined();
    fresh.finishPendingInput!("interrupted");
    await fresh.waitForPendingInputSettlement!();
  }));
