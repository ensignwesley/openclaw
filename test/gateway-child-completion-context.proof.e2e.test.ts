// Real shipped Gateway + real sessions_spawn, fixed external provider I/O.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  extractCurrentRuntimeContextTexts,
  isInternalRuntimeContextCarrierText,
} from "../extensions/qa-lab/api.js";
import { loadSubagentRegistryFromSqlite } from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { writeRestartToolCalls } from "./gateway-restart.test-support.js";
import {
  closeHttpServer,
  connectProofClient,
  listenLoopback,
  readRequestText,
} from "./helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const SESSION = "agent:main:child-completion-context-proof";
const TASK = "Return the synthetic completion proof report.";
const MARKER = "CHILD_COMPLETION_PROVIDER_UNIQUE_614f92";
const RESULT = `${MARKER}\n${"Synthetic report content for provider request accounting. ".repeat(26)}`;
type Item = {
  role?: string;
  type?: string;
  name?: string;
  call_id?: string;
  content?: unknown;
  output?: unknown;
};
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}
const count = (value: string) => value.split(MARKER).length - 1;

it(
  "includes a child result once on its exact direct completion turn, retaining pending status",
  { timeout: 180_000 },
  async ({ signal }) => {
    const artifactDir = process.env.CHILD_COMPLETION_PROOF_ARTIFACT_DIR;
    if (!artifactDir)
      throw new Error("Set CHILD_COMPLETION_PROOF_ARTIFACT_DIR to retain raw proof artifacts");
    const artifactRoot = path.resolve(artifactDir);
    await fs.mkdir(artifactRoot, { recursive: true });
    const releaseChild = createDeferred();
    const failures: string[] = [];
    const requests: Array<{
      raw: string;
      input: Item[];
      contexts: string[];
      kind?: string;
      wire: string;
    }> = [];
    let accepted: { runId: string; childSessionKey: string } | undefined;
    let completion: (typeof requests)[number] | undefined;
    let control: (typeof requests)[number] | undefined;
    let sequence = 0;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const raw = await readRequestText(request);
        const body = JSON.parse(raw) as { input?: Item[] };
        const input = body.input ?? [];
        const contexts = extractCurrentRuntimeContextTexts(input);
        const row = { raw, input, contexts, kind: "unclassified", wire: "" };
        requests.push(row);
        // Capture actual SSE writer output, retaining the original ServerResponse owner.
        const write = response.write.bind(response);
        response.write = ((...args: Parameters<typeof response.write>) => {
          row.wire += typeof args[0] === "string" ? args[0] : Buffer.from(args[0]).toString("utf8");
          return write(...args);
        }) as typeof response.write;
        const end = response.end.bind(response);
        response.end = ((...args: Parameters<typeof response.end>) => {
          const chunk: unknown = args[0];
          if (typeof chunk === "string") row.wire += chunk;
          else if (chunk instanceof Uint8Array) row.wire += Buffer.from(chunk).toString("utf8");
          return end(...args);
        }) as typeof response.end;
        const latestUser = input
          .toReversed()
          .find(
            (item) =>
              item.role === "user" && !isInternalRuntimeContextCarrierText(text(item.content)),
          );
        const current = text(latestUser?.content);
        const last = input.at(-1);
        const id = String(++sequence);
        const final = (value: string) =>
          writeOpenAiResponsesText(response, {
            text: value,
            messageId: `msg_${id}`,
            responseId: `resp_${id}`,
          });
        if (current.includes("[Subagent Task]") && current.includes(TASK)) {
          row.kind = "child";
          await releaseChild.promise;
          final(RESULT);
        } else if (current.includes("SETTLED_CONTROL_TURN")) {
          row.kind = "settled-control";
          control = row;
          final("CONTROL_OK");
        } else if (last?.type === "function_call_output") {
          const call = input.findLast(
            (item) => item.type === "function_call" && item.call_id === last.call_id,
          );
          if (call?.name !== "sessions_spawn")
            throw new Error(`Unexpected tool result: ${JSON.stringify(last)}`);
          const result: unknown =
            typeof last.output === "string" ? JSON.parse(last.output) : last.output;
          if (
            typeof result !== "object" ||
            result === null ||
            !("status" in result) ||
            result.status !== "accepted" ||
            !("runId" in result) ||
            typeof result.runId !== "string" ||
            !("childSessionKey" in result) ||
            typeof result.childSessionKey !== "string"
          )
            throw new Error(`sessions_spawn not accepted: ${JSON.stringify(result)}`);
          accepted = { runId: result.runId, childSessionKey: result.childSessionKey };
          row.kind = "spawn-result";
          final("Child started.");
        } else if (
          contexts.some(
            (context) =>
              context.includes("[Internal task completion event]") && context.includes(MARKER),
          )
        ) {
          row.kind = "direct-completion";
          if (completion) throw new Error("Unexpected second completion request");
          completion = row;
          final("COMPLETION_OK");
        } else if (current.includes("START_CHILD_COMPLETION_PROOF")) {
          row.kind = "kickoff";
          writeRestartToolCalls(
            response,
            `resp_${id}`,
            [
              {
                type: "function_call",
                id: `fc_${id}`,
                call_id: `spawn_${id}`,
                name: "sessions_spawn",
                arguments: JSON.stringify({
                  task: TASK,
                  runtime: "subagent",
                  mode: "run",
                  cleanup: "keep",
                  completionTarget: "parent",
                }),
                status: "completed",
              },
            ],
            { argumentEvent: "done" },
          );
        } else
          throw new Error(`Unexpected provider turn: ${JSON.stringify({ current, contexts })}`);
      })().catch((error: unknown) => {
        failures.push(String(error));
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: String(error) } }));
      });
    });
    const url = await listenLoopback(server);
    const config = createOpenAiResponsesModelConfig({
      baseUrl: url,
      providerId: "child-completion-proof",
      modelId: "gpt-6.1-sol",
      reasoning: false,
      toolProfile: "coding",
    });
    config.plugins = { enabled: false };
    config.tools = {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      allow: ["sessions_spawn"],
    };
    const instance = await createOpenClawTestInstance({
      name: "gateway-child-completion-context-proof",
      config,
      signal,
      entrypoint: ["openclaw.mjs"],
      env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
    }).catch(async (error: unknown) => {
      await closeHttpServer(server);
      throw error;
    });
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    try {
      instance.state.applyEnv();
      await instance.startGateway();
      client = await connectProofClient(instance, {
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        signal,
      });
      expect(
        await client.request(
          "agent",
          {
            sessionKey: SESSION,
            message: "START_CHILD_COMPLETION_PROOF",
            deliver: false,
            idempotencyKey: "child-completion-proof-start",
          },
          { expectFinal: true, timeoutMs: 60_000 },
        ),
      ).toMatchObject({ status: "ok" });
      expect(accepted).toBeDefined();
      // Only now is the parent idle; no steer or sessions_yield settle-wake path.
      releaseChild.resolve(undefined);
      await vi.waitFor(() => expect(completion).toBeDefined(), { timeout: 45_000 });
      await vi.waitFor(
        () => {
          const entry = loadSubagentRegistryFromSqlite().get(accepted!.runId);
          expect(entry?.delivery?.status).toBe("delivered");
          expect(entry?.requesterSettleWake).toBeUndefined();
        },
        { timeout: 45_000 },
      );
      expect(
        await client.request(
          "agent",
          {
            sessionKey: SESSION,
            message: "SETTLED_CONTROL_TURN",
            deliver: false,
            idempotencyKey: "child-completion-proof-control",
          },
          { expectFinal: true, timeoutMs: 30_000 },
        ),
      ).toMatchObject({ status: "ok" });
      const contexts = completion!.contexts;
      const event = contexts.filter((context) =>
        context.includes("[Internal task completion event]"),
      );
      const pending = contexts.filter((context) =>
        context.includes("## Child results awaiting delivery"),
      );
      await fs.writeFile(
        path.join(artifactRoot, "observation.json"),
        JSON.stringify(
          {
            accepted,
            event,
            pending,
            completionMarkerCount: count(contexts.join("\n")),
            settledContexts: control?.contexts,
            registry: loadSubagentRegistryFromSqlite().get(accepted!.runId),
            failures,
          },
          null,
          2,
        ),
      );
      expect(failures).toEqual([]);
      expect(event).toHaveLength(1);
      expect(event[0]).toContain(`session_key: ${accepted!.childSessionKey}`);
      expect(count(event.join("\n"))).toBe(1);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain(`run_json=${JSON.stringify(accepted!.runId)}`);
      expect(pending[0]).toMatch(/delivery=(?:pending|in_progress)/u);
      expect(control).toBeDefined();
      expect(control!.contexts.join("\n")).not.toContain("## Child results awaiting delivery");
      // Frozen invariant: baseline fails here on 2; repair must preserve all gates above.
      expect(count(contexts.join("\n"))).toBe(1);
      expect(count(pending.join("\n"))).toBe(0);
    } finally {
      releaseChild.resolve(undefined);
      // Artifact storage is fallible; start every teardown owner regardless of it.
      const capture = await Promise.allSettled([
        fs.writeFile(path.join(artifactRoot, "requests.json"), JSON.stringify(requests, null, 2)),
        fs.writeFile(path.join(artifactRoot, "gateway.log"), instance.logs()),
      ]);
      const cleanup = await Promise.allSettled([
        client ? disconnectGatewayClient(client) : Promise.resolve(),
        instance.cleanup(),
        closeHttpServer(server),
        Promise.resolve().then(() => closeOpenClawStateDatabaseForTest()),
      ]);
      const cleanupCapture = await Promise.allSettled([
        fs.writeFile(
          path.join(artifactRoot, "cleanup.json"),
          JSON.stringify(
            cleanup.map((result) =>
              result.status === "fulfilled"
                ? { status: result.status }
                : { status: result.status, error: String(result.reason) },
            ),
            null,
            2,
          ),
        ),
      ]);
      const errors = [...capture, ...cleanup, ...cleanupCapture].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Proof artifact capture or cleanup failed");
    }
  },
);
