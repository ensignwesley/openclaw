import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../packages/ai/src/host.js";
import { createAnthropicMessagesTransportStreamFn } from "../../../packages/ai/src/transports/anthropic-transport-stream.js";
import {
  createSseResponse,
  anthropicMessageStart,
  anthropicMessageDelta,
  makeAnthropicTransportModel,
  installAnthropicTransportTestHost,
} from "../../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import { buildCliAgentSystemPrompt } from "../../agents/cli-runner/helpers.js";
import { renderCodexSkillsInstructions } from "../../../extensions/codex/src/app-server/attempt-context.js";
import { buildSkillSnapshotProjection } from "../loading/skill-snapshot-projection.js";
import { prepareEmbeddedSkills } from "../../agents/embedded-agent-runner/skill-runtime.js";
import { prepareEmbeddedAttemptPromptContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-build.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { prepareEmbeddedSessionState } from "../../agents/command/session-preparation.js";
import { resolveNodeExecEligibilityAsync } from "../../agents/exec-defaults.js";
import { createReadTool } from "../../agents/sessions/tools/read.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { createComputerTool } from "../../agents/tools/computer-tool.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentRunLifecycleGeneration,
  clearAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import { closeSkillsWatchers } from "./refresh.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeInfo,
  removeRemoteNodeInfoForConnection,
  removeRemoteNodeInfo,
  setSkillsRemoteRegistry,
} from "./remote.js";
import { testRemoteSession, setTestSkillsRemoteRegistry } from "./remote.test-helpers.js";

