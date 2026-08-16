export * as ProjectArtifactStore from "./project-artifact"

import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Agent } from "@ycoding-ai/schema/agent"
import { Project } from "@ycoding-ai/schema/project"
import { Session } from "@ycoding-ai/schema/session"
import type { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { and, asc, eq, gte, inArray, lt, lte, ne, not, or } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Global } from "./global"
import { Hash } from "./util/hash"
import { EffectFlock } from "./util/effect-flock"
import { ProjectArtifactAdapterRegistry } from "./project-artifact/adapter/index"
import { ProjectArtifactPackage } from "./project-artifact/package"
import type { Filesystem } from "./project-artifact/filesystem"
import { ProjectArtifactAccounting } from "./project-artifact/accounting"
import {
  ProjectArtifactScopeTable,
  ProjectArtifactProjectScopeTable,
  ProjectArtifactGlobalScopeTable,
  ProjectArtifactTable,
  ProjectArtifactVersionTable,
  ProjectArtifactTrashTable,
  ProjectArtifactOperationTable,
  ProjectArtifactWriteTable,
  ProjectArtifactFeedbackTable,
  type ProjectArtifactOperation,
} from "./project-artifact/sql"
import { ProjectArtifactValidation } from "./project-artifact/validation"
import {
  ProjectArtifactStandardSourceRegistry,
  type StandardSource,
  type StandardSourceResolver,
} from "./project-artifact/source-registry"

export type { StandardSource, StandardSourceResolver } from "./project-artifact/source-registry"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

const day = 86_400_000
const automaticCaps = { skill: 24, command: 8, agent: 4, plugin: 0 } as const
const decodePackageMarker = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectArtifactPackage.Marker))
const decodeDeletionID = Schema.decodeUnknownOption(ProjectArtifact.DeletionID)
const GovernorStateContext = Schema.Struct({
  agentID: Schema.optional(Agent.ID),
  modelID: Schema.String,
  goalMode: Schema.Boolean,
  now: Schema.Number,
})
const GovernorStateContextJson = Schema.fromJsonString(GovernorStateContext)
const encodeGovernorStateContext = Schema.encodeSync(GovernorStateContextJson)
const decodeGovernorStateContext = Schema.decodeUnknownOption(GovernorStateContextJson)

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("ProjectArtifactStore.Error", {
  code: ProjectArtifact.ErrorCode,
  message: ProjectArtifact.Description,
}) {}

export interface AutomaticWriteInput {
  readonly projectID: Project.ID
  readonly sessionID: Session.ID
  readonly agentID?: Agent.ID
  readonly insightKey: string
  readonly id: string
  readonly definition: unknown
  readonly baseVersionID?: ProjectArtifact.VersionID
  readonly now?: number
}

export interface AdoptionResult {
  readonly scope: ProjectArtifact.ProjectScope
  readonly postCommit: Effect.Effect<void, StoreError>
}

export interface ScopeSelectorInput {
  readonly scope: ProjectArtifact.ScopeSelector
  readonly projectID?: Project.ID
}

export interface ListInput extends ScopeSelectorInput {
  readonly kind?: ProjectArtifact.Kind
  readonly stage?: ProjectArtifact.Stage
  readonly trash?: boolean
}

export interface TrashSummary {
  readonly deletionID: ProjectArtifact.DeletionID
  readonly scope: ProjectArtifact.Scope
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly name: ProjectArtifact.DisplayName
  readonly description: ProjectArtifact.Description
  readonly priorStage: ProjectArtifact.Stage
  readonly priorVersionID: ProjectArtifact.VersionID
  readonly deletedAt: number
  readonly purgeAfter: number
  readonly definition: ProjectArtifact.Definition
}

export interface TrashDetails extends TrashSummary {
  readonly currentVersion: ProjectArtifact.Version
  readonly versions: ReadonlyArray<ProjectArtifact.Version>
}

export type ListItem = ProjectArtifact.ArtifactSummary | TrashSummary

export interface GetInput extends ScopeSelectorInput {
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
}

export interface ManualWriteInput extends ScopeSelectorInput {
  readonly id: string
  readonly definition: ProjectArtifact.Definition
  readonly expectedRevision?: ProjectArtifact.Revision
  readonly expectedVersionID?: ProjectArtifact.VersionID
  readonly expectedDigest?: ProjectArtifact.Digest
  readonly now?: number
}

export interface ManualPreviewInput {
  readonly id: string
  readonly definition: ProjectArtifact.Definition
  readonly expectedRevision?: ProjectArtifact.Revision
  readonly expectedVersionID?: ProjectArtifact.VersionID
  readonly expectedDigest?: ProjectArtifact.Digest
  readonly now?: number
}

export interface ConfirmationPreview {
  readonly token: ProjectArtifact.ConfirmationToken
  readonly expiresAt: number
}

export interface ForkPreviewInput {
  readonly projectID: Project.ID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly expectedRevision?: ProjectArtifact.Revision
  readonly expectedVersionID: ProjectArtifact.VersionID
  readonly expectedDigest: ProjectArtifact.Digest
  readonly now?: number
}

export interface ShadowInput {
  readonly projectID: Project.ID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly expectedRevision: ProjectArtifact.Revision
  readonly expectedVersionID: ProjectArtifact.VersionID
  readonly expectedDigest: ProjectArtifact.Digest
  readonly globalScopeID: ProjectArtifact.ScopeID
  readonly globalExpectedRevision: ProjectArtifact.Revision
  readonly globalVersionID: ProjectArtifact.VersionID
  readonly globalDigest: ProjectArtifact.Digest
  readonly now?: number
}

export interface StoreHooks {
  readonly afterReconcileScan?: (scopeID: ProjectArtifact.ScopeID) => Effect.Effect<void>
  readonly packageFilesystem?: Filesystem
  readonly afterPackageFinalize?: (operationID: string) => Effect.Effect<void>
}

export interface WriteResult {
  readonly result: ProjectArtifact.AutomaticWriteResult
  readonly scopeID: ProjectArtifact.ScopeID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly versionID: ProjectArtifact.VersionID
  readonly contentDigest: ProjectArtifact.Digest
  readonly stage: "trial"
  readonly remaining: {
    readonly session: number
    readonly projectDaily: number
    readonly projectArtifacts: number
    readonly versions: number
    readonly bytes: number
  }
}

export interface PromotionPreviewInput {
  readonly projectID: Project.ID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly expectedRevision: ProjectArtifact.Revision
  readonly expectedVersionID: ProjectArtifact.VersionID
  readonly expectedDigest: ProjectArtifact.Digest
  readonly now?: number
}

export interface DeleteInput {
  readonly scopeID: ProjectArtifact.ScopeID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly expectedRevision: ProjectArtifact.Revision
  readonly expectedVersionID: ProjectArtifact.VersionID
  readonly expectedDigest: ProjectArtifact.Digest
  readonly now?: number
}

export interface RevertInput extends DeleteInput {
  readonly targetVersionID: ProjectArtifact.VersionID
}

export interface RestorePreviewInput {
  readonly deletionID: ProjectArtifact.DeletionID
  readonly now?: number
}

export interface GovernorEvaluationInput extends DeleteInput {
  readonly agentID?: Agent.ID
  readonly modelID: string
  readonly goalMode: boolean
}

