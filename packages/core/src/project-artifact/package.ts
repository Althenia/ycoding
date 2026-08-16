export * as ProjectArtifactPackage from "./package"

import { randomUUID } from "crypto"
import path from "path"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Effect, Exit, Schema } from "effect"
import { Hash } from "../util/hash"
import { EffectFlock } from "../util/effect-flock"
import { executeMutation, native, UnsafeMutationError } from "./filesystem"
import type { Filesystem, MutationRequest } from "./filesystem"

export const Marker = Schema.Struct({
  schema: Schema.Literal(1),
  scopeID: ProjectArtifact.ScopeID,
  storageID: ProjectArtifact.StorageID,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
  versionID: ProjectArtifact.VersionID,
  contentDigest: ProjectArtifact.Digest,
  contentRelpath: ProjectArtifact.ContentRelpath,
})
export type Marker = typeof Marker.Type

const MarkerJson = Schema.fromJsonString(Marker)
const encodeMarker = Schema.encodeSync(MarkerJson)
const decodeMarker = Schema.decodeUnknownSync(MarkerJson)
const trashLifetimeMs = 30 * 86_400_000

export const CommitTransactionPhase = Schema.Literals([
  "prepared",
  "reserved",
  "archiving-content",
  "archiving-marker",
  "activating-content",
  "activating-marker",
  "available",
  "finalizing",
  "committed",
  "compensating",
  "compensated",
])
export type CommitTransactionPhase = typeof CommitTransactionPhase.Type

export const CommitTransactionMetadata = Schema.Struct({
  schema: Schema.Literal(1),
  operationID: Schema.String,
  phase: CommitTransactionPhase,
  marker: Marker,
  previous: Schema.optional(Marker),
  stageRoot: Schema.String,
  contentPath: Schema.String,
  markerPath: Schema.String,
  standard: Schema.Boolean,
})
export type CommitTransactionMetadata = typeof CommitTransactionMetadata.Type

const CommitTransactionMetadataJson = Schema.fromJsonString(CommitTransactionMetadata)
const encodeCommitTransactionMetadata = Schema.encodeSync(CommitTransactionMetadataJson)
const decodeCommitTransactionMetadata = Schema.decodeUnknownSync(CommitTransactionMetadataJson)

export const StateMutationPhase = Schema.Literals([
  "prepared",
  "moving-current-content",
  "moving-current-marker",
  "moving-target-content",
  "moving-target-marker",
  "restoring-target-content",
  "restoring-target-marker",
  "restoring-current-content",
  "restoring-current-marker",
  "available",
  "finalizing",
  "committed",
  "compensating",
  "compensated",
])
export type StateMutationPhase = typeof StateMutationPhase.Type

export const StateMutationMetadata = Schema.Struct({
  schema: Schema.Literal(1),
  operationID: Schema.String,
  phase: StateMutationPhase,
  operation: Schema.Literals(["disable", "enable", "rollback"]),
  current: Marker,
  target: Schema.optional(Marker),
  stageRoot: Schema.String,
  contentPath: Schema.String,
  markerPath: Schema.String,
  standard: Schema.Boolean,
  context: Schema.optional(Schema.String),
})
export type StateMutationMetadata = typeof StateMutationMetadata.Type

const StateMutationMetadataJson = Schema.fromJsonString(StateMutationMetadata)
const encodeStateMutationMetadata = Schema.encodeSync(StateMutationMetadataJson)
const decodeStateMutationMetadata = Schema.decodeUnknownSync(StateMutationMetadataJson)

export class Failure extends Schema.TaggedErrorClass<Failure>()("ProjectArtifactPackage.Failure", {
  code: ProjectArtifact.ErrorCode,
  message: ProjectArtifact.Description,
}) {}

export interface MarkerInput {
  readonly scopeID: ProjectArtifact.ScopeID
  readonly storageID: ProjectArtifact.StorageID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly versionID: ProjectArtifact.VersionID
  readonly content: string
}

export function marker(input: MarkerInput): Marker {
  return Marker.make({
    schema: 1,
    scopeID: input.scopeID,
    storageID: input.storageID,
    kind: input.kind,
    id: input.id,
    versionID: input.versionID,
    contentDigest: ProjectArtifact.Digest.make(Hash.sha256(input.content)),
    contentRelpath: ProjectArtifact.ContentRelpath.make(relativeContentPath(input.kind, input.id)),
  })
}

export function activeContentPath(root: string, kind: ProjectArtifact.Kind, id: string) {
  if (kind === "skill") return path.join(root, "active", "skills", id, "SKILL.md")
  if (kind === "command") return path.join(root, "active", "commands", `${id}.md`)
  if (kind === "agent") return path.join(root, "active", "agents", `${id}.md`)
  return path.join(root, "active", "plugins", `${id}.ts`)
}

export function activeMarkerPath(root: string, kind: ProjectArtifact.Kind, id: string) {
  return path.join(root, "metadata", kind, `${id}.json`)
}

export function versionRoot(root: string, value: Pick<Marker, "kind" | "id" | "versionID">) {
  return path.join(root, "versions", value.kind, value.id, value.versionID)
}

export function versionContentPath(root: string, value: Marker) {
  return path.join(versionRoot(root, value), value.contentRelpath)
}

export function versionMarkerPath(root: string, value: Marker) {
  return path.join(versionRoot(root, value), ".ycoding-project-artifact.json")
}

export function scopeMarkerPath(root: string) {
  return path.join(root, ".ycoding-scope.json")
}

export interface CommitInput {
  readonly root: string
  readonly marker: Marker
  readonly content: string
  readonly expectedVersionID?: ProjectArtifact.VersionID
  readonly operationID?: string
  readonly filesystem?: Filesystem
}

export interface PreparedCommit {
  readonly input: CommitInput
  readonly current: Marker | undefined
  readonly stage: { readonly root: string; readonly content: string; readonly marker: string }
  readonly metadata: CommitTransactionMetadata
}

type ArtifactIdentity = Pick<Marker, "scopeID" | "kind" | "id">

interface ArtifactLockInput {
  readonly root: string
  readonly marker: ArtifactIdentity
}

export function withArtifactLock<A, E, R>(input: ArtifactLockInput, body: Effect.Effect<A, E, R>) {
  return withReconcileGate(input.root, withArtifactLockOnly(input, body))
}

function withArtifactLockOnly<A, E, R>(input: ArtifactLockInput, body: Effect.Effect<A, E, R>) {
  return withPackageLock(input.root, lockKey(input.marker), body)
}

function withReconcileGate<A, E, R>(root: string, body: Effect.Effect<A, E, R>) {
  return withPackageLock(root, "project-artifact:reconcile", body)
}

function withPackageLock<A, E, R>(root: string, key: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    return yield* flock
      .withLock(body, key, path.join(root, "locks"))
      .pipe(
        Effect.mapError((error) =>
          error instanceof EffectFlock.LockTimeoutError
            ? failure("LockTimeout")
            : error instanceof EffectFlock.LockCompromisedError
              ? failure("StorageUnavailable")
              : error,
        ),
      )
  })
}

export interface CommitTransactionHooks<E, R> {
  readonly reserve: (metadata: CommitTransactionMetadata) => Effect.Effect<void, E, R>
  readonly finalize: (metadata: CommitTransactionMetadata) => Effect.Effect<void, E, R>
  readonly abort: (metadata: CommitTransactionMetadata) => Effect.Effect<void, E, R>
}

const transactionNoopHooks: CommitTransactionHooks<never, never> = {
  reserve: () => Effect.void,
  finalize: () => Effect.void,
  abort: () => Effect.void,
}

