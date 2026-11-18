import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillEntry } from "../types.js";
import { formatSkillsForPromptBounded } from "./skill-prompt-limits.js";
import * as reprojection from "./skill-snapshot-reprojection.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "./workspace-skill-prompt.js";

const loggingMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "skills",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggingMocks.warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  loggingMocks.warn.mockClear();
});

function createEntry(name: string, description = name): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description,
      filePath: `/app/skills/${name}/SKILL.md`,
      baseDir: `/app/skills/${name}`,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
  };
}

const promptWorkspace = "/tmp/openclaw";
const snapshotOf = (entries: SkillEntry[]) => buildSkillSnapshot(promptWorkspace, { entries });
const resolve = (params: Omit<Parameters<typeof resolveSkillsPrompt>[0], "workspaceDir">) =>
  resolveSkillsPrompt({ workspaceDir: promptWorkspace, ...params });

function markUnavailable(skillKey: string) {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId: `skill:${skillKey}`,
      state: "unavailable",
      paths: [`skills.entries.${skillKey}.apiKey`],
      refKeys: ["env:default:MISSING_SKILL_KEY"],
      reason: "secret provider failed",
    },
  ]);
}

describe("resolveSkillsPrompt", () => {
  it.each([
    { label: "full", count: 1, maxChars: 10000, maxCount: 10 },
    { label: "compact", count: 10, maxChars: 1800, maxCount: 10 },
    { label: "truncated", count: 10, maxChars: 1800, maxCount: 2 },
    { label: "note-too-small", count: 1, maxChars: 80, maxCount: 10 },
  ])(
    "keeps catalog-only and legacy parser resources equal via the real renderer: $label",
    async ({ count, maxChars, maxCount }) => {
      const entries = Array.from({ length: count }, (_, index) =>
        createEntry(`skill-${index}`, "Stable guidance. ".repeat(100)),
      );
      const snapshot = await buildSkillSnapshot(promptWorkspace, {
        entries,
        config: {
          skills: { limits: { maxSkillsPromptChars: maxChars, maxSkillsInPrompt: maxCount } },
        },
        eligibility: {
          nodeSkills: { canExec: true },
          remote: {
            note: "Remote macOS node available (Parity Mac). Run macOS-only skills via exec host=node on that node.",
            platforms: ["darwin"],
            hasBin: () => false,
            hasAnyBin: () => false,
          },
        },
      });
      const legacy = resolveCodeModeSkills({
        skillsPrompt: snapshot.prompt,
        candidates: snapshot.resolvedSkills!,
      });
      const catalog = await resolve({ skillsSnapshot: snapshot, separateRemoteNote: true });
      expect(catalog).not.toContain("Remote macOS node available");
      expect(
        resolveCodeModeSkills({ skillsPrompt: catalog, candidates: snapshot.resolvedSkills! }),
      ).toEqual(legacy);
      expect(snapshot.catalogPrompt?.trim()).toBe(catalog);
      if (maxChars > 80) expect(legacy.length).toBeGreaterThan(0);
    },
  );

  it("compacts descriptions without changing admitted skill resources", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => {
      const entry = createEntry(`skill-${index}`);
      entry.skill.description = `Inspect records & preserve <identifiers>. ${"Detailed matching guidance. ".repeat(10)}`;
      entry.skill.locationNote = "Load the complete instruction file at this location.";
      entry.skill.readContent = `${"Complete instruction body. ".repeat(300)}END_${index}`;
      return entry;
    });
    const snapshot = await snapshotOf(entries);
    const original = snapshot.prompt.trim();
    const minimum = original.replace(
      /<description>[\s\S]*?<\/description>/gu,
      "<description>Inspect records &amp; preserve &lt;identifiers&gt;. Detailed matching g...</description>",
    );
    const contextTokenBudget = minimum.length * 5;
    const projected = await resolve({ skillsSnapshot: snapshot, contextTokenBudget });
    expect(projected.length).toBeLessThan(original.length);
    expect(projected).toBe(minimum);
    const omitDescriptions = (prompt: string) =>
      prompt.replace(/<description>[\s\S]*?<\/description>/gu, "");
    expect(omitDescriptions(projected)).toBe(omitDescriptions(original));
    expect(projected).toContain("&amp; preserve &lt;identifiers&gt;");
    expect(snapshot.prompt.trim()).toBe(original);
    expect(await resolve({ skillsSnapshot: snapshot })).toBe(original);
    const resources = resolveCodeModeSkills({
      skillsPrompt: projected,
      candidates: snapshot.resolvedSkills!,
    });
    expect(resources.map((skill) => skill.name)).toEqual(
      snapshot.resolvedSkills!.map((skill) => skill.name),
    );
    for (const resource of resources) {
      expect(await readCodeModeSkill(resource)).toBe(
        entries.find((entry) => entry.skill.name === resource.name)!.skill.readContent,
      );
    }
  });

  it("keeps an empty snapshot authoritative over current entries", async () => {
    const prompt = await resolve({
      skillsSnapshot: { prompt: "", skills: [] },
      entries: [createEntry("new-skill", "New")],
    });
    expect(prompt).toBe("");
  });

  it("fails closed before filtering an unsupported degraded prompt format", async () => {
    markUnavailable("cold-skill");

    const prompt = await resolve({
      skillsSnapshot: {
        prompt:
          "LEAKED COLD INSTRUCTIONS\n<available_skills>\n  <skill>\n    <name>cold-skill</name>\n  </skill>\n</available_skills>",
        skills: [{ name: "cold-skill", skillKey: "cold-skill" }],
        promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION - 1,
      },
    });
    expect(prompt).toBe("");
  });

  it("fails closed for a legacy snapshot whose owner identity is ambiguous", async () => {
    markUnavailable("cold-skill");

    const prompt = await resolve({
      skillsSnapshot: {
        prompt: "LEGACY SKILL PROMPT",
        skills: [{ name: "cold-skill" }, { name: "healthy-skill" }],
      },
    });

    expect(prompt).toBe("");
  });

  it.each(["legacy-skill-identity", "invalid-catalog-structure"])(
    "lazily rebuilds healthy entries for a degraded modern %s snapshot",
    async (reason) => {
      const entries = [createEntry("cold-skill"), createEntry("healthy-skill")];
      const snapshot = await snapshotOf(entries);
      if (reason === "legacy-skill-identity") {
        snapshot.skills = snapshot.skills.map(({ name }) => ({ name }));
      } else {
        snapshot.prompt += "\n<available_skills></available_skills>";
      }
      const loadEntries = vi.fn(() => entries);
      markUnavailable("cold-skill");

      const prompt = await resolve({ skillsSnapshot: snapshot, loadEntries });

      expect(loadEntries).toHaveBeenCalledOnce();
      expect(prompt).not.toContain("cold-skill/SKILL.md");
      expect(prompt).toContain("healthy-skill/SKILL.md");
      expect(loggingMocks.warn).toHaveBeenCalledWith(
        "Cached skills prompt could not be safely filtered; rebuilding from current skill entries.",
        { reason },
      );
    },
  );

  it("matches unavailable owners against a snapshot skill's config key", async () => {
    const cold = { ...createEntry("cold-skill", "Cold"), metadata: { skillKey: "cold-alias" } };
    const healthy: SkillEntry = createEntry("healthy-skill", "Healthy");
    const snapshot = await snapshotOf([cold, healthy]);
    markUnavailable("cold-alias");

    const prompt = await resolve({ skillsSnapshot: snapshot, entries: [cold, healthy] });

    expect(prompt).not.toContain("/app/skills/cold-skill/SKILL.md");
    expect(prompt).toContain("/app/skills/healthy-skill/SKILL.md");
  });

  it("does not add supplied skills outside the saved snapshot during a degraded rebuild", async () => {
    const capturedEntries = [createEntry("cold-skill"), createEntry("healthy-skill")];
    const snapshot = await snapshotOf(capturedEntries);
    markUnavailable("cold-skill");

    const prompt = await resolve({
      skillsSnapshot: snapshot,
      entries: [...capturedEntries, createEntry("new-skill")],
    });

    expect(prompt).not.toContain("/app/skills/cold-skill/SKILL.md");
    expect(prompt).toContain("/app/skills/healthy-skill/SKILL.md");
    expect(prompt).not.toContain("/app/skills/new-skill/SKILL.md");
  });

  it("preserves captured skill content during degraded prompt filtering", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-prompt-"));
    const write = (name: string, description: string) =>
      writeSkill({ dir: path.join(workspaceDir, "skills", name), name, description });
    await write("cold-skill", "Captured cold");
    await write("healthy-skill", "Captured healthy");
    const snapshot = await buildSkillSnapshot(workspaceDir);
    await write("healthy-skill", "Replacement healthy");
    await write("new-skill", "New skill");
    markUnavailable("cold-skill");

    try {
      const prompt = await resolveSkillsPrompt({ skillsSnapshot: snapshot, workspaceDir });

      expect(prompt).not.toContain("cold-skill/SKILL.md");
      expect(prompt).toContain("healthy-skill/SKILL.md");
      expect(prompt).toContain("Captured healthy");
      expect(prompt).not.toContain("Replacement healthy");
      expect(prompt).not.toContain("new-skill/SKILL.md");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", async () => {
    const hidden = createEntry("hidden-skill", "Hidden");
    hidden.skill.disableModelInvocation = true;

    const prompt = await resolve({ entries: [hidden] });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });
});

