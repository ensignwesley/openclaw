import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { captureAnthropicExchange, registerParityHostLifecycle } from "../../../packages/ai/src/provider-transport-parity.test-support.js";
import { prepareEmbeddedSkills } from "../../agents/embedded-agent-runner/skill-runtime.js";
import { buildAttemptSystemPrompt } from "../../agents/embedded-agent-runner/run/attempt-system-prompt.js";
import { createReadTool } from "../../agents/sessions/tools/read.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { parseSkillsPromptCatalog } from "../loading/skill-prompt-catalog.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { createRemoteExecPlacementSandbox } from "../../gateway/worker-environments/placement-sandbox.js";
import { createLauncher, runIdentity } from "../../gateway/worker-environments/worker-turn-launcher-flow.test-support.js";
import * as fx from "../../gateway/worker-environments/worker-turn-launcher.test-support.js";

// Synthetic discovery fact only; lifecycle, transfer and prompt owners remain real.
vi.mock("../../gateway/github-publication-discovery.js", () => ({ readGitHubPublicationFact: () => ({ available: false }) }));
registerParityHostLifecycle();
afterAll(closeStateDatabaseForTest);
it("renders the transferred catalog through the real remote-exec caller and embedded reader", async () => {
  await fx.setupWorkerTurnLauncherTest();
  try {
    const host = path.join(fx.root, "host-skills");
    const remote = path.join(await fs.realpath(fx.root), "remote");
    await fs.mkdir(remote, { recursive: true });
    const source = path.join(host, "skills", "delivered", "SKILL.md");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "---\nname: delivered\ndescription: Transfer fixture\n---\nRead me.\n");
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(fx.root, "empty-skills"));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(fx.root, "empty-plugins"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected fetch outside synthetic transport"); }));
    const input = fx.turn("run-projection-transfer");
    input.model = "gpt-6.1-sol";
    Object.assign(input.config, { plugins: { enabled: false } });
    input.config.agents.defaults.models = { "openai/gpt-6.1-sol": { agentRuntime: { id: "openclaw" } } };
    const snapshot = await buildSkillSnapshot(host, { config: input.config, entries: loadWorkspaceSkills(host, { workspaceOnly: true, config: input.config }) });
    expect(snapshot.resolvedSkills?.map((s) => s.name)).toEqual(["delivered"]);
    expect(snapshot.catalogPrompt).toContain(host);
    await fx.seedActivePlacement("remote-exec", remote);
    let workspaceCommands = 0;
    const tunnel = fx.createWorkerTurnTunnel({
      launchTurn: vi.fn(async () => { throw new Error("Unexpected native worker launch"); }),
      runWorkspaceCommand: async (command) => {
        workspaceCommands++;
        return runCommandWithTimeout([...command.argv], { cwd: remote, input: command.input, timeoutMs: 10000, signal: command.signal });
      },
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(fx.reconcileUnchangedLocalWorkspace),
    });
    const environments = { ...fx.unusedEnvironments(), get: vi.fn(() => ({ ...fx.attachedEnvironment(), providerId: "device", nodeDeviceId: "synthetic-proof-node", sshEndpoint: null })), startTunnel: vi.fn(async () => tunnel) };
    const launcher = createLauncher({ environments });
    await launcher.executeTurn(runIdentity(input.runId), { ...input, skillsSnapshot: snapshot, timeoutMs: 30000 }, async () => {
      const placement = fx.placements.get(fx.SESSION_ID);
      if (placement?.state !== "active") throw new Error("Expected real active placement");
      const sandbox = await createRemoteExecPlacementSandbox({ config: input.config, environments, workspaceDir: host, placement });
      const prepared = await prepareEmbeddedSkills({ separateRemoteNote: true, applySkillEnvironment: false, includeCodeModeSkills: true,
        attempt: { config: input.config, skillsSnapshot: snapshot }, effectiveWorkspace: remote, sandbox, sessionAgentId: "main" });
      const delivered = prepared.skillsSnapshotForRun?.resolvedSkills?.find((s) => s.name === "delivered");
      expect(delivered?.filePath).not.toBe(source);
      expect(delivered?.filePath.startsWith(remote)).toBe(true);
      expect(workspaceCommands).toBeGreaterThan(0);
      const read = createReadTool(remote);
      const rendered = await buildAttemptSystemPrompt({ isRawModelRun: false, transformSystemPrompt: (s) => s,
        embeddedSystemPrompt: { config: input.config, workspaceDir: remote, skillsPrompt: prepared.skillsPrompt, toolNames: ["read"], runtimeInfo: { agentId: "main", host: "synthetic-remote-exec", model: "fixture/model" } } });
      const exchange = await captureAnthropicExchange("transport", { context: { systemPrompt: rendered.systemPrompt,
        messages: [{ role: "user", content: "Use the delivered skill.", timestamp: 1 }], tools: [{ name: read.name, description: read.description, parameters: read.parameters }] } });
      expect(exchange.requests).toHaveLength(1);
      expect(exchange.terminal.stopReason).not.toBe("error");
      const payload = exchange.requests[0]!.payload;
      const system = (payload.system as Array<{ text: string }>).map((b) => b.text).join("\n");
      const catalog = parseSkillsPromptCatalog(system);
      const output = process.env.ROW_A_RECEIPTS_DIR;
      if (output) {
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, "worker-request.parsed.json"), JSON.stringify(payload, null, 2));
        await fs.writeFile(path.join(output, "worker-observation.json"), JSON.stringify({ catalog, deliveredPath: delivered?.filePath, source, workspaceCommands, sandboxBackend: sandbox.backendId, mounts: sandbox.readOnlyResourceMounts }, null, 2));
        await fs.writeFile(path.join(output, "worker-completion.json"), JSON.stringify(exchange.terminal, null, 2));
      }
      expect(catalog).toEqual([{ name: "delivered", location: delivered!.filePath }]);
      return { meta: { durationMs: 1 } };
    });
  } finally {
    await fx.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
}, 90000);