export function commitTransaction<E, R>(input: CommitInput | StandardCommitInput, hooks: CommitTransactionHooks<E, R>) {
  const finalized: { value: CommitTransactionMetadata | undefined } = { value: undefined }
  return Effect.uninterruptible(
    withArtifactLock(
      input,
      Effect.gen(function* () {
        const filesystem = input.filesystem ?? native
        const prepared = yield* Effect.tryPromise({
          try: () => prepareOrResumeCommitUnsafe(input, filesystem),
          catch: (cause) => packageFailure(cause),
        })
        if (prepared.metadata.phase === "committed") {
          finalized.value = prepared.metadata
          yield* Effect.tryPromise({
            try: () => cleanupCommitTransactionUnsafe(prepared.metadata, filesystem),
            catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
          }).pipe(Effect.ignore)
          return prepared.metadata
        }
        const available =
          prepared.metadata.phase === "available" || prepared.metadata.phase === "finalizing"
            ? { ...prepared.metadata, phase: "available" as const }
            : undefined
        const beforeFinalize = yield* Effect.exit(
          Effect.interruptible(
            Effect.gen(function* () {
              yield* hooks.reserve(available ?? prepared.metadata)
              if (!available) {
                yield* Effect.tryPromise({
                  try: async () => {
                    await writeCommitPhase(prepared, "reserved", filesystem)
                    return makeAvailableUnsafe(prepared, filesystem)
                  },
                  catch: (cause) => packageFailure(cause),
                })
              }
              const ready = available ?? { ...prepared.metadata, phase: "available" as const }
              yield* Effect.tryPromise({
                try: () => writeCommitPhase(prepared, "finalizing", filesystem),
                catch: (cause) => packageFailure(cause),
              })
              return ready
            }),
          ),
        )
        if (Exit.isFailure(beforeFinalize)) {
          return yield* compensateCommitFailure(beforeFinalize, prepared, filesystem, hooks)
        }
        const finalizeExit = yield* Effect.exit(Effect.interruptible(hooks.finalize(beforeFinalize.value)))
        if (Exit.isFailure(finalizeExit)) {
          return yield* compensateCommitFailure(finalizeExit, prepared, filesystem, hooks)
        }
        finalized.value = { ...beforeFinalize.value, phase: "finalizing" }
        const committed = yield* Effect.exit(
          Effect.tryPromise({
            try: () => writeCommitPhase(prepared, "committed", filesystem),
            catch: (cause) => packageFailure(cause),
          }),
        )
        if (Exit.isFailure(committed)) {
          yield* Effect.logWarning("project artifact commit journal cleanup deferred", {
            operationID: prepared.metadata.operationID,
          })
          return { ...beforeFinalize.value, phase: "finalizing" as const }
        }
        finalized.value = committed.value
        const removed = yield* Effect.exit(
          Effect.tryPromise({
            try: () => remove(input.root, prepared.stage.root, filesystem, true),
            catch: (cause) => packageFailure(cause),
          }),
        )
        if (Exit.isFailure(removed)) {
          yield* Effect.logWarning("project artifact commit journal removal deferred", {
            operationID: prepared.metadata.operationID,
          })
        }
        return committed.value
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        finalized.value ? Effect.succeed(finalized.value) : Effect.failCause(cause),
      ),
    ),
  )
}

function compensateCommitFailure<A, E, R>(
  attempt: Exit.Exit<A, E>,
  prepared: PreparedCommit,
  filesystem: Filesystem,
  hooks: CommitTransactionHooks<E, R>,
) {
  return Effect.gen(function* () {
    const interrupted = yield* Effect.promise(() =>
      readCommitJournal(prepared.input.root, prepared.stage.root, filesystem),
    )
    const compensation = yield* Effect.exit(
      Effect.tryPromise({
        try: async () => {
          await writeCommitPhase(prepared, "compensating", filesystem)
          await compensate(prepared, filesystem)
          return writeCommitPhase(prepared, "compensated", filesystem)
        },
        catch: () => failure("ReconciliationRequired"),
      }),
    )
    if (Exit.isFailure(compensation)) {
      if (interrupted) {
        yield* Effect.tryPromise({
          try: () => writeCommitPhase(prepared, interrupted.phase, filesystem),
          catch: () => failure("ReconciliationRequired"),
        }).pipe(Effect.ignore)
      }
      return yield* attempt
    }
    yield* hooks.abort(compensation.value)
    yield* Effect.tryPromise({
      try: () => remove(prepared.input.root, prepared.stage.root, filesystem, true),
      catch: () => failure("ReconciliationRequired"),
    })
    return yield* attempt
  })
}

export interface StateMutationInput {
  readonly root: string
  readonly operationID: string
  readonly operation: "disable" | "enable" | "rollback"
  readonly current: Marker
  readonly target?: Marker
  readonly contentPath?: string
  readonly markerPath?: string
  readonly context?: string
  readonly filesystem?: Filesystem
}

export interface StateMutationHooks<E, R> {
  readonly reserve: (metadata: StateMutationMetadata) => Effect.Effect<void, E, R>
  readonly finalize: (metadata: StateMutationMetadata) => Effect.Effect<void, E, R>
  readonly abort: (metadata: StateMutationMetadata) => Effect.Effect<void, E, R>
}

const stateMutationNoopHooks: StateMutationHooks<never, never> = {
  reserve: () => Effect.void,
  finalize: () => Effect.void,
  abort: () => Effect.void,
}

export function stateTransaction<E, R>(input: StateMutationInput, hooks: StateMutationHooks<E, R>) {
  const finalized: { value: StateMutationMetadata | undefined } = { value: undefined }
  return Effect.uninterruptible(
    withArtifactLock(
      { root: input.root, marker: input.current },
      Effect.gen(function* () {
        const filesystem = input.filesystem ?? native
        const prepared = yield* Effect.tryPromise({
          try: () => prepareOrResumeStateMutation(input, filesystem),
          catch: (cause) => packageFailure(cause),
        })
        if (prepared.phase === "committed") {
          finalized.value = prepared
          yield* Effect.tryPromise({
            try: () => cleanupStateTransactionUnsafe(prepared, filesystem),
            catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
          }).pipe(Effect.ignore)
          return prepared
        }
        const available = prepared.phase === "available" || prepared.phase === "finalizing"
        const beforeFinalize = yield* Effect.exit(
          Effect.interruptible(
            Effect.gen(function* () {
              yield* hooks.reserve(available ? { ...prepared, phase: "available" } : prepared)
              const ready = available
                ? { ...prepared, phase: "available" as const }
                : yield* Effect.tryPromise({
                    try: () => makeStateAvailable(prepared, filesystem),
                    catch: (cause) => packageFailure(cause),
                  })
              yield* Effect.tryPromise({
                try: () => writeStateMutationPhase(ready, "finalizing", filesystem),
                catch: (cause) => packageFailure(cause),
              })
              return ready
            }),
          ),
        )
        if (Exit.isFailure(beforeFinalize)) {
          return yield* compensateStateFailure(beforeFinalize, prepared, filesystem, hooks)
        }
        const finalizeExit = yield* Effect.exit(Effect.interruptible(hooks.finalize(beforeFinalize.value)))
        if (Exit.isFailure(finalizeExit)) {
          return yield* compensateStateFailure(finalizeExit, prepared, filesystem, hooks)
        }
        finalized.value = { ...beforeFinalize.value, phase: "finalizing" }
        const committed = yield* Effect.exit(
          Effect.tryPromise({
            try: () => writeStateMutationPhase(beforeFinalize.value, "committed", filesystem),
            catch: (cause) => packageFailure(cause),
          }),
        )
        if (Exit.isFailure(committed)) {
          yield* Effect.logWarning("project artifact state journal commit cleanup deferred", {
            operationID: input.operationID,
          })
          return { ...beforeFinalize.value, phase: "finalizing" as const }
        }
        finalized.value = committed.value
        const removed = yield* Effect.exit(
          Effect.tryPromise({
            try: () => remove(input.root, committed.value.stageRoot, filesystem, true),
            catch: (cause) => packageFailure(cause),
          }),
        )
        if (Exit.isFailure(removed)) {
          yield* Effect.logWarning("project artifact state journal removal deferred", {
            operationID: input.operationID,
          })
        }
        return committed.value
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        finalized.value ? Effect.succeed(finalized.value) : Effect.failCause(cause),
      ),
    ),
  )
}

function compensateStateFailure<A, E, R>(
  attempt: Exit.Exit<A, E>,
  prepared: StateMutationMetadata,
  filesystem: Filesystem,
  hooks: StateMutationHooks<E, R>,
) {
  return Effect.gen(function* () {
    const compensation = yield* Effect.exit(
      Effect.tryPromise({
        try: async () => {
          const compensating = await writeStateMutationPhase(prepared, "compensating", filesystem)
          await compensateStateMutation(compensating, filesystem)
          return writeStateMutationPhase(compensating, "compensated", filesystem)
        },
        catch: () => failure("ReconciliationRequired"),
      }),
    )
    if (Exit.isFailure(compensation)) return yield* attempt
    yield* hooks.abort(compensation.value)
    yield* Effect.tryPromise({
      try: () => remove(stateMutationRoot(prepared), compensation.value.stageRoot, filesystem, true),
      catch: () => failure("ReconciliationRequired"),
    })
    return yield* attempt
  })
}

export function prepareCommit(input: CommitInput) {
  return Effect.tryPromise({
    try: () => prepareCommitUnsafe(input, input.filesystem ?? native),
    catch: (cause) => packageFailure(cause),
  })
}

export function makeAvailable(prepared: PreparedCommit, filesystem: Filesystem = prepared.input.filesystem ?? native) {
  return Effect.tryPromise({
    try: () => makeAvailableUnsafe(prepared, filesystem),
    catch: (cause) => packageFailure(cause),
  })
}

export function finalizeCommit(prepared: PreparedCommit, filesystem: Filesystem = prepared.input.filesystem ?? native) {
  return Effect.tryPromise({
    try: async () => {
      await writeCommitPhase(prepared, "committed", filesystem)
      await remove(prepared.input.root, prepared.stage.root, filesystem, true)
    },
    catch: (cause) => packageFailure(cause),
  })
}

export function commit(input: CommitInput) {
  return commitTransaction(input, transactionNoopHooks)
}

export interface StandardCommitInput extends CommitInput {
  readonly contentPath: string
  readonly markerPath: string
  readonly noOverwrite?: boolean
}

export function commitStandard(input: StandardCommitInput) {
  return commitTransaction(input, transactionNoopHooks)
}

export interface TrashInput {
  readonly root: string
  readonly marker: Marker
  readonly deletionID: ProjectArtifact.DeletionID
  readonly priorStage?: "trial" | "active" | "degraded" | "disabled"
  readonly deletedAt?: number
  readonly now?: number
  readonly filesystem?: Filesystem
}

export const TrashManifestEntry = Schema.Struct({
  layout: Schema.Literals(["active", "version", "disabled"]),
  versionID: ProjectArtifact.VersionID,
  source: Schema.String,
  content: Schema.String,
  marker: Schema.String,
  contentDigest: ProjectArtifact.Digest,
  contentRelpath: ProjectArtifact.ContentRelpath,
})
export type TrashManifestEntry = typeof TrashManifestEntry.Type

export const TrashManifest = Schema.Struct({
  schema: Schema.Literal(1),
  phase: Schema.Literals(["trashing", "trashed", "restoring"]),
  deletionID: ProjectArtifact.DeletionID,
  scopeID: ProjectArtifact.ScopeID,
  storageID: ProjectArtifact.StorageID,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
  priorStage: Schema.Literals(["trial", "active", "degraded", "disabled"]),
  deletedAt: Schema.Number,
  entryCount: Schema.Number,
  entriesDigest: ProjectArtifact.Digest,
  standard: Schema.Boolean,
  entries: Schema.Array(TrashManifestEntry),
})
export type TrashManifest = typeof TrashManifest.Type

const TrashManifestJson = Schema.fromJsonString(TrashManifest)
const encodeTrashManifest = Schema.encodeSync(TrashManifestJson)
const decodeTrashManifest = Schema.decodeUnknownSync(TrashManifestJson)

export interface StandardTrashInput extends TrashInput {
  readonly contentPath: string
  readonly markerPath: string
}

export function trashStandard(input: StandardTrashInput) {
  return withArtifactLock(
    input,
    Effect.tryPromise({
      try: () => trashUnsafe(input, input.filesystem ?? native, standardTarget(input)),
      catch: (cause) => packageFailure(cause),
    }),
  )
}

export function restoreStandard(input: StandardTrashInput) {
  return withArtifactLock(
    input,
    Effect.tryPromise({
      try: () => restoreUnsafe(input, input.filesystem ?? native, standardTarget(input)),
      catch: (cause) => packageFailure(cause),
    }),
  )
}

export function trash(input: TrashInput) {
  return withArtifactLock(
    input,
    Effect.tryPromise({
      try: () => trashUnsafe(input, input.filesystem ?? native),
      catch: (cause) => packageFailure(cause),
    }),
  )
}

export function readTrashManifest(
  root: string,
  deletionID: ProjectArtifact.DeletionID,
  filesystem: Filesystem = native,
) {
  return Effect.tryPromise({
    try: async () => {
      try {
        return decodeTrashManifest(await readText(root, trashManifestPath(root, deletionID), filesystem))
      } catch {
        throw failure("OwnershipMismatch")
      }
    },
    catch: (cause) => packageFailure(cause),
  })
}

export function restore(input: TrashInput) {
  return withArtifactLock(
    input,
    Effect.tryPromise({
      try: () => restoreUnsafe(input, input.filesystem ?? native),
      catch: (cause) => packageFailure(cause),
    }),
  )
}

export function purge(input: TrashInput) {
  return withArtifactLock(
    input,
    Effect.tryPromise({
      try: async () => {
        const filesystem = input.filesystem ?? native
        const manifest = await loadManifest(input, filesystem)
        if (manifest.phase !== "trashed") throw failure("ReconciliationRequired")
        if ((input.now ?? Date.now()) < manifest.deletedAt + trashLifetimeMs) throw failure("TrashExpired")
        await remove(input.root, trashRoot(input.root, input.deletionID), filesystem, true)
      },
      catch: (cause) => packageFailure(cause),
    }),
  )
}

export function disable(
  input: Pick<TrashInput, "root" | "marker" | "filesystem"> & { readonly operationID?: string },
) {
  return stateTransaction(
    {
      root: input.root,
      operationID: input.operationID ?? randomUUID(),
      operation: "disable",
      current: input.marker,
      filesystem: input.filesystem,
    },
    stateMutationNoopHooks,
  )
}

export function enable(
  input: Pick<TrashInput, "root" | "marker" | "filesystem"> & { readonly operationID?: string },
) {
  return stateTransaction(
    {
      root: input.root,
      operationID: input.operationID ?? randomUUID(),
      operation: "enable",
      current: input.marker,
      filesystem: input.filesystem,
    },
    stateMutationNoopHooks,
  )
}

export interface StandardStateInput {
  readonly root: string
  readonly marker: Marker
  readonly contentPath: string
  readonly markerPath: string
  readonly operationID?: string
  readonly filesystem?: Filesystem
}

export function disableStandard(input: StandardStateInput) {
  return stateTransaction(
    {
      root: input.root,
      operationID: input.operationID ?? randomUUID(),
      operation: "disable",
      current: input.marker,
      contentPath: input.contentPath,
      markerPath: input.markerPath,
      filesystem: input.filesystem,
    },
    stateMutationNoopHooks,
  )
}

export function enableStandard(input: StandardStateInput) {
  return stateTransaction(
    {
      root: input.root,
      operationID: input.operationID ?? randomUUID(),
      operation: "enable",
      current: input.marker,
      contentPath: input.contentPath,
      markerPath: input.markerPath,
      filesystem: input.filesystem,
    },
    stateMutationNoopHooks,
  )
}

export interface RollbackInput {
  readonly root: string
  readonly current: Marker
  readonly target: Marker
  readonly operationID?: string
  readonly filesystem?: Filesystem
}

export function rollback(input: RollbackInput) {
  return stateTransaction(
    {
      root: input.root,
      operationID: input.operationID ?? randomUUID(),
      operation: "rollback",
      current: input.current,
      target: input.target,
      filesystem: input.filesystem,
    },
    stateMutationNoopHooks,
  )
}

export function rollbackStandard(input: RollbackInput & Pick<StandardStateInput, "contentPath" | "markerPath">) {
  return stateTransaction(
    {
      root: input.root,
      operationID: input.operationID ?? randomUUID(),
      operation: "rollback",
      current: input.current,
      target: input.target,
      contentPath: input.contentPath,
      markerPath: input.markerPath,
      filesystem: input.filesystem,
    },
    stateMutationNoopHooks,
  )
}

export function reconcile(root: string, filesystem: Filesystem = native) {
  return withReconcileGate(
    root,
    Effect.gen(function* () {
      const scope = yield* Effect.tryPromise({
        try: () => scopeOwnership(root, filesystem),
        catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
      })
      yield* reconcileStaging(root, scope, filesystem)
      yield* reconcileTrash(root, scope, filesystem)
      const files = yield* Effect.tryPromise({
        try: () => walk(root, path.join(root, "metadata"), filesystem),
        catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
      })
      const values: Marker[] = []
      for (const file of files.filter((item) => item.endsWith(".json")).toSorted()) {
        const identity = activeMarkerIdentity(root, file, scope)
        if (!identity) return yield* failure("ReconciliationRequired")
        const value = yield* withArtifactLockOnly(
          { root, marker: identity },
          Effect.tryPromise({
            try: () => reconcileActiveMarker(root, file, scope, identity, filesystem),
            catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
          }),
        )
        if (value) values.push(value)
      }
      return values
    }),
  ).pipe(Effect.mapError((cause) => packageFailure(cause, "ReconciliationRequired")))
}

export interface StandardReconcileInput {
  readonly root: string
  readonly scopeID: ProjectArtifact.ScopeID
  readonly storageID: ProjectArtifact.StorageID
  readonly roots: Partial<Record<"skill" | "command" | "agent", string>>
  readonly filesystem?: Filesystem
}

export interface StandardIssue {
  readonly kind: "skill" | "command" | "agent"
  readonly id: string
  readonly status: "content-only" | "marker-only" | "corrupt-marker" | "copied-marker"
  readonly ownership: "owned" | "user-owned" | "unknown"
}

export function reconcileStandard(input: StandardReconcileInput) {
  return Effect.gen(function* () {
    const owned: Marker[] = []
    const issues: StandardIssue[] = []
    const filesystem = input.filesystem ?? native
    for (const kind of ["skill", "command", "agent"] as const) {
      const root = input.roots[kind]
      if (!root) continue
      const names = yield* Effect.promise(() => filesystem.readdir(root, { withFileTypes: true }).catch(() => []))
      const ids = new Set<string>()
      for (const name of names) {
        if (kind === "skill" && name.isDirectory() && !name.isSymbolicLink()) ids.add(name.name)
        if (kind !== "skill") {
          const markerID = standardMarkerID(name.name)
          if (markerID) ids.add(markerID)
          const contentID = standardContentID(name.name)
          if (contentID) ids.add(contentID)
        }
      }
      for (const id of [...ids].toSorted()) {
        const contentPath = standardContentPath(root, kind, id)
        const markerPath = standardMarkerPath(root, kind, id)
        const result = yield* withArtifactLock(
          { root: input.root, marker: { scopeID: input.scopeID, kind, id: ProjectArtifact.ID.make(id) } },
          Effect.promise(async (): Promise<{ readonly marker?: Marker; readonly issue?: StandardIssue }> => {
            const hasContent = await exists(contentPath, filesystem)
            const hasMarker = await exists(markerPath, filesystem)
            const markerValue = hasMarker ? await readMarker(root, markerPath, filesystem) : undefined
            if (!hasMarker && !hasContent) return {}
            if (!hasMarker) return { issue: { kind, id, status: "content-only", ownership: "user-owned" } }
            if (!markerValue) return { issue: { kind, id, status: "corrupt-marker", ownership: "unknown" } }
            if (
              markerValue.scopeID !== input.scopeID ||
              markerValue.storageID !== input.storageID ||
              markerValue.kind !== kind ||
              markerValue.id !== id ||
              markerValue.contentRelpath !== relativeContentPath(kind, id)
            ) {
              return { issue: { kind, id, status: "copied-marker", ownership: "unknown" } }
            }
            if (!hasContent) return { issue: { kind, id, status: "marker-only", ownership: "owned" } }
            if (!(await contentMatches(root, contentPath, markerValue, filesystem))) {
              return { issue: { kind, id, status: "corrupt-marker", ownership: "owned" } }
            }
            return { marker: markerValue }
          }),
        )
        if (result.marker) owned.push(result.marker)
        if (result.issue) issues.push(result.issue)
      }
    }
    return { owned: owned.toSorted((a, b) => a.versionID.localeCompare(b.versionID)), issues }
  })
}

export function readActive(root: string, kind: ProjectArtifact.Kind, id: string, filesystem: Filesystem = native) {
  return Effect.tryPromise({
    try: () => readMarker(root, activeMarkerPath(root, kind, id), filesystem),
    catch: (cause) => packageFailure(cause),
  })
}

export function readCommitTransactions(root: string, filesystem: Filesystem = native) {
  return Effect.tryPromise({
    try: async () => {
      const scope = await scopeOwnership(root, filesystem)
      const staging = path.join(root, "staging")
      const entries = await filesystem.readdir(staging, { withFileTypes: true }).catch(() => [])
      const values: CommitTransactionMetadata[] = []
      for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
        const stageRoot = path.join(staging, entry.name)
        const metadata = await readCommitJournal(root, stageRoot, filesystem)
        if (!metadata) {
          if (await exists(commitJournalPath(stageRoot), filesystem)) throw failure("ReconciliationRequired")
          continue
        }
        if (!sameScope(metadata.marker, scope) || !validCommitMetadata(root, metadata)) {
          throw failure("ReconciliationRequired")
        }
        values.push(metadata)
      }
      return values.toSorted((a, b) => a.operationID.localeCompare(b.operationID))
    },
    catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
  })
}

export function cleanupCommitTransaction(metadata: CommitTransactionMetadata, filesystem: Filesystem = native) {
  const root = commitTransactionRoot(metadata)
  return withArtifactLock(
    { root, marker: metadata.marker },
    Effect.tryPromise({
      try: () => cleanupCommitTransactionUnsafe(metadata, filesystem),
      catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
    }),
  )
}

async function cleanupCommitTransactionUnsafe(metadata: CommitTransactionMetadata, filesystem: Filesystem) {
  const root = commitTransactionRoot(metadata)
  const scope = await scopeOwnership(root, filesystem)
  if (!sameScope(metadata.marker, scope) || !validCommitMetadata(root, metadata)) {
    throw failure("ReconciliationRequired")
  }
  const stored = await readCommitJournal(root, metadata.stageRoot, filesystem)
  if (!stored && (await exists(metadata.stageRoot, filesystem))) throw failure("ReconciliationRequired")
  const value = stored ?? metadata
  if (
    !sameCommitTransaction(metadata, value) ||
    (value.phase !== "finalizing" && value.phase !== "committed")
  ) {
    throw failure("ReconciliationRequired")
  }
  await requireAvailableCommit(value, filesystem)
  await remove(root, value.stageRoot, filesystem, true)
  return value
}

export function readStateTransactions(root: string, filesystem: Filesystem = native) {
  return Effect.tryPromise({
    try: async () => {
      const scope = await scopeOwnership(root, filesystem)
      const staging = path.join(root, "staging")
      const entries = await filesystem.readdir(staging, { withFileTypes: true }).catch(() => [])
      const values: StateMutationMetadata[] = []
      for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
        const stageRoot = path.join(staging, entry.name)
        const metadata = await readStateMutationJournal(root, stageRoot, filesystem)
        if (!metadata) {
          if (await exists(stateMutationJournalPath(stageRoot), filesystem)) throw failure("ReconciliationRequired")
          continue
        }
        if (!sameScope(metadata.current, scope) || !validStateMutationMetadata(root, metadata)) {
          throw failure("ReconciliationRequired")
        }
        values.push(metadata)
      }
      return values.toSorted((a, b) => a.operationID.localeCompare(b.operationID))
    },
    catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
  })
}

