export * as SessionContinuation from "./continuation"

import type { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { Database } from "../../database/database"
import { makeLocationNode } from "../../effect/app-node"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import {
  SessionContextRevisionTable,
  SessionProviderContinuationGenerationTable,
  SessionProviderContinuationTable,
} from "../sql"
import { canonicalJson } from "./cache"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export interface Fingerprint {
  readonly sessionID: SessionSchema.ID
  readonly contextRevision: number
  readonly continuationGeneration: number
  readonly provider: string
  readonly routeID: string
  readonly modelID: string
  readonly variant?: string
  readonly connectionIdentityDigest: string
  readonly representedThroughMessageID?: SessionMessage.ID
  readonly representedMessageCount: number
  readonly promptCacheKey: string
  readonly instructionsDigest: string
  readonly toolsDigest: string
  readonly optionsDigest: string
  readonly volatileContextDigest: string
}

export interface State extends Fingerprint {
  readonly responseID: string
}

export interface SelectInput extends Fingerprint {
  readonly mode: "auto" | "on" | "off"
  readonly store: boolean
  readonly completeMessageIDs: ReadonlyArray<SessionMessage.ID>
}

export interface Interface {
  readonly select: (input: SelectInput) => Effect.Effect<State | undefined>
  readonly remember: (state: State) => Effect.Effect<void>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly invalidateForContextRevision: (sessionID: SessionSchema.ID, revision: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionContinuation") {}

const RESPONSE_ROUTES = new Set(["openai-responses", "openai-responses-websocket"])
export const isResponsesRoute = (routeID: string) => RESPONSE_ROUTES.has(routeID)

export const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db

      const select: Interface["select"] = (input) =>
        Effect.gen(function* () {
          if (input.mode === "off") return undefined
          if (!input.store || input.provider !== "openai" || !isResponsesRoute(input.routeID)) return undefined

          const row = yield* db
            .select()
            .from(SessionProviderContinuationTable)
            .where(eq(SessionProviderContinuationTable.session_id, input.sessionID))
            .get()
          if (!row) return undefined
          const representedBoundary =
            row.represented_message_count === 0
              ? row.represented_through_message_id === null
              : input.completeMessageIDs[row.represented_message_count - 1] === row.represented_through_message_id
          if (!representedBoundary) return undefined
          const candidate = {
            ...input,
            representedThroughMessageID: row.represented_through_message_id ?? undefined,
            representedMessageCount: row.represented_message_count,
          }
          const matches =
            row.continuation_fingerprint === fingerprint(candidate) ||
            // Volatile context (liveState JSON, TeamView) is not part of provider-stored
            // prefix and churns every step. Require stable fingerprint equality and
            // tolerate volatile mismatches to keep `previous_response_id` reuse for
            // mainchat which has frequent todo/orchestration updates.
            fingerprintWithoutVolatile(fromRow(row)) === fingerprintWithoutVolatile(candidate)
          if (!matches) return undefined
          return fromRow(row)
        }).pipe(Effect.orDie)

      const remember: Interface["remember"] = (state) =>
        db.transaction((tx) => rememberInTransaction(tx, state)).pipe(Effect.orDie)
      const clear: Interface["clear"] = (sessionID) => clearWithCurrentRevision(db, sessionID).pipe(Effect.orDie)
      const invalidateForContextRevision: Interface["invalidateForContextRevision"] = (sessionID, revision) =>
        db.transaction((tx) => invalidateInTransaction(tx, sessionID, revision)).pipe(Effect.orDie)

      return Service.of({ select, remember, clear, invalidateForContextRevision })
    }),
  )

