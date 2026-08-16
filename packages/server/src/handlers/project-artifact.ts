import { Location } from "@ycoding-ai/core/location"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import {
  ArtifactBadRequest,
  ArtifactConflict,
  ArtifactGone,
  ArtifactNotFound,
  ArtifactRateLimited,
  ArtifactTooLarge,
  ArtifactUnavailable,
  type ProjectArtifact,
} from "@ycoding-ai/protocol/groups/project-artifact"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ProjectArtifactHandler = HttpApiBuilder.group(Api, "server.projectArtifact", (handlers) =>
  Effect.succeed(
    handlers
      .handle("artifact.list", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          if (ctx.query.scope === "trash") {
            const input = { kind: ctx.query.kind, stage: ctx.query.stage, trash: true }
            const project = yield* projectArtifact(
              store.list({ ...input, scope: { type: "project" }, projectID: location.project.id }),
            )
            const global = yield* projectArtifact(store.list({ ...input, scope: { type: "global" } }))
            return { data: [...project, ...global] }
          }
          const scope = ctx.query.scope === "global" ? { type: "global" as const } : { type: "project" as const }
          return {
            data: yield* projectArtifact(
              store.list({
                scope,
                projectID: scope.type === "project" ? location.project.id : undefined,
                kind: ctx.query.kind,
                stage: ctx.query.stage,
              }),
            ),
          }
        }),
      )
      .handle("artifact.get", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          return {
            data: yield* projectArtifact(
              store.get({
                scope: { type: ctx.params.scope },
                projectID: ctx.params.scope === "project" ? location.project.id : undefined,
                kind: ctx.params.kind,
                id: ctx.params.id,
              }),
            ),
          }
        }),
      )
      .handle("artifact.create", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          if (ctx.payload.scope === "global") {
            return { data: yield* projectArtifact(store.previewManual({ id: ctx.payload.id, definition: ctx.payload.definition })) }
          }
          return {
            data: yield* refreshMutation(
              store.writeManual({
                scope: { type: "project" },
                projectID: location.project.id,
                id: ctx.payload.id,
                definition: ctx.payload.definition,
              }),
            ),
          }
        }),
      )
      .handle("artifact.update", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          const input = { id: ctx.params.id, definition: ctx.payload.definition, ...expectation(ctx.payload) }
          if (ctx.params.scope === "global") return { data: yield* projectArtifact(store.previewManual(input)) }
          return {
            data: yield* refreshMutation(
              store.writeManual({ ...input, scope: { type: "project" }, projectID: location.project.id }),
            ),
          }
        }),
      )
      .handle("artifact.confirmGlobal", (ctx) =>
        ProjectArtifactStore.Service.use((store) =>
          refreshMutation(store.confirmManual(ctx.payload.token)).pipe(Effect.map((data) => ({ data }))),
        ),
      )
      .handle("artifact.disable", (ctx) => changeEnabled(ctx, false))
      .handle("artifact.enable", (ctx) => changeEnabled(ctx, true))
      .handle("artifact.remove", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          const scope = yield* projectArtifact(resolveScope(store, location.project.id, ctx.params.scope))
          return {
            data: yield* refreshMutation(
              store.remove({ scopeID: scope.id, kind: ctx.params.kind, id: ctx.params.id, ...expectation(ctx.payload) }),
            ),
          }
        }),
      )
      .handle("artifact.restore", (ctx) =>
        ProjectArtifactStore.Service.use((store) =>
          refreshMutation(store.restore(ctx.params.deletionID)).pipe(Effect.as(HttpApiSchema.NoContent.make())),
        ),
      )
      .handle("artifact.revert", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          const scope = yield* projectArtifact(resolveScope(store, location.project.id, ctx.params.scope))
          return yield* refreshMutation(
            store.revert({
              scopeID: scope.id,
              kind: ctx.params.kind,
              id: ctx.params.id,
              ...expectation(ctx.payload),
              targetVersionID: ctx.payload.targetVersionID,
            }),
          ).pipe(Effect.as(HttpApiSchema.NoContent.make()))
        }),
      )
      .handle("artifact.metrics", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const accounting = yield* ProjectArtifactAccounting.Service
          const location = yield* Location.Service
          const details = yield* projectArtifact(
            store.get({
              scope: { type: ctx.params.scope },
              projectID: ctx.params.scope === "project" ? location.project.id : undefined,
              kind: ctx.params.kind,
              id: ctx.params.id,
            }),
          )
          const data = yield* accounting.metrics(details.currentVersion.id).pipe(
            Effect.mapError(() => new ArtifactUnavailable({ code: "StorageUnavailable" })),
          )
          return { data: { ...data, lastUsedAt: details.artifact.lastUsedAt } }
        }),
      )
      .handle("artifact.promotion.preview", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          return {
            data: yield* projectArtifact(
              store.previewPromotion({
                projectID: location.project.id,
                kind: ctx.params.kind,
                id: ctx.params.id,
                ...expectation(ctx.payload),
              }),
            ),
          }
        }),
      )
      .handle("artifact.promotion.confirm", (ctx) =>
        ProjectArtifactStore.Service.use((store) =>
          refreshMutation(store.confirmPromotion(ctx.params.token)).pipe(Effect.map((data) => ({ data }))),
        ),
      )
      .handle("artifact.fork.preview", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          return {
            data: yield* projectArtifact(
              store.previewFork({
                projectID: location.project.id,
                kind: ctx.params.kind,
                id: ctx.params.id,
                ...expectation(ctx.payload),
              }),
            ),
          }
        }),
      )
      .handle("artifact.fork.confirm", (ctx) =>
        ProjectArtifactStore.Service.use((store) =>
          refreshMutation(store.confirmFork(ctx.params.token)).pipe(Effect.map((data) => ({ data }))),
        ),
      )
      .handle("artifact.shadow.preview", (ctx) =>
        Effect.gen(function* () {
          const store = yield* ProjectArtifactStore.Service
          const location = yield* Location.Service
          const globalScope = yield* projectArtifact(store.resolveGlobalScope())
          const global = yield* projectArtifact(
            store.get({ scope: { type: "global" }, kind: ctx.params.kind, id: ctx.params.id }),
          )
          return {
            data: yield* projectArtifact(
              store.previewShadow({
                projectID: location.project.id,
                kind: ctx.params.kind,
                id: ctx.params.id,
                ...expectation(ctx.payload),
                globalScopeID: globalScope.id,
                globalExpectedRevision: global.artifact.revision,
                globalVersionID: global.currentVersion.id,
                globalDigest: global.currentVersion.contentDigest,
              }),
            ),
          }
        }),
      )
      .handle("artifact.shadow.confirm", (ctx) =>
        ProjectArtifactStore.Service.use((store) =>
          refreshMutation(store.confirmShadow(ctx.params.token)).pipe(Effect.as(HttpApiSchema.NoContent.make())),
        ),
      )
      .handle("artifact.purge", () =>
        ProjectArtifactStore.Service.use((store) =>
          projectArtifact(store.purge()).pipe(Effect.map((count) => ({ data: { count } }))),
        ),
      ),
  ),
)