it("attempts separated projection recovery only once and retains the original legacy bytes", async () => {
  const snapshot = await snapshotOf([createEntry("selected")]);
  // The established legacy reader trims stored whitespace; compare with its actual output.
  const originalPrompt = await resolve({ skillsSnapshot: snapshot });
  delete snapshot.catalogPrompt;
  const project = vi
    .spyOn(reprojection, "reprojectSkillSnapshot")
    .mockReturnValueOnce({
      ...snapshot,
      prompt: "BROKEN PROJECTOR OUTPUT",
      catalogPrompt: "INCONSISTENT",
    })
    .mockImplementationOnce(() => {
      throw new Error("Second projection attempt sentinel");
    });
  const fallback = vi.fn();
  try {
    const prompt = await resolve({
      skillsSnapshot: snapshot,
      separateRemoteNote: true,
      onLegacyPromptFallback: fallback,
    });
    expect.soft(project).toHaveBeenCalledTimes(1);
    expect.soft(prompt).toBe(originalPrompt);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(loggingMocks.warn).toHaveBeenCalledWith(
      "Using legacy skills prompt for this turn; separated projection unavailable.",
      {
        errorName: "SkillsProjectionInvariantError",
        errorMessage:
          "Reprojected skills snapshot does not satisfy the current prompt projection invariant.",
      },
    );
  } finally {
    project.mockRestore();
  }
});

