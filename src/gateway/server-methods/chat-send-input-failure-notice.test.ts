import { afterEach, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";

const fixture = vi.hoisted(() => ({
  current: true,
  append: vi.fn(),
  settle: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock("./chat-send-delivery-authority.js", async (original) => ({
  ...(await original<typeof import("./chat-send-delivery-authority.js")>()),
  createChatSendReplyFinalizationAuthority: async () => ({
    deliveryAuthorized: () => fixture.current,
    authorizeDelivery: () => fixture.current,
    captureMediaScope: async () => ({
      assertCurrent: () => {
        if (!fixture.current) {
          throw new Error("replaced source");
        }
      },
    }),
    release() {},
  }),
}));
vi.mock("../session-utils-store-worker.js", async (original) => ({
  ...(await original<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    storePath: "/synthetic/openclaw-agent.sqlite",
    entry: { sessionId: "source-session", lifecycleRevision: "original" },
  }),
}));
vi.mock("./chat-transcript-source-reply-owner.js", async (original) => ({
  ...(await original<typeof import("./chat-transcript-source-reply-owner.js")>()),
  readCommittedSourceReplyContent: async () => undefined,
}));
vi.mock("./chat-reply-media.js", async (original) => ({
  ...(await original<typeof import("./chat-reply-media.js")>()),
  withPreparedWebchatReplyMedia: async (
    params: { inputs: Array<{ payload: { text?: string } }> },
    consume: (prepared: unknown) => unknown,
  ) =>
    consume({
      payloads: params.inputs.map((input) => input.payload),
      inputsByIndex: params.inputs.map((input) => [input]),
      buildContent: async (inputs: Array<{ payload: { text?: string } }>) => {
        const content = [{ type: "text", text: inputs[0]?.payload.text }];
        return { persistedAssistantContent: content, broadcastContent: content };
      },
    }),
}));
vi.mock("./chat-transcript-inject.js", async (original) => ({
  ...(await original<typeof import("./chat-transcript-inject.js")>()),
  appendInjectedAssistantMessageToTranscript: fixture.append,
}));
vi.mock("../../infra/outbound/delivery-completion.js", async (original) => ({
  ...(await original<typeof import("../../infra/outbound/delivery-completion.js")>()),
  settlePendingFinalDelivery: fixture.settle,
}));
vi.mock("./chat-broadcast.js", async (original) => ({
  ...(await original<typeof import("./chat-broadcast.js")>()),
  broadcastChatFinal: fixture.broadcast,
}));
afterEach(() => {
  fixture.current = true;
  vi.resetAllMocks();
});

const text =
  "I couldn't answer your message, “Summarize this synthetic report.” Please resend that message.";
const completion = {
  agentId: "main",
  sessionKey: "agent:main:notice",
  sessionId: "source-session",
  storePath: "/synthetic/openclaw-agent.sqlite",
  intentId: "notice-intent",
  deliveryId: "notice-delivery",
};
const run = (hostNotice: boolean) =>
  finalizeChatSendSourceReplies({
    context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
    accountId: undefined,
    terminalEntry: undefined,
    emitFirstAssistantServerTiming() {},
    session: {
      agentId: "main",
      backingSessionId: "source-session",
      clientRunId: "native-run",
      cfg: {},
      sessionKey: completion.sessionKey,
      sessionLoadOptions: { agentId: "main" },
    },
    deliveredReplies: [
      {
        kind: "final",
        input: {
          kind: "raw",
          payload: setReplyPayloadMetadata(
            { text, isError: true },
            {
              ...(hostNotice ? { hostNotice: true as const } : {}),
              pendingFinalDeliveryCompletion: completion,
            },
          ),
        },
      },
    ],
    hasReturnedAgentErrorPayloads: true,
    suppressFinal: true,
  });

it("publishes exactly one addressed host notice and settles only its committed identity", async () => {
  const canonical = {
    role: "assistant",
    content: [{ type: "text", text }],
    __openclaw: { id: "notice-row", runId: "native-run" },
  };
  fixture.append.mockResolvedValue({ ok: true, messageId: "notice-row", message: canonical });
  fixture.settle.mockResolvedValue({ state: "delivered" });
  await run(true);
  const addressed = fixture.broadcast.mock.calls.filter(([event]) =>
    JSON.stringify(event).includes("I couldn't answer your"),
  );
  expect(addressed).toHaveLength(1);
  expect(JSON.stringify(addressed)).toContain("Summarize this synthetic report.");
  expect(addressed[0]![0].message).toEqual(canonical);
  expect(fixture.append).toHaveBeenCalledWith(
    expect.objectContaining({
      message: text,
      runId: "native-run",
      sessionKey: completion.sessionKey,
      expectedSessionId: completion.sessionId,
      idempotencyKey: "notice-intent:notice-delivery",
    }),
  );
  expect(fixture.settle).toHaveBeenCalledWith(
    { kind: "pending-final", ...completion },
    "delivered",
    ["prepared", "queued", "unknown"],
    {
      identifiedResult: {
        channel: "webchat",
        messageId: "notice-row",
        target: { kind: "chat", id: completion.sessionKey },
      },
      clearAfterSettled: true,
    },
  );
  expect(fixture.append.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.broadcast.mock.invocationCallOrder[0]!,
  );
  expect(fixture.broadcast.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.settle.mock.invocationCallOrder[0]!,
  );
});
it("keeps generic failed-run errors suppressed", async () => {
  await run(false);
  expect(fixture.append).not.toHaveBeenCalled();
  expect(fixture.broadcast).not.toHaveBeenCalled();
  expect(fixture.settle).not.toHaveBeenCalled();
});
it("does not publish or discharge custody after persistence refusal", async () => {
  fixture.append.mockResolvedValue({ ok: false, error: "synthetic refusal" });
  await expect(run(true)).rejects.toThrow("not persisted");
  expect(fixture.broadcast).not.toHaveBeenCalled();
  expect(fixture.settle).not.toHaveBeenCalled();
});
it("does not discharge custody after source replacement at publication", async () => {
  fixture.append.mockImplementation(async () => {
    fixture.current = false;
    return { ok: true, messageId: "notice-row" };
  });
  await run(true);
  expect(fixture.broadcast).not.toHaveBeenCalled();
  expect(fixture.settle).not.toHaveBeenCalled();
});
