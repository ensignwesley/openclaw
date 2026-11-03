import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
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

// Diagnostic-only hosted proof. No live provider, production state, or image-path
// suppression: ordinary human input crosses the real Gateway and durable store.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
type ProviderBlock = { type: string; text?: string; image_url?: string };
type ProviderItem = { role?: string; content?: ProviderBlock[] };
type ProviderBody = { input: ProviderItem[] };
const imageBlocks = (item: ProviderItem) =>
  item.content?.filter((block) => block.type === "input_image") ?? [];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("human path images survive a cold replay without losing attachment or filesystem policy", async ({
  onTestFinished,
}) => {
  const evidence = process.env.ROW16_PROOF_OUTPUT;
  if (!evidence) {
    throw new Error("ROW16_PROOF_OUTPUT must name an isolated evidence directory");
  }
  await fs.mkdir(evidence, { recursive: true });
  const requests: Array<{ raw: string; body: ProviderBody }> = [];
  const responses: Array<{ status: number; body: string; observation: string }> = [];
  const rpcCalls: unknown[] = [];
  const summary: Record<string, unknown> = { phase: "setup", verdict: "not-reached" };
  let client: GatewayClient | undefined;
  let instance: OpenClawTestInstance | undefined;
  let closeModel: (() => Promise<void>) | undefined;
  onTestFinished(async () => {
    const cleanup: Record<string, unknown> = {};
    const failures: unknown[] = [];
    try {
      await client?.stopAndWait();
      cleanup.clientJoined = true;
    } catch (error) {
      failures.push(error);
      cleanup.clientError = String(error);
    }
    try {
      await instance?.cleanup();
      cleanup.gatewayJoined = true;
    } catch (error) {
      failures.push(error);
      cleanup.gatewayError = String(error);
    }
    try {
      await closeModel?.();
      cleanup.modelJoined = true;
    } catch (error) {
      failures.push(error);
      cleanup.modelError = String(error);
    }
    const redact = (text: string) =>
      [instance?.gatewayToken, instance?.hookToken].reduce(
        (result, token) => (token ? result.replaceAll(token, "[fixture-token]") : result),
        text,
      );
    await Promise.all([
      fs.writeFile(path.join(evidence, "requests.json"), JSON.stringify(requests, null, 2)),
      fs.writeFile(path.join(evidence, "responses.json"), JSON.stringify(responses, null, 2)),
      fs.writeFile(path.join(evidence, "rpc.json"), JSON.stringify(rpcCalls, null, 2)),
      fs.writeFile(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2)),
      fs.writeFile(path.join(evidence, "cleanup.json"), redact(JSON.stringify(cleanup, null, 2))),
      fs.writeFile(path.join(evidence, "gateway.log"), redact(instance?.logs() ?? "")),
    ]);
    if (failures.length) {
      throw new AggregateError(failures, "row16 proof cleanup did not fully join");
    }
  });
  const model = await startOpenAiResponsesModelServer({
    modelId: "image-proof",
    bindError: "row16 loopback model failed to bind",
    onRequest: async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ raw, body: JSON.parse(raw) as ProviderBody });
      const sequence = requests.length;
      const text = `ROW16_COMPLETE_${sequence}`;
      const item = {
        type: "message",
        id: `row16_msg_${sequence}`,
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: `row16_${sequence}`, status: "in_progress", output: [] },
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
            id: `row16_${sequence}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        },
      ];
      const body =
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      // Server-side emission evidence, not a client-received HTTP capture.
      const finished = once(response, "finish");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
      await finished;
      responses.push({ status: response.statusCode, body, observation: "server-finish" });
    },
  });
  closeModel = model.close;
  const config = createOpenAiResponsesModelConfig({
    baseUrl: model.baseUrl,
    providerId: "image-proof",
    modelId: "image-proof",
    reasoning: false,
    toolProfile: "minimal",
  });
  config.models!.providers!["image-proof"]!.models[0]!.input = ["text", "image"];
  instance = await createOpenClawTestInstance({
    name: "lane-d-row16-human-image-replay",
    startTimeoutMs: 240_000,
    config: {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          sandbox: { mode: "off" },
          modelPolicy: { allow: ["image-proof/image-proof"] },
        },
      },
      tools: { ...config.tools, fs: { workspaceOnly: true } },
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
  const gateway = instance;
  // Reuse the helper's stamped built entrypoint; do not start a source compiler
  // or change runtime ownership while the two Gateway processes consume it.
  summary.entrypoint = await gateway.entrypoint();
  const configured = JSON.parse(await fs.readFile(gateway.configPath, "utf8"));
  configured.agents ??= {};
  configured.agents.defaults ??= {};
  configured.agents.defaults.workspace = gateway.state.workspaceDir;
  configured.agents.entries = { main: { workspace: gateway.state.workspaceDir } };
  await gateway.state.writeConfig(OpenClawSchema.parse(configured));
  const authoredPath = path.join(gateway.state.workspaceDir, "diagram.png");
  const outsidePath = path.join(gateway.homeDir, "outside-row16.png");
  await fs.mkdir(gateway.state.workspaceDir, { recursive: true });
  // Keep the workspace attested when the image is removed later; deleting the
  // sole content file would exercise WORKSPACE_VANISHED, not image durability.
  await fs.writeFile(
    path.join(gateway.state.workspaceDir, "notes.txt"),
    "Row16 workspace control.\n",
  );
  await fs.writeFile(authoredPath, Buffer.from(PNG, "base64"));
  await fs.writeFile(outsidePath, Buffer.from(PNG, "base64"));
  const connect = async () => {
    await gateway.startGateway();
    await new Promise<void>((resolve, reject) => {
      client = new GatewayClient({
        url: gateway.url,
        token: gateway.gatewayToken,
        deviceIdentity: null,
        clientName: "cli",
        mode: "cli",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        requestTimeoutMs: 120_000,
        onHelloOk: () => resolve(),
        onConnectError: reject,
      });
      client.start();
    });
  };
  const rpc = async <T>(method: string, params: unknown) => {
    const result = await client!.request<T>(method, params);
    rpcCalls.push({ method, params, result });
    return result;
  };
  const turn = async (sessionKey: string, message: string, extra: Record<string, unknown> = {}) => {
    const before = requests.length;
    const completed = await client!.request<{
      runId: string;
      status: string;
      result?: { payloads?: Array<{ text?: string }> };
    }>(
      "agent",
      {
        sessionKey,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
        ...extra,
      },
      { expectFinal: true, timeoutMs: 120_000 },
    );
    rpcCalls.push({ method: "agent", sessionKey, message, extra, result: completed });
    expect(completed).toMatchObject({
      status: "ok",
      result: {
        payloads: expect.arrayContaining([
          expect.objectContaining({ text: `ROW16_COMPLETE_${before + 1}` }),
        ]),
      },
    });
    const done = await rpc<{ status: string }>("agent.wait", {
      runId: completed.runId,
      timeoutMs: 90_000,
    });
    expect(done.status).toBe("ok");
    expect(requests.length - before, "one completed provider call per turn").toBe(1);
    return requests[before]!.body;
  };
  const authored = (body: ProviderBody, text: string) => {
    const found = body.input.filter(
      (item) =>
        item.role === "user" &&
        item.content?.some((block) => block.type === "input_text" && block.text?.includes(text)),
    );
    expect(found, `exact authored provider item: ${text}`).toHaveLength(1);
    return found[0]!;
  };
  const humanSession = "agent:main:row16-human";
  const attachmentSession = "agent:main:row16-explicit";
  const humanText = "ROW16_HUMAN: Review ./diagram.png";
  const attachmentText = "ROW16_EXPLICIT: Inspect this attached PNG.";
  const deniedText = `ROW16_DENIED: Review ${outsidePath}`;
  await connect();
  summary.initialPid = gateway.child?.pid;
  summary.phase = "initial-capture";
  const initial = authored(await turn(humanSession, humanText), humanText);
  const explicit = authored(
    await turn(attachmentSession, attachmentText, {
      attachments: [
        { type: "image", mimeType: "image/png", fileName: "explicit.png", content: PNG },
      ],
    }),
    attachmentText,
  );
  const denied = authored(await turn("agent:main:row16-denied", deniedText), deniedText);
  summary.historyBefore = await rpc("chat.history", { sessionKey: humanSession, limit: 10 });
  await client!.stopAndWait();
  client = undefined;
  await gateway.stopGateway();
  summary.phase = "cold-reopen";
  await connect();
  summary.reopenedPid = gateway.child?.pid;
  expect(summary.initialPid).toBeTypeOf("number");
  expect(summary.reopenedPid).toBeTypeOf("number");
  expect(summary.reopenedPid).not.toBe(summary.initialPid);
  // The primary RED uses the unchanged, still-readable original file. It must
  // not be confused with a missing-source or changed-policy failure.
  summary.sourcePresentOnColdReplay = (await fs.readFile(authoredPath)).toString("base64") === PNG;
  const replay = authored(
    await turn(humanSession, "ROW16_FOLLOWUP: Continue without new attachments."),
    humanText,
  );
  const explicitReplay = authored(
    await turn(attachmentSession, "ROW16_EXPLICIT_FOLLOWUP: Continue."),
    attachmentText,
  );
  Object.assign(summary, {
    phase: "primary-product-assertions",
    initial,
    replay,
    explicit,
    explicitReplay,
    denied,
    initialImages: imageBlocks(initial).length,
    replayImages: imageBlocks(replay).length,
    initialSha256: digest(initial),
    replaySha256: digest(replay),
    explicitSha256: digest(explicit),
    explicitReplaySha256: digest(explicitReplay),
  });
  // Positive and denial controls must pass before interpreting the intended RED.
  expect(requests).toHaveLength(5);
  expect(responses).toHaveLength(5);
  expect(summary.sourcePresentOnColdReplay).toBe(true);
  expect(imageBlocks(initial)).toHaveLength(1);
  expect(imageBlocks(explicit)).toHaveLength(1);
  expect(imageBlocks(explicitReplay)).toHaveLength(1);
  expect(imageBlocks(explicitReplay)).toEqual(imageBlocks(explicit));
  expect(imageBlocks(denied), "workspace-only policy denies a real outside PNG").toHaveLength(0);
  summary.controls = "passed";
  summary.primaryVerdict =
    imageBlocks(replay).length === 1 && digest(initial) === digest(replay)
      ? "contract-green"
      : "contract-red";
  // Persist the reached primary checkpoint before a distinct source-deletion
  // scenario. A later setup/control failure cannot erase this narrower result.
  await fs.writeFile(
    path.join(evidence, "primary-checkpoint.json"),
    JSON.stringify(summary, null, 2),
  );
  expect(
    imageBlocks(replay),
    "ROW16: cold replay must retain the admitted human image",
  ).toHaveLength(1);
  expect(replay, "ROW16: previously sent authored provider item stays byte-identical").toEqual(
    initial,
  );
  // A repaired admission must retain already-sent bytes after the reference
  // disappears, rather than rediscovering mutable history paths.
  summary.phase = "source-deletion";
  await fs.unlink(authoredPath);
  summary.originalPathDeleted = true;
  const replayAfterDelete = authored(
    await turn(humanSession, "ROW16_AFTER_DELETE: Continue without new attachments."),
    humanText,
  );
  summary.historyAfter = await rpc("chat.history", { sessionKey: humanSession, limit: 10 });
  summary.replayAfterDelete = replayAfterDelete;
  summary.replayAfterDeleteSha256 = digest(replayAfterDelete);
  expect(requests).toHaveLength(6);
  expect(responses).toHaveLength(6);
  expect(
    imageBlocks(replayAfterDelete),
    "ROW16: admitted bytes survive original path deletion",
  ).toEqual(imageBlocks(initial));
  summary.phase = "complete";
  summary.verdict = "contract-green";
}, 600_000);
