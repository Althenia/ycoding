export * as SessionProviderState from "./provider-state"

import type { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import type { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { and, eq, inArray, lte } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionProviderStateBlobTable, SessionProviderStateLinkTable } from "./sql"
import { canonicalJson } from "./runner/cache"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export interface CaptureInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly partOrdinal: number
  readonly partKind: string
  readonly provider: string
  readonly modelID: string
  readonly contextRevision: number
  readonly state?: Record<string, unknown>
}

export interface MaterializeInput {
  readonly sessionID: SessionSchema.ID
  readonly provider: string
  readonly modelID: string
  readonly stateless: boolean
}

export interface Interface {
  readonly capture: (input: CaptureInput) => Effect.Effect<Record<string, unknown> | undefined>
  readonly materialize: (input: MaterializeInput) => Effect.Effect<ReadonlyMap<string, Record<string, unknown>>>
  readonly rebase: (sessionID: SessionSchema.ID, through: SessionCompaction.Boundary) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionProviderState") {}

export const key = (messageID: SessionMessage.ID, partOrdinal: number, partKind: string) =>
  `${messageID}:${partOrdinal}:${partKind}`

export function redact(state: Record<string, unknown> | undefined) {
  if (!state || (!("opaqueCompactionItem" in state) && !("opaqueCompactionOutput" in state))) return state
  const { opaqueCompactionItem: _, opaqueCompactionOutput: __, ...publicState } = state
  return Object.keys(publicState).length === 0 ? undefined : publicState
}

export function captureInTransaction(tx: Transaction | DatabaseClient, input: CaptureInput) {
  return Effect.gen(function* () {
    const opaque = input.state?.opaqueCompactionOutput ?? input.state?.opaqueCompactionItem
    if (!Schema.is(Schema.Json)(opaque)) return redact(input.state)
    const content = canonicalJson(opaque)
    const digest = Hash.sha256(content)
    const itemType =
      input.state?.opaqueCompactionOutput !== undefined
        ? "compaction-output"
        : typeof opaque === "object" &&
            opaque !== null &&
            !Array.isArray(opaque) &&
            "type" in opaque &&
            typeof opaque.type === "string"
          ? opaque.type
          : "opaque"
    yield* tx
      .insert(SessionProviderStateBlobTable)
      .values({
        digest,
        provider: input.provider,
        model_id: input.modelID,
        item_type: itemType,
        content: opaque,
        time_created: Date.now(),
      })
      .onConflictDoNothing()
    yield* tx
      .insert(SessionProviderStateLinkTable)
      .values({
        session_id: input.sessionID,
        message_id: input.messageID,
        part_ordinal: input.partOrdinal,
        part_kind: input.partKind,
        provider: input.provider,
        model_id: input.modelID,
        blob_digest: digest,
        context_revision: input.contextRevision,
        time_created: Date.now(),
      })
      .onConflictDoUpdate({
        target: [
          SessionProviderStateLinkTable.session_id,
          SessionProviderStateLinkTable.message_id,
          SessionProviderStateLinkTable.part_ordinal,
          SessionProviderStateLinkTable.part_kind,
        ],
        set: {
          provider: input.provider,
          model_id: input.modelID,
          blob_digest: digest,
          context_revision: input.contextRevision,
          time_created: Date.now(),
        },
      })
    return redact(input.state)
  })
}

export function rebaseInTransaction(
  tx: Transaction | DatabaseClient,
  sessionID: SessionSchema.ID,
  through: SessionCompaction.Boundary,
) {
  return Effect.gen(function* () {
    const ids = yield* tx
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), lte(SessionMessageTable.seq, through.seq)))
      .all()
    if (ids.length === 0) return
    yield* tx
      .delete(SessionProviderStateLinkTable)
      .where(
        and(
          eq(SessionProviderStateLinkTable.session_id, sessionID),
          inArray(
            SessionProviderStateLinkTable.message_id,
            ids.map((row) => row.id),
          ),
        ),
      )
  })
}

export const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return Service.of({
        capture: (input) => db.transaction((tx) => captureInTransaction(tx, input)).pipe(Effect.orDie),
        materialize: (input) =>
          Effect.gen(function* () {
            if (!input.stateless) return new Map()
            const rows = yield* db
              .select({ link: SessionProviderStateLinkTable, blob: SessionProviderStateBlobTable })
              .from(SessionProviderStateLinkTable)
              .innerJoin(
                SessionProviderStateBlobTable,
                eq(SessionProviderStateBlobTable.digest, SessionProviderStateLinkTable.blob_digest),
              )
              .where(
                and(
                  eq(SessionProviderStateLinkTable.session_id, input.sessionID),
                  eq(SessionProviderStateLinkTable.provider, input.provider),
                  eq(SessionProviderStateLinkTable.model_id, input.modelID),
                ),
              )
              .all()
            return new Map(
              rows.flatMap((row) => {
                const state =
                  row.blob.item_type === "compaction-output" && Array.isArray(row.blob.content)
                    ? { opaqueCompactionOutput: row.blob.content }
                    : typeof row.blob.content === "object" && row.blob.content !== null && !Array.isArray(row.blob.content)
                      ? { opaqueCompactionItem: row.blob.content }
                      : undefined
                return state
                  ? [[key(row.link.message_id, row.link.part_ordinal, row.link.part_kind), state] as const]
                  : []
              }),
            )
          }).pipe(Effect.orDie),
        rebase: (sessionID, through) => db.transaction((tx) => rebaseInTransaction(tx, sessionID, through)).pipe(Effect.orDie),
      })
    }),
  )

export const node = makeLocationNode({ service: Service, layer: layer(), deps: [Database.node] })
