import { describe, expect, test } from "bun:test"
import {
  artifactActions,
  artifactCategory,
  artifactDescription,
  artifactKindLabel,
  confirmationPreviewLines,
  filterArtifacts,
  promotionPreviewLines,
  shadowEligible,
} from "../src/util/project-artifacts"

const artifacts = [
  {
    scope: { type: "project" as const, id: "scope-project", projectID: "project", storageID: "storage" },
    kind: "skill" as const,
    id: "review",
    name: "Review changes",
    description: "Review changed files before delivery.",
    stage: "active" as const,
    revision: 3,
    currentVersionID: "version-3",
    currentDigest: "digest-3",
    timeUpdated: 3,
  },
  {
    scope: { type: "project" as const, id: "scope-project", projectID: "project", storageID: "storage" },
    kind: "command" as const,
    id: "ship",
    name: "Ship",
    description: "Prepare a release.",
    stage: "trial" as const,
    revision: 1,
    currentVersionID: "version-1",
    currentDigest: "digest-1",
    timeUpdated: 2,
  },
  {
    scope: { type: "global" as const, id: "scope-global", storageID: "storage" },
    kind: "plugin" as const,
    id: "future",
    name: "Future plugin",
    description: "Not supported in Phase 1.",
    stage: "quarantine" as const,
    revision: 1,
    currentVersionID: "version-plugin",
    currentDigest: "digest-plugin",
    timeUpdated: 1,
  },
]

describe("project artifact presentation", () => {
  test("filters by scope, kind, and stage without changing server order", () => {
    expect(filterArtifacts(artifacts, { scope: "project", kind: "all", stage: "all" })).toEqual(artifacts.slice(0, 2))
    expect(filterArtifacts(artifacts, { scope: "project", kind: "command", stage: "trial" })).toEqual([artifacts[1]])
  })

  test("uses stable kind categories and concise descriptions", () => {
    expect(artifactCategory(artifacts[0])).toBe("Skills")
    expect(artifactKindLabel("plugin")).toBe("Unsupported (quarantine only)")
    expect(artifactDescription(artifacts[0])).toBe("Project · Active · r3 · Review changed files before delivery.")
  })

  test("limits unsupported plugins to no lifecycle or promotion actions", () => {
    expect(artifactActions({ scope: "global", kind: "plugin", stage: "quarantine", versions: 2 })).toEqual({
      restore: false,
      enable: false,
      disable: false,
      remove: false,
      revert: false,
      promote: false,
      fork: false,
      shadow: false,
    })
    expect(artifactActions({ scope: "project", kind: "skill", stage: "disabled", versions: 2 })).toMatchObject({
      enable: true,
      revert: true,
      promote: true,
    })
    expect(artifactActions({ scope: "trash", kind: "plugin", stage: "quarantine", versions: 0 })).toMatchObject({
      restore: true,
      enable: false,
      promote: false,
    })
  })

  test("limits shadow previews to an exact project-over-global collision", () => {
    expect(
      shadowEligible({
        scope: "project",
        kind: "skill",
        id: "review",
        diagnostics: [{ type: "project-over-global-shadow", kind: "skill", id: "review", message: "Global skill exists" }],
      }),
    ).toBe(true)
    expect(
      shadowEligible({
        scope: "project",
        kind: "skill",
        id: "review",
        diagnostics: [{ type: "project-over-global-shadow", kind: "skill", id: "other", message: "Different skill" }],
      }),
    ).toBe(false)
    expect(
      shadowEligible({
        scope: "project",
        kind: "plugin",
        id: "future",
        diagnostics: [{ type: "project-over-global-shadow", kind: "plugin", id: "future", message: "Future plugin" }],
      }),
    ).toBe(false)
  })

  test("renders confirmation-token expiry for shadow previews", () => {
    expect(confirmationPreviewLines({ expiresAt: 1_700_000_000_000 })).toEqual(["Expires: 2023-11-14T22:13:20.000Z"])
  })

  test("renders every available promotion preview safety field before confirmation", () => {
    expect(
      promotionPreviewLines({
        artifact: artifacts[0],
        metrics: {
          score: 0.75,
          confidence: { sampleCount: 8, successCount: 6, lowerBound: 0.4, upperBound: 0.9, eligible: true },
          rewardUnits: 6,
          penaltyUnits: 2,
        },
        destination: { type: "global", id: "scope-global", storageID: "storage" },
        risk: "declarative",
        renderedContent: "# Review\n\nReview the diff.",
        collision: { type: "existing-source", kind: "skill", id: "review", message: "Existing global skill" },
        token: "single-use-token",
        expiresAt: 1_700_000_000_000,
      }),
    ).toEqual([
      "Risk: Declarative",
      "Collision: Existing global skill",
      "Samples: 8 · confidence 0.40–0.90",
      "Expires: 2023-11-14T22:13:20.000Z",
      "Content:\n# Review\n\nReview the diff.",
    ])
  })
})
