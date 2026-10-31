import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { readSessionPendingInputSettlements } from "../../config/sessions/session-accessor.pending-inputs.js";
import { sourceInputMatchesDeliveryContext } from "../../infra/outbound/source-reply-input-context.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.identity.js";
import { hasLiveSessionControllerSourceExecution } from "../../sessions/session-controller.mailbox-source.js";
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
  turn: Pick<
    AgentTurnParams,
    | "replyOperation"
    | "sessionKey"
    | "storePath"
    | "followupRun"
    | "opts"
    | "getActiveSessionEntry"
    | "sessionCtx"
    | "runtimePolicySessionKey"
  >,
  runId: string,
  inputRecorder?: UserTurnTranscriptRecorder | null,
  writer?: Parameters<typeof withAgentTurnCompletion>[0]["writer"],
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
  // Failed-owner cleanup cancels unconsumed custody even if a waiter shares it.
  // Only consumed originals can survive that cleanup through a runnable successor.
  const recoveryOwnsInput = (original: (typeof originals)[number]) =>
    original.consumed &&
    getSessionControllerEntryForOperation(operation).mailbox?.entries.some((input) => {
      if (!hasLiveSessionControllerSourceExecution(input)) {
        return false;
      }
      const candidateRecorder = input.source?.userTurnTranscriptRecorder;
      const owner = candidateRecorder && getUserTurnTranscriptAdmissionOwner(candidateRecorder);
      const candidates = owner?.sources?.length
        ? owner.sources
        : candidateRecorder
          ? [candidateRecorder]
          : [];
      return candidates.some((candidate) => {
        const pending = getUserTurnTranscriptAdmissionOwner(candidate)?.pendingInput();
        return (
          pending &&
          readSessionPendingInputSettlements(pending).some(
            (source) =>
              source.sessionKey === original.sessionKey &&
              source.sessionId === original.sessionId &&
              source.identity &&
              isDeepStrictEqual(source.identity, original.identity),
          )
        );
      });
    });
  return withAgentTurnCompletion(
    {
      agentId: turn.followupRun.run.agentId,
      storePath,
      sessionKey,
      entry: turn.getActiveSessionEntry(),
      writer,
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
      const unowned = unanswered.filter((source) => !recoveryOwnsInput(source));
      if (!unowned.length) {
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
      if (unowned.some((input) => !sourceInputMatchesDeliveryContext(input.origin, context))) {
        return { disposition: "unknown" };
      }
      const text = unowned
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
        sourceInputs: unowned.map((source) => source.identity!),
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
