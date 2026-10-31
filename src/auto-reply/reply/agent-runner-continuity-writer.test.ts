import { afterEach, expect, it } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareContinuityFailureNotice } from "./agent-runner-continuity-notice.js";
import type { FollowupRun } from "./queue/types.js";

afterEach(resetConfigRuntimeState);

it.each(["current", "replaced"] as const)(
  "uses the native settled writer with a stale ingress entry, preserving %s writer fencing",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:native-writer",
        sessionId: "writer-session",
        storePath: `${state.agentDir()}/openclaw-agent.sqlite`,
      };
      const cfg = { session: { store: scope.storePath } };
      setRuntimeConfigSnapshot(cfg);
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        lifecycleRevision: "original-lifecycle",
        deliveryContext: { channel: "webchat", to: scope.sessionKey },
      };
      await replaceSessionEntry(scope, entry);
      const operation = createReplyOperation({ ...scope, resetTriggered: false });
      operation.setPhase("running");
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...scope, sessionEntry: entry, config: cfg },
        input: {
          text: "Synthetic unanswered original",
          timestamp: 1000,
          idempotencyKey: "native-writer:user",
        },
      });
      try {
        await recorder.stageApproved!({ runId: "native-ingress", assertCurrent() {} });
        // Native writer claim commits after ingress captured its entry. The caller
        // consumes the retained settlement target, not a freshly reauthorized row.
        await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "native-run" }));
        const writer = {
          ...scope,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: "native-run",
        };
        if (mode === "replaced") {
          await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "replacement-run" }));
        }
        const followupRun: FollowupRun = {
          prompt: "Synthetic attempt",
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
        const notice = prepareContinuityFailureNotice(
          {
            sessionKey: scope.sessionKey,
            storePath: scope.storePath,
            replyOperation: operation,
            followupRun,
            getActiveSessionEntry: () => entry,
            sessionCtx: {
              Provider: "webchat",
              Surface: "webchat",
              OriginatingChannel: "webchat",
              OriginatingTo: scope.sessionKey,
              ChatType: "direct",
              SessionKey: scope.sessionKey,
            },
          },
          "native-run",
          recorder,
          writer,
        );
        if (mode === "replaced") {
          await expect(notice).rejects.toThrow("Terminal accounting session changed");
        } else {
          const result = await notice;
          expect(result.disposition).toBe("saved-unanswered");
          expect(result.payload?.text).toContain("Synthetic unanswered original");
        }
      } finally {
        recorder.finishPendingInput!("cancelled");
        await recorder.waitForPendingInputSettlement!();
        operation.complete();
      }
    }),
);
