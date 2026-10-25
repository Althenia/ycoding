export * as SessionMcpEvents from "./index"

import { randomBytes, timingSafeEqual } from "node:crypto"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Cause, Clock, Context, Duration, Effect, Layer, Result, Schema, Semaphore } from "effect"
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, max, min, notExists, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { SessionReviewFold } from "../session/review-fold"
import { EPHEMERAL_ATTENTION, mapEvent, REPLAYABLE, type Notification } from "./capture"
import { canonicalJSON, grantTtl, normalizeArguments, subscriptionIdentity } from "./identity"
import { McpEventsHttp } from "./protected-http"
import { McpEventsSecretBox } from "./secret-box"
import { sign } from "./signing"
import { McpEventOutboxTable, McpEventSubscriptionTable } from "./sql"

export interface AuthorizationInterface {
  readonly capabilities: Effect.Effect<boolean>
  readonly resolve: (context: McpEvents.RequestContext) => Effect.Effect<{ grantID: string; expiresAt: number }, McpEvents.Failure>
  readonly check: (principal: McpEvents.Principal) => Effect.Effect<{ expiresAt: number; signal?: AbortSignal }, McpEvents.Failure>
}

export class AuthorizationService extends Context.Service<AuthorizationService, AuthorizationInterface>()("@ycoding/McpEventsAuthorization") {}

const authorizationUnavailable = () => new McpEvents.Failure({ category: "unavailable", reason: "authorization_unavailable" })

export const disabledLayer = Layer.succeed(AuthorizationService, AuthorizationService.of({
  capabilities: Effect.succeed(false),
  resolve: () => Effect.fail(authorizationUnavailable()),
  check: () => Effect.fail(authorizationUnavailable()),
}))

const authorizationNode = makeGlobalNode({ service: AuthorizationService, layer: disabledLayer, deps: [] })

export const Authorization = { Service: AuthorizationService, disabledLayer, node: authorizationNode }

export interface Interface {
  readonly status: () => Effect.Effect<{ available: boolean }>
  readonly list: (input?: { cursor?: string | null }) => Effect.Effect<McpEvents.ListResult>
  readonly subscribe: (input: {
    context: McpEvents.RequestContext
    subscription: McpEvents.Subscribe
  }) => Effect.Effect<McpEvents.Subscription, McpEvents.Failure>
  readonly unsubscribe: (input: {
    context: McpEvents.RequestContext
    subscription: McpEvents.Unsubscribe
  }) => Effect.Effect<{}, McpEvents.Failure>
}