export interface Interface {
  readonly resolveProjectScope: (projectID: Project.ID) => Effect.Effect<ProjectArtifact.ProjectScope, StoreError>
  readonly resolveGlobalScope: () => Effect.Effect<ProjectArtifact.GlobalScope, StoreError>
  readonly adoptProject: (
    input: { readonly previousProjectID: Project.ID; readonly projectID: Project.ID },
    tx: Transaction,
  ) => Effect.Effect<AdoptionResult, StoreError>
  readonly writeAutomatic: (input: AutomaticWriteInput) => Effect.Effect<WriteResult, StoreError>
  readonly writeManual: (input: ManualWriteInput) => Effect.Effect<WriteResult, StoreError>
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<ListItem>, StoreError>
  readonly get: (input: GetInput) => Effect.Effect<ProjectArtifact.ArtifactDetails, StoreError>
  readonly getTrash: (deletionID: ProjectArtifact.DeletionID) => Effect.Effect<TrashDetails, StoreError>
  readonly previewManual: (input: ManualPreviewInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmManual: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<WriteResult, StoreError>
  readonly previewFork: (input: ForkPreviewInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmFork: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<WriteResult, StoreError>
  readonly previewShadow: (input: ShadowInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmShadow: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<void, StoreError>
  readonly previewRemove: (input: DeleteInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmRemove: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<ProjectArtifact.Trash, StoreError>
  readonly previewRestore: (input: RestorePreviewInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmRestore: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<void, StoreError>
  readonly previewDisable: (input: DeleteInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmDisable: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<void, StoreError>
  readonly previewEnable: (input: DeleteInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmEnable: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<void, StoreError>
  readonly previewRevert: (input: RevertInput) => Effect.Effect<ConfirmationPreview, StoreError>
  readonly confirmRevert: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<void, StoreError>
  readonly purge: (now?: number) => Effect.Effect<number, StoreError>
  readonly reconcile: (scopeID: ProjectArtifact.ScopeID) => Effect.Effect<ReadonlyArray<ProjectArtifactPackage.Marker>, StoreError>
  readonly remove: (input: DeleteInput) => Effect.Effect<ProjectArtifact.Trash, StoreError>
  readonly restore: (deletionID: ProjectArtifact.DeletionID, now?: number) => Effect.Effect<void, StoreError>
  readonly disable: (input: DeleteInput) => Effect.Effect<void, StoreError>
  readonly enable: (input: DeleteInput) => Effect.Effect<void, StoreError>
  readonly revert: (input: RevertInput) => Effect.Effect<void, StoreError>
  readonly degrade: (input: DeleteInput) => Effect.Effect<void, StoreError>
  readonly evaluateGovernor: (
    input: GovernorEvaluationInput,
  ) => Effect.Effect<ProjectArtifactAccounting.DecideResult, StoreError>
  readonly previewPromotion: (input: PromotionPreviewInput) => Effect.Effect<ProjectArtifact.PromotionPreview, StoreError>
  readonly confirmPromotion: (
    token: ProjectArtifact.ConfirmationToken,
    now?: number,
  ) => Effect.Effect<WriteResult, StoreError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProjectArtifactStore") {}

type ScopeRow = typeof ProjectArtifactScopeTable.$inferSelect
type ArtifactRow = typeof ProjectArtifactTable.$inferSelect
type VersionRow = typeof ProjectArtifactVersionTable.$inferSelect
type TrashRow = typeof ProjectArtifactTrashTable.$inferSelect
type OperationRow = typeof ProjectArtifactOperationTable.$inferSelect

interface OperationSpec {
  readonly id: string
  readonly scopeID: ProjectArtifact.ScopeID
  readonly kind: ProjectArtifact.Kind
  readonly artifactID: ProjectArtifact.ID
  readonly operation: ProjectArtifactOperation
  readonly requestFingerprint: ProjectArtifact.Digest
  readonly expectedRevision?: ProjectArtifact.Revision
  readonly expectedVersionID?: ProjectArtifact.VersionID
  readonly expectedDigest?: ProjectArtifact.Digest
  readonly sourceScopeID?: ProjectArtifact.ScopeID
  readonly sourceVersionID?: ProjectArtifact.VersionID
  readonly sourceDigest?: ProjectArtifact.Digest
  readonly targetVersionID?: ProjectArtifact.VersionID
  readonly targetDigest?: ProjectArtifact.Digest
  readonly deletionID?: ProjectArtifact.DeletionID
  readonly automaticSessionID?: Session.ID
  readonly automaticInsightDigest?: ProjectArtifact.Digest
  readonly now: number
}

interface PromotionToken {
  readonly type: "promotion"
  readonly source: ProjectArtifact.ProjectScope
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly revision: number
  readonly versionID: ProjectArtifact.VersionID
  readonly digest: ProjectArtifact.Digest
  readonly expiresAt: number
}

interface ManualToken {
  readonly type: "manual"
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly content: string
  readonly contentDigest: ProjectArtifact.Digest
  readonly expectedRevision?: ProjectArtifact.Revision
  readonly expectedVersionID?: ProjectArtifact.VersionID
  readonly expectedDigest?: ProjectArtifact.Digest
  readonly expiresAt: number
}

interface ForkToken {
  readonly type: "fork"
  readonly source: ProjectArtifact.GlobalScope
  readonly destination: ProjectArtifact.ProjectScope
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly revision: ProjectArtifact.Revision
  readonly versionID: ProjectArtifact.VersionID
  readonly digest: ProjectArtifact.Digest
  readonly content: string
  readonly expiresAt: number
}

interface ShadowToken {
  readonly type: "shadow"
  readonly project: ProjectArtifact.ProjectScope
  readonly global: ProjectArtifact.GlobalScope
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly projectRevision: ProjectArtifact.Revision
  readonly projectVersionID: ProjectArtifact.VersionID
  readonly projectDigest: ProjectArtifact.Digest
  readonly globalRevision: ProjectArtifact.Revision
  readonly globalVersionID: ProjectArtifact.VersionID
  readonly globalDigest: ProjectArtifact.Digest
  readonly expiresAt: number
}

interface DeleteToken {
  readonly type: "remove" | "disable" | "enable"
  readonly input: DeleteInput
  readonly expiresAt: number
}

interface RevertToken {
  readonly type: "revert"
  readonly input: RevertInput
  readonly expiresAt: number
}

interface RestoreToken {
  readonly type: "restore"
  readonly deletionID: ProjectArtifact.DeletionID
  readonly scopeID: ProjectArtifact.ScopeID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly priorStage: ProjectArtifact.Stage
  readonly priorVersionID: ProjectArtifact.VersionID
  readonly deletedAt: number
  readonly purgeAfter: number
  readonly expiresAt: number
}

type Confirmation = PromotionToken | ManualToken | ForkToken | ShadowToken | DeleteToken | RevertToken | RestoreToken

class GovernorDegrade extends Error {
  constructor(readonly decision: ProjectArtifactAccounting.DecideResult) {
    super("Governor degradation requires filesystem transaction")
  }
}

const layerWithResolver = (standardSources: StandardSourceResolver, hooks: StoreHooks) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const global = yield* Global.Service
    const flock = yield* EffectFlock.Service
    const accounting = yield* ProjectArtifactAccounting.Service
    const tokens = new Map<ProjectArtifact.ConfirmationToken, Confirmation>()

    const packageEffect = <A>(effect: Effect.Effect<A, ProjectArtifactPackage.Failure | EffectFlock.LockError, EffectFlock.Service>) =>
      effect.pipe(
        Effect.provideService(EffectFlock.Service, flock),
        Effect.mapError((cause) =>
          cause instanceof ProjectArtifactPackage.Failure
            ? failure(cause.code)
            : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
        ),
      )

    const packageTransaction = <A, R>(
      effect: Effect.Effect<A, ProjectArtifactPackage.Failure | StoreError, EffectFlock.Service | R>,
    ) =>
      effect.pipe(
        Effect.provideService(EffectFlock.Service, flock),
        Effect.mapError((cause) => cause instanceof StoreError ? cause : failure(cause.code)),
      )

    const stateMutation = (
      input: ProjectArtifactPackage.StateMutationInput,
      finalize: Effect.Effect<void, StoreError>,
      now: number,
    ) =>
      packageTransaction(
        ProjectArtifactPackage.stateTransaction({
          ...input,
          ...(hooks.packageFilesystem ? { filesystem: hooks.packageFilesystem } : {}),
        }, {
          reserve: () => Effect.void,
          finalize: () =>
            Effect.gen(function* () {
              yield* markOperationAvailable(input.operationID, now)
              yield* finalize
              if (hooks.afterPackageFinalize) yield* hooks.afterPackageFinalize(input.operationID)
            }),
          abort: () =>
            db
              .transaction((tx) => abortOperation(tx, input.operationID, now))
              .pipe(Effect.mapError(() => failure("ReconciliationRequired"))),
        }),
      )

    const cleanupFinalizedCommit = Effect.fn("ProjectArtifactStore.cleanupFinalizedCommit")(function* (
      root: string,
      operationID: string,
    ) {
      const metadata = (yield* packageEffect(ProjectArtifactPackage.readCommitTransactions(root))).find(
        (transaction) => transaction.operationID === operationID,
      )
      if (!metadata) return
      yield* packageEffect(ProjectArtifactPackage.cleanupCommitTransaction(metadata))
    })

    const cleanupFinalizedState = Effect.fn("ProjectArtifactStore.cleanupFinalizedState")(function* (
      root: string,
      operationID: string,
    ) {
      const metadata = (yield* packageEffect(ProjectArtifactPackage.readStateTransactions(root))).find(
        (transaction) => transaction.operationID === operationID,
      )
      if (!metadata) return
      yield* packageEffect(ProjectArtifactPackage.cleanupStateTransaction(metadata))
    })

    const storeFeedback = (
      tx: Transaction,
      version: VersionRow,
      action: ProjectArtifact.FeedbackAction,
      actor: ProjectArtifact.FeedbackActor,
      timeCreated: number,
    ) =>
      accounting
        .feedbackInTransaction(
          tx,
          ProjectArtifact.Feedback.make({
            artifact: {
              scopeID: version.scope_id,
              kind: version.kind,
              id: version.artifact_id,
              versionID: version.id,
            },
            action,
            actor,
            timeCreated: ProjectArtifact.TimestampMillis.make(timeCreated),
          }),
        )
        .pipe(Effect.mapError(() => failure("ReconciliationRequired")))

    const reserveOperation = Effect.fn("ProjectArtifactStore.reserveOperation")(function* (
      spec: OperationSpec,
      client: DatabaseClient | Transaction = db,
    ) {
      yield* client
        .insert(ProjectArtifactOperationTable)
        .values({
          id: spec.id,
          scope_id: spec.scopeID,
          kind: spec.kind,
          artifact_id: spec.artifactID,
          operation: spec.operation,
          request_fingerprint: spec.requestFingerprint,
          expected_revision: spec.expectedRevision,
          expected_version_id: spec.expectedVersionID,
          expected_digest: spec.expectedDigest,
          source_scope_id: spec.sourceScopeID,
          source_version_id: spec.sourceVersionID,
          source_digest: spec.sourceDigest,
          target_version_id: spec.targetVersionID,
          target_digest: spec.targetDigest,
          deletion_id: spec.deletionID,
          automatic_session_id: spec.automaticSessionID,
          automatic_insight_digest: spec.automaticInsightDigest,
          phase: "preparing",
          time_created: spec.now,
          time_updated: spec.now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
      const row = yield* client
        .select()
        .from(ProjectArtifactOperationTable)
        .where(
          spec.automaticSessionID && spec.automaticInsightDigest
            ? or(
                eq(ProjectArtifactOperationTable.id, spec.id),
                and(
                  eq(ProjectArtifactOperationTable.scope_id, spec.scopeID),
                  eq(ProjectArtifactOperationTable.automatic_session_id, spec.automaticSessionID),
                  eq(ProjectArtifactOperationTable.automatic_insight_digest, spec.automaticInsightDigest),
                ),
              )
            : eq(ProjectArtifactOperationTable.id, spec.id),
        )
        .get()
        .pipe(Effect.mapError(() => failure("StorageUnavailable")))
      if (!row || !operationMatches(row, spec)) return yield* failure("VersionConflict")
      if (row.phase !== "aborted") return row
      const reopened = yield* client
        .update(ProjectArtifactOperationTable)
        .set({ phase: "preparing", final_version_id: null, time_updated: spec.now })
        .where(
          and(
            eq(ProjectArtifactOperationTable.id, spec.id),
            eq(ProjectArtifactOperationTable.phase, "aborted"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
      if (!reopened) return yield* failure("VersionConflict")
      return reopened
    })

    const markOperationAvailable = Effect.fn("ProjectArtifactStore.markOperationAvailable")(function* (
      operationID: string,
      now: number,
    ) {
      const row = yield* db
        .update(ProjectArtifactOperationTable)
        .set({ phase: "available", time_updated: now })
        .where(
          and(
            eq(ProjectArtifactOperationTable.id, operationID),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
      if (!row) {
        const finalized = yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, operationID))
          .get()
          .pipe(Effect.mapError(() => failure("StorageUnavailable")))
        if (finalized?.phase === "finalized") return finalized
        return yield* failure("VersionConflict")
      }
      return row
    })

    const finalizeOperation = Effect.fn("ProjectArtifactStore.finalizeOperation")(function* (
      tx: Transaction,
      operationID: string,
      finalVersionID: ProjectArtifact.VersionID | undefined,
      now: number,
    ) {
      const row = yield* tx
        .update(ProjectArtifactOperationTable)
        .set({ phase: "finalized", final_version_id: finalVersionID, time_updated: now })
        .where(
          and(
            eq(ProjectArtifactOperationTable.id, operationID),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available", "finalized"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
      if (!row || row.phase !== "finalized" || row.final_version_id !== (finalVersionID ?? null)) {
        return yield* failure("VersionConflict")
      }
      return row
    })

    const abortOperation = Effect.fn("ProjectArtifactStore.abortOperation")(function* (
      tx: Transaction,
      operationID: string,
      now: number,
    ) {
      yield* tx
        .update(ProjectArtifactOperationTable)
        .set({ phase: "aborted", final_version_id: null, time_updated: now })
        .where(
          and(
            eq(ProjectArtifactOperationTable.id, operationID),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
          ),
        )
        .run()
        .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
    })

    const scopeMutation = <A, R>(
      scopeID: ProjectArtifact.ScopeID,
      effect: Effect.Effect<A, StoreError, R>,
    ) =>
      flock.withLock(effect, `project-artifact-scope:${scopeID}`).pipe(
        Effect.mapError((cause) =>
          cause instanceof StoreError
            ? cause
            : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
        ),
      )

    const targetMutation = <A, R>(
      root: string,
      marker: Pick<ProjectArtifactPackage.Marker, "scopeID" | "kind" | "id">,
      effect: Effect.Effect<A, StoreError, R>,
    ) =>
      ProjectArtifactPackage.withArtifactLock({ root, marker }, effect).pipe(
        Effect.provideService(EffectFlock.Service, flock),
        Effect.mapError((cause) => cause instanceof StoreError ? cause : failure(cause.code)),
      )

    const readReconcileMarker = Effect.fn("ProjectArtifactStore.readReconcileMarker")(function* (
      scope: Pick<ScopeRow, "id" | "type" | "storage_id">,
      kind: ProjectArtifact.Kind,
      id: ProjectArtifact.ID,
    ) {
      const root = scopeRoot(global.data, scope.storage_id)
      const contentPath = scope.type === "global"
        ? ProjectArtifactAdapterRegistry.globalPath(kind, global, id)
        : ProjectArtifactPackage.activeContentPath(root, kind, id)
      const markerPath = scope.type === "global"
        ? standardMarkerPath(contentPath, kind, id)
        : ProjectArtifactPackage.activeMarkerPath(root, kind, id)
      if (!(yield* Effect.promise(() => Bun.file(contentPath).exists())) || !(yield* Effect.promise(() => Bun.file(markerPath).exists()))) {
        return undefined
      }
      const encoded = yield* Effect.tryPromise({
        try: () => Bun.file(markerPath).text(),
        catch: () => failure("StorageUnavailable"),
      })
      const marker = Option.getOrUndefined(decodePackageMarker(encoded))
      if (
        !marker ||
        marker.scopeID !== scope.id ||
        marker.storageID !== scope.storage_id ||
        marker.kind !== kind ||
        marker.id !== id
      ) {
        return undefined
      }
      const content = yield* Effect.tryPromise({
        try: () => Bun.file(contentPath).text(),
        catch: () => failure("StorageUnavailable"),
      })
      if (Hash.sha256(content) !== marker.contentDigest) return undefined
      return marker
    })

    const scopeFromRow = (row: ScopeRow, projectID?: Project.ID): ProjectArtifact.Scope =>
      row.type === "project" && projectID !== undefined
        ? { type: "project", id: row.id, projectID, storageID: row.storage_id }
        : { type: "global", id: row.id, storageID: row.storage_id }

    const findProjectScope = Effect.fn("ProjectArtifactStore.findProjectScope")(function* (
      projectID: Project.ID,
      client: DatabaseClient | Transaction = db,
    ) {
      const row = yield* client
        .select({ scope: ProjectArtifactScopeTable })
        .from(ProjectArtifactProjectScopeTable)
        .innerJoin(ProjectArtifactScopeTable, eq(ProjectArtifactProjectScopeTable.scope_id, ProjectArtifactScopeTable.id))
        .where(eq(ProjectArtifactProjectScopeTable.project_id, projectID))
        .get()
        .pipe(Effect.orDie)
      if (row && row.scope.type !== "project") return yield* failure("ReconciliationRequired")
      return row ? (scopeFromRow(row.scope, projectID) as ProjectArtifact.ProjectScope) : undefined
    })

    const resolveProjectScope = Effect.fn("ProjectArtifactStore.resolveProjectScope")(function* (
      projectID: Project.ID,
    ) {
      if (projectID === Project.ID.global) return yield* failure("ProjectIdentityUnavailable")
      const current = yield* findProjectScope(projectID)
      if (current) {
        yield* restoreMissingScopeMarker(scopeRoot(global.data, current.storageID), current)
        return current
      }
      const now = Date.now()
      const created = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* findProjectScope(projectID, tx)
            if (existing) return existing
            const scope = ProjectArtifact.ProjectScope.make({
              type: "project",
              id: scopeID(),
              projectID,
              storageID: ProjectArtifact.StorageID.make(randomUUID().toLowerCase()),
            })
            yield* tx
              .insert(ProjectArtifactScopeTable)
              .values({
                id: scope.id,
                type: scope.type,
                storage_id: scope.storageID,
                time_created: now,
                time_updated: now,
              })
              .run()
            yield* tx
              .insert(ProjectArtifactProjectScopeTable)
              .values({ scope_id: scope.id, project_id: scope.projectID })
              .run()
            return scope
          }),
        )
        .pipe(Effect.mapError(() => failure("StorageUnavailable")))
      yield* writeScopeMarker(scopeRoot(global.data, created.storageID), created).pipe(
        Effect.mapError(() => failure("StorageUnavailable")),
      )
      return created
    })

    const resolveGlobalScope = Effect.fn("ProjectArtifactStore.resolveGlobalScope")(function* () {
      const row = yield* db
        .select({ scope: ProjectArtifactScopeTable })
        .from(ProjectArtifactGlobalScopeTable)
        .innerJoin(ProjectArtifactScopeTable, eq(ProjectArtifactGlobalScopeTable.scope_id, ProjectArtifactScopeTable.id))
        .where(eq(ProjectArtifactGlobalScopeTable.singleton, 1))
        .get()
        .pipe(Effect.orDie)
      if (row?.scope.type !== undefined && row.scope.type !== "global") return yield* failure("ReconciliationRequired")
      if (row) {
        const current = scopeFromRow(row.scope) as ProjectArtifact.GlobalScope
        yield* restoreMissingScopeMarker(scopeRoot(global.data, current.storageID), current)
        return current
      }
      const now = Date.now()
      const scope = ProjectArtifact.GlobalScope.make({
        type: "global",
        id: scopeID(),
        storageID: ProjectArtifact.StorageID.make(randomUUID().toLowerCase()),
      })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(ProjectArtifactScopeTable)
              .values({ id: scope.id, type: scope.type, storage_id: scope.storageID, time_created: now, time_updated: now })
              .run()
            yield* tx.insert(ProjectArtifactGlobalScopeTable).values({ scope_id: scope.id, singleton: 1 }).run()
          }),
        )
        .pipe(Effect.mapError(() => failure("StorageUnavailable")))
      yield* writeScopeMarker(scopeRoot(global.data, scope.storageID), scope).pipe(
        Effect.mapError(() => failure("StorageUnavailable")),
      )
      return scope
    })

    const adoptProject = Effect.fn("ProjectArtifactStore.adoptProject")(function* (
      input: { readonly previousProjectID: Project.ID; readonly projectID: Project.ID },
      tx: Transaction,
    ) {
      if (input.projectID === Project.ID.global || input.previousProjectID === Project.ID.global) {
        return yield* failure("ProjectIdentityUnavailable")
      }
      const previous = yield* findProjectScope(input.previousProjectID, tx)
      const current = yield* findProjectScope(input.projectID, tx)
      if (previous && current && previous.id !== current.id) return yield* failure("ProjectAdoptionConflict")
      const scope = current
        ? current
        : previous
          ? ProjectArtifact.ProjectScope.make({ ...previous, projectID: input.projectID })
          : ProjectArtifact.ProjectScope.make({
              type: "project",
              id: scopeID(),
              projectID: input.projectID,
              storageID: ProjectArtifact.StorageID.make(randomUUID().toLowerCase()),
            })
      if (previous && !current) {
        yield* tx
          .update(ProjectArtifactProjectScopeTable)
          .set({ project_id: input.projectID })
          .where(eq(ProjectArtifactProjectScopeTable.scope_id, previous.id))
          .run()
          .pipe(Effect.mapError(() => failure("StorageUnavailable")))
      }
      if (!previous && !current) {
        const now = Date.now()
        yield* tx
          .insert(ProjectArtifactScopeTable)
          .values({
            id: scope.id,
            type: scope.type,
            storage_id: scope.storageID,
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.mapError(() => failure("StorageUnavailable")))
        yield* tx
          .insert(ProjectArtifactProjectScopeTable)
          .values({ scope_id: scope.id, project_id: scope.projectID })
          .run()
          .pipe(Effect.mapError(() => failure("StorageUnavailable")))
      }
      return {
        scope,
        postCommit: writeScopeMarker(scopeRoot(global.data, scope.storageID), scope).pipe(
          Effect.mapError(() => failure("StorageUnavailable")),
        ),
      }
    })

    const resolveScope = Effect.fn("ProjectArtifactStore.resolveScope")(function* (input: ScopeSelectorInput) {
      if (input.scope.type === "global") return yield* resolveGlobalScope()
      if (!input.projectID) return yield* failure("ProjectIdentityUnavailable")
      return yield* resolveProjectScope(input.projectID)
    })

    const commitSnapshot = Effect.fn("ProjectArtifactStore.commitSnapshot")(function* (input: {
      readonly scope: ProjectArtifact.Scope
      readonly kind: ProjectArtifact.Kind
      readonly id: ProjectArtifact.ID
      readonly content: string
      readonly contentDigest: ProjectArtifact.Digest
      readonly source: ProjectArtifact.Source
      readonly now: number
      readonly artifact?: ArtifactRow
      readonly currentVersion?: VersionRow
      readonly originScopeID?: ProjectArtifact.ScopeID
      readonly originVersionID?: ProjectArtifact.VersionID
      readonly originEvidenceDigest?: ProjectArtifact.Digest
      readonly shadowedScopeID?: ProjectArtifact.ScopeID
    }) {
      if (input.currentVersion?.content_digest === input.contentDigest) {
        return writeResultValue(
          "reconciled",
          input.scope.id,
          input.kind,
          input.id,
          input.currentVersion.id,
          input.contentDigest,
          emptyCounters,
        )
      }
      const versionID = versionIDValue()
      const marker = ProjectArtifactPackage.marker({
        scopeID: input.scope.id,
        storageID: input.scope.storageID,
        kind: input.kind,
        id: input.id,
        versionID,
        content: input.content,
      })
      const root = scopeRoot(global.data, input.scope.storageID)
      const result = input.artifact ? ("updated" as const) : ("created" as const)
      const operation: ProjectArtifactOperation = input.source === "fork"
        ? "fork"
        : input.artifact
          ? "update"
          : "create"
      const requestFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256(
          [
            input.scope.id,
            input.kind,
            input.id,
            operation,
            input.artifact?.revision ?? "",
            input.artifact?.current_version_id ?? "",
            input.currentVersion?.content_digest ?? "",
            input.originScopeID ?? "",
            input.originVersionID ?? "",
            input.originEvidenceDigest ?? "",
            versionID,
            input.contentDigest,
          ].join("\0"),
        ),
      )
      const operationID = `pop_${requestFingerprint.slice(0, 32)}`
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: input.scope.id,
        kind: input.kind,
        artifactID: input.id,
        operation,
        requestFingerprint,
        expectedRevision: input.artifact?.revision,
        expectedVersionID: input.artifact?.current_version_id,
        expectedDigest: input.currentVersion?.content_digest,
        sourceScopeID: operation === "fork" ? input.originScopeID : undefined,
        sourceVersionID: operation === "fork" ? input.originVersionID : undefined,
        sourceDigest: operation === "fork" ? input.originEvidenceDigest : undefined,
        targetVersionID: versionID,
        targetDigest: input.contentDigest,
        now: input.now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      if (reserved.phase === "finalized") {
        yield* cleanupFinalizedCommit(root, operationID)
        return writeResultValue(result, input.scope.id, input.kind, input.id, versionID, input.contentDigest, emptyCounters)
      }
      const transactionHooks: ProjectArtifactPackage.CommitTransactionHooks<StoreError, never> = {
        reserve: () => reserveOperation(operationSpec).pipe(Effect.asVoid),
        finalize: () => Effect.gen(function* () {
          yield* markOperationAvailable(operationID, input.now)
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
            yield* tx.run("PRAGMA defer_foreign_keys = ON")
            const finalized = yield* getArtifact(tx, input.scope.id, input.kind, input.id)
            if (finalized?.current_version_id === versionID) {
              const finalizedVersion = yield* getVersion(tx, versionID)
              if (finalizedVersion?.content_digest !== input.contentDigest) return yield* failure("VersionConflict")
              yield* finalizeOperation(tx, operationID, versionID, input.now)
              return
            }
            if (!input.artifact) {
              if (finalized) return yield* failure("VersionConflict")
              yield* tx
                .insert(ProjectArtifactTable)
                .values({
                  scope_id: input.scope.id,
                  kind: input.kind,
                  artifact_id: input.id,
                  revision: 0,
                  stage: "trial",
                  current_version_id: versionID,
                  shadowed_scope_id: input.shadowedScopeID,
                  time_created: input.now,
                  time_updated: input.now,
                })
                .run()
            } else {
              const updated = yield* tx
                .update(ProjectArtifactTable)
                .set({
                  revision: input.artifact.revision + 1,
                  stage: "trial",
                  current_version_id: versionID,
                  fallback_version_id: input.artifact.current_version_id,
                  shadowed_scope_id: input.shadowedScopeID ?? input.artifact.shadowed_scope_id,
                  time_updated: input.now,
                })
                .where(
                  and(
                    eq(ProjectArtifactTable.scope_id, input.scope.id),
                    eq(ProjectArtifactTable.kind, input.kind),
                    eq(ProjectArtifactTable.artifact_id, input.id),
                    eq(ProjectArtifactTable.revision, input.artifact.revision),
                    eq(ProjectArtifactTable.current_version_id, input.artifact.current_version_id),
                  ),
                )
                .returning({ revision: ProjectArtifactTable.revision })
                .get()
              if (!updated) return yield* failure("VersionConflict")
              yield* tx
                .update(ProjectArtifactVersionTable)
                .set({ state: "superseded", time_state_changed: input.now })
                .where(eq(ProjectArtifactVersionTable.id, input.artifact.current_version_id))
                .run()
            }
            yield* tx
              .insert(ProjectArtifactVersionTable)
              .values({
                id: versionID,
                scope_id: input.scope.id,
                kind: input.kind,
                artifact_id: input.id,
                parent_version_id: input.artifact?.current_version_id,
                state: "trial",
                content_digest: input.contentDigest,
                content_relpath: marker.contentRelpath,
                source: input.source,
                origin_scope_id: input.originScopeID,
                origin_version_id: input.originVersionID,
                origin_evidence_digest: input.originEvidenceDigest,
                time_created: input.now,
                time_state_changed: input.now,
              })
              .run()
            yield* finalizeOperation(tx, operationID, versionID, input.now)
            })
          )
          if (hooks.afterPackageFinalize) yield* hooks.afterPackageFinalize(operationID)
        }).pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired"))),
        abort: () =>
          db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.run("PRAGMA defer_foreign_keys = ON")
                if (!input.artifact) {
                  yield* tx
                    .delete(ProjectArtifactTable)
                    .where(
                      and(
                        eq(ProjectArtifactTable.scope_id, input.scope.id),
                        eq(ProjectArtifactTable.kind, input.kind),
                        eq(ProjectArtifactTable.artifact_id, input.id),
                        eq(ProjectArtifactTable.current_version_id, versionID),
                      ),
                    )
                    .run()
                  yield* abortOperation(tx, operationID, input.now)
                  return
                }
                yield* tx
                  .update(ProjectArtifactTable)
                  .set({
                    revision: input.artifact.revision,
                    stage: input.artifact.stage,
                    current_version_id: input.artifact.current_version_id,
                    fallback_version_id: input.artifact.fallback_version_id,
                    shadowed_scope_id: input.artifact.shadowed_scope_id,
                    time_updated: input.artifact.time_updated,
                  })
                  .where(
                    and(
                      eq(ProjectArtifactTable.scope_id, input.scope.id),
                      eq(ProjectArtifactTable.kind, input.kind),
                      eq(ProjectArtifactTable.artifact_id, input.id),
                      eq(ProjectArtifactTable.current_version_id, versionID),
                    ),
                  )
                  .run()
                if (input.currentVersion) {
                  yield* tx
                    .update(ProjectArtifactVersionTable)
                    .set({
                      state: input.currentVersion.state,
                      time_state_changed: input.currentVersion.time_state_changed,
                    })
                    .where(eq(ProjectArtifactVersionTable.id, input.currentVersion.id))
                    .run()
                }
                yield* tx.delete(ProjectArtifactVersionTable).where(eq(ProjectArtifactVersionTable.id, versionID)).run()
                yield* abortOperation(tx, operationID, input.now)
              }),
            )
            .pipe(Effect.mapError(() => failure("ReconciliationRequired"))),
      }
      if (input.scope.type === "project") {
        yield* packageTransaction(
          ProjectArtifactPackage.commitTransaction(
            {
              root,
              marker,
              content: input.content,
              expectedVersionID: input.artifact?.current_version_id,
              operationID,
              ...(hooks.packageFilesystem ? { filesystem: hooks.packageFilesystem } : {}),
            },
            transactionHooks,
          ),
        )
      } else {
        const contentPath = ProjectArtifactAdapterRegistry.globalPath(input.kind, global, input.id)
        const markerPath = standardMarkerPath(contentPath, input.kind, input.id)
        yield* Effect.tryPromise({
          try: () => Promise.all([fs.mkdir(path.dirname(contentPath), { recursive: true }), fs.mkdir(path.dirname(markerPath), { recursive: true })]),
          catch: () => failure("StorageUnavailable"),
        })
        yield* packageTransaction(
          ProjectArtifactPackage.commitTransaction(
            {
              root,
              marker,
              content: input.content,
              contentPath,
              markerPath,
              expectedVersionID: input.artifact?.current_version_id,
              noOverwrite: !input.artifact,
              operationID,
              ...(hooks.packageFilesystem ? { filesystem: hooks.packageFilesystem } : {}),
            },
            transactionHooks,
          ),
        )
      }
      return writeResultValue(result, input.scope.id, input.kind, input.id, versionID, input.contentDigest, emptyCounters)
    })

    const writeAutomatic = Effect.fn("ProjectArtifactStore.writeAutomatic")(function* (input: AutomaticWriteInput) {
      const validation = ProjectArtifactValidation.validateAutomatic({
        id: input.id,
        definition: input.definition,
      })
      if (validation[0]) return yield* failure(validation[0].code)
      const insightErrors = ProjectArtifactValidation.validateText(input.insightKey, "insightKey", 512)
      if (insightErrors[0]) return yield* failure(insightErrors[0].code)
      const definition = ProjectArtifactAdapterRegistry.decode(
        (input.definition as { readonly kind: ProjectArtifact.Kind }).kind,
        input.definition,
      )
      if (definition.kind === "plugin") return yield* failure("UnsupportedKind")
      const id = ProjectArtifact.ID.make(input.id)
      const content = ProjectArtifactAdapterRegistry.render(definition, {
        source: "agent",
        creatorAgentID: input.agentID,
        creatorSessionID: input.sessionID,
      })
      const renderedErrors = ProjectArtifactValidation.validateRendered(content)
      if (renderedErrors[0]) return yield* failure(renderedErrors[0].code)
      const contentDigest = ProjectArtifact.Digest.make(Hash.sha256(content))
      const insightDigest = ProjectArtifact.Digest.make(Hash.sha256(normalizeInsight(input.insightKey)))
      const scope = yield* resolveProjectScope(input.projectID)
      const now = input.now ?? Date.now()
      const operation = input.baseVersionID ? ("update" as const) : ("create" as const)
      const requestFingerprint = automaticRequestFingerprint({
        scopeID: scope.id,
        kind: definition.kind,
        id,
        operation,
        baseVersionID: input.baseVersionID,
        contentDigest,
      })
      const operationFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256([scope.id, input.sessionID, insightDigest, requestFingerprint].join("\0")),
      )
      const operationID = `pop_${operationFingerprint.slice(0, 32)}`
      const versionID = ProjectArtifact.VersionID.make(`pav_${Hash.sha256(operationID).slice(0, 32)}`)
      const write = Effect.gen(function* () {
      yield* db
        .delete(ProjectArtifactWriteTable)
        .where(lt(ProjectArtifactWriteTable.time_created, now - 30 * day))
        .run()
        .pipe(Effect.orDie)
      const priorWrite = yield* db
        .select()
        .from(ProjectArtifactWriteTable)
        .where(
          and(
            eq(ProjectArtifactWriteTable.scope_id, scope.id),
            eq(ProjectArtifactWriteTable.session_id, input.sessionID),
            eq(ProjectArtifactWriteTable.insight_digest, insightDigest),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (priorWrite) {
        const version = yield* getVersion(db, priorWrite.version_id)
        if (!version) return yield* failure("VersionConflict")
        const stored = automaticRequestFingerprint({
          scopeID: version.scope_id,
          kind: version.kind,
          id: version.artifact_id,
          operation: priorWrite.operation === "reconcile" ? "update" : priorWrite.operation,
          baseVersionID:
            priorWrite.result === "created"
              ? undefined
              : priorWrite.result === "reconciled"
                ? version.id
                : version.parent_version_id ?? undefined,
          contentDigest: priorWrite.content_digest,
        })
        if (requestFingerprint !== stored || version.content_digest !== contentDigest) return yield* failure("VersionConflict")
        yield* cleanupFinalizedCommit(scopeRoot(global.data, scope.storageID), operationID)
        return yield* writeResult(priorWrite.result, scope.id, version.kind, version.artifact_id, version.id, contentDigest, {
          db,
          sessionID: input.sessionID,
          scopeID: scope.id,
          now,
          root: scopeRoot(global.data, scope.storageID),
          kind: definition.kind,
          id,
        })
      }
      const artifact = yield* getArtifact(db, scope.id, definition.kind, id)
      const currentVersion = artifact ? yield* getVersion(db, artifact.current_version_id) : undefined
      const available = yield* readReconcileMarker(
        {
          id: scope.id,
          type: scope.type,
          storage_id: scope.storageID,
        },
        definition.kind,
        id,
      )
      const recovering = available?.versionID === versionID && available.contentDigest === contentDigest
      if ((yield* standardSources.resolve({ scope: "project", projectID: input.projectID, kind: definition.kind, id })).length > 0) {
        return yield* failure("ArtifactCollision")
      }
      const crossScope = yield* db
        .select()
        .from(ProjectArtifactTable)
        .where(
          and(
            eq(ProjectArtifactTable.kind, definition.kind),
            eq(ProjectArtifactTable.artifact_id, id),
            not(eq(ProjectArtifactTable.scope_id, scope.id)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const crossVersion = crossScope ? yield* getVersion(db, crossScope.current_version_id) : undefined
      const globalSources = yield* standardSources.resolve({ scope: "global", kind: definition.kind, id })
      const shadowConfirmation = crossScope && crossVersion
        ? yield* db
            .select({ id: ProjectArtifactOperationTable.id })
            .from(ProjectArtifactOperationTable)
            .where(
              and(
                eq(ProjectArtifactOperationTable.kind, definition.kind),
                eq(ProjectArtifactOperationTable.artifact_id, id),
                eq(ProjectArtifactOperationTable.phase, "finalized"),
                or(
                  and(
                    eq(ProjectArtifactOperationTable.operation, "shadow"),
                    eq(ProjectArtifactOperationTable.scope_id, scope.id),
                    eq(ProjectArtifactOperationTable.source_scope_id, crossScope.scope_id),
                    eq(ProjectArtifactOperationTable.source_version_id, crossVersion.id),
                    eq(ProjectArtifactOperationTable.source_digest, crossVersion.content_digest),
                  ),
                  and(
                    eq(ProjectArtifactOperationTable.operation, "promotion"),
                    eq(ProjectArtifactOperationTable.scope_id, crossScope.scope_id),
                    eq(ProjectArtifactOperationTable.source_scope_id, scope.id),
                    eq(ProjectArtifactOperationTable.target_version_id, crossVersion.id),
                    eq(ProjectArtifactOperationTable.target_digest, crossVersion.content_digest),
                  ),
                ),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      const exactShadow =
        artifact !== undefined &&
        currentVersion !== undefined &&
        crossScope !== undefined &&
        crossVersion !== undefined &&
        artifact.shadowed_scope_id === crossScope.scope_id &&
        shadowConfirmation !== undefined &&
        exactManagedSources(globalSources, crossScope.scope_id, crossVersion.id, crossVersion.content_digest)
      if ((globalSources.length > 0 || crossScope) && !exactShadow) {
        return yield* failure("ArtifactCollision")
      }
      if (!recovering && !artifact && input.baseVersionID) return yield* failure("VersionConflict")
      if (!recovering && artifact && !input.baseVersionID) return yield* failure("VersionConflict")
      if (!recovering && artifact && artifact.current_version_id !== input.baseVersionID) return yield* failure("VersionConflict")
      if (recovering && artifact && artifact.current_version_id !== versionID) return yield* failure("VersionConflict")
      if (!recovering && currentVersion?.content_digest === contentDigest) {
        const record = {
          scope_id: scope.id,
          session_id: input.sessionID,
          insight_digest: insightDigest,
          operation: "update" as const,
          result: "reconciled" as const,
          version_id: currentVersion.id,
          content_digest: contentDigest,
          time_created: now,
        }
        yield* db.insert(ProjectArtifactWriteTable).values(record).run().pipe(Effect.orDie)
        return yield* writeResult("reconciled", scope.id, definition.kind, id, currentVersion.id, contentDigest, {
          db,
          sessionID: input.sessionID,
          scopeID: scope.id,
          now,
          root: scopeRoot(global.data, scope.storageID),
          kind: definition.kind,
          id,
        })
      }
      if (!recovering) {
        const counters = yield* quotaCounters({
          db,
          sessionID: input.sessionID,
          scopeID: scope.id,
          now,
          root: scopeRoot(global.data, scope.storageID),
          kind: definition.kind,
          id,
        })
        if (counters.session >= 3 || counters.projectDaily >= 10) return yield* failure("WriteRateExceeded")
        if (!artifact && (counters.artifacts >= 32 || counters.kindArtifacts >= automaticCaps[definition.kind])) {
          return yield* failure("ScopeQuotaExceeded")
        }
        if (artifact && counters.versions >= 16) return yield* failure("ScopeQuotaExceeded")
        if (counters.bytes + new TextEncoder().encode(content).byteLength > 8 * 1_024 * 1_024) {
          return yield* failure("ScopeQuotaExceeded")
        }
        if (artifact && currentVersion && now - currentVersion.time_created < 3_600_000) {
          return yield* failure("ArtifactCooldown")
        }
      }
      const marker = ProjectArtifactPackage.marker({
        scopeID: scope.id,
        storageID: scope.storageID,
        kind: definition.kind,
        id,
        versionID,
        content,
      })
      const expectedVersion = input.baseVersionID ? yield* getVersion(db, input.baseVersionID) : undefined
      if (input.baseVersionID && !expectedVersion) return yield* failure("VersionConflict")
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: scope.id,
        kind: definition.kind,
        artifactID: id,
        operation,
        requestFingerprint: operationFingerprint,
        expectedRevision:
          operation === "update" && artifact
            ? ProjectArtifact.Revision.make(recovering ? Math.max(0, artifact.revision - 1) : artifact.revision)
            : undefined,
        expectedVersionID: operation === "update" ? input.baseVersionID : undefined,
        expectedDigest: operation === "update" ? expectedVersion?.content_digest : undefined,
        targetVersionID: versionID,
        targetDigest: contentDigest,
        automaticSessionID: input.sessionID,
        automaticInsightDigest: insightDigest,
        now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      if (reserved.phase === "finalized") {
        yield* cleanupFinalizedCommit(scopeRoot(global.data, scope.storageID), operationID)
        const completed = yield* db
          .select()
          .from(ProjectArtifactWriteTable)
          .where(
            and(
              eq(ProjectArtifactWriteTable.scope_id, scope.id),
              eq(ProjectArtifactWriteTable.session_id, input.sessionID),
              eq(ProjectArtifactWriteTable.insight_digest, insightDigest),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!completed || completed.version_id !== versionID || completed.content_digest !== contentDigest) {
          return yield* failure("ReconciliationRequired")
        }
        return yield* writeResult(completed.result, scope.id, definition.kind, id, versionID, contentDigest, {
          db,
          sessionID: input.sessionID,
          scopeID: scope.id,
          now,
          root: scopeRoot(global.data, scope.storageID),
          kind: definition.kind,
          id,
        })
      }
      const result = operation === "update" ? ("updated" as const) : ("created" as const)
      yield* packageTransaction(
        ProjectArtifactPackage.commitTransaction(
          {
            root: scopeRoot(global.data, scope.storageID),
            marker,
            content,
            expectedVersionID: input.baseVersionID,
            operationID,
            ...(hooks.packageFilesystem ? { filesystem: hooks.packageFilesystem } : {}),
          },
          {
            reserve: () => reserveOperation(operationSpec).pipe(Effect.asVoid),
            finalize: () =>
              Effect.gen(function* () {
                yield* markOperationAvailable(operationID, now)
                yield* db.transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx.run("PRAGMA defer_foreign_keys = ON")
                    const finalizedArtifact = yield* getArtifact(tx, scope.id, definition.kind, id)
                    const finalizedVersion = yield* getVersion(tx, versionID)
                    const recovered =
                      finalizedArtifact?.current_version_id === versionID &&
                      finalizedVersion?.content_digest === contentDigest
                    if (!recovered) {
                      if (operation === "create") {
                        if (finalizedArtifact || finalizedVersion) return yield* failure("VersionConflict")
                        yield* tx
                          .insert(ProjectArtifactTable)
                          .values({
                            scope_id: scope.id,
                            kind: definition.kind,
                            artifact_id: id,
                            revision: 0,
                            stage: "trial",
                            current_version_id: versionID,
                            time_created: now,
                            time_updated: now,
                          })
                          .run()
                      } else {
                        if (
                          !artifact ||
                          !finalizedArtifact ||
                          finalizedArtifact.revision !== artifact.revision ||
                          finalizedArtifact.current_version_id !== input.baseVersionID
                        ) {
                          return yield* failure("VersionConflict")
                        }
                        const updated = yield* tx
                          .update(ProjectArtifactTable)
                          .set({
                            revision: artifact.revision + 1,
                            stage: "trial",
                            current_version_id: versionID,
                            fallback_version_id: artifact.current_version_id,
                            time_updated: now,
                          })
                          .where(
                            and(
                              eq(ProjectArtifactTable.scope_id, scope.id),
                              eq(ProjectArtifactTable.kind, definition.kind),
                              eq(ProjectArtifactTable.artifact_id, id),
                              eq(ProjectArtifactTable.revision, artifact.revision),
                              eq(ProjectArtifactTable.current_version_id, artifact.current_version_id),
                            ),
                          )
                          .returning({ revision: ProjectArtifactTable.revision })
                          .get()
                        if (!updated) return yield* failure("VersionConflict")
                        yield* tx
                          .update(ProjectArtifactVersionTable)
                          .set({ state: "superseded", time_state_changed: now })
                          .where(eq(ProjectArtifactVersionTable.id, artifact.current_version_id))
                          .run()
                      }
                    }
                    if (finalizedVersion) {
                      if (
                        finalizedVersion.scope_id !== scope.id ||
                        finalizedVersion.kind !== definition.kind ||
                        finalizedVersion.artifact_id !== id ||
                        finalizedVersion.content_digest !== contentDigest
                      ) {
                        return yield* failure("VersionConflict")
                      }
                      yield* tx
                        .update(ProjectArtifactVersionTable)
                        .set({
                          parent_version_id: input.baseVersionID,
                          state: "trial",
                          source: "agent",
                          creator_agent_id: input.agentID,
                          creator_session_id: input.sessionID,
                          insight_digest: insightDigest,
                          time_state_changed: now,
                        })
                        .where(eq(ProjectArtifactVersionTable.id, versionID))
                        .run()
                    } else {
                      yield* tx
                        .insert(ProjectArtifactVersionTable)
                        .values({
                          id: versionID,
                          scope_id: scope.id,
                          kind: definition.kind,
                          artifact_id: id,
                          parent_version_id: input.baseVersionID,
                          state: "trial",
                          content_digest: contentDigest,
                          content_relpath: marker.contentRelpath,
                          source: "agent",
                          creator_agent_id: input.agentID,
                          creator_session_id: input.sessionID,
                          insight_digest: insightDigest,
                          time_created: now,
                          time_state_changed: now,
                        })
                        .run()
                    }
                    yield* tx
                      .insert(ProjectArtifactWriteTable)
                      .values({
                        scope_id: scope.id,
                        session_id: input.sessionID,
                        insight_digest: insightDigest,
                        operation,
                        result,
                        version_id: versionID,
                        content_digest: contentDigest,
                        time_created: now,
                      })
                      .onConflictDoNothing()
                      .run()
                    const completed = yield* tx
                      .select()
                      .from(ProjectArtifactWriteTable)
                      .where(
                        and(
                          eq(ProjectArtifactWriteTable.scope_id, scope.id),
                          eq(ProjectArtifactWriteTable.session_id, input.sessionID),
                          eq(ProjectArtifactWriteTable.insight_digest, insightDigest),
                        ),
                      )
                      .get()
                    if (
                      !completed ||
                      completed.operation !== operation ||
                      completed.result !== result ||
                      completed.version_id !== versionID ||
                      completed.content_digest !== contentDigest
                    ) {
                      return yield* failure("VersionConflict")
                    }
                    yield* finalizeOperation(tx, operationID, versionID, now)
                  }),
                )
                if (hooks.afterPackageFinalize) yield* hooks.afterPackageFinalize(operationID)
              }).pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired"))),
            abort: (metadata) =>
              db
                .transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx.run("PRAGMA defer_foreign_keys = ON")
                    yield* tx
                      .delete(ProjectArtifactWriteTable)
                      .where(
                        and(
                          eq(ProjectArtifactWriteTable.scope_id, scope.id),
                          eq(ProjectArtifactWriteTable.session_id, input.sessionID),
                          eq(ProjectArtifactWriteTable.insight_digest, insightDigest),
                        ),
                      )
                      .run()
                    if (!metadata.previous) {
                      yield* tx
                        .delete(ProjectArtifactTable)
                        .where(
                          and(
                            eq(ProjectArtifactTable.scope_id, scope.id),
                            eq(ProjectArtifactTable.kind, definition.kind),
                            eq(ProjectArtifactTable.artifact_id, id),
                            eq(ProjectArtifactTable.current_version_id, versionID),
                          ),
                        )
                        .run()
                      yield* abortOperation(tx, operationID, now)
                      return
                    }
                    const finalizedArtifact = yield* getArtifact(tx, scope.id, definition.kind, id)
                    const previousVersion = yield* getVersion(tx, metadata.previous.versionID)
                    if (!finalizedArtifact || !previousVersion) return yield* failure("ReconciliationRequired")
                    const original = artifact?.current_version_id === versionID ? undefined : artifact
                    yield* tx
                      .update(ProjectArtifactTable)
                      .set({
                        revision: original?.revision ?? Math.max(0, finalizedArtifact.revision - 1),
                        stage: original?.stage ?? "trial",
                        current_version_id: metadata.previous.versionID,
                        fallback_version_id: original?.fallback_version_id ?? previousVersion.parent_version_id,
                        shadowed_scope_id: original?.shadowed_scope_id ?? finalizedArtifact.shadowed_scope_id,
                        time_updated: original?.time_updated ?? previousVersion.time_state_changed,
                      })
                      .where(
                        and(
                          eq(ProjectArtifactTable.scope_id, scope.id),
                          eq(ProjectArtifactTable.kind, definition.kind),
                          eq(ProjectArtifactTable.artifact_id, id),
                          eq(ProjectArtifactTable.current_version_id, versionID),
                        ),
                      )
                      .run()
                    yield* tx
                      .update(ProjectArtifactVersionTable)
                      .set({ state: original?.stage ?? "trial", time_state_changed: original?.time_updated ?? now })
                      .where(eq(ProjectArtifactVersionTable.id, metadata.previous.versionID))
                      .run()
                    yield* tx.delete(ProjectArtifactVersionTable).where(eq(ProjectArtifactVersionTable.id, versionID)).run()
                    yield* abortOperation(tx, operationID, now)
                  }),
                )
                .pipe(
                  Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")),
                ),
          },
        ),
      )
      return yield* writeResult(result, scope.id, definition.kind, id, versionID, contentDigest, {
        db,
        sessionID: input.sessionID,
        scopeID: scope.id,
        now,
        root: scopeRoot(global.data, scope.storageID),
        kind: definition.kind,
        id,
      })
      })
      return yield* flock
        .withLock(
          flock.withLock(write, `project-artifact-scope:${scope.id}`),
          `project-artifact-session:${input.sessionID}`,
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof StoreError
              ? cause
              : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
          ),
        )
    })

    const writeManual = Effect.fn("ProjectArtifactStore.writeManual")(function* (input: ManualWriteInput) {
      if (input.scope.type !== "project" || !input.projectID) return yield* failure("InvalidScope")
      const validation = ProjectArtifactValidation.validateAutomatic({ id: input.id, definition: input.definition })
      if (validation[0]) return yield* failure(validation[0].code)
      const definition = ProjectArtifactAdapterRegistry.decode(input.definition.kind, input.definition)
      if (definition.kind === "plugin") return yield* failure("UnsupportedKind")
      const id = ProjectArtifact.ID.make(input.id)
      const content = ProjectArtifactAdapterRegistry.render(definition, { source: "user" })
      const renderedErrors = ProjectArtifactValidation.validateRendered(content)
      if (renderedErrors[0]) return yield* failure(renderedErrors[0].code)
      const contentDigest = ProjectArtifact.Digest.make(Hash.sha256(content))
      const scope = yield* resolveProjectScope(input.projectID)
      const write = Effect.gen(function* () {
        const artifact = yield* getArtifact(db, scope.id, definition.kind, id)
        if ((yield* standardSources.resolve({ scope: "project", projectID: input.projectID, kind: definition.kind, id })).length > 0) {
          return yield* failure("ArtifactCollision")
        }
        const crossScope = yield* db
          .select({ scope_id: ProjectArtifactTable.scope_id })
          .from(ProjectArtifactTable)
          .where(
            and(
              eq(ProjectArtifactTable.kind, definition.kind),
              eq(ProjectArtifactTable.artifact_id, id),
              not(eq(ProjectArtifactTable.scope_id, scope.id)),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!artifact && crossScope) return yield* failure("ArtifactCollision")
        const currentVersion = artifact ? yield* getVersion(db, artifact.current_version_id) : undefined
        const expectations = [input.expectedRevision, input.expectedVersionID, input.expectedDigest]
        if (!artifact && expectations.some((value) => value !== undefined)) return yield* failure("VersionConflict")
        if (
          artifact &&
          (!currentVersion ||
            input.expectedRevision === undefined ||
            input.expectedVersionID === undefined ||
            input.expectedDigest === undefined ||
            artifact.revision !== input.expectedRevision ||
            currentVersion.id !== input.expectedVersionID ||
            currentVersion.content_digest !== input.expectedDigest)
        ) {
          return yield* failure("VersionConflict")
        }
        return yield* commitSnapshot({
          scope,
          kind: definition.kind,
          id,
          content,
          contentDigest,
          source: "user",
          now: input.now ?? Date.now(),
          artifact,
          currentVersion,
        })
      })
      return yield* flock.withLock(write, `project-artifact-scope:${scope.id}`).pipe(
        Effect.mapError((cause) =>
          cause instanceof StoreError
            ? cause
            : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
        ),
      )
    })

    const details = Effect.fn("ProjectArtifactStore.details")(function* (
      scope: ProjectArtifact.Scope,
      artifact: ArtifactRow,
    ) {
      const currentVersion = yield* getVersion(db, artifact.current_version_id)
      if (!currentVersion) return yield* failure("VersionNotFound")
      const content = yield* readStoredContent(global, scope, artifact, currentVersion).pipe(
        Effect.mapError(() => failure("StorageUnavailable")),
      )
      const definition = ProjectArtifactAdapterRegistry.parse(artifact.kind, content)
      const versions = yield* db
        .select()
        .from(ProjectArtifactVersionTable)
        .where(
          and(
            eq(ProjectArtifactVersionTable.scope_id, artifact.scope_id),
            eq(ProjectArtifactVersionTable.kind, artifact.kind),
            eq(ProjectArtifactVersionTable.artifact_id, artifact.artifact_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const diagnostics: ProjectArtifact.CollisionDiagnostic[] = artifact.shadowed_scope_id
        ? [
            {
              type: "project-over-global-shadow",
              kind: artifact.kind,
              id: artifact.artifact_id,
              scopeID: artifact.shadowed_scope_id,
              message: "Project artifact explicitly shadows the confirmed global source",
            },
          ]
        : []
      return ProjectArtifact.ArtifactDetails.make({
        artifact: artifactValue(scope, artifact),
        definition,
        currentVersion: versionValue(currentVersion),
        versions: versions.map(versionValue),
        diagnostics,
      })
    })

    const trashDetails = Effect.fn("ProjectArtifactStore.trashDetails")(function* (trash: TrashRow) {
      const scopeRow = yield* getScope(db, trash.scope_id)
      const currentVersion = yield* getVersion(db, trash.prior_version_id)
      if (!scopeRow || !currentVersion) return yield* failure("OwnershipMismatch")
      const scope = scopeFromRow(
        scopeRow,
        scopeRow.type === "project" ? yield* projectIDForScope(db, scopeRow.id) : undefined,
      )
      const root = scopeRoot(global.data, scope.storageID)
      const manifest = yield* packageEffect(ProjectArtifactPackage.readTrashManifest(root, trash.deletion_id))
      if (
        manifest.scopeID !== trash.scope_id ||
        manifest.storageID !== scope.storageID ||
        manifest.kind !== trash.kind ||
        manifest.id !== trash.artifact_id ||
        manifest.priorStage !== trash.prior_stage ||
        manifest.deletedAt !== trash.deleted_at
      ) {
        return yield* failure("OwnershipMismatch")
      }
      const entry = manifest.entries.find((item) => item.versionID === trash.prior_version_id)
      if (!entry) return yield* failure("OwnershipMismatch")
      const content = yield* Effect.tryPromise({
        try: () =>
          fs.readFile(
            path.join(
              root,
              "trash",
              trash.deletion_id,
              "entries",
              entry.layout,
              entry.versionID,
              currentVersion.content_relpath,
            ),
            "utf8",
          ),
        catch: () => failure("StorageUnavailable"),
      })
      if (Hash.sha256(content) !== currentVersion.content_digest) return yield* failure("OwnershipMismatch")
      const definition = ProjectArtifactAdapterRegistry.parse(trash.kind, content)
      const versions = yield* db
        .select()
        .from(ProjectArtifactVersionTable)
        .where(
          and(
            eq(ProjectArtifactVersionTable.scope_id, trash.scope_id),
            eq(ProjectArtifactVersionTable.kind, trash.kind),
            eq(ProjectArtifactVersionTable.artifact_id, trash.artifact_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return {
        deletionID: trash.deletion_id,
        scope,
        kind: trash.kind,
        id: trash.artifact_id,
        name: ProjectArtifact.DisplayName.make(definition.name),
        description: ProjectArtifact.Description.make(definition.description),
        priorStage: trash.prior_stage,
        priorVersionID: trash.prior_version_id,
        deletedAt: trash.deleted_at,
        purgeAfter: trash.purge_after,
        definition,
        currentVersion: versionValue(currentVersion),
        versions: versions.map(versionValue),
      } satisfies TrashDetails
    })

    const list = Effect.fn("ProjectArtifactStore.list")(function* (input: ListInput) {
      const scope = yield* resolveScope(input)
      const trash = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.scope_id, scope.id))
        .all()
        .pipe(Effect.orDie)
      if (input.trash === true) {
        return yield* Effect.forEach(
          trash
            .filter((item) => input.kind === undefined || item.kind === input.kind)
            .filter((item) => input.stage === undefined || item.prior_stage === input.stage)
            .toSorted((a, b) => b.deleted_at - a.deleted_at || a.kind.localeCompare(b.kind) || a.artifact_id.localeCompare(b.artifact_id))
            .slice(0, 128),
          trashDetails,
        )
      }
      const trashed = new Set(trash.map((item) => `${item.kind}:${item.artifact_id}`))
      const artifacts = (yield* db
        .select()
        .from(ProjectArtifactTable)
        .where(eq(ProjectArtifactTable.scope_id, scope.id))
        .all()
        .pipe(Effect.orDie))
        .filter((artifact) => !trashed.has(`${artifact.kind}:${artifact.artifact_id}`))
        .filter((artifact) => input.kind === undefined || artifact.kind === input.kind)
        .filter((artifact) => input.stage === undefined || artifact.stage === input.stage)
        .toSorted((a, b) => b.time_updated - a.time_updated || a.kind.localeCompare(b.kind) || a.artifact_id.localeCompare(b.artifact_id))
        .slice(0, 128)
      return yield* Effect.forEach(artifacts, (artifact) =>
        details(scope, artifact).pipe(
          Effect.map((item) =>
            ProjectArtifact.ArtifactSummary.make({
              scope,
              kind: artifact.kind,
              id: artifact.artifact_id,
              name: ProjectArtifact.DisplayName.make(item.definition.name),
              description: ProjectArtifact.Description.make(item.definition.description),
              stage: artifact.stage,
              revision: artifact.revision,
              currentVersionID: item.currentVersion.id,
              currentDigest: item.currentVersion.contentDigest,
              lastUsedAt: artifact.last_used_at ?? undefined,
              timeUpdated: artifact.time_updated,
            }),
          ),
        ),
      )
    })

    const getTrash = Effect.fn("ProjectArtifactStore.getTrash")(function* (deletionID: ProjectArtifact.DeletionID) {
      const trash = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.deletion_id, deletionID))
        .get()
        .pipe(Effect.orDie)
      if (!trash) return yield* failure("DeletionNotFound")
      return yield* trashDetails(trash)
    })

    const get = Effect.fn("ProjectArtifactStore.get")(function* (input: GetInput) {
      const scope = yield* resolveScope(input)
      const artifact = yield* getArtifact(db, scope.id, input.kind, input.id)
      if (!artifact) return yield* failure("ArtifactNotFound")
      return yield* details(scope, artifact)
    })

    const foldReconcileMarker = Effect.fn("ProjectArtifactStore.foldReconcileMarker")(function* (
      marker: ProjectArtifactPackage.Marker,
    ) {
      const current = yield* getArtifact(db, marker.scopeID, marker.kind, marker.id)
      const now = Date.now()
      const operation = yield* db
        .select()
        .from(ProjectArtifactOperationTable)
        .where(
          and(
            eq(ProjectArtifactOperationTable.scope_id, marker.scopeID),
            eq(ProjectArtifactOperationTable.kind, marker.kind),
            eq(ProjectArtifactOperationTable.artifact_id, marker.id),
            eq(ProjectArtifactOperationTable.target_version_id, marker.versionID),
            inArray(ProjectArtifactOperationTable.operation, ["enable", "revert"]),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (operation) yield* markOperationAvailable(operation.id, now)
      const stage = operation?.operation === "revert" ? ("active" as const) : ("trial" as const)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run("PRAGMA defer_foreign_keys = ON")
            if (!current) {
              yield* tx
                .insert(ProjectArtifactTable)
                .values({
                  scope_id: marker.scopeID,
                  kind: marker.kind,
                  artifact_id: marker.id,
                  revision: 0,
                  stage: marker.kind === "plugin" ? "quarantine" : stage,
                  current_version_id: marker.versionID,
                  time_created: now,
                  time_updated: now,
                })
                .run()
            } else if (
              current.current_version_id !== marker.versionID ||
              ((current.stage === "disabled" || current.stage === "degraded") && marker.kind !== "plugin")
            ) {
              const updated = yield* tx
                .update(ProjectArtifactTable)
                .set({
                  revision: current.revision + 1,
                  stage: marker.kind === "plugin" ? "quarantine" : stage,
                  current_version_id: marker.versionID,
                  fallback_version_id:
                    current.current_version_id === marker.versionID
                      ? current.fallback_version_id
                      : current.current_version_id,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(ProjectArtifactTable.scope_id, marker.scopeID),
                    eq(ProjectArtifactTable.kind, marker.kind),
                    eq(ProjectArtifactTable.artifact_id, marker.id),
                    eq(ProjectArtifactTable.revision, current.revision),
                    eq(ProjectArtifactTable.current_version_id, current.current_version_id),
                  ),
                )
                .returning({ revision: ProjectArtifactTable.revision })
                .get()
              if (!updated) return yield* failure("VersionConflict")
              if (current.current_version_id !== marker.versionID) {
                yield* tx
                  .update(ProjectArtifactVersionTable)
                  .set({ state: "superseded", time_state_changed: now })
                  .where(eq(ProjectArtifactVersionTable.id, current.current_version_id))
                  .run()
              }
            }
            yield* tx
              .insert(ProjectArtifactVersionTable)
              .values({
                id: marker.versionID,
                scope_id: marker.scopeID,
                kind: marker.kind,
                artifact_id: marker.id,
                state: marker.kind === "plugin" ? "quarantine" : stage,
                content_digest: marker.contentDigest,
                content_relpath: marker.contentRelpath,
                source: "restore",
                time_created: now,
                time_state_changed: now,
              })
              .onConflictDoNothing()
              .run()
            if (operation) {
              yield* tx
                .update(ProjectArtifactVersionTable)
                .set({ state: stage, time_state_changed: now })
                .where(eq(ProjectArtifactVersionTable.id, marker.versionID))
                .run()
              yield* finalizeOperation(tx, operation.id, marker.versionID, now)
            }
          }),
        )
        .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
    })

    const finalizeRecoveredCommit = Effect.fn("ProjectArtifactStore.finalizeRecoveredCommit")(function* (
      tx: Transaction,
      operation: OperationRow,
      marker: ProjectArtifactPackage.Marker,
    ) {
      if (
        operation.target_version_id !== marker.versionID ||
        operation.target_digest !== marker.contentDigest ||
        operation.scope_id !== marker.scopeID ||
        operation.kind !== marker.kind ||
        operation.artifact_id !== marker.id
      ) {
        return yield* failure("ReconciliationRequired")
      }
      yield* tx.run("PRAGMA defer_foreign_keys = ON")
      const artifact = yield* getArtifact(tx, marker.scopeID, marker.kind, marker.id)
      const alreadyFinalized = artifact?.current_version_id === marker.versionID
      if (!alreadyFinalized) {
        if (operation.operation === "update") {
          if (
            !artifact ||
            artifact.revision !== operation.expected_revision ||
            artifact.current_version_id !== operation.expected_version_id
          ) {
            return yield* failure("VersionConflict")
          }
          const updated = yield* tx
            .update(ProjectArtifactTable)
            .set({
              revision: artifact.revision + 1,
              stage: "trial",
              current_version_id: marker.versionID,
              fallback_version_id: artifact.current_version_id,
              time_updated: operation.time_created,
            })
            .where(
              and(
                eq(ProjectArtifactTable.scope_id, marker.scopeID),
                eq(ProjectArtifactTable.kind, marker.kind),
                eq(ProjectArtifactTable.artifact_id, marker.id),
                eq(ProjectArtifactTable.revision, artifact.revision),
                eq(ProjectArtifactTable.current_version_id, artifact.current_version_id),
              ),
            )
            .returning({ revision: ProjectArtifactTable.revision })
            .get()
          if (!updated) return yield* failure("VersionConflict")
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "superseded", time_state_changed: operation.time_created })
            .where(eq(ProjectArtifactVersionTable.id, artifact.current_version_id))
            .run()
        } else {
          if (artifact) return yield* failure("VersionConflict")
          yield* tx
            .insert(ProjectArtifactTable)
            .values({
              scope_id: marker.scopeID,
              kind: marker.kind,
              artifact_id: marker.id,
              revision: 0,
              stage: "trial",
              current_version_id: marker.versionID,
              shadowed_scope_id: operation.operation === "fork" ? operation.source_scope_id : undefined,
              time_created: operation.time_created,
              time_updated: operation.time_created,
            })
            .run()
        }
      }
      const version = yield* getVersion(tx, marker.versionID)
      const source = operation.operation === "promotion"
        ? ("promotion" as const)
        : operation.operation === "fork"
          ? ("fork" as const)
          : operation.automatic_session_id
            ? ("agent" as const)
            : ("user" as const)
      if (!version) {
        yield* tx
          .insert(ProjectArtifactVersionTable)
          .values({
            id: marker.versionID,
            scope_id: marker.scopeID,
            kind: marker.kind,
            artifact_id: marker.id,
            parent_version_id: operation.expected_version_id,
            state: "trial",
            content_digest: marker.contentDigest,
            content_relpath: marker.contentRelpath,
            source,
            creator_session_id: operation.automatic_session_id,
            insight_digest: operation.automatic_insight_digest,
            origin_scope_id: operation.source_scope_id,
            origin_version_id: operation.source_version_id,
            origin_evidence_digest: operation.source_digest,
            time_created: operation.time_created,
            time_state_changed: operation.time_created,
          })
          .run()
      }
      if (operation.automatic_session_id && operation.automatic_insight_digest) {
        yield* tx
          .insert(ProjectArtifactWriteTable)
          .values({
            scope_id: marker.scopeID,
            session_id: operation.automatic_session_id,
            insight_digest: operation.automatic_insight_digest,
            operation: operation.operation === "update" ? "update" : "create",
            result: operation.operation === "update" ? "updated" : "created",
            version_id: marker.versionID,
            content_digest: marker.contentDigest,
            time_created: operation.time_created,
          })
          .onConflictDoNothing()
          .run()
      }
      if (operation.operation === "promotion") {
        if (!operation.source_scope_id || !operation.source_version_id) return yield* failure("ReconciliationRequired")
        const sourceArtifact = yield* getArtifact(tx, operation.source_scope_id, marker.kind, marker.id)
        const sourceVersion = yield* getVersion(tx, operation.source_version_id)
        if (!sourceArtifact || !sourceVersion) return yield* failure("ReconciliationRequired")
        yield* tx
          .update(ProjectArtifactTable)
          .set({ shadowed_scope_id: marker.scopeID, time_updated: operation.time_created })
          .where(
            and(
              eq(ProjectArtifactTable.scope_id, operation.source_scope_id),
              eq(ProjectArtifactTable.kind, marker.kind),
              eq(ProjectArtifactTable.artifact_id, marker.id),
              eq(ProjectArtifactTable.current_version_id, operation.source_version_id),
            ),
          )
          .run()
        yield* storeFeedback(tx, sourceVersion, "promote", "user", operation.time_created)
      }
      yield* finalizeOperation(tx, operation.id, marker.versionID, operation.time_updated)
    })

    const abortRecoveredCommit = Effect.fn("ProjectArtifactStore.abortRecoveredCommit")(function* (
      tx: Transaction,
      operation: OperationRow,
      marker: ProjectArtifactPackage.Marker,
    ) {
      yield* tx.run("PRAGMA defer_foreign_keys = ON")
      if (operation.operation === "update" && operation.expected_version_id && operation.expected_revision !== null) {
        const previous = yield* getVersion(tx, operation.expected_version_id)
        if (!previous) return yield* failure("ReconciliationRequired")
        yield* tx
          .update(ProjectArtifactTable)
          .set({
            revision: operation.expected_revision,
            stage: previous.state === "active" ? "active" : "trial",
            current_version_id: previous.id,
            fallback_version_id: previous.parent_version_id,
            time_updated: operation.time_created,
          })
          .where(
            and(
              eq(ProjectArtifactTable.scope_id, marker.scopeID),
              eq(ProjectArtifactTable.kind, marker.kind),
              eq(ProjectArtifactTable.artifact_id, marker.id),
              eq(ProjectArtifactTable.current_version_id, marker.versionID),
            ),
          )
          .run()
        yield* tx
          .update(ProjectArtifactVersionTable)
          .set({ state: previous.state === "active" ? "active" : "trial", time_state_changed: operation.time_created })
          .where(eq(ProjectArtifactVersionTable.id, previous.id))
          .run()
        yield* tx.delete(ProjectArtifactVersionTable).where(eq(ProjectArtifactVersionTable.id, marker.versionID)).run()
      } else {
        yield* tx
          .delete(ProjectArtifactTable)
          .where(
            and(
              eq(ProjectArtifactTable.scope_id, marker.scopeID),
              eq(ProjectArtifactTable.kind, marker.kind),
              eq(ProjectArtifactTable.artifact_id, marker.id),
              eq(ProjectArtifactTable.current_version_id, marker.versionID),
            ),
          )
          .run()
      }
      if (operation.operation === "promotion" && operation.source_scope_id) {
        yield* tx
          .update(ProjectArtifactTable)
          .set({ shadowed_scope_id: null, time_updated: operation.time_created })
          .where(
            and(
              eq(ProjectArtifactTable.scope_id, operation.source_scope_id),
              eq(ProjectArtifactTable.kind, marker.kind),
              eq(ProjectArtifactTable.artifact_id, marker.id),
              eq(ProjectArtifactTable.shadowed_scope_id, marker.scopeID),
            ),
          )
          .run()
      }
      yield* abortOperation(tx, operation.id, Date.now())
    })

    const purgeIndex = Effect.fn("ProjectArtifactStore.purgeIndex")(function* (
      trash: TrashRow,
      preserveOperationID?: string,
      finalizeAt?: number,
    ) {
      const versions = yield* db
        .select({ id: ProjectArtifactVersionTable.id })
        .from(ProjectArtifactVersionTable)
        .where(
          and(
            eq(ProjectArtifactVersionTable.scope_id, trash.scope_id),
            eq(ProjectArtifactVersionTable.kind, trash.kind),
            eq(ProjectArtifactVersionTable.artifact_id, trash.artifact_id),
          ),
        )
        .all()
        .pipe(Effect.mapError(() => failure("StorageUnavailable")))
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run("PRAGMA defer_foreign_keys = ON")
            if (preserveOperationID && finalizeAt !== undefined) {
              yield* finalizeOperation(tx, preserveOperationID, undefined, finalizeAt)
              yield* tx
                .delete(ProjectArtifactOperationTable)
                .where(eq(ProjectArtifactOperationTable.id, preserveOperationID))
                .run()
            }
            yield* tx
              .delete(ProjectArtifactOperationTable)
              .where(
                and(
                  eq(ProjectArtifactOperationTable.scope_id, trash.scope_id),
                  eq(ProjectArtifactOperationTable.kind, trash.kind),
                  eq(ProjectArtifactOperationTable.artifact_id, trash.artifact_id),
                  inArray(ProjectArtifactOperationTable.phase, ["finalized", "aborted"]),
                  preserveOperationID ? ne(ProjectArtifactOperationTable.id, preserveOperationID) : undefined,
                ),
              )
              .run()
            if (versions.length > 0) {
              yield* tx
                .delete(ProjectArtifactWriteTable)
                .where(inArray(ProjectArtifactWriteTable.version_id, versions.map((item) => item.id)))
                .run()
              yield* tx
                .delete(ProjectArtifactFeedbackTable)
                .where(inArray(ProjectArtifactFeedbackTable.version_id, versions.map((item) => item.id)))
                .run()
            }
            yield* tx.delete(ProjectArtifactTrashTable).where(eq(ProjectArtifactTrashTable.deletion_id, trash.deletion_id)).run()
            yield* tx
              .delete(ProjectArtifactTable)
              .where(
                and(
                  eq(ProjectArtifactTable.scope_id, trash.scope_id),
                  eq(ProjectArtifactTable.kind, trash.kind),
                  eq(ProjectArtifactTable.artifact_id, trash.artifact_id),
                ),
              )
              .run()
          }),
        )
        .pipe(Effect.mapError(() => failure("StorageUnavailable")))
    })

    const recoverGovernorMutation = Effect.fn("ProjectArtifactStore.recoverGovernorMutation")(function* (
      operation: OperationRow,
      metadata: ProjectArtifactPackage.StateMutationMetadata,
    ) {
      const context = Option.getOrUndefined(decodeGovernorStateContext(metadata.context ?? ""))
      if (!context || operation.expected_revision === null) return yield* failure("ReconciliationRequired")
      const scope = yield* getScope(db, operation.scope_id)
      if (!scope) return yield* failure("ReconciliationRequired")
      const projectID = scope.type === "project" ? yield* projectIDForScope(db, scope.id) : undefined
      const cohortScope = scope.type === "global"
        ? { type: "global" as const }
        : projectID
          ? { type: "project" as const, projectID }
          : undefined
      if (!cohortScope) return yield* failure("ProjectIdentityUnavailable")
      const target = metadata.target
        ? yield* getVersion(db, metadata.target.versionID)
        : undefined
      if (metadata.target && !target) return yield* failure("ReconciliationRequired")
      const finalize = db
        .transaction((tx) =>
          Effect.gen(function* () {
            const artifact = yield* getArtifact(tx, operation.scope_id, operation.kind, operation.artifact_id)
            const version = artifact ? yield* getVersion(tx, artifact.current_version_id) : undefined
            if (
              !artifact ||
              !version ||
              artifact.revision !== operation.expected_revision ||
              version.id !== metadata.current.versionID ||
              version.content_digest !== metadata.current.contentDigest
            ) {
              return yield* failure("VersionConflict")
            }
            const decision = yield* accounting
              .decideInTransaction(tx, {
                scope: cohortScope,
                versionID: version.id,
                kind: artifact.kind,
                agentID: context.agentID,
                modelID: context.modelID,
                goalMode: context.goalMode,
                now: context.now,
              })
              .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
            if (decision.action !== "degrade") return yield* failure("VersionConflict")
            yield* tx
              .update(ProjectArtifactVersionTable)
              .set({ state: "degraded", time_state_changed: context.now })
              .where(eq(ProjectArtifactVersionTable.id, version.id))
              .run()
            if (target) {
              yield* tx
                .update(ProjectArtifactVersionTable)
                .set({ state: "active", time_state_changed: context.now })
                .where(eq(ProjectArtifactVersionTable.id, target.id))
                .run()
            }
            const updated = yield* tx
              .update(ProjectArtifactTable)
              .set({
                revision: artifact.revision + 1,
                stage: target ? "active" : "degraded",
                current_version_id: target?.id ?? version.id,
                fallback_version_id: target?.parent_version_id ?? artifact.fallback_version_id,
                time_updated: context.now,
              })
              .where(
                and(
                  eq(ProjectArtifactTable.scope_id, operation.scope_id),
                  eq(ProjectArtifactTable.kind, operation.kind),
                  eq(ProjectArtifactTable.artifact_id, operation.artifact_id),
                  eq(ProjectArtifactTable.revision, artifact.revision),
                  eq(ProjectArtifactTable.current_version_id, version.id),
                ),
              )
              .returning({ revision: ProjectArtifactTable.revision })
              .get()
            if (!updated) return yield* failure("VersionConflict")
            yield* storeFeedback(tx, version, "revert", "automatic-governor", context.now)
            yield* finalizeOperation(tx, operation.id, target?.id ?? version.id, context.now)
          }),
        )
        .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
      yield* stateMutation(
        {
          root: scopeRoot(global.data, scope.storage_id),
          operationID: metadata.operationID,
          operation: metadata.operation,
          current: metadata.current,
          ...(metadata.target ? { target: metadata.target } : {}),
          ...(metadata.standard
            ? { contentPath: metadata.contentPath, markerPath: metadata.markerPath }
            : {}),
          context: metadata.context,
        },
        finalize,
        context.now,
      )
    })

    const reconcileMutation = Effect.fn("ProjectArtifactStore.reconcileMutation")(function* (scopeID: ProjectArtifact.ScopeID) {
      const scope = yield* getScope(db, scopeID)
      if (!scope) return yield* failure("InvalidScope")
      const root = scopeRoot(global.data, scope.storage_id)
      const transactions = yield* packageEffect(ProjectArtifactPackage.readCommitTransactions(root))
      for (const metadata of transactions) {
        const operation = yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, metadata.operationID))
          .get()
          .pipe(Effect.orDie)
        if (
          !operation ||
          operation.scope_id !== scope.id ||
          operation.kind !== metadata.marker.kind ||
          operation.artifact_id !== metadata.marker.id ||
          operation.target_version_id !== metadata.marker.versionID ||
          operation.target_digest !== metadata.marker.contentDigest
        ) {
          return yield* failure("ReconciliationRequired")
        }
        if (operation.phase === "finalized") {
          if (metadata.phase !== "finalizing" && metadata.phase !== "committed") {
            return yield* failure("ReconciliationRequired")
          }
          yield* packageEffect(ProjectArtifactPackage.cleanupCommitTransaction(metadata))
          continue
        }
        const live = yield* Effect.promise(() => Bun.file(metadata.contentPath).exists())
        const content = yield* Effect.tryPromise({
          try: () =>
            Bun.file(
              live ? metadata.contentPath : path.join(metadata.stageRoot, metadata.marker.contentRelpath),
            ).text(),
          catch: () => failure("ReconciliationRequired"),
        })
        if (Hash.sha256(content) !== metadata.marker.contentDigest) return yield* failure("ReconciliationRequired")
        const hooks: ProjectArtifactPackage.CommitTransactionHooks<StoreError, never> = {
          reserve: () => Effect.void,
          finalize: () =>
            Effect.gen(function* () {
              yield* markOperationAvailable(operation.id, Date.now())
              yield* db
                .transaction((tx) => finalizeRecoveredCommit(tx, operation, metadata.marker))
                .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
            }),
          abort: () =>
            db
              .transaction((tx) => abortRecoveredCommit(tx, operation, metadata.marker))
              .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired"))),
        }
        if (metadata.standard) {
          yield* packageTransaction(
            ProjectArtifactPackage.commitTransaction(
              {
                root,
                marker: metadata.marker,
                content,
                contentPath: metadata.contentPath,
                markerPath: metadata.markerPath,
                expectedVersionID: metadata.previous?.versionID,
                noOverwrite: metadata.previous === undefined,
                operationID: metadata.operationID,
              },
              hooks,
            ),
          )
        } else {
          yield* packageTransaction(
            ProjectArtifactPackage.commitTransaction(
              {
                root,
                marker: metadata.marker,
                content,
                expectedVersionID: metadata.previous?.versionID,
                operationID: metadata.operationID,
              },
              hooks,
            ),
          )
        }
      }
      const stateTransactions = yield* packageEffect(ProjectArtifactPackage.readStateTransactions(root))
      for (const metadata of stateTransactions) {
        const operation = yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, metadata.operationID))
          .get()
          .pipe(Effect.orDie)
        if (
          !operation ||
          operation.scope_id !== scope.id ||
          operation.kind !== metadata.current.kind ||
          operation.artifact_id !== metadata.current.id ||
          operation.expected_version_id !== metadata.current.versionID ||
          operation.expected_digest !== metadata.current.contentDigest ||
          operation.target_version_id !== (metadata.target?.versionID ?? metadata.current.versionID) ||
          operation.target_digest !== (metadata.target?.contentDigest ?? metadata.current.contentDigest) ||
          operation.operation !== (metadata.operation === "rollback" ? "revert" : metadata.operation)
        ) {
          return yield* failure("ReconciliationRequired")
        }
        if (operation.phase !== "finalized") continue
        if (metadata.phase !== "finalizing" && metadata.phase !== "committed") {
          return yield* failure("ReconciliationRequired")
        }
        yield* packageEffect(ProjectArtifactPackage.cleanupStateTransaction(metadata))
      }
      const transactionIDs = new Set(transactions.map((item) => item.operationID))
      const orphanedCommits = yield* db
        .select()
        .from(ProjectArtifactOperationTable)
        .where(
          and(
            eq(ProjectArtifactOperationTable.scope_id, scopeID),
            inArray(ProjectArtifactOperationTable.operation, ["create", "update", "promotion", "fork"]),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      for (const operation of orphanedCommits.filter((item) => !transactionIDs.has(item.id))) {
        if (operation.phase === "available") return yield* failure("ReconciliationRequired")
        yield* db
          .transaction((tx) => abortOperation(tx, operation.id, Date.now()))
          .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
      }
      const projectMarkers = yield* packageEffect(ProjectArtifactPackage.reconcile(root))
      const pendingMutations = yield* db
        .select()
        .from(ProjectArtifactOperationTable)
        .where(
          and(
            eq(ProjectArtifactOperationTable.scope_id, scopeID),
            inArray(ProjectArtifactOperationTable.operation, ["remove", "restore", "disable", "enable", "revert"]),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      for (const operation of pendingMutations) {
        const state = stateTransactions.find((transaction) => transaction.operationID === operation.id)
        if (state?.context !== undefined) {
          yield* recoverGovernorMutation(operation, state)
          continue
        }
        if (
          operation.expected_revision === null ||
          !operation.expected_version_id ||
          !operation.expected_digest
        ) {
          return yield* failure("ReconciliationRequired")
        }
        const input = {
          scopeID: operation.scope_id,
          kind: operation.kind,
          id: operation.artifact_id,
          expectedRevision: operation.expected_revision,
          expectedVersionID: operation.expected_version_id,
          expectedDigest: operation.expected_digest,
          now: operation.time_created,
        }
        if (operation.operation === "remove" && operation.phase === "preparing") {
          yield* removeMutation(input)
          continue
        }
        if (operation.operation === "restore" && operation.phase === "preparing") {
          if (!operation.deletion_id) return yield* failure("ReconciliationRequired")
          yield* restoreMutation(operation.deletion_id, operation.time_created)
          continue
        }
        if (operation.operation === "disable") {
          yield* changeEnabled(input, false)
          continue
        }
        if (operation.operation === "enable") {
          yield* changeEnabled(input, true)
          continue
        }
        if (operation.operation === "revert") {
          if (!operation.target_version_id) return yield* failure("ReconciliationRequired")
          yield* rollback(input, operation.target_version_id, false)
        }
      }
      const markers = scope.type === "global"
        ? (yield* packageEffect(
            ProjectArtifactPackage.reconcileStandard({
              root,
              scopeID: scope.id,
              storageID: scope.storage_id,
              roots: {
                skill: path.join(global.home, ".agents", "skills"),
                command: path.join(global.config, "commands"),
                agent: path.join(global.config, "agents"),
              },
            }),
          )).owned
        : projectMarkers
      if (hooks.afterReconcileScan) yield* hooks.afterReconcileScan(scopeID)
      const shadowOperations = yield* db
        .select()
        .from(ProjectArtifactOperationTable)
        .where(
          and(
            eq(ProjectArtifactOperationTable.scope_id, scopeID),
            eq(ProjectArtifactOperationTable.operation, "shadow"),
            inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      for (const operation of shadowOperations) {
        if (
          operation.expected_revision === null ||
          !operation.expected_version_id ||
          !operation.expected_digest ||
          !operation.source_scope_id ||
          !operation.source_version_id ||
          !operation.source_digest ||
          !operation.target_version_id
        ) {
          return yield* failure("ReconciliationRequired")
        }
        const expectedVersionID = operation.expected_version_id
        const sourceScopeID = operation.source_scope_id
        const sourceVersionID = operation.source_version_id
        const sourceDigest = operation.source_digest
        const targetVersionID = operation.target_version_id
        const artifact = yield* getArtifact(db, operation.scope_id, operation.kind, operation.artifact_id)
        const version = yield* getVersion(db, expectedVersionID)
        const source = yield* getArtifact(db, sourceScopeID, operation.kind, operation.artifact_id)
        const sourceVersion = yield* getVersion(db, sourceVersionID)
        if (
          !artifact ||
          !version ||
          !source ||
          !sourceVersion ||
          artifact.current_version_id !== expectedVersionID ||
          version.content_digest !== operation.expected_digest ||
          source.current_version_id !== sourceVersionID ||
          sourceVersion.content_digest !== sourceDigest
        ) {
          return yield* failure("VersionConflict")
        }
        yield* markOperationAvailable(operation.id, Date.now())
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const already =
                artifact.shadowed_scope_id === sourceScopeID &&
                version.origin_scope_id === sourceScopeID &&
                version.origin_version_id === sourceVersionID &&
                version.origin_evidence_digest === sourceDigest
              if (!already) {
                const updated = yield* tx
                  .update(ProjectArtifactTable)
                  .set({
                    revision: artifact.revision + 1,
                    shadowed_scope_id: sourceScopeID,
                    time_updated: operation.time_created,
                  })
                  .where(
                    and(
                      eq(ProjectArtifactTable.scope_id, operation.scope_id),
                      eq(ProjectArtifactTable.kind, operation.kind),
                      eq(ProjectArtifactTable.artifact_id, operation.artifact_id),
                      eq(ProjectArtifactTable.current_version_id, expectedVersionID),
                    ),
                  )
                  .returning({ revision: ProjectArtifactTable.revision })
                  .get()
                if (!updated) return yield* failure("VersionConflict")
                yield* tx
                  .update(ProjectArtifactVersionTable)
                  .set({
                    origin_scope_id: sourceScopeID,
                    origin_version_id: sourceVersionID,
                    origin_evidence_digest: sourceDigest,
                  })
                  .where(eq(ProjectArtifactVersionTable.id, expectedVersionID))
                  .run()
              }
              yield* finalizeOperation(tx, operation.id, targetVersionID, Date.now())
            }),
          )
          .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
      }
      const trashEntries = yield* Effect.promise(() =>
        fs.readdir(path.join(root, "trash"), { withFileTypes: true }).catch(() => []),
      )
      for (const entry of trashEntries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
        const deletionID = Option.getOrUndefined(decodeDeletionID(entry.name))
        if (!deletionID) return yield* failure("ReconciliationRequired")
        const manifest = yield* packageEffect(ProjectArtifactPackage.readTrashManifest(root, deletionID))
        if (
          manifest.phase !== "trashed" ||
          manifest.scopeID !== scope.id ||
          manifest.storageID !== scope.storage_id
        ) {
          return yield* failure("ReconciliationRequired")
        }
        const artifact = yield* getArtifact(db, scope.id, manifest.kind, manifest.id)
        if (!artifact) return yield* failure("ReconciliationRequired")
        const version = yield* getVersion(db, artifact.current_version_id)
        if (!version) return yield* failure("VersionNotFound")
        const retained = manifest.entries.find(
          (item) =>
            item.versionID === version.id &&
            item.contentDigest === version.content_digest &&
            item.contentRelpath === version.content_relpath,
        )
        if (!retained) return yield* failure("OwnershipMismatch")
        const removeOperation = yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(
            and(
              eq(ProjectArtifactOperationTable.scope_id, scope.id),
              eq(ProjectArtifactOperationTable.operation, "remove"),
              eq(ProjectArtifactOperationTable.deletion_id, deletionID),
              inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (removeOperation) yield* markOperationAvailable(removeOperation.id, Date.now())
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(ProjectArtifactTrashTable)
                .values({
                  deletion_id: deletionID,
                  scope_id: scope.id,
                  kind: manifest.kind,
                  artifact_id: manifest.id,
                  prior_stage: manifest.priorStage,
                  prior_version_id: version.id,
                  deleted_at: manifest.deletedAt,
                  purge_after: manifest.deletedAt + 30 * day,
                })
                .onConflictDoNothing()
                .run()
              const indexed = yield* tx
                .select()
                .from(ProjectArtifactTrashTable)
                .where(eq(ProjectArtifactTrashTable.deletion_id, deletionID))
                .get()
              if (
                !indexed ||
                indexed.scope_id !== scope.id ||
                indexed.kind !== manifest.kind ||
                indexed.artifact_id !== manifest.id ||
                indexed.prior_stage !== manifest.priorStage ||
                indexed.prior_version_id !== version.id ||
                indexed.deleted_at !== manifest.deletedAt
              ) {
                return yield* failure("VersionConflict")
              }
              yield* storeFeedback(tx, version, "delete", "user", manifest.deletedAt)
              if (removeOperation) yield* finalizeOperation(tx, removeOperation.id, undefined, Date.now())
            }),
          )
          .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
      }
      const currentMarkers: ProjectArtifactPackage.Marker[] = []
      const keys = new Set<string>()
      for (const scanned of markers) {
        yield* targetMutation(
          root,
          scanned,
          Effect.gen(function* () {
            const marker = yield* readReconcileMarker(scope, scanned.kind, scanned.id)
            if (!marker) return
            yield* foldReconcileMarker(marker)
            keys.add(`${marker.kind}:${marker.id}`)
            currentMarkers.push(marker)
          }),
        )
      }
      const trash = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.scope_id, scopeID))
        .all()
        .pipe(Effect.orDie)
      const retainedTrash: TrashRow[] = []
      for (const item of trash) {
        if (yield* Effect.promise(() => Bun.file(path.join(root, "trash", item.deletion_id, ".ycoding-trash.json")).exists())) {
          retainedTrash.push(item)
          continue
        }
        const version = yield* getVersion(db, item.prior_version_id)
        if (!version) return yield* failure("VersionNotFound")
        yield* targetMutation(
          root,
          markerFrom(scope, version),
          Effect.gen(function* () {
            const marker = yield* readReconcileMarker(scope, item.kind, item.artifact_id)
            if (marker?.versionID === item.prior_version_id && marker.contentDigest === version.content_digest) {
              const restoreOperation = yield* db
                .select()
                .from(ProjectArtifactOperationTable)
                .where(
                  and(
                    eq(ProjectArtifactOperationTable.scope_id, item.scope_id),
                    eq(ProjectArtifactOperationTable.operation, "restore"),
                    eq(ProjectArtifactOperationTable.deletion_id, item.deletion_id),
                    inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (restoreOperation) yield* markOperationAvailable(restoreOperation.id, Date.now())
              yield* db
                .transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx
                      .delete(ProjectArtifactTrashTable)
                      .where(eq(ProjectArtifactTrashTable.deletion_id, item.deletion_id))
                      .run()
                    yield* storeFeedback(tx, version, "restore", "user", Date.now())
                    if (restoreOperation) {
                      yield* finalizeOperation(tx, restoreOperation.id, version.id, Date.now())
                    }
                  }),
                )
                .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
              return
            }
            if (Date.now() >= item.purge_after) {
              const purgeOperation = yield* db
                .select()
                .from(ProjectArtifactOperationTable)
                .where(
                  and(
                    eq(ProjectArtifactOperationTable.scope_id, item.scope_id),
                    eq(ProjectArtifactOperationTable.operation, "purge"),
                    eq(ProjectArtifactOperationTable.deletion_id, item.deletion_id),
                    inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (purgeOperation) {
                yield* markOperationAvailable(purgeOperation.id, Date.now())
                yield* purgeIndex(item, purgeOperation.id, Date.now())
                return
              }
              yield* purgeIndex(item)
              return
            }
            return yield* failure("ReconciliationRequired")
          }),
        )
      }
      const trashed = new Set(retainedTrash.map((item) => `${item.kind}:${item.artifact_id}`))
      const missing = (yield* db
        .select()
        .from(ProjectArtifactTable)
        .where(eq(ProjectArtifactTable.scope_id, scopeID))
        .all()
        .pipe(Effect.orDie)).filter(
        (artifact) => !keys.has(`${artifact.kind}:${artifact.artifact_id}`) && !trashed.has(`${artifact.kind}:${artifact.artifact_id}`),
      )
      for (const artifact of missing) {
        const version = yield* getVersion(db, artifact.current_version_id)
        if (!version) return yield* failure("VersionNotFound")
        yield* targetMutation(
          root,
          markerFrom(scope, version),
          Effect.gen(function* () {
            const marker = yield* readReconcileMarker(scope, artifact.kind, artifact.artifact_id)
            if (marker) {
              yield* foldReconcileMarker(marker)
              keys.add(`${marker.kind}:${marker.id}`)
              currentMarkers.push(marker)
              return
            }
            const currentTrash = yield* db
              .select({ deletion_id: ProjectArtifactTrashTable.deletion_id })
              .from(ProjectArtifactTrashTable)
              .where(
                and(
                  eq(ProjectArtifactTrashTable.scope_id, artifact.scope_id),
                  eq(ProjectArtifactTrashTable.kind, artifact.kind),
                  eq(ProjectArtifactTrashTable.artifact_id, artifact.artifact_id),
                ),
            )
              .get()
              .pipe(Effect.orDie)
            if (currentTrash) return
            const now = Date.now()
            const disableOperation = yield* db
              .select()
              .from(ProjectArtifactOperationTable)
              .where(
                and(
                  eq(ProjectArtifactOperationTable.scope_id, artifact.scope_id),
                  eq(ProjectArtifactOperationTable.kind, artifact.kind),
                  eq(ProjectArtifactOperationTable.artifact_id, artifact.artifact_id),
                  eq(ProjectArtifactOperationTable.operation, "disable"),
                  eq(ProjectArtifactOperationTable.target_version_id, artifact.current_version_id),
                  inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (disableOperation) yield* markOperationAvailable(disableOperation.id, now)
            if (artifact.stage === "disabled" || artifact.stage === "degraded") {
              if (disableOperation) {
                yield* db
                  .transaction((tx) =>
                    finalizeOperation(tx, disableOperation.id, artifact.current_version_id, now),
                  )
                  .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
              }
              return
            }
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  const updated = yield* tx
                    .update(ProjectArtifactTable)
                    .set({ revision: artifact.revision + 1, stage: "disabled", time_updated: now })
                    .where(
                      and(
                        eq(ProjectArtifactTable.scope_id, artifact.scope_id),
                        eq(ProjectArtifactTable.kind, artifact.kind),
                        eq(ProjectArtifactTable.artifact_id, artifact.artifact_id),
                        eq(ProjectArtifactTable.revision, artifact.revision),
                        eq(ProjectArtifactTable.current_version_id, artifact.current_version_id),
                      ),
                    )
                    .returning({ revision: ProjectArtifactTable.revision })
                    .get()
                  if (!updated) return yield* failure("VersionConflict")
                  yield* tx
                    .update(ProjectArtifactVersionTable)
                    .set({ state: "disabled", time_state_changed: now })
                    .where(eq(ProjectArtifactVersionTable.id, artifact.current_version_id))
                    .run()
                  if (disableOperation) {
                    yield* finalizeOperation(tx, disableOperation.id, artifact.current_version_id, now)
                  }
                }),
              )
              .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
          }),
        )
      }
      return currentMarkers
    })

    const reconcile = Effect.fn("ProjectArtifactStore.reconcile")(function* (scopeID: ProjectArtifact.ScopeID) {
      return yield* scopeMutation(scopeID, reconcileMutation(scopeID))
    })

    const removeMutation = Effect.fn("ProjectArtifactStore.removeMutation")(function* (input: DeleteInput) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      const artifact = yield* getArtifact(db, input.scopeID, input.kind, input.id)
      if (!artifact) return yield* failure("ArtifactNotFound")
      if (artifact.stage === "quarantine") return yield* failure("UnsupportedKind")
      const version = yield* getVersion(db, artifact.current_version_id)
      if (!version) return yield* failure("VersionNotFound")
      if (
        artifact.revision !== input.expectedRevision ||
        version.id !== input.expectedVersionID ||
        version.content_digest !== input.expectedDigest
      ) {
        return yield* failure("VersionConflict")
      }
      if (scope.type === "global") {
        const sources = yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id })
        if (
          (artifact.stage === "trial" || artifact.stage === "active") &&
          !exactManagedSources(sources, scope.id, version.id, version.content_digest)
        ) {
          return yield* failure(sources.length > 0 ? "DestinationExists" : "OwnershipMismatch")
        }
        if ((artifact.stage === "disabled" || artifact.stage === "degraded") && sources.length > 0) {
          return yield* failure("DestinationExists")
        }
      }
      const now = input.now ?? Date.now()
      const requestFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256(
          [
            input.scopeID,
            input.kind,
            input.id,
            "remove",
            input.expectedRevision,
            input.expectedVersionID,
            input.expectedDigest,
          ].join("\0"),
        ),
      )
      const operationID = `pop_${requestFingerprint.slice(0, 32)}`
      const deletionID = ProjectArtifact.DeletionID.make(`pad_${Hash.sha256(operationID).slice(0, 32)}`)
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: input.scopeID,
        kind: input.kind,
        artifactID: input.id,
        operation: "remove",
        requestFingerprint,
        expectedRevision: input.expectedRevision,
        expectedVersionID: input.expectedVersionID,
        expectedDigest: input.expectedDigest,
        deletionID,
        now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      const marker = markerFrom(scope, version)
      const root = scopeRoot(global.data, scope.storage_id)
      if (reserved.phase !== "finalized") {
        if (reserved.phase === "preparing") {
          if (scope.type === "project") {
            yield* packageEffect(
              ProjectArtifactPackage.trash({ root, marker, deletionID, priorStage: artifact.stage, deletedAt: reserved.time_created, now }),
            )
          } else {
            const contentPath = ProjectArtifactAdapterRegistry.globalPath(input.kind, global, input.id)
            yield* packageEffect(
              ProjectArtifactPackage.trashStandard({
                root,
                marker,
                deletionID,
                priorStage: artifact.stage,
                deletedAt: reserved.time_created,
                now,
                contentPath,
                markerPath: standardMarkerPath(contentPath, input.kind, input.id),
              }),
            )
          }
          yield* markOperationAvailable(operationID, now)
        }
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run("PRAGMA defer_foreign_keys = ON")
              yield* tx
                .insert(ProjectArtifactTrashTable)
                .values({
                  deletion_id: deletionID,
                  scope_id: input.scopeID,
                  kind: input.kind,
                  artifact_id: input.id,
                  prior_stage: artifact.stage,
                  prior_version_id: version.id,
                  deleted_at: reserved.time_created,
                  purge_after: reserved.time_created + 30 * day,
                })
                .onConflictDoNothing()
                .run()
              yield* storeFeedback(tx, version, "delete", "user", reserved.time_created)
              yield* finalizeOperation(tx, operationID, undefined, now)
            }),
          )
          .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
      }
      const indexed = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.deletion_id, deletionID))
        .get()
        .pipe(Effect.orDie)
      if (!indexed) return yield* failure("ReconciliationRequired")
      return ProjectArtifact.Trash.make({
        deletionID,
        scope: scopeFromRow(scope, scope.type === "project" ? yield* projectIDForScope(db, scope.id) : undefined),
        kind: input.kind,
        id: input.id,
        priorStage: indexed.prior_stage,
        priorVersionID: indexed.prior_version_id,
        deletedAt: indexed.deleted_at,
        purgeAfter: indexed.purge_after,
      })
    })

    const remove = Effect.fn("ProjectArtifactStore.remove")(function* (input: DeleteInput) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      if (scope.type === "global") return yield* failure("InvalidScope")
      return yield* scopeMutation(input.scopeID, removeMutation(input))
    })

    const restoreMutation = Effect.fn("ProjectArtifactStore.restoreMutation")(function* (
      deletionID: ProjectArtifact.DeletionID,
      now = Date.now(),
    ) {
      const trash = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.deletion_id, deletionID))
        .get()
        .pipe(Effect.orDie)
      if (!trash) {
        const completed = yield* db
          .select({ id: ProjectArtifactOperationTable.id })
          .from(ProjectArtifactOperationTable)
          .where(
            and(
              eq(ProjectArtifactOperationTable.operation, "restore"),
              eq(ProjectArtifactOperationTable.deletion_id, deletionID),
              eq(ProjectArtifactOperationTable.phase, "finalized"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (completed) return
        return yield* failure("DeletionNotFound")
      }
      if (now >= trash.purge_after) return yield* failure("TrashExpired")
      const scope = yield* getScope(db, trash.scope_id)
      const version = yield* getVersion(db, trash.prior_version_id)
      if (!scope || !version) return yield* failure("OwnershipMismatch")
      const artifact = yield* getArtifact(db, trash.scope_id, trash.kind, trash.artifact_id)
      if (!artifact || artifact.current_version_id !== version.id) return yield* failure("VersionConflict")
      if (
        scope.type === "global" &&
        (yield* standardSources.resolve({ scope: "global", kind: version.kind, id: version.artifact_id })).length > 0
      ) {
        return yield* failure("DestinationExists")
      }
      const root = scopeRoot(global.data, scope.storage_id)
      const marker = markerFrom(scope, version)
      const requestFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256(
          [
            trash.scope_id,
            trash.kind,
            trash.artifact_id,
            "restore",
            deletionID,
            artifact.revision,
            version.id,
            version.content_digest,
            trash.deleted_at,
          ].join("\0"),
        ),
      )
      const operationID = `pop_${requestFingerprint.slice(0, 32)}`
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: trash.scope_id,
        kind: trash.kind,
        artifactID: trash.artifact_id,
        operation: "restore",
        requestFingerprint,
        expectedRevision: artifact.revision,
        expectedVersionID: version.id,
        expectedDigest: version.content_digest,
        targetVersionID: version.id,
        targetDigest: version.content_digest,
        deletionID,
        now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      if (reserved.phase !== "finalized") {
        if (reserved.phase === "preparing") {
          if (scope.type === "project") {
            yield* packageEffect(ProjectArtifactPackage.restore({ root, marker, deletionID }))
          } else {
            const contentPath = ProjectArtifactAdapterRegistry.globalPath(version.kind, global, version.artifact_id)
            yield* packageEffect(
              ProjectArtifactPackage.restoreStandard({
                root,
                marker,
                deletionID,
                contentPath,
                markerPath: standardMarkerPath(contentPath, version.kind, version.artifact_id),
              }),
            )
          }
          yield* markOperationAvailable(operationID, now)
        }
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.delete(ProjectArtifactTrashTable).where(eq(ProjectArtifactTrashTable.deletion_id, deletionID)).run()
              yield* storeFeedback(tx, version, "restore", "user", reserved.time_created)
              yield* finalizeOperation(tx, operationID, version.id, now)
            }),
          )
          .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
      }
    })

    const restore = Effect.fn("ProjectArtifactStore.restore")(function* (
      deletionID: ProjectArtifact.DeletionID,
      now = Date.now(),
    ) {
      const trash = yield* db
        .select({ scope_id: ProjectArtifactTrashTable.scope_id })
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.deletion_id, deletionID))
        .get()
        .pipe(Effect.orDie)
      const completed = trash
        ? undefined
        : yield* db
            .select({ scope_id: ProjectArtifactOperationTable.scope_id })
            .from(ProjectArtifactOperationTable)
            .where(
              and(
                eq(ProjectArtifactOperationTable.operation, "restore"),
                eq(ProjectArtifactOperationTable.deletion_id, deletionID),
                eq(ProjectArtifactOperationTable.phase, "finalized"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
      if (!trash && !completed) return yield* failure("DeletionNotFound")
      const scopeID = trash?.scope_id ?? completed?.scope_id
      if (!scopeID) return yield* failure("DeletionNotFound")
      const scope = yield* getScope(db, scopeID)
      if (!scope) return yield* failure("OwnershipMismatch")
      if (scope.type === "global") return yield* failure("InvalidScope")
      return yield* scopeMutation(scope.id, restoreMutation(deletionID, now))
    })

    const changeEnabled = Effect.fn("ProjectArtifactStore.changeEnabled")(function* (
      input: DeleteInput,
      enabled: boolean,
    ) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      const now = input.now ?? Date.now()
      const operation = enabled ? ("enable" as const) : ("disable" as const)
      const requestFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256(
          [
            input.scopeID,
            input.kind,
            input.id,
            operation,
            input.expectedRevision,
            input.expectedVersionID,
            input.expectedDigest,
          ].join("\0"),
        ),
      )
      const operationID = `pop_${requestFingerprint.slice(0, 32)}`
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: input.scopeID,
        kind: input.kind,
        artifactID: input.id,
        operation,
        requestFingerprint,
        expectedRevision: input.expectedRevision,
        expectedVersionID: input.expectedVersionID,
        expectedDigest: input.expectedDigest,
        targetVersionID: input.expectedVersionID,
        targetDigest: input.expectedDigest,
        now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      if (reserved.phase === "finalized") {
        yield* cleanupFinalizedState(scopeRoot(global.data, scope.storage_id), operationID)
        return
      }
      const artifact = yield* getArtifact(db, input.scopeID, input.kind, input.id)
      if (!artifact) return yield* failure("ArtifactNotFound")
      const version = yield* getVersion(db, artifact.current_version_id)
      if (!version) return yield* failure("VersionNotFound")
      if (
        artifact.revision !== input.expectedRevision ||
        version.id !== input.expectedVersionID ||
        version.content_digest !== input.expectedDigest
      ) {
        return yield* failure("VersionConflict")
      }
      const root = scopeRoot(global.data, scope.storage_id)
      const recovering = (yield* packageEffect(ProjectArtifactPackage.readStateTransactions(root))).some(
        (transaction) => transaction.operationID === operationID,
      )
      if (scope.type === "global" && !recovering) {
        const sources = yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id })
        if (enabled && reserved.phase === "preparing" && sources.length > 0) return yield* failure("DestinationExists")
        if (enabled && reserved.phase === "available" && !exactManagedSources(sources, scope.id, version.id, version.content_digest)) {
          return yield* failure(sources.length > 0 ? "DestinationExists" : "OwnershipMismatch")
        }
        if (!enabled && reserved.phase === "preparing" && !exactManagedSources(sources, scope.id, version.id, version.content_digest)) {
          return yield* failure(sources.length > 0 ? "DestinationExists" : "OwnershipMismatch")
        }
        if (!enabled && reserved.phase === "available" && sources.length > 0) return yield* failure("DestinationExists")
      }
      const changesState = enabled
        ? artifact.stage === "disabled" || artifact.stage === "degraded"
        : artifact.stage !== "disabled"
      const marker = markerFrom(scope, version)
      const finalize = db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (changesState) {
              const updated = yield* tx
                .update(ProjectArtifactTable)
                .set({ revision: artifact.revision + 1, stage: enabled ? "trial" : "disabled", time_updated: now })
                .where(
                  and(
                    eq(ProjectArtifactTable.scope_id, input.scopeID),
                    eq(ProjectArtifactTable.kind, input.kind),
                    eq(ProjectArtifactTable.artifact_id, input.id),
                    eq(ProjectArtifactTable.revision, artifact.revision),
                    eq(ProjectArtifactTable.current_version_id, version.id),
                  ),
                )
                .returning({ revision: ProjectArtifactTable.revision })
                .get()
              if (!updated) return yield* failure("VersionConflict")
              yield* tx
                .update(ProjectArtifactVersionTable)
                .set({ state: enabled ? "trial" : "disabled", time_state_changed: now })
                .where(eq(ProjectArtifactVersionTable.id, version.id))
                .run()
              yield* storeFeedback(tx, version, enabled ? "enable" : "disable", "user", reserved.time_created)
            }
            yield* finalizeOperation(tx, operationID, version.id, now)
          }),
        )
        .pipe(Effect.mapError((cause) => (cause instanceof StoreError ? cause : failure("ReconciliationRequired"))))
      if (!changesState) {
        yield* markOperationAvailable(operationID, now)
        return yield* finalize
      }
      const contentPath = scope.type === "global"
        ? ProjectArtifactAdapterRegistry.globalPath(input.kind, global, input.id)
        : undefined
      yield* stateMutation(
        {
          root,
          operationID,
          operation: enabled ? "enable" : "disable",
          current: marker,
          ...(contentPath
            ? { contentPath, markerPath: standardMarkerPath(contentPath, input.kind, input.id) }
            : {}),
        },
        finalize,
        now,
      )
    })

    const disable = Effect.fn("ProjectArtifactStore.disable")(function* (input: DeleteInput) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      if (scope.type === "global") return yield* failure("InvalidScope")
      return yield* scopeMutation(input.scopeID, changeEnabled(input, false))
    })

    const enable = Effect.fn("ProjectArtifactStore.enable")(function* (input: DeleteInput) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      if (scope.type === "global") return yield* failure("InvalidScope")
      return yield* scopeMutation(input.scopeID, changeEnabled(input, true))
    })

    const rollback = Effect.fn("ProjectArtifactStore.rollback")(function* (
      input: DeleteInput,
      targetVersionID: ProjectArtifact.VersionID | undefined,
      automatic: boolean,
    ) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      const target = targetVersionID ? yield* getVersion(db, targetVersionID) : undefined
      if (
        targetVersionID &&
        (!target || target.scope_id !== input.scopeID || target.kind !== input.kind || target.artifact_id !== input.id)
      ) {
        return yield* failure("VersionNotFound")
      }
      const now = input.now ?? Date.now()
      const operation = target ? ("revert" as const) : ("disable" as const)
      const requestFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256(
          [
            input.scopeID,
            input.kind,
            input.id,
            operation,
            automatic,
            input.expectedRevision,
            input.expectedVersionID,
            input.expectedDigest,
            target?.id ?? "",
            target?.content_digest ?? "",
          ].join("\0"),
        ),
      )
      const operationID = `pop_${requestFingerprint.slice(0, 32)}`
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: input.scopeID,
        kind: input.kind,
        artifactID: input.id,
        operation,
        requestFingerprint,
        expectedRevision: input.expectedRevision,
        expectedVersionID: input.expectedVersionID,
        expectedDigest: input.expectedDigest,
        targetVersionID: target?.id ?? input.expectedVersionID,
        targetDigest: target?.content_digest ?? input.expectedDigest,
        now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      if (reserved.phase === "finalized") {
        yield* cleanupFinalizedState(scopeRoot(global.data, scope.storage_id), operationID)
        return
      }
      const artifact = yield* getArtifact(db, input.scopeID, input.kind, input.id)
      if (!artifact) return yield* failure("ArtifactNotFound")
      const current = yield* getVersion(db, artifact.current_version_id)
      if (!current) return yield* failure("VersionNotFound")
      if (
        artifact.revision !== input.expectedRevision ||
        current.id !== input.expectedVersionID ||
        current.content_digest !== input.expectedDigest
      ) {
        return yield* failure("VersionConflict")
      }
      const root = scopeRoot(global.data, scope.storage_id)
      const recovering = (yield* packageEffect(ProjectArtifactPackage.readStateTransactions(root))).some(
        (transaction) => transaction.operationID === operationID,
      )
      if (scope.type === "global" && !recovering) {
        const sources = yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id })
        const expectedSource = reserved.phase === "available" && target ? target : current
        if (reserved.phase === "available" && !target && sources.length > 0) return yield* failure("DestinationExists")
        if (
          (reserved.phase === "preparing" || target !== undefined) &&
          !exactManagedSources(sources, scope.id, expectedSource.id, expectedSource.content_digest)
        ) {
          return yield* failure(sources.length > 0 ? "DestinationExists" : "OwnershipMismatch")
        }
      }
      const finalize = db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(ProjectArtifactVersionTable)
              .set({ state: automatic ? "degraded" : "disabled", time_state_changed: now })
              .where(eq(ProjectArtifactVersionTable.id, current.id))
              .run()
            if (target) {
              yield* tx
                .update(ProjectArtifactVersionTable)
                .set({ state: "active", time_state_changed: now })
                .where(eq(ProjectArtifactVersionTable.id, target.id))
                .run()
            }
            const updated = yield* tx
              .update(ProjectArtifactTable)
              .set({
                revision: artifact.revision + 1,
                stage: target ? "active" : automatic ? "degraded" : "disabled",
                current_version_id: target?.id ?? current.id,
                fallback_version_id: target ? target.parent_version_id : artifact.fallback_version_id,
                time_updated: now,
              })
              .where(
                and(
                  eq(ProjectArtifactTable.scope_id, input.scopeID),
                  eq(ProjectArtifactTable.kind, input.kind),
                  eq(ProjectArtifactTable.artifact_id, input.id),
                  eq(ProjectArtifactTable.revision, artifact.revision),
                  eq(ProjectArtifactTable.current_version_id, current.id),
                ),
              )
              .returning({ revision: ProjectArtifactTable.revision })
              .get()
            if (!updated) return yield* failure("VersionConflict")
            if (!automatic) yield* storeFeedback(tx, current, "revert", "user", reserved.time_created)
            yield* finalizeOperation(tx, operationID, target?.id ?? current.id, now)
          }),
        )
        .pipe(Effect.mapError((cause) => (cause instanceof StoreError ? cause : failure("ReconciliationRequired"))))
      const contentPath = scope.type === "global"
        ? ProjectArtifactAdapterRegistry.globalPath(input.kind, global, input.id)
        : undefined
      yield* stateMutation(
        {
          root,
          operationID,
          operation: target ? "rollback" : "disable",
          current: markerFrom(scope, current),
          ...(target ? { target: markerFrom(scope, target) } : {}),
          ...(contentPath
            ? { contentPath, markerPath: standardMarkerPath(contentPath, input.kind, input.id) }
            : {}),
        },
        finalize,
        now,
      )
    })

    const revert = Effect.fn("ProjectArtifactStore.revert")(function* (input: RevertInput) {
      const scope = yield* getScope(db, input.scopeID)
      if (!scope) return yield* failure("InvalidScope")
      if (scope.type === "global") return yield* failure("InvalidScope")
      return yield* scopeMutation(input.scopeID, rollback(input, input.targetVersionID, false))
    })

    const degrade = Effect.fn("ProjectArtifactStore.degrade")(function* (input: DeleteInput) {
      return yield* scopeMutation(
        input.scopeID,
        Effect.gen(function* () {
          const artifact = yield* getArtifact(db, input.scopeID, input.kind, input.id)
          return yield* rollback(input, artifact?.fallback_version_id ?? undefined, true)
        }),
      )
    })

    const evaluateGovernor = Effect.fn("ProjectArtifactStore.evaluateGovernor")(function* (
      input: GovernorEvaluationInput,
    ) {
      return yield* scopeMutation(
        input.scopeID,
        Effect.gen(function* () {
          const scope = yield* getScope(db, input.scopeID)
          if (!scope) return yield* failure("InvalidScope")
          const artifact = yield* getArtifact(db, input.scopeID, input.kind, input.id)
          if (!artifact) return yield* failure("ArtifactNotFound")
          const version = yield* getVersion(db, artifact.current_version_id)
          if (!version) return yield* failure("VersionNotFound")
          if (
            artifact.revision !== input.expectedRevision ||
            version.id !== input.expectedVersionID ||
            version.content_digest !== input.expectedDigest ||
            (artifact.stage !== "trial" && artifact.stage !== "active")
          ) {
            return yield* failure("VersionConflict")
          }
          const projectID = scope.type === "project" ? yield* projectIDForScope(db, scope.id) : undefined
          const cohortScope = scope.type === "global"
            ? { type: "global" as const }
            : projectID
              ? { type: "project" as const, projectID }
              : undefined
          if (!cohortScope) return yield* failure("ProjectIdentityUnavailable")
          const now = input.now ?? Date.now()
          const target = artifact.fallback_version_id
            ? yield* getVersion(db, artifact.fallback_version_id)
            : undefined
          const operation = target ? ("revert" as const) : ("disable" as const)
          const requestFingerprint = ProjectArtifact.Digest.make(
            Hash.sha256(
              [
                input.scopeID,
                input.kind,
                input.id,
                operation,
                "automatic-governor",
                input.expectedRevision,
                input.expectedVersionID,
                input.expectedDigest,
                target?.id ?? "",
                target?.content_digest ?? "",
                input.agentID ?? "",
                input.modelID,
                input.goalMode,
              ].join("\0"),
            ),
          )
          const operationID = `pop_${requestFingerprint.slice(0, 32)}`
          const root = scopeRoot(global.data, scope.storage_id)
          const recovering = (yield* packageEffect(ProjectArtifactPackage.readStateTransactions(root))).some(
            (transaction) => transaction.operationID === operationID,
          )
          if (scope.type === "global" && !recovering) {
            const sources = yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id })
            if (!exactManagedSources(sources, scope.id, version.id, version.content_digest)) {
              return yield* failure(sources.length > 0 ? "DestinationExists" : "OwnershipMismatch")
            }
          }
          const decisionInput = {
            scope: cohortScope,
            versionID: version.id,
            kind: artifact.kind,
            agentID: input.agentID,
            modelID: input.modelID,
            goalMode: input.goalMode,
            now,
          }
          const preflight = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const decision = yield* accounting
                  .decideInTransaction(tx, decisionInput)
                  .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
                if (decision.action === "degrade") return yield* Effect.fail(new GovernorDegrade(decision))
                if (decision.action === "none") return decision
                const updated = yield* tx
                  .update(ProjectArtifactTable)
                  .set({ revision: artifact.revision + 1, stage: "active", time_updated: now })
                  .where(
                    and(
                      eq(ProjectArtifactTable.scope_id, input.scopeID),
                      eq(ProjectArtifactTable.kind, input.kind),
                      eq(ProjectArtifactTable.artifact_id, input.id),
                      eq(ProjectArtifactTable.revision, artifact.revision),
                      eq(ProjectArtifactTable.current_version_id, version.id),
                    ),
                  )
                  .returning({ revision: ProjectArtifactTable.revision })
                  .get()
                if (!updated) return yield* failure("VersionConflict")
                yield* tx
                  .update(ProjectArtifactVersionTable)
                  .set({ state: "active", time_state_changed: now })
                  .where(eq(ProjectArtifactVersionTable.id, version.id))
                  .run()
                return decision
              }),
            )
            .pipe(
              Effect.catch((cause) =>
                cause instanceof GovernorDegrade
                  ? Effect.succeed(cause.decision)
                  : Effect.fail(cause instanceof StoreError ? cause : failure("ReconciliationRequired")),
              ),
            )
          if (preflight.action !== "degrade") return preflight
          const reserved = yield* reserveOperation({
            id: operationID,
            scopeID: input.scopeID,
            kind: input.kind,
            artifactID: input.id,
            operation,
            requestFingerprint,
            expectedRevision: input.expectedRevision,
            expectedVersionID: input.expectedVersionID,
            expectedDigest: input.expectedDigest,
            targetVersionID: target?.id ?? input.expectedVersionID,
            targetDigest: target?.content_digest ?? input.expectedDigest,
            now,
          })
          if (reserved.phase === "finalized") {
            yield* cleanupFinalizedState(root, operationID)
            return preflight
          }
          const finalize = db
            .transaction((tx) =>
              Effect.gen(function* () {
                const currentArtifact = yield* getArtifact(tx, input.scopeID, input.kind, input.id)
                const currentVersion = currentArtifact ? yield* getVersion(tx, currentArtifact.current_version_id) : undefined
                if (
                  !currentArtifact ||
                  !currentVersion ||
                  currentArtifact.revision !== input.expectedRevision ||
                  currentVersion.id !== input.expectedVersionID ||
                  currentVersion.content_digest !== input.expectedDigest
                ) {
                  return yield* failure("VersionConflict")
                }
                const decision = yield* accounting
                  .decideInTransaction(tx, decisionInput)
                  .pipe(Effect.mapError(() => failure("ReconciliationRequired")))
                if (decision.action !== "degrade") return yield* failure("VersionConflict")
                yield* tx
                  .update(ProjectArtifactVersionTable)
                  .set({ state: "degraded", time_state_changed: now })
                  .where(eq(ProjectArtifactVersionTable.id, version.id))
                  .run()
                if (target) {
                  yield* tx
                    .update(ProjectArtifactVersionTable)
                    .set({ state: "active", time_state_changed: now })
                    .where(eq(ProjectArtifactVersionTable.id, target.id))
                    .run()
                }
                const updated = yield* tx
                  .update(ProjectArtifactTable)
                  .set({
                    revision: currentArtifact.revision + 1,
                    stage: target ? "active" : "degraded",
                    current_version_id: target?.id ?? version.id,
                    fallback_version_id: target?.parent_version_id ?? currentArtifact.fallback_version_id,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(ProjectArtifactTable.scope_id, input.scopeID),
                      eq(ProjectArtifactTable.kind, input.kind),
                      eq(ProjectArtifactTable.artifact_id, input.id),
                      eq(ProjectArtifactTable.revision, currentArtifact.revision),
                      eq(ProjectArtifactTable.current_version_id, currentVersion.id),
                    ),
                  )
                  .returning({ revision: ProjectArtifactTable.revision })
                  .get()
                if (!updated) return yield* failure("VersionConflict")
                yield* storeFeedback(tx, version, "revert", "automatic-governor", now)
                yield* finalizeOperation(tx, operationID, target?.id ?? version.id, now)
              }),
            )
            .pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired")))
          const contentPath = scope.type === "global"
            ? ProjectArtifactAdapterRegistry.globalPath(input.kind, global, input.id)
            : undefined
          yield* stateMutation(
            {
              root,
              operationID,
              operation: target ? "rollback" : "disable",
              current: markerFrom(scope, version),
              ...(target ? { target: markerFrom(scope, target) } : {}),
              ...(contentPath
                ? { contentPath, markerPath: standardMarkerPath(contentPath, input.kind, input.id) }
                : {}),
              context: encodeGovernorStateContext({
                ...(input.agentID === undefined ? {} : { agentID: input.agentID }),
                modelID: input.modelID,
                goalMode: input.goalMode,
                now,
              }),
            },
            finalize,
            now,
          )
          return preflight
        }),
      )
    })

    const previewManual = Effect.fn("ProjectArtifactStore.previewManual")(function* (input: ManualPreviewInput) {
      const validation = ProjectArtifactValidation.validateAutomatic({ id: input.id, definition: input.definition })
      if (validation[0]) return yield* failure(validation[0].code)
      const definition = ProjectArtifactAdapterRegistry.decode(input.definition.kind, input.definition)
      if (definition.kind === "plugin") return yield* failure("UnsupportedKind")
      const id = ProjectArtifact.ID.make(input.id)
      const content = ProjectArtifactAdapterRegistry.render(definition, { source: "user" })
      const renderedErrors = ProjectArtifactValidation.validateRendered(content)
      if (renderedErrors[0]) return yield* failure(renderedErrors[0].code)
      const scope = yield* resolveGlobalScope()
      const artifact = yield* getArtifact(db, scope.id, definition.kind, id)
      const version = artifact ? yield* getVersion(db, artifact.current_version_id) : undefined
      const expectations = [input.expectedRevision, input.expectedVersionID, input.expectedDigest]
      if (!artifact && expectations.some((value) => value !== undefined)) return yield* failure("VersionConflict")
      if (
        artifact &&
        (!version ||
          input.expectedRevision === undefined ||
          input.expectedVersionID === undefined ||
          input.expectedDigest === undefined ||
          artifact.revision !== input.expectedRevision ||
          version.id !== input.expectedVersionID ||
          version.content_digest !== input.expectedDigest)
      ) {
        return yield* failure("VersionConflict")
      }
      const sources = yield* standardSources.resolve({ scope: "global", kind: definition.kind, id })
      if (!artifact && sources.length > 0) return yield* failure("DestinationExists")
      if (artifact && version && !exactManagedSources(sources, scope.id, version.id, version.content_digest)) {
        return yield* failure("DestinationExists")
      }
      if (artifact && version) {
        yield* readStoredContent(global, scope, artifact, version).pipe(Effect.mapError(() => failure("OwnershipMismatch")))
      }
      const now = input.now ?? Date.now()
      const token = ProjectArtifact.ConfirmationToken.make(randomUUID())
      tokens.set(token, {
        type: "manual",
        kind: definition.kind,
        id,
        content,
        contentDigest: ProjectArtifact.Digest.make(Hash.sha256(content)),
        expectedRevision: input.expectedRevision,
        expectedVersionID: input.expectedVersionID,
        expectedDigest: input.expectedDigest,
        expiresAt: now + 5 * 60_000,
      })
      return { token, expiresAt: now + 5 * 60_000 }
    })

    const confirmManual = Effect.fn("ProjectArtifactStore.confirmManual")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "manual" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      const scope = yield* resolveGlobalScope()
      const write = Effect.gen(function* () {
        const artifact = yield* getArtifact(db, scope.id, preview.kind, preview.id)
        const version = artifact ? yield* getVersion(db, artifact.current_version_id) : undefined
        const sources = yield* standardSources.resolve({ scope: "global", kind: preview.kind, id: preview.id })
        if (!preview.expectedVersionID) {
          if (artifact || sources.length > 0) {
            return yield* failure("DestinationExists")
          }
        } else if (
          !artifact ||
          !version ||
          artifact.revision !== preview.expectedRevision ||
          version.id !== preview.expectedVersionID ||
          version.content_digest !== preview.expectedDigest
        ) {
          return yield* failure("VersionConflict")
        }
        if (artifact && version && !exactManagedSources(sources, scope.id, version.id, version.content_digest)) {
          return yield* failure("DestinationExists")
        }
        if (artifact && version) {
          const stored = yield* readStoredContent(global, scope, artifact, version).pipe(
            Effect.mapError(() => failure("OwnershipMismatch")),
          )
          if (Hash.sha256(stored) !== version.content_digest) return yield* failure("OwnershipMismatch")
        }
        return yield* commitSnapshot({
          scope,
          kind: preview.kind,
          id: preview.id,
          content: preview.content,
          contentDigest: preview.contentDigest,
          source: "user",
          now,
          artifact,
          currentVersion: version,
        })
      })
      return yield* flock.withLock(write, `project-artifact-scope:${scope.id}`).pipe(
        Effect.mapError((cause) =>
          cause instanceof StoreError
            ? cause
            : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
        ),
      )
    })

    const previewFork = Effect.fn("ProjectArtifactStore.previewFork")(function* (input: ForkPreviewInput) {
      const source = yield* resolveGlobalScope()
      const destination = yield* resolveProjectScope(input.projectID)
      const artifact = yield* getArtifact(db, source.id, input.kind, input.id)
      const version = artifact ? yield* getVersion(db, artifact.current_version_id) : undefined
      if (
        !artifact ||
        !version ||
        (input.expectedRevision !== undefined && artifact.revision !== input.expectedRevision) ||
        version.id !== input.expectedVersionID ||
        version.content_digest !== input.expectedDigest
      ) {
        return yield* failure("VersionConflict")
      }
      if (
        !exactManagedSources(
          yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id }),
          source.id,
          version.id,
          version.content_digest,
        )
      ) {
        return yield* failure("ArtifactCollision")
      }
      if (yield* getArtifact(db, destination.id, input.kind, input.id)) return yield* failure("ArtifactCollision")
      if ((yield* standardSources.resolve({ scope: "project", projectID: input.projectID, kind: input.kind, id: input.id })).length > 0) {
        return yield* failure("ArtifactCollision")
      }
      const content = yield* readStoredContent(global, source, artifact, version).pipe(
        Effect.mapError(() => failure("OwnershipMismatch")),
      )
      if (Hash.sha256(content) !== version.content_digest) return yield* failure("OwnershipMismatch")
      const now = input.now ?? Date.now()
      const token = ProjectArtifact.ConfirmationToken.make(randomUUID())
      tokens.set(token, {
        type: "fork",
        source,
        destination,
        kind: input.kind,
        id: input.id,
        revision: artifact.revision,
        versionID: version.id,
        digest: version.content_digest,
        content,
        expiresAt: now + 5 * 60_000,
      })
      return { token, expiresAt: now + 5 * 60_000 }
    })

    const confirmFork = Effect.fn("ProjectArtifactStore.confirmFork")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "fork" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      const write = Effect.gen(function* () {
        const source = yield* getArtifact(db, preview.source.id, preview.kind, preview.id)
        const version = source ? yield* getVersion(db, source.current_version_id) : undefined
        if (
          !source ||
          !version ||
          source.revision !== preview.revision ||
          version.id !== preview.versionID ||
          version.content_digest !== preview.digest ||
          (yield* getArtifact(db, preview.destination.id, preview.kind, preview.id))
        ) {
          return yield* failure("VersionConflict")
        }
        if (
          !exactManagedSources(
            yield* standardSources.resolve({ scope: "global", kind: preview.kind, id: preview.id }),
            preview.source.id,
            version.id,
            version.content_digest,
          ) ||
          (yield* standardSources.resolve({
            scope: "project",
            projectID: preview.destination.projectID,
            kind: preview.kind,
            id: preview.id,
          })).length > 0
        ) {
          return yield* failure("ArtifactCollision")
        }
        const content = yield* readStoredContent(global, preview.source, source, version).pipe(
          Effect.mapError(() => failure("OwnershipMismatch")),
        )
        if (Hash.sha256(content) !== preview.digest || content !== preview.content) return yield* failure("VersionConflict")
        return yield* commitSnapshot({
          scope: preview.destination,
          kind: preview.kind,
          id: preview.id,
          content: preview.content,
          contentDigest: preview.digest,
          source: "fork",
          now,
          originScopeID: preview.source.id,
          originVersionID: preview.versionID,
          originEvidenceDigest: preview.digest,
          shadowedScopeID: preview.source.id,
        })
      })
      const first = preview.source.id < preview.destination.id ? preview.source.id : preview.destination.id
      const second = first === preview.source.id ? preview.destination.id : preview.source.id
      return yield* flock
        .withLock(
          flock.withLock(write, `project-artifact-scope:${second}`),
          `project-artifact-scope:${first}`,
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof StoreError
              ? cause
              : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
          ),
        )
    })

    const previewShadow = Effect.fn("ProjectArtifactStore.previewShadow")(function* (input: ShadowInput) {
      const project = yield* resolveProjectScope(input.projectID)
      const globalScope = yield* getScope(db, input.globalScopeID)
      if (!globalScope || globalScope.type !== "global") return yield* failure("InvalidScope")
      const globalValue = scopeFromRow(globalScope) as ProjectArtifact.GlobalScope
      const projectArtifact = yield* getArtifact(db, project.id, input.kind, input.id)
      const globalArtifact = yield* getArtifact(db, input.globalScopeID, input.kind, input.id)
      const projectVersion = projectArtifact ? yield* getVersion(db, projectArtifact.current_version_id) : undefined
      const globalVersion = globalArtifact ? yield* getVersion(db, globalArtifact.current_version_id) : undefined
      if (
        !projectArtifact ||
        !projectVersion ||
        !globalArtifact ||
        !globalVersion ||
        projectArtifact.revision !== input.expectedRevision ||
        projectVersion.id !== input.expectedVersionID ||
        projectVersion.content_digest !== input.expectedDigest ||
        globalArtifact.revision !== input.globalExpectedRevision ||
        globalVersion.id !== input.globalVersionID ||
        globalVersion.content_digest !== input.globalDigest
      ) {
        return yield* failure("VersionConflict")
      }
      if (
        (yield* standardSources.resolve({
          scope: "project",
          projectID: input.projectID,
          kind: input.kind,
          id: input.id,
        })).length > 0 ||
        !exactManagedSources(
          yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id }),
          globalValue.id,
          globalVersion.id,
          globalVersion.content_digest,
        )
      ) {
        return yield* failure("ArtifactCollision")
      }
      const projectContent = yield* readStoredContent(global, project, projectArtifact, projectVersion).pipe(
        Effect.mapError(() => failure("OwnershipMismatch")),
      )
      const globalContent = yield* readStoredContent(global, globalValue, globalArtifact, globalVersion).pipe(
        Effect.mapError(() => failure("OwnershipMismatch")),
      )
      if (Hash.sha256(projectContent) !== projectVersion.content_digest || Hash.sha256(globalContent) !== globalVersion.content_digest) {
        return yield* failure("OwnershipMismatch")
      }
      const now = input.now ?? Date.now()
      const token = ProjectArtifact.ConfirmationToken.make(randomUUID())
      tokens.set(token, {
        type: "shadow",
        project,
        global: globalValue,
        kind: input.kind,
        id: input.id,
        projectRevision: projectArtifact.revision,
        projectVersionID: projectVersion.id,
        projectDigest: projectVersion.content_digest,
        globalRevision: globalArtifact.revision,
        globalVersionID: globalVersion.id,
        globalDigest: globalVersion.content_digest,
        expiresAt: now + 5 * 60_000,
      })
      return { token, expiresAt: now + 5 * 60_000 }
    })

    const confirmShadow = Effect.fn("ProjectArtifactStore.confirmShadow")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "shadow" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      const write = Effect.gen(function* () {
        const projectArtifact = yield* getArtifact(db, preview.project.id, preview.kind, preview.id)
        const globalArtifact = yield* getArtifact(db, preview.global.id, preview.kind, preview.id)
        const projectVersion = projectArtifact ? yield* getVersion(db, projectArtifact.current_version_id) : undefined
        const globalVersion = globalArtifact ? yield* getVersion(db, globalArtifact.current_version_id) : undefined
        if (
          !projectArtifact ||
          !projectVersion ||
          !globalArtifact ||
          !globalVersion ||
          projectArtifact.revision !== preview.projectRevision ||
          projectVersion.id !== preview.projectVersionID ||
          projectVersion.content_digest !== preview.projectDigest ||
          globalArtifact.revision !== preview.globalRevision ||
          globalVersion.id !== preview.globalVersionID ||
          globalVersion.content_digest !== preview.globalDigest
        ) {
          return yield* failure("VersionConflict")
        }
        if (
          (yield* standardSources.resolve({
            scope: "project",
            projectID: preview.project.projectID,
            kind: preview.kind,
            id: preview.id,
          })).length > 0 ||
          !exactManagedSources(
            yield* standardSources.resolve({ scope: "global", kind: preview.kind, id: preview.id }),
            preview.global.id,
            globalVersion.id,
            globalVersion.content_digest,
          )
        ) {
          return yield* failure("ArtifactCollision")
        }
        const projectContent = yield* readStoredContent(global, preview.project, projectArtifact, projectVersion).pipe(
          Effect.mapError(() => failure("OwnershipMismatch")),
        )
        const globalContent = yield* readStoredContent(global, preview.global, globalArtifact, globalVersion).pipe(
          Effect.mapError(() => failure("OwnershipMismatch")),
        )
        if (Hash.sha256(projectContent) !== preview.projectDigest || Hash.sha256(globalContent) !== preview.globalDigest) {
          return yield* failure("OwnershipMismatch")
        }
        const alreadyShadowed =
          projectArtifact.shadowed_scope_id === preview.global.id &&
          projectVersion.origin_scope_id === preview.global.id &&
          projectVersion.origin_version_id === preview.globalVersionID &&
          projectVersion.origin_evidence_digest === preview.globalDigest
        const requestFingerprint = ProjectArtifact.Digest.make(
          Hash.sha256(
            [
              preview.project.id,
              preview.kind,
              preview.id,
              "shadow",
              preview.projectRevision,
              preview.projectVersionID,
              preview.projectDigest,
              preview.global.id,
              preview.globalVersionID,
              preview.globalDigest,
            ].join("\0"),
          ),
        )
        const operationID = `pop_${requestFingerprint.slice(0, 32)}`
        const operationSpec: OperationSpec = {
          id: operationID,
          scopeID: preview.project.id,
          kind: preview.kind,
          artifactID: preview.id,
          operation: "shadow",
          requestFingerprint,
          expectedRevision: preview.projectRevision,
          expectedVersionID: preview.projectVersionID,
          expectedDigest: preview.projectDigest,
          sourceScopeID: preview.global.id,
          sourceVersionID: preview.globalVersionID,
          sourceDigest: preview.globalDigest,
          targetVersionID: preview.projectVersionID,
          targetDigest: preview.projectDigest,
          now,
        }
        const reserved = yield* reserveOperation(operationSpec)
        if (reserved.phase === "finalized") return
        yield* markOperationAvailable(operationID, now)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (!alreadyShadowed) {
                const updated = yield* tx
                  .update(ProjectArtifactTable)
                  .set({
                    revision: projectArtifact.revision + 1,
                    shadowed_scope_id: preview.global.id,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(ProjectArtifactTable.scope_id, preview.project.id),
                      eq(ProjectArtifactTable.kind, preview.kind),
                      eq(ProjectArtifactTable.artifact_id, preview.id),
                      eq(ProjectArtifactTable.revision, projectArtifact.revision),
                      eq(ProjectArtifactTable.current_version_id, projectVersion.id),
                    ),
                  )
                  .returning({ revision: ProjectArtifactTable.revision })
                  .get()
                if (!updated) return yield* failure("VersionConflict")
                yield* tx
                  .update(ProjectArtifactVersionTable)
                  .set({
                    origin_scope_id: preview.global.id,
                    origin_version_id: preview.globalVersionID,
                    origin_evidence_digest: preview.globalDigest,
                  })
                  .where(eq(ProjectArtifactVersionTable.id, projectVersion.id))
                  .run()
              }
              yield* finalizeOperation(tx, operationID, projectVersion.id, now)
            }),
          )
          .pipe(Effect.mapError((cause) => (cause instanceof StoreError ? cause : failure("ReconciliationRequired"))))
      })
      const first = preview.project.id < preview.global.id ? preview.project.id : preview.global.id
      const second = first === preview.project.id ? preview.global.id : preview.project.id
      return yield* flock
        .withLock(
          flock.withLock(write, `project-artifact-scope:${second}`),
          `project-artifact-scope:${first}`,
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof StoreError
              ? cause
              : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
          ),
        )
    })

    const previewDeleteMutation = Effect.fn("ProjectArtifactStore.previewDeleteMutation")(function* (
      type: "remove" | "disable" | "enable" | "revert",
      input: DeleteInput | RevertInput,
    ) {
      const scopeRow = yield* getScope(db, input.scopeID)
      if (!scopeRow || scopeRow.type !== "global") return yield* failure("InvalidScope")
      const artifact = yield* getArtifact(db, input.scopeID, input.kind, input.id)
      if (!artifact) return yield* failure("ArtifactNotFound")
      if (artifact.stage === "quarantine") return yield* failure("UnsupportedKind")
      const version = yield* getVersion(db, artifact.current_version_id)
      if (!version) return yield* failure("VersionNotFound")
      if (
        artifact.revision !== input.expectedRevision ||
        version.id !== input.expectedVersionID ||
        version.content_digest !== input.expectedDigest
      ) {
        return yield* failure("VersionConflict")
      }
      if (type === "revert") {
        if (!("targetVersionID" in input)) return yield* failure("VersionNotFound")
        const target = yield* getVersion(db, input.targetVersionID)
        if (!target || target.scope_id !== input.scopeID || target.kind !== input.kind || target.artifact_id !== input.id) {
          return yield* failure("VersionNotFound")
        }
      }
      const sources = yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id })
      if (type === "enable") {
        if (sources.length > 0) return yield* failure("DestinationExists")
      } else if (artifact.stage === "trial" || artifact.stage === "active") {
        if (!exactManagedSources(sources, scopeRow.id, version.id, version.content_digest)) {
          return yield* failure(sources.length > 0 ? "DestinationExists" : "OwnershipMismatch")
        }
      } else if (sources.length > 0) {
        return yield* failure("DestinationExists")
      }
      const scope = scopeFromRow(scopeRow) as ProjectArtifact.GlobalScope
      const content = yield* readStoredContent(global, scope, artifact, version).pipe(
        Effect.mapError(() => failure("OwnershipMismatch")),
      )
      if (Hash.sha256(content) !== version.content_digest) return yield* failure("OwnershipMismatch")
      const now = input.now ?? Date.now()
      const token = ProjectArtifact.ConfirmationToken.make(randomUUID())
      if (type === "revert") {
        if (!("targetVersionID" in input)) return yield* failure("VersionNotFound")
        tokens.set(token, { type, input, expiresAt: now + 5 * 60_000 })
      } else {
        tokens.set(token, { type, input, expiresAt: now + 5 * 60_000 })
      }
      return { token, expiresAt: now + 5 * 60_000 }
    })

    const previewRemove = Effect.fn("ProjectArtifactStore.previewRemove")(function* (input: DeleteInput) {
      return yield* previewDeleteMutation("remove", input)
    })

    const confirmRemove = Effect.fn("ProjectArtifactStore.confirmRemove")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "remove" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      return yield* scopeMutation(preview.input.scopeID, removeMutation({ ...preview.input, now }))
    })

    const previewDisable = Effect.fn("ProjectArtifactStore.previewDisable")(function* (input: DeleteInput) {
      return yield* previewDeleteMutation("disable", input)
    })

    const confirmDisable = Effect.fn("ProjectArtifactStore.confirmDisable")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "disable" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      return yield* scopeMutation(preview.input.scopeID, changeEnabled({ ...preview.input, now }, false))
    })

    const previewEnable = Effect.fn("ProjectArtifactStore.previewEnable")(function* (input: DeleteInput) {
      return yield* previewDeleteMutation("enable", input)
    })

    const confirmEnable = Effect.fn("ProjectArtifactStore.confirmEnable")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "enable" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      return yield* scopeMutation(preview.input.scopeID, changeEnabled({ ...preview.input, now }, true))
    })

    const previewRevert = Effect.fn("ProjectArtifactStore.previewRevert")(function* (input: RevertInput) {
      return yield* previewDeleteMutation("revert", input)
    })

    const confirmRevert = Effect.fn("ProjectArtifactStore.confirmRevert")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "revert" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      return yield* scopeMutation(
        preview.input.scopeID,
        rollback({ ...preview.input, now }, preview.input.targetVersionID, false),
      )
    })

    const previewRestore = Effect.fn("ProjectArtifactStore.previewRestore")(function* (input: RestorePreviewInput) {
      const now = input.now ?? Date.now()
      const trash = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.deletion_id, input.deletionID))
        .get()
        .pipe(Effect.orDie)
      if (!trash) return yield* failure("DeletionNotFound")
      if (now >= trash.purge_after) return yield* failure("TrashExpired")
      const scope = yield* getScope(db, trash.scope_id)
      if (!scope || scope.type !== "global") return yield* failure("InvalidScope")
      if ((yield* standardSources.resolve({ scope: "global", kind: trash.kind, id: trash.artifact_id })).length > 0) {
        return yield* failure("DestinationExists")
      }
      yield* trashDetails(trash)
      const token = ProjectArtifact.ConfirmationToken.make(randomUUID())
      tokens.set(token, {
        type: "restore",
        deletionID: trash.deletion_id,
        scopeID: trash.scope_id,
        kind: trash.kind,
        id: trash.artifact_id,
        priorStage: trash.prior_stage,
        priorVersionID: trash.prior_version_id,
        deletedAt: trash.deleted_at,
        purgeAfter: trash.purge_after,
        expiresAt: now + 5 * 60_000,
      })
      return { token, expiresAt: now + 5 * 60_000 }
    })

    const confirmRestore = Effect.fn("ProjectArtifactStore.confirmRestore")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "restore" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      const trash = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(eq(ProjectArtifactTrashTable.deletion_id, preview.deletionID))
        .get()
        .pipe(Effect.orDie)
      if (
        !trash ||
        trash.scope_id !== preview.scopeID ||
        trash.kind !== preview.kind ||
        trash.artifact_id !== preview.id ||
        trash.prior_stage !== preview.priorStage ||
        trash.prior_version_id !== preview.priorVersionID ||
        trash.deleted_at !== preview.deletedAt ||
        trash.purge_after !== preview.purgeAfter
      ) {
        return yield* failure("VersionConflict")
      }
      return yield* scopeMutation(preview.scopeID, restoreMutation(preview.deletionID, now))
    })

    const purge = Effect.fn("ProjectArtifactStore.purge")(function* (now = Date.now()) {
      const expired = yield* db
        .select()
        .from(ProjectArtifactTrashTable)
        .where(lte(ProjectArtifactTrashTable.purge_after, now))
        .orderBy(asc(ProjectArtifactTrashTable.purge_after), asc(ProjectArtifactTrashTable.deletion_id))
        .limit(128)
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        expired,
        (trash) =>
          scopeMutation(trash.scope_id, Effect.gen(function* () {
          if (trash.prior_stage === "quarantine") return yield* failure("UnsupportedKind")
          const scope = yield* getScope(db, trash.scope_id)
          const version = yield* getVersion(db, trash.prior_version_id)
          if (!scope || !version) return yield* failure("OwnershipMismatch")
          const artifact = yield* getArtifact(db, trash.scope_id, trash.kind, trash.artifact_id)
          if (!artifact) return yield* failure("ArtifactNotFound")
          const requestFingerprint = ProjectArtifact.Digest.make(
            Hash.sha256(
              [
                trash.scope_id,
                trash.kind,
                trash.artifact_id,
                "purge",
                trash.deletion_id,
                trash.prior_version_id,
                trash.deleted_at,
                trash.purge_after,
              ].join("\0"),
            ),
          )
          const operationID = `pop_${requestFingerprint.slice(0, 32)}`
          const operationSpec: OperationSpec = {
            id: operationID,
            scopeID: trash.scope_id,
            kind: trash.kind,
            artifactID: trash.artifact_id,
            operation: "purge",
            requestFingerprint,
            expectedRevision: artifact.revision,
            expectedVersionID: version.id,
            expectedDigest: version.content_digest,
            deletionID: trash.deletion_id,
            now,
          }
          const reserved = yield* reserveOperation(operationSpec)
          if (reserved.phase !== "finalized") {
            if (reserved.phase === "preparing") {
              yield* packageEffect(
                ProjectArtifactPackage.purge({
                  root: scopeRoot(global.data, scope.storage_id),
                  marker: markerFrom(scope, version),
                  deletionID: trash.deletion_id,
                  priorStage: trash.prior_stage,
                  deletedAt: trash.deleted_at,
                  now,
                }),
              )
              yield* markOperationAvailable(operationID, now)
            }
            yield* purgeIndex(trash, operationID, now)
          }
          })),
        { discard: true },
      )
      return expired.length
    })

    const previewPromotion = Effect.fn("ProjectArtifactStore.previewPromotion")(function* (
      input: PromotionPreviewInput,
    ) {
      const source = yield* resolveProjectScope(input.projectID)
      const artifact = yield* getArtifact(db, source.id, input.kind, input.id)
      if (!artifact) return yield* failure("ArtifactNotFound")
      const version = yield* getVersion(db, artifact.current_version_id)
      if (!version) return yield* failure("VersionNotFound")
      if (
        artifact.revision !== input.expectedRevision ||
        version.id !== input.expectedVersionID ||
        version.content_digest !== input.expectedDigest
      ) {
        return yield* failure("VersionConflict")
      }
      const root = scopeRoot(global.data, source.storageID)
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(ProjectArtifactPackage.activeContentPath(root, input.kind, input.id), "utf8"),
        catch: () => failure("StorageUnavailable"),
      })
      const definition = ProjectArtifactAdapterRegistry.parse(input.kind, content)
      const destination = yield* resolveGlobalScope()
      const projectSources = yield* standardSources.resolve({
        scope: "project",
        projectID: input.projectID,
        kind: input.kind,
        id: input.id,
      })
      if (
        input.kind === "plugin" ||
        projectSources.length > 0 ||
        (yield* standardSources.resolve({ scope: "global", kind: input.kind, id: input.id })).length > 0 ||
        (yield* getArtifact(db, destination.id, input.kind, input.id))
      ) {
        return yield* failure(
          input.kind === "plugin"
            ? "UnsupportedKind"
            : projectSources.length > 0
              ? "ArtifactCollision"
              : "DestinationExists",
        )
      }
      const now = input.now ?? Date.now()
      const metrics = yield* accounting.metrics(version.id)
      const token = ProjectArtifact.ConfirmationToken.make(randomUUID())
      tokens.set(token, {
        type: "promotion",
        source,
        kind: input.kind,
        id: input.id,
        revision: artifact.revision,
        versionID: version.id,
        digest: version.content_digest,
        expiresAt: now + 5 * 60_000,
      })
      return ProjectArtifact.PromotionPreview.make({
        artifact: {
          scope: source,
          kind: input.kind,
          id: input.id,
          name: ProjectArtifact.DisplayName.make(definition.name),
          description: ProjectArtifact.Description.make(definition.description),
          stage: artifact.stage,
          revision: artifact.revision,
          currentVersionID: version.id,
          currentDigest: version.content_digest,
          lastUsedAt: artifact.last_used_at ?? undefined,
          timeUpdated: artifact.time_updated,
        },
        metrics: ProjectArtifact.Metrics.make({ ...metrics, lastUsedAt: artifact.last_used_at ?? undefined }),
        destination,
        risk: "declarative",
        renderedContent: ProjectArtifact.RenderedContent.make(content),
        token,
        expiresAt: now + 5 * 60_000,
      })
    })

    const confirmPromotionMutation = Effect.fn("ProjectArtifactStore.confirmPromotionMutation")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      tokens.delete(token)
      if (!preview || preview.type !== "promotion" || now >= preview.expiresAt) return yield* failure("ConfirmationExpired")
      const artifact = yield* getArtifact(db, preview.source.id, preview.kind, preview.id)
      const sourceVersion = artifact ? yield* getVersion(db, artifact.current_version_id) : undefined
      if (
        !artifact ||
        !sourceVersion ||
        artifact.revision !== preview.revision ||
        sourceVersion.id !== preview.versionID ||
        sourceVersion.content_digest !== preview.digest
      ) {
        return yield* failure("VersionConflict")
      }
      if (
        (yield* standardSources.resolve({
          scope: "project",
          projectID: preview.source.projectID,
          kind: preview.kind,
          id: preview.id,
        })).length > 0
      ) {
        return yield* failure("ArtifactCollision")
      }
      const destination = yield* resolveGlobalScope()
      if (
        (yield* standardSources.resolve({ scope: "global", kind: preview.kind, id: preview.id })).length > 0 ||
        (yield* getArtifact(db, destination.id, preview.kind, preview.id))
      ) {
        return yield* failure("DestinationExists")
      }
      const sourceRoot = scopeRoot(global.data, preview.source.storageID)
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(ProjectArtifactPackage.activeContentPath(sourceRoot, preview.kind, preview.id), "utf8"),
        catch: () => failure("StorageUnavailable"),
      })
      if (Hash.sha256(content) !== preview.digest) return yield* failure("OwnershipMismatch")
      const contentPath = ProjectArtifactAdapterRegistry.globalPath(preview.kind, global, preview.id)
      const markerPath = standardMarkerPath(contentPath, preview.kind, preview.id)
      const versionID = versionIDValue()
      const marker = ProjectArtifactPackage.marker({
        scopeID: destination.id,
        storageID: destination.storageID,
        kind: preview.kind,
        id: preview.id,
        versionID,
        content,
      })
      const requestFingerprint = ProjectArtifact.Digest.make(
        Hash.sha256(
          [
            destination.id,
            preview.kind,
            preview.id,
            "promotion",
            preview.source.id,
            preview.revision,
            preview.versionID,
            preview.digest,
            versionID,
            marker.contentDigest,
          ].join("\0"),
        ),
      )
      const operationID = `pop_${requestFingerprint.slice(0, 32)}`
      const operationSpec: OperationSpec = {
        id: operationID,
        scopeID: destination.id,
        kind: preview.kind,
        artifactID: preview.id,
        operation: "promotion",
        requestFingerprint,
        sourceScopeID: preview.source.id,
        sourceVersionID: preview.versionID,
        sourceDigest: preview.digest,
        targetVersionID: versionID,
        targetDigest: marker.contentDigest,
        now,
      }
      const reserved = yield* reserveOperation(operationSpec)
      if (reserved.phase === "finalized") {
        yield* cleanupFinalizedCommit(scopeRoot(global.data, destination.storageID), operationID)
        return writeResultValue("created", destination.id, preview.kind, preview.id, versionID, marker.contentDigest, {
          session: 3,
          projectDaily: 10,
          artifacts: 0,
          kindArtifacts: 0,
          versions: 0,
          bytes: 0,
        })
      }
      yield* Effect.tryPromise({
        try: () => Promise.all([fs.mkdir(path.dirname(contentPath), { recursive: true }), fs.mkdir(path.dirname(markerPath), { recursive: true })]),
        catch: () => failure("StorageUnavailable"),
      })
      yield* packageTransaction(
        ProjectArtifactPackage.commitTransaction(
          {
            root: scopeRoot(global.data, destination.storageID),
            marker,
            content,
            contentPath,
            markerPath,
            noOverwrite: true,
            operationID,
            ...(hooks.packageFilesystem ? { filesystem: hooks.packageFilesystem } : {}),
          },
          {
            reserve: () => reserveOperation(operationSpec).pipe(Effect.asVoid),
            finalize: () =>
              Effect.gen(function* () {
                yield* markOperationAvailable(operationID, now)
                yield* db.transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx.run("PRAGMA defer_foreign_keys = ON")
                    const finalizedArtifact = yield* getArtifact(tx, destination.id, preview.kind, preview.id)
                    const finalizedVersion = yield* getVersion(tx, versionID)
                    if (!finalizedArtifact && !finalizedVersion) {
                      yield* tx
                        .insert(ProjectArtifactTable)
                        .values({
                          scope_id: destination.id,
                          kind: preview.kind,
                          artifact_id: preview.id,
                          revision: 0,
                          stage: "trial",
                          current_version_id: versionID,
                          time_created: now,
                          time_updated: now,
                        })
                        .run()
                      yield* tx
                        .insert(ProjectArtifactVersionTable)
                        .values({
                          id: versionID,
                          scope_id: destination.id,
                          kind: preview.kind,
                          artifact_id: preview.id,
                          state: "trial",
                          content_digest: marker.contentDigest,
                          content_relpath: marker.contentRelpath,
                          source: "promotion",
                          origin_scope_id: preview.source.id,
                          origin_version_id: preview.versionID,
                          origin_evidence_digest: preview.digest,
                          time_created: now,
                          time_state_changed: now,
                        })
                        .run()
                    } else if (
                      !finalizedArtifact ||
                      !finalizedVersion ||
                      finalizedArtifact.current_version_id !== versionID ||
                      finalizedVersion.content_digest !== marker.contentDigest
                    ) {
                      return yield* failure("VersionConflict")
                    }
                    const updated = yield* tx
                      .update(ProjectArtifactTable)
                      .set({ shadowed_scope_id: destination.id, time_updated: now })
                      .where(
                        and(
                          eq(ProjectArtifactTable.scope_id, preview.source.id),
                          eq(ProjectArtifactTable.kind, preview.kind),
                          eq(ProjectArtifactTable.artifact_id, preview.id),
                          eq(ProjectArtifactTable.revision, preview.revision),
                          eq(ProjectArtifactTable.current_version_id, preview.versionID),
                        ),
                      )
                      .returning({ revision: ProjectArtifactTable.revision })
                      .get()
                    if (!updated) return yield* failure("VersionConflict")
                    yield* storeFeedback(tx, sourceVersion, "promote", "user", now)
                    yield* finalizeOperation(tx, operationID, versionID, now)
                  }),
                )
                if (hooks.afterPackageFinalize) yield* hooks.afterPackageFinalize(operationID)
              }).pipe(Effect.mapError((cause) => cause instanceof StoreError ? cause : failure("ReconciliationRequired"))),
            abort: () =>
              db
                .transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx.run("PRAGMA defer_foreign_keys = ON")
                    yield* tx
                      .delete(ProjectArtifactTable)
                      .where(
                        and(
                          eq(ProjectArtifactTable.scope_id, destination.id),
                          eq(ProjectArtifactTable.kind, preview.kind),
                          eq(ProjectArtifactTable.artifact_id, preview.id),
                          eq(ProjectArtifactTable.current_version_id, versionID),
                        ),
                      )
                      .run()
                    yield* tx
                      .update(ProjectArtifactTable)
                      .set({ shadowed_scope_id: artifact.shadowed_scope_id, time_updated: artifact.time_updated })
                      .where(
                        and(
                          eq(ProjectArtifactTable.scope_id, preview.source.id),
                          eq(ProjectArtifactTable.kind, preview.kind),
                          eq(ProjectArtifactTable.artifact_id, preview.id),
                          eq(ProjectArtifactTable.revision, preview.revision),
                        ),
                      )
                      .run()
                    yield* abortOperation(tx, operationID, now)
                  }),
                )
                .pipe(Effect.mapError(() => failure("ReconciliationRequired"))),
          },
        ),
      )
      return writeResultValue("created", destination.id, preview.kind, preview.id, versionID, marker.contentDigest, {
        session: 3,
        projectDaily: 10,
        artifacts: 0,
        kindArtifacts: 0,
        versions: 0,
        bytes: 0,
      })
    })

    const confirmPromotion = Effect.fn("ProjectArtifactStore.confirmPromotion")(function* (
      token: ProjectArtifact.ConfirmationToken,
      now = Date.now(),
    ) {
      const preview = tokens.get(token)
      if (!preview || preview.type !== "promotion") return yield* confirmPromotionMutation(token, now)
      const destination = yield* resolveGlobalScope()
      const first = preview.source.id < destination.id ? preview.source.id : destination.id
      const second = first === preview.source.id ? destination.id : preview.source.id
      return yield* flock
        .withLock(
          flock.withLock(confirmPromotionMutation(token, now), `project-artifact-scope:${second}`),
          `project-artifact-scope:${first}`,
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof StoreError
              ? cause
              : failure(cause._tag === "LockTimeoutError" ? "LockTimeout" : "StorageUnavailable"),
          ),
        )
    })

    return Service.of({
      resolveProjectScope,
      resolveGlobalScope,
      adoptProject,
      writeAutomatic,
      writeManual,
      list,
      get,
      getTrash,
      previewManual,
      confirmManual,
      previewFork,
      confirmFork,
      previewShadow,
      confirmShadow,
      previewRemove,
      confirmRemove,
      previewRestore,
      confirmRestore,
      previewDisable,
      confirmDisable,
      previewEnable,
      confirmEnable,
      previewRevert,
      confirmRevert,
      purge,
      reconcile,
      remove,
      restore,
      disable,
      enable,
      revert,
      degrade,
      evaluateGovernor,
      previewPromotion,
      confirmPromotion,
    })
  }),
)

