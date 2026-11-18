import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { settleCurrentReadPreparations } from "../../shared/current-read-authority.js";
import { prepareSkillLibrarySelection } from "../../skills/library/selection.js";
import {
  assertCurrentSkillSnapshotProjection,
  hasCurrentSkillSnapshotProjection,
  reprojectSkillSnapshot,
  skillProjectionErrorDetails,
} from "../../skills/loading/skill-snapshot-reprojection.js";
import {
  buildSkillSnapshot,
  resolveSkillsPrompt,
  shouldPreserveLegacySkillSnapshotPrompt,
} from "../../skills/loading/workspace-skill-prompt.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveSkillResourceCandidates } from "../../skills/runtime/resource-candidates.js";
import { hasAgentRosterProperty, resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import type { SandboxContext } from "../sandbox/types.js";
import { resolveSessionSkillResourceSnapshot } from "../session-placement-skill-resources.js";
import { isToolExecutionAllowed } from "../tool-policy-shared.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import { prepareRuntimeSkillEntries } from "./skills-prompt.js";

const skillsLogger = createSubsystemLogger("skills");

/** Prepares readable skills and owns environment rollback until the caller takes custody. */
export async function prepareEmbeddedSkills(params: {
  /** Prompt-only callers can skip process-wide environment overrides. */
  applySkillEnvironment?: boolean;
  separateRemoteNote?: boolean;
  assertCurrent?: () => void;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "config"
    | "bootstrapWorkspaceDir"
    | "skillsSnapshot"
    | "contextTokenBudget"
    | "toolExecutionAllow"
    | "operation"
    | "sessionPersistence"
    | "disableTools"
    | "modelRun"
    | "promptMode"
  >;
  effectiveWorkspace: string;
  sandbox: SandboxContext | null | undefined;
  sessionAgentId: string;
  includeCodeModeSkills: boolean;
}) {
  const executionAllow = params.attempt.toolExecutionAllow;
  // Retained schemas are not execution permission. An unreadable skill catalog
  // creates impossible prerequisites and exposes an ungated Code Mode reader.
  // Detached tool-free raw requests consume neither skills nor their environment.
  if (
    params.attempt.operation === "settled-tool-finalization" ||
    (params.attempt.sessionPersistence === "detached" &&
      params.attempt.disableTools === true &&
      (params.attempt.modelRun === true || params.attempt.promptMode === "none")) ||
    (executionAllow && !isToolExecutionAllowed(executionAllow, "read"))
  ) {
    return {
      restoreSkillEnv: () => {},
      skillUsagePaths: undefined,
      skillsPrompt: "",
      legacySkillsPromptFallback: false,
      skillsSnapshotForRun: undefined,
      skillReadResources: undefined,
      codeModeSkills: [],
      installedSkills: [],
    };
  }
  const {
    skillsEligibility,
    skillUsagePaths,
    skillsPromptWorkspaceDir,
    skillsSnapshot: preparedSnapshot,
    skillsWorkspaceDir,
    shouldLoadSkillEntries,
    skillEntries,
    loadSkillEntries,
    preserveEntryOrder,
    mapEntries,
  } = await prepareRuntimeSkillEntries({
    sandbox: params.sandbox,
    skillsAnchorWorkspace:
      params.attempt.config && hasAgentRosterProperty(params.attempt.config)
        ? resolveAgentWorkspaceDir(params.attempt.config, params.sessionAgentId)
        : (params.attempt.bootstrapWorkspaceDir ?? params.effectiveWorkspace),
    skillsSnapshot: params.attempt.skillsSnapshot,
    assertCurrent: params.assertCurrent,
    config: params.attempt.config,
    agentId: params.sessionAgentId,
    executionWorkspaceDir: params.effectiveWorkspace,
  });
  let restoreSkillEnv = () => {};
  try {
    const promptSkillEntries = mapEntries(shouldLoadSkillEntries ? skillEntries : undefined);
    const preserveLegacyPrompt = Boolean(
      params.separateRemoteNote &&
      preparedSnapshot &&
      shouldPreserveLegacySkillSnapshotPrompt(preparedSnapshot),
    );
    const rebuildSeparatedSnapshot =
      params.separateRemoteNote &&
      preparedSnapshot &&
      !preserveLegacyPrompt &&
      !hasCurrentSkillSnapshotProjection(preparedSnapshot);
    const runEligibility =
      skillsEligibility ??
      (preparedSnapshot?.nodeSkillsEligibility
        ? {
            nodeSkills: preparedSnapshot.nodeSkillsEligibility,
            remote: getRemoteSkillEligibility({
              advertiseExecNode: preparedSnapshot.nodeSkillsEligibility.canExec,
            }),
          }
        : undefined);
    let skillsSnapshot = preparedSnapshot;
    let legacySkillsPromptFallback = preserveLegacyPrompt;
    if (!skillsSnapshot || rebuildSeparatedSnapshot) {
      const retained = skillsSnapshot;
      try {
        if (retained?.resolvedSkills !== undefined) {
          const remoteNote = runEligibility?.remote?.note;
          skillsSnapshot = reprojectSkillSnapshot(
            { ...retained, remoteNote },
            retained.resolvedSkills,
            {
              config: params.attempt.config,
              agentId: params.sessionAgentId,
              remoteNote,
            },
          );
        } else {
          skillsSnapshot = await buildSkillSnapshot(skillsPromptWorkspaceDir, {
            entries:
              promptSkillEntries ??
              (rebuildSeparatedSnapshot ? (mapEntries(await loadSkillEntries()) ?? []) : []),
            config: params.attempt.config,
            agentId: params.sessionAgentId,
            eligibility: runEligibility,
            preserveEntryOrder,
            assertCurrent: params.assertCurrent,
          });
        }
        if (params.separateRemoteNote) assertCurrentSkillSnapshotProjection(skillsSnapshot);
      } catch (error) {
        if (!params.separateRemoteNote || !retained) throw error;
        params.assertCurrent?.();
        skillsSnapshot = retained;
        legacySkillsPromptFallback = true;
        skillsLogger.warn(
          "Using legacy skills prompt for this turn; separated projection unavailable.",
          skillProjectionErrorDetails(error),
        );
      }
    }
    const [skillsPrompt, libraryEntries] = await settleCurrentReadPreparations([
      resolveSkillsPrompt({
        separateRemoteNote: params.separateRemoteNote && !legacySkillsPromptFallback,
        onLegacyPromptFallback: () => {
          legacySkillsPromptFallback = true;
        },
        assertCurrent: params.assertCurrent,
        contextTokenBudget: params.attempt.contextTokenBudget,
        skillsSnapshot,
        entries: promptSkillEntries,
        loadEntries: async () => mapEntries(await loadSkillEntries()) ?? [],
        config: params.attempt.config,
        workspaceDir: skillsPromptWorkspaceDir,
        agentId: params.sessionAgentId,
        eligibility: runEligibility,
        preserveEntryOrder,
      }),
      params.sandbox?.enabled
        ? []
        : prepareSkillLibrarySelection(
            skillsSnapshot.librarySelections ?? [],
            {},
            params.assertCurrent ?? (() => {}),
          ),
    ] as const);
    params.assertCurrent?.();
    // Preparation may yield to abort/revocation. Apply process-wide overrides only
    // once all filesystem work has settled and this caller can take custody.
    restoreSkillEnv =
      params.applySkillEnvironment === false
        ? () => {}
        : preparedSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: preparedSnapshot,
              config: params.attempt.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries,
              config: params.attempt.config,
            });
    const installedSkills = prepareInstalledSkillCatalog({
      snapshot: skillsSnapshot,
      workspaceDir: skillsWorkspaceDir,
      sandbox: params.sandbox,
      assertCurrent: params.assertCurrent,
    });
    const codeModeSkills = params.includeCodeModeSkills ? installedSkills : [];
    // Host read exceptions use exact eligible resources without changing model visibility.
    // Sandboxes keep their existing materialized paths; never resolve host library pins there.
    const skillReadResources = params.sandbox?.enabled
      ? undefined
      : resolveSkillResourceCandidates(skillsSnapshot, libraryEntries);
    return {
      restoreSkillEnv,
      skillReadResources,
      skillUsagePaths,
      skillsPrompt,
      legacySkillsPromptFallback,
      skillsSnapshotForRun: skillsSnapshot,
      codeModeSkills,
      installedSkills,
    };
  } catch (error) {
    restoreSkillEnv();
    throw error;
  }
}