export function cleanupStateTransaction(metadata: StateMutationMetadata, filesystem: Filesystem = native) {
  const root = stateMutationRoot(metadata)
  return withArtifactLock(
    { root, marker: metadata.current },
    Effect.tryPromise({
      try: () => cleanupStateTransactionUnsafe(metadata, filesystem),
      catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
    }),
  )
}

async function cleanupStateTransactionUnsafe(metadata: StateMutationMetadata, filesystem: Filesystem) {
  const root = stateMutationRoot(metadata)
  const scope = await scopeOwnership(root, filesystem)
  if (!sameScope(metadata.current, scope) || !validStateMutationMetadata(root, metadata)) {
    throw failure("ReconciliationRequired")
  }
  const stored = await readStateMutationJournal(root, metadata.stageRoot, filesystem)
  if (!stored && (await exists(metadata.stageRoot, filesystem))) throw failure("ReconciliationRequired")
  const value = stored ?? metadata
  if (
    !stateMutationMatches(stateMutationInput(metadata), value) ||
    (value.phase !== "finalizing" && value.phase !== "committed")
  ) {
    throw failure("ReconciliationRequired")
  }
  await requireAvailableState(value, filesystem)
  await remove(root, value.stageRoot, filesystem, true)
  return value
}

async function prepareCommitUnsafe(
  input: CommitInput | StandardCommitInput,
  filesystem: Filesystem,
): Promise<PreparedCommit> {
  if (Hash.sha256(input.content) !== input.marker.contentDigest) throw failure("InvalidArtifact")
  const scope = await scopeOwnership(input.root, filesystem)
  if (!sameScope(input.marker, scope)) throw failure("OwnershipMismatch")
  const location = commitLocation(input)
  if (
    location.standard &&
    !validStandardPaths(input.marker.kind, input.marker.id, location.contentPath, location.markerPath)
  ) {
    throw failure("OwnershipMismatch")
  }
  await assertSafePath(location.contentRoot, location.contentPath, filesystem)
  await assertSafePath(location.markerRoot, location.markerPath, filesystem)
  if (
    location.standard &&
    "noOverwrite" in input &&
    input.noOverwrite &&
    ((await exists(location.contentPath, filesystem)) || (await exists(location.markerPath, filesystem)))
  ) {
    throw failure("DestinationExists")
  }
  const current = await readMarker(location.markerRoot, location.markerPath, filesystem)
  if (
    current &&
    (!sameScope(current, scope) ||
      !sameOwnership(current, input.marker) ||
      current.contentRelpath !== relativeContentPath(current.kind, current.id) ||
      !(await contentMatches(location.contentRoot, location.contentPath, current, filesystem)))
  ) {
    throw failure("OwnershipMismatch")
  }
  validateExpectation(current, input.expectedVersionID)
  const operationID = input.operationID ?? randomUUID()
  if (!validOperationID(operationID)) throw failure("InvalidArtifact")
  const stageRoot = path.join(input.root, "staging", operationID)
  if (await exists(stageRoot, filesystem)) throw failure("ReconciliationRequired")
  const stageContent = path.join(stageRoot, input.marker.contentRelpath)
  const stageMarker = path.join(stageRoot, ".ycoding-project-artifact.json")
  await mkdir(input.root, path.dirname(stageContent), filesystem)
  await write(input.root, stageContent, input.content, filesystem, "wx")
  await write(input.root, stageMarker, encodeMarker(input.marker), filesystem, "wx")
  if (!(await contentMatches(input.root, stageContent, input.marker, filesystem))) throw failure("StorageUnavailable")
  const metadata = CommitTransactionMetadata.make({
    schema: 1,
    operationID,
    phase: "prepared",
    marker: input.marker,
    previous: current,
    stageRoot,
    contentPath: location.contentPath,
    markerPath: location.markerPath,
    standard: location.standard,
  })
  await write(input.root, commitJournalPath(stageRoot), encodeCommitTransactionMetadata(metadata), filesystem, "wx")
  return { input, current, stage: { root: stageRoot, content: stageContent, marker: stageMarker }, metadata }
}

async function makeAvailableUnsafe(prepared: PreparedCommit, filesystem: Filesystem) {
  const { input, current, stage } = prepared
  const contentPath = prepared.metadata.contentPath
  const markerPath = prepared.metadata.markerPath
  if (current) {
    const destination = versionRoot(input.root, current)
    if (await exists(destination, filesystem)) throw failure("VersionConflict")
    await mkdir(input.root, destination, filesystem)
    await writeCommitPhase(prepared, "archiving-content", filesystem)
    await moveAcross(
      commitContentRoot(prepared),
      input.root,
      contentPath,
      versionContentPath(input.root, current),
      filesystem,
    )
    await writeCommitPhase(prepared, "archiving-marker", filesystem)
    await moveAcross(
      commitMarkerRoot(prepared),
      input.root,
      markerPath,
      versionMarkerPath(input.root, current),
      filesystem,
    )
  }
  if (
    prepared.metadata.standard &&
    "noOverwrite" in input &&
    input.noOverwrite &&
    ((await exists(contentPath, filesystem)) || (await exists(markerPath, filesystem)))
  ) {
    throw failure("DestinationExists")
  }
  await mkdir(commitContentRoot(prepared), path.dirname(contentPath), filesystem)
  await mkdir(commitMarkerRoot(prepared), path.dirname(markerPath), filesystem)
  await writeCommitPhase(prepared, "activating-content", filesystem)
  await moveAcross(input.root, commitContentRoot(prepared), stage.content, contentPath, filesystem)
  await writeCommitPhase(prepared, "activating-marker", filesystem)
  await moveAcross(input.root, commitMarkerRoot(prepared), stage.marker, markerPath, filesystem)
  return writeCommitPhase(prepared, "available", filesystem)
}

