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
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { parseSkillsPromptCatalog } from "../loading/skill-prompt-catalog.js";
import { prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "../loading/workspace-skill-prompt.js";
import type { SkillSnapshot } from "../types.js";
import { closeSkillsWatchers } from "./refresh.js";

registerParityHostLifecycle();
type Kind =
  | "empty-positive"
  | "empty-absent"
  | "old-degraded"
  | "keyed-degraded"
  | "legacy-identity"
  | "malformed-boundary"
  | "malformed-body"
  | "malformed-tail";
function textStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(textStrings);
  return [];
}
async function runCase(kind: Kind, owner: "embedded" | "reader") {
  const empty = kind.startsWith("empty-");
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(state.root, "empty-skills"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(state.root, "empty-plugins"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("Unexpected provider fetch");
        }),
      );
      const captured = path.join(state.root, "captured");
      const workspace = path.join(state.root, "current");
      for (const [root, names, description] of [
        [captured, ["cold", "healthy"], "Captured"],
        [workspace, ["cold", "healthy", "outsider"], "Current"],
      ] as const) {
        for (const name of names) {
          const dir = path.join(root, "skills", name);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            path.join(dir, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${description} ${name} guidance\n---\nInstructions.\n`,
          );
        }
      }
      const config = { plugins: { enabled: false }, agents: { defaults: { workspace } } };
      setRuntimeConfigSnapshot(config);
      let snapshot: SkillSnapshot;
      if (empty)
        snapshot = {
          prompt: kind === "empty-absent" ? "  \n" : "",
          skills: [],
          promptFormatVersion: 8,
          nodeSkillsEligibility: { canExec: true },
          ...(kind === "empty-positive"
            ? {
                remoteNote:
                  "Remote macOS node available (Synthetic admitted Mac). Run macOS-only skills via exec host=node on that node.",
              }
            : {}),
        };
      else {
        snapshot = await buildSkillSnapshot(captured, { config });
        snapshot.promptFormatVersion = kind === "old-degraded" ? 7 : 8;
        delete snapshot.catalogPrompt;
        if (kind === "keyed-degraded") delete snapshot.resolvedSkills;
        if (kind === "legacy-identity")
          snapshot.skills = snapshot.skills.map(({ name }) => ({ name }));
        if (kind === "malformed-boundary")
          snapshot.prompt += "\n<available_skills></available_skills>";
        if (kind === "malformed-body")
          snapshot.prompt = snapshot.prompt.replace(
            "<available_skills>",
            "<available_skills>UNEXPECTED BODY",
          );
        if (kind === "malformed-tail")
          snapshot.prompt = snapshot.prompt.replace(
            "</available_skills>",
            "UNEXPECTED TAIL</available_skills>",
          );
        setActiveDegradedSecretOwners([
          {
            ownerKind: "capability",
            ownerId: "skill:cold",
            state: "unavailable",
            paths: ["skills.entries.cold.apiKey"],
            refKeys: ["env:default:SYNTHETIC_MISSING"],
            reason: "Synthetic unavailable owner",
          },
        ]);
      }
      const sandbox = empty
        ? createAgentToolsSandboxContext({
            workspaceDir: workspace,
            agentWorkspaceDir: captured,
            skillsWorkspaceDir: workspace,
            containerWorkdir: "/workspace",
          })
        : undefined;
      const attempt = {
        config,
        skillsSnapshot: snapshot,
        sessionId: "legacy-" + kind,
        sessionKey: "agent:main:legacy-" + kind,
      };
      const params = {
        applySkillEnvironment: false,
        includeCodeModeSkills: false,
        attempt,
        effectiveWorkspace: workspace,
        sandbox,
        sessionAgentId: "main",
      };
      let legacyPrompt: string;
      let prepared;
      if (owner === "embedded") {
        legacyPrompt = (await prepareEmbeddedSkills({ ...params, separateRemoteNote: false }))
          .skillsPrompt;
        prepared = await prepareEmbeddedSkills({ ...params, separateRemoteNote: true });
      } else {
        const readerParams = {
          workspaceDir: workspace,
          config,
          skillsSnapshot: snapshot,
          loadEntries: () => prepareWorkspaceSkills(workspace, { config }),
        };
        legacyPrompt = await resolveSkillsPrompt({ ...readerParams, separateRemoteNote: false });
        let fallback = false;
        const prompt = await resolveSkillsPrompt({
          ...readerParams,
          separateRemoteNote: true,
          onLegacyPromptFallback: () => {
            fallback = true;
          },
        });
        prepared = {
          skillsPrompt: prompt,
          skillsSnapshotForRun: snapshot,
          legacySkillsPromptFallback: fallback,
        };
      }
      const rendered = await buildAttemptSystemPrompt({
        isRawModelRun: false,
        transformSystemPrompt: (s) => s,
        embeddedSystemPrompt: {
          config,
          workspaceDir: workspace,
          skillsPrompt: prepared.skillsPrompt,
          toolNames: ["read"],
          runtimeInfo: { agentId: "main", host: "synthetic-legacy", model: "fixture/model" },
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
          effectivePrompt: "Use only admitted skills.",
          effectiveTranscriptPrompt: "Use only admitted skills.",
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
      const read = createReadTool(workspace);
      const exchange = await captureAnthropicExchange("transport", {
        context: {
          systemPrompt: rendered.systemPrompt,
          messages: convertToLlm(context.hookMessagesForCurrentPrompt),
          tools: [{ name: read.name, description: read.description, parameters: read.parameters }],
        },
      });
      expect(exchange.requests).toHaveLength(1);
      expect(exchange.terminal.stopReason).not.toBe("error");
      const payload = exchange.requests[0]!.payload;
      const system = (payload.system as Array<{ text: string }>).map((b) => b.text).join("\n");
      const catalog = parseSkillsPromptCatalog(system);
      const availability = textStrings(payload)
        .flatMap((s) => s.split("\n"))
        .filter((s) => s.startsWith("Remote macOS "));
      const receipts = process.env.ROW_A_RECEIPTS_DIR;
      if (receipts) {
        await fs.mkdir(receipts, { recursive: true });
        await fs.writeFile(
          path.join(receipts, owner + "-" + kind + ".json"),
          JSON.stringify(
            { payload, catalog, availability, legacyPrompt, preparedPrompt: prepared.skillsPrompt },
            null,
            2,
          ),
        );
        if (empty && owner === "embedded")
          await fs.writeFile(
            path.join(receipts, kind + ".availability.json"),
            JSON.stringify(availability),
          );
      }
      expect.soft(prepared.skillsPrompt).toBe(legacyPrompt);
      if (empty) {
        expect.soft(catalog).toEqual([]);
        expect(availability).toEqual([]);
      } else {
        expect(catalog.some((s) => s.name === "cold")).toBe(false);
        expect(system).not.toContain("Current cold guidance");
        if (kind === "keyed-degraded") {
          expect(system).toContain("Captured healthy guidance");
          expect(system).not.toContain("Current healthy guidance");
          expect(catalog.some((s) => s.name === "outsider")).toBe(false);
        }
      }
    });
  } finally {
    setActiveDegradedSecretOwners([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
    await closeSkillsWatchers();
  }
}
for (const owner of ["embedded", "reader"] as const) {
  for (const kind of [
    "empty-positive",
    "empty-absent",
    "old-degraded",
    "keyed-degraded",
    "legacy-identity",
    "malformed-boundary",
    "malformed-body",
    "malformed-tail",
  ] as const) {
    it(`${kind.startsWith("empty-") && owner === "embedded" ? "empty legacy sandbox" : "legacy decision"} ${owner} ${kind}`, () =>
      runCase(kind, owner));
  }
}