const layerWithRegistry = (hooks: StoreHooks) =>
  Layer.unwrap(
    Effect.map(
      ProjectArtifactStandardSourceRegistry.StandardSourceRegistry,
      (standardSources) => layerWithResolver(standardSources, hooks),
    ),
  )

export function layerWith(
  resolver: StandardSourceResolver,
  hooks?: StoreHooks,
): ReturnType<typeof layerWithResolver>
export function layerWith(
  resolver?: undefined,
  hooks?: StoreHooks,
): ReturnType<typeof layerWithRegistry>
export function layerWith(resolver?: StandardSourceResolver, hooks: StoreHooks = {}) {
  if (resolver) return layerWithResolver(resolver, hooks)
  return layerWithRegistry(hooks)
}

export const layer = layerWith()

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    Global.node,
    EffectFlock.node,
    ProjectArtifactAccounting.node,
    ProjectArtifactStandardSourceRegistry.registryNode,
  ],
})

function getScope(db: DatabaseClient | Transaction, id: ProjectArtifact.ScopeID) {
  return db.select().from(ProjectArtifactScopeTable).where(eq(ProjectArtifactScopeTable.id, id)).get().pipe(Effect.orDie)
}

function getArtifact(
  db: DatabaseClient | Transaction,
  scopeID: ProjectArtifact.ScopeID,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
) {
  return db
    .select()
    .from(ProjectArtifactTable)
    .where(
      and(
        eq(ProjectArtifactTable.scope_id, scopeID),
        eq(ProjectArtifactTable.kind, kind),
        eq(ProjectArtifactTable.artifact_id, id),
      ),
    )
    .get()
    .pipe(Effect.orDie)
}