/** Prepares prompt-only plugin skill inputs from delivered mounts or sandbox copies. */
export async function preparePluginHarnessSkills(
  params: Pick<
    Parameters<typeof prepareEmbeddedSkills>[0],
    "assertCurrent" | "attempt" | "effectiveWorkspace" | "sandbox" | "sessionAgentId"
  >,
) {
  const sandbox = params.sandbox;
  let skillsSnapshot = resolveSessionSkillResourceSnapshot(params.attempt.skillsSnapshot);
  let skillReferencePaths = sandbox?.readOnlyResourceMounts?.map((mount) => ({
    skillFile: path.join(mount.hostPath, "SKILL.md"),
    readPath: path.posix.join(mount.containerPath, "SKILL.md"),
  }));
  if (sandbox?.enabled && !sandbox.readOnlyResourceMounts?.length && skillsSnapshot) {
    const prepared = await prepareEmbeddedSkills({
      ...params,
      applySkillEnvironment: false,
      includeCodeModeSkills: false,
      attempt: { ...params.attempt, skillsSnapshot },
    });
    skillsSnapshot = {
      ...(prepared.skillsSnapshotForRun ?? skillsSnapshot),
      prompt: prepared.skillsPrompt,
    };
    skillReferencePaths = prepared.skillUsagePaths;
  }
  return { skillsSnapshot, skillReferencePaths };
}
