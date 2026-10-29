import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as transcriptPersistence from "../src/agents/sessions/agent-session-transcript.js";
import { SessionTranscriptContinuityError } from "../src/agents/sessions/transcript-turn-error.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { reserveGatewayTestListener } from "../src/gateway/test-helpers.listener.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { bindInheritedNativeProcessOwner } from "../src/process/supervisor/inherited-process-lineage.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

test("does not report an unanswered input after a native final commits before continuity refusal", async (context) => {
  const nativeOwner = process.env.CONTINUITY_PROOF_NATIVE_OWNER;
  const releaseNativeOwner = nativeOwner
    ? bindInheritedNativeProcessOwner(new URL(nativeOwner).href)
    : () => {};
  const destination =
    process.env.CONTINUITY_PROOF_OUTPUT ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-continuity-")));
  await fs.mkdir(destination, { recursive: true });
  const transport: { phase: string; request: string; response: string }[] = [];
  const phase = "native-postcommit";
  const model = await startOpenAiResponsesModelServer({
    modelId: "continuity-proof",
    bindError: "continuity fixture not listening",
    onRequest: async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const item = {
        type: "message",
        id: "msg_continuity",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "CONTINUITY-HEALTHY-OK", annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: "resp_continuity", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "CONTINUITY-HEALTHY-OK",
        },
        {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: "CONTINUITY-HEALTHY-OK",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_continuity",
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ];
      const wire =
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(wire);
    },
  });
  // Capture bytes read from the fixture's actual HTTP response, not its scripted event source.
  const captureProxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const requestPhase = phase;
      const upstream = httpRequest(
        new URL(request.url ?? "/", model.baseUrl),
        {
          method: request.method,
          headers: { ...request.headers, host: new URL(model.baseUrl).host },
        },
        (incoming) => {
          const received: Buffer[] = [];
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.on("data", (chunk) => {
            received.push(Buffer.from(chunk));
            response.write(chunk);
          });
          incoming.on("end", () => {
            if (request.method === "POST" && request.url === "/v1/responses") {
              transport.push({
                phase: requestPhase,
                request: body.toString("utf8"),
                response: Buffer.concat(received).toString("utf8"),
              });
              void fs.writeFile(
                path.join(destination, "transport.json"),
                JSON.stringify(transport, null, 2),
              );
            }
            response.end();
          });
          incoming.on("error", (error) => response.destroy(error));
        },
      );
      upstream.on("error", (error) => response.destroy(error));
      upstream.end(body);
    })().catch((error) => response.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    captureProxy.once("error", reject);
    captureProxy.listen(0, "127.0.0.1", resolve);
  });
  const proxyAddress = captureProxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw Error("Capture proxy not listening");
  const captureProxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  const native = transcriptPersistence.persistAgentSessionMessage;
  const records: Array<{
    kind: "admitted-user" | "native-final-committed";
    entryId: string | undefined;
    message?: unknown;
  }> = [];
  const spy = vi
    .spyOn(transcriptPersistence, "persistAgentSessionMessage")
    .mockImplementation(async (...args) => {
      const entryId = await native(...args);
      const message = args[1];
      if (message.role === "user") records.push({ kind: "admitted-user", entryId });
      if (
        message.role === "assistant" &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        message.stopReason !== "toolUse"
      ) {
        records.push({ kind: "native-final-committed", entryId, message });
        await fs.writeFile(
          path.join(destination, "native-committed.json"),
          JSON.stringify(records, null, 2),
        );
        throw new SessionTranscriptContinuityError(
          "projection_read_fence",
          "Session transcript changed during context read",
        );
      }
      return entryId;
    });
  const listener = await reserveGatewayTestListener();
  const token = "synthetic-native-continuity-proof";
  const state = await createOpenClawTestState({
    label: "b-native",
    scenario: "gateway-loopback",
    gateway: { port: listener.port, token },
    applyEnv: true,
  });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
  const events: Array<{ event?: string; payload?: unknown }> = [];
  const terminal = createDeferred<void>();
  let admittedRunId: string | undefined;
  const checkTerminal = () => {
    if (
      events.some((event) => {
        const payload = event.payload as { runId?: string; state?: string } | undefined;
        return (
          event.event === "chat" &&
          admittedRunId &&
          payload?.runId === admittedRunId &&
          ["final", "error", "aborted"].includes(payload.state ?? "")
        );
      })
    )
      terminal.resolve();
  };
  try {
    const config = createOpenAiResponsesModelConfig({
      baseUrl: captureProxyUrl,
      providerId: "continuity-proof",
      modelId: "continuity-proof",
      reasoning: false,
      toolProfile: "minimal",
    });
    config.agents!.defaults!.workspace = state.workspaceDir;
    config.agents!.entries = { main: { workspace: state.workspaceDir } };
    config.gateway = {
      port: listener.port,
      bind: "loopback",
      controlUi: { enabled: false },
      auth: { mode: "token", token },
    };
    config.plugins = { allow: ["openai"], slots: { memory: "none" } };
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await state.writeConfig(config);
    server = await listener.start(() =>
      startGatewayServer(listener.port, { bind: "loopback", controlUiEnabled: false }),
    );
    client = await acquireGatewayTestClient(
      {
        url: `ws://127.0.0.1:${listener.port}`,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        clientName: "test",
        clientVersion: "dev",
        mode: "test",
        role: "operator",
        deviceIdentity: loadOrCreateDeviceIdentity({ env: { OPENCLAW_STATE_DIR: state.stateDir } }),
        requestTimeoutMs: 120000,
        onEvent: (event) => {
          events.push(event);
          checkTerminal();
          void fs.writeFile(path.join(destination, "events.json"), JSON.stringify(events, null, 2));
        },
      },
      {
        timeoutMs: 30000,
        timeoutMessage: "Synthetic connect timeout",
        closeMessage: "Synthetic connect closed",
      },
    );
    const sessionKey = "agent:main:native-before-observation";
    await client.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      cwd: state.workspaceDir,
      label: "Synthetic native continuity",
    });
    const accepted = await client.request<{ runId: string }>("chat.send", {
      sessionKey,
      message: "Summarize this synthetic report.",
      idempotencyKey: "synthetic-native-before-observation",
    });
    admittedRunId = accepted.runId;
    checkTerminal();
    const settled = await client.request("agent.wait", {
      runId: accepted.runId,
      timeoutMs: 120000,
    });
    await withinTest(terminal.promise, context.signal);
    const history = await client.request("chat.history", { sessionKey, limit: 20 });
    await fs.writeFile(
      path.join(destination, "completion.json"),
      JSON.stringify({ accepted, settled, history, events, records }, null, 2),
    );
    expect(records.filter((row) => row.kind === "native-final-committed")).toHaveLength(1);
    expect(JSON.stringify(history)).toContain("CONTINUITY-HEALTHY-OK");
    const errors = events.filter((event) => {
      const payload = event.payload as
        | { state?: string; suppressErrorNotice?: boolean }
        | undefined;
      return (
        event.event === "chat" && payload?.state === "error" && payload.suppressErrorNotice !== true
      );
    });
    expect(errors).toHaveLength(0);
  } finally {
    await runQaGatewayFixture(
      async () => {},
      () => client?.stopAndWait(),
      () => server?.close({ reason: "Synthetic proof complete" }),
      () => listener.closeUnadopted(),
      () => state.cleanup(),
      () => {
        spy.mockRestore();
        releaseNativeOwner();
      },
      () =>
        fs.writeFile(path.join(destination, "transport.json"), JSON.stringify(transport, null, 2)),
      () => {
        captureProxy.closeAllConnections();
        return new Promise<void>((resolve, reject) =>
          captureProxy.close((error) => (error ? reject(error) : resolve())),
        );
      },
      () => model.close(),
      () =>
        fs.writeFile(
          path.join(destination, "cleanup.json"),
          JSON.stringify({ joined: true, port: listener.port }),
        ),
      () =>
        process.env.CONTINUITY_PROOF_OUTPUT
          ? undefined
          : fs.rm(destination, { recursive: true, force: true }),
    );
  }
}, 300000);
