import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import type { CurrentPromptReaction } from "../../sessions/user-turn-transcript-admission.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { prepareSourceInputFinalDelivery } from "./source-input-final-delivery.js";

/** The native SQLite reaction has the same exact-input final custodian as external tools. */
export async function settleCurrentPromptReactionSource(params: {
  source?: MessageActionAuthorization["currentInput"];
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolCallId: string;
  terminal: boolean;
  execute: () => ReturnType<CurrentPromptReaction>;
}): Promise<Awaited<ReturnType<CurrentPromptReaction>> | "answered" | "pending"> {
  if (!params.terminal || !params.source || !params.sessionKey || !params.sessionId) {
    return params.execute();
  }
  const originals = await readUserTurnSourceInputs(
    params.source.recorder,
    params.source.assertCurrent,
  );
  const origin = originals[0]?.origin;
  const context = {
    channel: origin?.messageProvider ?? "webchat",
    to: origin?.conversationId ?? params.sessionKey,
    accountId: origin?.accountId ?? undefined,
    threadId: origin?.messageThreadId ?? undefined,
  };
  const completion = await prepareSourceInputFinalDelivery({
    ...params,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    source: params.source,
    runId: params.source.runId,
    context,
  });
  if (completion === "answered" || completion === "pending") {
    return completion;
  }
  let result: Awaited<ReturnType<CurrentPromptReaction>>;
  try {
    result = await params.execute();
  } catch (error) {
    if (completion) {
      await settlePendingFinalDelivery(completion, "unknown");
    }
    throw error;
  }
  if (completion) {
    await settlePendingFinalDelivery(
      completion,
      result.changed ? "delivered" : "suppressed",
      undefined,
      {
        clearAfterSettled: true,
        ...(result.changed
          ? {
              identifiedResult: {
                channel: context.channel,
                messageId: result.messageId,
                target: { kind: "chat" as const, id: context.to },
              },
            }
          : {}),
      },
    );
  }
  return result;
}
