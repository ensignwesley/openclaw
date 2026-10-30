import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import { settleCurrentPromptReactionSource } from "../../infra/outbound/source-input-prompt-reaction.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { CurrentPromptReaction } from "../../sessions/user-turn-transcript-admission.js";
import { runWithAgentToolSourceExecutionScope } from "../agent-tool-source-execution-guard.js";
import { attachEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { jsonResult, readToolStringParam } from "./common.js";

/** Native prompt reactions are a source completion route, not external channel dispatch. */
export async function executeMessageToolPromptReaction(input: {
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolCallId: string;
  requestedFinal?: boolean;
  source?: MessageActionAuthorization["currentInput"];
  sourceReplyOperation?: Pick<ReplyOperation, "markSourceReplyDelivered">;
  currentPromptReaction: CurrentPromptReaction;
  assertCurrent: () => void;
  authorize: () => void;
}) {
  const { params } = input;
  const allowedParams = new Set(["action", "channel", "emoji", "remove", "dryRun"]);
  if (Object.keys(params).some((key) => params[key] !== undefined && !allowedParams.has(key))) {
    throw new Error(
      "WebChat reactions only target the current prompt; omit target, messageId, and identity parameters.",
    );
  }
  input.authorize();
  const emoji = readToolStringParam(params, "emoji", { required: true });
  const remove = readBooleanParam(params, "remove") === true;
  const dryRun = readBooleanParam(params, "dryRun") === true;
  const result = await settleCurrentPromptReactionSource({
    ...input,
    terminal: input.requestedFinal === true && !remove && !dryRun,
    execute: () =>
      runWithAgentToolSourceExecutionScope(input.assertCurrent, () =>
        input.currentPromptReaction({ emoji, remove, dryRun, assertCurrent: input.assertCurrent }),
      ),
  });
  if (typeof result === "string") {
    return jsonResult({
      ok: true,
      skipped: true,
      reason:
        result === "answered"
          ? "original_input_already_answered"
          : "original_input_delivery_pending",
    });
  }
  input.assertCurrent();
  const sourceReplyDelivered =
    input.requestedFinal === true && result.changed && !remove && !dryRun;
  if (sourceReplyDelivered) {
    input.sourceReplyOperation?.markSourceReplyDelivered();
  }
  return attachEmbeddedMessageDeliveryFact(
    jsonResult({ ok: true, channel: "webchat", ...result, remove, dryRun }),
    {
      status: dryRun ? "dryRun" : "settled",
      partialDelivery: false,
      createdThreadIds: [],
      ...(sourceReplyDelivered ? { sourceReplyDelivered: true } : {}),
    },
  );
}
