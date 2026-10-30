import type { RequesterOrigin } from "../../agents/requester-origin.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

/** A collected sibling cannot borrow a confirmed send on another original source route. */
export function sourceInputMatchesDeliveryContext(
  origin: RequesterOrigin | undefined,
  context?: DeliveryContext,
): boolean {
  if (!origin) {
    return true;
  }
  const normalized = normalizeDeliveryContext(context);
  const channel = normalized?.channel ?? "";
  return (
    !(origin.messageProvider && origin.messageProvider !== channel) &&
    !(
      origin.conversationId &&
      normalizeTargetForProvider(channel, origin.conversationId) !==
        normalizeTargetForProvider(channel, normalized?.to ?? "")
    ) &&
    !(
      origin.accountId !== undefined &&
      normalizeAccountId(origin.accountId) !== normalizeAccountId(normalized?.accountId)
    ) &&
    !(
      origin.messageThreadId !== undefined &&
      String(origin.messageThreadId ?? "").trim() !== String(normalized?.threadId ?? "").trim()
    )
  );
}
