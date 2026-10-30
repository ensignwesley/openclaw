import { afterEach, expect, it } from "vitest";
import { SessionTranscriptContinuityError } from "../../agents/sessions/transcript-turn-error.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionActor } from "../../config/sessions/session-actor-scope.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  claimSessionControllerInput,
  submitSessionControllerInput,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { prepareContinuityFailureNotice } from "./agent-runner-continuity-notice.js";
import { resolveReplyRunDeliveryContext } from "./agent-runner-core.js";
import type { FollowupRun } from "./queue/types.js";

afterEach(() => resetConfigRuntimeState());

it.each(["staged", "mixed", "pending", "live", "mixed-live", "reservation"] as const)(
  "retains an exact owned outcome after native %s continuity failure and real terminal cleanup",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:r2",
        sessionId: "r2",
        storePath: `${state.agentDir()}/openclaw-agent.sqlite`,
      };
      const cfg = {
        session: { store: scope.storePath },
        agents: { defaults: { userTimezone: "UTC" } },
      };
      setRuntimeConfigSnapshot(cfg);
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        deliveryContext: { channel: "whatsapp", to: "synthetic-source", accountId: "default" },
      };
      await replaceSessionEntry(scope, entry);
      const operation = createReplyOperation({ ...scope, resetTriggered: false });
      operation.setPhase("running");
      const assertCurrent = () => {
        if (!isCurrentSessionControllerOperation(operation)) {
          throw new Error("Native test operation lost custody");
        }
      };
      const make = (key: string) =>
        createUserTurnTranscriptRecorder({
          target: { ...scope, sessionEntry: entry, config: cfg },
          input: {
            text: `${key} accepted synthetic original`,
            timestamp: 1000,
            idempotencyKey: `${key}:user`,
          },
        });
      const a = make("A");
      await a.stageApproved!({ runId: "ingress-A", assertCurrent });
      if (mode === "live" || mode === "reservation") {
        await a.persistApproved();
      }
      const b = mode === "mixed" || mode === "mixed-live" ? make("B") : undefined;
      if (b) {
        await a.persistApproved();
        await b.stageApproved!({ runId: "ingress-B", assertCurrent });
      }
      const recorder = b
        ? createUserTurnTranscriptRecorder({
            target: { ...scope, sessionEntry: entry, config: cfg },
            input: { text: "Collected A and B", idempotencyKey: "aggregate:user" },
            pendingInputSources: [a, b],
          })
        : a;
      const followupRun: FollowupRun = {
        prompt: "Synthetic R2 attempt",
        enqueuedAt: 0,
        userTurnTranscriptRecorder: recorder,
        run: {
          ...scope,
          agentDir: state.agentDir(),
          sessionFile: scope.storePath,
          workspaceDir: state.workspaceDir,
          config: cfg,
          provider: "fixture",
          model: "fixture",
          timeoutMs: 1000,
          blockReplyBreak: "message_end",
        },
      };
      const turn = {
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        replyOperation: operation,
        followupRun,
        getActiveSessionEntry: () => entry,
        sessionCtx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          OriginatingChannel: "whatsapp",
          OriginatingTo: "synthetic-source",
          AccountId: "default",
          ChatType: "direct" as const,
          SessionKey: scope.sessionKey,
        },
      };
      const context = resolveReplyRunDeliveryContext({
        cfg,
        sessionCtx: turn.sessionCtx,
        sessionEntry: entry,
        sessionKey: scope.sessionKey,
      });
      expect(context).toMatchObject({ channel: "whatsapp", to: "synthetic-source" });
      const originals = await readUserTurnSourceInputs(recorder, assertCurrent);
      expect(originals.map((input) => input.consumed)).toEqual(
        b ? [true, false] : [mode === "live" || mode === "reservation"],
      );
      const readPending = () =>
        withSessionActor(
          scope,
          { assertCurrent() {}, assertReadable() {} },
          async (actor) =>
            (await actor.read({ assertCurrent() {}, authorize() {} })).entry?.pendingFinalDelivery,
        );
      if (mode === "pending") {
        await withAgentTurnCompletion(
          { ...scope, entry, operation, recorder, publish() {} },
          async (completion) => {
            await completion!.complete({
              kind: "replayable",
              text: "Existing addressed notice",
              sourceOutcome: "failure-notice",
              intentId: "existing-intent",
              sourceRunId: "existing-responder",
              deliveries: [{ id: "existing-member", state: "prepared" }],
              context,
              createdAt: 1,
            });
          },
        );
        await settlePendingFinalDelivery(
          {
            ...scope,
            kind: "pending-final",
            intentId: "existing-intent",
            deliveryId: "existing-member",
          },
          "unknown",
        );
      }
      const successor = { ...followupRun, userTurnTranscriptRecorder: a };
      const recovery =
        mode === "live" || mode === "mixed-live"
          ? claimSessionControllerInput(successor)
          : undefined;
      const reservation =
        mode === "reservation"
          ? submitSessionControllerInput(scope.sessionKey, successor, { mode: "followup" })
          : undefined;
      let result: Awaited<ReturnType<typeof prepareContinuityFailureNotice>>;
      try {
        try {
          throw new SessionTranscriptContinuityError(
            "projection_read_fence",
            "Deterministic native failure before remaining user consumption",
          );
        } catch (error) {
          expect(error).toBeInstanceOf(SessionTranscriptContinuityError);
          result = await prepareContinuityFailureNotice(turn, "failed-attempt-R", recorder);
        }
      } finally {
        // These are the actual native chat terminal cleanup APIs, not a mocked disposition.
        recorder.finishPendingInput!("cancelled");
        await recorder.waitForPendingInputSettlement!();
        operation.complete();
      }
      expect(isCurrentSessionControllerOperation(operation)).toBe(false);
      if (recovery) {
        const claim = await recovery;
        const next = createReplyOperation({ ...scope, resetTriggered: false, mailboxClaim: claim });
        next.setPhase("running");
        expect(isCurrentSessionControllerOperation(next)).toBe(true);
        const fresh = make("A");
        await fresh.stageApproved!({
          runId: "ingress-A",
          assertCurrent() {
            if (!isCurrentSessionControllerOperation(next)) {
              throw new Error("Successor lost custody");
            }
          },
        });
        expect(
          (await readUserTurnSourceInputs(fresh, () => {})).map((input) => input.identity),
        ).toEqual([originals[0]!.identity]);
        fresh.finishPendingInput!("cancelled");
        await fresh.waitForPendingInputSettlement!();
        // A real retained waiter became the actual successor after failed-owner cleanup.
        expect(claim.sources).toEqual([successor]);
        next.complete();
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
      }
      if (reservation) {
        retireSessionControllerInput(reservation);
        await reservation.settlement.promise;
      }
      const retained = await readPending();
      if (mode === "live") {
        expect(result!.disposition).toBe("recovering");
        expect(retained).toBeUndefined();
      } else if (mode === "pending") {
        expect(result!.disposition).toBe("delivery-unknown");
        expect(result!.payload).toBeUndefined();
        expect(retained).toMatchObject({
          intentId: "existing-intent",
          deliveries: [{ state: "unknown" }],
        });
      } else {
        expect(result!.disposition).toBe("saved-unanswered");
        if (mode === "mixed-live") {
          expect(result!.payload?.text).not.toContain("A accepted synthetic original");
        } else {
          expect(result!.payload?.text).toContain("A accepted synthetic original");
        }
        if (b) {
          expect(result!.payload?.text).toContain("B accepted synthetic original");
        }
        expect(result!.payload?.text?.match(/I couldn't answer your/g)).toHaveLength(
          b && mode !== "mixed-live" ? 2 : 1,
        );
        expect(retained?.sourceInputs?.map((input) => input.idempotencyKey)).toEqual(
          mode === "mixed-live" ? ["B:user"] : b ? ["A:user", "B:user"] : ["A:user"],
        );
        expect(retained?.deliveries).toMatchObject([{ state: "prepared" }]);
        expect(retained?.kind).toBe("replayable");
        if (retained?.kind !== "replayable") {
          throw new Error("Missing native notice intent");
        }
        expect(retained.text).toBe(result!.payload?.text);
      }
    }),
);
