import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  captureAnthropicExchange,
  registerParityHostLifecycle,
} from "../../../packages/ai/src/provider-transport-parity.test-support.js";
import { prepareEmbeddedAttemptPromptContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-build.js";
import { buildAttemptSystemPrompt } from "../../agents/embedded-agent-runner/run/attempt-system-prompt.js";
import { prepareEmbeddedSkills } from "../../agents/embedded-agent-runner/skill-runtime.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { createReadTool } from "../../agents/sessions/tools/read.js";
import { createAgentToolsSandboxContext } from "../../agents/test-helpers/agent-tools-sandbox-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseSkillsPromptCatalog } from "../../skills/loading/skill-prompt-catalog.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../../skills/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { recordRemoteNodeInfo, removeRemoteNodeInfo, setSkillsRemoteRegistry } from "./remote.js";
import { testRemoteSession, setTestSkillsRemoteRegistry } from "./remote.test-helpers.js";

registerParityHostLifecycle();

it.each([false, true])(
  "preserves legacy v8 sandbox shape and availability through the real caller: connected=$s",
  async (connected) => {
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const host = path.join(state.root, "host-skills");
        const materialized = path.join(state.root, "materialized-sandbox");
        vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(state.root, "empty-skills"));
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(state.root, "empty-plugins"));
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("Unexpected fetch outside synthetic transport");
          }),
        );
        for (const name of ["delivered", "withheld"]) {
          const dir = path.join(host, "skills", name);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            path.join(dir, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name} fixture\n---\n${name} instructions.\n`,
          );
        }
        const deliveredFile = path.join(materialized, "skills", "delivered", "SKILL.md");
        await fs.mkdir(path.dirname(deliveredFile), { recursive: true });
        await fs.copyFile(path.join(host, "skills", "delivered", "SKILL.md"), deliveredFile);
        const config: OpenClawConfig = {
          agents: { defaults: { workspace: host } },
          plugins: { enabled: false },
          tools: { exec: { host: "node", mode: "full" } },
        };
        setRuntimeConfigSnapshot(config);
        const snapshot = await buildSkillSnapshot(host, { config });
        expect(snapshot.promptFormatVersion).toBe(WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION);
        expect(snapshot.discoverySkills?.map((skill) => skill.name)).toEqual([
          "delivered",
          "withheld",
        ]);
        expect(snapshot.catalogPrompt).toContain(host);
        // Synthetic persisted-v8 selection; sandbox delivery already supplies its bytes.
        const librarySelections = [
          {
            skillId: "11111111-1111-4111-8111-111111111111",
            revision: "a".repeat(64),
            name: "delivered",
            ownerProfileId: null,
          },
        ];
        if (connected) {
          const mac = testRemoteSession("legacy-sandbox-mac", {
            displayName: "Legacy sandbox Mac",
          });
          setTestSkillsRemoteRegistry(mac.nodeId, { get: () => mac });
          recordRemoteNodeInfo(mac);
          snapshot.nodeSkillsEligibility = { canExec: true };
          snapshot.prompt =
            "Remote macOS node available (Legacy sandbox Mac). Run macOS-only skills via exec host=node on that node.\n" +
            snapshot.prompt;
        }
        delete snapshot.remoteNote;
        snapshot.promptFormatVersion = 8;
        delete snapshot.catalogPrompt;
        snapshot.librarySelections = librarySelections;
        snapshot.resolvedSkills = snapshot.resolvedSkills?.filter(
          (skill) => skill.name === "delivered",
        );
        const sandbox = createAgentToolsSandboxContext({
          workspaceDir: materialized,
          agentWorkspaceDir: host,
          skillsWorkspaceDir: materialized,
          containerWorkdir: "/workspace",
        });
        sandbox.skillUsagePaths = [
          {
            skillName: "delivered",
            skillFile: path.join(host, "skills", "delivered", "SKILL.md"),
            readPath: deliveredFile,
            skillSource: "workspace",
          },
        ];
        const attempt = { config, skillsSnapshot: snapshot };
        const prepared = await prepareEmbeddedSkills({
          separateRemoteNote: true,
          applySkillEnvironment: false,
          includeCodeModeSkills: true,
          attempt,
          effectiveWorkspace: materialized,
          sandbox,
          sessionAgentId: "main",
        });
        const expectedLocation = "/workspace/.openclaw/sandbox-skills/skills/delivered/SKILL.md";
        const read = createReadTool(materialized);
        const requestTools = [
          { name: read.name, description: read.description, parameters: read.parameters },
        ];
        const rendered = await buildAttemptSystemPrompt({
          isRawModelRun: false,
          transformSystemPrompt: (text) => text,
          embeddedSystemPrompt: {
            config,
            workspaceDir: "/workspace",
            skillsPrompt: prepared.skillsPrompt,
            toolNames: ["read"],
            runtimeInfo: { agentId: "main", host: "synthetic-sandbox", model: "fixture/model" },
          },
        });
        const context = await prepareEmbeddedAttemptPromptContext({
          attempt,
          preparedSkills: prepared,
          capabilityToolNames: new Set(["read", "computer"]),
          includeBoundaryTimestamp: false,
          isRawModelRun: false,
          messages: [],
          prompt: {
            effectivePrompt: "Use the delivered skill.",
            effectiveTranscriptPrompt: "Use the delivered skill.",
          },
          replaceSessionMessages: () => {},
          sessionAgentId: "main",
          systemPromptText: rendered.systemPrompt,
          toolResultPromptProjectionState: {
            replacements: new Map(),
            frozen: new Set(),
            ambiguousBaseKeys: new Set(),
            restoredCacheTtl: new Map(),
            sourceHashByKey: new Map(),
          },
        });
        const exchange = await captureAnthropicExchange("transport", {
          context: {
            systemPrompt: rendered.systemPrompt,
            messages: convertToLlm(context.hookMessagesForCurrentPrompt),
            tools: requestTools,
          },
        });
        expect(exchange.requests).toHaveLength(1);
        expect(exchange.terminal.stopReason).not.toBe("error");
        const payload = exchange.requests[0]!.payload;
        expect(Array.isArray(payload.system)).toBe(true);
        const modelSystem = (payload.system as Array<{ text: string }>)
          .map((block) => block.text)
          .join("\n");
        const catalog = parseSkillsPromptCatalog(modelSystem);
        const output = process.env.ROW_A_RECEIPTS_DIR;
        if (output) {
          await fs.mkdir(output, { recursive: true });
          await fs.writeFile(
            path.join(output, "sandbox-v8-request.parsed.json"),
            JSON.stringify(payload, null, 2),
          );
          await fs.writeFile(
            path.join(output, "sandbox-v8-model-catalog.json"),
            JSON.stringify(
              {
                catalog,
                expectedLocation,
                host,
                librarySelections: prepared.skillsSnapshotForRun?.librarySelections,
                expectedLibrarySelections: librarySelections,
                preparedFormat: prepared.skillsSnapshotForRun?.promptFormatVersion,
                preparedResolved: prepared.skillsSnapshotForRun?.resolvedSkills?.map((skill) => ({
                  name: skill.name,
                  filePath: skill.filePath,
                })),
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(output, "sandbox-v8-completion.json"),
            JSON.stringify(exchange.terminal, null, 2),
          );
        }
        // RED on da71: actual model catalog still contains host locations and withheld skill.
        expect.soft(prepared.skillsSnapshotForRun?.librarySelections).toEqual(librarySelections);
        expect.soft(prepared.skillsSnapshotForRun?.catalogPrompt).toBeUndefined();
        expect.soft(prepared.skillsSnapshotForRun?.promptFormatVersion).toBe(8);
        expect.soft(prepared.legacySkillsPromptFallback).toBe(true);
        expect(JSON.stringify(payload)).not.toContain("Remote macOS execution is unavailable");
        expect(catalog).toEqual([{ name: "delivered", location: expectedLocation }]);
        expect(modelSystem).not.toContain(host);
        expect(modelSystem).not.toContain("<name>withheld</name>");
      });
    } finally {
      removeRemoteNodeInfo("legacy-sandbox-mac");
      setSkillsRemoteRegistry(null);
      clearRuntimeConfigSnapshot();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
