import { describe, expect, test } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { Credential } from "@ycoding-ai/core/credential"
import { Location } from "@ycoding-ai/core/location"
import { Money } from "@ycoding-ai/schema/money"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { BrowserProtocol } from "@ycoding-ai/core/browser/protocol"
import { BrowserAdmission } from "@ycoding-ai/core/browser/admission"
import { EventV2 } from "@ycoding-ai/core/event"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, PubSub, Queue, Schema, Scope, Stream } from "effect"
import { location } from "../fixture/location"

const directory = AbsolutePath.make("/browser-fixture")
const foreignDirectory = AbsolutePath.make("/browser-foreign")
const sessionID = SessionSchema.ID.make("ses_browser_owner")
const otherSessionID = SessionSchema.ID.make("ses_browser_other")
const foreignSessionID = SessionSchema.ID.make("ses_browser_foreign")
const extensionID = "a".repeat(32)
const credentials = new Map<Credential.ID, Credential.Info>()
const lifecycleEvents = Effect.runSync(PubSub.unbounded<EventV2.Payload>())
const eventLayer = Layer.mock(EventV2.Service, { subscribe: () => Stream.fromPubSub(lifecycleEvents) })

const lifecycleEvent = (definition: typeof SessionEvent.Moved | typeof SessionEvent.Deleted | typeof SessionEvent.Archived) =>
  Schema.decodeUnknownSync(definition)({
    id: EventV2.ID.create(),
    created: 1,
    type: definition.type,
    durable: {
      aggregateID: sessionID,
      seq: 0,
      version: definition.durable.version,
    },
    data: definition === SessionEvent.Moved ? { sessionID, location: { directory } } : { sessionID },
  })

const session = (id: SessionSchema.ID, sessionDirectory = directory, archived = false) =>
  SessionSchema.Info.make({
    id,
    projectID: ProjectV2.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: DateTime.makeUnsafe(1),
      updated: DateTime.makeUnsafe(1),
      ...(archived ? { archived: DateTime.makeUnsafe(2) } : {}),
    },
    title: "Browser fixture",
    location: { directory: sessionDirectory },
  })

const credentialLayer = Layer.mock(Credential.Service, {
  all: () => Effect.succeed([...credentials.values()]),
  list: (integrationID) =>
    Effect.succeed([...credentials.values()].filter((credential) => credential.integrationID === integrationID)),
  get: (id) => Effect.succeed(credentials.get(id)),
  create: (input) =>
    Effect.sync(() => {
      for (const [id, credential] of credentials)
        if (credential.integrationID === input.integrationID) credentials.delete(id)
      const credential = new Credential.Info({
        id: Credential.ID.create(),
        integrationID: input.integrationID,
        label: input.label ?? "default",
        value: input.value,
      })
      credentials.set(credential.id, credential)
      return credential
    }),
  update: (id, updates) =>
    Effect.sync(() => {
      const credential = credentials.get(id)
      if (!credential) return
      credentials.set(
        id,
        new Credential.Info({
          id: credential.id,
          integrationID: credential.integrationID,
          label: updates.label ?? credential.label,
          value: updates.value ?? credential.value,
          generation: credential.generation,
        }),
      )
    }),
  remove: (id) => Effect.sync(() => void credentials.delete(id)),
})

const dependencies = Layer.mergeAll(
  Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
  Layer.mock(SessionStore.Service, {
    get: (id) => Effect.succeed([sessionID, otherSessionID].includes(id) ? session(id) : undefined),
  }),
  credentialLayer,
  BrowserAdmission.layer,
  eventLayer,
)

function run<A, E>(
  effect: Effect.Effect<A, E, Browser.Service | BrowserAdmission.Service | Scope.Scope>,
  options: Browser.Options = { commandTimeout: "25 millis" },
) {
  const browser = Browser.layer(options).pipe(Layer.provide(dependencies))
  return Effect.runPromise(
    Effect.scoped(
      effect.pipe(Effect.provide(Layer.merge(dependencies, browser))),
    ),
  )
}