async function compensate(prepared: PreparedCommit, filesystem: Filesystem) {
  const content = prepared.metadata.contentPath
  const marker = prepared.metadata.markerPath
  const active = await readMarker(commitMarkerRoot(prepared), marker, filesystem)
  if (active?.versionID === prepared.input.marker.versionID) {
    if (await exists(marker, filesystem)) await remove(commitMarkerRoot(prepared), marker, filesystem)
    if (await exists(content, filesystem)) await remove(commitContentRoot(prepared), content, filesystem)
  } else if (
    !active &&
    (await contentMatches(commitContentRoot(prepared), content, prepared.input.marker, filesystem))
  ) {
    await remove(commitContentRoot(prepared), content, filesystem)
  }
  if (!prepared.current) return
  const historicalContent = versionContentPath(prepared.input.root, prepared.current)
  const historicalMarker = versionMarkerPath(prepared.input.root, prepared.current)
  if (!(await exists(content, filesystem)) && (await exists(historicalContent, filesystem))) {
    await moveAcross(prepared.input.root, commitContentRoot(prepared), historicalContent, content, filesystem)
  }
  if (!(await exists(marker, filesystem)) && (await exists(historicalMarker, filesystem))) {
    await write(
      commitMarkerRoot(prepared),
      marker,
      await readText(prepared.input.root, historicalMarker, filesystem),
      filesystem,
      "wx",
    )
    await remove(prepared.input.root, historicalMarker, filesystem)
  }
  const restored = await readMarker(commitMarkerRoot(prepared), marker, filesystem)
  if (
    !restored ||
    restored.versionID !== prepared.current.versionID ||
    !sameOwnership(restored, prepared.current) ||
    !(await contentMatches(commitContentRoot(prepared), content, restored, filesystem))
  ) {
    throw failure("ReconciliationRequired")
  }
  if (await exists(versionRoot(prepared.input.root, prepared.current), filesystem)) {
    await remove(prepared.input.root, versionRoot(prepared.input.root, prepared.current), filesystem, true)
  }
}

async function prepareOrResumeCommitUnsafe(input: CommitInput | StandardCommitInput, filesystem: Filesystem) {
  const pending = await pendingCommit(input, filesystem)
  if (!pending) return prepareCommitUnsafe(input, filesystem)
  if (
    pending.metadata.phase === "available" ||
    pending.metadata.phase === "finalizing" ||
    pending.metadata.phase === "committed"
  ) {
    return pending
  }
  await reconcilePreparedCommit(pending, filesystem)
  return prepareCommitUnsafe(input, filesystem)
}

async function prepareOrResumeStateMutation(input: StateMutationInput, filesystem: Filesystem) {
  if (!validOperationID(input.operationID)) throw failure("InvalidArtifact")
  const stageRoot = path.join(input.root, "staging", input.operationID)
  if (await exists(stageRoot, filesystem)) {
    const pending = await readStateMutationJournal(input.root, stageRoot, filesystem)
    if (!pending || !stateMutationMatches(input, pending) || !validStateMutationMetadata(input.root, pending)) {
      throw failure("ReconciliationRequired")
    }
    if (pending.phase === "compensated") {
      await remove(input.root, stageRoot, filesystem, true)
    } else {
      return pending
    }
  }
  const scope = await scopeOwnership(input.root, filesystem)
  if (!sameScope(input.current, scope)) throw failure("OwnershipMismatch")
  if (input.operation === "rollback") {
    if (!input.target || !sameScope(input.target, scope) || !sameOwnership(input.current, input.target)) {
      throw failure("OwnershipMismatch")
    }
  } else if (input.target) {
    throw failure("InvalidArtifact")
  }
  const location = stateMutationLocation(input)
  if (location.standard && !validStandardPaths(input.current.kind, input.current.id, location.contentPath, location.markerPath)) {
    throw failure("OwnershipMismatch")
  }
  await assertSafePath(location.contentRoot, location.contentPath, filesystem)
  await assertSafePath(location.markerRoot, location.markerPath, filesystem)
  if (input.operation === "enable") {
    await requireCompleteLayout(
      input.root,
      path.join(disabledRoot(input.root, input.current), input.current.contentRelpath),
      input.root,
      path.join(disabledRoot(input.root, input.current), ".ycoding-project-artifact.json"),
      input.current,
      filesystem,
    )
    if ((await exists(location.contentPath, filesystem)) || (await exists(location.markerPath, filesystem))) {
      throw failure("DestinationExists")
    }
  } else {
    await requireCompleteLayout(
      location.contentRoot,
      location.contentPath,
      location.markerRoot,
      location.markerPath,
      input.current,
      filesystem,
    )
    if (await exists(disabledRoot(input.root, input.current), filesystem)) throw failure("DestinationExists")
  }
  if (input.operation === "rollback" && input.target) {
    await requireCompleteLayout(
      input.root,
      versionContentPath(input.root, input.target),
      input.root,
      versionMarkerPath(input.root, input.target),
      input.target,
      filesystem,
    )
  }
  await mkdir(input.root, stageRoot, filesystem)
  const metadata = StateMutationMetadata.make({
    schema: 1,
    operationID: input.operationID,
    phase: "prepared",
    operation: input.operation,
    current: input.current,
    target: input.target,
    stageRoot,
    contentPath: location.contentPath,
    markerPath: location.markerPath,
    standard: location.standard,
    ...(input.context === undefined ? {} : { context: input.context }),
  })
  await write(input.root, stateMutationJournalPath(stageRoot), encodeStateMutationMetadata(metadata), filesystem, "wx")
  return metadata
}

async function makeStateAvailable(metadata: StateMutationMetadata, filesystem: Filesystem) {
  const root = stateMutationRoot(metadata)
  const contentRoot = metadata.standard ? path.dirname(metadata.contentPath) : root
  const markerRoot = metadata.standard ? path.dirname(metadata.markerPath) : root
  const disabled = disabledRoot(root, metadata.current)
  if (metadata.operation === "enable") {
    await writeStateMutationPhase(metadata, "moving-current-content", filesystem)
    await moveAcross(root, contentRoot, path.join(disabled, metadata.current.contentRelpath), metadata.contentPath, filesystem)
    await writeStateMutationPhase(metadata, "moving-current-marker", filesystem)
    await moveAcross(root, markerRoot, path.join(disabled, ".ycoding-project-artifact.json"), metadata.markerPath, filesystem)
    await remove(root, disabled, filesystem, true)
  } else {
    await mkdir(root, disabled, filesystem)
    await writeStateMutationPhase(metadata, "moving-current-content", filesystem)
    await moveAcross(contentRoot, root, metadata.contentPath, path.join(disabled, metadata.current.contentRelpath), filesystem)
    await writeStateMutationPhase(metadata, "moving-current-marker", filesystem)
    await moveAcross(markerRoot, root, metadata.markerPath, path.join(disabled, ".ycoding-project-artifact.json"), filesystem)
    if (metadata.operation === "rollback" && metadata.target) {
      await writeStateMutationPhase(metadata, "moving-target-content", filesystem)
      await moveAcross(root, contentRoot, versionContentPath(root, metadata.target), metadata.contentPath, filesystem)
      await writeStateMutationPhase(metadata, "moving-target-marker", filesystem)
      await moveAcross(root, markerRoot, versionMarkerPath(root, metadata.target), metadata.markerPath, filesystem)
      await remove(root, versionRoot(root, metadata.target), filesystem, true)
    }
  }
  await requireAvailableState(metadata, filesystem)
  return writeStateMutationPhase(metadata, "available", filesystem)
}

async function compensateStateMutation(metadata: StateMutationMetadata, filesystem: Filesystem) {
  const root = stateMutationRoot(metadata)
  const contentRoot = metadata.standard ? path.dirname(metadata.contentPath) : root
  const markerRoot = metadata.standard ? path.dirname(metadata.markerPath) : root
  const disabled = disabledRoot(root, metadata.current)
  if (metadata.operation === "enable") {
    await mkdir(root, disabled, filesystem)
    if (
      !(await exists(path.join(disabled, metadata.current.contentRelpath), filesystem)) &&
      (await contentMatches(contentRoot, metadata.contentPath, metadata.current, filesystem))
    ) {
      await writeStateMutationPhase(metadata, "restoring-current-content", filesystem)
      await moveAcross(contentRoot, root, metadata.contentPath, path.join(disabled, metadata.current.contentRelpath), filesystem)
    }
    const active = await readMarker(markerRoot, metadata.markerPath, filesystem)
    if (!(await exists(path.join(disabled, ".ycoding-project-artifact.json"), filesystem)) && active?.versionID === metadata.current.versionID) {
      await writeStateMutationPhase(metadata, "restoring-current-marker", filesystem)
      await moveAcross(markerRoot, root, metadata.markerPath, path.join(disabled, ".ycoding-project-artifact.json"), filesystem)
    }
    await requireCompleteLayout(
      root,
      path.join(disabled, metadata.current.contentRelpath),
      root,
      path.join(disabled, ".ycoding-project-artifact.json"),
      metadata.current,
      filesystem,
    )
    if ((await exists(metadata.contentPath, filesystem)) || (await exists(metadata.markerPath, filesystem))) {
      throw failure("ReconciliationRequired")
    }
    return
  }
  if (metadata.operation === "rollback" && metadata.target) {
    const targetRoot = versionRoot(root, metadata.target)
    await mkdir(root, targetRoot, filesystem)
    if (
      !(await exists(versionContentPath(root, metadata.target), filesystem)) &&
      (await contentMatches(contentRoot, metadata.contentPath, metadata.target, filesystem))
    ) {
      await writeStateMutationPhase(metadata, "restoring-target-content", filesystem)
      await moveAcross(contentRoot, root, metadata.contentPath, versionContentPath(root, metadata.target), filesystem)
    }
    const active = await readMarker(markerRoot, metadata.markerPath, filesystem)
    if (!(await exists(versionMarkerPath(root, metadata.target), filesystem)) && active?.versionID === metadata.target.versionID) {
      await writeStateMutationPhase(metadata, "restoring-target-marker", filesystem)
      await moveAcross(markerRoot, root, metadata.markerPath, versionMarkerPath(root, metadata.target), filesystem)
    }
    await requireCompleteLayout(
      root,
      versionContentPath(root, metadata.target),
      root,
      versionMarkerPath(root, metadata.target),
      metadata.target,
      filesystem,
    )
  }
  if (
    !(await exists(metadata.contentPath, filesystem)) &&
    (await exists(path.join(disabled, metadata.current.contentRelpath), filesystem))
  ) {
    await writeStateMutationPhase(metadata, "restoring-current-content", filesystem)
    await moveAcross(root, contentRoot, path.join(disabled, metadata.current.contentRelpath), metadata.contentPath, filesystem)
  }
  if (
    !(await exists(metadata.markerPath, filesystem)) &&
    (await exists(path.join(disabled, ".ycoding-project-artifact.json"), filesystem))
  ) {
    await writeStateMutationPhase(metadata, "restoring-current-marker", filesystem)
    await moveAcross(root, markerRoot, path.join(disabled, ".ycoding-project-artifact.json"), metadata.markerPath, filesystem)
  }
  await requireCompleteLayout(
    contentRoot,
    metadata.contentPath,
    markerRoot,
    metadata.markerPath,
    metadata.current,
    filesystem,
  )
  await remove(root, disabled, filesystem, true)
}

