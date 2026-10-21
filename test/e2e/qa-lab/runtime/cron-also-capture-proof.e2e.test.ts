import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

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

it(
  "captures real ordinary and admin-also declarations and execution authority",
  { timeout: 240_000 },
  async () => {
    const instance = await createSkillLibraryWireInstance();
    const clients: SkillLibraryWireClient[] = [];
    const declarations = new Map<string, string>();
    const toolOutcomes = new Map<string, string>();
    let jobId: string | undefined;
    const provider = createNativeProvider(
      async (request, response, rawBody) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(rawBody) as ModelRequest;
        const messages = body.messages ?? [];
        const lastUser = messages.findLastIndex((message) => message.role === "user");
        const current = JSON.stringify(messages[lastUser]?.content ?? "");
        const marker = ["CAPTURE_ORDINARY", "CAPTURE_ADMIN", "ORDINARY_EDIT", "ADMIN_EDIT"].find(
          (candidate) => current.includes(candidate),
        );
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
        const subsequent = messages.slice(lastUser + 1);
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
      (error, response) => response.writeHead(500).end(String(error)),
    );
    await runQaGatewayFixture(
      async () => {
        const providerUrl = await listenNativeProvider(provider);
        const config = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
        const modelRef = "proof-provider/proof-model";
        config.models = {
          mode: "replace",
          providers: {
            "proof-provider": {
              baseUrl: providerUrl,
              api: "openai-completions",
              apiKey: "synthetic-proof-key",
              models: [nativeModel("proof-model")],
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
        await instance.startGateway();

        const ordinary = await SkillLibraryWireClient.connect(instance, {
          email: SKILL_LIBRARY_ALICE,
          scopes: ["operator.read", "operator.write"],
        });
        const admin = await SkillLibraryWireClient.connect(instance, {
          email: SKILL_LIBRARY_ALICE,
          scopes: ["operator.admin", "operator.read", "operator.write"],
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
          expect(
            await client.request("agent.wait", { runId: started.runId, timeoutMs: 60_000 }, 65_000),
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
        await instance.cleanup();
        await closeNativeProvider(provider);
      },
    );
  },
);
