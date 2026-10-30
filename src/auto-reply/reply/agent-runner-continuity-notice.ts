import { randomUUID } from "node:crypto";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { sourceInputMatchesDeliveryContext } from "../../infra/outbound/source-reply-input-context.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.identity.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../sessions/user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { escapeMarkdownText } from "../../shared/text/escape-markdown.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { resolveReplyRunDeliveryContext } from "./agent-runner-core.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

export type ContinuityFailureDisposition =
  | "answered"
  | "notified"
  | "recovering"
  | "cancelled"
  | "delivery-unknown"
  | "saved-unanswered"
  | "unknown";

/** An attempt error never proves loss. Only its original accepted input can owe a notice. */
export async function prepareContinuityFailureNotice(
  turn: AgentTurnParams,
  runId: string,
  inputRecorder?: UserTurnTranscriptRecorder | null,
): Promise<{
  disposition: ContinuityFailureDisposition;
  payload?: ReplyPayload;
}> {
  const operation = turn.replyOperation;
  const { sessionKey, storePath } = turn;
  const recorder =
    inputRecorder !== undefined
      ? (inputRecorder ?? undefined)
      : turn.followupRun.userTurnTranscriptRecorder;
  const completed = recorder?.getProcessingCompletion?.();
  if (
    operation?.abortSignal.aborted ||
    completed?.reason === "superseded" ||
    (completed?.reason === "cancelled" && completed.stopReason !== "restart")
  ) {
    return { disposition: "cancelled" };
  }
  if (!operation || !storePath || !sessionKey) {
    return { disposition: "unknown" };
  }
  const assertCurrent = () => {
    if (!isCurrentSessionControllerOperation(operation) || operation.abortSignal.aborted) {
      throw new Error("Input failure no longer owns its operation");
    }
  };
  assertCurrent();
  const originals = await readUserTurnSourceInputs(recorder, assertCurrent);
  if (!originals.length) {
    return { disposition: "unknown" };
  }
  if (originals.some((source) => !source.consumed)) {
    return { disposition: "recovering" };
  }
  // Native local observation reconciles real canonical finals even when ordinary
  // observation was skipped by an awaited postcommit failure. Its return value
  // alone is not a durable exact-input receipt.
  await turn.opts?.resolveReplyDeliveryFacts?.();
  const receipts = await Promise.all(originals.map((source) => source.read!()));
  assertCurrent();
  const unanswered = originals.filter((_, index) => !receipts[index]);
  if (!unanswered.length) {
    return {
      disposition: receipts.some((receipt) => receipt?.kind === "failure-notice")
        ? "notified"
        : "answered",
    };
  }
  if (completed?.reason === "completed") {
    return { disposition: "unknown" };
  }
  const recoveryOwnsInput = () =>
    getSessionControllerEntryForOperation(operation).mailbox?.entries.some((input) => {
      if (input.claim?.operation === operation || !input.source?.userTurnTranscriptRecorder) {
        return false;
      }
      const admission = getUserTurnTranscriptAdmissionOwner(
        input.source.userTurnTranscriptRecorder,
      )?.receipt();
      return (
        admission && unanswered.some((source) => source.admission?.entryId === admission.entryId)
      );
    });
  if (recoveryOwnsInput()) {
    return { disposition: "recovering" };
  }
  return withAgentTurnCompletion(
    {
      agentId: turn.followupRun.run.agentId,
      storePath,
      sessionKey,
      entry: turn.getActiveSessionEntry(),
      operation,
      recorder,
      publish() {},
    },
    async (completion) => {
      if (!completion) {
        return { disposition: "unknown" };
      }
      const current = await completion.refresh();
      if (current.pendingFinalDelivery) {
        return { disposition: "delivery-unknown" };
      }
      assertCurrent();
      if (recoveryOwnsInput()) {
        return { disposition: "recovering" };
      }
      const shared =
        turn.sessionCtx.ChatType !== "direct" && turn.sessionCtx.ChatType !== undefined;
      const context = resolveReplyRunDeliveryContext({
        cfg: turn.followupRun.run.config,
        sessionCtx: turn.sessionCtx,
        sessionEntry: current,
        sessionKey,
        runtimePolicySessionKey: turn.runtimePolicySessionKey,
        opts: turn.opts,
      });
      if (unanswered.some((input) => !sourceInputMatchesDeliveryContext(input.origin, context))) {
        return { disposition: "unknown" };
      }
      const text = unanswered
        .map(({ message }) => {
          const raw =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join(" ");
          const excerpt = escapeMarkdownText(
            [...raw.replace(/[\p{C}\s]+/gu, " ").trim()].slice(0, 120).join(""),
          );
          const time = Number.isFinite(message.timestamp)
            ? new Intl.DateTimeFormat("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: resolveUserTimezone(
                  turn.followupRun.run.config.agents?.defaults?.userTimezone,
                ),
              }).format(message.timestamp)
            : undefined;
          return `I couldn't answer your${time ? ` ${time}` : ""} message${!shared && excerpt ? `, “${excerpt}”` : ""}. Please resend that message.`;
        })
        .join("\n");
      const intentId = randomUUID(),
        deliveryId = randomUUID();
      const entry = await completion.complete({
        kind: "replayable",
        text,
        intentId,
        sourceRunId: runId,
        sourceOutcome: "failure-notice",
        sourceInputs: unanswered.map((source) => source.identity!),
        deliveries: [{ id: deliveryId, state: "prepared" }],
        createdAt: Date.now(),
        context,
      });
      if (entry.pendingFinalDelivery?.intentId !== intentId) {
        return { disposition: "unknown" };
      }
      return {
        disposition: "saved-unanswered",
        payload: setReplyPayloadMetadata(
          { text, isError: true },
          {
            deliverDespiteSourceReplySuppression: true,
            pendingFinalDeliveryCompletion: {
              agentId: turn.followupRun.run.agentId,
              sessionKey,
              storePath,
              sessionId: entry.sessionId,
              intentId,
              deliveryId,
            },
          },
        ),
      };
    },
  );
}