async function requireAvailableState(metadata: StateMutationMetadata, filesystem: Filesystem) {
  const root = stateMutationRoot(metadata)
  const contentRoot = metadata.standard ? path.dirname(metadata.contentPath) : root
  const markerRoot = metadata.standard ? path.dirname(metadata.markerPath) : root
  const disabled = disabledRoot(root, metadata.current)
  if (metadata.operation === "disable") {
    await requireCompleteLayout(
      root,
      path.join(disabled, metadata.current.contentRelpath),
      root,
      path.join(disabled, ".ycoding-project-artifact.json"),
      metadata.current,
      filesystem,
    )
    if ((await exists(metadata.contentPath, filesystem)) || (await exists(metadata.markerPath, filesystem))) {
      throw failure("ReconciliationRequired")
    }
    return
  }
  const expected = metadata.operation === "rollback" ? metadata.target : metadata.current
  if (!expected) throw failure("ReconciliationRequired")
  await requireCompleteLayout(contentRoot, metadata.contentPath, markerRoot, metadata.markerPath, expected, filesystem)
  if (metadata.operation === "rollback") {
    await requireCompleteLayout(
      root,
      path.join(disabled, metadata.current.contentRelpath),
      root,
      path.join(disabled, ".ycoding-project-artifact.json"),
      metadata.current,
      filesystem,
    )
  }
}

async function requireCompleteLayout(
  contentRoot: string,
  contentPath: string,
  markerRoot: string,
  markerPath: string,
  expected: Marker,
  filesystem: Filesystem,
) {
  const stored = await readMarker(markerRoot, markerPath, filesystem)
  if (
    !stored ||
    stored.versionID !== expected.versionID ||
    stored.contentDigest !== expected.contentDigest ||
    !sameOwnership(stored, expected) ||
    !(await contentMatches(contentRoot, contentPath, stored, filesystem))
  ) {
    throw failure("OwnershipMismatch")
  }
}

function stateMutationLocation(input: StateMutationInput) {
  if (input.contentPath !== undefined || input.markerPath !== undefined) {
    if (!input.contentPath || !input.markerPath) throw failure("InvalidArtifact")
    return {
      contentPath: input.contentPath,
      markerPath: input.markerPath,
      contentRoot: path.dirname(input.contentPath),
      markerRoot: path.dirname(input.markerPath),
      standard: true,
    }
  }
  return {
    contentPath: activeContentPath(input.root, input.current.kind, input.current.id),
    markerPath: activeMarkerPath(input.root, input.current.kind, input.current.id),
    contentRoot: input.root,
    markerRoot: input.root,
    standard: false,
  }
}

function stateMutationMatches(input: StateMutationInput, metadata: StateMutationMetadata) {
  const location = stateMutationLocation(input)
  return (
    metadata.operationID === input.operationID &&
    metadata.operation === input.operation &&
    metadata.current.versionID === input.current.versionID &&
    metadata.current.contentDigest === input.current.contentDigest &&
    sameOwnership(metadata.current, input.current) &&
    metadata.target?.versionID === input.target?.versionID &&
    metadata.target?.contentDigest === input.target?.contentDigest &&
    (metadata.target === undefined || input.target === undefined || sameOwnership(metadata.target, input.target)) &&
    metadata.contentPath === location.contentPath &&
    metadata.markerPath === location.markerPath &&
    metadata.standard === location.standard &&
    metadata.context === input.context
  )
}

function stateMutationInput(metadata: StateMutationMetadata): StateMutationInput {
  return {
    root: stateMutationRoot(metadata),
    operationID: metadata.operationID,
    operation: metadata.operation,
    current: metadata.current,
    ...(metadata.target ? { target: metadata.target } : {}),
    ...(metadata.standard
      ? { contentPath: metadata.contentPath, markerPath: metadata.markerPath }
      : {}),
    ...(metadata.context === undefined ? {} : { context: metadata.context }),
  }
}

function validStateMutationMetadata(root: string, metadata: StateMutationMetadata) {
  if (
    !validOperationID(metadata.operationID) ||
    metadata.stageRoot !== path.join(root, "staging", metadata.operationID) ||
    metadata.current.contentRelpath !== relativeContentPath(metadata.current.kind, metadata.current.id) ||
    (metadata.operation === "rollback") !== (metadata.target !== undefined) ||
    (metadata.target !== undefined &&
      (!sameOwnership(metadata.current, metadata.target) ||
        metadata.target.versionID === metadata.current.versionID ||
        metadata.target.contentRelpath !== relativeContentPath(metadata.target.kind, metadata.target.id)))
  ) {
    return false
  }
  if (!metadata.standard) {
    return (
      metadata.contentPath === activeContentPath(root, metadata.current.kind, metadata.current.id) &&
      metadata.markerPath === activeMarkerPath(root, metadata.current.kind, metadata.current.id)
    )
  }
  return validStandardPaths(metadata.current.kind, metadata.current.id, metadata.contentPath, metadata.markerPath)
}

function stateMutationRoot(metadata: StateMutationMetadata) {
  return path.dirname(path.dirname(metadata.stageRoot))
}

function stateMutationJournalPath(stageRoot: string) {
  return path.join(stageRoot, ".ycoding-state-operation.json")
}

async function writeStateMutationPhase(
  metadata: StateMutationMetadata,
  phase: StateMutationPhase,
  filesystem: Filesystem,
) {
  const value = StateMutationMetadata.make({ ...metadata, phase })
  await replaceFile(
    stateMutationRoot(metadata),
    stateMutationJournalPath(metadata.stageRoot),
    encodeStateMutationMetadata(value),
    filesystem,
  )
  return value
}

async function readStateMutationJournal(root: string, stageRoot: string, filesystem: Filesystem) {
  try {
    return decodeStateMutationMetadata(await readText(root, stateMutationJournalPath(stageRoot), filesystem))
  } catch {
    return undefined
  }
}

interface StandardTarget {
  readonly contentPath: string
  readonly markerPath: string
}

interface LayoutEntry {
  readonly layout: "active" | "version" | "disabled"
  readonly source: string
  readonly content: string
  readonly marker: string
  readonly contentRoot: string
  readonly markerRoot: string
  readonly stored: Marker
}

async function trashUnsafe(input: TrashInput, filesystem: Filesystem, target?: StandardTarget) {
  const scope = await scopeOwnership(input.root, filesystem)
  if (!sameScope(input.marker, scope)) throw failure("OwnershipMismatch")
  const trash = trashRoot(input.root, input.deletionID)
  if (await exists(trash, filesystem)) throw failure("DestinationExists")
  const entries = await collectLayouts(input.root, input.marker, filesystem, target)
  if (!entries.length) throw failure("OwnershipMismatch")
  const selected = entries.find((entry) => entry.stored.versionID === input.marker.versionID)
  if (
    !selected ||
    selected.stored.contentDigest !== input.marker.contentDigest ||
    selected.stored.contentRelpath !== input.marker.contentRelpath
  ) {
    throw failure("OwnershipMismatch")
  }
  const manifestEntries = entries.map((entry) =>
    TrashManifestEntry.make({
      layout: entry.layout,
      versionID: entry.stored.versionID,
      source: entry.source,
      content: entry.content,
      marker: entry.marker,
      contentDigest: entry.stored.contentDigest,
      contentRelpath: entry.stored.contentRelpath,
    }),
  )
  const manifest = TrashManifest.make({
    schema: 1,
    phase: "trashing",
    deletionID: input.deletionID,
    scopeID: input.marker.scopeID,
    storageID: input.marker.storageID,
    kind: input.marker.kind,
    id: input.marker.id,
    priorStage: input.priorStage ?? "active",
    deletedAt: input.deletedAt ?? Date.now(),
    entryCount: manifestEntries.length,
    entriesDigest: manifestEntriesDigest(manifestEntries),
    standard: !!target,
    entries: manifestEntries,
  })
  await mkdir(input.root, trash, filesystem)
  await write(
    input.root,
    trashManifestPath(input.root, input.deletionID),
    encodeTrashManifest(manifest),
    filesystem,
    "wx",
  )
  try {
    for (const entry of entries) await moveLayoutToTrash(input.root, input.deletionID, entry, filesystem)
    await writeTrashPhase(input.root, manifest, "trashed", filesystem)
  } catch (cause) {
    await restoreManifestEntries(input.root, manifest, filesystem)
    await remove(input.root, trash, filesystem, true)
    throw cause
  }
}

async function restoreUnsafe(input: TrashInput, filesystem: Filesystem, target?: StandardTarget) {
  const manifest = await loadManifest(input, filesystem, target)
  if (manifest.standard && !target) throw failure("OwnershipMismatch")
  if (manifest.phase !== "trashed") throw failure("ReconciliationRequired")
  for (const entry of manifest.entries) {
    if ((await exists(entry.content, filesystem)) || (await exists(entry.marker, filesystem)))
      throw failure("DestinationExists")
  }
  await writeTrashPhase(input.root, manifest, "restoring", filesystem)
  try {
    await restoreManifestEntries(input.root, { ...manifest, phase: "restoring" }, filesystem)
    await remove(input.root, trashRoot(input.root, input.deletionID), filesystem, true)
  } catch (cause) {
    await returnManifestEntriesToTrash(input.root, manifest, filesystem)
    await writeTrashPhase(input.root, manifest, "trashed", filesystem)
    throw cause
  }
}

async function loadManifest(input: TrashInput, filesystem: Filesystem, target?: StandardTarget) {
  const manifest = await decodeTrash(input.root, input.deletionID, filesystem)
  if (manifest.deletionID !== input.deletionID) throw failure("OwnershipMismatch")
  await validateManifest(input.root, manifest, input.marker, filesystem, target)
  const selected = manifest.entries.find((entry) => entry.versionID === input.marker.versionID)
  if (
    !selected ||
    selected.contentDigest !== input.marker.contentDigest ||
    selected.contentRelpath !== input.marker.contentRelpath
  ) {
    throw failure("OwnershipMismatch")
  }
  return manifest
}

async function collectLayouts(root: string, marker: Marker, filesystem: Filesystem, target?: StandardTarget) {
  const activeContent = target?.contentPath ?? activeContentPath(root, marker.kind, marker.id)
  const activeMarker = target?.markerPath ?? activeMarkerPath(root, marker.kind, marker.id)
  const activeContentRoot = target ? path.dirname(target.contentPath) : root
  const activeMarkerRoot = target ? path.dirname(target.markerPath) : root
  const values: LayoutEntry[] = []
  if ((await exists(activeContent, filesystem)) || (await exists(activeMarker, filesystem))) {
    const stored = await readMarker(activeMarkerRoot, activeMarker, filesystem)
    if (
      !stored ||
      !sameOwnership(stored, marker) ||
      !(await contentMatches(activeContentRoot, activeContent, stored, filesystem))
    ) {
      throw failure("OwnershipMismatch")
    }
    values.push({
      layout: "active",
      source: target ? path.dirname(target.contentPath) : root,
      content: activeContent,
      marker: activeMarker,
      contentRoot: activeContentRoot,
      markerRoot: activeMarkerRoot,
      stored,
    })
  }
  for (const [layout, directory] of [
    ["version", path.join(root, "versions", marker.kind, marker.id)],
    ["disabled", path.join(root, "disabled", marker.kind, marker.id)],
  ] as const) {
    const entries = await filesystem.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure("OwnershipMismatch")
      const source = path.join(directory, entry.name)
      const stored = await readMarker(root, path.join(source, ".ycoding-project-artifact.json"), filesystem)
      if (
        !stored ||
        stored.versionID !== entry.name ||
        !sameOwnership(stored, marker) ||
        !(await contentMatches(root, path.join(source, stored.contentRelpath), stored, filesystem))
      ) {
        throw failure("OwnershipMismatch")
      }
      values.push({
        layout,
        source,
        content: path.join(source, stored.contentRelpath),
        marker: path.join(source, ".ycoding-project-artifact.json"),
        contentRoot: root,
        markerRoot: root,
        stored,
      })
    }
  }
  const keys = values.map((entry) => entry.stored.versionID)
  if (new Set(keys).size !== keys.length) throw failure("OwnershipMismatch")
  return values.toSorted((a, b) =>
    `${a.layout}:${a.stored.versionID}`.localeCompare(`${b.layout}:${b.stored.versionID}`),
  )
}

