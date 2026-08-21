export * as SessionContextState from "./context-state"

import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { and, eq, lte } from "drizzle-orm"
import { Cause, Context, Data, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { AbsolutePath } from "../schema"
import { ContextManifest } from "./context-manifest"
import { SessionErrors } from "./error"
import { SessionEvent } from "./event"
import type { SessionGuardrail } from "./guardrail"
import { InstructionState } from "./instruction-state"
import { SessionMessage } from "./message"
import { SessionProviderState } from "./provider-state"
import { SessionContinuation } from "./runner/continuation"
import { SessionSchema } from "./schema"
import { SessionSummaryToon } from "./summary-toon"
import {
  CompactionManifestBlobTable,
  SessionCompactionJobTable,
  SessionContextExclusionTable,
  SessionContextRevisionTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionTable,
} from "./sql"

type DatabaseService = Database.Interface["db"]
type LiveStateModule = Pick<typeof import("./live-state"), "captureDatabase" | "toProtectedState">

export interface Current {
  readonly status: "active" | "quarantined"
  readonly revision: number
  readonly manifestDigest?: string
  readonly coveredThrough?: ContextManifest.CoveredThrough
  readonly activatedEventID?: EventV2.ID
  readonly timeActivated?: number
  readonly errorCode?: string
}

interface ActivationBase {
  readonly sessionID: SessionSchema.ID
  readonly manifest: ContextManifest.Manifest
}

export type ActivationInput =
  | (ActivationBase & { readonly jobID: SessionCompaction.ID; readonly leaseOwner: string })
  | (ActivationBase & { readonly jobID?: never; readonly leaseOwner?: never })

export interface ActivationResult {
  readonly revision: number
  readonly manifestDigest: string
  readonly eventID: EventV2.ID
  readonly sequence: number
}

export type ModelSummary = ContextManifest.RollingSummary & {
  readonly manifestDigest: string
  readonly timeActivated: number
}

export type ActivationErrorCode =
  | "unknown_context"
  | "context_quarantined"
  | "stale_base_revision"
  | "boundary_changed"
  | "selector_mutation"
  | "protected_state_changed"
  | "invalid_manifest"
  | "job_conflict"

export class ActivationError extends Data.TaggedError("SessionContextState.ActivationError")<{
  readonly code: ActivationErrorCode
  readonly message: string
}> {}

export interface Interface {
  readonly current: (sessionID: SessionSchema.ID) => Effect.Effect<Current>
  readonly filter: (
    sessionID: SessionSchema.ID,
    messages: ReadonlyArray<SessionMessage.Info>,
  ) => Effect.Effect<ReadonlyArray<SessionMessage.Info>>
  readonly activate: (input: ActivationInput) => Effect.Effect<ActivationResult, ActivationError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionContextState") {}

const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const encodeAssistant = Schema.encodeSync(SessionMessage.Assistant)
const decodeManifestContent = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

export const initialize = Effect.fn("SessionContextState.initialize")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  timeCreated: number,
) {
  yield* db
    .insert(SessionContextRevisionTable)
    .values({ session_id: sessionID, revision: 0, time_created: timeCreated })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionContextStateTable)
    .values({ session_id: sessionID, status: "active", revision: 0 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export function selectEntries<Entry extends { readonly seq?: number; readonly message: SessionMessage.Info }>(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  entries: ReadonlyArray<Entry>,
) {
  return Effect.gen(function* () {
    const state = yield* findCurrent(db, sessionID)
    if (!state || state.status !== "active" || state.covered_through_seq === null) return { entries }
    const summary = yield* modelSummary(db, state)
    const active = summary
      ? entries.filter((entry) => entry.seq === undefined || entry.seq > summary.coveredThrough.seq)
      : entries
    const exclusions = yield* db
      .select()
      .from(SessionContextExclusionTable)
      .where(
        and(
          eq(SessionContextExclusionTable.session_id, sessionID),
          eq(SessionContextExclusionTable.context_revision, state.revision),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    if (exclusions.length === 0) return { entries: active, ...(summary === undefined ? {} : { summary }) }
    const filtered = active.flatMap((entry): ReadonlyArray<Entry> => {
      if (entry.seq === undefined || entry.seq > state.covered_through_seq!) return [entry]
      const messageExclusions = exclusions.flatMap((row) => {
        const target = storedSelector(row.target_selector)
        return target?.kind === "message" &&
          target.messageID === entry.message.id &&
          row.target_key === ContextManifest.targetKey(target)
          ? [target]
          : []
      })
      if (messageExclusions.some((target) => target.digest === messageDigest(entry.message))) return []
      if (entry.message.type !== "assistant") return [entry]

      const encoded = encodeAssistant(entry.message)
      const removed = new Set(
        exclusions.flatMap((row) => {
          const target = storedSelector(row.target_selector)
          if (
            target?.kind !== "part" ||
            target.messageID !== entry.message.id ||
            row.target_key !== ContextManifest.targetKey(target)
          )
            return []
          const part = encoded.content[target.ordinal]
          return part &&
            part.type === target.partKind &&
            Schema.is(Schema.Json)(part) &&
            ContextManifest.payloadDigest(part) === target.digest
            ? [target.ordinal]
            : []
        }),
      )
      if (removed.size === 0) return [entry]
      return [
        {
          ...entry,
          message: { ...entry.message, content: entry.message.content.filter((_, index) => !removed.has(index)) },
        },
      ]
    })
    return { entries: filtered, ...(summary === undefined ? {} : { summary }) }
  })
}

export function filterEntries<Entry extends { readonly seq?: number; readonly message: SessionMessage.Info }>(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  entries: ReadonlyArray<Entry>,
) {
  return selectEntries(db, sessionID, entries).pipe(Effect.map((selection) => selection.entries))
}

const modelSummary = Effect.fnUntraced(function* (
  db: DatabaseService,
  state: typeof SessionContextStateTable.$inferSelect,
) {
  if (state.manifest_digest === null || state.time_activated === null) return undefined
  const blob = yield* db
    .select({ content: CompactionManifestBlobTable.content })
    .from(CompactionManifestBlobTable)
    .where(eq(CompactionManifestBlobTable.digest, state.manifest_digest))
    .get()
    .pipe(Effect.orDie)
  if (!blob || !plainRecord(blob.content)) return undefined
  const summary = Schema.decodeUnknownOption(ContextManifest.RollingSummary)(blob.content.summary)
  if (Option.isNone(summary)) return undefined
  return {
    ...summary.value,
    manifestDigest: state.manifest_digest,
    timeActivated: state.time_activated,
  } satisfies ModelSummary
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap.Service
    return Service.of({
      current: (sessionID) => readCurrent(db, sessionID),
      filter: (sessionID, messages) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              const sequences = new Map(
                (yield* db
                  .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
                  .from(SessionMessageTable)
                  .where(eq(SessionMessageTable.session_id, sessionID))
                  .all()
                  .pipe(Effect.orDie)).map((row) => [row.id, row.seq]),
              )
              return (yield* filterEntries(
                db,
                sessionID,
                messages.map((message) => ({ seq: sequences.get(message.id), message })),
              )).map((entry) => entry.message)
            }),
          )
          .pipe(Effect.orDie),
      activate: (input) =>
        Effect.gen(function* () {
          const session = yield* db
            .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* activationFailure("unknown_context", `Session ${input.sessionID} was not found`)
          const guardrail = yield* Effect.promise(() => import("./guardrail"))
          const liveState = yield* Effect.promise(() => import("./live-state"))
          return yield* guardrail.Service.use((guardrails) => activate(db, events, guardrails, liveState, input)).pipe(
            Effect.provide(
              locations
                .get(
                  Location.Ref.make({
                    directory: AbsolutePath.make(session.directory),
                    workspaceID: session.workspaceID ?? undefined,
                  }),
                )
                .pipe(Layer.orDie),
            ),
          )
        }),
    })
  }),
)

export const node = makeGlobalNode({
  name: "session-context-state",
  layer,
  deps: [Database.node, EventV2.node, LocationServiceMap.node],
})

const activate = Effect.fn("SessionContextState.activate")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  guardrails: SessionGuardrail.Interface,
  liveState: LiveStateModule,
  input: ActivationInput,
): Effect.fn.Return<ActivationResult, ActivationError> {
  const manifestDigest = yield* requireManifest(input.manifest)
  const state = yield* findCurrent(db, input.sessionID)
  if (!state)
    return yield* activationFailure("unknown_context", `Context state not found for Session ${input.sessionID}`)
  if (state.status !== "active")
    return yield* activationFailure(
      "context_quarantined",
      `Context state is quarantined for Session ${input.sessionID}`,
    )
  if (state.revision === input.manifest.baseContextRevision + 1 && state.manifest_digest === manifestDigest)
    return yield* existingActivation(db, input.sessionID, state.revision, manifestDigest)
  if (state.revision !== input.manifest.baseContextRevision)
    return yield* activationFailure(
      "stale_base_revision",
      `Expected context revision ${state.revision}, received ${input.manifest.baseContextRevision}`,
    )

  const eventID = EventV2.ID.create()
  const revision = state.revision + 1
  const timeActivated = Date.now()
  const jobID = input.jobID ?? SessionCompaction.ID.make(`cmp_${manifestDigest}`)
  const checkpointMessages = input.manifest.summary
    ? yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            lte(SessionMessageTable.seq, input.manifest.summary.coveredThrough.seq),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    : []
  const metrics = {
    excludedMessages:
      checkpointMessages.length +
      input.manifest.exclusions.filter(
        (exclusion) => exclusion.reason !== "provider_rebase" && exclusion.target.kind === "message",
      ).length,
    excludedParts: input.manifest.exclusions.filter(
      (exclusion) => exclusion.reason !== "provider_rebase" && exclusion.target.kind === "part",
    ).length,
    inputTokens: input.manifest.inputTokens,
    retainedTokens: input.manifest.retainedTokens,
  }
  const event = yield* guardrails
    .withSnapshot(input.sessionID, (guardrail) =>
      events.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID: input.sessionID,
          jobID,
          revision,
          boundary: input.manifest.coveredThrough,
          metrics,
        },
        {
          id: eventID,
          commit: (sequence) =>
            commitActivation(db, liveState, {
              input,
              manifestDigest,
              revision,
              eventID,
              sequence,
              timeActivated,
              guardrail,
            }).pipe(Effect.orDie),
        },
      ),
    )
    .pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        if (error instanceof ActivationError) return Effect.fail(error)
        if (error instanceof SessionErrors.NotFoundError)
          return activationFailure("unknown_context", `Session ${input.sessionID} was not found`)
        return Effect.die(error)
      }),
    )
  return {
    revision,
    manifestDigest,
    eventID,
    sequence: event.durable.seq,
  }
})