// RED-only proof: change no product code. Real producers, preparation, rendering,
// transport serialization and SSE consumer; only node/provider I/O is synthetic.
it("keeps prior system bytes stable when only remote skill availability changes", async () => {
  const output = process.env.ROW_A_RECEIPTS_DIR;
  if (!output) throw new Error("ROW_A_RECEIPTS_DIR must retain RED proof artifacts");
  await fs.mkdir(output, { recursive: true });
  const originalHost = getAiTransportHost();
  const buildModelFetch = vi.fn();
  const guardedFetch = vi.fn();
  installAnthropicTransportTestHost({
    coreTransportHost: originalHost,
    buildModelFetch,
    guardedFetch,
  });
  const syntheticTransportHost = getAiTransportHost();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected fetch outside the synthetic provider boundary"); }));
  const nodeId = "row-a-synthetic-mac";
  const runId = "row-a-red";
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspaceDir = state.workspaceDir;
      vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(state.root, "empty-skills"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(state.root, "empty-plugins"));
      await fs.mkdir(path.join(workspaceDir, "skills", "fixed"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "skills", "fixed", "SKILL.md"),
        "---\nname: fixed\ndescription: Fixed OS-independent skill\n---\nStable instructions.\n",
      );
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: { enabled: false },
        tools: { exec: { host: "node", mode: "full" } },
      };
      setRuntimeConfigSnapshot(cfg);
      let sessionEntry: SessionEntry = {
        sessionId: "row-a-one-session",
        updatedAt: 1,
        permissionMode: "full",
      };
      let connected: ReturnType<typeof testRemoteSession> | undefined;
      setTestSkillsRemoteRegistry(nodeId, { get: () => connected });
      const computer = createComputerTool({
        config: cfg,
        computerExecutionId: "row-a-fixed-computer",
      });
      const read = createReadTool(workspaceDir);
      const tools = [computer, read].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
      const history = [
        {
          role: "user" as const,
          content: "ROW_A_EARLY_HISTORY must stay byte identical.",
          timestamp: 1,
        },
      ];
      const model = makeAnthropicTransportModel();
      const requests: Array<{
        state: string;
        body: string;
        payload: Record<string, unknown>;
        roster: string[];
        snapshotVersion: number;
        canExec: boolean;
      }> = [];
      const responses: string[] = [];
      const legacyControls: unknown[] = [];
      const completions: unknown[] = [];
      const stream = createAnthropicMessagesTransportStreamFn();
      for (const presence of ["online-1", "offline", "online-2", "stale-c1-removal", "linux", "no-system-run", "denied"]) {
        const turnCfg: OpenClawConfig = presence === "denied"
          ? { ...cfg, gateway: { nodes: { commands: { deny: ["system.run"] } } } } : cfg;
        if (presence === "stale-c1-removal") {
          expect(removeRemoteNodeInfoForConnection(nodeId, "c1")).toBe(false);
        } else if (presence === "offline") {
          const retired = connected!.connId;
          connected = undefined;
          expect(removeRemoteNodeInfoForConnection(nodeId, retired)).toBe(true);
        } else {
          connected = testRemoteSession(nodeId, {
            connId: presence === "online-1" ? "c1" : "c2",
            displayName: "Fixed proof Mac",
            platform: presence === "linux" ? "linux" : "darwin",
            commands: presence === "no-system-run" ? [] : ["system.run"],
          });
          recordRemoteNodeInfo(connected);
        }
        const eligibility = await resolveNodeExecEligibilityAsync({
          cfg: turnCfg,
          sessionEntry,
          agentId: "main",
        });
        expect(eligibility.canExec).toBe(presence !== "denied");
        const remote = getRemoteSkillEligibility({ advertiseExecNode: eligibility.canExec });
        expect(Boolean(remote?.note)).toBe(["online-1", "online-2", "stale-c1-removal"].includes(presence));
        const prepared = await prepareEmbeddedSessionState({
          cfg: turnCfg,
          opts: { message: "Fixed current turn" },
          sessionEntry,
          sessionKey: "agent:main:row-a",
          sessionId: sessionEntry.sessionId,
          storePath: path.join(state.root, "sessions.json"),
          sessionAgentId: "main",
          lifecycleGeneration: getAgentRunLifecycleGeneration(),
          runId,
          executionWorkspaceDir: workspaceDir,
          watchSkills: false,
          isNewSession: false,
          isSubagentLaneTurn: false,
          suppressVisibleSessionEffects: true,
          sessionStateActor: { actorType: "agent" },
        });
        expect(prepared.skillsSnapshot).toBeDefined();
        sessionEntry = { ...sessionEntry, skillsSnapshot: prepared.skillsSnapshot };
        const skillPreparation = await prepareEmbeddedSkills({
          separateRemoteNote: true,
          applySkillEnvironment: false,
          includeCodeModeSkills: false,
          attempt: { config: turnCfg, skillsSnapshot: prepared.skillsSnapshot },
          effectiveWorkspace: workspaceDir,
          sandbox: undefined,
          sessionAgentId: "main",
        });
        const systemPrompt = buildAgentSystemPrompt({
          workspaceDir,
          skillsPrompt: skillPreparation.skillsPrompt,
          toolNames: tools.map((tool) => tool.name),
          runtimeInfo: { agentId: "main", host: "fixed-proof-host", model: model.id },
        });
        expect(systemPrompt).toContain("## Skills");
        expect(systemPrompt).toContain("<name>fixed</name>");
        for (const [label, count, maxChars] of [["full", 1, 5000], ["compact", 1, 700], ["truncated", 10, 700], ["note-does-not-fit", 1, 180]] as const) {
          const projection = buildSkillSnapshotProjection({
            workspaceDir: "/proof", eligible: Array.from({length: count}, (_, i) => ({
              skill: { ...prepared.skillsSnapshot!.resolvedSkills![0], name: `fixed-${i}`,
                description: "Stable description ".repeat(70), filePath: `/proof/skills/fixed-${i}/SKILL.md`, baseDir: `/proof/skills/fixed-${i}` },
              frontmatter: {},
            })),
            config: { skills: { limits: { maxSkillsPromptChars: maxChars } } },
            eligibility: { remote },
          });
          legacyControls.push({ presence, label, prompt: projection.prompt,
            cli: buildCliAgentSystemPrompt({ workspaceDir: "/proof", preparedRepoRoot: null,
              preparedGitCoauthorPrompt: "", skillsPrompt: projection.prompt, tools: [computer, read], modelDisplay: "fixed/model" }),
            codex: renderCodexSkillsInstructions({ attempt: { config: cfg }, skillsPrompt: projection.prompt }),
          });
        }
        const promptContext = await prepareEmbeddedAttemptPromptContext({
          attempt: { config: turnCfg, skillsSnapshot: prepared.skillsSnapshot,
            sessionId: sessionEntry.sessionId, sessionKey: "agent:main:row-a", contextTokenBudget: 32000 },
          capabilityToolNames: new Set(["read", "computer"]),
          includeBoundaryTimestamp: false, isRawModelRun: false,
          messages: history, prompt: { effectivePrompt: "Fixed current turn", effectiveTranscriptPrompt: "Fixed current turn" },
          replaceSessionMessages: () => {}, sessionAgentId: "main", systemPromptText: systemPrompt,
          toolResultPromptProjectionState: { replacements: new Map(), frozen: new Set(), ambiguousBaseKeys: new Set(), restoredCacheTtl: new Map(), sourceHashByKey: new Map() },
        });
        const modelMessages = convertToLlm(promptContext.hookMessagesForCurrentPrompt);
        const response = createSseResponse([
          anthropicMessageStart({
            id: "synthetic-response",
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 0, output_tokens: 0 }),
          { type: "message_stop" },
        ]);
        responses.push(await response.clone().text());
        configureAiTransportHost(syntheticTransportHost);
        const beforeCaptureCount = requests.length;
        guardedFetch.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
          const wireBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
          const body = new TextDecoder("utf-8", { fatal: true }).decode(wireBytes);
          expect(Buffer.from(body, "utf8")).toEqual(Buffer.from(wireBytes));
          await fs.writeFile(path.join(output, presence + ".request.json"), wireBytes);
          requests.push({
            state: presence,
            body,
            payload: JSON.parse(body),
            roster: prepared.skillsSnapshot!.skills.map((s) => s.name),
            snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
            canExec: eligibility.canExec,
          });
          return response;
        });
        const completion = await stream(
            model,
            { systemPrompt, messages: modelMessages, tools },
            {
              apiKey: "synthetic-not-a-credential",
              cacheRetention: "long",
              sessionId: sessionEntry.sessionId,
            },
          ).result();
        completions.push(completion);
        await fs.writeFile(path.join(output, "completions.json"), JSON.stringify(completions, null, 2));
        expect(completion.stopReason, JSON.stringify(completion)).not.toBe("error");
        expect(requests.length, "real transport must reach exactly one synthetic fetch per turn").toBe(beforeCaptureCount + 1);
      }
      expect(requests).toHaveLength(7);
      for (const request of requests)
        await fs.writeFile(path.join(output, request.state + ".request.json"), request.body);
      await fs.writeFile(path.join(output, "responses.json"), JSON.stringify(responses, null, 2));
      await fs.writeFile(
        path.join(output, "completions.json"),
        JSON.stringify(completions, null, 2),
      );
      const systemBytes = (r: (typeof requests)[number]) =>
        Buffer.from(JSON.stringify(r.payload.system));
      const offset = (a: Buffer, b: Buffer) => {
        let i = 0;
        while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        return i === a.length && i === b.length ? null : i;
      };
      const pairs = [
        [0, 1],
        [1, 2],
      ].map(([a, b]) => ({
        from: requests[a].state,
        to: requests[b].state,
        requestFirstDifferingByte: offset(
          Buffer.from(requests[a].body),
          Buffer.from(requests[b].body),
        ),
        systemFirstDifferingByte: offset(systemBytes(requests[a]), systemBytes(requests[b])),
      }));
      await fs.writeFile(
        path.join(output, "observations.json"),
        JSON.stringify(
          {
            noPhysicalNode: true,
            sessionId: sessionEntry.sessionId,
            pairs,
            requests: requests.map(({ body, payload, ...r }) => ({
              ...r,
              preHistoryNote: JSON.stringify(payload.system).includes(
                "Remote macOS node available",
              ),
              messages: payload.messages,
              tools: payload.tools,
              system: payload.system,
            })),
          },
          null,
          2,
        ),
      );
      await fs.writeFile(path.join(output, "legacy-controls.json"), JSON.stringify(legacyControls, null, 2));
      const messages = (r: (typeof requests)[number]) => {
        if (!Array.isArray(r.payload.messages)) throw new Error("Expected serialized messages array");
        return r.payload.messages;
      };
      expect(requests.map((r) => r.roster)).toEqual(Array.from({length: 7}, () => ["fixed"]));
      expect(messages(requests[0])[0]).toEqual(messages(requests[1])[0]);
      expect(messages(requests[1])[0]).toEqual(messages(requests[2])[0]);
      expect(requests[0].payload.tools).toEqual(requests[1].payload.tools);
      expect(requests[1].payload.tools).toEqual(requests[2].payload.tools);
      // Expected RED on baseline: a live availability note rewrites pre-history system bytes.
      expect(systemBytes(requests[1])).toEqual(systemBytes(requests[0]));
      expect(systemBytes(requests[2])).toEqual(systemBytes(requests[0]));
      expect(JSON.stringify(requests[0].payload.messages)).toContain("Remote macOS node available");
      expect(JSON.stringify(requests[1].payload.messages)).toContain("Remote macOS execution is unavailable for this turn.");
      expect(JSON.stringify(requests[2].payload.messages)).toContain("Remote macOS node available");
      expect(requests[0].body).toBe(requests[2].body);
      expect(requests[3].body).toBe(requests[2].body);
      for (const request of requests.slice(3)) {
        expect(systemBytes(request)).toEqual(systemBytes(requests[0]));
      }
      for (const request of requests.slice(4)) {
        expect(JSON.stringify(request.payload.messages)).not.toContain("Remote macOS node available");
      }
      expect(JSON.stringify(requests[6].payload.messages)).not.toContain("Remote macOS execution");
    });
  } finally {
    removeRemoteNodeInfo(nodeId);
    setSkillsRemoteRegistry(null);
    clearAgentRunContext(runId);
    await closeSkillsWatchers();
    configureAiTransportHost(originalHost);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
}, 60_000);