function getVersion(db: DatabaseClient | Transaction, id: ProjectArtifact.VersionID) {
  return db
    .select()
    .from(ProjectArtifactVersionTable)
    .where(eq(ProjectArtifactVersionTable.id, id))
    .get()
    .pipe(Effect.orDie)
}

function projectIDForScope(db: DatabaseClient | Transaction, scopeID: ProjectArtifact.ScopeID) {
  return db
    .select({ projectID: ProjectArtifactProjectScopeTable.project_id })
    .from(ProjectArtifactProjectScopeTable)
    .where(eq(ProjectArtifactProjectScopeTable.scope_id, scopeID))
    .get()
    .pipe(Effect.orDie, Effect.map((row) => row?.projectID))
}

interface QuotaInput {
  readonly db: DatabaseClient | Transaction
  readonly sessionID: Session.ID
  readonly scopeID: ProjectArtifact.ScopeID
  readonly now: number
  readonly root: string
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
}

interface Counters {
  readonly session: number
  readonly projectDaily: number
  readonly artifacts: number
  readonly kindArtifacts: number
  readonly versions: number
  readonly bytes: number
}

const emptyCounters: Counters = {
  session: 0,
  projectDaily: 0,
  artifacts: 0,
  kindArtifacts: 0,
  versions: 0,
  bytes: 0,
}

