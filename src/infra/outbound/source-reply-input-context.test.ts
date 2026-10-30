import { expect, it } from "vitest";
import { sourceInputMatchesDeliveryContext } from "./source-reply-input-context.js";
it("does not union channel, account, conversation or thread coverage across original inputs", () => {
  const origin = {
    sessionKey: "agent:main:s",
    messageProvider: "test",
    conversationId: "source",
    accountId: "default",
    messageThreadId: 0,
  };
  const context = { channel: "test", to: "source", threadId: "0" };
  expect(sourceInputMatchesDeliveryContext(origin, context)).toBe(true);
  for (const changed of [
    { channel: "other" },
    { to: "other" },
    { accountId: "other" },
    { threadId: "other" },
  ]) {
    expect(sourceInputMatchesDeliveryContext(origin, { ...context, ...changed })).toBe(false);
  }
});
