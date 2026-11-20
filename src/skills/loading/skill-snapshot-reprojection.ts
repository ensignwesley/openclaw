import type { SkillSnapshot } from "../types.js";
import { hasUnavailableSkillSecretOwners, isSkillSecretOwnerUnavailable } from "./config.js";
import {
  formatSkillsForPromptBounded,
  type prepareSkillsForPrompt,
} from "./skill-prompt-limits.js";

export function hasUnavailableSnapshotSkillOwners(snapshot: SkillSnapshot): boolean {
  return (
    snapshot.skills.some((skill) => isSkillSecretOwnerUnavailable(skill.skillKey ?? skill.name)) ||
    (snapshot.skills.some((skill) => !skill.skillKey) && hasUnavailableSkillSecretOwners())
  );
}

/** Every delivery/preparation/reader boundary uses this same input classification. */
export function classifySkillSnapshot(snapshot: SkillSnapshot): "legacy" | "separated" {
  // Empty prompts retain base silence, even when a stored note and empty pair exist.
  return !snapshot.prompt.trim() ||
    !hasCurrentSkillSnapshotProjection(snapshot) ||
    hasUnavailableSnapshotSkillOwners(snapshot)
    ? "legacy"
    : "separated";
}

/** Remap only the admitted set, retaining the input class and availability carrier. */
export function reprojectSkillSnapshot(
  snapshot: SkillSnapshot,
  resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]>,
  options: Omit<Parameters<typeof prepareSkillsForPrompt>[0], "skills" | "remoteNote"> = {},
): SkillSnapshot {
  const inputClass = classifySkillSnapshot(snapshot);
  const catalog = formatSkillsForPromptBounded({
    skills: resolvedSkills,
    preserveOrder: true,
    ...options,
  });
  if (inputClass === "legacy") {
    const { catalogPrompt: _catalogPrompt, ...legacy } = snapshot;
    return { ...legacy, resolvedSkills, prompt: catalog };
  }
  // P carries exactly the input's admitted prefix plus the remapped catalog; never re-budget the note.
  const carriedNote = snapshot.prompt === snapshot.catalogPrompt ? undefined : snapshot.remoteNote;
  return {
    ...snapshot,
    resolvedSkills,
    catalogPrompt: catalog,
    prompt: carriedNote ? (catalog ? `${carriedNote}\n${catalog}` : carriedNote) : catalog,
  };
}

/** Pair consistency is not proof that the strings describe the admitted delivery. */
function hasCurrentSkillSnapshotProjection(snapshot: SkillSnapshot): boolean {
  if (typeof snapshot.catalogPrompt !== "string") {
    return false;
  }
  const catalog = snapshot.catalogPrompt;
  if (snapshot.prompt === catalog) {
    return true;
  }
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