function changeEnabled(
  ctx: {
    readonly params: { readonly scope: "project" | "global"; readonly kind: ProjectArtifact.Kind; readonly id: ProjectArtifact.ID }
    readonly payload: {
      readonly expectedRevision: ProjectArtifact.Revision
      readonly expectedVersionID: ProjectArtifact.VersionID
      readonly expectedDigest: ProjectArtifact.Digest
    }
  },
  enabled: boolean,
) {
  return Effect.gen(function* () {
    const store = yield* ProjectArtifactStore.Service
    const location = yield* Location.Service
    const scope = yield* projectArtifact(resolveScope(store, location.project.id, ctx.params.scope))
    const input = { scopeID: scope.id, kind: ctx.params.kind, id: ctx.params.id, ...expectation(ctx.payload) }
    const effect = enabled ? store.enable(input) : store.disable(input)
    return yield* refreshMutation(effect).pipe(Effect.as(HttpApiSchema.NoContent.make()))
  })
}

function resolveScope(
  store: ProjectArtifactStore.Interface,
  projectID: Parameters<ProjectArtifactStore.Interface["resolveProjectScope"]>[0],
  scope: "project" | "global",
): Effect.Effect<ProjectArtifact.Scope, ProjectArtifactStore.StoreError> {
  if (scope === "global") return store.resolveGlobalScope()
  return store.resolveProjectScope(projectID)
}

function expectation(input: {
  readonly expectedRevision: ProjectArtifact.Revision
  readonly expectedVersionID: ProjectArtifact.VersionID
  readonly expectedDigest: ProjectArtifact.Digest
}) {
  return {
    expectedRevision: input.expectedRevision,
    expectedVersionID: input.expectedVersionID,
    expectedDigest: input.expectedDigest,
  }
}

export function projectArtifactError(error: ProjectArtifactStore.StoreError) {
  switch (error.code) {
    case "ProjectIdentityUnavailable":
    case "InvalidArtifact":
    case "UnsafeContent":
    case "UnsupportedKind":
    case "InvalidScope":
      return new ArtifactBadRequest({ code: error.code })
    case "ArtifactNotFound":
    case "VersionNotFound":
    case "DeletionNotFound":
      return new ArtifactNotFound({ code: error.code })
    case "ArtifactCollision":
    case "ScopeCollision":
    case "VersionConflict":
    case "OwnershipMismatch":
    case "DestinationExists":
    case "ProjectAdoptionConflict":
      return new ArtifactConflict({ code: error.code })
    case "ConfirmationExpired":
    case "TrashExpired":
      return new ArtifactGone({ code: error.code })
    case "ContentTooLarge":
    case "ScopeQuotaExceeded":
      return new ArtifactTooLarge({ code: error.code })
    case "WriteRateExceeded":
    case "ArtifactCooldown":
      return new ArtifactRateLimited({ code: error.code })
    case "StorageUnavailable":
    case "LockTimeout":
    case "ReconciliationRequired":
      return new ArtifactUnavailable({ code: error.code })
  }
}

function projectArtifact<A, R>(effect: Effect.Effect<A, ProjectArtifactStore.StoreError, R>) {
  return effect.pipe(Effect.mapError(projectArtifactError))
}

function refreshMutation<A, R>(effect: Effect.Effect<A, ProjectArtifactStore.StoreError, R>) {
  return Effect.gen(function* () {
    const result = yield* projectArtifact(effect)
    const source = yield* ProjectArtifactSource.Service
    return yield* refreshAfterProjectArtifactMutation(Effect.succeed(result), source)
  })
}

export function refreshAfterProjectArtifactMutation<A, E, R, SourceR>(
  mutation: Effect.Effect<A, E, R>,
  source: { readonly refresh: () => Effect.Effect<void, never, SourceR> },
) {
  return mutation.pipe(Effect.tap(() => source.refresh()))
}
