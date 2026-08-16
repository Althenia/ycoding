import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export { ProjectArtifact }

export const ArtifactScope = Schema.Literals(["project", "global"]).annotate({
  identifier: "ProjectArtifact.ApiScope",
})
export const ArtifactListScope = Schema.Literals(["project", "global", "trash"]).annotate({
  identifier: "ProjectArtifact.ApiListScope",
})
export const ArtifactQuery = Schema.Struct({
  ...LocationQuery.fields,
  scope: ArtifactListScope,
  kind: ProjectArtifact.Kind.pipe(Schema.optional),
  stage: ProjectArtifact.Stage.pipe(Schema.optional),
}).annotate({ identifier: "ProjectArtifact.ApiQuery" })

const ArtifactParams = Schema.Struct({
  scope: ArtifactScope,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
})
const ProjectArtifactParams = Schema.Struct({ kind: ProjectArtifact.Kind, id: ProjectArtifact.ID })
const Expectation = {
  expectedRevision: ProjectArtifact.Revision,
  expectedVersionID: ProjectArtifact.VersionID,
  expectedDigest: ProjectArtifact.Digest,
}

export const ArtifactMutation = Schema.Struct({
  definition: ProjectArtifact.Definition,
  ...Expectation,
}).annotate({ identifier: "ProjectArtifact.ApiMutation" })
export const ArtifactCreate = Schema.Struct({
  scope: ArtifactScope,
  id: ProjectArtifact.ID,
  definition: ProjectArtifact.Definition,
}).annotate({ identifier: "ProjectArtifact.ApiCreate" })
export const ArtifactExpectation = Schema.Struct(Expectation).annotate({
  identifier: "ProjectArtifact.ApiExpectation",
})
export const ArtifactRevert = Schema.Struct({
  ...Expectation,
  targetVersionID: ProjectArtifact.VersionID,
}).annotate({ identifier: "ProjectArtifact.ApiRevert" })
export const GlobalMutationConfirmation = Schema.Struct({
  token: ProjectArtifact.ConfirmationToken,
}).annotate({ identifier: "ProjectArtifact.ApiGlobalMutationConfirmation" })

export const ArtifactMutationResult = Schema.Struct({
  result: ProjectArtifact.AutomaticWriteResult,
  scopeID: ProjectArtifact.ScopeID,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
  versionID: ProjectArtifact.VersionID,
  contentDigest: ProjectArtifact.Digest,
  stage: Schema.Literal("trial"),
  remaining: Schema.Struct({
    session: Schema.Int,
    projectDaily: Schema.Int,
    projectArtifacts: Schema.Int,
    versions: Schema.Int,
    bytes: Schema.Int,
  }),
}).annotate({ identifier: "ProjectArtifact.ApiMutationResult" })
export const ConfirmationPreview = Schema.Struct({
  token: ProjectArtifact.ConfirmationToken,
  expiresAt: ProjectArtifact.TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.ApiConfirmationPreview" })
export const ArtifactTrashSummary = Schema.Struct({
  ...ProjectArtifact.Trash.fields,
  name: ProjectArtifact.DisplayName,
  description: ProjectArtifact.Description,
  definition: ProjectArtifact.Definition,
}).annotate({ identifier: "ProjectArtifact.ApiTrashSummary" })
export const ArtifactListItem = Schema.Union([ProjectArtifact.ArtifactSummary, ArtifactTrashSummary]).annotate({
  identifier: "ProjectArtifact.ApiListItem",
})
const MetricsResponse = Schema.Struct({
  ...ProjectArtifact.Metrics.fields,
  lastUsedAt: ProjectArtifact.TimestampMillis.pipe(Schema.optional),
}).annotate({ identifier: "ProjectArtifact.ApiMetrics" })
const PurgeResponse = Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })

export class ArtifactBadRequest extends Schema.TaggedErrorClass<ArtifactBadRequest>()("ArtifactBadRequest", {
  code: Schema.Literals(["ProjectIdentityUnavailable", "InvalidArtifact", "UnsafeContent", "UnsupportedKind", "InvalidScope"]),
}, { httpApiStatus: 400 }) {}
export class ArtifactNotFound extends Schema.TaggedErrorClass<ArtifactNotFound>()("ArtifactNotFound", {
  code: Schema.Literals(["ArtifactNotFound", "VersionNotFound", "DeletionNotFound"]),
}, { httpApiStatus: 404 }) {}
export class ArtifactConflict extends Schema.TaggedErrorClass<ArtifactConflict>()("ArtifactConflict", {
  code: Schema.Literals([
    "ArtifactCollision",
    "ScopeCollision",
    "VersionConflict",
    "OwnershipMismatch",
    "DestinationExists",
    "ProjectAdoptionConflict",
  ]),
}, { httpApiStatus: 409 }) {}
export class ArtifactGone extends Schema.TaggedErrorClass<ArtifactGone>()("ArtifactGone", {
  code: Schema.Literals(["ConfirmationExpired", "TrashExpired"]),
}, { httpApiStatus: 410 }) {}
export class ArtifactTooLarge extends Schema.TaggedErrorClass<ArtifactTooLarge>()("ArtifactTooLarge", {
  code: Schema.Literals(["ContentTooLarge", "ScopeQuotaExceeded"]),
}, { httpApiStatus: 413 }) {}
export class ArtifactRateLimited extends Schema.TaggedErrorClass<ArtifactRateLimited>()("ArtifactRateLimited", {
  code: Schema.Literals(["WriteRateExceeded", "ArtifactCooldown"]),
}, { httpApiStatus: 429 }) {}
export class ArtifactUnavailable extends Schema.TaggedErrorClass<ArtifactUnavailable>()("ArtifactUnavailable", {
  code: Schema.Literals(["StorageUnavailable", "LockTimeout", "ReconciliationRequired"]),
}, { httpApiStatus: 503 }) {}