export interface TestInterface extends Interface {
  readonly capture: (input: { type: string; id: string; data: Record<string, unknown> }) => Effect.Effect<void>
  readonly dispatchOnce: () => Effect.Effect<void>
  readonly rows: () => Effect.Effect<{ subscriptions: number; activeSubscriptions: number; outbox: number; pending: number }>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/McpEvents") {}

export interface Dependencies {
  readonly db: Database.Interface["db"]
  readonly authorization: AuthorizationInterface
  readonly transport: McpEventsHttp.Interface
  readonly secretBox: McpEventsSecretBox.SecretBox
  readonly session: (id: string) => Effect.Effect<{ id: string; parentID?: string } | undefined>
}

const MAX_ATTEMPTS = 5
const DISPATCH_BATCH = 100
const RETENTION_MS = 7 * 86_400_000
const VERIFICATION_CACHE_MS = 5 * 60_000
const ROTATION_MS = 120_000
const PROGRESS_COALESCE_MS = 30_000
const MAX_BODY_BYTES = 262_144

const fail = (category: McpEvents.FailureCategory, reason: McpEvents.FailureReason) => new McpEvents.Failure({ category, reason })

export const make = (deps: Dependencies): Effect.Effect<TestInterface> => Effect.gen(function* () {
  const db = deps.db
  const mutations = Semaphore.makeUnsafe(1)
  const verified = new Map<string, number>()
  const inflight = new Map<string, Set<AbortController>>()
  const abortInflight = (subscriptionID: string) => {
    for (const controller of inflight.get(subscriptionID) ?? []) controller.abort()
  }
  const now = Clock.currentTimeMillis

  const ancestorsOf = (sessionID: string) => Effect.gen(function* () {
    const chain: string[] = []
    let current: string | undefined = sessionID
    while (current !== undefined && chain.length < 64 && !chain.includes(current)) {
      chain.push(current)
      const info: { id: string; parentID?: string } | undefined = yield* deps.session(current)
      current = info?.parentID
    }
    return chain
  })

  const watermark = (subscriptionID: string) => Effect.gen(function* () {
    const firstPending = yield* db
      .select({ value: min(McpEventOutboxTable.seq) })
      .from(McpEventOutboxTable)
      .where(and(eq(McpEventOutboxTable.subscription_id, subscriptionID), isNull(McpEventOutboxTable.delivered_at), eq(McpEventOutboxTable.dead, 0)))
      .get()
      .pipe(Effect.orDie)
    if (firstPending?.value !== null && firstPending?.value !== undefined) return firstPending.value - 1
    const last = yield* db
      .select({ value: max(McpEventOutboxTable.seq) })
      .from(McpEventOutboxTable)
      .where(eq(McpEventOutboxTable.subscription_id, subscriptionID))
      .get()
      .pipe(Effect.orDie)
    const pruned = yield* db.select({ value: McpEventSubscriptionTable.pruned_through }).from(McpEventSubscriptionTable)
      .where(eq(McpEventSubscriptionTable.id, subscriptionID)).get().pipe(Effect.orDie)
    return Math.max(last?.value ?? 0, pruned?.value ?? 0)
  })

  const verifyCallback = (input: {
    identity: ReturnType<typeof subscriptionIdentity>
    principal: McpEvents.Principal
    url: string
    secretBytes: Uint8Array
  }) => Effect.gen(function* () {
    const cacheKey = `${deps.secretBox.fingerprint(Buffer.from(canonicalJSON({ principal: input.principal, url: input.url })))}:${deps.secretBox.fingerprint(input.secretBytes)}`
    const current = yield* now
    if ((verified.get(cacheKey) ?? 0) > current) return
    const challenge = randomBytes(24).toString("base64url")
    const body = JSON.stringify({ type: "verification", challenge })
    const id = `msg_verification_${randomBytes(16).toString("hex")}`
    const timestampSeconds = Math.floor(current / 1000)
    const response = yield* deps.transport.send({
      url: input.url,
      body,
      timeoutMs: 10_000,
      headers: {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(timestampSeconds),
        "webhook-signature": sign({ id, timestampSeconds, body, secrets: [input.secretBytes] }),
        "X-MCP-Subscription-Id": input.identity.id,
      },
    })
    if (response.status < 200 || response.status >= 300) return yield* fail("callback_endpoint", "challenge_failed")
    const parsed = Schema.decodeUnknownResult(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Struct({ challenge: Schema.String }))))(response.body)
    const echoed = Result.isSuccess(parsed) ? parsed.success.challenge : undefined
    const expected = Buffer.from(challenge)
    const actual = echoed === undefined ? Buffer.alloc(0) : Buffer.from(echoed)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return yield* fail("callback_endpoint", "challenge_failed")
    verified.set(cacheKey, current + VERIFICATION_CACHE_MS)
  })