async function attached(
  browser: Browser.Interface,
  outbox: Queue.Queue<BrowserProtocol.ServerMessage>,
  close: Browser.Transport["close"] = () => {},
) {
  const pairing = await Effect.runPromise(browser.start(sessionID))
  const attachment = await Effect.runPromise(
    browser.attach({
      sessionID,
      origin: `chrome-extension://${extensionID}`,
      handshake: { type: "pair", version: 2, extensionID, secret: pairing.secret },
      transport: {
        send: (message) => Queue.offerUnsafe(outbox, message),
        close,
      },
    }),
  )
  const paired = await Effect.runPromise(Queue.take(outbox))
  if (paired.type !== "paired") throw new Error("expected paired frame")
  return { attachment, generation: paired.generation }
}

async function pairedTrust(browser: Browser.Interface, session = sessionID) {
  const outbox = await Effect.runPromise(Queue.unbounded<BrowserProtocol.ServerMessage>())
  const pairing = await Effect.runPromise(browser.start(session))
  const attachment = await Effect.runPromise(
    browser.attach({
      sessionID: session,
      origin: `chrome-extension://${extensionID}`,
      handshake: { type: "pair", version: 2, extensionID, secret: pairing.secret },
      transport: {
        send: (message) => Queue.offerUnsafe(outbox, message),
        close: () => {},
      },
    }),
  )
  const response = await Effect.runPromise(Queue.take(outbox))
  if (response.type !== "paired" || !response.credential) throw new Error("expected durable paired credential")
  return { attachment, response: { ...response, credential: response.credential } }
}