export function rememberInTransaction(tx: Transaction | DatabaseClient, state: State) {
  return Effect.gen(function* () {
    yield* tx
      .insert(SessionProviderContinuationGenerationTable)
      .values({
        session_id: state.sessionID,
        generation: state.continuationGeneration,
        context_revision: state.contextRevision,
        time_updated: Date.now(),
      })
      .onConflictDoNothing()

    const authority = yield* tx
      .select()
      .from(SessionProviderContinuationGenerationTable)
      .where(eq(SessionProviderContinuationGenerationTable.session_id, state.sessionID))
      .get()
    if (
      !authority ||
      authority.generation !== state.continuationGeneration ||
      authority.context_revision !== state.contextRevision ||
      state.provider !== "openai" ||
      !isResponsesRoute(state.routeID)
    )
      return

    yield* tx
      .insert(SessionProviderContinuationTable)
      .values(toRow(state))
      .onConflictDoUpdate({
        target: SessionProviderContinuationTable.session_id,
        set: toRow(state),
      })
  })
}

export function invalidateInTransaction(tx: Transaction | DatabaseClient, sessionID: SessionSchema.ID, revision: number) {
  return Effect.gen(function* () {
    yield* tx.delete(SessionProviderContinuationTable).where(eq(SessionProviderContinuationTable.session_id, sessionID))
    yield* tx
      .insert(SessionProviderContinuationGenerationTable)
      .values({ session_id: sessionID, generation: 1, context_revision: revision, time_updated: Date.now() })
      .onConflictDoUpdate({
        target: SessionProviderContinuationGenerationTable.session_id,
        set: {
          generation: sql`${SessionProviderContinuationGenerationTable.generation} + 1`,
          context_revision: revision,
          time_updated: Date.now(),
        },
      })
  })
}

export function currentGeneration(client: DatabaseClient | Transaction, sessionID: SessionSchema.ID) {
  return client
    .select({
      generation: SessionProviderContinuationGenerationTable.generation,
      contextRevision: SessionProviderContinuationGenerationTable.context_revision,
    })
    .from(SessionProviderContinuationGenerationTable)
    .where(eq(SessionProviderContinuationGenerationTable.session_id, sessionID))
    .get()
}

export function captureAuthority(client: DatabaseClient, sessionID: SessionSchema.ID) {
  return client.transaction((tx) =>
    Effect.gen(function* () {
      const existing = yield* currentGeneration(tx, sessionID)
      if (existing) return existing
      const latest = yield* tx
        .select({ revision: SessionContextRevisionTable.revision })
        .from(SessionContextRevisionTable)
        .where(eq(SessionContextRevisionTable.session_id, sessionID))
        .orderBy(desc(SessionContextRevisionTable.revision))
        .get()
      const contextRevision = latest?.revision ?? 0
      if (!latest)
        yield* tx
          .insert(SessionContextRevisionTable)
          .values({ session_id: sessionID, revision: 0, time_created: Date.now() })
          .onConflictDoNothing()
      yield* tx
        .insert(SessionProviderContinuationGenerationTable)
        .values({ session_id: sessionID, generation: 0, context_revision: contextRevision, time_updated: Date.now() })
        .onConflictDoNothing()
      return (yield* currentGeneration(tx, sessionID)) ?? { generation: 0, contextRevision }
    }),
  )
}

function clearWithCurrentRevision(client: DatabaseClient, sessionID: SessionSchema.ID) {
  return client.transaction((tx) =>
    Effect.gen(function* () {
      const authority = yield* currentGeneration(tx, sessionID)
      const active = authority
        ? undefined
        : yield* tx
            .select({ contextRevision: SessionProviderContinuationTable.context_revision })
            .from(SessionProviderContinuationTable)
            .where(eq(SessionProviderContinuationTable.session_id, sessionID))
            .get()
      const latest =
        authority || active
          ? undefined
          : yield* tx
              .select({ contextRevision: SessionContextRevisionTable.revision })
              .from(SessionContextRevisionTable)
              .where(eq(SessionContextRevisionTable.session_id, sessionID))
              .orderBy(desc(SessionContextRevisionTable.revision))
              .get()
      if (!authority && !active && !latest)
        yield* tx
          .insert(SessionContextRevisionTable)
          .values({ session_id: sessionID, revision: 0, time_created: Date.now() })
          .onConflictDoNothing()
      yield* invalidateInTransaction(tx, sessionID, authority?.contextRevision ?? active?.contextRevision ?? latest?.contextRevision ?? 0)
    }),
  )
}

