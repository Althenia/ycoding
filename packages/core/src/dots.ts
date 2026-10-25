export * as DotsRuntime from "./dots"

import { Dots } from "@ycoding-ai/schema/dots"
import { Cause, Context, Deferred, Effect, Exit, Option, Schema, Scope, Semaphore, Stream, type Duration } from "effect"
import type { Database } from "./database/database"
import type { DotsAttachments } from "./dots/attachments"
import { DotsPeer } from "./dots/peer"
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
  readonly targets: (profile: string) => Effect.Effect<Dots.Target[], Error>
  readonly bind: (input: {
    readonly sessionID: SessionSchema.ID
    readonly target: Dots.Target
  }) => Effect.Effect<Dots.Status, Error>
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Dots.Status, Error>
  readonly send: (input: { readonly sessionID: SessionSchema.ID } & Dots.Send) => Effect.Effect<Dots.Delivery, Error>
  readonly pause: (input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.Effect<Dots.Status, Error>
  readonly resume: (input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.Effect<Dots.Status, Error>
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
  readonly turns: Map<string, { readonly threadID: string; readonly causalMessageID?: string }>
  readonly seen: Map<string, Set<string>>
  readonly buffered: Map<string, DotsTransport.Inbound[]>
  readonly partials: Map<
    string,
    {
      readonly threadID: string
      readonly turnID?: string
      readonly itemID: string
      readonly causalMessageID?: string
      text: string
    }
  >
  state: Dots.State
  error?: string
  connection?: DotsTransport.Connection
}

interface Binding {
  readonly target: Dots.Target
  readonly client: Client
  runtimeState?: Dots.RuntimeState
  control?: "pending" | "unknown"
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
    yield* disable
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

  const disabledStatus = disable.pipe(Effect.as({ enabled: false, state: "disconnected" } satisfies Dots.Status))

  const disableSoon = disable.pipe(Effect.forkIn(lifetime), Effect.asVoid)

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
      yield* Effect.forEach(events, (event) => handle(client, sessionID, event), { discard: true })
    } else {
      const seeded = new Set<string>()
      for (const event of events) if (event.type === "message") seeded.add(event.itemID)
      client.seen.set(threadID, seeded)
      for (const event of events) {
        if (event.type === "message.snapshot") yield* handle(client, sessionID, event)
        if (event.type === "user.message") {
          reconcile(sessionID, event.clientMessageID, event.turnID)
          if (event.turnID !== undefined)
            client.turns.set(event.turnID, { threadID, causalMessageID: event.clientMessageID })
        }
        if (event.type === "turn.completed") client.turns.delete(event.turnID)
      }
    }
    const buffered = client.buffered.get(threadID)
    for (let event = buffered?.shift(); event; event = buffered?.shift()) yield* handle(client, sessionID, event)
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
      yield* handle(client, sessionID, event)
    })

  const handle = (client: Client, sessionID: SessionSchema.ID, event: DotsTransport.Inbound) =>
    Effect.gen(function* () {
      if (event.type === "message.revision") return
      const turn = event.turnID === undefined ? undefined : client.turns.get(event.turnID)
      if (event.type === "turn.started") {
        const causalMessageID = event.clientMessageID ?? turn?.causalMessageID
        return void client.turns.set(event.turnID, {
          threadID: event.threadID,
          ...(causalMessageID === undefined ? {} : { causalMessageID }),
        })
      }
      if (event.type === "user.message") {
        reconcile(sessionID, event.clientMessageID, event.turnID)
        if (event.turnID !== undefined)
          client.turns.set(event.turnID, { threadID: event.threadID, causalMessageID: event.clientMessageID })
        return
      }
      if (event.type === "message.snapshot") {
        const key = `${event.threadID}\0${event.itemID}`
        if (client.seen.get(event.threadID)?.has(event.itemID)) return void client.partials.delete(key)
        return void client.partials.set(key, {
          threadID: event.threadID,
          turnID: event.turnID,
          itemID: event.itemID,
          text: event.text,
          causalMessageID: event.causalMessageID,
        })
      }
      if (event.type === "message.delta") {
        const key = `${event.threadID}\0${event.itemID}`
        const partial = client.partials.get(key)
        if (partial) partial.text += event.delta
        if (!partial)
          client.partials.set(key, {
            threadID: event.threadID,
            turnID: event.turnID,
            itemID: event.itemID,
            text: event.delta,
            causalMessageID: event.causalMessageID,
          })
        return
      }
      if (event.type === "message") {
        client.partials.delete(`${event.threadID}\0${event.itemID}`)
        return yield* admit(client, sessionID, {
          ...event,
          causalMessageID: event.causalMessageID ?? turn?.causalMessageID,
        })
      }
      const streamed = [...client.partials.entries()].filter(([, partial]) => partial.turnID === event.turnID)
      for (const [key, partial] of streamed) {
        client.partials.delete(key)
        yield* admit(client, sessionID, {
          ...partial,
          causalMessageID: partial.causalMessageID ?? turn?.causalMessageID,
        })
      }
      client.turns.delete(event.turnID)
    })

  const admit = (
    client: Client,
    sessionID: SessionSchema.ID,
    reply: {
      readonly threadID: string
      readonly turnID?: string
      readonly itemID: string
      readonly text: string
      readonly causalMessageID?: string
    },
  ) =>
    Effect.gen(function* () {
      const admissible = () => {
        const binding = bindings.get(sessionID)
        const seen = client.seen.get(reply.threadID)
        return !binding ||
          binding.client !== client ||
          binding.target.threadID !== reply.threadID ||
          client.threads.get(reply.threadID) !== sessionID ||
          !seen ||
          seen.has(reply.itemID) ||
          reply.text === ""
          ? undefined
          : { binding, seen }
      }
      if (!admissible()) return
      if (!(yield* allowed)) return yield* disableSoon
      const admitted = admissible()
      if (!admitted) return
      const { binding, seen } = admitted
      yield* options.sessions.admit({
        sessionID,
        id: DotsPeer.messageID({
          sessionID,
          accountID: client.account.accountID,
          dotID: binding.target.dotID,
          threadID: reply.threadID,
          itemID: reply.itemID,
        }),
        text: reply.text,
        description: `Dots message from ${binding.target.label || binding.target.dotID}`,
        metadata: {
          dots: {
            origin: "dots-peer",
            profile: binding.target.profile,
            dotID: binding.target.dotID,
            threadID: reply.threadID,
            ...(reply.turnID === undefined ? {} : { turnID: reply.turnID }),
            itemID: reply.itemID,
            ...(reply.causalMessageID === undefined ? {} : { causalMessageID: reply.causalMessageID }),
          },
        },
      })
      seen.add(reply.itemID)
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
      turns: new Map(),
      seen: new Map(),
      buffered: new Map(),
      partials: new Map(),
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
    for (const [turnID, turn] of binding.client.turns)
      if (turn.threadID === threadID) binding.client.turns.delete(turnID)
    for (const [key, partial] of binding.client.partials)
      if (partial.threadID === threadID) binding.client.partials.delete(key)
    if (binding.client.threads.size > 0) return
    if (clients.get(binding.client.account.key) === binding.client) clients.delete(binding.client.account.key)
    yield* Scope.close(binding.client.scope, Exit.void)
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
    if (receipt.turnID !== undefined)
      client.turns.set(receipt.turnID, { threadID: binding.target.threadID, causalMessageID: input.id })
    return {
      messageID: input.id,
      status: receipt.status,
      ...(receipt.turnID === undefined ? {} : { turnID: receipt.turnID }),
    } satisfies Dots.Delivery
  })

  const control = (action: "pause" | "resume", input: { readonly sessionID: SessionSchema.ID } & Dots.Control) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* requireEnabled
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
      Stream.runForEach(() => allowed.pipe(Effect.flatMap((on) => (on ? Effect.void : disable)))),
      Effect.forkIn(lifetime, { startImmediately: true }),
    )

  return Service.of({
    targets: Effect.fn("DotsRuntime.targets")(function* (profile) {
      yield* requireEnabled
      return (yield* destinations(profile)).targets
    }),
    bind: Effect.fn("DotsRuntime.bind")(function* (input) {
      yield* requireEnabled
      if (!(yield* options.sessions.exists(input.sessionID)))
        return yield* fail("session_not_found", "The Session does not exist.")
      const found = yield* destinations(input.target.profile)
      const target = found.targets.find((item) => sameTarget(item, input.target))
      if (!target)
        return yield* fail("target_unavailable", "That Dot conversation is no longer offered by the profile.")
      const client = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireEnabled
          const existing = bindings.get(input.sessionID)
          if (existing && existing.client.account.key === found.account.key && sameTarget(existing.target, target)) {
            if (existing.control === "pending") return yield* fail("runtime_unknown", "A Dots runtime control is still pending.")
            existing.control = undefined
            existing.runtimeState = undefined
            if (existing.client.state === "failed") yield* start(existing.client)
            return existing.client
          }
          const owner = clients.get(found.account.key)?.threads.get(target.threadID)
          if (owner !== undefined && owner !== input.sessionID)
            return yield* fail("target_in_use", "Another Session is already confirmed for that Dot conversation.")
          if (existing) yield* release(input.sessionID, existing)
          const reused = clients.get(found.account.key)
          const connection = reused?.state === "connected" ? reused.connection : undefined
          const client = reused ?? (yield* open(found.account))
          client.buffered.set(target.threadID, [])
          client.threads.set(target.threadID, input.sessionID)
          bindings.set(input.sessionID, { target, client })
          if (!reused || reused.state === "failed") yield* start(client)
          if (connection)
            yield* subscribe(client, connection, target.threadID).pipe(
              Effect.tapError(() => release(input.sessionID, { target, client })),
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
  })
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