describe("selected-tab browser service", () => {
  test("settles pending mutations and releases control on Session moved, deleted, and archived events", async () => {
    for (const definition of [SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived]) {
      credentials.clear()
      const closed: Array<{ code: number; reason: string }> = []
      await run(
        Effect.gen(function* () {
          const admission = yield* BrowserAdmission.Service
          const browser = yield* Browser.Service
          const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
          const connected = yield* Effect.promise(() =>
            attached(browser, outbox, (code, reason) => closed.push({ code, reason })),
          )
          const tabID = Browser.TabID.make(`btab_${definition.type.replaceAll(".", "_")}`)
          yield* connected.attachment.receive({
            type: "shared",
            tabID,
            title: "Fixture",
            url: "https://example.test/form",
            documentGeneration: 1,
            active: false,
          })
          const observing = yield* browser
            .observe({ sessionID, tabID, generation: connected.generation, callID: "observe-lifecycle" })
            .pipe(Effect.forkScoped)
          yield* Queue.take(outbox)
          yield* connected.attachment.receive({
            type: "observation",
            callID: "observe-lifecycle",
            tabID,
            generation: connected.generation,
            documentGeneration: 1,
            revision: 1,
            title: "Fixture",
            url: "https://example.test/form",
            elements: [{ ref: "b1", role: "button", name: "Submit" }],
            truncated: false,
          })
          yield* Fiber.join(observing)
          const pending = yield* browser
            .action({
              sessionID,
              tabID,
              generation: connected.generation,
              documentGeneration: 1,
              observationRevision: 1,
              callID: "lifecycle-mutation",
              action: { type: "click", ref: "b1" },
            })
            .pipe(Effect.forkScoped)
          yield* Queue.take(outbox)
          yield* PubSub.publish(lifecycleEvents, lifecycleEvent(definition))
          const result = yield* Fiber.join(pending).pipe(
            Effect.timeoutOrElse({
              duration: "500 millis",
              orElse: () => Effect.die(new Error(`Session ${definition.type} did not settle browser work`)),
            }),
          )
          expect(result).toMatchObject({ status: "uncertain", callID: "lifecycle-mutation" })
          expect(closed).toEqual([
            { code: 1000, reason: `session ${definition.type.slice("session.".length)}` },
          ])
          expect(yield* browser.list(sessionID)).toEqual([])
          expect(admission.claim(sessionID, "isolated")).toBe(true)
          expect(credentials.size).toBe(1)
        }),
        { commandTimeout: "2 seconds" },
      )
    }
  })

  test("retains archived Session trust but rejects reconnect until the Session is active", async () => {
    credentials.clear()
    const trust = await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        return yield* Effect.promise(() => pairedTrust(browser))
      }),
    )
    const archivedDependencies = Layer.mergeAll(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
      Layer.mock(SessionStore.Service, {
        get: (id) => Effect.succeed(id === sessionID ? session(id, directory, true) : undefined),
      }),
      credentialLayer,
      BrowserAdmission.layer,
      eventLayer,
    )
    const reconnect = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* Browser.Service
          return yield* browser
            .attach({
              sessionID,
              origin: `chrome-extension://${extensionID}`,
              handshake: {
                type: "authenticate",
                version: 2,
                extensionID,
                serverID: trust.response.serverID,
                credential: trust.response.credential,
              },
              transport: { send: () => true, close: () => {} },
            })
            .pipe(Effect.exit)
        }).pipe(Effect.provide(Browser.layer().pipe(Layer.provide(archivedDependencies)))),
      ),
    )
    expect(Exit.isFailure(reconnect)).toBe(true)
    if (Exit.isFailure(reconnect))
      expect(Cause.squash(reconnect.cause)).toMatchObject({ _tag: "Session.NotFoundError" })
    expect(credentials.size).toBe(1)
  })

  test("persists installation-bound trust for restart auth without restoring tabs", async () => {
    credentials.clear()
    const trust = await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        return yield* Effect.promise(() => pairedTrust(browser))
      }),
    )
    await Effect.runPromise(trust.attachment.detach)

    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        yield* browser.attach({
          sessionID,
          origin: `chrome-extension://${extensionID}`,
          handshake: {
            type: "authenticate",
            version: 2,
            extensionID,
            serverID: trust.response.serverID,
            credential: trust.response.credential,
          },
          transport: { send: (message) => Queue.offerUnsafe(outbox, message), close: () => {} },
        })
        expect(yield* Queue.take(outbox)).toMatchObject({
          type: "paired",
          version: 2,
          serverID: trust.response.serverID,
          credential: undefined,
        })
        expect(yield* browser.list(sessionID)).toEqual([])
        const wrongServer = yield* browser
          .attach({
            sessionID,
            origin: `chrome-extension://${extensionID}`,
            handshake: {
              type: "authenticate",
              version: 2,
              extensionID,
              serverID: "different-server-identity",
              credential: trust.response.credential,
            },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(wrongServer)).toBe(true)
        if (Exit.isFailure(wrongServer))
          expect(Cause.squash(wrongServer.cause)).toMatchObject({ _tag: "Browser.AuthenticationError" })
      }),
    )
  })

  test("does not accept a Location-bound credential for a valid Session in another Location", async () => {
    credentials.clear()
    const trust = await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        return yield* Effect.promise(() => pairedTrust(browser))
      }),
    )
    const foreignDependencies = Layer.mergeAll(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: foreignDirectory }))),
      Layer.mock(SessionStore.Service, {
        get: (id) => Effect.succeed(id === foreignSessionID ? session(id, foreignDirectory) : undefined),
      }),
      credentialLayer,
      BrowserAdmission.layer,
      eventLayer,
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* Browser.Service
          return yield* browser
            .attach({
              sessionID: foreignSessionID,
              origin: `chrome-extension://${extensionID}`,
              handshake: {
                type: "authenticate",
                version: 2,
                extensionID,
                serverID: trust.response.serverID,
                credential: trust.response.credential,
              },
              transport: { send: () => true, close: () => {} },
            })
            .pipe(Effect.exit)
        }).pipe(Effect.provide(Browser.layer().pipe(Layer.provide(foreignDependencies)))),
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result))
      expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Browser.AuthenticationError" })
  })

  test("revokes forgotten credentials and fails unknown or cross-Session auth closed", async () => {
    credentials.clear()
    const trust = await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const paired = yield* Effect.promise(() => pairedTrust(browser))
        yield* paired.attachment.receive({ type: "forget" })
        return paired.response
      }),
    )

    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const authenticate = (targetSession: SessionSchema.ID, credential: string) =>
          browser
            .attach({
              sessionID: targetSession,
              origin: `chrome-extension://${extensionID}`,
              handshake: {
                type: "authenticate",
                version: 2,
                extensionID,
                serverID: trust.serverID,
                credential,
              },
              transport: { send: () => true, close: () => {} },
            })
            .pipe(Effect.exit)
        const revoked = yield* authenticate(sessionID, trust.credential)
        const unknown = yield* authenticate(sessionID, "u".repeat(43))
        const crossSession = yield* authenticate(otherSessionID, trust.credential)
        for (const exit of [revoked, unknown, crossSession]) {
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit))
            expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Browser.AuthenticationError" })
        }
      }),
    )
  })

  test("an explicit Session switch disarms the previous durable grant", async () => {
    credentials.clear()
    const closed: Array<{ code: number; reason: string }> = []
    const first = await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const pairing = yield* browser.start(sessionID)
        yield* browser.attach({
          sessionID,
          origin: `chrome-extension://${extensionID}`,
          handshake: { type: "pair", version: 2, extensionID, secret: pairing.secret },
          transport: {
            send: (message) => Queue.offerUnsafe(outbox, message),
            close: (code, reason) => closed.push({ code, reason }),
          },
        })
        const response = yield* Queue.take(outbox)
        if (response.type !== "paired" || !response.credential) throw new Error("expected durable paired credential")
        yield* browser.start(otherSessionID)
        expect(closed).toEqual([{ code: 1000, reason: "pairing switched" }])
        return { ...response, credential: response.credential }
      }),
    )
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const rejected = yield* browser
          .attach({
            sessionID,
            origin: `chrome-extension://${extensionID}`,
            handshake: {
              type: "authenticate",
              version: 2,
              extensionID,
              serverID: first.serverID,
              credential: first.credential,
            },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
      }),
    )
  })

  test("consumes one-time pairing, verifies extension origin, and isolates Session ownership", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const pairing = yield* browser.start(sessionID)
        const rejected = yield* browser
          .attach({
            sessionID,
            origin: "https://website.example",
            handshake: { type: "pair", version: 2, extensionID, secret: pairing.secret },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        if (Exit.isFailure(rejected))
          expect(Cause.squash(rejected.cause)).toMatchObject({ _tag: "Browser.AuthenticationError" })

        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* browser.attach({
          sessionID,
          origin: `chrome-extension://${extensionID}`,
          handshake: { type: "pair", version: 2, extensionID, secret: pairing.secret },
          transport: { send: (message) => Queue.offerUnsafe(outbox, message), close: () => {} },
        })
        const paired = yield* Queue.take(outbox)
        expect(paired.type).toBe("paired")
        const reused = yield* browser
          .attach({
            sessionID,
            origin: `chrome-extension://${extensionID}`,
            handshake: { type: "pair", version: 2, extensionID, secret: pairing.secret },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(reused)).toBe(true)

        yield* connected.receive({
          type: "shared",
          tabID: Browser.TabID.make("btab_owner"),
          title: "Fixture",
          url: "https://example.test/form?secret=redacted#fragment",
          documentGeneration: 1,
          active: false,
        })
        const crossSession = yield* browser
          .observe({
            sessionID: otherSessionID,
            tabID: Browser.TabID.make("btab_owner"),
            generation: 1,
            callID: "cross",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(crossSession)).toBe(true)
        if (Exit.isFailure(crossSession))
          expect(Cause.squash(crossSession.cause)).toMatchObject({ _tag: "Browser.OwnershipError" })
      }),
    )
  })

  test("rejects selected-tab start and trusted attach while isolated mode owns the Session without revoking trust", async () => {
    credentials.clear()
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const admission = yield* BrowserAdmission.Service
        const paired = yield* Effect.promise(() => pairedTrust(browser))
        yield* browser.stop(sessionID)
        expect(admission.claim(sessionID, "isolated")).toBe(true)
        const start = yield* browser.start(sessionID).pipe(Effect.exit)
        expect(Exit.isFailure(start)).toBe(true)
        if (Exit.isFailure(start)) expect(Cause.squash(start.cause)).toMatchObject({ _tag: "Browser.BusyError" })
        expect(credentials.size).toBe(1)
        const attach = yield* browser
          .attach({
            sessionID,
            origin: `chrome-extension://${extensionID}`,
            handshake: {
              type: "authenticate",
              version: 2,
              extensionID,
              serverID: paired.response.serverID,
              credential: paired.response.credential,
            },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(attach)).toBe(true)
        if (Exit.isFailure(attach)) expect(Cause.squash(attach.cause)).toMatchObject({ _tag: "Browser.BusyError" })
        expect(credentials.size).toBe(1)
      }),
    )
  })

  test("binds semantic actions to observation revisions and strips sensitive URL components", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* Effect.promise(() => attached(browser, outbox))
        const tabID = Browser.TabID.make("btab_semantic")
        yield* connected.attachment.receive({
          type: "shared",
          tabID,
          title: "Fixture",
          url: "https://example.test/form?token=hidden",
          documentGeneration: 1,
          active: false,
        })
        const observing = yield* browser
          .observe({ sessionID, tabID, generation: connected.generation, callID: "observe-1" })
          .pipe(Effect.forkScoped)
        expect(yield* Queue.take(outbox)).toMatchObject({ type: "observe", callID: "observe-1" })
        yield* connected.attachment.receive({
          type: "observation",
          callID: "observe-1",
          tabID,
          generation: connected.generation,
          documentGeneration: 1,
          revision: 1,
          title: "Fixture",
          url: "https://example.test/form?token=hidden#private",
          elements: [
            { ref: "b1", role: "button", name: "Submit", destination: "https://example.test/done?token=hidden" },
          ],
          truncated: false,
        })
        const observation = yield* Fiber.join(observing)
        expect(observation.page).toEqual({ origin: "https://example.test", path: "/form" })
        expect(observation.elements[0]?.destination).toEqual({ origin: "https://example.test", path: "/done" })

        const stale = yield* browser
          .action({
            sessionID,
            tabID,
            generation: connected.generation,
            documentGeneration: 1,
            observationRevision: 0,
            callID: "stale",
            action: { type: "click", ref: "b1" },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        if (Exit.isFailure(stale)) expect(Cause.squash(stale.cause)).toMatchObject({ _tag: "Browser.FenceError" })

        const mutation = {
          sessionID,
          tabID,
          generation: connected.generation,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "extension-predispatch-error",
          action: { type: "click" as const, ref: "b1" },
        }
        const mutating = yield* browser.action(mutation).pipe(Effect.forkScoped)
        expect(yield* Queue.take(outbox)).toMatchObject({ type: "action", callID: "extension-predispatch-error" })
        yield* connected.attachment.receive({
          type: "error",
          callID: "extension-predispatch-error",
          tabID,
          generation: connected.generation,
          dispatched: false,
          message: "mutation guard rejected before dispatch",
        })
        expect(yield* Fiber.join(mutating)).toMatchObject({
          callID: "extension-predispatch-error",
          status: "rejected",
          tab: { status: "shared" },
        })
        expect((yield* browser.action(mutation)).status).toBe("rejected")
        expect((yield* Queue.poll(outbox))._tag).toBe("None")
      }),
    )
  })

  test("marks a lost mutation response uncertain and never dispatches the same call twice", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* Effect.promise(() => attached(browser, outbox))
        const tabID = Browser.TabID.make("btab_uncertain")
        yield* connected.attachment.receive({
          type: "shared",
          tabID,
          title: "Fixture",
          url: "https://example.test/form",
          documentGeneration: 1,
          active: false,
        })
        const observing = yield* browser
          .observe({ sessionID, tabID, generation: connected.generation, callID: "observe-2" })
          .pipe(Effect.forkScoped)
        yield* Queue.take(outbox)
        yield* connected.attachment.receive({
          type: "observation",
          callID: "observe-2",
          tabID,
          generation: connected.generation,
          documentGeneration: 1,
          revision: 1,
          title: "Fixture",
          url: "https://example.test/form",
          elements: [{ ref: "b1", role: "button", name: "Submit" }],
          truncated: false,
        })
        yield* Fiber.join(observing)
        const input = {
          sessionID,
          tabID,
          generation: connected.generation,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "mutate-once",
          action: { type: "click" as const, ref: "b1" },
        }
        const first = yield* browser.action(input)
        expect(first.status).toBe("uncertain")
        expect(first.tab).toMatchObject({ status: "paused", uncertainCallID: "mutate-once" })
        expect(yield* Queue.take(outbox)).toMatchObject({ type: "action", callID: "mutate-once" })
        expect((yield* browser.action(input)).status).toBe("uncertain")
        expect((yield* Queue.poll(outbox))._tag).toBe("None")
        const conflictingRetry = yield* browser
          .action({
            ...input,
            action: { type: "navigate", url: "https://example.test/form" },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(conflictingRetry)).toBe(true)
        if (Exit.isFailure(conflictingRetry))
          expect(Cause.squash(conflictingRetry.cause)).toMatchObject({ _tag: "Browser.FenceError" })
        expect((yield* Queue.poll(outbox))._tag).toBe("None")
        yield* connected.attachment.receive({
          type: "error",
          callID: "mutate-once",
          tabID,
          generation: connected.generation,
          dispatched: true,
          message: "late extension failure",
        })
        expect(yield* browser.list(sessionID)).toEqual([
          expect.objectContaining({ status: "paused", pauseReason: "uncertain", uncertainCallID: "mutate-once" }),
        ])
      }),
    )
  })

  test("settles an in-flight mutation as uncertain when the extension disconnects", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* Effect.promise(() => attached(browser, outbox))
        const tabID = Browser.TabID.make("btab_disconnect")
        yield* connected.attachment.receive({
          type: "shared",
          tabID,
          title: "Fixture",
          url: "https://example.test/form",
          documentGeneration: 1,
          active: false,
        })
        const observing = yield* browser
          .observe({ sessionID, tabID, generation: connected.generation, callID: "observe-disconnect" })
          .pipe(Effect.forkScoped)
        yield* Queue.take(outbox)
        yield* connected.attachment.receive({
          type: "observation",
          callID: "observe-disconnect",
          tabID,
          generation: connected.generation,
          documentGeneration: 1,
          revision: 1,
          title: "Fixture",
          url: "https://example.test/form",
          elements: [{ ref: "b1", role: "button", name: "Submit" }],
          truncated: false,
        })
        yield* Fiber.join(observing)
        const mutating = yield* browser
          .action({
            sessionID,
            tabID,
            generation: connected.generation,
            documentGeneration: 1,
            observationRevision: 1,
            callID: "disconnect-mutation",
            action: { type: "click", ref: "b1" },
          })
          .pipe(Effect.forkScoped)
        expect(yield* Queue.take(outbox)).toMatchObject({ type: "action", callID: "disconnect-mutation" })
        yield* connected.attachment.detach
        expect(yield* Fiber.join(mutating)).toMatchObject({
          callID: "disconnect-mutation",
          status: "uncertain",
          tab: { status: "paused", pauseReason: "uncertain", uncertainCallID: "disconnect-mutation" },
        })
      }),
    )
  })
})
