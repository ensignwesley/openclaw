import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it, vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams,
  resetThreadLifecycleTestFixtures,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
afterEach(resetThreadLifecycleTestFixtures);

// RED-only integration. Native RPC is synthetic, not the lifecycle or CAS store.
it("durably accounts for a pending assignment across a runtime-version-only change", async () => {
  const output = process.env.FINGERPRINT_RECEIPTS_DIR;
  if (!output) throw new Error("FINGERPRINT_RECEIPTS_DIR must preserve the result");
  await fs.mkdir(output, { recursive: true });
  const root = temps.make("codex-runtime-version-proof-");
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const stateRoot = path.join(root, "private-state");
  const stateOptions = {
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot },
  };
  const state = createCodexSqliteTestBindingStateStore(stateOptions);
  const store = createCodexAppServerBindingStore(state);
  const params = createParams(path.join(root, "session.jsonl"), cwd);
  params.disableTools = false;
  params.agentId = "main";
  const identity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  const key = bindingStoreKey(identity);
  const appServer = createAppServerOptions();
  const versionFingerprint = (appServerVersion: string) =>
    buildCodexAppServerRuntimeFingerprint({ appServer, appServerVersion });
  const v1 = versionFingerprint("0.164.0");
  const v2 = versionFingerprint("0.164.1");
  expect(JSON.parse(v2)).toEqual({ ...JSON.parse(v1), appServerVersion: "0.164.1" });
  let starts = 0;
  const wire = await createLeasedCodexLifecycleHarness({
    agentDir: root,
    respond: async (method) => {
      if (method === "config/read") return { config: {}, origins: {}, layers: [] };
      if (method === "configRequirements/read") return { requirements: null };
      if (method === "account/read") return { account: { type: "apiKey" } };
      if (method === "thread/start") return threadStartResult(`version-parent-${++starts}`);
      if (method === "thread/delete") return {};
      throw new Error(`Unexpected synthetic native request: ${method}`);
    },
  });
  const options: CodexStartOrResumeThreadParams = {
    client: wire.client,
    bindingStore: store,
    params,
    cwd,
    dynamicTools: [],
    appServer,
    nativeCodeModeEnabled: true,
    userMcpServersEnabled: false,
    mcpServersFingerprint: "fixed-mcp",
    mcpServersFingerprintEvaluated: true,
    appServerRuntimeFingerprint: v1,
  };
  const debug = vi.spyOn(embeddedAgentLog, "debug");
  const warn = vi.spyOn(embeddedAgentLog, "warn");
  const parent = await startOrResumeThread(options);
  await retainCodexAppServerLiveThread(
    wire.client,
    parent.threadId,
    async (threadId, assertCurrent, withCurrent) => {
      await wire.client.request("thread/unsubscribe", { threadId }, { assertCurrent, withCurrent });
    },
    parent.liveThreadConfigFingerprint,
  );
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: parent.threadId,
    sessionId: params.sessionId,
    binding: parent,
  });
  assert(owner);
  const assignment: CodexNativeSubagentPendingAssignment = {
    runId: "codex-thread:proof-finished-child",
    childThreadId: "proof-finished-child",
    nativeParentThreadId: parent.threadId,
    owner,
    recordedCompletion: {
      childThreadId: "proof-finished-child",
      status: "succeeded",
      statusLabel: "recorded_task_result",
      result: "Synthetic finished result, still pending requester delivery",
      completedAt: 1000,
    },
  };
  let authorityActive = true;
  const assertCurrent = () => assert(authorityActive, "synthetic admitted authority closed");
  expect(
    await store.mutate(
      identity,
      { kind: "record-native-subagent-assignment", owner, assignment },
      assertCurrent,
    ),
  ).toBe(true);
  expect(await store.readNativeSubagentAssignments(identity, owner)).toEqual([assignment]);
  const before = await state.asyncReads.lookup(key);
  await fs.writeFile(path.join(output, "before.json"), JSON.stringify(before, null, 2));
  // Change ONLY this actual lifecycle input; no MCP, account, scope or requester change.
  const successor = await startOrResumeThread({ ...options, appServerRuntimeFingerprint: v2 });
  const after = await state.asyncReads.lookup(key);
  expect(starts).toBe(2);
  expect(successor.threadId).not.toBe(parent.threadId);
  expect(successor.appServerRuntimeFingerprint).toBe(v2);
  expect(successor.cwd).toBe(parent.cwd);
  expect(successor.connectionScope).toBe(parent.connectionScope);
  expect(successor.authProfileId).toBe(parent.authProfileId);
  await fs.writeFile(path.join(output, "after.json"), JSON.stringify(after, null, 2));
  await fs.writeFile(
    path.join(output, "rpc.json"),
    JSON.stringify(wire.request.mock.calls, null, 2),
  );
  await fs.writeFile(
    path.join(output, "logs.json"),
    JSON.stringify({ debug: debug.mock.calls, warn: warn.mock.calls }, null, 2),
  );
  authorityActive = false;
  // Await the production worker lifecycle before native cold SQLite inspection.
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  const dbPath = path.join(stateRoot, "state", "openclaw.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let coldRows: Array<Record<string, unknown>>;
  let related: Record<string, unknown[]> = {};
  try {
    coldRows = db
      .prepare("SELECT * FROM plugin_state_entries WHERE plugin_id='codex' ORDER BY namespace,key")
      .all();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name));
    for (const name of names.filter(
      (n) => /^(task|completion|delivery|retirement)/.test(n) && /^[a-zA-Z0-9_]+$/.test(n),
    )) {
      related[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    }
  } finally {
    db.close();
  }
  await fs.copyFile(dbPath, path.join(output, "synthetic-state.sqlite"));
  await fs.writeFile(path.join(output, "cold-codex-rows.json"), JSON.stringify(coldRows, null, 2));
  await fs.writeFile(path.join(output, "cold-related-rows.json"), JSON.stringify(related, null, 2));
  const coldStore = createCodexAppServerBindingStore(
    createCodexSqliteTestBindingStateStore(stateOptions),
  );
  const newOwner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: successor.threadId,
    sessionId: params.sessionId,
    binding: successor,
  });
  assert(newOwner);
  const currentInventory = await coldStore.readNativeSubagentAssignments(identity, newOwner);
  const oldInventory = await coldStore.readNativeSubagentAssignments(identity, owner);
  const marker = assignment.childThreadId;
  const codexRowsWithLocator = coldRows.filter((row) => JSON.stringify(row).includes(marker));
  const taskRowsWithLocator = Object.values(related)
    .flat()
    .filter((row) => JSON.stringify(row).includes(marker));
  await fs.writeFile(
    path.join(output, "observations.json"),
    JSON.stringify(
      {
        inputBefore: JSON.parse(v1),
        inputAfter: JSON.parse(v2),
        identity,
        nativeRpcSynthetic: true,
        noGatewayProcess: true,
        realSqliteCasStore: true,
        assignment,
        parent,
        successor,
        currentInventory,
        oldInventory,
        codexRowsWithLocator,
        taskRowsWithLocator,
        dispositionsScope:
          "all Codex plugin rows and task/completion/delivery/retirement-named tables in this isolated state DB; native monitor not started",
      },
      null,
      2,
    ),
  );
  // Proposed observability invariant, not permission to deliver across changed authority.
  // Current main is RED if neither pending locator nor a durable outcome remains.
  expect(
    currentInventory.length + codexRowsWithLocator.length + taskRowsWithLocator.length,
  ).toBeGreaterThan(0);
}, 60_000);