  const subscribe: Interface["subscribe"] = Effect.fn("McpEvents.subscribe")(function* (input) {
    const subscription = yield* Schema.decodeUnknownEffect(McpEvents.Subscribe)(input.subscription, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => fail("invalid_params", "invalid_arguments")),
    )
    const context = yield* Schema.decodeUnknownEffect(McpEvents.RequestContext)(input.context, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => fail("unauthorized", "unauthorized_principal")),
    )
    if (!(yield* deps.authorization.capabilities)) return yield* authorizationUnavailable()
    const args = normalizeArguments(subscription.arguments)
    const session = yield* deps.session(args.session_id)
    if (session === undefined) return yield* fail("invalid_params", "session_not_found")
    const url = Result.try(() => new URL(subscription.delivery.url))
    if (Result.isFailure(url) || url.success.protocol !== "https:" || url.success.username !== "" || url.success.password !== "")
      return yield* fail("invalid_params", "invalid_delivery")
    const secretBytes = McpEventsSecretBox.decodeSecret(subscription.delivery.secret)
    if (Result.isFailure(secretBytes)) return yield* secretBytes.failure
    const current = yield* now
    const grant = yield* deps.authorization.resolve(context)
    if (grant.expiresAt <= current) return yield* fail("unauthorized", "grant_expired")
    const principal: McpEvents.Principal = { ...context.principal, grantID: grant.grantID, epoch: context.epoch }
    const identity = subscriptionIdentity(principal, subscription.delivery.url, subscription.name, args)
    const expiresAt = grantTtl({ ttlMs: subscription.ttlMs, grantExpiresAt: grant.expiresAt, now: current })
    if (expiresAt <= current) return yield* fail("unauthorized", "grant_expired")
    const replayable = REPLAYABLE.has(subscription.name)
    let cursorSeq: number | undefined
    if (subscription.cursor !== undefined && subscription.cursor !== null) {
      if (!replayable) return yield* fail("invalid_params", "invalid_cursor")
      cursorSeq = deps.secretBox.decodeCursor(identity.hash, subscription.cursor)
      if (cursorSeq === undefined) return yield* fail("invalid_params", "invalid_cursor")
    }
    yield* verifyCallback({ identity, principal, url: subscription.delivery.url, secretBytes: secretBytes.success })
    const confirmed = yield* deps.authorization.check(principal)
    const verifiedAt = yield* now
    if (confirmed.expiresAt <= verifiedAt || expiresAt <= verifiedAt) return yield* fail("unauthorized", "grant_expired")
    if (confirmed.signal?.aborted) return yield* fail("unavailable", "authorization_unavailable")

    return yield* db.transaction((tx) => Effect.gen(function* () {
      const existing = yield* tx.select().from(McpEventSubscriptionTable).where(eq(McpEventSubscriptionTable.identity_hash, identity.hash)).get().pipe(Effect.orDie)
      if (existing?.disabled === 1) return yield* authorizationUnavailable()
      const fingerprint = deps.secretBox.fingerprint(secretBytes.success)
      const rotated = existing !== undefined && existing.secret_fingerprint !== fingerprint
      const values = {
        id: identity.id,
        identity_hash: identity.hash,
        owner_id: principal.ownerID,
        device_id: principal.deviceID,
        client_id: principal.clientID,
        grant_id: principal.grantID,
        epoch: principal.epoch,
        name: subscription.name,
        session_id: args.session_id,
        include_descendants: args.include_descendants ? 1 : 0,
        callback_url: subscription.delivery.url,
        secret_ciphertext: deps.secretBox.encrypt(secretBytes.success),
        secret_fingerprint: fingerprint,
        previous_secret_ciphertext: rotated ? existing.secret_ciphertext : (existing?.previous_secret_ciphertext ?? null),
        previous_secret_until: rotated ? current + ROTATION_MS : (existing?.previous_secret_until ?? null),
        expires_at: Math.min(expiresAt, confirmed.expiresAt),
        disabled: 0,
        time_created: existing?.time_created ?? current,
        time_updated: current,
      }
      yield* tx
        .insert(McpEventSubscriptionTable)
        .values(values)
        .onConflictDoUpdate({ target: McpEventSubscriptionTable.identity_hash, set: values })
        .run()
        .pipe(Effect.orDie)
      if (cursorSeq !== undefined) {
        yield* tx.update(McpEventOutboxTable).set({ delivered_at: null, dead: 0, next_attempt_at: current }).where(and(
          eq(McpEventOutboxTable.subscription_id, identity.id),
          gt(McpEventOutboxTable.seq, cursorSeq),
          isNotNull(McpEventOutboxTable.delivered_at),
          gte(McpEventOutboxTable.time_created, current - RETENTION_MS),
        )).run().pipe(Effect.orDie)
      }
      const mark = replayable ? yield* watermark(identity.id) : 0
      const retained = yield* tx.select({ prunedThrough: McpEventSubscriptionTable.pruned_through }).from(McpEventSubscriptionTable)
        .where(eq(McpEventSubscriptionTable.id, identity.id)).get().pipe(Effect.orDie)
      const result = {
        id: identity.id,
        refreshBefore: new Date(values.expires_at).toISOString(),
        cursor: replayable ? deps.secretBox.encodeCursor(identity.hash, mark) : null,
        truncated: cursorSeq !== undefined && cursorSeq < (retained?.prunedThrough ?? 0),
      }
      if (values.expires_at <= (yield* now)) return yield* fail("unauthorized", "grant_expired")
      if (confirmed.signal?.aborted) return yield* authorizationUnavailable()
      return result
    }), { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
  })

