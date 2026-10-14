export * as SessionRetention from "./retention"

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Schedule, Scope } from "effect"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeGlobalNode, Node } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { EventRuntime } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import { Global } from "../global"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { SessionEvent } from "./event"
import { SessionExecution } from "./execution"
import { SessionHistoryPruning } from "./history-pruning"
import { SessionProjector } from "./projector"
import type { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

const defaultDays = 7
const pageSize = 200
const instructionChunkSize = 500
const kept = { deleted: 0, instructions: [] as ReadonlyArray<string> }
const instructionEventType = EventRuntime.versionedType(
  SessionEvent.InstructionsUpdated.type,
  SessionEvent.InstructionsUpdated.durable.version,
)

export interface Interface {
  readonly cleanup: (now?: number) => Effect.Effect<number>
  readonly pruneHistory: () => Effect.Effect<SessionHistoryPruning.Result>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionRetention") {}

const layer = (options?: Config.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const execution = yield* SessionExecution.Service
      const events = yield* EventRuntime.Service
      const global = yield* Global.Service
      const lifetime = yield* Scope.Scope
      const context = yield* Effect.context()
      const config = yield* Effect.cached(
        Layer.buildWithScope(
          LayerNode.compile(configGraph(options, AbsolutePath.make(global.config)).node).pipe(
            Layer.provide(Layer.succeedContext(context)),
          ),
          lifetime,
        ).pipe(
          Effect.map((built) => Context.get(built, Config.Service)),
          Effect.orDie,
        ),
      )

      const ids = (family: ReadonlyArray<SessionSchema.ID>) =>
        sql.join(
          family.map((id) => sql`${id}`),
          sql`, `,
        )

      const exempt = (family: ReadonlyArray<SessionSchema.ID>, cutoff: number) =>
        db
          .get<{ exempt: number }>(
            sql`SELECT
              EXISTS (
                SELECT 1 FROM session WHERE id IN (${ids(family)}) AND (
                  max(time_updated, coalesce(time_active, 0)) >= ${cutoff}
                  OR time_pinned IS NOT NULL
                  OR time_suspended IS NOT NULL
                  OR json_extract(autonomy, '$.goal.status') = 'active'
                )
              )
              OR EXISTS (SELECT 1 FROM session_pending WHERE session_id IN (${ids(family)}))
              OR EXISTS (
                SELECT 1 FROM session WHERE fork_session_id IN (${ids(family)}) AND id NOT IN (${ids(family)})
              ) AS exempt`,
          )
          .pipe(Effect.map((row) => row?.exempt === 1))

      const referencedBlobs = (family: ReadonlyArray<SessionSchema.ID>) =>
        Effect.all({
          manifests: db.all<{ digest: string }>(
            sql`SELECT manifest_digest AS digest FROM session_context_revision WHERE session_id IN (${ids(family)}) AND manifest_digest IS NOT NULL
              UNION SELECT manifest_digest FROM session_context_state WHERE session_id IN (${ids(family)}) AND manifest_digest IS NOT NULL
              UNION SELECT manifest_digest FROM session_context_exclusion WHERE session_id IN (${ids(family)})
              UNION SELECT manifest_digest FROM session_compaction_job WHERE session_id IN (${ids(family)}) AND manifest_digest IS NOT NULL`,
          ),
          providerStates: db.all<{ digest: string }>(
            sql`SELECT DISTINCT blob_digest AS digest FROM session_provider_state_link WHERE session_id IN (${ids(family)})`,
          ),
          instructions: db.all<{ digest: string }>(
            sql`SELECT entry.value AS digest FROM event, json_each(event.data, '$.delta') AS entry
                WHERE event.aggregate_id IN (${ids(family)}) AND event.type = ${instructionEventType} AND entry.value <> 'removed'
              UNION SELECT entry.value FROM instruction_state, json_each(instruction_state.initial_values) AS entry
                WHERE instruction_state.session_id IN (${ids(family)})
              UNION SELECT entry.value FROM instruction_state, json_each(instruction_state.current_values) AS entry
                WHERE instruction_state.session_id IN (${ids(family)})`,
          ),
        })

      const digests = (values: ReadonlyArray<string>) =>
        sql.join(
          values.map((value) => sql`${value}`),
          sql`, `,
        )

      const removeUnreferencedBlobs = Effect.fnUntraced(function* (
        blobs: Effect.Success<ReturnType<typeof referencedBlobs>>,
      ) {
        if (blobs.manifests.length > 0)
          yield* db.run(
            sql`DELETE FROM compaction_manifest_blob WHERE digest IN (${digests(blobs.manifests.map((row) => row.digest))})
              AND NOT EXISTS (SELECT 1 FROM session_context_revision WHERE manifest_digest = compaction_manifest_blob.digest)
              AND NOT EXISTS (SELECT 1 FROM session_context_state WHERE manifest_digest = compaction_manifest_blob.digest)
              AND NOT EXISTS (SELECT 1 FROM session_context_exclusion WHERE manifest_digest = compaction_manifest_blob.digest)
              AND NOT EXISTS (SELECT 1 FROM session_compaction_job WHERE manifest_digest = compaction_manifest_blob.digest)`,
          )
        if (blobs.providerStates.length > 0)
          yield* db.run(
            sql`DELETE FROM session_provider_state_blob WHERE digest IN (${digests(blobs.providerStates.map((row) => row.digest))})
              AND NOT EXISTS (SELECT 1 FROM session_provider_state_link WHERE blob_digest = session_provider_state_blob.digest)`,
          )
      })

      const removeUnreferencedInstructions = (hashes: ReadonlyArray<string>) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(hashes.length / instructionChunkSize) }, (_, index) =>
            hashes.slice(index * instructionChunkSize, (index + 1) * instructionChunkSize),
          ),
          (chunk) =>
            db.run(
              sql`DELETE FROM instruction_blob WHERE hash IN (${digests(chunk)}) AND hash NOT IN (
                SELECT entry.value FROM event_sequence CROSS JOIN event
                  ON event.aggregate_id = event_sequence.aggregate_id AND event.type = ${instructionEventType},
                  json_each(event.data, '$.delta') AS entry
                UNION ALL SELECT entry.value FROM instruction_state, json_each(instruction_state.initial_values) AS entry
                UNION ALL SELECT entry.value FROM instruction_state, json_each(instruction_state.current_values) AS entry
              )`,
            ),
          { discard: true },
        )

      const removeFamily = (rootID: SessionSchema.ID, cutoff: number) =>
        db.transaction(
          () =>
            Effect.gen(function* () {
              const members = yield* db.all<{ id: SessionSchema.ID; depth: number }>(
                sql`WITH RECURSIVE family(id, depth) AS (
                  SELECT id, 0 FROM session WHERE id = ${rootID} AND parent_id IS NULL
                  UNION ALL SELECT session.id, family.depth + 1 FROM session JOIN family ON session.parent_id = family.id
                ) SELECT id, depth FROM family ORDER BY depth DESC`,
              )
              const family = members.map((member) => member.id)
              if (family.length === 0) return kept
              const active = yield* execution.active
              if (family.some((id) => active.has(id))) return kept
              if (yield* exempt(family, cutoff)) return kept
              const blobs = yield* referencedBlobs(family)
              const locations = new Map(
                (yield* db
                  .select({
                    id: SessionTable.id,
                    directory: SessionTable.directory,
                    workspaceID: SessionTable.workspace_id,
                  })
                  .from(SessionTable)
                  .where(inArray(SessionTable.id, family))
                  .all()).map((row) => [row.id, row]),
              )
              yield* Effect.forEach(
                family,
                (sessionID) => {
                  const location = locations.get(sessionID)
                  return events.publish(
                    SessionEvent.Deleted,
                    { sessionID },
                    location
                      ? {
                          location: {
                            directory: AbsolutePath.make(location.directory),
                            ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
                          },
                        }
                      : undefined,
                  )
                },
                { discard: true },
              )
              yield* db.delete(EventSequenceTable).where(inArray(EventSequenceTable.aggregate_id, family)).run()
              yield* db.delete(EventTable).where(inArray(EventTable.aggregate_id, family)).run()
              yield* removeUnreferencedBlobs(blobs)
              return { deleted: family.length, instructions: blobs.instructions.map((row) => row.digest) }
            }),
          { behavior: "immediate" },
        )

      return Service.of({
        pruneHistory: SessionHistoryPruning.make(db, execution.active).sweep,
        cleanup: Effect.fn("SessionRetention.cleanup")(function* (now?: number) {
          const settings = yield* config
          const days = Config.latest(yield* settings.entries(), "session_retention")?.days ?? defaultDays
          const cutoff = (now ?? (yield* Clock.currentTimeMillis)) - Duration.toMillis(Duration.days(days))
          let cursor: { id: SessionSchema.ID; updated: number } | undefined
          let deleted = 0
          const instructions = new Set<string>()
          while (true) {
            const roots = yield* db
              .select({ id: SessionTable.id, updated: SessionTable.time_updated })
              .from(SessionTable)
              .where(
                and(
                  isNull(SessionTable.parent_id),
                  lt(SessionTable.time_updated, cutoff),
                  cursor
                    ? or(
                        gt(SessionTable.time_updated, cursor.updated),
                        and(eq(SessionTable.time_updated, cursor.updated), gt(SessionTable.id, cursor.id)),
                      )
                    : undefined,
                ),
              )
              .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
              .limit(pageSize)
              .all()
              .pipe(Effect.orDie)
            for (const root of roots) {
              const removed = yield* removeFamily(root.id, cutoff).pipe(
                Effect.orDie,
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterrupts(cause),
                  (cause) =>
                    Effect.logError("session retention could not delete family", { sessionID: root.id, cause }).pipe(
                      Effect.as(kept),
                    ),
                ),
              )
              deleted += removed.deleted
              removed.instructions.forEach((hash) => instructions.add(hash))
            }
            if (roots.length < pageSize) break
            cursor = roots.at(-1)!
          }
          if (deleted > 0) {
            yield* Effect.logInfo("session retention deleted idle Sessions", { deleted, days })
            yield* removeUnreferencedInstructions(Array.from(instructions)).pipe(Effect.orDie)
            yield* Database.reclaim(db).pipe(Effect.orDie)
          }
          yield* db.run("PRAGMA optimize").pipe(Effect.orDie)
          return deleted
        }),
      })
    }),
  )

const sweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* Service
    yield* retention
      .cleanup()
      .pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.logError("session retention sweep failed", { cause }),
        ),
        Effect.andThen(
          retention.pruneHistory().pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logError("session history pruning sweep failed", { cause }),
            ),
          ),
        ),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.forkScoped,
      )
  }),
)

function configGraph(options: Config.Options | undefined, directory: AbsolutePath) {
  return LayerNode.hoist(Config.configured(options), Node.tags.values.global, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory }))],
  ])
}

export function configured(options?: Config.Options) {
  const service = layer(options)
  return makeGlobalNode({
    service: Service,
    layer: Layer.merge(service, sweepLayer.pipe(Layer.provide(service))),
    deps: [
      Database.node,
      SessionExecution.node,
      SessionProjector.node,
      EventRuntime.node,
      Global.node,
      configGraph(options, AbsolutePath.make(Global.Path.config)).hoisted,
    ],
  })
}

export const node = configured()
