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

const lifecycleEvent = (
  definition: typeof SessionEvent.Moved | typeof SessionEvent.Deleted | typeof SessionEvent.Archived,
) =>
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
    get: (id) =>
      Effect.succeed(
        id === foreignSessionID
          ? session(id, foreignDirectory)
          : [sessionID, otherSessionID].includes(id)
            ? session(id)
            : undefined,
      ),
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
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(Layer.merge(dependencies, browser)))))
}

async function attached(
  browser: Browser.Interface,
  outbox: Queue.Queue<BrowserProtocol.ServerMessage>,
  close: Browser.Transport["close"] = () => {},
  grant = true,
) {
  const pairing = await Effect.runPromise(browser.start(sessionID))
  const attachment = await Effect.runPromise(
    browser.attach({
      origin: `chrome-extension://${extensionID}`,
      handshake: { type: "pair", version: 3, extensionID, secret: pairing.secret },
      transport: {
        send: (message) => Queue.offerUnsafe(outbox, message),
        close,
      },
    }),
  )
  const paired = await Effect.runPromise(Queue.take(outbox))
  if (paired.type !== "paired") throw new Error("expected paired frame")
  if (grant) await Effect.runPromise(attachment.receive({ type: "profile_access", enabled: true }))
  return { attachment, generation: paired.generation }
}

