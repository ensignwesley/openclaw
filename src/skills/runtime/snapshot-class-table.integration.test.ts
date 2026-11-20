import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
import type { OpenClawConfig } from "../../config/config.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { transferSkillResources } from "../../gateway/worker-environments/skill-resource-transfer.js";
import { prepareWorkerTurnPrompt } from "../../gateway/worker-environments/worker-turn-prompt.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { parseSkillsPromptCatalog } from "../loading/skill-prompt-catalog.js";
import { formatSkillsForPromptBounded } from "../loading/skill-prompt-limits.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "../loading/workspace-skill-prompt.js";
import { closeSkillsWatchers } from "./refresh.js";
import { recordRemoteNodeInfo, removeRemoteNodeInfo, setSkillsRemoteRegistry } from "./remote.js";
import { testRemoteSession, setTestSkillsRemoteRegistry } from "./remote.test-helpers.js";

vi.mock("node:crypto", async (load) => ({
  ...(await load<typeof import("node:crypto")>()),
  randomUUID: () => "22222222-2222-4222-8222-222222222222",
}));
// mock-isolation: Exercise the real worker caller, system renderer and context composer,
// without admitting a real session, filesystem bootstrap, plugin hook or context engine.
vi.mock("../../agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js", async (load) => ({
  ...(await load<
    typeof import("../../agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js")
  >()),
  prepareEmbeddedAttemptBootstrap: async () => ({}),
}));
vi.mock("../../agents/prompt-projects.js", async (load) => ({
  ...(await load<typeof import("../../agents/prompt-projects.js")>()),
  prepareAgentPromptProjects: async () => ({}),
}));
vi.mock(
  "../../agents/embedded-agent-runner/run/attempt-system-prompt-additions.js",
  async (load) => ({
    ...(await load<
      typeof import("../../agents/embedded-agent-runner/run/attempt-system-prompt-additions.js")
    >()),
    prepareAttemptSystemPromptAdditions: async () => ({}),
  }),
);
vi.mock(
  "../../agents/embedded-agent-runner/run/attempt-system-prompt-prepare.js",
  async (load) => ({
    ...(await load<
      typeof import("../../agents/embedded-agent-runner/run/attempt-system-prompt-prepare.js")
    >()),
    prepareEmbeddedAttemptSystemPrompt: async (input: {
      skillsPrompt: string;
      setup: { effectiveWorkspace: string };
      attempt: { config: OpenClawConfig };
    }) => {
      const rendered = await buildAttemptSystemPrompt({
        isRawModelRun: false,
        transformSystemPrompt: (text) => text,
        embeddedSystemPrompt: {
          config: input.attempt.config,
          workspaceDir: input.setup.effectiveWorkspace,
          skillsPrompt: input.skillsPrompt,
          toolNames: ["read"],
          runtimeInfo: { agentId: "main", host: "synthetic-legacy", model: "fixture/model" },
        },
      });
      return { systemPromptText: rendered.systemPrompt };
    },
  }),
);
vi.mock("../../agents/embedded-agent-runner/run/attempt-transcript-helpers.js", async (load) => ({
  ...(await load<
    typeof import("../../agents/embedded-agent-runner/run/attempt-transcript-helpers.js")
  >()),
  resolveExistingAttemptTranscriptState: async () => ({ hasBootstrapTranscriptState: false }),
}));
vi.mock("../../agents/agent-project-settings.js", async (load) => ({
  ...(await load<typeof import("../../agents/agent-project-settings.js")>()),
  createPreparedEmbeddedAgentSettingsManager: () => ({ getCompactionReserveTokens: () => 0 }),
}));
vi.mock("../../agents/harness/context-engine-lifecycle.js", async (load) => ({
  ...(await load<typeof import("../../agents/harness/context-engine-lifecycle.js")>()),
  bootstrapHarnessContextEngine: async () => {},
  prepareHarnessContextEnginePrompt: async (input: {
    messages: unknown[];
    promptBudget: { systemPrompt: string };
  }) => ({
    messages: input.messages,
    systemPrompt: input.promptBudget.systemPrompt,
  }),
}));
vi.mock("../../agents/embedded-agent-runner/run/attempt-prompt-build.js", async (load) => ({
  ...(await load<
    typeof import("../../agents/embedded-agent-runner/run/attempt-prompt-build.js")
  >()),
  prepareEmbeddedAttemptPromptAssembly: async () => ({
    effectivePrompt: "Use only admitted skills.",
    effectiveTranscriptPrompt: "Use only admitted skills.",
  }),
}));
let invocationRoot: string;
let ownsInvocationRoot = false;
beforeAll(async () => {
  invocationRoot =
    process.env.ROW_A_TABLE_ROOT ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "row-a-class-table-")));
  ownsInvocationRoot = !process.env.ROW_A_TABLE_ROOT;
});
afterAll(async () => {
  if (ownsInvocationRoot) {
    await fs.rm(invocationRoot, { recursive: true, force: true });
  }
});
registerParityHostLifecycle();
function textStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(textStrings);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(textStrings);
  }
  return [];
}
const shapes = ["no-pair", "both-empty", "pair-note", "pair-no-note"] as const;
const paths = ["none", "sandbox", "worker", "worker-turn", "attempt-only"] as const;
const ownerStates = ["available", "unavailable"] as const;
const note =
  "Remote macOS node available (Matrix Mac). Run macOS-only skills via exec host=node on that node.";
