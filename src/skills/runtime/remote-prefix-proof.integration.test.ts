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
import { prepareEmbeddedSessionState } from "../../agents/command/session-preparation.js";
import { resolveNodeExecEligibilityAsync } from "../../agents/exec-defaults.js";
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
      const tools = [
        { name: computer.name, description: computer.description, parameters: computer.parameters },
      ];
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
      const completions: unknown[] = [];
      const stream = createAnthropicMessagesTransportStreamFn();
      for (const presence of ["online-1", "offline", "online-2"]) {
        if (presence === "offline") {
          const retired = connected!.connId;
          connected = undefined;
          expect(removeRemoteNodeInfoForConnection(nodeId, retired)).toBe(true);
        } else {
          connected = testRemoteSession(nodeId, {
            connId: presence === "online-1" ? "c1" : "c2",
            displayName: "Fixed proof Mac",
            commands: ["system.run"],
          });
          recordRemoteNodeInfo(connected);
        }
        const eligibility = await resolveNodeExecEligibilityAsync({
          cfg,
          sessionEntry,
          agentId: "main",
        });
        expect(eligibility.canExec).toBe(true);
        const remote = getRemoteSkillEligibility({ advertiseExecNode: eligibility.canExec });
        expect(Boolean(remote?.note)).toBe(presence !== "offline");
        const prepared = await prepareEmbeddedSessionState({
          cfg,
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
        const systemPrompt = buildAgentSystemPrompt({
          workspaceDir,
          skillsPrompt: prepared.skillsSnapshot!.prompt,
          toolNames: [computer.name],
          runtimeInfo: { agentId: "main", host: "fixed-proof-host", model: model.id },
        });
        const response = createSseResponse([
          anthropicMessageStart({
            id: "synthetic-response",
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 0, output_tokens: 0 }),
          { type: "message_stop" },
        ]);
        responses.push(await response.clone().text());
        guardedFetch.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
          expect(typeof init.body).toBe("string");
          const body = init.body as string;
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
        completions.push(
          await stream(
            model,
            { systemPrompt, messages: history, tools },
            {
              apiKey: "synthetic-not-a-credential",
              cacheRetention: "long",
              sessionId: sessionEntry.sessionId,
            },
          ).result(),
        );
      }
      expect(requests).toHaveLength(3);
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
        return i;
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
      expect(requests.map((r) => r.roster)).toEqual([["fixed"], ["fixed"], ["fixed"]]);
      expect(requests[0].payload.messages).toEqual(requests[1].payload.messages);
      expect(requests[1].payload.messages).toEqual(requests[2].payload.messages);
      expect(requests[0].payload.tools).toEqual(requests[1].payload.tools);
      expect(requests[1].payload.tools).toEqual(requests[2].payload.tools);
      // Expected RED on baseline: a live availability note rewrites pre-history system bytes.
      expect(systemBytes(requests[1])).toEqual(systemBytes(requests[0]));
    });
  } finally {
    removeRemoteNodeInfo(nodeId);
    setSkillsRemoteRegistry(null);
    clearAgentRunContext(runId);
    await closeSkillsWatchers();
    configureAiTransportHost(originalHost);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}, 60_000);
