import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveAgentSkillsLimits } from "../discovery/agent-filter.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillSnapshot } from "../types.js";
import { prepareSkillsForPrompt } from "./skill-prompt-limits.js";

/** Re-render only the already admitted set; never rediscover or replace selection metadata. */
export function reprojectSkillSnapshot(
  snapshot: SkillSnapshot,
  resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]>,
  options: Omit<Parameters<typeof prepareSkillsForPrompt>[0], "skills"> & {
    config?: OpenClawConfig;
    agentId?: string;
  } = {},
): SkillSnapshot {
  const { config, agentId, ...renderOptions } = options;
  const limits = config?.skills?.limits;
  const agentLimits = resolveEffectiveAgentSkillsLimits(config, agentId);
  const prepared = prepareSkillsForPrompt({
    skills: resolvedSkills,
    preserveOrder: true,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt,
    maxSkillsPromptChars: agentLimits?.maxSkillsPromptChars ?? limits?.maxSkillsPromptChars,
    ...renderOptions,
  });
  return {
    ...snapshot,
    resolvedSkills,
    prompt: prepared.prompt,
    catalogPrompt: prepared.catalogPrompt,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}

/** Pair consistency is not proof that the strings describe the admitted delivery. */
export function hasCurrentSkillSnapshotProjection(snapshot: SkillSnapshot): boolean {
  if (
    snapshot.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION ||
    typeof snapshot.catalogPrompt !== "string"
  )
    return false;
  const catalog = snapshot.catalogPrompt;
  if (snapshot.prompt === catalog) return true;
  const note = snapshot.remoteNote;
  return Boolean(note && snapshot.prompt === (catalog ? `${note}\n${catalog}` : note));
}