function quotaCounters(input: QuotaInput) {
  return Effect.gen(function* () {
    yield* input.db
      .delete(ProjectArtifactWriteTable)
      .where(lt(ProjectArtifactWriteTable.time_created, input.now - 30 * day))
      .run()
      .pipe(Effect.orDie)
    const session = yield* input.db
      .select()
      .from(ProjectArtifactWriteTable)
      .where(
        and(
          eq(ProjectArtifactWriteTable.session_id, input.sessionID),
          ne(ProjectArtifactWriteTable.result, "reconciled"),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const daily = yield* input.db
      .select()
      .from(ProjectArtifactWriteTable)
      .where(
        and(
          eq(ProjectArtifactWriteTable.scope_id, input.scopeID),
          gte(ProjectArtifactWriteTable.time_created, input.now - day),
          ne(ProjectArtifactWriteTable.result, "reconciled"),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const operations = yield* input.db
      .select()
      .from(ProjectArtifactOperationTable)
      .where(
        and(
          eq(ProjectArtifactOperationTable.scope_id, input.scopeID),
          inArray(ProjectArtifactOperationTable.phase, ["preparing", "available"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const artifacts = yield* input.db
      .select()
      .from(ProjectArtifactTable)
      .where(eq(ProjectArtifactTable.scope_id, input.scopeID))
      .all()
      .pipe(Effect.orDie)
    const trash = yield* input.db
      .select()
      .from(ProjectArtifactTrashTable)
      .where(eq(ProjectArtifactTrashTable.scope_id, input.scopeID))
      .all()
      .pipe(Effect.orDie)
    const versions = yield* input.db
      .select()
      .from(ProjectArtifactVersionTable)
      .where(
        and(
          eq(ProjectArtifactVersionTable.scope_id, input.scopeID),
          eq(ProjectArtifactVersionTable.kind, input.kind),
          eq(ProjectArtifactVersionTable.artifact_id, input.id),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const bytes = yield* ownedDirectorySize(input.root)
    const trashed = new Set(trash.map((item) => `${item.kind}:${item.artifact_id}`))
    const live = artifacts.filter((item) => !trashed.has(`${item.kind}:${item.artifact_id}`))
    const pendingCreates = operations.filter(
      (item) =>
        item.operation === "create" &&
        !live.some((artifact) => artifact.kind === item.kind && artifact.artifact_id === item.artifact_id),
    )
    return {
      session:
        session.length +
        operations.filter((item) => item.automatic_session_id === input.sessionID).length,
      projectDaily:
        daily.length +
        operations.filter(
          (item) => item.automatic_session_id !== null && item.time_created >= input.now - day,
        ).length,
      artifacts: live.length + pendingCreates.length,
      kindArtifacts:
        live.filter((item) => item.kind === input.kind).length +
        pendingCreates.filter((item) => item.kind === input.kind).length,
      versions:
        versions.length +
        operations.filter(
          (item) =>
            item.operation === "update" && item.kind === input.kind && item.artifact_id === input.id,
        ).length,
      bytes,
    }
  })
}

function writeResult(
  result: ProjectArtifact.AutomaticWriteResult,
  scopeID: ProjectArtifact.ScopeID,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
  versionID: ProjectArtifact.VersionID,
  digest: ProjectArtifact.Digest,
  input: QuotaInput,
) {
  return quotaCounters(input).pipe(
    Effect.map((counters) => writeResultValue(result, scopeID, kind, id, versionID, digest, counters)),
  )
}

function writeResultValue(
  result: ProjectArtifact.AutomaticWriteResult,
  scopeID: ProjectArtifact.ScopeID,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
  versionID: ProjectArtifact.VersionID,
  digest: ProjectArtifact.Digest,
  counters: Counters,
): WriteResult {
  return {
    result,
    scopeID,
    kind,
    id,
    versionID,
    contentDigest: digest,
    stage: "trial",
    remaining: {
      session: Math.max(0, 3 - counters.session),
      projectDaily: Math.max(0, 10 - counters.projectDaily),
      projectArtifacts: Math.max(0, 32 - counters.artifacts),
      versions: Math.max(0, 16 - counters.versions),
      bytes: Math.max(0, 8 * 1_024 * 1_024 - counters.bytes),
    },
  }
}

function markerFrom(scope: ScopeRow, version: VersionRow) {
  return ProjectArtifactPackage.Marker.make({
    schema: 1,
    scopeID: scope.id,
    storageID: scope.storage_id,
    kind: version.kind,
    id: version.artifact_id,
    versionID: version.id,
    contentDigest: version.content_digest,
    contentRelpath: version.content_relpath,
  })
}

function scopeRoot(data: string, storageID: ProjectArtifact.StorageID) {
  return path.join(data, "project-artifacts", storageID)
}

function writeScopeMarker(root: string, scope: ProjectArtifact.Scope) {
  return Effect.tryPromise({
    try: async () => {
      await fs.mkdir(root, { recursive: true })
      const file = ProjectArtifactPackage.scopeMarkerPath(root)
      await fs.writeFile(`${file}.tmp`, scopeMarkerContent(scope))
      await fs.rename(`${file}.tmp`, file)
    },
    catch: () => failure("StorageUnavailable"),
  })
}

function restoreMissingScopeMarker(root: string, scope: ProjectArtifact.Scope) {
  const file = ProjectArtifactPackage.scopeMarkerPath(root)
  return Effect.tryPromise({
    try: async () => {
      const missing = await fs.readFile(file).then(
        () => false,
        (error) => {
          if (fileErrorCode(error, "ENOENT")) return true
          throw error
        },
      )
      if (!missing) return
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(file, scopeMarkerContent(scope), { flag: "wx" }).catch((error) => {
        if (!fileErrorCode(error, "EEXIST")) throw error
      })
    },
    catch: () => failure("StorageUnavailable"),
  })
}

function scopeMarkerContent(scope: ProjectArtifact.Scope) {
  return JSON.stringify({ schema: 1, scopeID: scope.id, type: scope.type, storageID: scope.storageID })
}

function fileErrorCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function ownedDirectorySize(root: string): Effect.Effect<number> {
  return Effect.promise(() => ownedDirectorySizePromise(root))
}

async function ownedDirectorySizePromise(root: string) {
  const files = await collectFiles(root)
  const owned = new Set(
    files.filter((file) =>
      [".ycoding-scope.json", ".ycoding-operation.json", ".ycoding-trash.json"].includes(path.basename(file)),
    ),
  )
  const trashRoots = files
    .filter((file) => path.basename(file) === ".ycoding-trash.json")
    .map((file) => path.dirname(file))
  for (const file of files) {
    if (trashRoots.some((trash) => file === trash || file.startsWith(`${trash}${path.sep}`))) owned.add(file)
  }
  await Promise.all(
    files.map(async (file) => {
      const encoded = await Bun.file(file).text().catch(() => undefined)
      if (!encoded) return
      const marker = Option.getOrUndefined(decodePackageMarker(encoded))
      if (!marker) return
      const content = file === ProjectArtifactPackage.activeMarkerPath(root, marker.kind, marker.id)
        ? ProjectArtifactPackage.activeContentPath(root, marker.kind, marker.id)
        : path.join(path.dirname(file), marker.contentRelpath)
      if (!(await Bun.file(content).exists())) return
      if (Hash.sha256(await Bun.file(content).text()) !== marker.contentDigest) return
      owned.add(file)
      owned.add(content)
    }),
  )
  const sizes = await Promise.all([...owned].map((file) => fs.stat(file).then((item) => item.size, () => 0)))
  return sizes.reduce((sum, value) => sum + value, 0)
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return []
      const item = path.join(root, entry.name)
      if (entry.isDirectory()) return collectFiles(item)
      return entry.isFile() ? [item] : []
    }),
    )
  ).flat()
}

function standardMarkerPath(contentPath: string, kind: ProjectArtifact.Kind, id: string) {
  if (kind === "skill") return path.join(path.dirname(contentPath), ".ycoding-project-artifact.json")
  return path.join(path.dirname(contentPath), `.${id}.ycoding-project-artifact.json`)
}

function exactManagedSources(
  sources: ReadonlyArray<StandardSource>,
  scopeID: ProjectArtifact.ScopeID,
  versionID: ProjectArtifact.VersionID,
  digest: ProjectArtifact.Digest,
) {
  return sources.length > 0 && sources.every(
    (source) =>
      source.managedScopeID === scopeID &&
      source.managedVersionID === versionID &&
      source.managedDigest === digest,
  )
}

function readStoredContent(
  global: Global.Interface,
  scope: ProjectArtifact.Scope,
  artifact: ArtifactRow,
  version: VersionRow,
) {
  const root = scopeRoot(global.data, scope.storageID)
  const file =
    artifact.stage === "disabled" || artifact.stage === "degraded"
      ? path.join(root, "disabled", artifact.kind, artifact.artifact_id, version.id, version.content_relpath)
      : scope.type === "global"
        ? ProjectArtifactAdapterRegistry.globalPath(artifact.kind, global, artifact.artifact_id)
        : ProjectArtifactPackage.activeContentPath(root, artifact.kind, artifact.artifact_id)
  return Effect.tryPromise({
    try: () => fs.readFile(file, "utf8"),
    catch: () => failure("StorageUnavailable"),
  })
}

function artifactValue(scope: ProjectArtifact.Scope, artifact: ArtifactRow): ProjectArtifact.Artifact {
  return ProjectArtifact.Artifact.make({
    scope,
    kind: artifact.kind,
    id: artifact.artifact_id,
    revision: artifact.revision,
    stage: artifact.stage,
    currentVersionID: artifact.current_version_id,
    fallbackVersionID: artifact.fallback_version_id ?? undefined,
    shadowedScopeID: artifact.shadowed_scope_id ?? undefined,
    lastUsedAt: artifact.last_used_at ?? undefined,
    timeCreated: artifact.time_created,
    timeUpdated: artifact.time_updated,
  })
}

function versionValue(version: VersionRow): ProjectArtifact.Version {
  return ProjectArtifact.Version.make({
    id: version.id,
    parentVersionID: version.parent_version_id ?? undefined,
    state: version.state,
    contentDigest: version.content_digest,
    contentRelpath: version.content_relpath,
    provenance: {
      source: version.source,
      creatorAgentID: version.creator_agent_id ?? undefined,
      creatorSessionID: version.creator_session_id ?? undefined,
      insightDigest: version.insight_digest ?? undefined,
      originScopeID: version.origin_scope_id ?? undefined,
      originVersionID: version.origin_version_id ?? undefined,
      originEvidenceDigest: version.origin_evidence_digest ?? undefined,
    },
    timeCreated: version.time_created,
    timeStateChanged: version.time_state_changed,
  })
}

function automaticRequestFingerprint(input: {
  readonly scopeID: ProjectArtifact.ScopeID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly operation: "create" | "update"
  readonly baseVersionID?: ProjectArtifact.VersionID
  readonly contentDigest: ProjectArtifact.Digest
}) {
  return Hash.sha256(
    [input.scopeID, input.kind, input.id, input.operation, input.baseVersionID ?? "", input.contentDigest].join("\0"),
  )
}

function operationMatches(row: OperationRow, spec: OperationSpec) {
  return (
    row.id === spec.id &&
    row.scope_id === spec.scopeID &&
    row.kind === spec.kind &&
    row.artifact_id === spec.artifactID &&
    row.operation === spec.operation &&
    row.request_fingerprint === spec.requestFingerprint &&
    row.expected_revision === (spec.expectedRevision ?? null) &&
    row.expected_version_id === (spec.expectedVersionID ?? null) &&
    row.expected_digest === (spec.expectedDigest ?? null) &&
    row.source_scope_id === (spec.sourceScopeID ?? null) &&
    row.source_version_id === (spec.sourceVersionID ?? null) &&
    row.source_digest === (spec.sourceDigest ?? null) &&
    row.target_version_id === (spec.targetVersionID ?? null) &&
    row.target_digest === (spec.targetDigest ?? null) &&
    row.deletion_id === (spec.deletionID ?? null) &&
    row.automatic_session_id === (spec.automaticSessionID ?? null) &&
    row.automatic_insight_digest === (spec.automaticInsightDigest ?? null)
  )
}

function exists(file: string) {
  return Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )
}

function existsPromise(file: string) {
  return fs.lstat(file).then(
    () => true,
    () => false,
  )
}

function normalizeInsight(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
}

function scopeID() {
  return ProjectArtifact.ScopeID.make(`pas_${randomUUID().replaceAll("-", "")}`)
}

function versionIDValue() {
  return ProjectArtifact.VersionID.make(`pav_${randomUUID().replaceAll("-", "")}`)
}

function deletionIDValue() {
  return ProjectArtifact.DeletionID.make(`pad_${randomUUID().replaceAll("-", "")}`)
}

function failure(code: ProjectArtifact.ErrorCode) {
  return new StoreError({ code, message: "Project Artifact operation failed" })
}