function fingerprint(input: Fingerprint) {
  return createHash("sha256")
    .update(
      canonicalJson({
        sessionID: input.sessionID,
        contextRevision: input.contextRevision,
        continuationGeneration: input.continuationGeneration,
        provider: input.provider,
        routeID: input.routeID,
        modelID: input.modelID,
        variant: input.variant,
        connectionIdentityDigest: input.connectionIdentityDigest,
        representedThroughMessageID: input.representedThroughMessageID,
        representedMessageCount: input.representedMessageCount,
        promptCacheKey: input.promptCacheKey,
        instructionsDigest: input.instructionsDigest,
        toolsDigest: input.toolsDigest,
        optionsDigest: input.optionsDigest,
        volatileContextDigest: input.volatileContextDigest,
      }),
    )
    .digest("hex")
}

function fingerprintWithoutVolatile(input: Fingerprint) {
  return createHash("sha256")
    .update(
      canonicalJson({
        sessionID: input.sessionID,
        contextRevision: input.contextRevision,
        continuationGeneration: input.continuationGeneration,
        provider: input.provider,
        routeID: input.routeID,
        modelID: input.modelID,
        variant: input.variant,
        connectionIdentityDigest: input.connectionIdentityDigest,
        representedThroughMessageID: input.representedThroughMessageID,
        representedMessageCount: input.representedMessageCount,
        promptCacheKey: input.promptCacheKey,
        instructionsDigest: input.instructionsDigest,
        toolsDigest: input.toolsDigest,
        optionsDigest: input.optionsDigest,
      }),
    )
    .digest("hex")
}

export function transportFingerprint(input: Fingerprint) {
  return createHash("sha256")
    .update(
      canonicalJson({
        sessionID: input.sessionID,
        contextRevision: input.contextRevision,
        continuationGeneration: input.continuationGeneration,
        provider: input.provider,
        routeID: input.routeID,
        modelID: input.modelID,
        variant: input.variant,
        connectionIdentityDigest: input.connectionIdentityDigest,
        promptCacheKey: input.promptCacheKey,
        instructionsDigest: input.instructionsDigest,
        toolsDigest: input.toolsDigest,
        optionsDigest: input.optionsDigest,
      }),
    )
    .digest("hex")
}

function toRow(state: State) {
  return {
    session_id: state.sessionID,
    response_id: state.responseID,
    represented_through_message_id: state.representedThroughMessageID,
    represented_message_count: state.representedMessageCount,
    context_revision: state.contextRevision,
    continuation_generation: state.continuationGeneration,
    provider: state.provider,
    route_id: state.routeID,
    model_id: state.modelID,
    variant: state.variant,
    connection_identity_digest: state.connectionIdentityDigest,
    prompt_cache_key: state.promptCacheKey,
    instructions_digest: state.instructionsDigest,
    tools_digest: state.toolsDigest,
    options_digest: state.optionsDigest,
    volatile_context_digest: state.volatileContextDigest,
    continuation_fingerprint: fingerprint(state),
    time_updated: Date.now(),
  }
}

function fromRow(row: typeof SessionProviderContinuationTable.$inferSelect): State {
  return {
    sessionID: row.session_id,
    responseID: row.response_id,
    representedThroughMessageID: row.represented_through_message_id ?? undefined,
    representedMessageCount: row.represented_message_count,
    contextRevision: row.context_revision,
    continuationGeneration: row.continuation_generation,
    provider: row.provider,
    routeID: row.route_id,
    modelID: row.model_id,
    variant: row.variant ?? undefined,
    connectionIdentityDigest: row.connection_identity_digest,
    promptCacheKey: row.prompt_cache_key,
    instructionsDigest: row.instructions_digest,
    toolsDigest: row.tools_digest,
    optionsDigest: row.options_digest,
    volatileContextDigest: row.volatile_context_digest,
  }
}

export const node = makeLocationNode({ service: Service, layer: layer(), deps: [Database.node] })
