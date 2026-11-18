import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { projectSkillSnapshot } from "../runtime/refresh.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { hasUnavailableSkillSecretOwners, isSkillSecretOwnerUnavailable } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import { compactSkillsPromptForContext, escapeSkillXml } from "./skill-contract.js";
import {
  assertCurrentSkillSnapshotProjection,
  hasCurrentSkillSnapshotProjection,
  reprojectSkillSnapshot,
  skillProjectionErrorDetails,
} from "./skill-snapshot-reprojection.js";
import { resolveWorkspaceSkillPromptEntries } from "./workspace-skill-loader.js";

const skillsLogger = createSubsystemLogger("skills");

type WorkspaceSkillBuildOptions = NonNullable<
  Parameters<typeof resolveWorkspaceSkillPromptEntries>[1]
> & {
  preserveEntryOrder?: boolean;
};

export async function buildSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): Promise<SkillSnapshot> {
  const { eligible, skillFilter } = await resolveWorkspaceSkillPromptEntries(workspaceDir, opts);
  const agent =
    opts?.config && opts.agentId ? resolveAgentEntry(opts.config, opts.agentId) : undefined;
  const snapshot = await projectSkillSnapshot({
    workspaceDir,
    eligible,
    skillFilter,
    // Eligibility is already selected. Rendering needs no channel, provider, or plugin config.
    config: opts?.config
      ? {
          skills: { limits: opts.config.skills?.limits },
          ...(agent
            ? {
                agents: {
                  entries: {
                    [agent.id]: { agentDir: agent.agentDir, skillsLimits: agent.skillsLimits },
                  },
                },
              }
            : {}),
        }
      : undefined,
    agentId: opts?.agentId,
    skillOverrides: opts?.skillOverrides,
    eligibility: opts?.eligibility
      ? {
          nodeSkills: opts.eligibility.nodeSkills,
          remote: opts.eligibility.remote ? { note: opts.eligibility.remote.note } : undefined,
        }
      : undefined,
    preserveEntryOrder: opts?.preserveEntryOrder,
    snapshotVersion: opts?.snapshotVersion,
  });
  opts?.assertCurrent?.();
  return snapshot;
}

type ResolveSkillsPromptParams = {
  separateRemoteNote?: boolean;
  onLegacyPromptFallback?: () => void;
  contextTokenBudget?: number;
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  loadEntries?: () => SkillEntry[] | Promise<SkillEntry[]>;
  preserveEntryOrder?: boolean;
  assertCurrent?: () => void;
};

async function buildSkillsPromptFromEntries(
  params: ResolveSkillsPromptParams,
  entries: SkillEntry[] | undefined,
): Promise<string> {
  if (!entries || entries.length === 0) {
    return "";
  }
  const snapshot = await buildSkillSnapshot(params.workspaceDir, {
    ...params,
    entries,
  });
  const prompt = params.separateRemoteNote ? (snapshot.catalogPrompt ?? "") : snapshot.prompt;
  return prompt.trim() ? prompt : "";
}

async function rebuildAfterUnsafeSnapshot(
  params: ResolveSkillsPromptParams,
  reason: "unsupported-prompt-format" | "legacy-skill-identity" | "invalid-catalog-structure",
): Promise<string> {
  skillsLogger.warn(
    "Cached skills prompt could not be safely filtered; rebuilding from current skill entries.",
    { reason },
  );
  const sourceEntries = params.entries ?? (await params.loadEntries?.());
  const entries = sourceEntries?.filter(
    (entry) => !isSkillSecretOwnerUnavailable(resolveSkillKey(entry)),
  );
  return buildSkillsPromptFromEntries(params, entries);
}

function hasUnavailableSnapshotSkillOwners(snapshot: SkillSnapshot): boolean {
  return (
    snapshot.skills.some((skill) => isSkillSecretOwnerUnavailable(skill.skillKey ?? skill.name)) ||
    (snapshot.skills.some((skill) => !skill.skillKey) && hasUnavailableSkillSecretOwners())
  );
}

/** Legacy exclusion and degraded-owner decisions take precedence over projection repair. */
export function shouldPreserveLegacySkillSnapshotPrompt(snapshot: SkillSnapshot): boolean {
  return !snapshot.prompt.trim() || hasUnavailableSnapshotSkillOwners(snapshot);
}

