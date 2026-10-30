import { afterEach, expect, it } from "vitest";
import {
  setRuntimeConfigSnapshot,
  resetConfigRuntimeState,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionActor } from "../../config/sessions/session-actor-scope.js";
import {
  mintMessageActionTurnCapability,
  advanceMessageActionPrompt,
  resolveMessageActionTurnAuthorization,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareTerminalSourceInputReply,
  settleTerminalSourceInputReply,
} from "./source-reply-mirror.js";

afterEach(() => resetConfigRuntimeState());

it.each([
  ["reply", false],
  ["reply", true],
  ["thread-reply", false],
  ["thread-reply", true],
] as const)(
  "owns %s custody before I/O and settles only identified result (ambiguous=%s)",
  (action, ambiguous) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:source-reply",
        sessionId: "source-reply",
        storePath: `${state.agentDir()}/openclaw-agent.sqlite`,
      };
      const cfg = { session: { store: scope.storePath } };
      setRuntimeConfigSnapshot(cfg);
      const sessionEntry = { sessionId: scope.sessionId, updatedAt: 1 };
      await replaceSessionEntry(scope, sessionEntry);
      const threadId = action === "thread-reply" ? "root" : undefined;
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...scope, sessionEntry, config: cfg },
        input: {
          requesterOrigin: {
            sessionKey: scope.sessionKey,
            messageProvider: "testchat",
            conversationId: "room",
            accountId: "default",
            messageThreadId: threadId,
          },
        },
        message: {
          role: "user",
          content: "Native reply original",
          timestamp: 1,
          idempotencyKey: "source:user",
        },
      });
      const assertCurrent = () => {};
      await recorder.stageApproved!({ runId: "source", assertCurrent });
      await recorder.persistApproved();
      try {
        const toolContext = {
          currentSourceTurnId: "channel-user:v1:source-A",
          currentChannelProvider: "testchat",
          currentChannelId: "room",
          currentMessagingTarget: "room",
          currentMessageId: "inbound",
          currentThreadTs: threadId,
          currentChatType: "direct" as const,
        };
        const token = mintMessageActionTurnCapability({
          ...scope,
          runId: "actual-runtime-R",
          toolContext,
        });
        advanceMessageActionPrompt({ ...scope, runId: "actual-runtime-R", recorder });
        const auth = resolveMessageActionTurnAuthorization({
          token,
          ...scope,
          runId: "actual-runtime-R",
        });
        expect(auth?.currentInput).toBeDefined();
        const params = {
          action,
          channel: "testchat",
          actionParams: {
            target: "room",
            messageId: "inbound",
            message: "answer",
            ...(threadId ? { threadId } : {}),
          },
          cfg,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          currentInput: auth!.currentInput,
          sourceReplyFinal: true,
          toolCallId: "source-call",
          toolContext,
        };
        const completion = await prepareTerminalSourceInputReply(params);
        expect(completion).toMatchObject({ kind: "pending-final" });
        const readPending = () =>
          withSessionActor(
            scope,
            { assertCurrent, assertReadable: assertCurrent },
            async (actor) =>
              (await actor.read({ assertCurrent, authorize: assertCurrent })).entry
                ?.pendingFinalDelivery,
          );
        expect((await readPending())?.deliveries).toMatchObject([{ state: "prepared" }]);
        expect((await readPending())?.sourceRunId).toBe("actual-runtime-R");
        await settleTerminalSourceInputReply(
          completion,
          {
            ...params,
            ...(ambiguous
              ? {}
              : {
                  deliveredPayload: {
                    ok: true,
                    messageId: "actual-outbound",
                    channelId: "room",
                    receipt: threadId ? { threadId } : { replyToId: "inbound" },
                  },
                }),
          },
          ambiguous ? new Error("lost response after platform acceptance") : undefined,
        );
        const [source] = await readUserTurnSourceInputs(recorder, assertCurrent);
        const receipt = await source!.read!();
        if (ambiguous) {
          expect(receipt).toBeUndefined();
          expect((await readPending())?.deliveries).toMatchObject([{ state: "unknown" }]);
          expect(
            await prepareTerminalSourceInputReply({ ...params, toolCallId: "new-source-call" }),
          ).toBe("pending");
        } else {
          expect(receipt).toMatchObject({
            kind: "answer",
            responderRunId: "actual-runtime-R",
            platformMessageId: "actual-outbound",
          });
          expect(await readPending()).toBeUndefined();
          expect(
            await prepareTerminalSourceInputReply({ ...params, toolCallId: "new-source-call" }),
          ).toBe("answered");
        }
        expect(
          await prepareTerminalSourceInputReply({
            ...params,
            actionParams: { ...params.actionParams, target: "foreign-room" },
          }),
        ).toBeUndefined();
        revokeMessageActionTurnCapability(token);
      } finally {
        recorder.finishPendingInput!("interrupted");
        await recorder.waitForPendingInputSettlement!();
      }
    }),
);

