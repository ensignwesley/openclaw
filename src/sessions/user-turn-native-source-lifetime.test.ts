import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { preparePendingInputStore } from "../config/sessions/session-pending-input-store.js";
import { createChatSendWorkAdmission } from "../gateway/server-methods/chat-send-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createReplyOperation } from "./session-controller.js";
import { readUserTurnSourceInputs } from "./user-turn-source-delivery.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import {
  publishCommittedUserTurnInput,
  withCurrentUserTurnInput,
} from "./user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";

afterEach(resetConfigRuntimeState);
it.each(["resolved", "rejected"] as const)(
  "retains the steered source through native reconciliation, then releases its %s dispatcher",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:native-lifetime",
        sessionId: "native-lifetime",
        storePath: `${state.agentDir()}/openclaw-agent.sqlite`,
      };
      const cfg = { session: { store: scope.storePath } };
      setRuntimeConfigSnapshot(cfg);
      const entry = { sessionId: scope.sessionId, updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const operation = createReplyOperation({ ...scope, resetTriggered: false });
      operation.setPhase("running");
      const make = (key: string) =>
        createUserTurnTranscriptRecorder({
          target: { ...scope, sessionEntry: entry, config: cfg },
          input: { text: `${key} synthetic native original`, idempotencyKey: `${key}:user` },
        });
      const a = make("A"),
        b = make("B");
      const releaseDone = createDeferred();
      const released = vi.fn(() => releaseDone.resolve());
      const work = createChatSendWorkAdmission({
        admission: { release: released },
        logGateway: { warn: vi.fn() },
      });
      work.setPendingInputCleanup(async () => {
        b.finishPendingInput!("cancelled");
        await b.waitForPendingInputSettlement!();
      });
      getUserTurnTranscriptAdmissionOwner(b)!.retainSource = work.retain;
      try {
        await a.stageApproved!({ runId: "ingress-A", assertCurrent() {} });
        await b.stageApproved!({ runId: "ingress-B", assertCurrent() {} });
        const dispatch = withCurrentUserTurnInput(a, async () => {
          // The execution has a separate recorder set, but source delivery remains
          // within the enclosing dispatcher lifetime, including final accounting.
          await withCurrentUserTurnInput(
            a,
            async () => {
              await b.persistApproved();
              publishCommittedUserTurnInput(b);
              work.release(); // Native USER commit settles the injection, not its answer.
              const sources = await readUserTurnSourceInputs(b, () => {});
              expect(sources).toHaveLength(1);
              await sources[0]!.write!({
                kind: "answer",
                responderRunId: "native-R",
                intentId: "B-native",
                deliveryId: "B-final",
                platformMessageId: "B-final",
                resultCount: 1,
                settledAt: 1,
              });
            },
            operation,
          );
          expect(work.isActive()).toBe(true);
          const sources = await readUserTurnSourceInputs(b, () => {});
          expect(await sources[0]!.read!()).toMatchObject({
            kind: "answer",
            platformMessageId: "B-final",
          });
          if (mode === "rejected") {
            throw new Error("Synthetic native finalization failure");
          }
        });
        if (mode === "rejected") {
          await expect(dispatch).rejects.toThrow("Synthetic native finalization failure");
        } else {
          await dispatch;
        }
        expect(work.isActive()).toBe(false);
        await b.waitForPendingInputSettlement!();
        await releaseDone.promise;
        expect(released).toHaveBeenCalledOnce();
        const stored = await preparePendingInputStore(scope, () => {});
        try {
          expect(
            await stored.read({ ...scope, kind: "settlement", idempotencyKey: "B:user" }),
          ).toMatchObject({
            kind: "settlement",
            row: { sourceDelivery: { kind: "answer", platformMessageId: "B-final" } },
          });
        } finally {
          await stored.release();
        }
        await expect(readUserTurnSourceInputs(b, () => {})).rejects.toThrow(
          "Pending input ownership ended",
        );
      } finally {
        work.release();
        a.finishPendingInput!("cancelled");
        b.finishPendingInput!("cancelled");
        await a.waitForPendingInputSettlement!();
        await b.waitForPendingInputSettlement!();
        operation.complete();
      }
    }),
);