for (const shape of shapes) {
  for (const route of paths) {
    for (const owners of ownerStates) {
      it.skipIf(process.platform === "win32")(
        `class table ${shape}/${route}/${owners}`,
        async () => {
          const id = `${shape}--${route}--${owners}`;
          const root = path.join(invocationRoot, id);
          let resources: Awaited<ReturnType<typeof transferSkillResources>>;
          try {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-11-20T11:15:00Z"));
            await withOpenClawTestState({ scenario: "minimal" }, async () => {
              const workspace = path.join(root, "host");
              const remote = path.join(root, "worker");
              const materialized = path.join(root, "materialized");
              await fs.mkdir(remote, { recursive: true });
              vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(root, "empty-skills"));
              vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "empty-plugins"));
              for (const name of ["cold", "healthy"]) {
                const file = path.join(workspace, "skills", name, "SKILL.md");
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(
                  file,
                  `---\nname: ${name}\ndescription: Matrix ${name} instructions\n---\nInstructions.\n`,
                );
              }
              const config = { plugins: { enabled: false }, agents: { defaults: { workspace } } };
              setRuntimeConfigSnapshot(config);
              const snapshot = await buildSkillSnapshot(workspace, { config });
              const skills = snapshot.resolvedSkills!;
              const plain = formatSkillsForPromptBounded({ skills, preserveOrder: true });
              snapshot.prompt = shape === "pair-no-note" ? plain : `${note}\n${plain}`;
              snapshot.promptFormatVersion = 8;
              snapshot.nodeSkillsEligibility = { canExec: true };
              snapshot.remoteNote = shape === "pair-no-note" ? undefined : note;
              if (shape === "no-pair") {
                delete snapshot.catalogPrompt;
              } else {
                snapshot.catalogPrompt = plain;
              }
              if (shape === "both-empty") {
                snapshot.prompt = "";
                snapshot.catalogPrompt = "";
              }
              // Force the real materialized owner even for both-empty input; do not use its empty fast path.
              if (route === "sandbox") {
                snapshot.librarySelections = [
                  {
                    skillId: "11111111-1111-4111-8111-111111111111",
                    revision: "a".repeat(64),
                    name: "healthy",
                    ownerProfileId: null,
                  },
                ];
              }
              const connected = testRemoteSession("matrix-mac", {
                displayName: "Matrix Mac",
                platform: "darwin",
                commands: ["system.run"],
              });
              setTestSkillsRemoteRegistry(connected.nodeId, { get: () => connected });
              recordRemoteNodeInfo(connected);
              if (owners === "unavailable") {
                setActiveDegradedSecretOwners([
                  {
                    ownerKind: "capability",
                    ownerId: "skill:cold",
                    state: "unavailable",
                    paths: ["skills.entries.cold.apiKey"],
                    refKeys: ["env:default:SYNTHETIC"],
                    reason: "Synthetic unavailable owner",
                  },
                ]);
              }
              let input = snapshot;
              let sandbox;
              if (route === "sandbox") {
                sandbox = createAgentToolsSandboxContext({
                  workspaceDir: materialized,
                  agentWorkspaceDir: workspace,
                  skillsWorkspaceDir: materialized,
                  containerWorkdir: "/workspace",
                });
                sandbox.skillUsagePaths = [];
                for (const skill of skills) {
                  const target = path.join(materialized, "skills", skill.name, "SKILL.md");
                  await fs.mkdir(path.dirname(target), { recursive: true });
                  await fs.copyFile(skill.filePath, target);
                  sandbox.skillUsagePaths.push({
                    skillName: skill.name,
                    skillFile: skill.filePath,
                    readPath: target,
                    skillSource: "workspace",
                  });
                }
              }
              if (route === "worker") {
                resources = await transferSkillResources({
                  snapshot,
                  workspaceDir: workspace,
                  remoteWorkspaceDir: remote,
                  assertCurrent: () => {},
                  tunnel: {
                    runWorkspaceCommand: async (command) =>
                      new Promise((resolve, reject) => {
                        const child = spawn(command.argv[0]!, command.argv.slice(1), {
                          stdio: "pipe",
                        });
                        let stdout = "",
                          stderr = "";
                        child.stdout.on("data", (b) => (stdout += b));
                        child.stderr.on("data", (b) => (stderr += b));
                        child.on("error", reject);
                        child.on("close", (code) =>
                          resolve({
                            stdout,
                            stderr,
                            code,
                            termination: "exit",
                            signal: null,
                            killed: false,
                          }),
                        );
                        child.stdin.end(command.input);
                      }),
                  },
                });
                expect(resources).toBeDefined();
                input = resources!.snapshot;
              }
              // Library selection has already been delivered in remap paths. No host library lookup.
              if (route !== "sandbox") {
                delete input.librarySelections;
              }
              const attempt = {
                config,
                skillsSnapshot: input,
                sessionId: "matrix",
                sessionKey: "agent:main:matrix",
              };
              const prepared =
                route === "worker-turn" || route === "attempt-only"
                  ? {
                      skillsPrompt: input.prompt,
                      skillsSnapshotForRun: input,
                      legacySkillsPromptFallback: true,
                    }
                  : await prepareEmbeddedSkills({
                      separateRemoteNote: true,
                      applySkillEnvironment: false,
                      includeCodeModeSkills: false,
                      attempt,
                      effectiveWorkspace: workspace,
                      sandbox,
                      sessionAgentId: "main",
                    });
              const rendered = await buildAttemptSystemPrompt({
                isRawModelRun: false,
                transformSystemPrompt: (s) => s,
                embeddedSystemPrompt: {
                  config,
                  workspaceDir: workspace,
                  skillsPrompt: prepared.skillsPrompt,
                  toolNames: ["read"],
                  runtimeInfo: {
                    agentId: "main",
                    host: "synthetic-legacy",
                    model: "fixture/model",
                  },
                },
              });
              const contextInput: Parameters<typeof prepareEmbeddedAttemptPromptContext>[0] = {
                attempt,
                preparedSkills:
                  route === "attempt-only" || route === "worker-turn" ? undefined : prepared,
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
              };
              const context = await prepareEmbeddedAttemptPromptContext(contextInput);
              const workerResult =
                route === "worker-turn"
                  ? await prepareWorkerTurnPrompt({
                      turn: {
                        ...attempt,
                        workspaceDir: workspace,
                        bootstrapWorkspaceDir: workspace,
                        prompt: "Use only admitted skills.",
                        thinkLevel: "off",
                        admittedRunContext: {},
                      },
                      agentId: "main",
                      workspaceDir: workspace,
                      preparedModelRuntime: { agentDir: path.join(root, "agent") },
                      model: {
                        provider: "fixture",
                        id: "model",
                        api: "anthropic-messages",
                        contextWindow: 32000,
                        maxTokens: 1000,
                      },
                      surface: {
                        tools: [{ definition: { name: "read" } }],
                        presentation: { codeMode: { enabled: false } },
                      },
                      toolRuntime: {
                        getPromptProjection: async () => ({
                          tools: [],
                          toolSchemaDirectoryPrompt: undefined,
                        }),
                        applyPromptToolsAllow: () => ["read"],
                      },
                      identity: {},
                      manager: { getHeader: () => ({ version: 3 }) },
                      transcriptPolicy: {},
                      history: [],
                      contextEngine: {},
                      assertCurrent: () => {},
                    } as unknown as Parameters<typeof prepareWorkerTurnPrompt>[0])
                  : undefined;
              const read = createReadTool(workspace);
              const exchange = await captureAnthropicExchange("transport", {
                context: {
                  systemPrompt: workerResult?.systemPromptText ?? rendered.systemPrompt,
                  messages: workerResult
                    ? [
                        {
                          role: "user",
                          content: textStrings(workerResult.runtimeContext).join("\n"),
                          timestamp: 0,
                        },
                      ]
                    : convertToLlm(context.hookMessagesForCurrentPrompt),
                  tools: [
                    { name: read.name, description: read.description, parameters: read.parameters },
                  ],
                },
              });
              expect(exchange.requests).toHaveLength(1);
              expect(exchange.terminal.stopReason).not.toBe("error");
              const payload = exchange.requests[0]!.payload;
              const system = (payload.system as Array<{ text: string }>)
                .map((b) => b.text)
                .join("\n");
              const catalog = parseSkillsPromptCatalog(system);
              expect(system).toContain(prepared.skillsPrompt.trim());
              expect(catalog).toEqual(parseSkillsPromptCatalog(prepared.skillsPrompt));
              const availability = textStrings(payload)
                .flatMap((s) => s.split("\n"))
                .filter((s) => s.startsWith("Remote macOS "));

              const workerSystemPrompt = workerResult?.systemPromptText;
              const turnContext = workerResult
                ? textStrings(workerResult.runtimeContext).join("\n")
                : textStrings(context.runtimeContextFragments).join("\n");
              const observed = {
                catalogBytes: prepared.skillsPrompt,
                availability,
                ...(workerSystemPrompt === undefined ? {} : { workerSystemPrompt }),
                ...(route === "worker-turn" || route === "attempt-only" ? { turnContext } : {}),
              };
              const output = process.env.ROW_A_RECEIPTS_DIR;
              if (output) {
                await fs.mkdir(output, { recursive: true });
                await fs.writeFile(
                  path.join(output, id + ".json"),
                  JSON.stringify(
                    {
                      id,
                      invocationRoot,
                      shape,
                      route,
                      owners,
                      inputClass:
                        shape === "no-pair" || shape === "both-empty" || owners === "unavailable"
                          ? "legacy"
                          : "separated",
                      ...observed,
                      runCatalogPrompt: prepared.skillsSnapshotForRun?.catalogPrompt,
                      runPrompt: prepared.skillsSnapshotForRun?.prompt,
                    },
                    null,
                    2,
                  ),
                );
              }
              if (process.env.ROW_A_BASELINE !== "1") {
                const ordinaryRoute = route !== "worker-turn" && route !== "attempt-only";
                const base = process.env.ROW_A_BASE_RECEIPTS
                  ? JSON.parse(
                      await fs.readFile(
                        path.join(process.env.ROW_A_BASE_RECEIPTS, id + ".json"),
                        "utf8",
                      ),
                    )
                  : ordinaryRoute
                    ? JSON.parse(
                        (
                          await fs.readFile(
                            new URL("./fixtures/snapshot-class-table-base.json", import.meta.url),
                            "utf8",
                          )
                        ).replaceAll("/tmp/row-a-snapshot-class-table", root),
                      )[id]
                    : undefined;
                // Standalone expected fixture paths expand synthetic inputs, never captured bytes.
                // Hosted base/candidate runs compare fresh raw strings with the same owned root.
                const legacy =
                  shape === "no-pair" || shape === "both-empty" || owners === "unavailable";
                if (route === "worker-turn" || route === "attempt-only") {
                  if (base) {
                    expect.soft(observed).toEqual({
                      catalogBytes: base.catalogBytes,
                      availability: base.availability,
                      ...(base.workerSystemPrompt === undefined
                        ? {}
                        : { workerSystemPrompt: base.workerSystemPrompt }),
                      turnContext: base.turnContext,
                    });
                  }
                  expect.soft(turnContext).not.toContain("Remote macOS ");
                  if (route === "worker-turn" && shape === "pair-note" && owners === "available") {
                    expect.soft(availability).toEqual([note]);
                    expect.soft(workerSystemPrompt?.split(note).length).toBe(2);
                  }
                } else if (legacy) {
                  expect.soft(observed.catalogBytes).toBe(base.catalogBytes);
                  expect.soft(observed.availability).toEqual(base.availability);
                  expect.soft(prepared.skillsSnapshotForRun?.catalogPrompt).toBeUndefined();
                } else {
                  // Feature-only difference: stable delivered catalog in system; one live fact in turn context.
                  const expectedCatalog = await resolveSkillsPrompt({
                    workspaceDir: workspace,
                    config,
                    skillsSnapshot: {
                      ...prepared.skillsSnapshotForRun!,
                      prompt: formatSkillsForPromptBounded({
                        skills: prepared.skillsSnapshotForRun!.resolvedSkills!,
                        preserveOrder: true,
                      }),
                      catalogPrompt: undefined,
                    },
                  });
                  expect.soft(observed.catalogBytes).toBe(expectedCatalog);
                  expect
                    .soft(observed.availability)
                    .toEqual([
                      shape === "pair-no-note"
                        ? "Remote macOS execution is unavailable for this turn."
                        : note,
                    ]);
                }
              }
            });
          } finally {
            await resources?.cleanup();
            removeRemoteNodeInfo("matrix-mac");
            setSkillsRemoteRegistry(null);
            setActiveDegradedSecretOwners([]);
            vi.useRealTimers();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
            clearRuntimeConfigSnapshot();
            await closeSkillsWatchers();
          }
        },
      );
    }
  }
}

