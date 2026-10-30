import { afterEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import { persistAgentSessionMessage } from "../../agents/sessions/agent-session-transcript.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { jsonResult } from "../../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveMessageActionAgentRuntimeIdentity } from "../../agents/tools/gateway.js";
import { createMessageToolAsync } from "../../agents/tools/message-tool-execution.js";
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
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareTerminalSourceInputReply,
  settleTerminalSourceInputReply,
} from "./source-reply-mirror.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

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
      const cfg = {
        session: { store: scope.storePath },
        channels: { testchat: { enabled: true } },
      };
      setRuntimeConfigSnapshot(cfg);
      const sessionEntry = { sessionId: scope.sessionId, updatedAt: 1 };
      await replaceSessionEntry(scope, sessionEntry);
      const threadId = action === "thread-reply" ? "root" : undefined;
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...scope, sessionEntry, config: cfg },
        input: {
          text: "Native reply original",
          timestamp: 1,
          idempotencyKey: "source:user",
          transport: { channel: "testchat", conversationRef: "room", messageId: "inbound" },
          requesterOrigin: {
            sessionKey: scope.sessionKey,
            messageProvider: "testchat",
            conversationId: "room",
            accountId: "default",
            messageThreadId: threadId,
          },
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
        let token = mintMessageActionTurnCapability({
          ...scope,
          runId: "actual-runtime-R",
          toolContext,
        });
        const manager = await SessionManager.openAsync(scope, state.agentDir());
        const prepared = await recorder.resolveMessage();
        expect(prepared).toBeDefined();
        const before = manager.getBranch().length;
        const guarded = guardSessionManager(manager, {
          ...scope,
          runId: "actual-runtime-R",
          preparedUserTurnMessage: prepared,
          preparedUserTurnTranscriptRecorder: recorder,
          suppressNextUserMessagePersistence: true,
        });
        await persistAgentSessionMessage(
          guarded,
          { ...prepared!, content: "Rendered adopted original" },
          { invalidateSerializedPrefixCache: false },
        );
        expect(manager.getBranch()).toHaveLength(before);
        if (action === "thread-reply") {
          // A real re-entry refreshes the capability but reuses the already-durable
          // native input/manager. The guard deduplicates, rather than appending again.
          revokeMessageActionTurnCapability(token);
          token = mintMessageActionTurnCapability({
            ...scope,
            runId: "actual-runtime-R",
            toolContext,
          });
          const rebound = guardSessionManager(guarded, {
            ...scope,
            runId: "actual-runtime-R",
            preparedUserTurnMessage: prepared,
            preparedUserTurnTranscriptRecorder: recorder,
            suppressNextUserMessagePersistence: true,
          });
          await persistAgentSessionMessage(
            rebound,
            { ...prepared!, content: "Fallback re-entry of original" },
            { invalidateSerializedPrefixCache: false },
          );
          expect(manager.getBranch()).toHaveLength(before);
        }
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
        const readPending = () =>
          withSessionActor(
            scope,
            { assertCurrent, assertReadable: assertCurrent },
            async (actor) =>
              (await actor.read({ assertCurrent, authorize: assertCurrent })).entry
                ?.pendingFinalDelivery,
          );
        const physical = vi.fn(async () => {
          expect((await readPending())?.deliveries).toMatchObject([{ state: "prepared" }]);
          expect((await readPending())?.sourceRunId).toBe("actual-runtime-R");
          if (ambiguous) {
            throw new Error("lost response after platform acceptance");
          }
          return jsonResult({
            ok: true,
            messageId: "actual-outbound",
            channelId: "room",
            receipt: threadId ? { threadId } : { replyToId: "inbound" },
          });
        });
        const plugin = {
          ...createChannelTestPluginBase({
            id: "testchat",
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({ enabled: true }),
              isConfigured: () => true,
            },
          }),
          outbound: {
            deliveryMode: "direct" as const,
            sendText: async () => {
              throw new Error("Unexpected text send");
            },
          },
          messaging: { targetResolver: { looksLikeId: () => true } },
          actions: {
            describeMessageTool: () => ({ actions: [action] }),
            supportsAction: () => true,
            resolveExecutionMode: () => "local" as const,
            handleAction: physical,
          },
        };
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]),
        );
        const operation = createReplyOperation({
          ...scope,
          resetTriggered: false,
        });
        operation.setPhase("running");
        const operationalRunInstance = createOperationalRunInstanceRef("actual-runtime-R");
        const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
        try {
          await withGatewayToolCallerIdentity(
            {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              operationalRunInstance,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
            },
            async () => {
              const tool = await createMessageToolAsync({
                ...scope,
                runId: "actual-runtime-R",
                config: cfg,
                agentSessionKey: scope.sessionKey,
                runSessionKey: scope.sessionKey,
                messageActionTurnCapability: token,
                agentAccountId: "default",
                sourceReplyDeliveryMode: "message_tool_only",
              });
              const sent = tool.execute("source-call", {
                action,
                channel: "testchat",
                target: "room",
                messageId: "inbound",
                message: "answer",
                final: true,
                ...(threadId ? { threadId, channelId: "room" } : {}),
              });
              if (ambiguous) {
                await expect(sent).rejects.toThrow("lost response");
              } else {
                await sent;
              }
              expect(physical).toHaveBeenCalledOnce();
            },
          );
        } finally {
          releaseAgentRunDelegatedAuthority(authority);
          operation.complete();
        }
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
      const operationalRunInstance = createOperationalRunInstanceRef("actual-runtime-R");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      try {
        const identity = await withGatewayToolCallerIdentity(
          {
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            operationalRunInstance,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
          },
          () =>
            resolveMessageActionAgentRuntimeIdentity({
              opts: {},
              target: "local",
              runId: "actual-runtime-R",
              sessionId: scope.sessionId,
              turnCapability: token,
              sourceReplyFinal: true,
              sourceReplyToolCallId: "B-answer",
            }),
        );
        expect(identity?.messageActionContext?.toolContext?.currentMessageId).toBe("inbound-B");
        expect(identity?.messageActionContext?.toolContext?.currentSourceTurnId).toBeUndefined();
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
      }
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

