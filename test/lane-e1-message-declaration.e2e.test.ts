import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { GatewayClient } from "../packages/gateway-client/src/client.js";
import { OpenClawSchema } from "../src/config/zod-schema.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

// Diagnostic-only hosted proof: actual isolated Gateway, persistent session,
// built runtime and HTTP/SSE transport. No external inference or adapter send.
const requestSchema = z
  .object({
    tools: z.array(z.object({ name: z.string().optional() }).passthrough()),
    instructions: z.string().optional(),
    input: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();
type ProviderBody = z.infer<typeof requestSchema>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prompt = (body: ProviderBody) => ({
  instructions: body.instructions ?? null,
  messages: body.input.filter((item) => item.role === "system" || item.role === "developer"),
});

test("message declarations and system prompt survive a disabled turn in one durable session", async ({
  onTestFinished,
}) => {
  const evidence = process.env.LANE_E1_PROOF_OUTPUT;
  if (!evidence) {
    throw new Error("LANE_E1_PROOF_OUTPUT must name an isolated evidence directory");
  }
  await fs.mkdir(evidence, { recursive: true });
  const requests: Array<{ raw: string; body: ProviderBody }> = [];
  const responses: Array<{ sequence: number; status: number; body: string; observation: string }> =
    [];
  const rpcCalls: unknown[] = [];
  const summary: Record<string, unknown> = { phase: "setup", verdict: "not-reached" };
  const resources: {
    client?: GatewayClient;
    instance?: OpenClawTestInstance;
    closeModel?: () => Promise<void>;
  } = {};
  onTestFinished(async () => {
    const cleanup: Record<string, unknown> = {};
    const failures: unknown[] = [];
    for (const [name, close] of [
      ["client", () => resources.client?.stopAndWait()],
      ["gateway", () => resources.instance?.cleanup()],
      ["model", () => resources.closeModel?.()],
    ] as const) {
      try {
        await close();
        cleanup[`${name}Joined`] = true;
      } catch (error) {
        failures.push(error);
        cleanup[`${name}Error`] = String(error);
      }
    }
    const redact = (text: string) =>
      [resources.instance?.gatewayToken, resources.instance?.hookToken].reduce<string>(
        (result, token) => (token ? result.replaceAll(token, "[fixture-token]") : result),
        text,
      );
    for (const [name, value] of Object.entries({
      requests,
      responses,
      rpc: rpcCalls,
      summary,
      cleanup,
    })) {
      await fs.writeFile(
        path.join(evidence, `${name}.json`),
        redact(JSON.stringify(value, null, 2)),
      );
    }
    await fs.writeFile(
      path.join(evidence, "gateway.log"),
      redact(resources.instance?.logs() ?? ""),
    );
    if (failures.length) {
      throw new AggregateError(failures, "E1 proof cleanup did not fully join");
    }
  });
  const model = await startOpenAiResponsesModelServer({
    modelId: "message-proof",
    bindError: "E1 loopback model failed to bind",
    onRequest: async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ raw, body: requestSchema.parse(JSON.parse(raw)) });
      const sequence = requests.length;
      const text = `LANE_E1_COMPLETE_${sequence}`;
      const item = {
        type: "message",
        id: `e1_message_${sequence}`,
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: `e1_response_${sequence}`, status: "in_progress", output: [] },
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
          delta: text,
        },
        {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text,
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `e1_response_${sequence}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        },
      ];
      const body =
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      const finished = once(response, "finish");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
      await finished;
      responses.push({ sequence, status: response.statusCode, body, observation: "server-finish" });
    },
  });
  resources.closeModel = model.close;
  const config = createOpenAiResponsesModelConfig({
    baseUrl: model.baseUrl,
    providerId: "message-proof",
    modelId: "message-proof",
    reasoning: false,
    toolProfile: "messaging",
  });
  const instance = await createOpenClawTestInstance({
    name: "lane-e1-message-declaration",
    startTimeoutMs: 240_000,
    config: {
      ...config,
      agents: {
        ...config.agents,
        entries: { main: {} },
        defaults: {
          ...config.agents?.defaults,
          sandbox: { mode: "off" },
          modelPolicy: { allow: ["message-proof/message-proof"] },
        },
      },
      tools: { ...config.tools, toolSearch: false, codeMode: false },
      plugins: { allow: ["openai"], slots: { memory: "none" } },
    },
    env: {
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  resources.instance = instance;
  const gateway = instance;
  summary.entrypoint = await gateway.entrypoint();
  const configured = OpenClawSchema.parse(
    JSON.parse(await fs.readFile(gateway.configPath, "utf8")),
  );
  configured.agents = {
    ...configured.agents,
    defaults: { ...configured.agents?.defaults, workspace: gateway.state.workspaceDir },
    entries: { main: { workspace: gateway.state.workspaceDir } },
  };
  await gateway.state.writeConfig(configured);
  await fs.mkdir(gateway.state.workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(gateway.state.workspaceDir, "notes.txt"),
    "E1 isolated workspace control.\n",
  );
  await gateway.startGateway();
  const connected = createDeferred();
  const connection = new GatewayClient({
    url: gateway.url,
    token: gateway.gatewayToken,
    deviceIdentity: null,
    clientName: "cli",
    mode: "cli",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    requestTimeoutMs: 120_000,
    onHelloOk: () => connected.resolve(),
    onConnectError: connected.reject,
  });
  resources.client = connection;
  connection.start();
  await connected.promise;
  const sessionKey = "agent:main:lane-e1-message-proof";
  summary.phase = "three-turn-capture";
  for (const [index, disableMessageTool] of [false, true, false].entries()) {
    const params = {
      sessionKey,
      message: `LANE_E1_TURN_${index + 1}`,
      disableMessageTool,
      deliver: false,
      idempotencyKey: randomUUID(),
    };
    const completed = await connection.request<{
      runId: string;
      status: string;
      result?: { payloads?: Array<{ text?: string }> };
    }>("agent", params, { expectFinal: true, timeoutMs: 120_000 });
    rpcCalls.push({ method: "agent", params, result: completed });
    expect(completed).toMatchObject({
      status: "ok",
      result: {
        payloads: expect.arrayContaining([
          expect.objectContaining({ text: `LANE_E1_COMPLETE_${index + 1}` }),
        ]),
      },
    });
    const waitParams = { runId: completed.runId, timeoutMs: 90_000 };
    const settled = await connection.request<{ status: string }>("agent.wait", waitParams);
    rpcCalls.push({ method: "agent.wait", params: waitParams, result: settled });
    expect(settled.status).toBe("ok");
    expect(requests).toHaveLength(index + 1);
  }
  const history = await connection.request("chat.history", { sessionKey, limit: 20 });
  rpcCalls.push({ method: "chat.history", sessionKey, result: history });
  summary.phase = "product-assertions";
  expect(requests).toHaveLength(3);
  expect(responses).toHaveLength(3);
  const first = requests[0]!.body;
  summary.catalogHashes = requests.map(({ body }) => digest(body.tools));
  summary.promptHashes = requests.map(({ body }) => digest(prompt(body)));
  expect(
    first.tools.some((tool) => tool.name === "message"),
    "normal turn offers message",
  ).toBe(true);
  expect(JSON.stringify(prompt(first)).length, "nonempty real system prompt").toBeGreaterThan(100);
  const originalUser = first.input.find(
    (item) => item.role === "user" && JSON.stringify(item).includes("LANE_E1_TURN_1"),
  );
  expect(originalUser, "initial authored user reached provider").toBeDefined();
  for (const { body } of requests.slice(1)) {
    expect(
      body.input.filter(
        (item) => item.role === "user" && JSON.stringify(item).includes("LANE_E1_TURN_1"),
      ),
    ).toEqual([originalUser]);
    expect(
      JSON.stringify(body.tools),
      "E1: disabled/resumed turn keeps provider declaration bytes",
    ).toBe(JSON.stringify(first.tools));
    expect(
      JSON.stringify(prompt(body)),
      "E1: disabled/resumed turn keeps provider system prompt bytes",
    ).toBe(JSON.stringify(prompt(first)));
  }
  summary.phase = "complete";
  summary.verdict = "contract-green";
}, 600_000);