// Fresh base-shaped builder results use the same legacy contract as delivered snapshots.
it.skipIf(process.platform === "win32")(
  "class table fresh-build/base-shaped/available",
  async () => {
    const id = "fresh-build--base-shaped--available";
    const workspace = path.join(invocationRoot, id);
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await fs.mkdir(workspace, { recursive: true });
        vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(workspace, "empty-skills"));
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(workspace, "empty-plugins"));
        const config = { plugins: { enabled: false }, agents: { defaults: { workspace } } };
        setRuntimeConfigSnapshot(config);
        const builder = await import("../loading/workspace-skill-prompt.js");
        const snapshot = { prompt: "", skills: [], resolvedSkills: [], discoverySkills: [] };
        const build = vi.spyOn(builder, "buildSkillSnapshot").mockResolvedValueOnce(snapshot);
        const prepared = await prepareEmbeddedSkills({
          separateRemoteNote: true,
          applySkillEnvironment: false,
          includeCodeModeSkills: false,
          attempt: { config },
          effectiveWorkspace: workspace,
          sandbox: undefined,
          sessionAgentId: "main",
        });
        expect(build).toHaveBeenCalledOnce();
        const context = await prepareEmbeddedAttemptPromptContext({
          attempt: { config, sessionId: "fresh-build", sessionKey: "agent:main:fresh-build" },
          preparedSkills: prepared,
          capabilityToolNames: new Set(["read", "computer"]),
          includeBoundaryTimestamp: false,
          isRawModelRun: false,
          messages: [],
          prompt: { effectivePrompt: "Read skills.", effectiveTranscriptPrompt: "Read skills." },
          replaceSessionMessages: () => {},
          sessionAgentId: "main",
          systemPromptText: prepared.skillsPrompt,
          toolResultPromptProjectionState: {
            replacements: new Map(),
            frozen: new Set(),
            ambiguousBaseKeys: new Set(),
            restoredCacheTtl: new Map(),
            sourceHashByKey: new Map(),
          },
        });
        const availability = textStrings(context.runtimeContextFragments)
          .flatMap((text) => text.split("\n"))
          .filter((text) => text.startsWith("Remote macOS "));
        const observed = {
          id,
          invocationRoot,
          inputClass: "legacy",
          route: "fresh-build",
          catalogBytes: prepared.skillsPrompt,
          availability,
        };
        expect(observed.catalogBytes).toBe("");
        expect(observed.availability).toEqual([]);
        expect(prepared.skillsSnapshotForRun).toBe(snapshot);
        expect(prepared.skillsSnapshotForRun?.catalogPrompt).toBeUndefined();
        if (process.env.ROW_A_RECEIPTS_DIR) {
          await fs.mkdir(process.env.ROW_A_RECEIPTS_DIR, { recursive: true });
          await fs.writeFile(
            path.join(process.env.ROW_A_RECEIPTS_DIR, id + ".json"),
            JSON.stringify(observed, null, 2),
          );
        }
        if (process.env.ROW_A_BASELINE !== "1" && process.env.ROW_A_BASE_RECEIPTS) {
          const base = JSON.parse(
            await fs.readFile(path.join(process.env.ROW_A_BASE_RECEIPTS, id + ".json"), "utf8"),
          );
          expect(observed).toEqual(base);
        }
      });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      clearRuntimeConfigSnapshot();
      await closeSkillsWatchers();
    }
  },
);
