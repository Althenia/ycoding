import { expect, test } from "bun:test"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Schema } from "effect"
import {
  ArtifactMutation,
  ArtifactListItem,
  ArtifactQuery,
  ArtifactScope,
  GlobalMutationConfirmation,
  ProjectArtifactGroup,
} from "../src/groups/project-artifact.js"

test("declares the managed project artifact operation manifest", () => {
  const endpoints = ProjectArtifactGroup.endpoints

  expect(Object.keys(endpoints).toSorted()).toEqual([
    "artifact.confirmGlobal",
    "artifact.create",
    "artifact.disable",
    "artifact.enable",
    "artifact.fork.confirm",
    "artifact.fork.preview",
    "artifact.get",
    "artifact.list",
    "artifact.metrics",
    "artifact.promotion.confirm",
    "artifact.promotion.preview",
    "artifact.purge",
    "artifact.remove",
    "artifact.restore",
    "artifact.revert",
    "artifact.shadow.confirm",
    "artifact.shadow.preview",
    "artifact.update",
  ])
  expect(endpoints["artifact.list"].path).toBe("/api/artifact")
  expect(endpoints["artifact.get"].path).toBe("/api/artifact/:scope/:kind/:id")
  expect(endpoints["artifact.promotion.preview"].path).toBe("/api/artifact/project/:kind/:id/promotion")
  expect(endpoints["artifact.promotion.confirm"].path).toBe("/api/artifact/project/:kind/:id/promotion/:token/confirm")
  expect(endpoints["artifact.fork.preview"].path).toBe("/api/artifact/global/:kind/:id/fork")
  expect(endpoints["artifact.fork.confirm"].path).toBe("/api/artifact/global/:kind/:id/fork/:token/confirm")
  expect(endpoints["artifact.shadow.preview"].path).toBe("/api/artifact/project/:kind/:id/shadow")
  expect(endpoints["artifact.shadow.confirm"].path).toBe("/api/artifact/project/:kind/:id/shadow/:token/confirm")
})

test("lists typed trash summaries alongside live artifact summaries", () => {
  const decoded = Schema.decodeUnknownSync(ArtifactListItem)({
      deletionID: "pad_deleted",
      scope: {
        type: "project",
        id: "pas_project",
        projectID: "project",
        storageID: "00000000-0000-0000-0000-000000000000",
      },
      kind: "skill",
      id: "review",
      name: "Review",
      description: "Review changes",
      priorStage: "active",
      priorVersionID: "pav_deleted",
      deletedAt: 0,
      purgeAfter: 30 * 86_400_000,
      definition: { kind: "skill", name: "Review", description: "Review changes", content: "Review." },
    })
  expect("deletionID" in decoded ? String(decoded.deletionID) : undefined).toBe("pad_deleted")
})

test("keeps only server-resolved scope selectors and optimistic mutation expectations", () => {
  expect(Schema.decodeUnknownSync(ArtifactScope)("project")).toBe("project")
  expect(Schema.decodeUnknownSync(ArtifactScope)("global")).toBe("global")
  expect(() => Schema.decodeUnknownSync(ArtifactScope)({ type: "project", storageID: "path" })).toThrow()
  expect(Schema.decodeUnknownSync(ArtifactQuery)({ scope: "project", path: "/private" })).toEqual({ scope: "project" })

  expect(
    Schema.decodeUnknownSync(ArtifactMutation)({
      definition: {
        kind: "skill",
        name: "Focused artifact",
        description: "A bounded declaration",
        content: "Use the bounded declaration.",
      },
      expectedRevision: 0,
      expectedVersionID: ProjectArtifact.VersionID.make("pav_current"),
      expectedDigest: ProjectArtifact.Digest.make("a".repeat(64)),
    }),
  ).toEqual({
    definition: {
      kind: "skill",
      name: "Focused artifact",
      description: "A bounded declaration",
      content: "Use the bounded declaration.",
    },
    expectedRevision: 0,
    expectedVersionID: ProjectArtifact.VersionID.make("pav_current"),
    expectedDigest: ProjectArtifact.Digest.make("a".repeat(64)),
  })
})

test("requires a confirmation token for global mutation and has no workflow kind", () => {
  expect(
    Schema.decodeUnknownSync(GlobalMutationConfirmation)({ token: "single-use-token" }),
  ).toEqual({ token: "single-use-token" })
  expect(Schema.decodeUnknownSync(GlobalMutationConfirmation)({ token: "single-use-token", collision: true })).toEqual({
    token: "single-use-token",
  })
  expect(() => Schema.decodeUnknownSync(ArtifactMutation)({ definition: { kind: "workflow" } })).toThrow()
})

test("removes the legacy self-improvement Protocol group", async () => {
  const api = await Bun.file(new URL("../src/api.ts", import.meta.url)).text()
  const client = await Bun.file(new URL("../src/client.ts", import.meta.url)).text()

  expect(api).not.toContain("SelfImprovement")
  expect(api).not.toContain("self-improvement")
  expect(client).not.toContain("selfImprovement")
})
