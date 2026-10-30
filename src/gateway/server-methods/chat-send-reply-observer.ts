import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ReplyDeliveryFactsObserver,
  ReplyDeliveryState,
} from "../../agents/reply-completion.js";
import {
  resolveSessionTranscriptDatabasePath,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { retainSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import { getOwnedSessionTranscriptReader } from "../../config/sessions/transcript-write-context.js";
import { sourceInputMatchesDeliveryContext } from "../../infra/outbound/source-reply-input-context.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import { readCommittedUserTurnInputRecorders } from "../../sessions/user-turn-transcript-runtime-context.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../../shared/chat-message-content.js";
import { isToolHistoryBlockType } from "../chat-display-projection.canvas.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import {
  resolveChatReplyDeliveryFromAnchors,
  resolveChatReplySourceInput,
} from "./chat-send-reply-delivery.js";
import { createChatReplySessionReader, type ChatReplySession } from "./chat-send-reply-session.js";
import type { GatewayRequestContext } from "./types.js";

type SessionReader = ReturnType<typeof createChatReplySessionReader>;
/** The native observer owns canonical final association and source receipt publication. */
export function createChatReplyDeliveryObserver(params: {
  session: ChatReplySession;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "markBlocked" | "getAdmissionReceipt">;
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"];
  getTranscriptStart: () => ReturnType<SessionReader["captureTranscriptStart"]>;
  getRunId: () => string;
  isAgentRunStarted: () => boolean;
  isRunCurrent?: () => boolean;
  abortSignal?: AbortSignal;
  readCurrentSession: SessionReader["readCurrentSession"];
  assertRetainedSourceCurrent: SessionReader["assertRetainedSourceCurrent"];
}): ReplyDeliveryFactsObserver {
  const {
    session,
    userTurnRecorder,
    getRuntimeConfig,
    isAgentRunStarted,
    readCurrentSession,
    assertRetainedSourceCurrent,
  } = params;
  return async (minimumAssistantMessageIndex = 0) => {
    const readSource = session.sessionTarget?.readSource;
    // Keep the selected database owner through the terminal disclosure snapshot.
    const retainedSource =
      assertRetainedSourceCurrent && readSource
        ? retainSessionHistoryWorkerDatabase({ agentId: readSource.agentId, path: readSource.path })
        : undefined;
    try {
      const admission = userTurnRecorder.getAdmissionReceipt();
      const transcriptStart = params.getTranscriptStart();
      const runId = params.getRunId();
      const lifecycleRevision = transcriptStart?.lifecycleRevision;
      const reader = admission && getOwnedSessionTranscriptReader(admission);
      const isRunCurrent = () => {
        const currentAdmission = userTurnRecorder.getAdmissionReceipt();
        return Boolean(
          admission &&
          admission.agentId === session.agentId &&
          admission.sessionKey === session.sessionKey &&
          isAgentRunStarted() &&
          params.isRunCurrent?.() === true &&
          !params.abortSignal?.aborted &&
          params.getRunId() === runId &&
          params.getTranscriptStart() === transcriptStart &&
          currentAdmission?.logicalTurnId === admission.logicalTurnId &&
          currentAdmission?.entryId === admission.entryId,
        );
      };
      const isInspectionCurrent = () => {
        if (!isRunCurrent()) {
          return false;
        }
        assertRetainedSourceCurrent?.();
        retainedSource?.owner.assertCurrent();
        reader?.assertCurrent();
        return true;
      };
      const isCurrent = async () => {
        if (!admission || !isRunCurrent()) {
          return false;
        }
        const current = await readCurrentSession();
        return (
          isRunCurrent() &&
          current.entry?.sessionId === admission.sessionId &&
          current.entry.lifecycleRevision === lifecycleRevision &&
          resolveSessionTranscriptDatabasePath({
            agentId: session.agentId,
            sessionId: admission.sessionId,
            sessionKey: session.sessionKey,
            storePath: current.storePath,
          }) === admission.storePath
        );
      };
      if (
        !admission ||
        !transcriptStart ||
        transcriptStart.sessionId !== admission.sessionId ||
        !(reader ? isInspectionCurrent() : await isCurrent())
      ) {
        return { source: "missing", terminal: "missing" };
      }
      const scope = admission;
      // Inspection exposes no result until the final anchor snapshot rechecks the stored session.
      // Between reads, retain physical/run custody; each history operation keeps its own freshness.
      await waitForSessionTranscriptProjection(scope, params.abortSignal);
      if (!(reader || assertRetainedSourceCurrent ? isInspectionCurrent() : await isCurrent())) {
        return { source: "missing", terminal: "missing" };
      }
      const assertRoutingCurrent = captureSessionMutationRouting(getRuntimeConfig(), undefined, [
        scope,
      ]);
      const sourceInputs = (
        await Promise.all(
          [
            ...new Set([
              userTurnRecorder as UserTurnTranscriptRecorder,
              ...readCommittedUserTurnInputRecorders(
                userTurnRecorder as UserTurnTranscriptRecorder,
              ),
            ]),
          ].map((recorder) =>
            readUserTurnSourceInputs(recorder, () => {
              if (!isInspectionCurrent()) {
                throw new Error("Native reply source lost current admission");
              }
            }),
          ),
        )
      )
        .flat()
        .filter(
          (source) =>
            source.sessionKey === admission.sessionKey && source.sessionId === admission.sessionId,
        );
      const committedSources: Array<{ source: (typeof sourceInputs)[number]; messageId: string }> =
        [];
      let decision: ReplyDeliveryState = "pending";
      let sourceDecision: ReplyDeliveryState = "missing";
      await readSessionTranscriptAnchorsAsync(
        scope,
        {
          entryIds: [admission.entryId],
          afterSeq: transcriptStart.afterSeq,
          includeSession: true,
          includeWatermark: true,
          includeMessagesForRunId: runId,
        },
        params.abortSignal,
        (facts) => {
          assertRoutingCurrent(getRuntimeConfig());
          if (
            !isInspectionCurrent() ||
            facts.session?.sessionId !== admission.sessionId ||
            facts.session.lifecycleRevision !== lifecycleRevision ||
            !facts.watermark
          ) {
            decision = "missing";
            return;
          }
          const input = facts.anchors.find((anchor) => anchor.entryId === admission.entryId);
          if (!input || input.rawSeq !== admission.rawSeq) {
            decision = "missing";
            return;
          }
          let latestInput = input;
          for (const row of facts.tail?.entries ?? []) {
            if (
              row.role === "user" &&
              row.anchor &&
              row.anchor.activeMessagePosition > latestInput.activeMessagePosition
            ) {
              latestInput = row.anchor;
            }
          }
          if (minimumAssistantMessageIndex > 0 && latestInput.entryId === input.entryId) {
            decision = "missing";
            return;
          }
          decision = "missing";
          // Payload visibility and anchors were selected in this same history snapshot.
          // The callback consumes them before releasing the FIFO and native mutation witness.
          for (const row of facts.tail?.entries ?? []) {
            const message = asOptionalRecord(row.message);
            if (message?.role !== "assistant" || readSessionTranscriptRunId(message) !== runId) {
              continue;
            }
            const hasTools =
              message.stopReason === "toolUse" ||
              (Array.isArray(message.content) &&
                message.content.some((block) =>
                  isToolHistoryBlockType(asOptionalRecord(block)?.type),
                ));
            const answer = hasTools
              ? extractAssistantTextForPhase(message, { phase: "final_answer" })
              : extractAssistantPhaseText(message);
            if (
              message.stopReason === "error" ||
              message.stopReason === "aborted" ||
              !answer ||
              !extractAssistantPhaseText(projectChatDisplayMessage(message))
            ) {
              continue;
            }
            const sourceEntryId = resolveChatReplySourceInput({
              facts,
              messageId: row.entryId,
              admissionIds: sourceInputs.flatMap((source) =>
                source.admission ? [source.admission.entryId] : [],
              ),
              afterSeq: transcriptStart.afterSeq,
            });
            const matchedSources = sourceEntryId
              ? sourceInputs.filter(
                  (original) =>
                    original.admission?.entryId === sourceEntryId &&
                    sourceInputMatchesDeliveryContext(original.origin, {
                      channel: "webchat",
                      to: admission.sessionKey,
                    }),
                )
              : [];
            for (const original of matchedSources) {
              if (
                row.anchor &&
                row.anchor.rawSeq > transcriptStart.afterSeq &&
                !committedSources.some(
                  (previous) =>
                    previous.source.identity!.idempotencyKey === original.identity!.idempotencyKey,
                )
              ) {
                committedSources.push({ source: original, messageId: row.entryId });
                sourceDecision = "delivered";
              }
            }
            const selected = resolveChatReplyDeliveryFromAnchors({
              facts,
              admissionId: admission.entryId,
              inputId: latestInput.entryId,
              messageId: row.entryId,
              afterSeq: transcriptStart.afterSeq,
              watermark: facts.watermark,
              currentWatermark: facts.watermark,
            });
            if (selected !== undefined) {
              decision = selected;
              const mirror = asOptionalRecord(message.openclawDeliveryMirror);
              if (mirror?.kind === "message-tool-source-reply" && mirror.final === true) {
                sourceDecision = selected;
                return;
              }
            }
          }
        },
      );
      assertRoutingCurrent(getRuntimeConfig());
      for (const { source: original, messageId } of committedSources) {
        if (!isInspectionCurrent()) {
          throw new Error("Native reply source changed before settlement");
        }
        await original.write!({
          kind: "answer",
          responderRunId: runId,
          intentId: `native:${original.admission!.entryId}`,
          deliveryId: messageId,
          platformMessageId: messageId,
          resultCount: 1,
          settledAt: Date.now(),
        });
      }
      return isInspectionCurrent()
        ? { source: sourceDecision, terminal: decision }
        : { source: "missing", terminal: "missing" };
    } finally {
      retainedSource?.release();
    }
  };
}