async function moveLayoutToTrash(
  root: string,
  deletionID: ProjectArtifact.DeletionID,
  entry: LayoutEntry,
  filesystem: Filesystem,
) {
  const destination = trashEntryRoot(root, deletionID, entry.layout, entry.stored.versionID)
  await mkdir(root, destination, filesystem)
  await moveAcross(
    entry.contentRoot,
    root,
    entry.content,
    path.join(destination, entry.stored.contentRelpath),
    filesystem,
  )
  await moveAcross(
    entry.markerRoot,
    root,
    entry.marker,
    path.join(destination, ".ycoding-project-artifact.json"),
    filesystem,
  )
}

async function restoreManifestEntries(root: string, manifest: TrashManifest, filesystem: Filesystem) {
  for (const entry of manifest.entries) {
    const source = trashEntryRoot(root, manifest.deletionID, entry.layout, entry.versionID)
    const trashContent = path.join(source, entry.contentRelpath)
    const trashMarker = path.join(source, ".ycoding-project-artifact.json")
    if (!(await exists(entry.content, filesystem)) && (await exists(trashContent, filesystem))) {
      await moveAcross(root, entryContentRoot(root, manifest, entry), trashContent, entry.content, filesystem)
    }
    if (!(await exists(entry.marker, filesystem)) && (await exists(trashMarker, filesystem))) {
      await moveAcross(root, entryMarkerRoot(root, manifest, entry), trashMarker, entry.marker, filesystem)
    }
    const stored = await readMarker(entryMarkerRoot(root, manifest, entry), entry.marker, filesystem)
    if (
      !stored ||
      stored.versionID !== entry.versionID ||
      stored.contentDigest !== entry.contentDigest ||
      !sameOwnership(stored, manifest) ||
      !(await contentMatches(entryContentRoot(root, manifest, entry), entry.content, stored, filesystem))
    ) {
      throw failure("ReconciliationRequired")
    }
  }
}

async function returnManifestEntriesToTrash(root: string, manifest: TrashManifest, filesystem: Filesystem) {
  for (const entry of manifest.entries.toReversed()) {
    const destination = trashEntryRoot(root, manifest.deletionID, entry.layout, entry.versionID)
    await mkdir(root, destination, filesystem)
    const trashMarker = path.join(destination, ".ycoding-project-artifact.json")
    const trashContent = path.join(destination, entry.contentRelpath)
    if ((await exists(entry.marker, filesystem)) && !(await exists(trashMarker, filesystem))) {
      await moveAcross(entryMarkerRoot(root, manifest, entry), root, entry.marker, trashMarker, filesystem)
    }
    if ((await exists(entry.content, filesystem)) && !(await exists(trashContent, filesystem))) {
      await moveAcross(entryContentRoot(root, manifest, entry), root, entry.content, trashContent, filesystem)
    }
  }
}

function commitLocation(input: CommitInput | StandardCommitInput) {
  if ("contentPath" in input) {
    return {
      contentPath: input.contentPath,
      markerPath: input.markerPath,
      contentRoot: path.dirname(input.contentPath),
      markerRoot: path.dirname(input.markerPath),
      standard: true,
    }
  }
  return {
    contentPath: activeContentPath(input.root, input.marker.kind, input.marker.id),
    markerPath: activeMarkerPath(input.root, input.marker.kind, input.marker.id),
    contentRoot: input.root,
    markerRoot: input.root,
    standard: false,
  }
}

function commitContentRoot(prepared: PreparedCommit) {
  return prepared.metadata.standard ? path.dirname(prepared.metadata.contentPath) : prepared.input.root
}

function commitMarkerRoot(prepared: PreparedCommit) {
  return prepared.metadata.standard ? path.dirname(prepared.metadata.markerPath) : prepared.input.root
}

function commitJournalPath(stageRoot: string) {
  return path.join(stageRoot, ".ycoding-operation.json")
}

function validOperationID(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

async function writeCommitPhase(prepared: PreparedCommit, phase: CommitTransactionPhase, filesystem: Filesystem) {
  const metadata = CommitTransactionMetadata.make({ ...prepared.metadata, phase })
  await replaceFile(
    prepared.input.root,
    commitJournalPath(prepared.stage.root),
    encodeCommitTransactionMetadata(metadata),
    filesystem,
  )
  return metadata
}

async function readCommitJournal(root: string, stageRoot: string, filesystem: Filesystem) {
  try {
    return decodeCommitTransactionMetadata(await readText(root, commitJournalPath(stageRoot), filesystem))
  } catch {
    return undefined
  }
}

function preparedFromMetadata(
  root: string,
  metadata: CommitTransactionMetadata,
  input: CommitInput | StandardCommitInput = {
    root,
    marker: metadata.marker,
    content: "",
    expectedVersionID: metadata.previous?.versionID,
  },
): PreparedCommit {
  return {
    input,
    current: metadata.previous,
    stage: {
      root: metadata.stageRoot,
      content: path.join(metadata.stageRoot, metadata.marker.contentRelpath),
      marker: path.join(metadata.stageRoot, ".ycoding-project-artifact.json"),
    },
    metadata,
  }
}

async function pendingCommit(input: CommitInput | StandardCommitInput, filesystem: Filesystem) {
  const staging = path.join(input.root, "staging")
  const entries = await filesystem.readdir(staging, { withFileTypes: true }).catch(() => [])
  const location = commitLocation(input)
  const matches: PreparedCommit[] = []
  for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
    const stageRoot = path.join(staging, entry.name)
    const metadata = await readCommitJournal(input.root, stageRoot, filesystem)
    if (!metadata) {
      if (await exists(commitJournalPath(stageRoot), filesystem)) throw failure("ReconciliationRequired")
      continue
    }
    if (!validCommitMetadata(input.root, metadata)) throw failure("ReconciliationRequired")
    if (sameOwnership(metadata.marker, input.marker) && metadata.marker.versionID !== input.marker.versionID) {
      throw failure("VersionConflict")
    }
    if (
      metadata.marker.versionID !== input.marker.versionID ||
      metadata.marker.contentDigest !== input.marker.contentDigest ||
      !sameOwnership(metadata.marker, input.marker)
    ) {
      continue
    }
    if (
      metadata.stageRoot !== stageRoot ||
      metadata.operationID !== entry.name ||
      metadata.contentPath !== location.contentPath ||
      metadata.markerPath !== location.markerPath ||
      metadata.standard !== location.standard ||
      (input.operationID && metadata.operationID !== input.operationID)
    ) {
      throw failure("ReconciliationRequired")
    }
    matches.push(preparedFromMetadata(input.root, metadata, input))
  }
  if (matches.length > 1) throw failure("ReconciliationRequired")
  return matches[0]
}

function standardTarget(input: StandardTrashInput): StandardTarget {
  if (!validStandardPaths(input.marker.kind, input.marker.id, input.contentPath, input.markerPath)) {
    throw failure("OwnershipMismatch")
  }
  return { contentPath: input.contentPath, markerPath: input.markerPath }
}

function validCommitMetadata(root: string, metadata: CommitTransactionMetadata) {
  if (
    !validOperationID(metadata.operationID) ||
    metadata.stageRoot !== path.join(root, "staging", metadata.operationID) ||
    metadata.marker.contentRelpath !== relativeContentPath(metadata.marker.kind, metadata.marker.id) ||
    (metadata.previous !== undefined &&
      (!sameOwnership(metadata.previous, metadata.marker) ||
        metadata.previous.versionID === metadata.marker.versionID ||
        metadata.previous.contentRelpath !== relativeContentPath(metadata.previous.kind, metadata.previous.id)))
  ) {
    return false
  }
  if (!metadata.standard) {
    return (
      metadata.contentPath === activeContentPath(root, metadata.marker.kind, metadata.marker.id) &&
      metadata.markerPath === activeMarkerPath(root, metadata.marker.kind, metadata.marker.id)
    )
  }
  return validStandardPaths(metadata.marker.kind, metadata.marker.id, metadata.contentPath, metadata.markerPath)
}

function commitTransactionRoot(metadata: CommitTransactionMetadata) {
  return path.dirname(path.dirname(metadata.stageRoot))
}

function sameCommitTransaction(left: CommitTransactionMetadata, right: CommitTransactionMetadata) {
  return (
    left.operationID === right.operationID &&
    sameMarker(left.marker, right.marker) &&
    ((left.previous === undefined && right.previous === undefined) ||
      (left.previous !== undefined && right.previous !== undefined && sameMarker(left.previous, right.previous))) &&
    left.stageRoot === right.stageRoot &&
    left.contentPath === right.contentPath &&
    left.markerPath === right.markerPath &&
    left.standard === right.standard
  )
}

function sameMarker(left: Marker, right: Marker) {
  return (
    left.scopeID === right.scopeID &&
    left.storageID === right.storageID &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.versionID === right.versionID &&
    left.contentDigest === right.contentDigest &&
    left.contentRelpath === right.contentRelpath
  )
}

async function requireAvailableCommit(metadata: CommitTransactionMetadata, filesystem: Filesystem) {
  const root = commitTransactionRoot(metadata)
  const contentRoot = metadata.standard ? path.dirname(metadata.contentPath) : root
  const markerRoot = metadata.standard ? path.dirname(metadata.markerPath) : root
  await requireCompleteLayout(
    contentRoot,
    metadata.contentPath,
    markerRoot,
    metadata.markerPath,
    metadata.marker,
    filesystem,
  )
}

function validStandardPaths(kind: ProjectArtifact.Kind, id: string, contentPath: string, markerPath: string) {
  if (!path.isAbsolute(contentPath) || !path.isAbsolute(markerPath)) return false
  if (kind === "skill") {
    return (
      path.basename(path.dirname(contentPath)) === id &&
      path.basename(contentPath) === "SKILL.md" &&
      path.dirname(markerPath) === path.dirname(contentPath) &&
      path.basename(markerPath) === ".ycoding-project-artifact.json"
    )
  }
  const extension = kind === "plugin" ? "ts" : "md"
  return (
    path.dirname(markerPath) === path.dirname(contentPath) &&
    path.basename(contentPath) === `${id}.${extension}` &&
    path.basename(markerPath) === `.${id}.ycoding-project-artifact.json`
  )
}

function trashManifestPath(root: string, deletionID: ProjectArtifact.DeletionID) {
  return path.join(trashRoot(root, deletionID), ".ycoding-trash.json")
}

function trashEntryRoot(
  root: string,
  deletionID: ProjectArtifact.DeletionID,
  layout: TrashManifestEntry["layout"],
  versionID: ProjectArtifact.VersionID,
) {
  return path.join(trashRoot(root, deletionID), "entries", layout, versionID)
}

function manifestEntriesDigest(entries: readonly TrashManifestEntry[]) {
  return ProjectArtifact.Digest.make(Hash.sha256(JSON.stringify(entries)))
}

async function writeTrashPhase(
  root: string,
  manifest: TrashManifest,
  phase: TrashManifest["phase"],
  filesystem: Filesystem,
) {
  const value = TrashManifest.make({ ...manifest, phase })
  await replaceFile(root, trashManifestPath(root, manifest.deletionID), encodeTrashManifest(value), filesystem)
  return value
}

async function decodeTrash(root: string, deletionID: ProjectArtifact.DeletionID, filesystem: Filesystem) {
  try {
    return decodeTrashManifest(await readText(root, trashManifestPath(root, deletionID), filesystem))
  } catch {
    throw failure("OwnershipMismatch")
  }
}

