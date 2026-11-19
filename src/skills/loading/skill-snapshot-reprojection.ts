import type { SkillSnapshot } from "../types.js";
import { formatSkillsForPromptBounded, prepareSkillsForPrompt } from "./skill-prompt-limits.js";

/** Remap only the admitted set, retaining the incoming legacy or separated shape. */
export function reprojectSkillSnapshot(
  snapshot: SkillSnapshot,
  resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]>,
  options: Omit<Parameters<typeof prepareSkillsForPrompt>[0], "skills" | "remoteNote"> = {},
): SkillSnapshot {
  const renderOptions = { skills: resolvedSkills, preserveOrder: true, ...options };
  if (hasCurrentSkillSnapshotProjection(snapshot)) {
    const prepared = prepareSkillsForPrompt({ ...renderOptions, remoteNote: snapshot.remoteNote });
    return {
      ...snapshot,
      resolvedSkills,
      prompt: prepared.prompt,
      catalogPrompt: prepared.catalogPrompt,
    };
  }
  // Base remapping does not carry an availability prefix. Do not infer or promote old snapshots.
  const { catalogPrompt: _catalogPrompt, ...legacySnapshot } = snapshot;
  return { ...legacySnapshot, resolvedSkills, prompt: formatSkillsForPromptBounded(renderOptions) };
}

/** Pair consistency is not proof that the strings describe the admitted delivery. */
export function hasCurrentSkillSnapshotProjection(snapshot: SkillSnapshot): boolean {
  if (typeof snapshot.catalogPrompt !== "string") return false;
  const catalog = snapshot.catalogPrompt;
  if (snapshot.prompt === catalog) return true;
  const note = snapshot.remoteNote;
  return Boolean(note && snapshot.prompt === (catalog ? `${note}\n${catalog}` : note));
}

export function assertCurrentSkillSnapshotProjection(snapshot: SkillSnapshot): void {
  if (!hasCurrentSkillSnapshotProjection(snapshot)) {
    const error = new Error(
      "Reprojected skills snapshot does not satisfy the current prompt projection invariant.",
    );
    error.name = "SkillsProjectionInvariantError";
    throw error;
  }
}
