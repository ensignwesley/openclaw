import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import { persistAgentSessionMessage } from "../../agents/sessions/agent-session-transcript.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { SessionTranscriptContinuityError } from "../../agents/sessions/transcript-turn-error.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveMessageActionAgentRuntimeIdentity } from "../../agents/tools/gateway.js";
import { createMessageToolAsync } from "../../agents/tools/message-tool-execution.js";
import { prepareContinuityFailureNotice } from "../../auto-reply/reply/agent-runner-continuity-notice.js";
import {
  createFollowupRun,
  createRunAgentTurnParams,
} from "../../auto-reply/reply/agent-runner-execution.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionActor } from "../../config/sessions/session-actor-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { QaBusStateSnapshot } from "../../plugin-sdk/qa-channel-protocol.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { verifyAgentRuntimeIdentityToken } from "../agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../call.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import { sendHandlers } from "./send.js";
import { createAgentRuntimeGatewayClientForTests } from "./send.test-helpers.js";
import { makeContext } from "./send.test-support.js";
import type { RespondFn } from "./types.js";

const gatewayTransport = vi.hoisted(() => ({ call: vi.fn() }));
// mock-isolation: only the Gateway wire is replaced. The real producer redeems and
// signs runtime identity; the receiving real handler verifies/uses it before QA HTTP I/O.
vi.mock("../call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../call.js")>()),
  callGatewayLeastPrivilege: gatewayTransport.call,
}));
afterEach(() => {
  resetPluginRuntimeStateForTest();
  gatewayTransport.call.mockReset();
});

type QaBusState = { getSnapshot: () => QaBusStateSnapshot };

