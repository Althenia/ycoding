export * as DotsAccess from "./access"

import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { Session } from "@ycoding-ai/schema/session"
import { Config } from "../config"
import { Credential } from "../credential"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import { Integration } from "../integration"
import { Location } from "../location"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import { SessionEvent } from "../session/event"
import { SessionStore } from "../session/store"

export class Error extends Schema.TaggedErrorClass<Error>()("DotsAccess.Error", {
  code: Schema.Literals(["unavailable", "root_required", "conflict"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Dots.Access, Error>
  readonly set: (input: Dots.AccessSet & { readonly sessionID: Session.ID }) => Effect.Effect<Dots.Access, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/DotsAccess") {}

export function configured(entries: readonly Config.Entry[], credentials: readonly Credential.Info[]) {
  const selected = Config.dots(entries)
  if (!selected.enabled) return false
  const exact = credentials.filter((credential) => credential.label === selected.profile && credential.integrationID === "openai")
  return exact.length === 1 && exact[0]!.value.type === "oauth" && Boolean(OpenAICodex.accountID(exact[0]!.value))
}

export function make(input: {
  readonly db: Database.Interface
  readonly events: EventRuntime.Interface
  readonly sessions: Pick<SessionStore.Interface, "get">
  readonly configured: () => Effect.Effect<boolean>
  readonly location?: Location.Ref
}): Interface {
  const db = input.db.db
  const unavailable = () => new Error({ code: "unavailable", message: "Session Dots access is unavailable" })
  const root = Effect.fn("DotsAccess.root")(function* (sessionID: Session.ID) {
    const selected = yield* input.sessions.get(sessionID)
    if (!selected || selected.time.archived !== undefined || input.location &&
      (selected.location.directory !== input.location.directory || selected.location.workspaceID !== input.location.workspaceID))
      return yield* unavailable()
    const visited = new Set<Session.ID>()
    let current = selected
    while (true) {
      if (visited.has(current.id) || visited.size >= 64 || current.time.archived !== undefined) return yield* unavailable()
      visited.add(current.id)
      const owner = yield* db.select({ ownerID: EventSequenceTable.owner_id }).from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, current.id)).get().pipe(Effect.orDie)
      if (owner?.ownerID) return yield* unavailable()
      if (!current.parentID) return current
      const parent = yield* input.sessions.get(current.parentID)
      if (!parent) return yield* unavailable()
      current = parent
    }
  })
  const preference = Effect.fn("DotsAccess.preference")(function* (sessionID: Session.ID) {
    const row = yield* db.select({ data: EventTable.data }).from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, EventRuntime.versionedType(SessionEvent.DotsAccessChanged.type, 1))))
      .orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!row) return { enabled: false, revision: 0 }
    const data = yield* Schema.decodeUnknownEffect(SessionEvent.DotsAccessChanged.data)(row.data)
      .pipe(Effect.mapError(() => unavailable()))
    if (data.sessionID !== sessionID) return yield* unavailable()
    return { enabled: data.enabled, revision: data.revision }
  })
  const get = Effect.fn("DotsAccess.get")(function* (sessionID: Session.ID) {
    const owner = yield* root(sessionID)
    return {
      sessionID, rootSessionID: owner.id, ...(yield* preference(owner.id)),
      inherited: owner.id !== sessionID, configured: yield* input.configured(),
    }
  })
  return {
    get,
    set: Effect.fn("DotsAccess.set")(function* (value) {
      const current = yield* get(value.sessionID)
      if (current.inherited) return yield* new Error({ code: "root_required", message: "Only root Sessions can change Dots access" })
      if (current.revision !== value.expectedRevision) return yield* new Error({ code: "conflict", message: "Dots access revision changed" })
      if (current.enabled === value.enabled) return current
      const revision = current.revision + 1
      const committed = yield* input.events.publishBatch([{
        definition: SessionEvent.DotsAccessChanged,
        data: { sessionID: value.sessionID, enabled: value.enabled, revision },
        options: { location: (yield* root(value.sessionID)).location },
      }], { when: Effect.gen(function* () {
        const owner = yield* root(value.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        return owner?.id === value.sessionID && (yield* preference(value.sessionID)).revision === value.expectedRevision
      }).pipe(Effect.catch(() => Effect.succeed(false))) })
      if (committed.length === 0) return yield* new Error({ code: "conflict", message: "Dots access authorization or revision changed" })
      return { ...current, enabled: value.enabled, revision }
    }),
  }
}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const db = yield* Database.Service
    const events = yield* EventRuntime.Service
    const sessions = yield* SessionStore.Service
    const config = yield* Config.GlobalService
    const credentials = yield* Credential.Service
    const location = yield* Location.Service
    return make({ db, events, sessions, location, configured: () => Effect.gen(function* () {
      const snapshot = yield* config.snapshot()
      return snapshot.diagnostics.length === 0 && configured(snapshot.entries, yield* credentials.list(Integration.ID.make("openai")))
    }) })
  })),
  deps: [Database.node, EventRuntime.node, SessionStore.node, Config.globalNode, Credential.node, Location.node],
})