const commitActivation = Effect.fnUntraced(function* (
  db: DatabaseService,
  liveState: LiveStateModule,
  activation: {
    readonly input: ActivationInput
    readonly manifestDigest: string
    readonly revision: number
    readonly eventID: EventV2.ID
    readonly sequence: number
    readonly timeActivated: number
    readonly guardrail: SessionGuardrail.Snapshot
  },
) {
  const state = yield* findCurrent(db, activation.input.sessionID)
  if (!state || state.status !== "active" || state.revision !== activation.input.manifest.baseContextRevision)
    return yield* activationFailure("stale_base_revision", "The active context revision changed before activation")
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, activation.input.sessionID),
        eq(SessionMessageTable.id, activation.input.manifest.coveredThrough.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!boundary || boundary.seq !== activation.input.manifest.coveredThrough.seq)
    return yield* activationFailure(
      "boundary_changed",
      "The covered complete-message boundary changed before activation",
    )
  yield* verifySelectors(db, activation.input)
  yield* verifyJob(db, activation.input)
  const current = yield* liveState.captureDatabase(db, activation.input.sessionID)
  if (
    !protectedStateMatches(
      activation.input.manifest.protectedState,
      liveState.toProtectedState({ ...current.sources, guardrails: activation.guardrail }),
    )
  )
    return yield* activationFailure(
      "protected_state_changed",
      "The authoritative protected state changed before activation",
    )

  const content = decodeManifestContent(ContextManifest.manifestJSON(activation.input.manifest))
  if (!Schema.is(Schema.Json)(content))
    return yield* activationFailure("invalid_manifest", "Manifest content is not JSON")
  yield* db
    .insert(CompactionManifestBlobTable)
    .values({
      digest: activation.manifestDigest,
      schema_version: activation.input.manifest.schemaVersion,
      content,
      input_tokens: activation.input.manifest.inputTokens,
      retained_tokens: activation.input.manifest.retainedTokens,
      time_created: activation.timeActivated,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionContextRevisionTable)
    .values({
      session_id: activation.input.sessionID,
      revision: activation.revision,
      parent_revision: activation.input.manifest.baseContextRevision,
      manifest_digest: activation.manifestDigest,
      covered_through_message_id: activation.input.manifest.coveredThrough.messageID,
      covered_through_seq: activation.input.manifest.coveredThrough.seq,
      activation_event_id: activation.eventID,
      activation_sequence: activation.sequence,
      time_created: activation.timeActivated,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(SessionContextExclusionTable)
    .where(eq(SessionContextExclusionTable.session_id, activation.input.sessionID))
    .run()
    .pipe(Effect.orDie)
  if (activation.input.manifest.exclusions.length > 0)
    yield* db
      .insert(SessionContextExclusionTable)
      .values(
        activation.input.manifest.exclusions.map((exclusion) => ({
          session_id: activation.input.sessionID,
          context_revision: activation.revision,
          target_key: exclusion.targetKey,
          target_kind: exclusion.target.kind,
          target_selector: exclusion.target,
          dependency_group: exclusion.reason === "provider_rebase" ? undefined : exclusion.dependencyGroup,
          reason: exclusion.reason,
          manifest_digest: activation.manifestDigest,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  const advanced = yield* db
    .update(SessionContextStateTable)
    .set({
      status: "active",
      revision: activation.revision,
      manifest_digest: activation.manifestDigest,
      covered_through_message_id: activation.input.manifest.coveredThrough.messageID,
      covered_through_seq: activation.input.manifest.coveredThrough.seq,
      activated_event_id: activation.eventID,
      time_activated: activation.timeActivated,
      error_code: null,
    })
    .where(
      and(
        eq(SessionContextStateTable.session_id, activation.input.sessionID),
        eq(SessionContextStateTable.revision, activation.input.manifest.baseContextRevision),
      ),
    )
    .returning({ sessionID: SessionContextStateTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!advanced)
    return yield* activationFailure("stale_base_revision", "The active context revision changed before activation")

  yield* SessionProviderState.rebaseInTransaction(
    db,
    activation.input.sessionID,
    activation.input.manifest.coveredThrough,
  )
  yield* SessionContinuation.invalidateInTransaction(db, activation.input.sessionID, activation.revision)
  yield* InstructionState.advanceEpoch(db, activation.input.sessionID, activation.sequence)
  if (activation.input.jobID) {
    const settled = yield* db
      .update(SessionCompactionJobTable)
      .set({
        status: "ended",
        lease_owner: null,
        lease_expires_at: null,
        manifest_digest: activation.manifestDigest,
        time_ended: activation.timeActivated,
      })
      .where(
        and(
          eq(SessionCompactionJobTable.id, activation.input.jobID),
          eq(SessionCompactionJobTable.status, "running"),
          eq(SessionCompactionJobTable.session_id, activation.input.sessionID),
          eq(SessionCompactionJobTable.base_context_revision, activation.input.manifest.baseContextRevision),
          eq(
            SessionCompactionJobTable.requested_through_message_id,
            activation.input.manifest.coveredThrough.messageID,
          ),
          eq(SessionCompactionJobTable.requested_through_seq, activation.input.manifest.coveredThrough.seq),
          eq(SessionCompactionJobTable.lease_owner, activation.input.leaseOwner),
        ),
      )
      .returning({ id: SessionCompactionJobTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!settled)
      return yield* activationFailure(
        "job_conflict",
        `Compaction job ${activation.input.jobID} lost lease ownership before activation`,
      )
  }
})

const readCurrent = Effect.fn("SessionContextState.current")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* findCurrent(db, sessionID)
  if (!row) return yield* Effect.die(new Error(`Context state not found for Session ${sessionID}`))
  return currentFromRow(row)
})

const findCurrent = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

function currentFromRow(row: typeof SessionContextStateTable.$inferSelect): Current {
  return {
    status: row.status,
    revision: row.revision,
    ...(row.manifest_digest === null ? {} : { manifestDigest: row.manifest_digest }),
    ...(row.covered_through_message_id === null || row.covered_through_seq === null
      ? {}
      : {
          coveredThrough: { messageID: row.covered_through_message_id, seq: EventV2.Seq.make(row.covered_through_seq) },
        }),
    ...(row.activated_event_id === null ? {} : { activatedEventID: EventV2.ID.make(row.activated_event_id) }),
    ...(row.time_activated === null ? {} : { timeActivated: row.time_activated }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  }
}

const existingActivation = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  revision: number,
  manifestDigest: string,
): Effect.fn.Return<ActivationResult, ActivationError> {
  const row = yield* db
    .select()
    .from(SessionContextRevisionTable)
    .where(
      and(eq(SessionContextRevisionTable.session_id, sessionID), eq(SessionContextRevisionTable.revision, revision)),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row?.activation_event_id || row.activation_sequence === null)
    return yield* activationFailure("invalid_manifest", "The active manifest has incomplete activation lineage")
  return {
    revision,
    manifestDigest,
    eventID: EventV2.ID.make(row.activation_event_id),
    sequence: row.activation_sequence,
  }
})

const verifyJob = Effect.fnUntraced(function* (db: DatabaseService, input: ActivationInput) {
  if (!input.jobID) return
  const current = yield* db
    .select()
    .from(SessionCompactionJobTable)
    .where(eq(SessionCompactionJobTable.id, input.jobID))
    .get()
    .pipe(Effect.orDie)
  if (!jobMatches(current, input))
    return yield* activationFailure("job_conflict", `Compaction job ${input.jobID} is not owned by this activation`)
})

function jobMatches(row: typeof SessionCompactionJobTable.$inferSelect | undefined, input: ActivationInput) {
  return (
    input.jobID !== undefined &&
    row !== undefined &&
    row.id === input.jobID &&
    row.status === "running" &&
    row.session_id === input.sessionID &&
    row.base_context_revision === input.manifest.baseContextRevision &&
    row.requested_through_message_id === input.manifest.coveredThrough.messageID &&
    row.requested_through_seq === input.manifest.coveredThrough.seq &&
    row.lease_owner === input.leaseOwner
  )
}

const verifySelectors = Effect.fnUntraced(function* (db: DatabaseService, input: ActivationInput) {
  const rows = yield* db
    .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, input.sessionID))
    .all()
    .pipe(Effect.orDie)
  const messages = new Map(rows.map((row) => [row.id, row]))
  if (input.manifest.summary) {
    const boundary = messages.get(input.manifest.summary.coveredThrough.messageID)
    if (
      !boundary ||
      boundary.seq !== input.manifest.summary.coveredThrough.seq ||
      boundary.seq > input.manifest.coveredThrough.seq
    )
      return yield* activationFailure(
        "selector_mutation",
        "The rolling summary boundary no longer leaves chronological history",
      )
  }
  for (const selector of manifestSelectors(input.manifest)) {
    if (selector.kind === "provider_state") continue
    const row = messages.get(selector.messageID)
    if (!row || row.seq > input.manifest.coveredThrough.seq || !selectorMatches(selector, row.data))
      return yield* activationFailure(
        "selector_mutation",
        `Selector for ${selector.messageID} no longer matches canonical context`,
      )
  }
})

function selectorMatches(selector: ContextManifest.TargetSelector, data: unknown) {
  if (!Schema.is(Schema.Json)(data)) return false
  if (selector.kind === "message") return ContextManifest.payloadDigest(data) === selector.digest
  if (!plainRecord(data) || !Array.isArray(data.content)) return false
  const part = data.content[selector.ordinal]
  return plainRecord(part) && part.type === selector.partKind && ContextManifest.payloadDigest(part) === selector.digest
}

function manifestSelectors(manifest: ContextManifest.Manifest) {
  return [
    ...(manifest.summary ? [ContextManifest.summarySelector(manifest.summary)] : []),
    ...manifest.exclusions.flatMap((exclusion) => {
      if (exclusion.reason === "provider_rebase" || exclusion.reason === "terminal_intermediate")
        return [exclusion.target]
      return [exclusion.target, exclusion.evidence]
    }),
  ]
}

const requireManifest = Effect.fnUntraced(function* (
  manifest: ContextManifest.Manifest,
): Effect.fn.Return<string, ActivationError> {
  const mutation = manifestMutation(manifest)
  if (mutation) return yield* Effect.fail(mutation)
  return yield* Effect.try({
    try: () => {
      if (
        manifest.schemaVersion !== 1 ||
        !nonnegativeInteger(manifest.baseContextRevision) ||
        !nonnegativeInteger(manifest.coveredThrough.seq) ||
        !nonnegativeInteger(manifest.inputTokens) ||
        !nonnegativeInteger(manifest.retainedTokens) ||
        manifest.retainedTokens >= manifest.inputTokens
      )
        throw new ActivationError({ code: "invalid_manifest", message: "Manifest counters or version are invalid" })
      const protectedSources = new Set<string>()
      for (const entry of manifest.protectedState) {
        if (!nonnegativeInteger(entry.revision) || !digest(entry.digest) || protectedSources.has(entry.source))
          throw new ActivationError({ code: "invalid_manifest", message: "Manifest protected state is invalid" })
        protectedSources.add(entry.source)
      }
      if (manifest.summary) {
        const parsed = SessionSummaryToon.parse(manifest.summary.text, {
          throughSequence: manifest.summary.coveredThrough.seq,
          maxSummaryBytes: Buffer.byteLength(manifest.summary.text, "utf8"),
        })
        if (
          !Schema.is(ContextManifest.RollingSummary)(manifest.summary) ||
          "_tag" in parsed ||
          !SessionSummaryToon.isCanonical(manifest.summary.text) ||
          manifest.summary.coveredThrough.seq > manifest.coveredThrough.seq
        )
          throw new ActivationError({ code: "invalid_manifest", message: "Manifest rolling summary is invalid" })
      }
      const targets = new Set<string>()
      for (const exclusion of manifest.exclusions) {
        if (
          exclusion.targetKey !== ContextManifest.targetKey(exclusion.target) ||
          targets.has(exclusion.targetKey) ||
          (exclusion.reason === "provider_rebase") !== (exclusion.target.kind === "provider_state")
        )
          throw new ActivationError({ code: "selector_mutation", message: "Manifest selector identity is invalid" })
        targets.add(exclusion.targetKey)
      }
      const json = ContextManifest.manifestJSON(manifest)
      decodeManifestContent(json)
      return ContextManifest.manifestDigest(manifest)
    },
    catch: (error) =>
      error instanceof ActivationError
        ? error
        : new ActivationError({ code: "invalid_manifest", message: "Manifest is not canonical JSON" }),
  })
})

function manifestMutation(manifest: ContextManifest.Manifest) {
  if (manifest.summary && !isDeeplyFrozen(manifest.summary))
    return new ActivationError({
      code: "selector_mutation",
      message: "The rolling summary changed after manifest validation",
    })
  if (!Object.isFrozen(manifest.protectedState) || manifest.protectedState.some((entry) => !isDeeplyFrozen(entry)))
    return new ActivationError({
      code: "protected_state_changed",
      message: "The protected-state snapshot changed after manifest validation",
    })
  if (!Object.isFrozen(manifest.exclusions) || manifest.exclusions.some((exclusion) => !isDeeplyFrozen(exclusion)))
    return new ActivationError({
      code: "selector_mutation",
      message: "A selector changed after manifest validation",
    })
  if (!Object.isFrozen(manifest))
    return new ActivationError({
      code: "invalid_manifest",
      message: "Activation requires an immutable validated manifest",
    })
}

function protectedStateMatches(
  expected: ReadonlyArray<ContextManifest.ProtectedStateEntry>,
  current: ReadonlyArray<ContextManifest.ProtectedStateEntry>,
) {
  if (expected.length !== current.length) return false
  const bySource = new Map(expected.map((entry) => [entry.source, entry]))
  return current.every((entry) => {
    const value = bySource.get(entry.source)
    return value?.revision === entry.revision && value.digest === entry.digest
  })
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen)
}

type StoredSelector =
  | { readonly kind: "message"; readonly messageID: SessionMessage.ID; readonly digest: string }
  | {
      readonly kind: "part"
      readonly messageID: SessionMessage.ID
      readonly ordinal: number
      readonly partKind: string
      readonly digest: string
    }
  | {
      readonly kind: "provider_state"
      readonly messageID: SessionMessage.ID
      readonly ordinal: number
      readonly partKind: string
      readonly digest: string
    }

function storedSelector(value: Schema.Json): StoredSelector | undefined {
  if (!plainRecord(value) || typeof value.messageID !== "string" || !digest(value.digest)) return
  if (value.kind === "message")
    return { kind: value.kind, messageID: SessionMessage.ID.make(value.messageID), digest: value.digest }
  if (
    (value.kind !== "part" && value.kind !== "provider_state") ||
    !nonnegativeInteger(value.ordinal) ||
    typeof value.partKind !== "string" ||
    value.partKind.length === 0
  )
    return
  return {
    kind: value.kind,
    messageID: SessionMessage.ID.make(value.messageID),
    ordinal: value.ordinal,
    partKind: value.partKind,
    digest: value.digest,
  }
}

function messageDigest(message: SessionMessage.Info) {
  const encoded = encodeMessage(message)
  const { id: _, type: __, ...data } = encoded
  return Schema.is(Schema.Json)(data) ? ContextManifest.payloadDigest(data) : undefined
}

function plainRecord(value: unknown): value is Record<string, Schema.Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function activationFailure(code: ActivationErrorCode, message: string) {
  return Effect.fail(new ActivationError({ code, message }))
}