it.for([
  { mode: "producer-gateway-send", ambiguous: false },
  { mode: "producer-gateway-send", ambiguous: true },
  { mode: "producer-gateway-thread-reply", ambiguous: false },
  { mode: "producer-gateway-thread-reply", ambiguous: true },
  { mode: "gateway-send", ambiguous: false },
  { mode: "gateway-send", ambiguous: true },
  { mode: "gateway-thread-reply", ambiguous: false },
  { mode: "gateway-thread-reply", ambiguous: true },
  { mode: "producer-local-send", ambiguous: false },
  { mode: "producer-local-send", ambiguous: true },
  { mode: "producer-local-thread-reply", ambiguous: false },
  { mode: "producer-local-thread-reply", ambiguous: true },
])(
  "retains native source-tool receipt or unknown custody after actual HTTP acceptance ($mode ambiguous=$ambiguous)",
  async ({ mode, ambiguous }, test) => {
    await withOpenClawTestState({ prefix: "gateway-qa-reply-ambiguity-" }, async (state) => {
      const { qaChannelPlugin } = await loadBundledPluginFacade<{ qaChannelPlugin: ChannelPlugin }>(
        {
          pluginId: "qa-channel",
          artifactBasename: "api.js",
        },
      );
      const { createQaBusState, startQaBusServer } = await loadBundledPluginFacade<{
        createQaBusState: () => QaBusState;
        startQaBusServer: (params: { state: QaBusState }) => Promise<{
          baseUrl: string;
          stop: () => Promise<void>;
        }>;
      }>({ pluginId: "qa-lab", artifactBasename: "api.js" });
      const busState = createQaBusState();
      const bus = await startQaBusServer({ state: busState });
      const action = mode.endsWith("thread-reply") ? "thread-reply" : "send";
      const target = action === "thread-reply" ? "channel:room" : "dm:alice";
      let threadId: string | undefined;
      if (action === "thread-reply") {
        const response = await fetch(new URL("/v1/actions/thread-create", bus.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: "room",
            title: "Native source fixture",
            createdBy: "alice",
          }),
        });
        expect(response.status).toBe(200);
        threadId = ((await response.json()) as { thread: { id: string } }).thread.id;
      }
      await using resources = new AsyncDisposableStack();
      resources.defer(() => bus.stop());
      await using transport = new AsyncDisposableStack();
      const exchangesCaptured: { request: string; response: unknown; responseReturned: boolean }[] =
        [];
      const output = process.env.CONTINUITY_PROOF_OUTPUT
        ? path.join(
            process.env.CONTINUITY_PROOF_OUTPUT,
            `source-tool-${mode}-${ambiguous ? "ambiguous" : "success"}`,
          )
        : undefined;
      const evidence: Record<string, unknown> = {};
      resources.defer(async () => {
        if (output) {
          await fs.mkdir(output, { recursive: true });
          await fs.writeFile(
            path.join(output, "evidence.json"),
            JSON.stringify(
              {
                mode,
                action,
                target,
                threadId,
                ambiguous,
                evidence,
                exchangesCaptured,
                bus: busState.getSnapshot(),
              },
              null,
              2,
            ),
          );
        }
      });
      const accepted = createDeferred();
      const releaseResponse = createDeferred();
      const upstream = new AbortController();
      const exchanges: Promise<void>[] = [];
      const exchangeErrors: unknown[] = [];
      const calls: Promise<Parameters<RespondFn>>[] = [];
      let requestCount = 0;
      const text = "One accepted source reply";
      const proxy = createServer((incoming, downstream) => {
        requestCount++;
        const exchange = (async () => {
          expect(incoming).toMatchObject({ method: "POST", url: "/v1/outbound/message" });
          const requestBody = await readRequestText(incoming);
          const response = await fetch(new URL(incoming.url!, bus.baseUrl), {
            method: incoming.method,
            headers: { "content-type": "application/json" },
            body: requestBody,
            signal: upstream.signal,
          });
          const body = await response.json();
          expect(response.status).toBe(200);
          const messages = busState.getSnapshot().messages;
          expect(messages).toMatchObject([{ direction: "outbound", text }]);
          expect(body).toMatchObject({ message: { id: messages[0]!.id, text } });
          // The bus committed a business message, but the caller receives no HTTP response.
          exchangesCaptured.push({
            request: requestBody,
            response: body,
            responseReturned: !ambiguous,
          });
          accepted.resolve();
          await releaseResponse.promise;
          if (ambiguous) {
            downstream.destroy();
          } else {
            downstream.writeHead(200, { "content-type": "application/json" });
            downstream.end(JSON.stringify(body));
          }
        })().catch((error: unknown) => {
          exchangeErrors.push(error);
          accepted.reject(error);
          downstream.destroy();
        });
        exchanges.push(exchange);
      });
      transport.defer(async () => {
        releaseResponse.resolve();
        upstream.abort();
        const closing = proxy.listening ? closeHttpServer(proxy) : Promise.resolve();
        const settled = await Promise.allSettled([...calls, closing]);
        await Promise.all(exchanges);
        expect.soft(settled.at(-1)).toMatchObject({ status: "fulfilled" });
      });
      const baseUrl = await listenLoopback(proxy);
      const identity = {
        agentId: "main",
        runId: "qa-reply-run",
        sessionId: "qa-reply-session",
        sessionKey: "agent:main:qa-channel:direct:alice",
      };
      const sourceTurnId = "channel-user:v1:qa-source-turn";
      const scope = {
        ...identity,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        session: { store: scope.storePath },
        channels: {
          "qa-channel": { enabled: true, baseUrl },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "qa-channel",
            source: "test",
            plugin: mode.startsWith("producer-gateway")
              ? {
                  ...qaChannelPlugin,
                  actions: { ...qaChannelPlugin.actions, resolveExecutionMode: () => "gateway" },
                }
              : qaChannelPlugin,
          },
        ]),
      );
      await replaceSessionEntry(scope, { sessionId: identity.sessionId, updatedAt: 1 });
      const operation = createReplyOperation({ ...identity, resetTriggered: false });
      operation.setPhase("running");
      resources.defer(() => operation.complete());
      let recorder = createUserTurnTranscriptRecorder({
        target: {
          ...scope,
          sessionEntry: { sessionId: identity.sessionId, updatedAt: 1 },
          config: cfg,
        },
        input: {
          requesterOrigin: {
            sessionKey: identity.sessionKey,
            messageProvider: "qa-channel",
            conversationId: target,
            messageThreadId: threadId,
            accountId: "default",
            chatType: action === "thread-reply" ? "channel" : "direct",
          },
        },
        message: {
          role: "user",
          content: "Native source-tool original",
          timestamp: 1,
          idempotencyKey: "qa-native-original:user",
        },
      });
      await recorder.stageApproved!({ runId: identity.runId, assertCurrent() {} });
      await recorder.persistApproved();
      resources.defer(async () => {
        recorder.finishPendingInput!("interrupted");
        await recorder.waitForPendingInputSettlement!();
      });
      const operationalRunInstance = createOperationalRunInstanceRef(identity.runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      resources.defer(() => {
        releaseAgentRunDelegatedAuthority(authority);
      });
      const capability = mintMessageActionTurnCapability({
        ...identity,
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "qa-channel",
          currentChannelId: action === "thread-reply" ? "room" : "alice",
          currentMessagingTarget: target,
          currentThreadTs: threadId,
          currentChatType: action === "thread-reply" ? "channel" : "direct",
          currentSourceTurnId: sourceTurnId,
        },
      });
      resources.defer(() => {
        revokeMessageActionTurnCapability(capability);
      });
      const originalA = recorder;
      const manager = await SessionManager.openAsync(scope, state.agentDir());
      const adopt = async (input: typeof recorder, suppress: boolean) => {
        const prepared = await input.resolveMessage();
        expect(prepared).toBeDefined();
        const count = manager.getBranch().length;
        const guarded = guardSessionManager(manager, {
          ...identity,
          preparedUserTurnMessage: prepared,
          preparedUserTurnTranscriptRecorder: input,
          suppressNextUserMessagePersistence: suppress,
        });
        await persistAgentSessionMessage(
          guarded,
          { ...prepared!, content: "Rendered exact native original" },
          { invalidateSerializedPrefixCache: false },
        );
        expect(manager.getBranch()).toHaveLength(count + (suppress ? 0 : 1));
      };
      // Fresh fallback/adopted capability binds without reappending durable A.
      await adopt(recorder, true);
      if (!mode.startsWith("producer-local")) {
        recorder = createUserTurnTranscriptRecorder({
          target: {
            ...scope,
            sessionEntry: { sessionId: identity.sessionId, updatedAt: 1 },
            config: cfg,
          },
          input: {
            text: "Committed steered source B",
            timestamp: 2,
            idempotencyKey: "qa-native-B:user",
            requesterOrigin: {
              sessionKey: identity.sessionKey,
              messageProvider: "qa-channel",
              conversationId: target,
              messageThreadId: threadId,
              accountId: "default",
              chatType: action === "thread-reply" ? "channel" : "direct",
            },
            transport: { channel: "qa-channel", conversationRef: target, messageId: "inbound-B" },
          },
        });
        await recorder.stageApproved!({ runId: "qa-steering-B", assertCurrent() {} });
        // Actual native guarded append/consume, not a manual capability advance.
        await adopt(recorder, false);
        resources.defer(async () => {
          originalA.finishPendingInput!("interrupted");
          await originalA.waitForPendingInputSettlement!();
        });
      }
      const context = makeContext(() => cfg);
      context.validateAgentRuntimeApprovalAuthority =
        createAgentRuntimeApprovalAuthorityValidator();
      const handler = expectDefined(
        sendHandlers["message.action"],
        "Gateway message.action handler",
      );
      gatewayTransport.call.mockImplementation(async (options: CallGatewayOptions) => {
        expect(options.method).toBe("message.action");
        const runtimeIdentity = expectDefined(
          await verifyAgentRuntimeIdentityToken(options.agentRuntimeIdentityToken),
          "real producer signed runtime identity",
        );
        expect(runtimeIdentity.messageActionContext?.toolContext?.currentMessageId).toBe(
          "inbound-B",
        );
        expect(
          runtimeIdentity.messageActionContext?.toolContext?.currentSourceTurnId,
        ).toBeUndefined();
        const respond = vi.fn<RespondFn>();
        await handler({
          req: { type: "req", id: "producer-gateway-wire", method: "message.action" },
          params: expectDefined(asOptionalRecord(options.params), "producer message.action params"),
          context,
          client: createAgentRuntimeGatewayClientForTests(runtimeIdentity),
          isWebchatConnect: () => false,
          respond,
        });
        const response = expectDefined(respond.mock.calls[0], "actual Gateway handler response");
        if (!response[0]) {
          throw new Error(response[2]?.message ?? "Gateway handler refused");
        }
        return response[1];
      });
      const invoke = (toolCallId: string, idempotencyKey: string) => {
        const running = withGatewayToolCallerIdentity(
          {
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            operationalRunInstance,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
          },
          async () => {
            if (mode.startsWith("producer")) {
              const tool = await createMessageToolAsync({
                ...identity,
                agentSessionKey: identity.sessionKey,
                runSessionKey: identity.sessionKey,
                config: cfg,
                agentAccountId: "default",
                messageActionTurnCapability: capability,
                workspaceDir: state.workspaceDir,
                sourceReplyDeliveryMode: "message_tool_only",
              });
              try {
                const result = await tool.execute(
                  toolCallId,
                  {
                    action,
                    channel: "qa-channel",
                    target,
                    to: target,
                    message: text,
                    idempotencyKey,
                    final: true,
                    ...(threadId ? { threadId, channelId: "room" } : {}),
                  },
                  test.signal,
                );
                return [true, result.details, undefined] as Parameters<RespondFn>;
              } catch (error) {
                return [
                  false,
                  undefined,
                  { code: "LOCAL_TRANSPORT_EXCEPTION", message: String(error) },
                ] as Parameters<RespondFn>;
              }
            }
            const runtimeIdentity = expectDefined(
              await resolveMessageActionAgentRuntimeIdentity({
                opts: {},
                target: "local",
                runId: identity.runId,
                sessionId: identity.sessionId,
                turnCapability: capability,
                sourceReplyFinal: true,
                sourceReplyToolCallId: toolCallId,
              }),
              "admitted message-action runtime identity",
            );
            expect(runtimeIdentity.messageActionContext).toMatchObject({
              sessionId: identity.sessionId,
              sourceReplyFinal: true,
              sourceReplyToolCallId: toolCallId,
              toolContext: { currentChannelProvider: "qa-channel" },
            });
            expect(
              runtimeIdentity.messageActionContext?.toolContext?.currentSourceTurnId,
            ).toBeUndefined();
            if (recorder !== originalA) {
              expect(runtimeIdentity.messageActionContext?.toolContext?.currentMessageId).toBe(
                "inbound-B",
              );
            }
            const respond = vi.fn<RespondFn>();
            await handler({
              req: { type: "req", id: toolCallId, method: "message.action" },
              params: {
                channel: "qa-channel",
                action,
                params: {
                  target,
                  to: target,
                  message: text,
                  ...(threadId ? { threadId, channelId: "room" } : {}),
                },
                sessionKey: identity.sessionKey,
                sessionId: identity.sessionId,
                idempotencyKey,
              },
              context,
              client: createAgentRuntimeGatewayClientForTests(runtimeIdentity),
              isWebchatConnect: () => false,
              respond,
            });
            expect(respond).toHaveBeenCalledOnce();
            return expectDefined(respond.mock.calls[0], "Gateway message.action response");
          },
        );
        calls.push(running);
        return running;
      };
      const first = invoke("qa-call-first", "qa-request-first");
      await withinTest(
        awaitGateBeforeSettlement(
          accepted.promise,
          first,
          "Gateway action settled before QA acceptance",
        ),
        test.signal,
      );
      releaseResponse.resolve();
      const failed = await withinTest(first, test.signal);
      expect(exchangeErrors).toEqual([]);
      evidence.first = failed;
      if (ambiguous) {
        expect([failed[0], failed[2]?.code]).toEqual([
          false,
          mode.startsWith("producer") ? "LOCAL_TRANSPORT_EXCEPTION" : "UNAVAILABLE",
        ]);
      } else {
        expect(failed[0]).toBe(true);
      }
      const [original] = await readUserTurnSourceInputs(recorder, () => {});
      if (recorder !== originalA) {
        const [untouchedA] = await readUserTurnSourceInputs(originalA, () => {});
        expect(await untouchedA!.read!()).toBeUndefined();
        expect(original!.identity?.idempotencyKey).toBe("qa-native-B:user");
      }
      evidence.sourceIdentity = original!.identity;
      const receipt = await original!.read!();
      const pending = await withSessionActor(
        scope,
        { assertCurrent() {}, assertReadable() {} },
        async (actor) =>
          (await actor.read({ assertCurrent() {}, authorize() {} })).entry?.pendingFinalDelivery,
      );
      evidence.receipt = receipt ?? null;
      evidence.pending = pending ?? null;
      if (ambiguous) {
        expect(receipt).toBeUndefined();
        expect(pending?.deliveries).toMatchObject([{ state: "unknown" }]);
      } else {
        expect(receipt).toMatchObject({
          kind: "answer",
          responderRunId: identity.runId,
          platformMessageId: busState.getSnapshot().messages[0]!.id,
        });
        expect(pending).toBeUndefined();
      }

      // Deterministic typed fault AFTER actual transport acceptance; use the real original's
      // canonical policy, not the run-local tool evidence, to decide whether any notice is owed.
      const turn = {
        ...createRunAgentTurnParams(createFollowupRun({ config: cfg, agentId: identity.agentId })),
        sessionKey: identity.sessionKey,
        storePath: scope.storePath,
        replyOperation: operation,
        getActiveSessionEntry: () => ({ sessionId: identity.sessionId, updatedAt: 1 }),
      };
      let disposition;
      try {
        throw new SessionTranscriptContinuityError(
          "projection_read_fence",
          "Synthetic fault after actual source-tool transport acceptance",
        );
      } catch (error) {
        expect(error).toBeInstanceOf(SessionTranscriptContinuityError);
        disposition = await prepareContinuityFailureNotice(turn, identity.runId, recorder);
      }
      evidence.postTransportContinuity = disposition;
      expect(disposition).toMatchObject({
        disposition: ambiguous ? "delivery-unknown" : "answered",
      });
      expect(disposition?.payload).toBeUndefined();

      // Reconcile the original request; a fresh request has ordinary send semantics.
      const second = await withinTest(invoke("qa-call-first", "qa-request-first"), test.signal);
      if (mode.startsWith("producer-local")) {
        expect(second[0]).toBe(true);
        expect(second[1]).toMatchObject({ skipped: true });
      } else if (mode.startsWith("producer-gateway")) {
        expect(second[0]).toBe(!ambiguous);
      } else {
        expect(second.slice(0, 3)).toEqual(failed.slice(0, 3));
        expect(second[3]?.cached).toBe(true);
      }
      expect(requestCount).toBe(1);
      expect(busState.getSnapshot().messages).toHaveLength(1);
      expect(exchangeErrors).toEqual([]);
      const next = await withinTest(invoke("qa-call-second", "qa-request-second"), test.signal);
      evidence.freshRequest = next;
      expect(next[0]).toBe(true);
      expect(next[1]).toMatchObject({
        skipped: true,
        reason: ambiguous ? "original_input_delivery_pending" : "original_input_already_answered",
      });
      expect(requestCount).toBe(1);
      expect(busState.getSnapshot().messages).toHaveLength(1);
    });
  },
);
