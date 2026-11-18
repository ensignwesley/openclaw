import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillSnapshot } from "../types.js";
import { prepareSkillsForPrompt } from "./skill-prompt-limits.js";

/** Re-render only the already admitted set; never rediscover or replace selection metadata. */
export function reprojectSkillSnapshot(
  snapshot: SkillSnapshot,
  resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]>,
  options: Omit<Parameters<typeof prepareSkillsForPrompt>[0], "skills"> = {},
): SkillSnapshot {
  const prepared = prepareSkillsForPrompt({
    skills: resolvedSkills,
    preserveOrder: true,
    ...options,
  });
  return {
    ...snapshot,
    resolvedSkills,
    prompt: prepared.prompt,
    catalogPrompt: prepared.catalogPrompt,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}
