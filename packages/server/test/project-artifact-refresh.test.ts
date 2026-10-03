import { expect, test } from "bun:test"
import { Location } from "@ycoding-ai/core/location"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { ProjectArtifactHandler } from "../src/handlers/project-artifact"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import {
  ArtifactMutationResult,
  ConfirmationPreview,
  ProjectArtifact,
} from "@ycoding-ai/protocol/groups/project-artifact"

const digest = "a".repeat(64)
const version = "pav_version"
const expectation = { expectedRevision: 1, expectedVersionID: version, expectedDigest: digest }
const artifact = "/api/artifact/project/skill/review"
const definition = { kind: "skill", name: "Review", description: "Review changes", content: "Review." }
const projectScope = Schema.decodeUnknownSync(ProjectArtifact.ProjectScope)({
  type: "project",
  id: "pas_project",
  projectID: "prj_artifact",
  storageID: "00000000-0000-0000-0000-000000000000",
})
const globalScope = Schema.decodeUnknownSync(ProjectArtifact.GlobalScope)({
  type: "global",
  id: "pas_global",
  storageID: "00000000-0000-0000-0000-000000000000",
})
const committed = Schema.decodeUnknownSync(ArtifactMutationResult)({
  result: "created",
  scopeID: projectScope.id,
  kind: "skill",
  id: "review",
  versionID: version,
  contentDigest: digest,
  stage: "trial",
  remaining: { session: 1, projectDaily: 1, projectArtifacts: 1, versions: 1, bytes: 1 },
})
const preview = Schema.decodeUnknownSync(ConfirmationPreview)({ token: "single-use-token", expiresAt: 100 })
const trash = Schema.decodeUnknownSync(ProjectArtifact.Trash)({
  deletionID: "pad_deleted",
  scope: projectScope,
  kind: "skill",
  id: "review",
  priorStage: "trial",
  priorVersionID: version,
  deletedAt: 0,
  purgeAfter: 30 * 86_400_000,
})
const metrics = Schema.decodeUnknownSync(ProjectArtifact.Metrics)({
  score: 0,
  confidence: { sampleCount: 0, successCount: 0, lowerBound: 0, upperBound: 1, eligible: false },
  rewardUnits: 0,
  penaltyUnits: 0,
})
const details = Schema.decodeUnknownSync(ProjectArtifact.ArtifactDetails)({
  artifact: {
    scope: globalScope,
    kind: "skill",
    id: "review",
    revision: 1,
    stage: "trial",
    currentVersionID: version,
    lastUsedAt: 0,
    timeCreated: 0,
    timeUpdated: 0,
  },
  definition,
  currentVersion: {
    id: version,
    state: "trial",
    contentDigest: digest,
    contentRelpath: "SKILL.md",
    provenance: { source: "user" },
    timeCreated: 0,
    timeStateChanged: 0,
  },
  versions: [],
  diagnostics: [],
})
const promotion = Schema.decodeUnknownSync(ProjectArtifact.PromotionPreview)({
  artifact: {
    scope: projectScope,
    kind: "skill",
    id: "review",
    name: "Review",
    description: "Review changes",
    stage: "trial",
    revision: 1,
    currentVersionID: version,
    currentDigest: digest,
    timeUpdated: 0,
  },
  metrics,
  destination: globalScope,
  risk: "declarative",
  renderedContent: "Review.",
  ...preview,
})