async function validateManifest(
  root: string,
  manifest: TrashManifest,
  expected: Pick<Marker, "scopeID" | "storageID" | "kind" | "id">,
  filesystem: Filesystem,
  target?: StandardTarget,
) {
  if (
    manifest.deletionID === "" ||
    !sameOwnership(manifest, expected) ||
    !Number.isSafeInteger(manifest.deletedAt) ||
    manifest.deletedAt < 0 ||
    !Number.isSafeInteger(manifest.entryCount) ||
    manifest.entryCount <= 0 ||
    manifest.entryCount !== manifest.entries.length ||
    manifest.entriesDigest !== manifestEntriesDigest(manifest.entries) ||
    (manifest.standard !== !!target && target !== undefined)
  ) {
    throw failure("OwnershipMismatch")
  }
  const keys = manifest.entries.map((entry) => `${entry.layout}:${entry.versionID}`)
  const versions = manifest.entries.map((entry) => entry.versionID)
  if (new Set(keys).size !== keys.length || new Set(versions).size !== versions.length)
    throw failure("OwnershipMismatch")
  for (const entry of manifest.entries) validateManifestEntryPath(root, manifest, entry, target)
  const storedKeys = await trashEntryKeys(root, manifest.deletionID, filesystem)
  if (storedKeys.some((key) => !keys.includes(key))) throw failure("OwnershipMismatch")
  if (manifest.phase !== "trashed") return
  if (storedKeys.length !== keys.length || storedKeys.some((key, index) => key !== keys.toSorted()[index])) {
    throw failure("OwnershipMismatch")
  }
  for (const entry of manifest.entries) {
    const source = trashEntryRoot(root, manifest.deletionID, entry.layout, entry.versionID)
    const stored = await readMarker(root, path.join(source, ".ycoding-project-artifact.json"), filesystem)
    if (
      !stored ||
      stored.versionID !== entry.versionID ||
      stored.contentDigest !== entry.contentDigest ||
      stored.contentRelpath !== entry.contentRelpath ||
      !sameOwnership(stored, manifest) ||
      !(await contentMatches(root, path.join(source, entry.contentRelpath), stored, filesystem))
    ) {
      throw failure("OwnershipMismatch")
    }
  }
}

function validateManifestEntryPath(
  root: string,
  manifest: TrashManifest,
  entry: TrashManifestEntry,
  target?: StandardTarget,
) {
  if (entry.contentRelpath !== relativeContentPath(manifest.kind, manifest.id)) throw failure("OwnershipMismatch")
  if (entry.layout === "active" && manifest.standard) {
    if (!validStandardEntry(manifest, entry)) throw failure("OwnershipMismatch")
    if (target && (entry.content !== target.contentPath || entry.marker !== target.markerPath)) {
      throw failure("OwnershipMismatch")
    }
    return
  }
  const source =
    entry.layout === "active"
      ? root
      : entry.layout === "version"
        ? versionRoot(root, { kind: manifest.kind, id: manifest.id, versionID: entry.versionID })
        : disabledRoot(root, { kind: manifest.kind, id: manifest.id, versionID: entry.versionID })
  const content =
    entry.layout === "active"
      ? activeContentPath(root, manifest.kind, manifest.id)
      : path.join(source, entry.contentRelpath)
  const markerPath =
    entry.layout === "active"
      ? activeMarkerPath(root, manifest.kind, manifest.id)
      : path.join(source, ".ycoding-project-artifact.json")
  if (entry.source !== source || entry.content !== content || entry.marker !== markerPath)
    throw failure("OwnershipMismatch")
}

function validStandardEntry(manifest: TrashManifest, entry: TrashManifestEntry) {
  return (
    entry.source === path.dirname(entry.content) &&
    validStandardPaths(manifest.kind, manifest.id, entry.content, entry.marker)
  )
}

async function trashEntryKeys(root: string, deletionID: ProjectArtifact.DeletionID, filesystem: Filesystem) {
  const values: string[] = []
  const entriesRoot = path.join(trashRoot(root, deletionID), "entries")
  const layouts = await filesystem.readdir(entriesRoot, { withFileTypes: true }).catch(() => [])
  if (
    layouts.some(
      (entry) =>
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        (entry.name !== "active" && entry.name !== "version" && entry.name !== "disabled"),
    )
  ) {
    throw failure("OwnershipMismatch")
  }
  for (const layout of ["active", "version", "disabled"] as const) {
    const directory = path.join(entriesRoot, layout)
    const entries = await filesystem.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure("OwnershipMismatch")
      values.push(`${layout}:${entry.name}`)
    }
  }
  return values.toSorted()
}

function entryContentRoot(root: string, manifest: TrashManifest, entry: TrashManifestEntry) {
  return manifest.standard && entry.layout === "active" ? path.dirname(entry.content) : root
}

function entryMarkerRoot(root: string, manifest: TrashManifest, entry: TrashManifestEntry) {
  return manifest.standard && entry.layout === "active" ? path.dirname(entry.marker) : root
}

async function replaceFile(root: string, file: string, content: string, filesystem: Filesystem) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await write(root, temporary, content, filesystem, "wx")
  try {
    await move(root, temporary, file, filesystem, true)
  } catch (cause) {
    await remove(root, temporary, filesystem)
    throw cause
  }
}

async function requireOwnedActive(root: string, expected: Marker, filesystem: Filesystem) {
  const scope = await scopeOwnership(root, filesystem)
  const current = await readMarker(root, activeMarkerPath(root, expected.kind, expected.id), filesystem)
  if (
    !current ||
    !sameOwnership(current, expected) ||
    !sameScope(current, scope) ||
    !(await contentMatches(root, activeContentPath(root, current.kind, current.id), current, filesystem))
  ) {
    throw failure("OwnershipMismatch")
  }
  return current
}

function reconcileStaging(root: string, scope: ScopeOwnership, filesystem: Filesystem) {
  return Effect.gen(function* () {
    const staging = path.join(root, "staging")
    const entries = yield* Effect.promise(() => filesystem.readdir(staging, { withFileTypes: true }).catch(() => []))
    for (const entry of entries
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      const operation = path.join(staging, entry.name)
      const identity = yield* Effect.promise(() => stagingEntryIdentity(root, operation, entry.name, scope, filesystem))
      const recovery = Effect.tryPromise({
        try: () => reconcileStagingEntry(root, operation, entry.name, scope, identity, filesystem),
        catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
      })
      if (!identity) {
        yield* recovery
        continue
      }
      yield* withArtifactLockOnly({ root, marker: identity }, recovery)
    }
  })
}

async function stagingEntryIdentity(
  root: string,
  operation: string,
  operationID: string,
  scope: ScopeOwnership,
  filesystem: Filesystem,
) {
  const state = await readStateMutationJournal(root, operation, filesystem)
  if (state) {
    if (
      sameScope(state.current, scope) &&
      validStateMutationMetadata(root, state) &&
      state.stageRoot === operation &&
      state.operationID === operationID
    ) {
      return artifactIdentity(state.current)
    }
    return undefined
  }
  if (await exists(stateMutationJournalPath(operation), filesystem)) return undefined
  const metadata = await readCommitJournal(root, operation, filesystem)
  if (metadata) {
    if (
      sameScope(metadata.marker, scope) &&
      validCommitMetadata(root, metadata) &&
      metadata.stageRoot === operation &&
      metadata.operationID === operationID
    ) {
      return artifactIdentity(metadata.marker)
    }
    return undefined
  }
  if (await exists(commitJournalPath(operation), filesystem)) return undefined
  const value = await readMarker(root, path.join(operation, ".ycoding-project-artifact.json"), filesystem)
  return value && sameScope(value, scope) ? artifactIdentity(value) : undefined
}

async function reconcileStagingEntry(
  root: string,
  operation: string,
  operationID: string,
  scope: ScopeOwnership,
  expected: ArtifactIdentity | undefined,
  filesystem: Filesystem,
) {
  const state = await readStateMutationJournal(root, operation, filesystem)
  if (!state && (await exists(stateMutationJournalPath(operation), filesystem))) {
    throw failure("ReconciliationRequired")
  }
  if (state) {
    if (
      !expected ||
      !sameArtifactIdentity(state.current, expected) ||
      !sameScope(state.current, scope) ||
      !validStateMutationMetadata(root, state) ||
      state.stageRoot !== operation ||
      state.operationID !== operationID
    ) {
      throw failure("ReconciliationRequired")
    }
    await reconcileStateMutation(state, filesystem)
    return
  }
  const metadata = await readCommitJournal(root, operation, filesystem)
  if (!metadata && (await exists(commitJournalPath(operation), filesystem))) throw failure("ReconciliationRequired")
  if (metadata) {
    if (
      !expected ||
      !sameArtifactIdentity(metadata.marker, expected) ||
      !sameScope(metadata.marker, scope) ||
      !validCommitMetadata(root, metadata) ||
      metadata.stageRoot !== operation ||
      metadata.operationID !== operationID
    ) {
      throw failure("ReconciliationRequired")
    }
    await reconcilePreparedCommit(preparedFromMetadata(root, metadata), filesystem)
    return
  }
  const stagedMarker = path.join(operation, ".ycoding-project-artifact.json")
  const value = await readMarker(root, stagedMarker, filesystem)
  if (!value || !sameScope(value, scope)) {
    if (expected) throw failure("ReconciliationRequired")
    await remove(root, operation, filesystem, true)
    return
  }
  if (!expected || !sameArtifactIdentity(value, expected)) throw failure("ReconciliationRequired")
  const staged = path.join(operation, value.contentRelpath)
  const activeContent = activeContentPath(root, value.kind, value.id)
  const activeMarker = activeMarkerPath(root, value.kind, value.id)
  const active = await readMarker(root, activeMarker, filesystem)
  if (
    !active &&
    (await contentMatches(root, activeContent, value, filesystem)) &&
    (await exists(stagedMarker, filesystem))
  ) {
    await move(root, stagedMarker, activeMarker, filesystem)
    await remove(root, operation, filesystem, true)
    return
  }
  if (
    !active &&
    !(await exists(activeContent, filesystem)) &&
    (await contentMatches(root, staged, value, filesystem))
  ) {
    await move(root, staged, activeContent, filesystem)
    await move(root, stagedMarker, activeMarker, filesystem)
  }
  await remove(root, operation, filesystem, true)
}

async function reconcileStateMutation(metadata: StateMutationMetadata, filesystem: Filesystem) {
  const root = stateMutationRoot(metadata)
  if (metadata.phase === "committed") {
    await requireAvailableState(metadata, filesystem)
    await remove(root, metadata.stageRoot, filesystem, true)
    return
  }
  if (metadata.phase === "finalizing") {
    await requireAvailableState(metadata, filesystem)
    return
  }
  if (metadata.phase === "available") {
    await requireAvailableState(metadata, filesystem)
    return
  }
  await compensateStateMutation(metadata, filesystem)
  await remove(root, metadata.stageRoot, filesystem, true)
}

async function reconcilePreparedCommit(prepared: PreparedCommit, filesystem: Filesystem) {
  if (
    prepared.metadata.phase === "prepared" ||
    prepared.metadata.phase === "reserved" ||
    prepared.metadata.phase === "archiving-content" ||
    prepared.metadata.phase === "archiving-marker" ||
    prepared.metadata.phase === "compensating" ||
    prepared.metadata.phase === "compensated"
  ) {
    await compensate(prepared, filesystem)
    await remove(prepared.input.root, prepared.stage.root, filesystem, true)
    return
  }
  if (prepared.metadata.phase === "finalizing") {
    await requireAvailableCommit(prepared.metadata, filesystem)
    return
  }
  if (prepared.metadata.phase === "committed") {
    await requireAvailableCommit(prepared.metadata, filesystem)
    await remove(prepared.input.root, prepared.stage.root, filesystem, true)
    return
  }
  const content = prepared.metadata.contentPath
  const markerPath = prepared.metadata.markerPath
  if (!(await contentMatches(commitContentRoot(prepared), content, prepared.input.marker, filesystem))) {
    if (!(await contentMatches(prepared.input.root, prepared.stage.content, prepared.input.marker, filesystem))) {
      throw failure("ReconciliationRequired")
    }
    await moveAcross(prepared.input.root, commitContentRoot(prepared), prepared.stage.content, content, filesystem)
  }
  const active = await readMarker(commitMarkerRoot(prepared), markerPath, filesystem)
  if (active?.versionID !== prepared.input.marker.versionID) {
    const staged = await readMarker(prepared.input.root, prepared.stage.marker, filesystem)
    if (!staged || staged.versionID !== prepared.input.marker.versionID) throw failure("ReconciliationRequired")
    if (await exists(markerPath, filesystem)) throw failure("ReconciliationRequired")
    await moveAcross(prepared.input.root, commitMarkerRoot(prepared), prepared.stage.marker, markerPath, filesystem)
  }
  const complete = await readMarker(commitMarkerRoot(prepared), markerPath, filesystem)
  if (
    !complete ||
    complete.versionID !== prepared.input.marker.versionID ||
    !sameOwnership(complete, prepared.input.marker) ||
    complete.contentRelpath !== prepared.input.marker.contentRelpath ||
    !(await contentMatches(commitContentRoot(prepared), content, complete, filesystem))
  ) {
    throw failure("ReconciliationRequired")
  }
  await writeCommitPhase(prepared, "available", filesystem)
}

