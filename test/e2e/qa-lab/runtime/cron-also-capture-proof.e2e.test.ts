import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
import { SKILL_LIBRARY_ALICE, SkillLibraryWireClient } from "./skill-library-wire-fixture.js";

type ModelMessage = { role?: string; content?: unknown };
type ModelRequest = {
  model: string;
  messages?: ModelMessage[];
  tools?: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }>;
};

const revision = process.env.OPENCLAW_PROOF_REVISION;
const artifactDir = process.env.OPENCLAW_PROOF_ARTIFACT_DIR;
if ((revision !== "main" && revision !== "pr") || !artifactDir) {
  throw new Error("proof revision and artifact directory are required");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof port unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

it(
  "captures real ordinary and admin-also declarations and execution authority",
  { timeout: 240_000 },
  async () => {
    const instance = await createOpenClawTestInstance({
      name: "cron-also-proof",
      port: await freePort(),
      reserveIdlePort: false,
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        NODE_ENV: undefined,
        CODEX_HOME: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENCLAW_BUILD_PRIVATE_QA: "1",
      },
    });
    const clients: SkillLibraryWireClient[] = [];
    let gateway: ChildProcess | undefined;
    const declarations = new Map<string, string>();
    const toolOutcomes = new Map<string, string>();
    const providerErrors: string[] = [];
    const providerShapes: Array<{
      roles: string[];
      userBytes: number[];
      markerInAnyMessage: boolean;
    }> = [];
    let providerRequests = 0;
    let jobId: string | undefined;
    const provider = createNativeProvider(
      async (request, response, rawBody) => {
        providerRequests++;
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(rawBody) as ModelRequest;
        const messages = body.messages ?? [];
        providerShapes.push({
          roles: messages.map((message) => message.role ?? "none"),
          userBytes: messages
            .filter((message) => message.role === "user")
            .map((message) => Buffer.byteLength(JSON.stringify(message.content ?? ""))),
          markerInAnyMessage: messages.some((message) =>
            ["CAPTURE_ORDINARY", "CAPTURE_ADMIN", "ORDINARY_EDIT", "ADMIN_EDIT"].some((candidate) =>
              JSON.stringify(message.content ?? "").includes(candidate),
            ),
          ),
        });
        const markers = ["CAPTURE_ORDINARY", "CAPTURE_ADMIN", "ORDINARY_EDIT", "ADMIN_EDIT"];
        const markedUser = messages.findLastIndex(
          (message) =>
            message.role === "user" &&
            markers.some((candidate) => JSON.stringify(message.content ?? "").includes(candidate)),
        );
        const current = JSON.stringify(messages[markedUser]?.content ?? "");
        const marker = markers.find((candidate) => current.includes(candidate));
        if (!marker) {
          throw new Error("model request had no proof marker");
        }
        const tool = body.tools?.find((entry) => entry.function?.name === "automations");
        if (!tool) {
          throw new Error("Automations declaration absent from real model request");
        }
        if (marker.startsWith("CAPTURE_")) {
          declarations.set(marker, JSON.stringify(tool));
          writeNativeCompletion(response, `proof-${marker}`, body.model, "Captured.");
          return;
        }
        const subsequent = messages.slice(markedUser + 1);
        const toolMessage = subsequent.findLast((message) => message.role === "tool");
        if (toolMessage) {
          toolOutcomes.set(marker, JSON.stringify(toolMessage.content));
          writeNativeCompletion(response, `proof-${marker}-settled`, body.model, "Edit observed.");
          return;
        }
        if (!jobId) {
          throw new Error("proof job has not been created");
        }
        writeNativeCompletion(
          response,
          `proof-${marker}-call`,
          body.model,
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `proof-${marker}-tool`,
                type: "function",
                function: {
                  name: "automations",
                  arguments: JSON.stringify({ action: "update", jobId, job: { agentId: null } }),
                },
              },
            ],
          },
          "tool_calls",
        );
      },
      (error, response) => {
        providerErrors.push(String(error).slice(0, 500));
        response.writeHead(500).end(String(error));
      },
    );
    await runQaGatewayFixture(
      async () => {
        const providerUrl = await listenNativeProvider(provider);
        const config = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
        config.gateway = {
          mode: "local",
          bind: "loopback",
          port: instance.port,
          trustedProxies: ["127.0.0.1", "::1"],
          nodes: { pairing: { autoApproveLocal: true } },
          auth: {
            mode: "trusted-proxy",
            password: instance.gatewayToken,
            identityScopes: {
              [SKILL_LIBRARY_ALICE]: ["operator.admin", "operator.read", "operator.write"],
            },
            trustedProxy: {
              userHeader: "x-forwarded-user",
              allowLoopback: true,
              requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
              allowUsers: [SKILL_LIBRARY_ALICE],
            },
          },
          controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${instance.port}`] },
        };
        const modelRef = "proof-provider/proof-model";
        config.models = {
          mode: "replace",
          providers: {
            "proof-provider": {
              baseUrl: providerUrl,
              api: "openai-completions",
              apiKey: "synthetic-proof-key",
              models: [nativeModel("proof-model", { contextWindow: 131_072 })],
            },
          },
        };
        config.agents = {
          defaults: {
            workspace: instance.state.workspaceDir,
            skipBootstrap: true,
            model: modelRef,
          },
          entries: { main: {} },
        };
        config.tools = { profile: "full", codeMode: false, toolSearch: false };
        config.plugins = { enabled: false, slots: { memory: "none" } };
        await instance.state.writeConfig(config);
        const gatewayArgs = await instance.entrypoint();
        let gatewayStderr = "";
        gateway = spawn(
          process.execPath,
          [
            ...gatewayArgs,
            "gateway",
            "--port",
            String(instance.port),
            "--bind",
            "loopback",
            "--allow-unconfigured",
          ],
          {
            cwd: process.cwd(),
            env: instance.env,
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        gateway.stderr?.on("data", (chunk: Buffer) => {
          gatewayStderr = (gatewayStderr + chunk.toString()).slice(-16_384);
        });
        let ready = false;
        for (let attempt = 0; attempt < 240; attempt++) {
          if (gateway.exitCode !== null || gateway.signalCode !== null) {
            throw new Error(`isolated Gateway exited before readiness: ${gatewayStderr}`);
          }
          try {
            const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`, {
              signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) {
              ready = true;
              break;
            }
          } catch {
            // The child has not opened its listener yet.
          }
          await sleep(500);
        }
        if (!ready) {
          throw new Error(`isolated Gateway did not become ready: ${gatewayStderr}`);
        }

        const bootstrap = await SkillLibraryWireClient.connect(instance);
        clients.push(bootstrap.client);
        const buildId = bootstrap.hello.server.buildId;
        const ordinary = await SkillLibraryWireClient.connect(instance, {
          email: SKILL_LIBRARY_ALICE,
          scopes: ["operator.read", "operator.write"],
          buildId,
        });
        const admin = await SkillLibraryWireClient.connect(instance, {
          email: SKILL_LIBRARY_ALICE,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          buildId,
        });
        clients.push(ordinary.client, admin.client);
        expect(ordinary.hello.auth?.scopes).not.toContain("operator.admin");
        expect(admin.hello.auth?.scopes).toContain("operator.admin");
        const profile = await admin.client.request<{ profile: { id: string } }>("users.self", {});
        const sessionKey = "agent:main:cron-proof";
        await admin.client.request("sessions.create", { key: sessionKey, agentId: "main" });

        async function turn(client: SkillLibraryWireClient, marker: string) {
          const started = await client.request<{ runId: string }>(
            "chat.send",
            { sessionKey, message: marker, deliver: false, idempotencyKey: `proof-${marker}` },
            30_000,
            { expectedProfileId: profile.profile.id },
          );
          const terminal = await client.request<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            65_000,
          );
          expect(
            terminal,
            JSON.stringify({
              marker,
              providerRequests,
              providerErrors,
              providerShapes: providerShapes.slice(-2),
              gatewayStderr: gatewayStderr.slice(-3000),
            }),
          ).toMatchObject({ status: "ok" });
        }
        await turn(ordinary.client, "CAPTURE_ORDINARY");
        await turn(admin.client, "CAPTURE_ADMIN");
        const ordinaryDeclaration = declarations.get("CAPTURE_ORDINARY");
        const adminDeclaration = declarations.get("CAPTURE_ADMIN");
        expect(ordinaryDeclaration).toBeTruthy();
        expect(adminDeclaration).toBeTruthy();
        await fs.mkdir(artifactDir, { recursive: true });
        await fs.writeFile(path.join(artifactDir, "ordinary.json"), ordinaryDeclaration! + "\n");
        await fs.writeFile(path.join(artifactDir, "admin-also.json"), adminDeclaration! + "\n");
        const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
        const declarationSummary = {
          revision,
          identicalBytes: ordinaryDeclaration === adminDeclaration,
          ordinarySha256: sha256(ordinaryDeclaration!),
          adminAlsoSha256: sha256(adminDeclaration!),
          ordinaryBytes: Buffer.byteLength(ordinaryDeclaration!),
          adminAlsoBytes: Buffer.byteLength(adminDeclaration!),
        };
        await fs.writeFile(
          path.join(artifactDir, "declaration-summary.json"),
          JSON.stringify(declarationSummary, null, 2) + "\n",
        );
        if (revision === "main") {
          expect(declarationSummary.identicalBytes).toBe(false);
          return;
        }
        expect(declarationSummary.identicalBytes).toBe(true);

        const created = await admin.client.request<{ id: string }>("cron.add", {
          name: "proof-job",
          agentId: "main",
          enabled: false,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "synthetic proof event" },
        });
        jobId = created.id;
        await turn(ordinary.client, "ORDINARY_EDIT");
        const ordinaryOutcome = toolOutcomes.get("ORDINARY_EDIT") ?? "";
        expect(ordinaryOutcome).toContain("agentId cannot be changed by caller scope");
        const afterOrdinary = await admin.client.request<{ agentId?: string }>("cron.get", {
          id: jobId,
        });
        expect(afterOrdinary.agentId).toBe("main");

        await turn(admin.client, "ADMIN_EDIT");
        const adminOutcome = toolOutcomes.get("ADMIN_EDIT") ?? "";
        expect(adminOutcome).not.toContain("agentId cannot be changed by caller scope");
        const afterAdmin = await admin.client.request<{ agentId?: string }>("cron.get", {
          id: jobId,
        });
        expect(afterAdmin.agentId).toBeUndefined();
        await fs.writeFile(
          path.join(artifactDir, "authority.txt"),
          "ordinary: agentId cannot be changed by caller scope\nadmin-also: agentId clear succeeded\n",
        );
      },
      async () => {
        await Promise.all(clients.map((client) => client.close()));
        if (gateway?.pid && gateway.exitCode === null && gateway.signalCode === null) {
          try {
            process.kill(-gateway.pid, "SIGTERM");
          } catch {
            /* Already exited. */
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              gateway?.once("exit", () => resolve());
            }),
            sleep(5_000),
          ]);
          if (gateway.exitCode === null && gateway.signalCode === null) {
            try {
              process.kill(-gateway.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        }
        await instance.cleanup();
        await closeNativeProvider(provider);
      },
    );
  },
);