it("binds committed steering to B's native message and actual responder, never A's source token", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:source-steering",
      sessionId: "source-steering",
      storePath: `${state.agentDir()}/openclaw-agent.sqlite`,
    };
    const cfg = { session: { store: scope.storePath } };
    setRuntimeConfigSnapshot(cfg);
    const sessionEntry = { sessionId: scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry(scope, sessionEntry);
    const make = (key: string) =>
      createUserTurnTranscriptRecorder({
        target: { ...scope, sessionEntry, config: cfg },
        input: {
          text: `Native ${key}`,
          timestamp: 1,
          idempotencyKey: `${key}:user`,
          requesterOrigin: {
            sessionKey: scope.sessionKey,
            messageProvider: "testchat",
            conversationId: "room",
            accountId: "default",
            chatType: "direct",
          },
          transport: { channel: "testchat", conversationRef: "room", messageId: `inbound-${key}` },
        },
      });
    const a = make("A"),
      b = make("B");
    const token = mintMessageActionTurnCapability({
      ...scope,
      runId: "actual-runtime-R",
      toolContext: {
        currentSourceTurnId: "channel-user:v1:source-A",
        currentChannelProvider: "testchat",
        currentChannelId: "room",
        currentMessagingTarget: "room",
        currentMessageId: "inbound-A",
        currentChatType: "direct",
      },
    });
    try {
      await a.stageApproved!({ runId: "ingress-A", assertCurrent() {} });
      await a.persistApproved();
      advanceMessageActionPrompt({ ...scope, runId: "actual-runtime-R", recorder: a });
      await b.stageApproved!({ runId: "ingress-B", assertCurrent() {} });
      await b.persistApproved();
      advanceMessageActionPrompt({ ...scope, runId: "actual-runtime-R", recorder: b });
      const auth = resolveMessageActionTurnAuthorization({
        token,
        ...scope,
        runId: "actual-runtime-R",
      })!;
      expect(auth.currentInput?.recorder).toBe(b);
      expect(auth.toolContext?.currentMessageId).toBe("inbound-B");
      expect(auth.toolContext?.currentSourceTurnId).not.toBe("channel-user:v1:source-A");
      const params = {
        ...scope,
        cfg,
        action: "reply",
        channel: "testchat",
        actionParams: { target: "room", messageId: "inbound-B", message: "B answer" },
        currentInput: auth.currentInput,
        toolContext: auth.toolContext,
        sourceReplyFinal: true,
        toolCallId: "B-answer",
      };
      const completion = await prepareTerminalSourceInputReply(params);
      expect(completion).toMatchObject({ kind: "pending-final" });
      await settleTerminalSourceInputReply(completion, {
        ...params,
        deliveredPayload: {
          ok: true,
          messageId: "outbound-B",
          channelId: "room",
          receipt: { replyToId: "inbound-B" },
        },
      });
      const [originalA] = await readUserTurnSourceInputs(a, () => {}),
        [originalB] = await readUserTurnSourceInputs(b, () => {});
      expect(await originalA!.read!()).toBeUndefined();
      expect(originalB!.identity?.idempotencyKey).toBe("B:user");
      expect(await originalB!.read!()).toMatchObject({
        kind: "answer",
        responderRunId: "actual-runtime-R",
        platformMessageId: "outbound-B",
      });
    } finally {
      revokeMessageActionTurnCapability(token);
      for (const recorder of [a, b]) {
        recorder.finishPendingInput!("interrupted");
        await recorder.waitForPendingInputSettlement!();
      }
    }
  }));
