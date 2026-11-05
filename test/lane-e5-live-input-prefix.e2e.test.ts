import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as pendingOwners from "../src/config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { SessionPendingInputOwner } from "../src/config/sessions/session-pending-input-owner.types.js";
import {
  listenProvider,
  writeToolCallResponse,
} from "../src/gateway/gateway-provider-fixture.test-support.js";
import { waitForGatewayDispatch } from "../src/gateway/server-in-process-dispatch.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { onAgentEvent } from "../src/infra/agent-events.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { readRequestText } from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "./helpers/promise.js";

// mock-isolation: maintenance is unrelated; real admission, steering, custody,
// transcript, tools, yield, child completion, and provider transport remain enabled.
vi.mock("../src/gateway/server-idle-task.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/gateway/server-idle-task.js")>()),
  scheduleGatewayIdleTask: () => ({ stop: vi.fn() }),
}));

type ProviderInput = {
  type?: string;
  role?: string;
  call_id?: string;
  output?: string;
  content?: string | Array<{ type: string; text?: string }>;
};
type ProviderRequest = { input: ProviderInput[]; tools: Array<{ name: string }> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const userText = (item: ProviderInput) =>
  typeof item.content === "string"
    ? item.content
    : (item.content?.map((part) => part.text ?? "").join("\n") ?? "");

it(
  "diagnoses already-submitted steering custody across real sessions_yield",
  { timeout: 90_000 },
  async ({ signal, onTestFinished }) => {
    const artifactDir = process.env.OPENCLAW_LANE_E5_PROOF_DIR;
    if (!artifactDir) {
      throw new Error("OPENCLAW_LANE_E5_PROOF_DIR must name an isolated evidence directory");
    }
    const token = "lane-e5-isolated-fixture";
    const state = await createOpenClawTestState({
      label: "lane-e5-live-prefix",
      applyEnv: false,
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const pluginsDir = state.path("bundled-plugins");
    state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = pluginsDir;
    const rootMarker = `fixture://lane-e5/root/${randomUUID()}`;
    const childMarker = `fixture://lane-e5/child/${randomUUID()}`;
    const correction = `Synthetic E5 steering correction ${randomUUID()}`;
    const steeringKey = randomUUID();
    const steeringInputKey = `${steeringKey}:user`;
    const sessionKey = `agent:main:lane-e5-${randomUUID()}`;
    const firstOpen = createDeferred();
    const steeringRegistered = createDeferred();
    const releaseFirst = createDeferred();
    const childOpen = createDeferred();
    const submittedCorrection = createDeferred<ProviderRequest>();
    const releaseYield = createDeferred();
    const yielded = createDeferred();
    const resumed = createDeferred<{ body: ProviderRequest; liveAtResume: boolean }>();
    const finished = createDeferred();
    const fixtureAbort = new AbortController();
    const handlers = new Set<Promise<void>>();
    const fixtureFailed = createDeferred<never>();
    void fixtureFailed.promise.catch(() => {});
    const fixtureErrors: Array<{ name: string; message: string; stack?: string; phase: string }> =
      [];
    const capturedRequests: Array<{
      raw: string;
      phase: string;
      url?: string;
      method?: string;
      body?: ProviderRequest;
    }> = [];
    const cleanup: Record<string, { status: string; error?: string }> = {};
    const cleanupErrors: string[] = [];
    const sourceObservations: Array<Record<string, unknown>> = [];
    const ownerRegistrations: Array<Record<string, unknown>> = [];
    let steeringSettlement: Record<string, unknown> = { status: "not-sent" };
    const foreignSamples: Array<{ stage: string; includesCorrection: boolean; keys: number }> = [];
    let correctionOwner: SessionPendingInputOwner | undefined;
    let heldChild: ServerResponse | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let providerServer: ReturnType<typeof createServer> | undefined;
    let rootRequests = 0;
    let childRequests = 0;
    let yieldIssued = false;
    let preparationStage = "before-yield";
    let rootRunId: string | undefined;
    let stopping = false;
    let steeringRequest: Promise<unknown> | undefined;
    let trace: Record<string, unknown> = { status: "setup-incomplete" };
    let evidenceWrite = Promise.resolve();
    let evidenceError: Error | undefined;
    const errorDetails = (error: unknown) =>
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "UnknownError", message: String(error) };
    const saveEvidence = () => {
      const snapshot = JSON.stringify(
        {
          ...trace,
          capturedRequests,
          fixtureErrors,
          sourceObservations,
          ownerRegistrations,
          steeringSettlement,
          foreignSamples,
          rootRequests,
          childRequests,
          yieldIssued,
          cleanup,
          cleanupErrors,
          evidenceLimit:
            "Provider HTTP request bytes captured; scripted response bytes and final chat-event payload not captured.",
        },
        null,
        2,
      );
      evidenceWrite = evidenceWrite.then(async () => {
        try {
          await fs.mkdir(artifactDir, { recursive: true });
          await fs.writeFile(path.join(artifactDir, "e5-live-input-prefix.json"), snapshot);
        } catch (error) {
          if (!evidenceError) {
            evidenceError = new Error("E5 evidence write failed", { cause: error });
            trace = { ...trace, evidenceFailure: errorDetails(error) };
            fixtureFailed.reject(evidenceError);
            console.error("LANE_E5_EVIDENCE_FAILURE", JSON.stringify(errorDetails(error)));
          }
        }
      });
      return evidenceWrite;
    };
    const checkpoint = <T>(phase: string, pending: Promise<T>): Promise<T> => {
      trace = { ...trace, phase };
      void saveEvidence();
      return withinTest(Promise.race([pending, fixtureFailed.promise]), signal);
    };
    // Persist before cleanup too: a stalled shutdown must leave its last receipt,
    // rather than erase the original fixture failure and received provider bytes.
    onTestFinished(async () => {
      trace = { ...trace, testFinished: true };
      await saveEvidence();
      expect(cleanupErrors, "all fixture cleanup joined successfully").toEqual([]);
      if (evidenceError) {
        throw evidenceError;
      }
    });

    // Observe actual registered owners without extending their lifetime or replacing
    // any custody decision. An ended source means the E5 premise was not reached.
    const register = pendingOwners.registerSessionPendingInputOwner;
    const ownerSpy = vi
      .spyOn(pendingOwners, "registerSessionPendingInputOwner")
      .mockImplementation((owner) => {
        register(owner);
        ownerRegistrations.push({
          sessionKey: owner.sessionKey,
          idempotencyKey: owner.idempotencyKey,
          inputId: owner.inputId,
          stage: preparationStage,
        });
        void saveEvidence();
        if (owner.idempotencyKey === steeringInputKey) {
          correctionOwner = owner;
          steeringRegistered.resolve();
        }
      });
    const releaseOwner = pendingOwners.releaseSessionPendingInputOwner;
    const releaseSpy = vi
      .spyOn(pendingOwners, "releaseSessionPendingInputOwner")
      .mockImplementation((owner) => {
        const correctionReleased = owner === correctionOwner;
        releaseOwner(owner);
        if (correctionReleased) {
          observeSource("real-owner-released");
          void saveEvidence();
        }
      });
    const captureReader = pendingOwners.captureForeignLiveSessionPendingInputReader;
    const readerSpy = vi
      .spyOn(pendingOwners, "captureForeignLiveSessionPendingInputReader")
      .mockImplementation(() => {
        const read = captureReader();
        return (scope) => {
          const result = read(scope);
          if (scope.sessionKey === sessionKey) {
            const owner = correctionOwner?.promotedOwner ?? correctionOwner;
            foreignSamples.push({
              stage: preparationStage,
              includesCorrection:
                owner !== undefined && result.get(owner.transcriptInputId) === owner.idempotencyKey,
              keys: result.size,
            });
          }
          return result;
        };
      });
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.stream === "lifecycle" &&
        event.runId === rootRunId &&
        event.data.yielded === true
      ) {
        yielded.resolve();
      }
    });
    const wait = (label: string, pending: Promise<void>) =>
      waitForGatewayDispatch(label, pending, 30_000, fixtureAbort.signal);
    function observeSource(stage: string) {
      const owner = expectDefined(correctionOwner, "real steering pending-input owner");
      let live = false;
      try {
        pendingOwners.assertSessionPendingInputLifetimeCurrent(owner);
        live = true;
      } catch {
        // Observation only: never reopen ended custody to manufacture the premise.
      }
      sourceObservations.push({
        stage,
        live,
        consumed: owner.consumed === true,
        settling: owner.settling === true,
        inputId: owner.inputId,
        transcriptInputId: owner.transcriptInputId,
        promoted: owner.promotedOwner !== undefined,
        databaseIdentity: digest(owner.workerDatabasePath),
      });
      return live;
    }
    function reply(response: ServerResponse, text: string) {
      writeOpenAiResponsesText(response, {
        text,
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    }
    function tool(
      response: ServerResponse,
      body: ProviderRequest,
      name: string,
      args: Record<string, unknown>,
    ) {
      expect(
        body.tools.map((entry) => entry.name),
        `real ${name} declaration`,
      ).toContain(name);
      const id = randomUUID();
      const item = {
        type: "function_call",
        id: `fc_${id}`,
        call_id: `call_${id}`,
        name,
        arguments: JSON.stringify(args),
        status: "completed",
      };
      writeToolCallResponse(response, item, randomUUID(), 64, 16);
    }
    try {
      await fs.mkdir(pluginsDir, { recursive: true });
      state.applyEnv();
      providerServer = createServer((request, response) => {
        const handler = (async () => {
          const raw = await readRequestText(request);
          const captured: (typeof capturedRequests)[number] = {
            raw,
            phase: preparationStage,
            url: request.url,
            method: request.method,
          };
          capturedRequests.push(captured);
          void saveEvidence();
          expect(request.url).toBe("/v1/responses");
          const body: ProviderRequest = JSON.parse(raw);
          captured.body = body;
          void saveEvidence();
          const userTexts = body.input.filter((item) => item.role === "user").map(userText);
          const assignment = userTexts.findLast((text) => text.includes("[Subagent Task]"));
          if (assignment?.includes(childMarker)) {
            expect(++childRequests, "one actual held child request").toBe(1);
            heldChild = response;
            childOpen.resolve();
            return;
          }
          expect(
            userTexts.some((text) => text.includes(rootMarker)),
            "root conversation routing",
          ).toBe(true);
          const step = ++rootRequests;
          if (step === 1) {
            firstOpen.resolve();
            await wait("release requester after real steering registration", releaseFirst.promise);
            tool(response, body, "sessions_spawn", {
              task: childMarker,
              label: "E5 held child",
              context: "isolated",
              expectsCompletionMessage: true,
            });
            return;
          }
          if (step === 2) {
            expect(
              userTexts.filter((text) => text.includes(correction)),
              "steering actually submitted before yield",
            ).toHaveLength(1);
            await wait("held child provider admission", childOpen.promise);
            submittedCorrection.resolve(body);
            await wait("release actual yield after custody observation", releaseYield.promise);
            yieldIssued = true;
            tool(response, body, "sessions_yield", { message: "Await E5 held child completion." });
            return;
          }
          expect(step, "one resumed provider exchange").toBe(3);
          expect(yieldIssued, "resume follows actual tool dispatch").toBe(true);
          // Observe at request receipt, before the response can settle source custody.
          const liveAtResume = observeSource("resumed-request-received");
          resumed.resolve({ body, liveAtResume });
          reply(response, "Synthetic E5 continuation complete.");
        })().catch((error: unknown) => {
          if (!stopping) {
            fixtureErrors.push({ ...errorDetails(error), phase: preparationStage });
            trace = { ...trace, status: "fixture-contract-failed" };
            fixtureFailed.reject(error);
            console.error("LANE_E5_FIXTURE_FAILURE", JSON.stringify(fixtureErrors.at(-1)));
          }
          void saveEvidence();
          if (!response.destroyed && !response.writableEnded) {
            if (!response.headersSent) {
              response.writeHead(400, { "content-type": "application/json" });
            }
            response.end(
              JSON.stringify({ error: { message: "Synthetic E5 fixture contract failed." } }),
            );
          }
        });
        handlers.add(handler);
        void handler.then(
          () => handlers.delete(handler),
          (error: unknown) => {
            handlers.delete(handler);
            fixtureFailed.reject(error);
          },
        );
      });
      const provider = buildMockOpenAiResponsesProvider(await listenProvider(providerServer));
      gateway = await startGatewayWithClient({
        configPath: state.configPath,
        token,
        cfg: {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
              subagents: { maxSpawnDepth: 1, maxConcurrent: 2 },
            },
            entries: { main: {} },
          },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            allow: ["sessions_spawn", "sessions_yield"],
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token } },
        },
        onEvent: (event) => {
          if (event.event !== "chat") {
            return;
          }
          const payload = event.payload as {
            sessionKey?: string;
            state?: string;
            yielded?: boolean;
            message?: unknown;
          };
          if (
            payload.sessionKey === sessionKey &&
            payload.state === "final" &&
            !payload.yielded &&
            payload.message &&
            yieldIssued
          ) {
            finished.resolve();
          }
        },
      });
      const started = await checkpoint(
        "root-chat-send",
        gateway.client.request<{ status: string; runId: string }>("chat.send", {
          sessionKey,
          message: rootMarker,
          deliver: false,
          idempotencyKey: randomUUID(),
        }),
      );
      expect(started.status).toBe("started");
      rootRunId = started.runId;
      await checkpoint("first-root-provider-request", firstOpen.promise);
      steeringSettlement = { status: "pending" };
      steeringRequest = gateway.client
        .request("chat.send", {
          sessionKey,
          message: correction,
          deliver: false,
          idempotencyKey: steeringKey,
          queueMode: "steer",
        })
        .then(
          (result) => {
            steeringSettlement = { status: "resolved", result };
            void saveEvidence();
            return result;
          },
          (error: unknown) => {
            steeringSettlement = { status: "rejected", error: errorDetails(error) };
            void saveEvidence();
            fixtureFailed.reject(error);
            throw error;
          },
        );
      void steeringRequest.catch(() => {});
      await checkpoint("real-steering-owner-registration", steeringRegistered.promise);
      observeSource("registered-before-first-response");
      releaseFirst.resolve();
      const before = await checkpoint(
        "submitted-correction-provider-request",
        submittedCorrection.promise,
      );
      await checkpoint("steering-chat-send-settlement", steeringRequest);
      const liveBeforeYield = observeSource("submitted-before-yield");
      releaseYield.resolve();
      await checkpoint("actual-yield-lifecycle-event", yielded.promise);
      const liveAfterYield = observeSource("yielded-before-child-completion");
      preparationStage = "after-yield";
      reply(expectDefined(heldChild, "real held child response"), "Synthetic E5 child finished.");
      const { body: after, liveAtResume } = await checkpoint(
        "resumed-provider-request",
        resumed.promise,
      );
      const correctionIndex = before.input.findIndex(
        (item) => item.role === "user" && userText(item).includes(correction),
      );
      expect(correctionIndex, "submitted correction position").toBeGreaterThanOrEqual(0);
      const prefix = JSON.stringify(before.input.slice(0, correctionIndex + 1));
      const resumedPrefix = JSON.stringify(after.input.slice(0, correctionIndex + 1));
      const preserved = prefix === resumedPrefix;
      const foreignAtResume = foreignSamples.some(
        (sample) => sample.stage === "after-yield" && sample.includesCorrection,
      );
      const qualified = liveBeforeYield && liveAfterYield && liveAtResume && foreignAtResume;
      trace = {
        status: qualified
          ? preserved
            ? "qualified-prefix-preserved"
            : "qualified-prefix-loss"
          : "premise-not-reached",
        qualified,
        preserved,
        liveBeforeYield,
        liveAfterYield,
        liveAtResume,
        foreignAtResume,
        beforePrefixSha256: digest(prefix),
        resumedPrefixSha256: digest(resumedPrefix),
        correctionIndex,
        beforeInputCount: before.input.length,
        resumedInputCount: after.input.length,
        sourceObservations,
        foreignSamples,
        rootRequests,
        childRequests,
        omittedControl:
          "not fabricated; existing attempt-session-boundary.live-input.test.ts covers never-submitted foreign input",
      };
      // Only a real still-live foreign source is a counterexample to E5. Ended
      // source custody is a drop disposition, never repaired with a synthetic hold.
      if (qualified) {
        expect(digest(resumedPrefix), "already-submitted provider prefix").toBe(digest(prefix));
      }
      await checkpoint("final-chat-event", finished.promise);
      expect(fixtureErrors).toEqual([]);
    } catch (error) {
      trace = {
        ...trace,
        status: trace.status === "setup-incomplete" ? "execution-failed" : trace.status,
        failure: errorDetails(error),
      };
      void saveEvidence();
      throw error;
    } finally {
      stopping = true;
      trace = { ...trace, cleanupJoined: false };
      void saveEvidence();
      fixtureAbort.abort();
      releaseFirst.resolve();
      releaseYield.resolve();
      providerServer?.closeAllConnections();
      const join = async (name: string, close: () => Promise<unknown>) => {
        cleanup[name] = { status: "pending" };
        void saveEvidence();
        try {
          await close();
          cleanup[name] = { status: "joined" };
        } catch (error) {
          cleanupErrors.push(`${name}: ${String(error)}`);
          cleanup[name] = { status: "failed", error: String(error) };
        }
        void saveEvidence();
      };
      if (gateway) {
        const activeGateway = gateway;
        await join("gateway-client", () => disconnectGatewayClient(activeGateway.client));
        await join("gateway-server", () => activeGateway.server.close());
      }
      if (providerServer?.listening) {
        const server = providerServer;
        await join(
          "provider-server",
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        );
      }
      await join("provider-handlers", () => Promise.allSettled(handlers));
      await join("steering-request", () =>
        Promise.allSettled(steeringRequest ? [steeringRequest] : []),
      );
      unsubscribe();
      ownerSpy.mockRestore();
      releaseSpy.mockRestore();
      readerSpy.mockRestore();
      await join("test-state", () => state.cleanup());
      trace = { ...trace, cleanupJoined: cleanupErrors.length === 0 };
      await saveEvidence();
      console.info(`LANE_E5_DIAGNOSTIC ${JSON.stringify(trace)}`);
    }
  },
);
