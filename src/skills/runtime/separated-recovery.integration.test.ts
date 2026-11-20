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
import { prepareRuntimeSkillEntries } from "../../agents/embedded-agent-runner/skills-prompt.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { createReadTool } from "../../agents/sessions/tools/read.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { parseSkillsPromptCatalog } from "../loading/skill-prompt-catalog.js";
import * as projectionOwner from "../loading/skill-snapshot-reprojection.js";
import * as skillLoader from "../loading/workspace-skill-loader.js";
import * as promptOwner from "../loading/workspace-skill-prompt.js";
import type { SkillSnapshot } from "../types.js";
import * as refreshOwner from "./refresh.js";

// Mock isolation: preserve the real logger factory and all other exports; observe only skills warnings.
const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "skills" ? { ...logger, warn: diagnostics.warn } : logger;
    },
  };
});
registerParityHostLifecycle();
const remoteNote =
  "Remote macOS node available (Synthetic fallback Mac). Run macOS-only skills via exec host=node on that node.";

async function runCase(kind: "resolved" | "loader" | "fallback" | "reader-fallback" | "v8-roots") {
  diagnostics.warn.mockClear();
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
      const source = path.join(state.root, "selected-source");
      const empty = path.join(state.root, "empty-execution");
      await fs.mkdir(path.join(source, "skills", "selected"), { recursive: true });
      await fs.mkdir(empty, { recursive: true });
      await fs.writeFile(
        path.join(source, "skills", "selected", "SKILL.md"),
        "---\nname: selected\ndescription: Selected fixture\n---\nRead selected.\n",
      );
      const workspace = kind === "v8-roots" ? empty : source;
      if (kind === "v8-roots") {
        const added = path.join(workspace, "skills", "selected");
        await fs.mkdir(added, { recursive: true });
        await fs.writeFile(
          path.join(added, "SKILL.md"),
          "---\nname: selected\ndescription: Wrong current root\n---\nNot captured.\n",
        );
      }
      const config = { plugins: { enabled: false }, agents: { defaults: { workspace } } };
      setRuntimeConfigSnapshot(config);
      const snapshot = await promptOwner.buildSkillSnapshot(source, { config });
      const expectedLocation = snapshot.resolvedSkills![0]!.filePath;
      const original = snapshot.prompt;
      if (kind === "loader") {
        const added = path.join(source, "skills", "new-outsider");
        await fs.mkdir(added, { recursive: true });
        await fs.writeFile(
          path.join(added, "SKILL.md"),
          "---\nname: new-outsider\ndescription: Added after capture\n---\nNot captured.\n",
        );
      }
      snapshot.promptFormatVersion = 8;
      if (kind === "loader") {
        snapshot.catalogPrompt = "STALE DERIVED CATALOG";
      } else {
        delete snapshot.catalogPrompt;
      }
      if (kind !== "resolved" && kind !== "fallback") {
        delete snapshot.resolvedSkills;
      }
      snapshot.skillOverrides = { selected: true };
      if (kind === "v8-roots") {
        snapshot.skillRoots = {
          agentWorkspaceDir: source,
          executionWorkspaceDir: path.join(state.root, "captured-execution"),
        };
        await fs.mkdir(snapshot.skillRoots.executionWorkspaceDir, { recursive: true });
        const actual = await prepareRuntimeSkillEntries({
          skillsAnchorWorkspace: workspace,
          executionWorkspaceDir: workspace,
          config,
          skillsSnapshot: snapshot,
          agentId: "main",
        });
        expect
          .soft(
            actual.skillEntries.find((entry) => entry.skill.name === "selected")?.skill.filePath,
          )
          .toBe(expectedLocation);
      }
      if (kind === "fallback" || kind === "reader-fallback") {
        snapshot.remoteNote = remoteNote;
        snapshot.nodeSkillsEligibility = { canExec: true };
        snapshot.prompt = remoteNote + "\n" + original;
      }
      const legacyPrompt = await promptOwner.resolveSkillsPrompt({
        skillsSnapshot: snapshot,
        workspaceDir: source,
        config,
        separateRemoteNote: false,
      });
      const attempt = {
        config,
        skillsSnapshot: snapshot,
        sessionId: "projection-" + kind,
        sessionKey: "agent:main:projection-" + kind,
      };
      const loaderSpy =
        kind === "resolved" ? vi.spyOn(skillLoader, "prepareWorkspaceSkills") : undefined;
      let prepared: {
        skillsPrompt: string;
        skillsSnapshotForRun: SkillSnapshot | undefined;
        legacySkillsPromptFallback: boolean;
      };
      let fallbackNotifications = 0;
      const readerLoader = vi.fn(async () => {
        throw new Error("Synthetic discovery unavailable");
      });
      if (kind === "reader-fallback") {
        // Fault injection at the exported reader's loader seam, not a runtime discovery reproduction.
        const params = {
          separateRemoteNote: true,
          skillsSnapshot: snapshot,
          workspaceDir: source,
          loadEntries: readerLoader,
          onLegacyPromptFallback: () => {
            fallbackNotifications++;
          },
        };
        const prompt = await promptOwner.resolveSkillsPrompt(params);
        prepared = {
          skillsPrompt: prompt,
          skillsSnapshotForRun: snapshot,
          legacySkillsPromptFallback: fallbackNotifications > 0,
        };
      } else {
        if (kind === "fallback") {
          // Fault injection into the new re-projection call only, after the real source snapshot exists.
          vi.spyOn(projectionOwner, "reprojectSkillSnapshot").mockImplementationOnce(() => {
            throw new Error("Synthetic projection unavailable");
          });
        }
        prepared = await prepareEmbeddedSkills({
          separateRemoteNote: true,
          applySkillEnvironment: false,
          includeCodeModeSkills: false,
          attempt,
          effectiveWorkspace: kind === "resolved" ? empty : workspace,
          sandbox: undefined,
          sessionAgentId: "main",
        });
      }
      const rendered = await buildAttemptSystemPrompt({
        isRawModelRun: false,
        transformSystemPrompt: (s) => s,
        embeddedSystemPrompt: {
          config,
          workspaceDir: source,
          skillsPrompt: prepared.skillsPrompt,
          toolNames: ["read"],
          runtimeInfo: { agentId: "main", host: "synthetic-recovery", model: "fixture/model" },
        },
      });
      const context = await prepareEmbeddedAttemptPromptContext({
        attempt,
        preparedSkills: prepared,
        capabilityToolNames: new Set(["read", "computer"]),
        includeBoundaryTimestamp: false,
        isRawModelRun: false,
        messages: [],
        prompt: { effectivePrompt: "Use selected.", effectiveTranscriptPrompt: "Use selected." },
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
      const read = createReadTool(source);
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
      const system = (payload.system as Array<{ text: string }>).map((x) => x.text).join("\n");
      const catalog = parseSkillsPromptCatalog(system);
      const output = process.env.ROW_A_RECEIPTS_DIR;
      if (output) {
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(
          path.join(output, kind + ".request.parsed.json"),
          JSON.stringify(payload, null, 2),
        );
        await fs.writeFile(
          path.join(output, kind + ".observation.json"),
          JSON.stringify(
            {
              catalog,
              expectedLocation,
              preparedPrompt: prepared.skillsPrompt,
              originalLegacyPrompt: legacyPrompt,
              persistedSnapshotPrompt: snapshot.prompt,
              fallbackNotifications,
              fallback: prepared.legacySkillsPromptFallback,
            },
            null,
            2,
          ),
        );
      }
      if (kind === "resolved") {
        expect.soft(loaderSpy).not.toHaveBeenCalled();
      }
      expect.soft(catalog).toEqual([{ name: "selected", location: expectedLocation }]);
      if (["resolved", "loader", "v8-roots", "fallback", "reader-fallback"].includes(kind)) {
        expect.soft(prepared.skillsPrompt).toBe(legacyPrompt);
        if (kind === "loader") {
          // A stale catalogPrompt is dropped to preserve the legacy shape.
          const { catalogPrompt: _catalogPrompt, ...legacySnapshot } = snapshot;
          expect.soft(prepared.skillsSnapshotForRun).toStrictEqual(legacySnapshot);
        } else {
          expect.soft(prepared.skillsSnapshotForRun).toBe(snapshot);
        }
        expect.soft(prepared.skillsSnapshotForRun?.skillOverrides).toEqual({ selected: true });
        expect.soft(prepared.legacySkillsPromptFallback).toBe(true);
        expect.soft(diagnostics.warn).not.toHaveBeenCalled();
      }
      if (kind === "fallback" || kind === "reader-fallback") {
        expect(prepared.skillsPrompt).toBe(legacyPrompt);
        expect(prepared.legacySkillsPromptFallback).toBe(true);
        expect((JSON.stringify(payload).match(/Remote macOS node available/g) ?? []).length).toBe(
          1,
        );
        if (kind === "reader-fallback") {
          expect(fallbackNotifications).toBe(1);
          expect(readerLoader).not.toHaveBeenCalled();
        }
        if (kind === "fallback") {
          expect(projectionOwner.reprojectSkillSnapshot).not.toHaveBeenCalled();
          expect(diagnostics.warn).not.toHaveBeenCalled();
        }
      }
    });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await refreshOwner.closeSkillsWatchers();
    clearRuntimeConfigSnapshot();
  }
}

it("retains an old hydrated snapshot as legacy bytes without a loader or promotion", () =>
  runCase("resolved"));
it("retains an inconsistent unhydrated pair as legacy bytes without widening the selection", () =>
  runCase("loader"));
it("hydrates a v8 selected skill from captured roots, not the current run roots", () =>
  runCase("v8-roots"));
it("never attempts projection repair for a hydrated legacy snapshot", () => runCase("fallback"));
it("keeps legacy bytes with one notification at the canonical reader fallback", () =>
  runCase("reader-fallback"));