// Projection contract controls, not a substitute for the seven-state real-producer wire oracle.
for (const state of [
  "online-1",
  "offline",
  "online-2",
  "stale-c1-removal",
  "linux",
  "no-system-run",
  "denied",
]) {
  it(`keeps projection pairs valid across renderer budgets: ${state}`, async () => {
    const note = ["online-1", "online-2", "stale-c1-removal"].includes(state)
      ? "Remote macOS node available (Projection Mac). Run macOS-only skills via exec host=node on that node.  "
      : undefined;
    for (const options of [
      { maxSkillsPromptChars: 18000 },
      { maxSkillsPromptChars: 800 },
      { maxSkillsPromptChars: 100, maxSkillsInPrompt: 0 },
      { maxSkillsPromptChars: 0 },
    ]) {
      const entries = [
        createEntry("a", "Long guidance. ".repeat(100)),
        createEntry("b", "More guidance. ".repeat(100)),
      ];
      const snapshot = await snapshotOf(entries);
      const projected = reprojection.reprojectSkillSnapshot(
        { ...snapshot, remoteNote: note },
        snapshot.resolvedSkills!,
        { ...options, remoteNote: note },
      );
      expect(reprojection.hasCurrentSkillSnapshotProjection(projected)).toBe(true);
    }
    const empty = await snapshotOf([]);
    const noteOnly = reprojection.reprojectSkillSnapshot({ ...empty, remoteNote: note }, [], {
      remoteNote: note,
    });
    expect(noteOnly.prompt).toBe(note ?? "");
    expect(noteOnly.catalogPrompt).toBe("");
    expect(reprojection.hasCurrentSkillSnapshotProjection(noteOnly)).toBe(true);
  });
}

it("keeps remapping owners' legacy formatter bytes unchanged inside and beyond default limits", async () => {
  for (const count of [1, 151]) {
    const entries = Array.from({ length: count }, (_, n) =>
      createEntry(`skill-${n}`, "Long guidance. ".repeat(100)),
    );
    const snapshot = await snapshotOf(entries);
    // Both remapping owners supply the exact remapped set with preserveOrder and no remote prefix/config.
    const resolved = entries.map((e) => e.skill);
    const projected = reprojection.reprojectSkillSnapshot(snapshot, resolved);
    expect(projected.prompt).toBe(
      formatSkillsForPromptBounded({ skills: resolved, preserveOrder: true }),
    );
    expect(reprojection.hasCurrentSkillSnapshotProjection(projected)).toBe(true);
  }
});
