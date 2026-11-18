import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  captureAnthropicExchange,
  registerParityHostLifecycle,
} from "../../../packages/ai/src/provider-transport-parity.test-support.js";
import { buildAttemptSystemPrompt } from "../../agents/embedded-agent-runner/run/attempt-system-prompt.js";
import { prepareEmbeddedSkills } from "../../agents/embedded-agent-runner/skill-runtime.js";
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

registerParityHostLifecycle();

it("renders only materialized sandbox skills at container paths in the model request", async () => {
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
      };
      setRuntimeConfigSnapshot(config);
      const snapshot = await buildSkillSnapshot(host, { config });
      expect(snapshot.promptFormatVersion).toBe(WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION);
      expect(snapshot.discoverySkills?.map((skill) => skill.name)).toEqual([
        "delivered",
        "withheld",
      ]);
      expect(snapshot.catalogPrompt).toContain(host);
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
      const prepared = await prepareEmbeddedSkills({
        separateRemoteNote: true,
        applySkillEnvironment: false,
        includeCodeModeSkills: true,
        attempt: { config, skillsSnapshot: snapshot },
        effectiveWorkspace: materialized,
        sandbox,
        sessionAgentId: "main",
      });
      const expectedLocation = "/workspace/.openclaw/sandbox-skills/skills/delivered/SKILL.md";
      // These guards prove the real caller performed materialized remapping before rendering.
      expect(prepared.skillsSnapshotForRun?.resolvedSkills?.map((skill) => skill.name)).toEqual([
        "delivered",
      ]);
      expect(prepared.skillsSnapshotForRun?.prompt).toContain(expectedLocation);
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
      const exchange = await captureAnthropicExchange("transport", {
        context: {
          systemPrompt: rendered.systemPrompt,
          messages: [{ role: "user", content: "Use the delivered skill.", timestamp: 1 }],
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
          path.join(output, "sandbox-request.parsed.json"),
          JSON.stringify(payload, null, 2),
        );
        await fs.writeFile(
          path.join(output, "sandbox-model-catalog.json"),
          JSON.stringify(
            {
              catalog,
              expectedLocation,
              host,
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
          path.join(output, "sandbox-completion.json"),
          JSON.stringify(exchange.terminal, null, 2),
        );
      }
      // RED on da71: actual model catalog still contains host locations and withheld skill.
      expect(catalog).toEqual([{ name: "delivered", location: expectedLocation }]);
      expect(modelSystem).not.toContain(host);
      expect(modelSystem).not.toContain("<name>withheld</name>");
    });
  } finally {
    clearRuntimeConfigSnapshot();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