  const unsubscribe: Interface["unsubscribe"] = Effect.fn("McpEvents.unsubscribe")(function* (input) {
    const subscription = yield* Schema.decodeUnknownEffect(McpEvents.Unsubscribe)(input.subscription, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => fail("invalid_params", "invalid_arguments")),
    )
    const context = yield* Schema.decodeUnknownEffect(McpEvents.RequestContext)(input.context, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => fail("unauthorized", "unauthorized_principal")),
    )
    if (!(yield* deps.authorization.capabilities)) return yield* authorizationUnavailable()
    const grant = yield* deps.authorization.resolve(context)
    const principal: McpEvents.Principal = { ...context.principal, grantID: grant.grantID, epoch: context.epoch }
    const identity = subscriptionIdentity(principal, subscription.delivery.url, subscription.name, normalizeArguments(subscription.arguments))
    abortInflight(identity.id)
    yield* db.update(McpEventSubscriptionTable).set({ disabled: 1, time_updated: yield* now }).where(eq(McpEventSubscriptionTable.identity_hash, identity.hash)).run().pipe(Effect.orDie)
    yield* db.update(McpEventOutboxTable).set({ dead: 1 }).where(eq(McpEventOutboxTable.subscription_id, identity.id)).run().pipe(Effect.orDie)
    return {}
  })

  const capture: TestInterface["capture"] = Effect.fn("McpEvents.capture")(function* (input) {
    const review = input.type === "session.review.decided" || input.type === "session.review.withdrawn"
      ? (yield* SessionReviewFold.fold(db, [SessionSchema.ID.make(String(input.data.sessionID))])).find((item) => item.itemID === input.data.itemID)
      : undefined
    const notification: Notification | undefined = mapEvent(review === undefined ? input : {
      ...input,
      data: { ...input.data, sessionID: review.sessionID, kind: review.kind, origin: review.origin, payload: review.payload },
    })
    if (notification === undefined) return
    yield* captureNotification(notification)
    if (input.type !== "session.task.updated" || notification.taskID === undefined || notification.state !== "cancelled") return
    const previous = yield* db.select().from(McpEventOutboxTable).where(and(
      eq(McpEventOutboxTable.session_id, notification.sessionID), eq(McpEventOutboxTable.name, "session.question.changed"),
      sql`json_extract(${McpEventOutboxTable.attention}, '$.kind') = 'subagent_question'`,
    )).orderBy(sql`${McpEventOutboxTable.seq} DESC`).limit(1).get().pipe(Effect.orDie)
    if (previous === undefined || previous.request_id === null || (previous.state !== "pending" && previous.state !== "deferred")) return
    yield* captureNotification({
      name: "session.question.changed", sessionID: notification.sessionID, taskID: notification.taskID,
      requestID: previous.request_id, sourceID: input.id, state: "cancelled",
      ...(notification.reason === undefined ? {} : { reason: notification.reason }),
      ...(previous.attention === null ? {} : { attention: previous.attention }),
    })
  })

  const captureNotification = Effect.fn("McpEvents.captureNotification")(function* (notification: Notification) {
    const current = yield* now
    const chain = yield* ancestorsOf(notification.sessionID)
    const root = chain[chain.length - 1] ?? notification.sessionID
    const subscriptions = yield* db
      .select()
      .from(McpEventSubscriptionTable)
      .where(and(eq(McpEventSubscriptionTable.name, notification.name), eq(McpEventSubscriptionTable.disabled, 0)))
      .all()
      .pipe(Effect.orDie)
    for (const sub of subscriptions) {
      if (sub.expires_at <= current) continue
      const matches = sub.session_id === notification.sessionID || (sub.include_descendants === 1 && chain.includes(sub.session_id))
      if (!matches) continue
      if (notification.name === "session.progress" && notification.requestID === undefined) {
        const latest = yield* db
          .select()
          .from(McpEventOutboxTable)
          .where(and(eq(McpEventOutboxTable.subscription_id, sub.id), eq(McpEventOutboxTable.session_id, notification.sessionID), eq(McpEventOutboxTable.name, notification.name)))
          .orderBy(asc(McpEventOutboxTable.seq))
          .all()
          .pipe(Effect.orDie)
        const last = latest[latest.length - 1]
        if (last !== undefined && last.state === notification.state && current - last.time_created < PROGRESS_COALESCE_MS) continue
      }
      const previous = notification.requestID === undefined && notification.itemID === undefined ? undefined : yield* db
        .select({ attention: McpEventOutboxTable.attention })
        .from(McpEventOutboxTable)
        .where(and(
          eq(McpEventOutboxTable.subscription_id, sub.id), eq(McpEventOutboxTable.session_id, notification.sessionID),
          eq(McpEventOutboxTable.name, notification.name),
          or(
            notification.requestID === undefined ? undefined : eq(McpEventOutboxTable.request_id, notification.requestID),
            notification.itemID === undefined ? undefined : eq(McpEventOutboxTable.item_id, notification.itemID),
          ),
          isNotNull(McpEventOutboxTable.attention),
        )).orderBy(sql`${McpEventOutboxTable.seq} DESC`).limit(1).get().pipe(Effect.orDie)
      const snapshot = previous?.attention ?? notification.attention
      const attention = snapshot === undefined ? undefined : McpEvents.Attention.make({
        ...snapshot,
        actions: notification.state === "pending" || notification.state === "deferred" ? ["inspect", "notify_human"] : ["inspect"],
      })
      yield* db
        .insert(McpEventOutboxTable)
        .values({
          id: `evt_${randomBytes(16).toString("hex")}`,
          subscription_id: sub.id,
          dedupe_key: `${sub.id}:${notification.name}:${notification.sourceID}:${notification.state}`,
          name: notification.name,
          session_id: notification.sessionID,
          root_session_id: root,
          state: notification.state,
          request_id: notification.requestID ?? null,
          item_id: notification.itemID ?? null,
          task_id: notification.taskID ?? null,
          category: notification.category ?? null,
          reason: notification.reason ?? null,
          attention: attention ?? null,
          time_created: current,
          attempts: 0,
          next_attempt_at: current,
          dead: 0,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  })

  const dispatchOnce: TestInterface["dispatchOnce"] = Effect.fn("McpEvents.dispatchOnce")(function* () {
    const started = yield* now
    while (true) {
      const pruned = yield* db.transaction(() => Effect.gen(function* () {
        const rows = yield* db.select({ seq: McpEventOutboxTable.seq, subscriptionID: McpEventOutboxTable.subscription_id })
          .from(McpEventOutboxTable)
          .where(and(lt(McpEventOutboxTable.time_created, started - RETENTION_MS), or(isNotNull(McpEventOutboxTable.delivered_at), eq(McpEventOutboxTable.dead, 1))))
          .orderBy(asc(McpEventOutboxTable.seq)).limit(DISPATCH_BATCH).all()
        if (rows.length === 0) return 0
        const watermarks = new Map<string, number>()
        for (const row of rows) watermarks.set(row.subscriptionID, Math.max(watermarks.get(row.subscriptionID) ?? 0, row.seq))
        for (const [subscriptionID, seq] of watermarks) yield* db.update(McpEventSubscriptionTable)
          .set({ pruned_through: sql`max(${McpEventSubscriptionTable.pruned_through}, ${seq})` })
          .where(eq(McpEventSubscriptionTable.id, subscriptionID)).run()
        yield* db.delete(McpEventOutboxTable).where(inArray(McpEventOutboxTable.seq, rows.map((row) => row.seq))).run()
        return rows.length
      }), { behavior: "immediate" }).pipe(Effect.orDie)
      if (pruned === 0) break
      yield* Effect.yieldNow
    }
    const rows = yield* db
      .select()
      .from(McpEventOutboxTable)
      .where(and(isNull(McpEventOutboxTable.delivered_at), eq(McpEventOutboxTable.dead, 0), lte(McpEventOutboxTable.next_attempt_at, started)))
      .orderBy(asc(McpEventOutboxTable.seq))
      .limit(DISPATCH_BATCH)
      .all()
      .pipe(Effect.orDie)
    const blocked = new Set<string>()
    for (const row of rows) {
      if (blocked.has(row.subscription_id)) continue
      const earlier = yield* db.select({ seq: McpEventOutboxTable.seq }).from(McpEventOutboxTable).where(and(
        eq(McpEventOutboxTable.subscription_id, row.subscription_id),
        lt(McpEventOutboxTable.seq, row.seq),
        isNull(McpEventOutboxTable.delivered_at),
        eq(McpEventOutboxTable.dead, 0),
      )).limit(1).get().pipe(Effect.orDie)
      if (earlier !== undefined) {
        blocked.add(row.subscription_id)
        continue
      }
      const sub = yield* db.select().from(McpEventSubscriptionTable).where(eq(McpEventSubscriptionTable.id, row.subscription_id)).get().pipe(Effect.orDie)
      const current = yield* now
      if (sub === undefined || sub.disabled === 1 || sub.expires_at <= current) {
        yield* db.update(McpEventOutboxTable).set({ dead: 1 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
        continue
      }
      const principal: McpEvents.Principal = { ownerID: sub.owner_id, deviceID: sub.device_id, clientID: sub.client_id, grantID: sub.grant_id, epoch: sub.epoch }
      const checked = yield* deps.authorization.check(principal).pipe(Effect.result)
      if (Result.isFailure(checked)) {
        if (checked.failure.category === "unavailable") {
          yield* db.update(McpEventOutboxTable).set({ next_attempt_at: current + 30_000 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
          yield* Effect.logWarning("MCP Events delivery deferred", {
            subscriptionID: sub.id, eventID: row.id, category: checked.failure.category, reason: checked.failure.reason,
          })
        } else {
          yield* db.update(McpEventSubscriptionTable).set({ disabled: 1, time_updated: current }).where(eq(McpEventSubscriptionTable.id, sub.id)).run().pipe(Effect.orDie)
          yield* db.update(McpEventOutboxTable).set({ dead: 1 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
          yield* Effect.logWarning("MCP Events subscription disabled", {
            subscriptionID: sub.id, eventID: row.id, category: checked.failure.category, reason: checked.failure.reason,
          })
        }
        blocked.add(row.subscription_id)
        continue
      }
      if (checked.success.signal?.aborted || checked.success.expiresAt <= current) {
        yield* db.update(McpEventSubscriptionTable).set({ disabled: 1, time_updated: current }).where(eq(McpEventSubscriptionTable.id, sub.id)).run().pipe(Effect.orDie)
        yield* db.update(McpEventOutboxTable).set({ dead: 1 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
        yield* Effect.logWarning("MCP Events subscription disabled", {
          subscriptionID: sub.id, eventID: row.id,
          category: checked.success.expiresAt <= current ? "unauthorized" : "unavailable",
          reason: checked.success.expiresAt <= current ? "grant_expired" : "authorization_unavailable",
        })
        blocked.add(row.subscription_id)
        continue
      }
      const secretBytes = deps.secretBox.decrypt(sub.secret_ciphertext)
      if (secretBytes === undefined) {
        yield* db.update(McpEventSubscriptionTable).set({ disabled: 1, time_updated: current }).where(eq(McpEventSubscriptionTable.id, sub.id)).run().pipe(Effect.orDie)
        yield* db.update(McpEventOutboxTable).set({ dead: 1 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
        yield* Effect.logWarning("MCP Events subscription disabled", {
          subscriptionID: sub.id, eventID: row.id, category: "unavailable", reason: "secure_storage_unavailable",
        })
        continue
      }
      const secrets = [secretBytes]
      if (sub.previous_secret_ciphertext !== null && sub.previous_secret_until !== null && sub.previous_secret_until > current) {
        const previous = deps.secretBox.decrypt(sub.previous_secret_ciphertext)
        if (previous !== undefined) secrets.push(previous)
      }
      const name = row.name as McpEvents.Name
      const payload = {
        eventId: row.id,
        name,
        timestamp: new Date(row.time_created).toISOString(),
        data: {
          session_id: row.session_id,
          root_session_id: row.root_session_id,
          state: row.state,
          ...(row.request_id === null ? {} : { request_id: row.request_id }),
          ...(row.item_id === null ? {} : { item_id: row.item_id }),
          ...(row.task_id === null ? {} : { task_id: row.task_id }),
          ...(row.category === null ? {} : { category: row.category }),
          ...(row.reason === null ? {} : { reason: row.reason }),
          ...(row.attention === null ? {} : { attention: row.attention }),
        },
        cursor: REPLAYABLE.has(name) ? deps.secretBox.encodeCursor(sub.identity_hash, row.seq) : null,
      }
      const body = JSON.stringify(payload)
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        yield* db.update(McpEventOutboxTable).set({ dead: 1 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
        continue
      }
      const timestampSeconds = Math.floor(current / 1000)
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (checked.success.signal !== undefined) {
        if (checked.success.signal.aborted) controller.abort()
        else checked.success.signal.addEventListener("abort", abort, { once: true })
      }
      const controllers = inflight.get(sub.id) ?? new Set<AbortController>()
      controllers.add(controller)
      inflight.set(sub.id, controllers)
      const sent = yield* deps.transport.send({
        url: sub.callback_url,
        body,
        timeoutMs: 10_000,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "webhook-id": row.id,
          "webhook-timestamp": String(timestampSeconds),
          "webhook-signature": sign({ id: row.id, timestampSeconds, body, secrets }),
          "X-MCP-Subscription-Id": sub.id,
        },
      }).pipe(Effect.result, Effect.ensuring(Effect.sync(() => {
        checked.success.signal?.removeEventListener("abort", abort)
        controllers.delete(controller)
        if (controllers.size === 0) inflight.delete(sub.id)
      })))
      const settledAt = yield* now
      if (Result.isSuccess(sent) && sent.success.status >= 200 && sent.success.status < 300) {
        yield* db.update(McpEventOutboxTable).set({ delivered_at: settledAt }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
        continue
      }
      blocked.add(row.subscription_id)
      const attempts = row.attempts + 1
      const nonRetryable = Result.isSuccess(sent) && (sent.success.status === 410 || sent.success.status === 413)
      yield* Effect.logWarning("MCP Events webhook failed", {
        subscriptionID: sub.id, eventID: row.id, attempt: attempts, terminal: nonRetryable || attempts >= MAX_ATTEMPTS,
        ...(Result.isSuccess(sent) ? { httpStatus: sent.success.status } : { category: sent.failure.category, reason: sent.failure.reason }),
      })
      if (nonRetryable || attempts >= MAX_ATTEMPTS) {
        yield* db.update(McpEventOutboxTable).set({ attempts, dead: 1 }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
      } else {
        const backoff = Math.min(300_000, 5_000 * 2 ** (attempts - 1))
        yield* db.update(McpEventOutboxTable).set({ attempts, next_attempt_at: settledAt + backoff }).where(eq(McpEventOutboxTable.seq, row.seq)).run().pipe(Effect.orDie)
      }
    }
  })

  const reconcile = Effect.gen(function* () {
    const current = yield* now
    const later = alias(McpEventOutboxTable, "later_attention")
    while (true) {
      const rows = yield* db
        .select()
        .from(McpEventOutboxTable)
        .where(and(
          eq(McpEventOutboxTable.state, "pending"),
          inArray(McpEventOutboxTable.name, [...EPHEMERAL_ATTENTION]),
          or(isNull(McpEventOutboxTable.attention), sql`json_extract(${McpEventOutboxTable.attention}, '$.kind') <> 'subagent_question'`),
          isNotNull(McpEventOutboxTable.request_id),
          notExists(db.select({ seq: later.seq }).from(later).where(and(
            eq(later.subscription_id, McpEventOutboxTable.subscription_id),
            eq(later.session_id, McpEventOutboxTable.session_id),
            eq(later.request_id, McpEventOutboxTable.request_id),
            gt(later.seq, McpEventOutboxTable.seq),
          ))),
        ))
        .limit(DISPATCH_BATCH)
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) break
      for (const row of rows) {
        yield* db
          .insert(McpEventOutboxTable)
          .values({
            id: `evt_${randomBytes(16).toString("hex")}`,
            subscription_id: row.subscription_id,
            dedupe_key: `${row.dedupe_key}:restart-cancelled`,
            name: row.name,
            session_id: row.session_id,
            root_session_id: row.root_session_id,
            state: "cancelled",
            request_id: row.request_id,
            item_id: row.item_id,
            task_id: row.task_id,
            category: row.category,
            reason: "restart",
            attention: row.attention === null ? null : McpEvents.Attention.make({ ...row.attention, actions: ["inspect"] }),
            time_created: current,
            attempts: 0,
            next_attempt_at: current,
            dead: 0,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
      yield* Effect.yieldNow
    }
  })
  yield* reconcile

  return {
    status: () => deps.authorization.capabilities.pipe(Effect.map((available) => ({ available }))),
    list: () => Effect.succeed({ events: McpEvents.Definitions }),
    subscribe: (input) => {
      const requestHash = typeof input.context?.requestID === "string" && input.context.requestID.length <= 256
        ? deps.secretBox.fingerprint(Buffer.from(input.context.requestID)) : undefined
      return mutations.withPermit(subscribe(input)).pipe(
        Effect.tap((result) => Effect.logInfo("MCP Events subscription active", { requestHash, subscriptionID: result.id })),
        Effect.tapCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.void
          const failure = Cause.findError(cause)
          return Effect.logWarning("MCP Events subscription failed", {
            requestHash,
            category: Result.isSuccess(failure) ? failure.success.category : "unavailable",
            reason: Result.isSuccess(failure) ? failure.success.reason : "service_unavailable",
          })
        }),
      )
    },
    unsubscribe: (input) => mutations.withPermit(unsubscribe(input)),
    capture,
    dispatchOnce,
    rows: () => Effect.gen(function* () {
      const current = yield* now
      const countOf = (effect: Effect.Effect<{ value: number } | undefined>) => effect.pipe(Effect.map((row) => row?.value ?? 0))
      const subscriptions = yield* countOf(db.select({ value: count() }).from(McpEventSubscriptionTable).get().pipe(Effect.orDie))
      const all = yield* db.select().from(McpEventSubscriptionTable).all().pipe(Effect.orDie)
      const outbox = yield* countOf(db.select({ value: count() }).from(McpEventOutboxTable).get().pipe(Effect.orDie))
      const pending = yield* countOf(db.select({ value: count() }).from(McpEventOutboxTable).where(isNull(McpEventOutboxTable.delivered_at)).get().pipe(Effect.orDie))
      return { subscriptions, activeSubscriptions: all.filter((sub) => sub.disabled === 0 && sub.expires_at > current).length, outbox, pending }
    }),
  }
})

const layer = Layer.effect(Service, Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const store = yield* SessionStore.Service
  const authorization = yield* AuthorizationService
  const transport = yield* McpEventsHttp.Service
  const secretBoxService = yield* McpEventsSecretBox.Service
  const box = yield* secretBoxService.get.pipe(Effect.result)
  if (Result.isFailure(box)) {
    const failure = box.failure
    return Service.of({
      status: () => Effect.succeed({ available: false }),
      list: () => Effect.succeed({ events: McpEvents.Definitions }),
      subscribe: () => Effect.fail(failure),
      unsubscribe: () => Effect.fail(failure),
    })
  }
  const svc = yield* make({
    db: database.db,
    authorization,
    transport,
    secretBox: box.success,
    session: (id) => store.get(id as SessionSchema.ID).pipe(
      Effect.map((info) => info === undefined ? undefined : { id: String(info.id), parentID: info.parentID === undefined ? undefined : String(info.parentID) }),
    ),
  })
  const faults = new Set<"capture" | "dispatch">()
  const observe = (operation: "capture" | "dispatch", effect: Effect.Effect<void>) => effect.pipe(
    Effect.tap(() => Effect.sync(() => faults.delete(operation))),
    Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), () => Effect.gen(function* () {
      if (!faults.has(operation)) yield* Effect.logError(`MCP Events ${operation} failed`)
      faults.add(operation)
    })),
  )
  const remove = yield* events.listen((event) => observe("capture",
    svc.capture({ type: event.type, id: String(event.id), data: event.data as unknown as Record<string, unknown> }),
  ))
  yield* Effect.addFinalizer(() => remove)
  yield* Effect.forkScoped(
    Effect.forever(observe("dispatch", svc.dispatchOnce()).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1))))),
  )
  return Service.of({
    status: () => svc.status().pipe(Effect.map((status) => ({ available: status.available && faults.size === 0 }))),
    list: svc.list,
    subscribe: svc.subscribe,
    unsubscribe: svc.unsubscribe,
  })
}))

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, SessionStore.node, authorizationNode, McpEventsHttp.node, McpEventsSecretBox.node],
})

export const layerWith = (deps: Dependencies) => Layer.effect(Service, make(deps).pipe(
  Effect.map((svc) => Service.of({ status: svc.status, list: svc.list, subscribe: svc.subscribe, unsubscribe: svc.unsubscribe })),
))