function fixture(failed = false) {
  const calls: string[] = []
  const inputs: unknown[] = []
  const storeResult =
    <A>(operation: string, result: A) =>
    (input: unknown) =>
      Effect.sync(() => {
        calls.push(operation)
        inputs.push(input)
      }).pipe(
        Effect.andThen(
          failed
            ? Effect.fail(
                new ProjectArtifactStore.StoreError({ code: "VersionConflict", message: "private Store details" }),
              )
            : Effect.succeed(result),
        ),
      )
  const context = Context.empty().pipe(
    Context.add(
      Location.Service,
      new Location.Info({
        directory: AbsolutePath.make("/fixture"),
        project: { id: ProjectV2.ID.make("prj_artifact"), directory: AbsolutePath.make("/fixture") },
      }),
    ),
    Context.merge(
      Layer.build(
        Layer.mock(ProjectArtifactStore.Service, {
          resolveProjectScope: () => Effect.succeed(projectScope),
          resolveGlobalScope: () => Effect.succeed(globalScope),
          writeManual: storeResult("writeManual", committed),
          confirmManual: storeResult("confirmManual", committed),
          remove: storeResult("remove", trash),
          restore: storeResult("restore", undefined),
          revert: storeResult("revert", undefined),
          enable: storeResult("enable", undefined),
          disable: storeResult("disable", undefined),
          confirmPromotion: storeResult("confirmPromotion", committed),
          confirmFork: storeResult("confirmFork", committed),
          confirmShadow: storeResult("confirmShadow", undefined),
          purge: () => storeResult("purge", 1)(undefined),
          list: storeResult("list", []),
          get: storeResult("get", details),
          previewManual: storeResult("previewManual", preview),
          previewFork: storeResult("previewFork", preview),
          previewShadow: storeResult("previewShadow", preview),
          previewPromotion: storeResult("previewPromotion", promotion),
        }),
      ).pipe(Effect.scoped, Effect.runSync),
    ),
    Context.merge(
      Layer.build(
        Layer.mock(ProjectArtifactSource.Service, {
          refresh: () => Effect.sync(() => void calls.push("refresh")),
        }),
      ).pipe(Effect.scoped, Effect.runSync),
    ),
    Context.merge(
      Layer.build(
        Layer.mock(ProjectArtifactAccounting.Service, {
          metrics: () => Effect.succeed(metrics),
        }),
      ).pipe(Effect.scoped, Effect.runSync),
    ),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.projectArtifact"])).pipe(
      Layer.provide(ProjectArtifactHandler),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LocationMiddleware, (effect) =>
            Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe)),
          ),
          Layer.succeed(Authorization, (effect) => effect),
          Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  return {
    calls,
    inputs,
    request: (method: string, path: string, body?: unknown) =>
      handler.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        context,
      ),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test.each([
  ["create", "POST", "/api/artifact", { scope: "project", id: "review", definition }, committed, "writeManual"],
  ["update", "PUT", artifact, { definition, ...expectation }, committed, "writeManual"],
  ["confirmGlobal", "POST", "/api/artifact/global/confirm", { token: "single-use-token" }, committed, "confirmManual"],
  ["disable", "POST", `${artifact}/disable`, expectation, undefined, "disable"],
  ["enable", "POST", `${artifact}/enable`, expectation, undefined, "enable"],
  ["remove", "DELETE", artifact, expectation, trash, "remove"],
  ["restore", "POST", "/api/artifact/trash/pad_deleted/restore", undefined, undefined, "restore"],
  ["revert", "POST", `${artifact}/revert`, { ...expectation, targetVersionID: "pav_target" }, undefined, "revert"],
  [
    "promotion.confirm",
    "POST",
    `${artifact}/promotion/single-use-token/confirm`,
    undefined,
    committed,
    "confirmPromotion",
  ],
  [
    "fork.confirm",
    "POST",
    "/api/artifact/global/skill/review/fork/single-use-token/confirm",
    undefined,
    committed,
    "confirmFork",
  ],
  ["shadow.confirm", "POST", `${artifact}/shadow/single-use-token/confirm`, undefined, undefined, "confirmShadow"],
] as const)(
  "artifact.%s returns the committed response after refreshing discovery",
  async (_name, method, path, body, result, operation) => {
    await using f = fixture()
    const response = await f.request(method, path, body)
    expect(response.status).toBe(result === undefined ? 204 : 200)
    if (result !== undefined) expect(await response.json()).toEqual({ data: result })
    expect(f.calls).toEqual([operation, "refresh"])
  },
)

test("artifact.purge deletes trash without refreshing the artifact source", async () => {
  await using f = fixture()
  const response = await f.request("POST", "/api/artifact/trash/purge")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: { count: 1 } })
  expect(f.calls).toEqual(["purge"])
})

test.each([
  ["list", "/api/artifact?scope=project", []],
  ["get", artifact, details],
  ["metrics", `${artifact}/metrics`, { ...metrics, lastUsedAt: 0 }],
] as const)("artifact.%s returns Store data without refreshing discovery", async (name, path, result) => {
  await using f = fixture()
  const response = await f.request("GET", path)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: result })
  expect(f.calls).toEqual([name === "metrics" ? "get" : name])
  expect(f.inputs).toEqual([
    name === "list"
      ? { scope: { type: "project" }, projectID: "prj_artifact", kind: undefined, stage: undefined }
      : { scope: { type: "project" }, projectID: "prj_artifact", kind: "skill", id: "review" },
  ])
})

test.each([
  ["promotion", `${artifact}/promotion`, promotion],
  ["fork", "/api/artifact/global/skill/review/fork", preview],
  ["shadow", `${artifact}/shadow`, preview],
] as const)("artifact.%s.preview returns a preview without refreshing discovery", async (name, path, result) => {
  await using f = fixture()
  const response = await f.request("POST", path, expectation)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: result })
  expect(f.calls).toEqual(
    name === "shadow" ? ["get", "previewShadow"] : [name === "fork" ? "previewFork" : "previewPromotion"],
  )
})

test("artifact mutations use server-resolved project identity and preserve optimistic expectations", async () => {
  await using f = fixture()
  const response = await f.request("PUT", artifact, {
    definition,
    ...expectation,
    projectID: "prj_untrusted",
    storageID: "untrusted",
    collision: true,
  })
  expect(response.status).toBe(200)
  expect(f.inputs).toEqual([
    { id: "review", definition, ...expectation, scope: { type: "project" }, projectID: "prj_artifact" },
  ])
})

test("failed artifact mutations return sanitized conflicts without refreshing discovery", async () => {
  await using f = fixture(true)
  const response = await f.request("PUT", artifact, { definition, ...expectation })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ _tag: "ArtifactConflict", code: "VersionConflict" })
  expect(f.calls).toEqual(["writeManual"])
})

test.each([
  ["create", "POST", "/api/artifact", { scope: "global", id: "review", definition }, { id: "review", definition }],
  [
    "update",
    "PUT",
    "/api/artifact/global/skill/review",
    { definition, ...expectation },
    { id: "review", definition, ...expectation },
  ],
] as const)(
  "global artifact.%s previews without writing or refreshing before confirmation",
  async (_name, method, path, body, input) => {
    await using f = fixture()
    const response = await f.request(method, path, body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: preview })
    expect(f.calls).toEqual(["previewManual"])
    expect(f.inputs).toEqual([input])
  },
)