function reconcileTrash(root: string, scope: ScopeOwnership, filesystem: Filesystem) {
  return Effect.gen(function* () {
    const directory = path.join(root, "trash")
    const entries = yield* Effect.promise(() => filesystem.readdir(directory, { withFileTypes: true }).catch(() => []))
    for (const entry of entries
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      const deletionID = ProjectArtifact.DeletionID.make(entry.name)
      const identity = yield* Effect.promise(() => trashEntryIdentity(root, deletionID, scope, filesystem))
      const recovery = Effect.tryPromise({
        try: () => reconcileTrashEntry(root, deletionID, scope, identity, filesystem),
        catch: (cause) => packageFailure(cause, "ReconciliationRequired"),
      })
      if (!identity) {
        yield* recovery
        continue
      }
      yield* withArtifactLockOnly({ root, marker: identity }, recovery)
    }
  })
}

async function trashEntryIdentity(
  root: string,
  deletionID: ProjectArtifact.DeletionID,
  scope: ScopeOwnership,
  filesystem: Filesystem,
) {
  try {
    const manifest = await decodeTrash(root, deletionID, filesystem)
    return sameScope(manifest, scope) && manifest.deletionID === deletionID ? artifactIdentity(manifest) : undefined
  } catch {
    return undefined
  }
}

async function reconcileTrashEntry(
  root: string,
  deletionID: ProjectArtifact.DeletionID,
  scope: ScopeOwnership,
  expected: ArtifactIdentity | undefined,
  filesystem: Filesystem,
) {
  const manifest = await decodeTrash(root, deletionID, filesystem)
  if (
    !expected ||
    !sameArtifactIdentity(manifest, expected) ||
    !sameScope(manifest, scope) ||
    manifest.deletionID !== deletionID
  ) {
    throw failure("ReconciliationRequired")
  }
  await validateManifest(root, manifest, manifest, filesystem)
  if (manifest.phase === "trashed") return
  await restoreManifestEntries(root, manifest, filesystem)
  await remove(root, trashRoot(root, deletionID), filesystem, true)
}

function validateExpectation(current: Marker | undefined, expected: ProjectArtifact.VersionID | undefined) {
  if (!current && expected) throw failure("VersionConflict")
  if (current && !expected) throw failure("ArtifactCollision")
  if (current && expected && current.versionID !== expected) throw failure("VersionConflict")
}

function lockKey(value: Pick<Marker, "scopeID" | "kind" | "id">) {
  return `project-artifact:${value.scopeID}:${value.kind}:${value.id}`
}

function artifactIdentity(value: ArtifactIdentity): ArtifactIdentity {
  return { scopeID: value.scopeID, kind: value.kind, id: value.id }
}

function sameArtifactIdentity(left: ArtifactIdentity, right: ArtifactIdentity) {
  return left.scopeID === right.scopeID && left.kind === right.kind && left.id === right.id
}

function relativeContentPath(kind: ProjectArtifact.Kind, id: string) {
  if (kind === "skill") return "SKILL.md"
  if (kind === "command" || kind === "agent") return `${id}.md`
  return `${id}.ts`
}

function trashRoot(root: string, deletionID: ProjectArtifact.DeletionID) {
  return path.join(root, "trash", deletionID)
}

function disabledRoot(root: string, value: Pick<Marker, "kind" | "id" | "versionID">) {
  return path.join(root, "disabled", value.kind, value.id, value.versionID)
}

function sameOwnership(
  left: Pick<Marker, "scopeID" | "storageID" | "kind" | "id">,
  right: Pick<Marker, "scopeID" | "storageID" | "kind" | "id">,
) {
  return (
    left.scopeID === right.scopeID &&
    left.storageID === right.storageID &&
    left.kind === right.kind &&
    left.id === right.id
  )
}

function sameScope(marker: Pick<Marker, "scopeID" | "storageID">, scope: ScopeOwnership) {
  return marker.scopeID === scope.scopeID && marker.storageID === scope.storageID
}

function isActiveMarkerPath(root: string, file: string, value: Marker) {
  return path.resolve(file) === path.resolve(activeMarkerPath(root, value.kind, value.id))
}

function activeMarkerIdentity(root: string, file: string, scope: ScopeOwnership): ArtifactIdentity | undefined {
  const relative = path.relative(path.join(root, "metadata"), file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  const parts = relative.split(path.sep)
  if (parts.length !== 2 || !parts[1]?.endsWith(".json")) return undefined
  const kind = parts[0]
  if (kind !== "skill" && kind !== "command" && kind !== "agent" && kind !== "plugin") return undefined
  const id = parts[1].slice(0, -5)
  if (!id) return undefined
  return { scopeID: scope.scopeID, kind, id: ProjectArtifact.ID.make(id) }
}

async function reconcileActiveMarker(
  root: string,
  file: string,
  scope: ScopeOwnership,
  expected: ArtifactIdentity,
  filesystem: Filesystem,
) {
  const identity = activeMarkerIdentity(root, file, scope)
  if (!identity || !sameArtifactIdentity(identity, expected)) throw failure("ReconciliationRequired")
  if (!(await exists(file, filesystem))) return undefined
  const value = await readMarker(root, file, filesystem)
  const ownedPath =
    !!value && sameArtifactIdentity(value, expected) && sameScope(value, scope) && isActiveMarkerPath(root, file, value)
  if (!value || !ownedPath || value.contentRelpath !== relativeContentPath(value.kind, value.id)) {
    await quarantine(root, file, value, filesystem, false)
    return undefined
  }
  const content = activeContentPath(root, value.kind, value.id)
  if (!(await contentMatches(root, content, value, filesystem))) {
    await quarantine(root, file, value, filesystem, true)
    return undefined
  }
  return value
}

function standardMarkerID(name: string) {
  const match = /^\.(.+)\.ycoding-project-artifact\.json$/.exec(name)
  return match?.[1]
}

function standardContentID(name: string) {
  return name.endsWith(".md") && !name.startsWith(".") ? name.slice(0, -3) : undefined
}

function standardContentPath(root: string, kind: "skill" | "command" | "agent", id: string) {
  if (kind === "skill") return path.join(root, id, "SKILL.md")
  return path.join(root, `${id}.md`)
}

function standardMarkerPath(root: string, kind: "skill" | "command" | "agent", id: string) {
  if (kind === "skill") return path.join(root, id, ".ycoding-project-artifact.json")
  return path.join(root, `.${id}.ycoding-project-artifact.json`)
}

interface ScopeOwnership {
  readonly scopeID: ProjectArtifact.ScopeID
  readonly storageID: ProjectArtifact.StorageID
}

async function scopeOwnership(root: string, filesystem: Filesystem): Promise<ScopeOwnership> {
  const value = await readJson(root, scopeMarkerPath(root), filesystem)
  if (!value || typeof value.scopeID !== "string" || typeof value.storageID !== "string")
    throw failure("OwnershipMismatch")
  return {
    scopeID: ProjectArtifact.ScopeID.make(value.scopeID),
    storageID: ProjectArtifact.StorageID.make(value.storageID),
  }
}

async function readMarker(root: string, file: string, filesystem: Filesystem) {
  try {
    return decodeMarker(await readText(root, file, filesystem))
  } catch {
    return undefined
  }
}

async function readJson(
  root: string,
  file: string,
  filesystem: Filesystem,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readText(root, file, filesystem))
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function contentMatches(root: string, file: string, value: Marker, filesystem: Filesystem) {
  try {
    return Hash.sha256(await readText(root, file, filesystem)) === value.contentDigest
  } catch {
    return false
  }
}

async function quarantine(
  root: string,
  markerPath: string,
  value: Marker | undefined,
  filesystem: Filesystem,
  includeContent: boolean,
) {
  const destination = path.join(
    root,
    "quarantine",
    value?.kind ?? "invalid",
    value?.id ?? randomUUID(),
    value?.versionID ?? randomUUID(),
  )
  await mkdir(root, destination, filesystem)
  if (await exists(markerPath, filesystem))
    await move(root, markerPath, path.join(destination, ".ycoding-project-artifact.json"), filesystem)
  if (value && includeContent) {
    const content = activeContentPath(root, value.kind, value.id)
    if (await exists(content, filesystem))
      await move(root, content, path.join(destination, value.contentRelpath), filesystem)
  }
}

async function walk(root: string, directory: string, filesystem: Filesystem): Promise<string[]> {
  await assertSafePath(root, directory, filesystem)
  const entries = await filesystem.readdir(directory, { withFileTypes: true }).catch(() => [])
  const values = await Promise.all(
    entries.map((entry) => {
      const item = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) return []
      if (entry.isDirectory()) return walk(root, item, filesystem)
      return entry.isFile() ? [item] : []
    }),
  )
  return values.flat()
}

async function readText(root: string, file: string, filesystem: Filesystem) {
  await assertSafePath(root, file, filesystem)
  await filesystem.beforeRead?.(file)
  return filesystem.readFile(file, "utf8")
}

async function exists(file: string, filesystem: Filesystem) {
  return filesystem.lstat(file).then(
    (info) => !info.isSymbolicLink(),
    () => false,
  )
}

async function mkdir(root: string, directory: string, filesystem: Filesystem) {
  const target = path.resolve(directory)
  const relative = path.relative(path.resolve(root), target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("OwnershipMismatch")
  const parts = relative ? relative.split(path.sep) : []
  let current = path.resolve(root)
  await assertSafePath(root, current, filesystem)
  for (const part of parts) {
    current = path.join(current, part)
    if (await exists(current, filesystem)) {
      await assertSafePath(root, current, filesystem)
      continue
    }
    await mutate(filesystem, { operation: "mkdir", root, path: current })
  }
}

async function write(root: string, file: string, content: string, filesystem: Filesystem, flag?: "wx") {
  await mkdir(root, path.dirname(file), filesystem)
  await mutate(filesystem, { operation: "write", root, path: file, content, flag })
}

async function move(root: string, source: string, destination: string, filesystem: Filesystem, replace = false) {
  await mkdir(root, path.dirname(destination), filesystem)
  await mutate(filesystem, {
    operation: "rename",
    sourceRoot: root,
    destinationRoot: root,
    source,
    destination,
    replace,
  })
}

async function moveAcross(
  sourceRoot: string,
  destinationRoot: string,
  source: string,
  destination: string,
  filesystem: Filesystem,
) {
  await mkdir(destinationRoot, path.dirname(destination), filesystem)
  await assertSafePath(sourceRoot, source, filesystem)
  await assertSafePath(destinationRoot, destination, filesystem)
  await mutate(filesystem, { operation: "rename", sourceRoot, destinationRoot, source, destination })
}

async function remove(root: string, target: string, filesystem: Filesystem, recursive = false) {
  if (!(await exists(target, filesystem))) return
  await mutate(filesystem, { operation: "remove", root, path: target, recursive })
}

async function mutate(filesystem: Filesystem, mutation: MutationRequest) {
  try {
    await executeMutation(filesystem, mutation)
  } catch (cause) {
    if (cause instanceof UnsafeMutationError) throw failure("OwnershipMismatch")
    throw cause
  }
}

async function assertSafePath(root: string, target: string, filesystem: Filesystem) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(target)
  const relative = path.relative(absoluteRoot, absoluteTarget)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("OwnershipMismatch")
  const rootInfo = await filesystem.lstat(absoluteRoot).catch(() => undefined)
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw failure("OwnershipMismatch")
  const canonicalRoot = await filesystem.realpath(absoluteRoot).catch(() => undefined)
  if (!canonicalRoot) throw failure("OwnershipMismatch")
  let current = absoluteRoot
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    const info = await filesystem.lstat(current).catch(() => undefined)
    if (!info) break
    if (info.isSymbolicLink()) throw failure("OwnershipMismatch")
    const canonical = await filesystem.realpath(current).catch(() => undefined)
    if (!canonical || (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))) {
      throw failure("OwnershipMismatch")
    }
  }
}

function failure(code: ProjectArtifact.ErrorCode) {
  return new Failure({ code, message: "Project Artifact package operation failed" })
}

function packageFailure(cause: unknown, fallback: ProjectArtifact.ErrorCode = "StorageUnavailable") {
  if (cause instanceof Failure) return cause
  if (cause instanceof UnsafeMutationError) return failure("OwnershipMismatch")
  return failure(fallback)
}