it("keeps a source-less native WebChat capability usable for explicit external actions", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:webchat",
      sessionId: "webchat",
      storePath: `${state.agentDir()}/openclaw-agent.sqlite`,
    };
    const cfg = { session: { store: scope.storePath }, channels: { testchat: { enabled: true } } };
    setRuntimeConfigSnapshot(cfg);
    const sessionEntry = { sessionId: scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry(scope, sessionEntry);
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...scope, sessionEntry, config: cfg },
      input: {
        text: "WebChat original",
        timestamp: 1,
        idempotencyKey: "webchat:user",
        requesterOrigin: { sessionKey: scope.sessionKey, messageProvider: "webchat" },
      },
    });
    const operationalRunInstance = createOperationalRunInstanceRef("webchat-R");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const token = mintMessageActionTurnCapability({ ...scope, runId: "webchat-R" });
    try {
      await recorder.stageApproved!({ runId: "webchat-R", assertCurrent() {} });
      await recorder.persistApproved();
      const prepared = await recorder.resolveMessage();
      const manager = await SessionManager.openAsync(scope, state.agentDir());
      const guarded = guardSessionManager(manager, {
        ...scope,
        runId: "webchat-R",
        preparedUserTurnMessage: prepared,
        preparedUserTurnTranscriptRecorder: recorder,
        suppressNextUserMessagePersistence: true,
      });
      await persistAgentSessionMessage(
        guarded,
        { ...prepared!, content: "Rendered WebChat original" },
        { invalidateSerializedPrefixCache: false },
      );
      await withGatewayToolCallerIdentity(
        {
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          operationalRunInstance,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
        },
        async () => {
          const identity = await resolveMessageActionAgentRuntimeIdentity({
            opts: {},
            target: "local",
            runId: "webchat-R",
            sessionId: scope.sessionId,
            turnCapability: token,
            sourceReplyFinal: true,
            sourceReplyToolCallId: "external-call",
          });
          expect(identity).toBeDefined();
          expect(identity?.messageActionContext?.toolContext?.currentSourceTurnId).toBeUndefined();
          const auth = resolveMessageActionTurnAuthorization({
            token,
            ...scope,
            runId: "webchat-R",
          })!;
          expect(
            await prepareTerminalSourceInputReply({
              ...scope,
              cfg,
              action: "send",
              channel: "testchat",
              actionParams: { target: "external", message: "External answer" },
              toolContext: auth.toolContext,
              currentInput: auth.currentInput,
              sourceReplyFinal: true,
              toolCallId: "external-call",
            }),
          ).toBeUndefined();
          const sends = vi.fn(async () =>
            jsonResult({ ok: true, messageId: "external-1", channelId: "external" }),
          );
          const plugin = {
            ...createChannelTestPluginBase({
              id: "testchat",
              config: {
                listAccountIds: () => ["default"],
                resolveAccount: () => ({ enabled: true }),
                isConfigured: () => true,
              },
            }),
            outbound: {
              deliveryMode: "direct" as const,
              sendText: async () => ({ channel: "testchat", messageId: "external-1" }),
            },
            messaging: { targetResolver: { looksLikeId: () => true } },
            actions: {
              describeMessageTool: () => ({ actions: ["send" as const] }),
              supportsAction: () => true,
              resolveExecutionMode: () => "local" as const,
              handleAction: sends,
            },
          };
          setActivePluginRegistry(
            createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]),
          );
          const tool = await createMessageToolAsync({
            ...scope,
            runId: "webchat-R",
            config: cfg,
            agentSessionKey: scope.sessionKey,
            runSessionKey: scope.sessionKey,
            messageActionTurnCapability: token,
            agentAccountId: "default",
          });
          await tool.execute("external-call", {
            action: "send",
            channel: "testchat",
            target: "external",
            message: "External answer",
            final: true,
          });
          expect(sends).toHaveBeenCalledOnce();
          revokeMessageActionTurnCapability(token);
          await expect(
            resolveMessageActionAgentRuntimeIdentity({
              opts: {},
              target: "local",
              runId: "webchat-R",
              sessionId: scope.sessionId,
              turnCapability: token,
              sourceReplyFinal: true,
              sourceReplyToolCallId: "stale-call",
            }),
          ).rejects.toThrow("active turn capability");
        },
      );
      const [original] = await readUserTurnSourceInputs(recorder, () => {});
      expect(await original!.read!()).toBeUndefined();
    } finally {
      revokeMessageActionTurnCapability(token);
      releaseAgentRunDelegatedAuthority(authority);
      recorder.finishPendingInput!("interrupted");
      await recorder.waitForPendingInputSettlement!();
    }
  }));