const errors = [
  ArtifactBadRequest,
  ArtifactNotFound,
  ArtifactConflict,
  ArtifactGone,
  ArtifactTooLarge,
  ArtifactRateLimited,
  ArtifactUnavailable,
] as const

export const ProjectArtifactGroup = HttpApiGroup.make("server.projectArtifact")
  .add(
    HttpApiEndpoint.get("artifact.list", "/api/artifact", {
      query: ArtifactQuery,
      success: Schema.Struct({ data: Schema.Array(ArtifactListItem) }),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.artifact.list", summary: "List project artifacts" })),
  )
  .add(
    HttpApiEndpoint.get("artifact.get", "/api/artifact/:scope/:kind/:id", {
      params: ArtifactParams,
      query: LocationQuery,
      success: Schema.Struct({ data: ProjectArtifact.ArtifactDetails }),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.artifact.get", summary: "Get project artifact" })),
  )
  .add(
    HttpApiEndpoint.post("artifact.create", "/api/artifact", {
      query: LocationQuery,
      payload: ArtifactCreate,
      success: Schema.Struct({ data: Schema.Union([ArtifactMutationResult, ConfirmationPreview]) }),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.artifact.create", summary: "Create project artifact" })),
  )
  .add(
    HttpApiEndpoint.put("artifact.update", "/api/artifact/:scope/:kind/:id", {
      params: ArtifactParams,
      query: LocationQuery,
      payload: ArtifactMutation,
      success: Schema.Struct({ data: Schema.Union([ArtifactMutationResult, ConfirmationPreview]) }),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.artifact.update", summary: "Update project artifact" })),
  )
  .add(
    HttpApiEndpoint.post("artifact.confirmGlobal", "/api/artifact/global/confirm", {
      query: LocationQuery,
      payload: GlobalMutationConfirmation,
      success: Schema.Struct({ data: ArtifactMutationResult }),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.artifact.global.confirm", summary: "Confirm global artifact mutation" })),
  )
  .add(
    HttpApiEndpoint.post("artifact.disable", "/api/artifact/:scope/:kind/:id/disable", {
      params: ArtifactParams,
      query: LocationQuery,
      payload: ArtifactExpectation,
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.enable", "/api/artifact/:scope/:kind/:id/enable", {
      params: ArtifactParams,
      query: LocationQuery,
      payload: ArtifactExpectation,
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.delete("artifact.remove", "/api/artifact/:scope/:kind/:id", {
      params: ArtifactParams,
      query: LocationQuery,
      payload: ArtifactExpectation,
      success: Schema.Struct({ data: ProjectArtifact.Trash }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.restore", "/api/artifact/trash/:deletionID/restore", {
      params: Schema.Struct({ deletionID: ProjectArtifact.DeletionID }),
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.revert", "/api/artifact/:scope/:kind/:id/revert", {
      params: ArtifactParams,
      query: LocationQuery,
      payload: ArtifactRevert,
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.get("artifact.metrics", "/api/artifact/:scope/:kind/:id/metrics", {
      params: ArtifactParams,
      query: LocationQuery,
      success: Schema.Struct({ data: MetricsResponse }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.promotion.preview", "/api/artifact/project/:kind/:id/promotion", {
      params: ProjectArtifactParams,
      query: LocationQuery,
      payload: ArtifactExpectation,
      success: Schema.Struct({ data: ProjectArtifact.PromotionPreview }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.promotion.confirm", "/api/artifact/project/:kind/:id/promotion/:token/confirm", {
      params: Schema.Struct({ ...ProjectArtifactParams.fields, token: ProjectArtifact.ConfirmationToken }),
      query: LocationQuery,
      success: Schema.Struct({ data: ArtifactMutationResult }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.fork.preview", "/api/artifact/global/:kind/:id/fork", {
      params: ProjectArtifactParams,
      query: LocationQuery,
      payload: ArtifactExpectation,
      success: Schema.Struct({ data: ConfirmationPreview }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.fork.confirm", "/api/artifact/global/:kind/:id/fork/:token/confirm", {
      params: Schema.Struct({ ...ProjectArtifactParams.fields, token: ProjectArtifact.ConfirmationToken }),
      query: LocationQuery,
      success: Schema.Struct({ data: ArtifactMutationResult }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.shadow.preview", "/api/artifact/project/:kind/:id/shadow", {
      params: ProjectArtifactParams,
      query: LocationQuery,
      payload: ArtifactExpectation,
      success: Schema.Struct({ data: ConfirmationPreview }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.shadow.confirm", "/api/artifact/project/:kind/:id/shadow/:token/confirm", {
      params: Schema.Struct({ ...ProjectArtifactParams.fields, token: ProjectArtifact.ConfirmationToken }),
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("artifact.purge", "/api/artifact/trash/purge", {
      query: LocationQuery,
      success: Schema.Struct({ data: PurgeResponse }),
      error: errors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .annotateMerge(OpenApi.annotations({ title: "projectArtifact", description: "Managed Project Artifact operations." }))
