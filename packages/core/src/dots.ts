export * as DotsRuntime from "./dots"

import { Dots } from "@ycoding-ai/schema/dots"
import { Cause, Context, Deferred, Effect, Exit, Option, Schema, Scope, Semaphore, Stream, type Duration } from "effect"
import type { Database } from "./database/database"
import type { DotsAttachments } from "./dots/attachments"
import { Hash } from "./util/hash"
import type { DotsTransport } from "./dots/transport"
import { Integration } from "./integration"
import type { IntegrationConnection } from "./integration/connection"
import { OpenAICodex } from "./plugin/provider/openai-codex"
import type { Session } from "./session"
import type { SessionMessage } from "./session/message"
import { SessionPending } from "./session/pending"
import type { SessionSchema } from "./session/schema"

export class Error extends Schema.TaggedErrorClass<Error>()("DotsRuntime.Error", {
  code: Dots.ErrorCode,
  message: Schema.String,
}) {}

export interface PeerAdmission {
  readonly sessionID: SessionSchema.ID
  readonly id: SessionMessage.ID
  readonly text: string
  readonly description: string
  readonly metadata: { readonly dots: Dots.Peer }
}

export interface Interface {
  readonly withBinding: <A, E, R>(sessionID: SessionSchema.ID, use: (binding: BindingAuthority) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, R>
  readonly attachment: (sessionID: SessionSchema.ID) => Effect.Effect<{ readonly target: Dots.Target; readonly accountDigest: string }, Error>
  readonly targets: (profile: string) => Effect.Effect<Dots.Target[], Error>
  readonly bind: (input: {
    readonly sessionID: SessionSchema.ID
    readonly target: Dots.Target
  }) => Effect.Effect<Dots.Status, Error>
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Dots.Status, Error>
  readonly send: (input: { readonly sessionID: SessionSchema.ID } & Dots.Send) => Effect.Effect<Dots.Delivery, Error>
  readonly pause: (input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.Effect<Dots.Status, Error>
  readonly resume: (input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.Effect<Dots.Status, Error>
  readonly unbind: (input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.Effect<Dots.Status, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/DotsRuntime") {}

const integrationID = Integration.ID.make("openai")

interface Account {
  readonly key: string
  readonly connection: IntegrationConnection.Info
  readonly credentialID: string
  readonly accountGeneration: number
  readonly accountID: string
}

interface Client {
  readonly account: Account
  readonly scope: Scope.Closeable
  ready: Deferred.Deferred<void>
  readonly threads: Map<string, SessionSchema.ID>
  readonly seen: Map<string, Set<string>>
  readonly buffered: Map<string, DotsTransport.Inbound[]>
  state: Dots.State
  error?: string
  connection?: DotsTransport.Connection
}

interface Binding {
  target: Dots.Target
  readonly client: Client
  runtimeState?: Dots.RuntimeState
  control?: "pending" | "unknown"
  readonly authority: BindingAuthority
}

export interface DelegationGrant {
  readonly anchorSessionID: SessionSchema.ID
  readonly info: Dots.DelegationInfo
  readonly bindingID: string
  readonly accountDigest: string
  readonly target: Dots.Target
  readonly taskFence?: string
  readonly ownerFence: string
  readonly nativeScope: Dots.ExchangeRecord["scope"]
}

export interface BindingAuthority {
  readonly incarnation: string
  target: Dots.Target
  accountDigest: string
  readonly grants: Map<string, DelegationGrant>
  readonly proposals: Map<string, { readonly fingerprint: string; readonly result: Deferred.Deferred<Dots.DelegationInfo, Error> }>
}

export interface Persistence {
  readonly binding: (sessionID: SessionSchema.ID) => Effect.Effect<Dots.BindingRecord | undefined>
  readonly bind: (sessionID: SessionSchema.ID, target: Dots.Target, accountDigest: string) => Effect.Effect<Dots.BindingRecord, Error>
  readonly unbind: (sessionID: SessionSchema.ID, bindingID: string) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

export const make = Effect.fn("DotsRuntime.make")(function* (options: {
  readonly integration: Pick<Integration.Interface, "get" | "connection">
  readonly transport: DotsTransport.Interface
  readonly attachments: DotsAttachments.Read
  readonly sessions: {
    readonly exists: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
    readonly admit: (input: PeerAdmission) => Effect.Effect<void>
  }
  readonly retryDelay?: (attempt: number) => Duration.Input
  readonly enabled?: () => Effect.Effect<boolean>
  readonly changes?: Stream.Stream<unknown>
  readonly persistence?: Persistence
}) {
  const lifetime = yield* Effect.scope
  const lock = Semaphore.makeUnsafe(1)
  const clients = new Map<string, Client>()
  const bindings = new Map<SessionSchema.ID, Binding>()
  const inflight = new Map<string, Deferred.Deferred<Dots.Delivery, Error>>()
  const outcomes = new Map<string, Dots.Delivery>()
  const retryDelay = options.retryDelay ?? ((attempt: number) => Math.min(1_000 * 2 ** attempt, 30_000))

  const allowed = Effect.suspend(() => options.enabled?.() ?? Effect.succeed(false)).pipe(
    Effect.catchDefect(() => Effect.succeed(false)),
  )

  const requireEnabled = Effect.gen(function* () {
    if (yield* allowed) return
    yield* invalidate
    return yield* fail("feature_disabled", disabledMessage)
  })

  const disable: Effect.Effect<void> = Effect.suspend(() => {
    const closing = [...clients.values()]
    bindings.clear()
    clients.clear()
    return Effect.forEach(
      closing,
      (client) =>
        Scope.close(client.scope, Exit.void).pipe(Effect.andThen(Deferred.succeed(client.ready, undefined))),
      { discard: true },
    )
  })

  const invalidate = Effect.suspend(() => options.persistence?.clear() ?? Effect.void).pipe(Effect.andThen(disable))
  const disabledStatus = invalidate.pipe(Effect.as({ enabled: false, state: "disconnected" } satisfies Dots.Status))
  yield* Effect.addFinalizer(() => disable)

  const disableSoon = invalidate.pipe(Effect.forkIn(lifetime), Effect.asVoid)

  const resolve = Effect.fn("DotsRuntime.resolve")(function* (profile: string) {
    const integration = yield* options.integration.get(integrationID)
    const connection = integration?.connections.find((item) => item.type === "credential" && item.label === profile)
    if (!connection)
      return yield* fail("profile_unavailable", "Dots requires a connected ChatGPT profile with that name.")
    return yield* authorize({ connection })
  })

  const authorize = Effect.fn("DotsRuntime.authorize")(function* (input: {
    readonly connection: IntegrationConnection.Info
    readonly rejectedAccessToken?: string
  }) {
    const snapshot = yield* options.integration.connection
      .snapshot(
        input.connection,
        input.rejectedAccessToken ? { rejectedAccessToken: input.rejectedAccessToken } : undefined,
      )
      .pipe(Effect.mapError(() => new Error({ code: "authentication_failed", message: authenticationMessage })))
    const accountID = OpenAICodex.accountID(snapshot.value)
    if (!snapshot.credential || snapshot.value?.type !== "oauth" || !accountID)
      return yield* fail(
        "profile_unavailable",
        "Dots requires ChatGPT OAuth with an account identity; reconnect that profile.",
      )
    const account: Account = {
      key: [snapshot.credential.id, snapshot.credential.accountGeneration, accountID].join("\0"),
      connection: input.connection,
      credentialID: snapshot.credential.id,
      accountGeneration: snapshot.credential.accountGeneration,
      accountID,
    }
    return { account, credentials: { access: snapshot.value.access, accountID } }
  })

  const current = Effect.fn("DotsRuntime.current")(function* (account: Account, rejectedAccessToken?: string) {
    const resolved = yield* authorize({ connection: account.connection, rejectedAccessToken })
    if (resolved.account.key !== account.key)
      return yield* fail("profile_changed", "The confirmed ChatGPT profile changed accounts; confirm the Dot again.")
    return resolved.credentials
  })

  const authorized = <A>(
    account: Account,
    first: DotsTransport.Credentials,
    use: (credentials: DotsTransport.Credentials) => Effect.Effect<A, DotsTransport.Error, Scope.Scope>,
  ) =>
    use(first).pipe(
      Effect.catchIf(
        (error) => error.reason === "unauthorized",
        () => current(account, first.access).pipe(Effect.flatMap(use)),
      ),
    )

  const destinations = Effect.fn("DotsRuntime.destinations")(function* (profile: string) {
    const resolved = yield* resolve(profile)
    const found = yield* Effect.scoped(
      authorized(resolved.account, resolved.credentials, (credentials) => options.transport.destinations(credentials)),
    ).pipe(Effect.mapError(transportFailure("target_unavailable")))
    return {
      account: resolved.account,
      targets: found.map(
        (item): Dots.Target => ({
          profile,
          dotID: item.dotID,
          threadID: item.threadID,
          generation: item.generation,
          label: item.label,
        }),
      ),
    }
  })

  const statusOf = (binding: Binding | undefined, runtimeState = binding?.runtimeState): Dots.Status => {
    if (!binding) return { enabled: true, state: "disconnected" }
    const client = binding.client
    return {
      enabled: true,
      target: binding.target,
      state:
        client.state === "connected" &&
        (!client.seen.has(binding.target.threadID) || client.buffered.has(binding.target.threadID))
          ? "connecting"
          : client.state,
      ...(client.state === "failed" && client.error ? { error: client.error } : {}),
      runtimeState: binding.control || client.state !== "connected" || !client.connection || !client.seen.has(binding.target.threadID) || client.buffered.has(binding.target.threadID) ? "unknown" : runtimeState ?? "unknown",
    }
  }

  const readStatus = (sessionID: SessionSchema.ID) => Effect.gen(function* () {
    if (!(yield* allowed)) return yield* disabledStatus
    yield* restoreBinding(sessionID)
    const binding = bindings.get(sessionID)
    if (!binding || binding.control) return statusOf(binding)
    const state = yield* current(binding.client.account).pipe(
      Effect.flatMap((credentials) => options.transport.runtimeState(credentials, binding.target)),
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.succeed("unknown" as const) }),
      Effect.catch(() => Effect.succeed("unknown" as const)),
    )
    if (!(yield* allowed)) return yield* disabledStatus
    if (bindings.get(sessionID) !== binding) return statusOf(bindings.get(sessionID))
    return statusOf(binding, state)
  })

  const settle = (client: Client, state: Dots.State, error?: string) =>
    Effect.gen(function* () {
      client.state = state
      client.error = error
      if (state !== "connected") {
        client.connection = undefined
      }
      yield* Deferred.succeed(client.ready, undefined)
    })

  const attempt = (client: Client) =>
    Effect.gen(function* () {
      const credentials = yield* current(client.account)
      const connection = yield* authorized(client.account, credentials, (value) =>
        options.transport.connect(value),
      ).pipe(Effect.mapError(transportFailure("connection_unavailable")))
      const subscribed = new Set<string>()
      while (true) {
        const pending = [...client.threads.keys()].filter(
          (threadID) => !subscribed.has(threadID) || !client.seen.has(threadID),
        )
        if (pending.length === 0) break
        for (const threadID of pending) {
          yield* subscribe(client, connection, threadID)
          subscribed.add(threadID)
        }
      }
      client.connection = connection
      yield* settle(client, "connected")
      yield* Stream.runForEach(connection.inbound, (event) => receive(client, event)).pipe(
        Effect.mapError(transportFailure("connection_unavailable")),
      )
    })

  const run = (client: Client) =>
    Effect.gen(function* () {
      let failures = 0
      while (true) {
        if (!(yield* allowed)) return yield* disableSoon
        const exit = yield* Effect.scoped(attempt(client)).pipe(Effect.exit)
        const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        if (failure && terminal.has(failure.code)) return yield* settle(client, "failed", failure.message)
        failures = Exit.isSuccess(exit) ? 0 : failures + 1
        yield* settle(client, "connecting")
        yield* Effect.sleep(retryDelay(failures))
      }
    })

  const start = Effect.fn("DotsRuntime.start")(function* (client: Client) {
    client.state = "connecting"
    client.error = undefined
    client.ready = yield* Deferred.make<void>()
    yield* run(client).pipe(Effect.forkIn(client.scope, { startImmediately: true }))
  })

  const subscribe = Effect.fn("DotsRuntime.subscribe")(function* (
    client: Client,
    connection: DotsTransport.Connection,
    threadID: string,
  ) {
    const snapshot = yield* connection
      .subscribe(threadID)
      .pipe(Effect.mapError(transportFailure("connection_unavailable")))
    const sessionID = client.threads.get(threadID)
    if (sessionID === undefined) return
    const events = snapshot.filter((event) => event.threadID === threadID && event.type !== "message.delta")
    if (client.seen.has(threadID)) {
      yield* Effect.forEach(events, (event) => handle(sessionID, event), { discard: true })
    } else {
      const seeded = new Set<string>()
      for (const event of events) if (event.type === "message") seeded.add(event.itemID)
      client.seen.set(threadID, seeded)
      for (const event of events) {
        if (event.type === "message.snapshot") yield* handle(sessionID, event)
        if (event.type === "user.message") {
          reconcile(sessionID, event.clientMessageID, event.turnID)
        }
      }
    }
    const buffered = client.buffered.get(threadID)
    for (let event = buffered?.shift(); event; event = buffered?.shift()) yield* handle(sessionID, event)
    client.buffered.delete(threadID)
  })

  const receive = (client: Client, event: DotsTransport.Inbound) =>
    Effect.gen(function* () {
      const sessionID = client.threads.get(event.threadID)
      if (sessionID === undefined) return
      const buffered = client.buffered.get(event.threadID)
      if (buffered) {
        buffered.push(event)
        return
      }
      yield* handle(sessionID, event)
    })

  const handle = (sessionID: SessionSchema.ID, event: DotsTransport.Inbound) =>
    Effect.gen(function* () {
      if (event.type === "user.message") {
        reconcile(sessionID, event.clientMessageID, event.turnID)
      }
    })

  const reconcile = (sessionID: SessionSchema.ID, messageID: string, turnID?: string) => {
    const key = `${sessionID}\0${messageID}`
    if (outcomes.get(key)?.status === "unknown")
      outcomes.set(key, { messageID, status: "accepted", ...(turnID === undefined ? {} : { turnID }) })
  }

  const open = Effect.fn("DotsRuntime.open")(function* (account: Account) {
    const scope = yield* Scope.fork(lifetime)
    const client: Client = {
      account,
      scope,
      ready: yield* Deferred.make<void>(),
      threads: new Map(),
      seen: new Map(),
      buffered: new Map(),
      state: "connecting",
    }
    clients.set(account.key, client)
    return client
  })

  const release = Effect.fn("DotsRuntime.release")(function* (sessionID: SessionSchema.ID, binding: Binding) {
    bindings.delete(sessionID)
    const threadID = binding.target.threadID
    binding.client.threads.delete(threadID)
    binding.client.seen.delete(threadID)
    binding.client.buffered.delete(threadID)
    if (binding.client.threads.size > 0) return
    if (clients.get(binding.client.account.key) === binding.client) clients.delete(binding.client.account.key)
    yield* Scope.close(binding.client.scope, Exit.void)
    yield* Deferred.succeed(binding.client.ready, undefined)
  })

  const deliver = Effect.fn("DotsRuntime.deliver")(function* (
    binding: Binding,
    input: { readonly sessionID: SessionSchema.ID } & Dots.Send,
    dispatch: () => void,
  ) {
    const client = binding.client
    const files = yield* Effect.forEach(input.files ?? [], options.attachments).pipe(
      Effect.mapError((error) => new Error({ code: "attachment_invalid", message: error.message })),
    )
    yield* requireEnabled
    yield* current(client.account)
    const offered = yield* destinations(binding.target.profile)
    if (offered.account.key !== client.account.key)
      return yield* fail("profile_changed", "The confirmed ChatGPT profile changed accounts; confirm the Dot again.")
    if (!offered.targets.some((target) => sameTarget(target, binding.target)))
      return yield* fail("target_changed", targetChangedMessage)
    yield* current(client.account)
    yield* requireEnabled
    if (bindings.get(input.sessionID) !== binding) return yield* fail("target_changed", targetChangedMessage)
    const connection =
      client.state === "connected" &&
      client.seen.has(binding.target.threadID) &&
      !client.buffered.has(binding.target.threadID)
        ? client.connection
        : undefined
    if (!connection) return yield* fail("connection_unavailable", unavailableMessage(client))
    dispatch()
    const receipt = yield* connection
      .send({
        threadID: binding.target.threadID,
        messageID: input.id,
        groupID: crypto.randomUUID(),
        ...(input.causalMessageID === undefined ? {} : { causalMessageID: input.causalMessageID }),
        text: input.text,
        files,
      })
      .pipe(
        Effect.catchIf(
          (error) => error.reason === "disconnected",
          () => Effect.succeed<DotsTransport.Receipt>({ status: "unknown" }),
        ),
        Effect.mapError(transportFailure("send_failed")),
      )
    return {
      messageID: input.id,
      status: receipt.status,
      ...(receipt.turnID === undefined ? {} : { turnID: receipt.turnID }),
    } satisfies Dots.Delivery
  })

  const control = (action: "pause" | "resume", input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* requireEnabled
    yield* restoreBinding(input.sessionID)
    const binding = bindings.get(input.sessionID)
    if (!binding) return yield* fail("not_bound", "Confirm a Dot for this Session before controlling its runtime.")
    if (!sameTarget(binding.target, input.expectedTarget)) return yield* fail("target_changed", targetChangedMessage)
    const ready = () => binding.client.state === "connected" && binding.client.connection !== undefined && binding.client.seen.has(binding.target.threadID) && !binding.client.buffered.has(binding.target.threadID)
    if (!ready()) return yield* fail("connection_unavailable", unavailableMessage(binding.client))
    if (binding.control) return yield* fail("runtime_unknown", "A Dots control is pending or its outcome is unknown; explicitly confirm the Dot before another attempt.")
    binding.control = "pending"
    let dispatched = false
    const isCurrent = () => bindings.get(input.sessionID) === binding && sameTarget(binding.target, input.expectedTarget) && ready()
    const validate = () => requireEnabled.pipe(Effect.andThen(Effect.suspend(() =>
      bindings.get(input.sessionID) !== binding || !sameTarget(binding.target, input.expectedTarget)
        ? fail("target_changed", targetChangedMessage)
        : !ready() ? fail("connection_unavailable", unavailableMessage(binding.client)) : Effect.void)))
    return yield* restore(Effect.gen(function* () {
      const first = yield* current(binding.client.account)
      const state = yield* options.transport.runtimeState(first, binding.target).pipe(
        Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => fail("runtime_unknown", "The Dot runtime state could not be read in time.") }),
        Effect.mapError(transportFailure("control_failed")),
      )
      yield* validate()
      if (state !== (action === "pause" ? "unpaused" : "paused"))
        return yield* fail("runtime_unknown", `The Dot must be ${action === "pause" ? "unpaused" : "paused"} before this control can run.`)
      const credentials = yield* current(binding.client.account)
      yield* validate()
      const confirmed = yield* options.transport.control(credentials, { dotID: binding.target.dotID, threadID: binding.target.threadID, action }, isCurrent, () => { dispatched = true }).pipe(
        Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => fail("control_failed", "The Dot runtime control outcome is unknown; confirm the Dot before another attempt.") }),
        Effect.mapError(transportFailure("control_failed")),
      )
      yield* validate()
      if (confirmed !== (action === "pause" ? "paused" : "unpaused"))
        return yield* fail("control_failed", "The Dot runtime change could not be confirmed.")
      binding.runtimeState = confirmed
      binding.control = undefined
      return statusOf(binding)
    })).pipe(Effect.onExit((exit) => Effect.sync(() => {
      if (Exit.isFailure(exit)) {
        binding.runtimeState = "unknown"
        binding.control = dispatched ? "unknown" : undefined
      }
    })))
  }))

  if (options.changes)
    yield* options.changes.pipe(
      Stream.runForEach(() => allowed.pipe(Effect.flatMap((on) => (on ? Effect.void : invalidate)))),
      Effect.forkIn(lifetime, { startImmediately: true }),
    )

  const restoreBinding = Effect.fn("DotsRuntime.restoreBinding")(function* (sessionID: SessionSchema.ID) {
    if (bindings.has(sessionID) || !options.persistence) return
    const saved = yield* options.persistence.binding(sessionID)
    if (!saved) return
    const account = yield* resolve(saved.target.profile)
    if (Hash.sha256(account.account.key) !== saved.accountDigest) {
      yield* options.persistence.unbind(sessionID, saved.id)
      return yield* fail("profile_changed", "The bound ChatGPT profile changed accounts; confirm the Dot again.")
    }
    yield* service.bind({ sessionID, target: saved.target })
  })

  const service: Interface = Service.of({
    withBinding: (sessionID, use) => Effect.gen(function* () {
      yield* requireEnabled
      yield* restoreBinding(sessionID)
      const binding = bindings.get(sessionID)
      if (!binding) return yield* fail("not_bound", "Confirm a Dot for this Session before delegating.")
      const account = yield* resolve(binding.target.profile)
      return yield* lock.withPermits(1)(Effect.gen(function* () {
        yield* requireEnabled
        if (binding !== bindings.get(sessionID) || account.account.key !== binding.client.account.key)
          return yield* fail("target_changed", targetChangedMessage)
        if (options.persistence && (yield* options.persistence.binding(sessionID))?.id !== binding.authority.incarnation)
          return yield* fail("target_changed", targetChangedMessage)
        binding.authority.target = binding.target
        return yield* use(binding.authority)
      }))
    }),
    attachment: Effect.fn("DotsRuntime.attachment")(function* (sessionID) {
      yield* requireEnabled
      yield* restoreBinding(sessionID)
      const binding = bindings.get(sessionID)
      if (!binding) return yield* fail("not_bound", "Confirm a Dot for this Session before creating an exchange.")
      const found = yield* destinations(binding.target.profile)
      if (found.account.key !== binding.client.account.key) return yield* fail("profile_changed", "The confirmed ChatGPT account changed.")
      if (!found.targets.some((target) => sameTarget(target, binding.target))) return yield* fail("target_changed", targetChangedMessage)
      if (binding !== bindings.get(sessionID)) return yield* fail("target_changed", targetChangedMessage)
      return { target: binding.target, accountDigest: Hash.sha256(binding.client.account.key) }
    }),
    targets: Effect.fn("DotsRuntime.targets")(function* (profile) {
      yield* requireEnabled
      return (yield* destinations(profile)).targets
    }),
    bind: Effect.fn("DotsRuntime.bind")(function* (input) {
      yield* requireEnabled
      if (!(yield* options.sessions.exists(input.sessionID)))
        return yield* fail("session_not_found", "The Session does not exist.")
      const found = yield* destinations(input.target.profile)
      const offered = found.targets.find((item) => sameTarget(item, input.target))
      if (!offered)
        return yield* fail("target_unavailable", "That Dot conversation is no longer offered by the profile.")
      const target = { ...offered, label: input.target.label.trim() || offered.label }
      const client = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireEnabled
          const existing = bindings.get(input.sessionID)
          if (existing && existing.client.account.key === found.account.key && sameTarget(existing.target, target) &&
            (!options.persistence || (yield* options.persistence.binding(input.sessionID))?.id === existing.authority.incarnation)) {
            if (existing.control === "pending") return yield* fail("runtime_unknown", "A Dots runtime control is still pending.")
            existing.target = target
            existing.control = undefined
            existing.runtimeState = undefined
            if (existing.client.state === "failed") yield* start(existing.client)
            return existing.client
          }
          const owner = clients.get(found.account.key)?.threads.get(target.threadID)
          if (owner !== undefined && owner !== input.sessionID)
            return yield* fail("target_in_use", "Another Session is already confirmed for that Dot conversation.")
          const saved = yield* (options.persistence?.bind(input.sessionID, target, Hash.sha256(found.account.key)) ?? Effect.succeed(undefined))
          if (existing) yield* release(input.sessionID, existing)
          const reused = clients.get(found.account.key)
          const connection = reused?.state === "connected" ? reused.connection : undefined
          const client = reused ?? (yield* open(found.account))
          client.buffered.set(target.threadID, [])
          client.threads.set(target.threadID, input.sessionID)
          const binding: Binding = { target, client, authority: { incarnation: saved?.id ?? crypto.randomUUID(), target,
            accountDigest: Hash.sha256(client.account.key), grants: new Map(), proposals: new Map() } }
          bindings.set(input.sessionID, binding)
          if (!reused || reused.state === "failed") yield* start(client)
          if (connection)
            yield* subscribe(client, connection, target.threadID).pipe(
              Effect.tapError(() => release(input.sessionID, binding)),
            )
          return client
        }),
      )
      yield* Deferred.await(client.ready)
      yield* requireEnabled
      return yield* readStatus(input.sessionID)
    }),
    status: readStatus,
    send: Effect.fn("DotsRuntime.send")(function* (input) {
      yield* requireEnabled
      yield* restoreBinding(input.sessionID)
      if (input.text.trim() === "" && (input.files?.length ?? 0) === 0)
        return yield* fail("invalid_input", "Enter a message or attach a file to send.")
      const binding = bindings.get(input.sessionID)
      if (!binding) return yield* fail("not_bound", "Confirm a Dot for this Session before sending.")
      if (!sameTarget(binding.target, input.expectedTarget)) return yield* fail("target_changed", targetChangedMessage)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const key = `${input.sessionID}\0${input.id}`
          const settled = outcomes.get(key)
          if (settled) return settled
          const prior = inflight.get(key)
          if (prior) return yield* restore(Deferred.await(prior))
          const pending = yield* Deferred.make<Dots.Delivery, Error>()
          inflight.set(key, pending)
          let dispatched = false
          const exit = yield* restore(
            deliver(binding, input, () => {
              dispatched = true
            }),
          ).pipe(Effect.exit)
          inflight.delete(key)
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
            if (dispatched) {
              const unknown: Dots.Delivery = { messageID: input.id, status: "unknown" }
              outcomes.set(key, unknown)
              yield* Deferred.succeed(pending, unknown)
            } else
              yield* Deferred.fail(
                pending,
                new Error({ code: "send_failed", message: "The Dots send was cancelled before dispatch." }),
              )
            return yield* exit
          }
          if (Exit.isSuccess(exit)) outcomes.set(key, exit.value)
          yield* Deferred.done(pending, exit)
          return yield* exit
        }),
      )
    }),
    pause: (input) => control("pause", input),
    resume: (input) => control("resume", input),
    unbind: Effect.fn("DotsRuntime.unbind")(function* (input) {
      if (!(yield* allowed)) return yield* disabledStatus
      if (!(yield* options.sessions.exists(input.sessionID)))
        return yield* fail("session_not_found", "The Session does not exist.")
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* allowed)) return yield* disabledStatus
          const binding = bindings.get(input.sessionID)
          if (!binding) {
            const saved = yield* (options.persistence?.binding(input.sessionID) ?? Effect.succeed(undefined))
            if (!saved) return statusOf(undefined)
            if (!sameTarget(saved.target, input.expectedTarget)) return yield* fail("target_changed", targetChangedMessage)
            yield* options.persistence!.unbind(input.sessionID, saved.id)
            return statusOf(undefined)
          }
          if (!sameTarget(binding.target, input.expectedTarget)) return yield* fail("target_changed", targetChangedMessage)
          if (options.persistence) yield* options.persistence.unbind(input.sessionID, binding.authority.incarnation)
          yield* release(input.sessionID, binding)
          return statusOf(undefined)
        }),
      )
    }),
  })
  return service
})

