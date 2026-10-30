import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { MessageActionResult, ResolvedActionContext } from "./message-action-contracts.js";
import {
  prepareTerminalSourceInputReply,
  settleTerminalSourceInputReply,
} from "./source-reply-mirror.js";

/** Local adapters use the same existing final custodian as Gateway actions, never both. */
export async function executeLocalSourceInputAction(
  ctx: ResolvedActionContext,
  action: ChannelMessageActionName,
  result: (payload: unknown) => MessageActionResult,
  execute: () => Promise<MessageActionResult>,
): Promise<MessageActionResult> {
  if (ctx.dryRun || ctx.input.gatewayOwnedDelivery) {
    return execute();
  }
  const auth = ctx.input.messageActionAuthorization;
  const params = {
    cfg: ctx.cfg,
    action,
    channel: ctx.channel,
    actionParams: ctx.params,
    accountId: ctx.accountId,
    currentAccountId: auth?.requesterAccountId ?? ctx.input.defaultAccountId,
    agentId: ctx.agentId,
    sessionKey: ctx.input.sourceReplySessionKey ?? ctx.input.sessionKey,
    sessionId: ctx.input.sessionId,
    currentInput: auth?.currentInput,
    toolContext: auth?.toolContext ?? ctx.input.toolContext,
    sourceReplyFinal: ctx.input.sourceReplyFinal,
    toolCallId: ctx.input.sourceReplyToolCallId,
    replyToIsExplicit: typeof ctx.params.replyTo === "string" && Boolean(ctx.params.replyTo.trim()),
  };
  const completion = await prepareTerminalSourceInputReply(params);
  if (completion === "answered" || completion === "pending") {
    return result({
      ok: true,
      skipped: true,
      reason:
        completion === "answered"
          ? "original_input_already_answered"
          : "original_input_delivery_pending",
    });
  }
  let accepted: MessageActionResult;
  try {
    accepted = await execute();
  } catch (error) {
    await settleTerminalSourceInputReply(completion, params, error);
    throw error;
  }
  await settleTerminalSourceInputReply(completion, {
    ...params,
    deliveredPayload: accepted.payload,
  });
  return accepted;
}