async function pairedTrust(browser: Browser.Interface, session = sessionID) {
  const outbox = await Effect.runPromise(Queue.unbounded<BrowserProtocol.ServerMessage>())
  const pairing = await Effect.runPromise(browser.start(session))
  const attachment = await Effect.runPromise(
    browser.attach({
      origin: `chrome-extension://${extensionID}`,
      handshake: { type: "pair", version: 3, extensionID, secret: pairing.secret },
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

describe("paired Chrome browser service", () => {
  test("an active profile tab remains controllable until an explicit pause", async () => {
    await run(Effect.gen(function* () {
      const browser = yield* Browser.Service
      const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
      const connected = yield* Effect.promise(() => attached(browser, outbox))
      const profileID = Browser.TabID.make("btab_active_profile")
      yield* connected.attachment.receive({ type: "shared", mode: "profile", tabID: profileID,
        title: "Active", url: "https://example.test/active", documentGeneration: 1, active: true })
      expect(yield* browser.list(sessionID)).toMatchObject([
        { id: profileID, mode: "profile", status: "shared" },
      ])
      const observing = yield* browser.observe({ sessionID, tabID: profileID,
        generation: connected.generation, callID: "active-observe" }).pipe(Effect.forkScoped)
      expect(yield* Queue.take(outbox)).toMatchObject({ type: "observe", tabID: profileID })
      yield* connected.attachment.receive({ type: "observation", tabID: profileID,
        callID: "active-observe", generation: connected.generation, documentGeneration: 1,
        revision: 1, title: "Active", url: "https://example.test/active", elements: [], truncated: false })
      yield* Fiber.join(observing)
      yield* connected.attachment.receive({ type: "takeover", tabID: profileID,
        documentGeneration: 2, active: true })
      expect((yield* browser.list(sessionID)).find((item) => item.id === profileID))
        .toMatchObject({ status: "shared" })
      const acting = yield* browser.action({ sessionID, tabID: profileID, generation: connected.generation,
        documentGeneration: 2, observationRevision: 0, callID: "active-action",
        action: { type: "navigate", url: "https://example.test/next" } }).pipe(Effect.forkScoped)
      expect(yield* Queue.take(outbox)).toMatchObject({ type: "action", tabID: profileID })
      yield* connected.attachment.receive({ type: "result", tabID: profileID, callID: "active-action",
        generation: connected.generation, documentGeneration: 3, observationRevision: 0,
        status: "completed", title: "Next", url: "https://example.test/next" })
      expect(yield* Fiber.join(acting)).toMatchObject({ status: "completed", tab: { status: "shared" } })
      yield* browser.control(sessionID, { action: "pause" })
      expect(yield* browser.status(sessionID)).toMatchObject({ state: "paused" })
      expect(Exit.isFailure(yield* browser.observe({ sessionID, tabID: profileID,
        generation: connected.generation, callID: "paused-observe" }).pipe(Effect.exit))).toBe(true)
    }))
  })
  test("accepts profile tabs only after explicit extension grant and removes them on revocation", async () => {
    await run(Effect.gen(function* () {
      const browser = yield* Browser.Service
      const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
      const connected = yield* Effect.promise(() => attached(browser, outbox, undefined, false))
      const id = Browser.TabID.make("btab_profile_test")
      const shared = { type: "shared" as const, mode: "profile" as const, tabID: id,
        title: "Synthetic", url: "https://example.test/form?secret=hidden", documentGeneration: 1, active: false }
      yield* connected.attachment.receive(shared)
      expect(yield* browser.list(otherSessionID)).toEqual([])
      yield* connected.attachment.receive({ type: "profile_access", enabled: true })
      yield* connected.attachment.receive(shared)
      expect(yield* browser.status(sessionID)).toMatchObject({ profileGranted: true })
      expect(yield* browser.list(otherSessionID)).toMatchObject([
        { id, mode: "profile", page: { origin: "https://example.test", path: "/form" },
          sessionID: otherSessionID },
      ])
      yield* connected.attachment.receive({ type: "profile_access", enabled: false })
      expect(yield* browser.list(otherSessionID)).toEqual([])
      expect(yield* browser.status(sessionID)).toMatchObject({ profileGranted: false })
      yield* connected.attachment.receive(shared)
      expect(yield* browser.list(sessionID)).toEqual([])
    }))
  })
  test("creates a Session-owned tab from a fenced request and denies other Sessions and personal-tab close", async () => {
    await run(Effect.gen(function* () {
      const browser = yield* Browser.Service
      const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
      const connected = yield* Effect.promise(() => attached(browser, outbox))
      const opening = yield* browser.open({ sessionID, generation: connected.generation,
        url: "https://example.test/new", callID: "open-owned" }).pipe(Effect.forkScoped)
      const sent = yield* Queue.take(outbox)
      expect(sent).toMatchObject({ type: "open", url: "https://example.test/new", generation: connected.generation })
      if (sent.type !== "open") throw new Error("expected open frame")
      yield* connected.attachment.receive({ type: "opened", callID: sent.callID, tabID: sent.tabID,
        generation: sent.generation, title: "Fixture", url: sent.url, documentGeneration: 1, active: false })
      const owned = yield* Fiber.join(opening)
      expect(owned).toMatchObject({ id: sent.tabID, sessionID, mode: "owned", status: "shared" })
      yield* connected.attachment.receive({ type: "takeover", tabID: owned.id,
        documentGeneration: 2, active: true })
      expect((yield* browser.list(sessionID)).find((item) => item.id === owned.id))
        .toMatchObject({ status: "shared", mode: "owned" })
      const activeOwnedObserve = yield* browser.observe({ sessionID, tabID: owned.id,
        generation: owned.generation, callID: "active-owned-observe" }).pipe(Effect.forkScoped)
      expect(yield* Queue.take(outbox)).toMatchObject({ type: "observe", tabID: owned.id })
      yield* connected.attachment.receive({ type: "observation", tabID: owned.id,
        callID: "active-owned-observe", generation: owned.generation, documentGeneration: 2,
        revision: 1, title: "Fixture", url: "https://example.test/new", elements: [], truncated: false })
      yield* Fiber.join(activeOwnedObserve)
      expect(Exit.isFailure(yield* browser.open({ sessionID, generation: connected.generation,
        url: "https://example.test/new", callID: "open-owned" }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* browser.open({ sessionID, generation: connected.generation + 1,
        url: "https://example.test/other", callID: "stale-open" }).pipe(Effect.exit))).toBe(true)
      expect(yield* browser.list(otherSessionID)).toEqual([])
      expect(Exit.isFailure(yield* browser.observe({ sessionID: otherSessionID, tabID: owned.id,
        generation: owned.generation, callID: "foreign-observe" }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* browser.action({ sessionID: otherSessionID, tabID: owned.id,
        generation: owned.generation, documentGeneration: owned.documentGeneration,
        observationRevision: 0, callID: "foreign-action", action: { type: "capture" } }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* browser.close({ sessionID: otherSessionID, tabID: owned.id,
        generation: owned.generation, callID: "foreign-close" }).pipe(Effect.exit))).toBe(true)
      const rejected = yield* browser.close({ sessionID, tabID: owned.id,
        generation: owned.generation, callID: "close-active" }).pipe(Effect.forkScoped)
      const rejectedFrame = yield* Queue.take(outbox)
      if (rejectedFrame.type !== "close") throw new Error("expected close frame")
      yield* connected.attachment.receive({ type: "error", callID: rejectedFrame.callID,
        tabID: rejectedFrame.tabID, generation: rejectedFrame.generation,
        dispatched: false, message: "The owned tab is active" })
      expect(Exit.isFailure(yield* Fiber.await(rejected))).toBe(true)
      expect(yield* browser.list(sessionID)).toMatchObject([{ id: owned.id, mode: "owned" }])
      expect(Exit.isFailure(yield* browser.close({ sessionID, tabID: owned.id,
        generation: owned.generation, callID: "close-active" }).pipe(Effect.exit))).toBe(true)
      expect(yield* Queue.size(outbox)).toBe(0)
      const closing = yield* browser.close({ sessionID, tabID: owned.id,
        generation: owned.generation, callID: "close-owned" }).pipe(Effect.forkScoped)
      const close = yield* Queue.take(outbox)
      expect(close).toMatchObject({ type: "close", tabID: owned.id })
      if (close.type !== "close") throw new Error("expected close frame")
      yield* connected.attachment.receive({ type: "closed", callID: close.callID, tabID: close.tabID,
        generation: close.generation })
      expect(yield* Fiber.await(closing)).toMatchObject({ _tag: "Success" })
      expect(yield* browser.list(sessionID)).toEqual([])
      yield* connected.attachment.receive({ type: "shared", mode: "profile", tabID: Browser.TabID.make("btab_personal"),
        title: "Personal", url: "https://example.test/", documentGeneration: 1, active: false })
      expect(Exit.isFailure(yield* browser.close({ sessionID, tabID: Browser.TabID.make("btab_personal"),
        generation: connected.generation, callID: "close-personal" }).pipe(Effect.exit))).toBe(true)
    }))
  })
  const ownerTransitions = [SessionEvent.Moved, SessionEvent.Archived, SessionEvent.Deleted]
  ownerTransitions.forEach((event) => {
    test(`releases the ending Session's active owned tab on ${event.type} while keeping profile tabs available`, async () => {
      await run(Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* Effect.promise(() => attached(browser, outbox))
        const opening = yield* browser.open({ sessionID, generation: connected.generation,
          url: "https://example.test/owned", callID: "lifecycle-open" }).pipe(Effect.forkScoped)
        const open = yield* Queue.take(outbox)
        if (open.type !== "open") throw new Error("expected open frame")
        yield* connected.attachment.receive({ type: "opened", callID: open.callID, tabID: open.tabID,
          generation: open.generation, title: "Owned", url: open.url, documentGeneration: 1, active: false })
        yield* Fiber.join(opening)
        yield* connected.attachment.receive({ type: "takeover", tabID: open.tabID, documentGeneration: 1, active: true })
        yield* connected.attachment.receive({ type: "shared", mode: "profile", tabID: Browser.TabID.make("btab_selected_lifecycle"),
          title: "Shared", url: "https://example.test/", documentGeneration: 1, active: false })
        yield* PubSub.publish(lifecycleEvents, lifecycleEvent(event))
        const release = yield* Queue.take(outbox)
        expect(release).toMatchObject({ type: "release", tabID: open.tabID })
        expect(yield* browser.list(otherSessionID)).toMatchObject([{ id: "btab_selected_lifecycle" }])
      }))
    })
  })
  test("a bootstrap Session ending leaves the shared connection available to another Session", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* Effect.promise(() => attached(browser, outbox))
        yield* connected.attachment.receive({
          type: "shared", mode: "profile",
          tabID: Browser.TabID.make("btab_still_shared"),
          title: "Fixture",
          url: "https://example.test/page",
          documentGeneration: 1,
          active: false,
        })
        yield* PubSub.publish(lifecycleEvents, lifecycleEvent(SessionEvent.Deleted))
        yield* Effect.sleep("10 millis")
        expect(yield* browser.status(otherSessionID)).toMatchObject({ state: "connected" })
        expect(yield* browser.list(otherSessionID)).toMatchObject([{ id: "btab_still_shared" }])
      }),
    )
  })

  test("a paired extension shares its tab with every active Session, including another Location", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* Effect.promise(() => attached(browser, outbox))
        const tabID = Browser.TabID.make("btab_global")
        yield* connected.attachment.receive({
          type: "shared", mode: "profile",
          tabID,
          title: "Fixture",
          url: "https://example.test/page",
          documentGeneration: 1,
          active: false,
        })
        const admission = yield* BrowserAdmission.Service
        expect(admission.claim(otherSessionID, "isolated")).toBe(true)
        expect(yield* browser.list(otherSessionID)).toEqual([])
        expect(yield* browser.status(otherSessionID)).toMatchObject({ state: "unavailable" })
        admission.release(otherSessionID, "isolated")
        for (const viewer of [otherSessionID, foreignSessionID]) {
          expect(yield* browser.status(viewer)).toMatchObject({ state: "connected" })
          expect(yield* browser.list(viewer)).toMatchObject([{ id: tabID, sessionID: viewer }])
          const observing = yield* browser
            .observe({
              sessionID: viewer,
              tabID,
              generation: connected.generation,
              callID: `read-${viewer}`,
            })
            .pipe(Effect.forkScoped)
          expect(yield* Queue.take(outbox)).toMatchObject({ type: "observe", tabID })
          yield* connected.attachment.receive({
            type: "observation",
            callID: `read-${viewer}`,
            tabID,
            generation: connected.generation,
            documentGeneration: 1,
            revision: 1,
            title: "Fixture",
            url: "https://example.test/page",
            elements: [],
            truncated: false,
          })
          expect(yield* Fiber.join(observing)).toMatchObject({ tabID })
          const acting = yield* browser
            .action({
              sessionID: viewer,
              tabID,
              generation: connected.generation,
              documentGeneration: 1,
              observationRevision: 1,
              callID: "shared-call",
              action: { type: "scroll", deltaY: 100 },
            })
            .pipe(Effect.forkScoped)
          expect(yield* Queue.take(outbox)).toMatchObject({ type: "action", callID: "shared-call" })
          yield* connected.attachment.receive({
            type: "result",
            callID: "shared-call",
            tabID,
            generation: connected.generation,
            documentGeneration: 1,
            observationRevision: 1,
            status: "completed",
            title: "Fixture",
            url: "https://example.test/page",
          })
          expect(yield* Fiber.join(acting)).toMatchObject({ status: "completed", tab: { sessionID: viewer } })
        }
        expect(Exit.isFailure(yield* browser.list(SessionSchema.ID.make("ses_missing")).pipe(Effect.exit))).toBe(true)
        yield* browser.stop(foreignSessionID)
        expect(yield* browser.list(sessionID)).toEqual([])
        expect(admission.current(sessionID)).toBeUndefined()
      }),
    )
  })
  test("settles pending mutations but keeps other Sessions connected on owner lifecycle events", async () => {
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
            type: "shared", mode: "profile",
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
          expect(closed).toEqual([])
          expect(yield* browser.list(otherSessionID)).toMatchObject([{ id: tabID, status: "paused" }])
          expect(admission.claim(sessionID, "isolated")).toBe(true)
          expect(credentials.size).toBe(1)
        }),
        { commandTimeout: "2 seconds" },
      )
    }
  })

  test("reconnects with durable trust after the bootstrap Session is archived", async () => {
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
              origin: `chrome-extension://${extensionID}`,
              handshake: {
                type: "authenticate",
                version: 3,
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
    expect(Exit.isSuccess(reconnect)).toBe(true)
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
          origin: `chrome-extension://${extensionID}`,
          handshake: {
            type: "authenticate",
            version: 3,
            extensionID,
            serverID: trust.response.serverID,
            credential: trust.response.credential,
          },
          transport: { send: (message) => Queue.offerUnsafe(outbox, message), close: () => {} },
        })
        expect(yield* Queue.take(outbox)).toMatchObject({
          type: "paired",
          version: 3,
          serverID: trust.response.serverID,
          credential: undefined,
        })
        expect(yield* browser.list(sessionID)).toEqual([])
        const wrongServer = yield* browser
          .attach({
            origin: `chrome-extension://${extensionID}`,
            handshake: {
              type: "authenticate",
              version: 3,
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

  test("authenticates backend trust independent of the bootstrap Location", async () => {
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
              origin: `chrome-extension://${extensionID}`,
              handshake: {
                type: "authenticate",
                version: 3,
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
    expect(Exit.isSuccess(result)).toBe(true)
  })

  test("revokes forgotten credentials and rejects unknown credentials", async () => {
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
        const authenticate = (credential: string) =>
          browser
            .attach({
              origin: `chrome-extension://${extensionID}`,
              handshake: {
                type: "authenticate",
                version: 3,
                extensionID,
                serverID: trust.serverID,
                credential,
              },
              transport: { send: () => true, close: () => {} },
            })
            .pipe(Effect.exit)
        const revoked = yield* authenticate(trust.credential)
        const unknown = yield* authenticate("u".repeat(43))
        for (const exit of [revoked, unknown]) {
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
          origin: `chrome-extension://${extensionID}`,
          handshake: { type: "pair", version: 3, extensionID, secret: pairing.secret },
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
            origin: `chrome-extension://${extensionID}`,
            handshake: {
              type: "authenticate",
              version: 3,
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

  test("consumes one-time pairing, verifies extension origin, and shares with other Sessions", async () => {
    await run(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const pairing = yield* browser.start(sessionID)
        const rejected = yield* browser
          .attach({
            origin: "https://website.example",
            handshake: { type: "pair", version: 3, extensionID, secret: pairing.secret },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        if (Exit.isFailure(rejected))
          expect(Cause.squash(rejected.cause)).toMatchObject({ _tag: "Browser.AuthenticationError" })

        const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
        const connected = yield* browser.attach({
          origin: `chrome-extension://${extensionID}`,
          handshake: { type: "pair", version: 3, extensionID, secret: pairing.secret },
          transport: { send: (message) => Queue.offerUnsafe(outbox, message), close: () => {} },
        })
        const paired = yield* Queue.take(outbox)
        expect(paired.type).toBe("paired")
        const reused = yield* browser
          .attach({
            origin: `chrome-extension://${extensionID}`,
            handshake: { type: "pair", version: 3, extensionID, secret: pairing.secret },
            transport: { send: () => true, close: () => {} },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(reused)).toBe(true)

        yield* connected.receive({ type: "profile_access", enabled: true })
        yield* connected.receive({
          type: "shared", mode: "profile",
          tabID: Browser.TabID.make("btab_owner"),
          title: "Fixture",
          url: "https://example.test/form?secret=redacted#fragment",
          documentGeneration: 1,
          active: false,
        })
        const observing = yield* browser
          .observe({
            sessionID: otherSessionID,
            tabID: Browser.TabID.make("btab_owner"),
            generation: 1,
            callID: "cross",
          })
          .pipe(Effect.forkScoped)
        expect(yield* Queue.take(outbox)).toMatchObject({ type: "observe", callID: "cross" })
        yield* connected.receive({
          type: "observation",
          callID: "cross",
          tabID: Browser.TabID.make("btab_owner"),
          generation: 1,
          documentGeneration: 1,
          revision: 1,
          title: "Fixture",
          url: "https://example.test/form",
          elements: [],
          truncated: false,
        })
        expect(yield* Fiber.join(observing)).toMatchObject({ tabID: Browser.TabID.make("btab_owner") })
      }),
    )
  })

  test("rejects Chrome pairing and trusted attach while isolated mode owns the Session without revoking trust", async () => {
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
            origin: `chrome-extension://${extensionID}`,
            handshake: {
              type: "authenticate",
              version: 3,
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
          type: "shared", mode: "profile",
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
            { ref: "b1", role: "button", name: "Submit", destination: "https://other.test/done?token=hidden" },
          ],
          truncated: false,
        })
        const observation = yield* Fiber.join(observing)
        expect(observation.page).toEqual({ origin: "https://example.test", path: "/form" })
        expect(observation.elements[0]?.destination).toEqual({ origin: "https://other.test", path: "/done" })
        expect(yield* browser.clickDestination({
          sessionID, tabID, generation: connected.generation, documentGeneration: 1,
          observationRevision: 1, ref: "b1",
        })).toEqual({ origin: "https://other.test", path: "/done" })
        const staleDestination = yield* browser.clickDestination({
          sessionID, tabID, generation: connected.generation, documentGeneration: 1,
          observationRevision: 0, ref: "b1",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(staleDestination)).toBe(true)

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
        expect(yield* Queue.take(outbox)).toMatchObject({
          type: "action", callID: "extension-predispatch-error",
          allowedOrigins: ["https://example.test", "https://other.test"],
        })
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
          type: "shared", mode: "profile",
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
          type: "shared", mode: "profile",
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