async function resolveSkillsPromptCatalog(params: ResolveSkillsPromptParams): Promise<string> {
  if (
    params.separateRemoteNote &&
    params.skillsSnapshot &&
    shouldPreserveLegacySkillSnapshotPrompt(params.skillsSnapshot)
  ) {
    params.assertCurrent?.();
    params.onLegacyPromptFallback?.();
    return readSkillsPromptCatalog({ ...params, separateRemoteNote: false });
  }

  if (
    params.separateRemoteNote &&
    params.skillsSnapshot &&
    !hasCurrentSkillSnapshotProjection(params.skillsSnapshot)
  ) {
    const snapshot = params.skillsSnapshot;
    let failure: unknown = new Error(
      "Snapshot has no resolved skills or available loader entries.",
    );
    try {
      if (snapshot.resolvedSkills !== undefined) {
        const remoteNote = params.eligibility
          ? params.eligibility.remote?.note
          : snapshot.remoteNote;
        const projected = reprojectSkillSnapshot(
          { ...snapshot, remoteNote },
          snapshot.resolvedSkills,
          {
            config: params.config,
            agentId: params.agentId,
            remoteNote,
          },
        );
        assertCurrentSkillSnapshotProjection(projected);
        return await readSkillsPromptCatalog({ ...params, skillsSnapshot: projected });
      }
      const entries = params.entries ?? (await params.loadEntries?.());
      if (entries !== undefined) return await buildSkillsPromptFromEntries(params, entries);
    } catch (error) {
      failure = error;
      // Do not turn lost read authority into permission to use a retained prompt.
      params.assertCurrent?.();
    }
    params.assertCurrent?.();
    params.onLegacyPromptFallback?.();
    skillsLogger.warn(
      "Using legacy skills prompt for this turn; separated projection unavailable.",
      skillProjectionErrorDetails(failure),
    );
    return readSkillsPromptCatalog({ ...params, separateRemoteNote: false });
  }
  return readSkillsPromptCatalog(params);
}

// Reading never retries projection recovery: a malformed projector cannot re-enter the guard.
async function readSkillsPromptCatalog(params: ResolveSkillsPromptParams): Promise<string> {
  const snapshotPrompt = (
    params.separateRemoteNote ? params.skillsSnapshot?.catalogPrompt : params.skillsSnapshot?.prompt
  )?.trim();
  if (params.skillsSnapshot && !snapshotPrompt) {
    return "";
  }
  const snapshotHasLegacySkillIdentity = params.skillsSnapshot?.skills.some(
    (skill) => !skill.skillKey,
  );
  if (snapshotPrompt) {
    const snapshotHasUnavailableSkill = params.skillsSnapshot
      ? hasUnavailableSnapshotSkillOwners(params.skillsSnapshot)
      : false;
    if (
      snapshotHasUnavailableSkill &&
      params.skillsSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION
    ) {
      return rebuildAfterUnsafeSnapshot(params, "unsupported-prompt-format");
    }
    if (snapshotHasLegacySkillIdentity && hasUnavailableSkillSecretOwners()) {
      return rebuildAfterUnsafeSnapshot(params, "legacy-skill-identity");
    }
    const unavailableNames = new Set(
      params.skillsSnapshot?.skills
        .filter(
          (skill) => skill.skillKey !== undefined && isSkillSecretOwnerUnavailable(skill.skillKey),
        )
        .map((skill) => escapeSkillXml(skill.name)),
    );
    if (unavailableNames.size === 0) {
      return snapshotPrompt;
    }
    const catalogOpen = "<available_skills>";
    const catalogClose = "</available_skills>";
    const catalogStart = snapshotPrompt.indexOf(catalogOpen);
    const catalogEnd = snapshotPrompt.indexOf(catalogClose, catalogStart + catalogOpen.length);
    if (
      catalogStart < 0 ||
      catalogEnd < 0 ||
      snapshotPrompt.includes(catalogOpen, catalogStart + catalogOpen.length) ||
      snapshotPrompt.includes(catalogClose, catalogEnd + catalogClose.length)
    ) {
      return rebuildAfterUnsafeSnapshot(params, "invalid-catalog-structure");
    }
    const bodyStart = catalogStart + catalogOpen.length;
    const catalogBody = snapshotPrompt.slice(bodyStart, catalogEnd);
    const blockPattern = /\n[ ]{2}<skill>\n[\s\S]*?\n[ ]{2}<\/skill>/g;
    let cursor = 0;
    let filteredBody = "";
    for (const match of catalogBody.matchAll(blockPattern)) {
      const gap = catalogBody.slice(cursor, match.index);
      const block = match[0];
      const name = /^[ ]{4}<name>(.*)<\/name>$/m.exec(block)?.[1];
      if (gap.trim() || !name) {
        return rebuildAfterUnsafeSnapshot(params, "invalid-catalog-structure");
      }
      filteredBody += gap;
      if (!unavailableNames.has(name)) {
        filteredBody += block;
      }
      cursor = match.index + block.length;
    }
    const tail = catalogBody.slice(cursor);
    if (tail.trim()) {
      return rebuildAfterUnsafeSnapshot(params, "invalid-catalog-structure");
    }
    return `${snapshotPrompt.slice(0, bodyStart)}${filteredBody}${tail}${snapshotPrompt.slice(catalogEnd)}`.trim();
  }
  return buildSkillsPromptFromEntries(params, params.entries);
}

export async function resolveSkillsPrompt(params: ResolveSkillsPromptParams): Promise<string> {
  return compactSkillsPromptForContext(
    await resolveSkillsPromptCatalog(params),
    params.contextTokenBudget,
  );
}
