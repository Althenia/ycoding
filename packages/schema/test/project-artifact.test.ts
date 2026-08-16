import { expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { ProjectArtifact as DirectProjectArtifact } from "../src/project-artifact.js"
import { ProjectArtifact } from "../src/index.js"

const strict = { errors: "all", onExcessProperty: "error" } as const

function succeeds(schema: Schema.Decoder<unknown>, input: unknown) {
  expect(Exit.isSuccess(Schema.decodeUnknownExit(schema, strict)(input))).toBe(true)
}

function fails(schema: Schema.Decoder<unknown>, input: unknown) {
  expect(Exit.isFailure(Schema.decodeUnknownExit(schema, strict)(input))).toBe(true)
}

test("exports the Phase 1 project artifact contracts", () => {
  expect(DirectProjectArtifact).toBe(ProjectArtifact)
  expect(
    [
      ProjectArtifact.Scope,
      ProjectArtifact.Kind,
      ProjectArtifact.Stage,
      ProjectArtifact.Artifact,
      ProjectArtifact.ArtifactSummary,
      ProjectArtifact.ArtifactDetails,
      ProjectArtifact.CreateRequest,
      ProjectArtifact.UpdateRequest,
      ProjectArtifact.DeleteRequest,
      ProjectArtifact.RestoreRequest,
      ProjectArtifact.PromotionPreviewRequest,
      ProjectArtifact.PromotionConfirmRequest,
      ProjectArtifact.Metrics,
      ProjectArtifact.ValidationError,
      ProjectArtifact.UnsupportedKindError,
    ].every(Schema.isSchema),
  ).toBe(true)
})

test("uses tagged project and global scopes and the supported ecosystem kinds", () => {
  succeeds(ProjectArtifact.Scope, {
    type: "project",
    id: "pas_project",
    projectID: "project-id",
    storageID: "123e4567-e89b-12d3-a456-426614174000",
  })
  succeeds(ProjectArtifact.Scope, {
    type: "global",
    id: "pas_global",
    storageID: "123e4567-e89b-12d3-a456-426614174001",
  })
  fails(ProjectArtifact.Scope, { type: "project", id: "pas_project", storageID: "storage" })
  fails(ProjectArtifact.Scope, { type: "global", id: "pas_global", projectID: "project-id", storageID: "storage" })
  succeeds(ProjectArtifact.ScopeSelector, { type: "project" })
  succeeds(ProjectArtifact.ScopeSelector, { type: "global" })
  fails(ProjectArtifact.ScopeSelector, { type: "project", id: "pas_project" })
  fails(ProjectArtifact.ScopeSelector, { type: "global", storageID: "123e4567-e89b-12d3-a456-426614174001" })

  for (const kind of ["skill", "command", "agent", "plugin"]) succeeds(ProjectArtifact.Kind, kind)
  fails(ProjectArtifact.Kind, "workflow")
  for (const stage of ["trial", "active", "degraded", "disabled", "quarantine"]) succeeds(ProjectArtifact.Stage, stage)
})

test("enforces stable identifiers, digest, and text limits", () => {
  succeeds(ProjectArtifact.ID, "artifact-1")
  for (const value of ["Artifact", "a_thing", "con", "a".repeat(65)]) fails(ProjectArtifact.ID, value)
  succeeds(ProjectArtifact.Digest, "a".repeat(64))
  fails(ProjectArtifact.Digest, "A".repeat(64))
  succeeds(ProjectArtifact.DisplayName, "x".repeat(128))
  fails(ProjectArtifact.DisplayName, "x".repeat(129))
  succeeds(ProjectArtifact.SkillContent, "x".repeat(24 * 1024))
  fails(ProjectArtifact.SkillContent, "x".repeat(24 * 1024 + 1))
})

test("uses server-derived scope selectors for manual mutations", () => {
  const scope = { type: "project" } as const
  const key = { scope, kind: "skill", id: "artifact" } as const
  const definition = { kind: "skill", name: "A skill", description: "Useful", content: "Use this skill." } as const
  succeeds(ProjectArtifact.CreateRequest, { key, definition })
  succeeds(ProjectArtifact.UpdateRequest, {
    key,
    definition,
    expectedRevision: 0,
    expectedVersionID: "pav_version",
    expectedDigest: "a".repeat(64),
  })
  succeeds(ProjectArtifact.DeleteRequest, {
    key,
    expectedRevision: 0,
    expectedVersionID: "pav_version",
    expectedDigest: "a".repeat(64),
  })
  succeeds(ProjectArtifact.RestoreRequest, { deletionID: "pad_deleted" })
  succeeds(ProjectArtifact.PromotionPreviewRequest, {
    key,
    expectedRevision: 0,
    expectedVersionID: "pav_version",
    expectedDigest: "a".repeat(64),
  })
  succeeds(ProjectArtifact.PromotionConfirmRequest, { token: "confirm-token" })
  fails(ProjectArtifact.CreateRequest, { key: { ...key, scope: { type: "project", id: "pas_project" } }, definition })
  fails(ProjectArtifact.UpdateRequest, {
    key: { ...key, scope: { type: "global", storageID: "123e4567-e89b-12d3-a456-426614174000" } },
    definition,
    expectedRevision: 0,
    expectedVersionID: "pav_version",
    expectedDigest: "a".repeat(64),
  })
  fails(ProjectArtifact.DeleteRequest, {
    key,
    scope: { type: "project", id: "pas_project" },
    expectedRevision: 0,
    expectedVersionID: "pav_version",
    expectedDigest: "a".repeat(64),
  })
})

test("models version provenance, normalized paths, bounded previews, and trash retention", () => {
  const scope = {
    type: "project",
    id: "pas_project",
    projectID: "project-id",
    storageID: "123e4567-e89b-12d3-a456-426614174000",
  } as const
  const provenance = { source: "agent", creatorAgentID: "agent", creatorSessionID: "ses_123" } as const
  succeeds(ProjectArtifact.Provenance, provenance)
  fails(ProjectArtifact.Provenance, { ...provenance, creatorSessionID: "agent" })
  succeeds(ProjectArtifact.VersionState, "superseded")
  succeeds(ProjectArtifact.Version, {
    id: "pav_version",
    state: "superseded",
    contentDigest: "a".repeat(64),
    contentRelpath: "versions/skill/artifact/pav_version/SKILL.md",
    provenance,
    timeCreated: 0,
    timeStateChanged: 0,
  })
  for (const contentRelpath of ["/absolute", "../parent", "~/home", "https://example.com", "C:\\windows", "\\\\server\\share"]) {
    fails(ProjectArtifact.Version, {
      id: "pav_version",
      state: "trial",
      contentDigest: "a".repeat(64),
      contentRelpath,
      provenance,
      timeCreated: 0,
      timeStateChanged: 0,
    })
  }
  succeeds(ProjectArtifact.Trash, {
    deletionID: "pad_deleted",
    scope,
    kind: "skill",
    id: "artifact",
    priorStage: "active",
    priorVersionID: "pav_version",
    deletedAt: 0,
    purgeAfter: 30 * 86_400_000,
  })
  fails(ProjectArtifact.Trash, {
    deletionID: "pad_deleted",
    scope,
    kind: "skill",
    id: "artifact",
    priorStage: "active",
    priorVersionID: "pav_version",
    deletedAt: 0,
    purgeAfter: 1,
  })
})

test("validates confidence, bounded promotion fields, and privacy-safe accounting records", () => {
  succeeds(ProjectArtifact.Confidence, { sampleCount: 2, successCount: 2, lowerBound: 0.5, upperBound: 0.5, eligible: true })
  fails(ProjectArtifact.Confidence, { sampleCount: 1, successCount: 2, lowerBound: 0.5, upperBound: 0.5, eligible: true })
  fails(ProjectArtifact.Confidence, { sampleCount: 1, successCount: 1, lowerBound: 0.6, upperBound: 0.5, eligible: true })
  fails(ProjectArtifact.PromotionConfirmRequest, { token: "x".repeat(1025) })
  fails(ProjectArtifact.PromotionPreview, {
    artifact: {},
    metrics: {},
    destination: {},
    risk: "declarative",
    renderedContent: "x".repeat(32 * 1024 + 1),
    token: "token",
    expiresAt: 0,
  })
  succeeds(ProjectArtifact.Activation, {
    id: "paa_activation",
    artifact: { scopeID: "pas_scope", kind: "skill", id: "artifact", versionID: "pav_version" },
    source: "skill-tool",
    boundarySeq: 0,
    activatedAt: 0,
  })
  succeeds(ProjectArtifact.Observation, {
    id: "pao_observation",
    artifact: { scopeID: "pas_scope", kind: "skill", id: "artifact", versionID: "pav_version" },
    activationSetDigest: "a".repeat(64),
    activeArtifactCount: 1,
    externalConfounded: false,
    eligible: true,
    terminalOutcome: "succeeded",
    goalStatus: "completed",
    repeatFix: false,
    observedAt: 0,
  })
  succeeds(ProjectArtifact.Feedback, {
    artifact: { scopeID: "pas_scope", kind: "skill", id: "artifact", versionID: "pav_version" },
    action: "disable",
    actor: "user",
    timeCreated: 0,
  })
  succeeds(ProjectArtifact.AutomaticWrite, {
    scopeID: "pas_scope",
    sessionID: "ses_123",
    insightDigest: "a".repeat(64),
    operation: "create",
    result: "created",
    versionID: "pav_version",
    contentDigest: "a".repeat(64),
    timeCreated: 0,
  })
  fails(ProjectArtifact.Observation, {
    id: "pao_observation",
    artifact: { scopeID: "pas_scope", kind: "skill", id: "artifact", versionID: "pav_version" },
    activationSetDigest: "a".repeat(64),
    activeArtifactCount: 1,
    externalConfounded: false,
    eligible: true,
    terminalOutcome: "succeeded",
    goalStatus: "completed",
    repeatFix: false,
    prompt: "smuggled",
    observedAt: 0,
  })
})