export const admitPeer = Effect.fn("DotsRuntime.admitPeer")(function* (
  deps: { readonly db: Database.Interface["db"]; readonly sessions: Pick<Session.Interface, "synthetic"> },
  input: PeerAdmission,
) {
  const prior = yield* SessionPending.lookup(deps.db, input.sessionID, input.id).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(defect) : Effect.die(defect),
    ),
  )
  if (prior !== undefined) return "duplicate" as const
  return yield* deps.sessions
    .synthetic({
      id: input.id,
      sessionID: input.sessionID,
      text: input.text,
      description: input.description,
      metadata: input.metadata,
      delivery: "steer",
    })
    .pipe(
      Effect.as("admitted" as const),
      Effect.catchTag("Session.NotFoundError", () => Effect.succeed("missing" as const)),
      Effect.catchTag("Session.SyntheticConflictError", () => Effect.succeed("duplicate" as const)),
    )
})

const terminal = new Set<Dots.ErrorCode>(["profile_unavailable", "profile_changed", "authentication_failed"])

const disabledMessage = "Dots is disabled; set dots.enabled to true in the YCoding configuration to use it."

const targetChangedMessage = "The Session's confirmed Dot changed; confirm the destination again."

const authenticationMessage = "ChatGPT did not authorize this profile for Dots; reconnect that profile."

const fail = (code: Dots.ErrorCode, message: string) => Effect.fail(new Error({ code, message }))

const sameTarget = (left: Dots.Target, right: Dots.Target) =>
  left.profile === right.profile &&
  left.dotID === right.dotID &&
  left.threadID === right.threadID &&
  left.generation === right.generation

const unavailableMessage = (client: Client) =>
  client.state === "failed" && client.error ? client.error : "The Dots connection is not ready; try again shortly."

const transportFailure = (code: Dots.ErrorCode) => (error: DotsTransport.Error | Error) => {
  if (error instanceof Error) return error
  if (error.reason === "unauthorized")
    return new Error({ code: "authentication_failed", message: authenticationMessage })
  if (error.reason === "target-changed") return new Error({ code: "target_changed", message: targetChangedMessage })
  return new Error({ code, message: transportMessages[error.reason] })
}

const transportMessages: Record<DotsTransport.Error["reason"], string> = {
  unauthorized: authenticationMessage,
  unavailable: "The Dots service is unavailable; try again shortly.",
  rejected: "The Dots service rejected the request.",
  disconnected: "The Dots connection closed before the request completed.",
  "invalid-response": "The Dots service returned a response YCoding cannot read.",
  "target-changed": targetChangedMessage,
}
