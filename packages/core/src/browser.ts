export * as Browser from "./browser"

import { Browser } from "@ycoding-ai/schema/browser"
import { Integration } from "@ycoding-ai/schema/integration"
import { Context, Deferred, Duration, Effect, Layer, Schema, Stream, Types } from "effect"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { BrowserProtocol } from "./browser/protocol"
import { BrowserAdmission } from "./browser/admission"
import { Credential } from "./credential"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { SessionErrors } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionStore } from "./session/store"

export { Browser as Schema }
export const TabID = Browser.TabID
export const Status = Browser.Status
export const Tab = Browser.Tab
export const Pairing = Browser.Pairing
export const Observation = Browser.Observation
export const ActionInput = Browser.ActionInput
export const ObserveInput = Browser.ObserveInput
export const ActionResult = Browser.ActionResult
export const ControlInput = Browser.ControlInput
export const MAX_CAPTURE_BYTES = Browser.MAX_CAPTURE_BYTES

export type Status = Browser.Status
export type Tab = Browser.Tab
export type Pairing = Browser.Pairing
export type Observation = Browser.Observation
export type ActionInput = Browser.ActionInput
export type ObserveInput = Browser.ObserveInput
export type ActionResult = Browser.ActionResult

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("Browser.UnavailableError", {
  message: Schema.String,
}) {}
export class OwnershipError extends Schema.TaggedErrorClass<OwnershipError>()("Browser.OwnershipError", {
  message: Schema.String,
}) {}
export class FenceError extends Schema.TaggedErrorClass<FenceError>()("Browser.FenceError", {
  message: Schema.String,
}) {}
export class BusyError extends Schema.TaggedErrorClass<BusyError>()("Browser.BusyError", {
  message: Schema.String,
}) {}
export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()("Browser.AuthenticationError", {
  message: Schema.String,
}) {}
export class BridgeError extends Schema.TaggedErrorClass<BridgeError>()("Browser.BridgeError", {
  message: Schema.String,
}) {}

export interface Transport {
  readonly send: (message: BrowserProtocol.ServerMessage) => boolean
  readonly close: (code: number, reason: string) => void
}

export interface Attachment {
  readonly receive: (message: Exclude<BrowserProtocol.ClientMessage, BrowserProtocol.Handshake>) => Effect.Effect<void>
  readonly detach: Effect.Effect<void>
}

export interface Interface {
  readonly status: (sessionID: Browser.Tab["sessionID"]) => Effect.Effect<Status, SessionErrors.NotFoundError>
  readonly list: (sessionID: Browser.Tab["sessionID"]) => Effect.Effect<ReadonlyArray<Tab>, SessionErrors.NotFoundError>
  readonly start: (
    sessionID: Browser.Tab["sessionID"],
  ) => Effect.Effect<Pairing, SessionErrors.NotFoundError | BusyError>
  readonly observe: (
    input: ObserveInput,
  ) => Effect.Effect<
    Observation,
    SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError
  >
  readonly action: (
    input: ActionInput,
  ) => Effect.Effect<
    ActionResult,
    SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError
  >
  readonly control: (
    sessionID: Browser.Tab["sessionID"],
    input: Browser.ControlInput,
  ) => Effect.Effect<Status, SessionErrors.NotFoundError | OwnershipError | FenceError | UnavailableError>
  readonly stop: (
    sessionID: Browser.Tab["sessionID"],
  ) => Effect.Effect<void, SessionErrors.NotFoundError | OwnershipError>
  readonly forget: (
    sessionID: Browser.Tab["sessionID"],
  ) => Effect.Effect<void, SessionErrors.NotFoundError | OwnershipError>
  readonly attach: (input: {
    readonly sessionID: Browser.Tab["sessionID"]
    readonly origin: string
    readonly handshake: BrowserProtocol.Handshake
    readonly transport: Transport
  }) => Effect.Effect<Attachment, SessionErrors.NotFoundError | AuthenticationError | BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Browser") {}

export interface Options {
  readonly pairingTTL?: Duration.Input
  readonly commandTimeout?: Duration.Input
}

const DEFAULT_PAIRING_TTL = Duration.minutes(2)
const DEFAULT_COMMAND_TIMEOUT = Duration.seconds(30)
const MAX_PAIRING_ATTEMPTS = 5
const SETTLEMENT_LIMIT = 64

type MutableTab = Types.DeepMutable<Tab> & { elements: Map<string, Browser.Element> }
type PairingState = {
  sessionID: Browser.Tab["sessionID"]
  digest: Uint8Array
  expiresAt: number
  attempts: number
  serverID: string
}
type Trust = {
  readonly credentialID: Credential.ID
  readonly digest: Uint8Array
  readonly extensionID: string
  readonly locationKey: string
  readonly serverID: string
  readonly sessionID: Browser.Tab["sessionID"]
}
type PendingBase = {
  readonly callID: string
  readonly tabID: Browser.TabID
  readonly generation: number
  readonly deferred: Deferred.Deferred<Observation | ActionResult, BridgeError>
  timedOut: boolean
}
type Pending = PendingBase &
  (
    | {
        readonly kind: "observe"
        readonly mutation: false
      }
    | {
        readonly kind: "action"
        readonly mutation: boolean
        readonly fingerprint: string
        readonly documentGeneration: number
      }
  )
type Settlement = {
  readonly fingerprint: string
  readonly result: ActionResult
}
type Connection = {
  readonly token: object
  readonly sessionID: Browser.Tab["sessionID"]
  readonly extensionID: string
  readonly generation: number
  readonly transport: Transport
  readonly tabs: Map<Browser.TabID, MutableTab>
  readonly settlements: Map<string, Settlement>
  connected: boolean
  paused: boolean
  pending?: Pending
}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const sessions = yield* SessionStore.Service
      const credentials = yield* Credential.Service
      const admission = yield* BrowserAdmission.Service
      const events = yield* EventV2.Service
      const pairingTTL = Duration.toMillis(Duration.fromInputUnsafe(options.pairingTTL ?? DEFAULT_PAIRING_TTL))
      const commandTimeout = options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT
      let pairing: PairingState | undefined
      let pairingExpiryTimer: ReturnType<typeof setTimeout> | undefined
      let connection: Connection | undefined
      let nextGeneration = 1
      const locationKey = createHash("sha256")
        .update(JSON.stringify([location.directory, location.workspaceID ?? null]))
        .digest("hex")
      const integrationID = Integration.ID.make(`ycoding.browser.${locationKey}`)

      const loadTrust = Effect.fn("Browser.loadTrust")(function* () {
        const stored = (yield* credentials.list(integrationID))[0]
        if (!stored || stored.value.type !== "key") return undefined
        const metadata = stored.value.metadata
        if (
          metadata?.type !== "browser-extension-trust" ||
          metadata.locationKey !== locationKey ||
          typeof metadata.extensionID !== "string" ||
          typeof metadata.serverID !== "string" ||
          typeof metadata.sessionID !== "string"
        )
          return undefined
        const digest = Buffer.from(stored.value.key, "hex")
        if (digest.byteLength !== 32) return undefined
        return {
          credentialID: stored.id,
          digest,
          extensionID: metadata.extensionID,
          locationKey,
          serverID: metadata.serverID,
          sessionID: Browser.Tab.fields.sessionID.make(metadata.sessionID),
        } satisfies Trust
      })

      const removeTrust = Effect.fn("Browser.removeTrust")(function* () {
        const trust = yield* loadTrust()
        if (trust) yield* credentials.remove(trust.credentialID)
      })

      const assertSession = Effect.fn("Browser.assertSession")(function* (sessionID: Browser.Tab["sessionID"]) {
        const session = yield* sessions.get(sessionID)
        if (!session || session.time.archived) return yield* new SessionErrors.NotFoundError({ sessionID })
        if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
          return yield* new SessionErrors.NotFoundError({ sessionID })
        return session
      })

      function publicTab(tab: MutableTab): Tab {
        const { elements: _elements, ...info } = tab
        return info
      }

      function bridgeStatus(sessionID: Browser.Tab["sessionID"]): Status {
        if (connection?.sessionID === sessionID) {
          return {
            state: !connection.connected
              ? "unavailable"
              : connection.paused || connection.pending?.timedOut
                ? "paused"
                : "connected",
            generation: connection.generation,
            extensionID: connection.extensionID,
            pendingCallID: connection.pending?.callID,
          }
        }
        if (pairing?.sessionID === sessionID) {
          if (pairing.expiresAt > Date.now()) return { state: "pairing", pairingExpiresAt: pairing.expiresAt }
          pairing = undefined
          if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
          pairingExpiryTimer = undefined
          admission.release(sessionID, "selected")
        }
        return { state: "unavailable" }
      }

      const requireConnection = Effect.fn("Browser.requireConnection")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (!connection?.connected)
          return yield* new UnavailableError({ message: "Chrome extension bridge is unavailable" })
        if (connection.sessionID !== sessionID)
          yield* new OwnershipError({ message: "Browser bridge belongs to another Session" })
        return connection
      })

      const requireTab = Effect.fn("Browser.requireTab")(function* (
        sessionID: Browser.Tab["sessionID"],
        tabID: Browser.TabID,
      ) {
        const current = yield* requireConnection(sessionID)
        const tab = current.tabs.get(tabID)
        if (!tab) return yield* new OwnershipError({ message: "Chrome tab is not shared with this Session" })
        return { current, tab }
      })

      function remember(current: Connection, fingerprint: string, result: ActionResult) {
        current.settlements.delete(result.callID)
        current.settlements.set(result.callID, { fingerprint, result })
        while (current.settlements.size > SETTLEMENT_LIMIT) {
          const oldest = current.settlements.keys().next().value
          if (oldest === undefined) break
          current.settlements.delete(oldest)
        }
      }

      function failPending(current: Connection, message: string) {
        const pending = current.pending
        if (!pending) return
        const tab = current.tabs.get(pending.tabID)
        if (pending.mutation && tab) {
          tab.status = "paused"
          tab.pauseReason = "uncertain"
          tab.uncertainCallID = pending.callID
          const uncertain: ActionResult = {
            callID: pending.callID,
            tab: publicTab(tab),
            status: "uncertain",
            message: bounded(`The browser bridge was lost while the mutation was settling: ${message}`, 1024),
          }
          remember(current, pending.fingerprint, uncertain)
          Deferred.doneUnsafe(pending.deferred, Effect.succeed(uncertain))
          current.pending = undefined
          return
        }
        Deferred.doneUnsafe(pending.deferred, Effect.fail(new BridgeError({ message })))
        current.pending = undefined
      }

      const releaseSession = Effect.fn("Browser.releaseSession")((sessionID: Browser.Tab["sessionID"], reason: string) =>
        Effect.sync(() => {
          if (pairing?.sessionID === sessionID) {
            pairing = undefined
            if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
            pairingExpiryTimer = undefined
          }
          if (connection?.sessionID === sessionID) {
            failPending(connection, `Browser ownership ended because the Session was ${reason}`)
            connection.transport.send({ type: "control", action: "stop" })
            connection.transport.close(1000, `session ${reason}`)
            connection.tabs.clear()
            connection.connected = false
            connection = undefined
          }
          admission.release(sessionID, "selected")
        }),
      )

      const status = Effect.fn("Browser.status")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        return bridgeStatus(sessionID)
      })

      const list = Effect.fn("Browser.list")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (connection?.sessionID !== sessionID) return []
        return Array.from(connection.tabs.values(), publicTab)
      })

      const start = Effect.fn("Browser.start")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (!admission.claim(sessionID, "selected"))
          return yield* new BusyError({ message: "Stop the isolated browser before starting selected-tab pairing" })
        const trust = yield* loadTrust()
        yield* removeTrust()
        if (pairing && pairing.sessionID !== sessionID) admission.release(pairing.sessionID, "selected")
        if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
        if (connection) {
          const previousSessionID = connection.sessionID
          connection.transport.send({ type: "control", action: "forget" })
          connection.transport.close(1000, "pairing switched")
          failPending(connection, "Browser pairing switched")
          connection.tabs.clear()
          connection.connected = false
          connection = undefined
          if (previousSessionID !== sessionID) admission.release(previousSessionID, "selected")
        }
        const secret = randomBytes(32).toString("base64url")
        const expiresAt = Date.now() + pairingTTL
        pairing = {
          sessionID,
          digest: createHash("sha256").update(secret).digest(),
          expiresAt,
          attempts: 0,
          serverID: trust?.serverID ?? randomBytes(24).toString("base64url"),
        }
        pairingExpiryTimer = setTimeout(() => {
          if (pairing?.sessionID !== sessionID || pairing.expiresAt !== expiresAt) return
          pairing = undefined
          pairingExpiryTimer = undefined
          admission.release(sessionID, "selected")
        }, pairingTTL)
        pairingExpiryTimer.unref()
        return { secret, expiresAt }
      })

      const dispatch = Effect.fn("Browser.dispatch")(function* (
        current: Connection,
        pending: Pending,
        message: BrowserProtocol.ServerMessage,
      ) {
        if (current.pending)
          return yield* new BusyError({ message: `Browser command ${current.pending.callID} is still unsettled` })
        current.pending = pending
        if (!current.transport.send(message)) {
          current.pending = undefined
          return yield* new UnavailableError({ message: "Chrome extension bridge output queue is full" })
        }
        const result = yield* Deferred.await(pending.deferred).pipe(
          Effect.timeoutOrElse({
            duration: commandTimeout,
            orElse: () => Effect.succeed(undefined),
          }),
        )
        if (result !== undefined) {
          if (current.pending === pending) current.pending = undefined
          return result
        }
        if (!pending.mutation) {
          if (current.pending === pending) current.pending = undefined
          return yield* new UnavailableError({ message: "Chrome extension did not answer before the command deadline" })
        }
        pending.timedOut = true
        const tab = current.tabs.get(pending.tabID)
        if (!tab) return yield* new OwnershipError({ message: "Chrome tab was revoked while the action was pending" })
        tab.status = "paused"
        tab.pauseReason = "uncertain"
        tab.uncertainCallID = pending.callID
        const uncertain: ActionResult = {
          callID: pending.callID,
          tab: publicTab(tab),
          status: "uncertain",
          message:
            "The extension response was lost or late. The action will not be replayed; inspect or stop after reconciliation.",
        }
        remember(current, pending.fingerprint, uncertain)
        return uncertain
      })

      const observe = Effect.fn("Browser.observe")(function* (input: ObserveInput) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (current.paused || tab.status !== "shared")
          return yield* new FenceError({ message: "Chrome tab control is paused" })
        if (tab.generation !== input.generation)
          return yield* new FenceError({ message: "Chrome bridge generation is stale" })
        const deferred = yield* Deferred.make<Observation | ActionResult, BridgeError>()
        const result = yield* dispatch(
          current,
          {
            kind: "observe",
            callID: input.callID,
            tabID: input.tabID,
            generation: input.generation,
            mutation: false,
            deferred,
            timedOut: false,
          },
          { type: "observe", callID: input.callID, tabID: input.tabID, generation: input.generation },
        )
        if (!("elements" in result))
          return yield* new BridgeError({ message: "Extension returned an action result for observe" })
        return result
      })

      const action = Effect.fn("Browser.action")(function* (input: ActionInput) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        const fingerprint = actionFingerprint(input)
        const settled = current.settlements.get(input.callID)
        if (settled) {
          if (settled.fingerprint !== fingerprint)
            return yield* new FenceError({ message: "Browser call ID was already used for a different action" })
          return settled.result
        }
        if (current.paused || tab.status !== "shared")
          return yield* new FenceError({ message: "Chrome tab control is paused" })
        if (
          tab.generation !== input.generation ||
          tab.documentGeneration !== input.documentGeneration ||
          tab.observationRevision !== input.observationRevision
        )
          return yield* new FenceError({ message: "Chrome tab observation is stale; observe again" })
        if (input.action.type !== "navigate" && input.action.type !== "scroll" && input.action.type !== "capture") {
          const element = tab.elements.get(input.action.ref)
          if (!element) return yield* new FenceError({ message: "Semantic element reference is stale" })
          if (element.disabled) return yield* new FenceError({ message: "Semantic element is disabled" })
        }
        const destination = yield* Effect.try({
          try: () =>
            input.action.type === "navigate"
              ? safePage(input.action.url)
              : input.action.type === "click"
                ? tab.elements.get(input.action.ref)?.destination
                : undefined,
          catch: () => new FenceError({ message: "Only credential-free HTTP and HTTPS navigation is supported" }),
        })
        const allowedOrigins = [...new Set([tab.page.origin, ...(destination ? [destination.origin] : [])])]
        const deferred = yield* Deferred.make<Observation | ActionResult, BridgeError>()
        const result = yield* dispatch(
          current,
          {
            kind: "action",
            callID: input.callID,
            tabID: input.tabID,
            generation: input.generation,
            documentGeneration: input.documentGeneration,
            mutation: ["navigate", "click", "type"].includes(input.action.type),
            fingerprint,
            deferred,
            timedOut: false,
          },
          {
            type: "action",
            callID: input.callID,
            tabID: input.tabID,
            generation: input.generation,
            documentGeneration: input.documentGeneration,
            observationRevision: input.observationRevision,
            allowedOrigins,
            action: input.action,
          },
        )
        if (!("status" in result))
          return yield* new BridgeError({ message: "Extension returned an observation for action" })
        remember(current, fingerprint, result)
        return result
      })

      const control = Effect.fn("Browser.control")(function* (
        sessionID: Browser.Tab["sessionID"],
        input: Browser.ControlInput,
      ) {
        const current = yield* requireConnection(sessionID)
        if (input.action === "pause") {
          if (current.pending)
            return yield* new FenceError({ message: "Cannot pause while a browser action is still settling" })
          current.paused = true
          current.transport.send({ type: "control", action: "pause" })
          return bridgeStatus(sessionID)
        }
        if (current.pending)
          return yield* new FenceError({ message: "Cannot resume while an action has an uncertain or pending result" })
        current.paused = false
        for (const tab of current.tabs.values()) {
          tab.observationRevision = 0
          tab.elements.clear()
          if (tab.pauseReason === "requested") {
            tab.status = "shared"
            delete tab.pauseReason
          }
        }
        current.transport.send({ type: "control", action: "resume" })
        return bridgeStatus(sessionID)
      })

      const stop = Effect.fn("Browser.stop")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (pairing?.sessionID === sessionID) {
          pairing = undefined
          if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
          pairingExpiryTimer = undefined
        }
        if (!connection) {
          admission.release(sessionID, "selected")
          return
        }
        if (connection.sessionID !== sessionID)
          yield* new OwnershipError({ message: "Browser bridge belongs to another Session" })
        connection.transport.send({ type: "control", action: "stop" })
        connection.transport.close(1000, "stopped")
        failPending(connection, "Browser bridge stopped")
        connection.tabs.clear()
        connection.connected = false
        connection = undefined
        admission.release(sessionID, "selected")
      })

      const forget = Effect.fn("Browser.forget")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        const trust = yield* loadTrust()
        if (trust && trust.sessionID !== sessionID)
          yield* new OwnershipError({ message: "Browser pairing belongs to another Session" })
        yield* removeTrust()
        if (pairing?.sessionID === sessionID) {
          pairing = undefined
          if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
          pairingExpiryTimer = undefined
        }
        if (!connection) {
          admission.release(sessionID, "selected")
          return
        }
        if (connection.sessionID !== sessionID)
          yield* new OwnershipError({ message: "Browser bridge belongs to another Session" })
        connection.transport.send({ type: "control", action: "forget" })
        connection.transport.close(1000, "pairing forgotten")
        failPending(connection, "Browser pairing forgotten")
        connection.tabs.clear()
        connection.connected = false
        connection = undefined
        admission.release(sessionID, "selected")
      })

      const attach: Interface["attach"] = Effect.fn("Browser.attach")(function* (input) {
        yield* assertSession(input.sessionID)
        const originID = BrowserProtocol.extensionIDFromOrigin(input.origin)
        if (!originID || originID !== input.handshake.extensionID)
          return yield* new AuthenticationError({ message: "Invalid Chrome extension identity" })
        const credential =
          input.handshake.type === "pair"
            ? yield* authenticatePairing(input.sessionID, originID, input.handshake.secret)
            : yield* authenticateTrust(input.sessionID, originID, input.handshake)
        if (!admission.claim(input.sessionID, "selected"))
          return yield* new BusyError({ message: "Stop the isolated browser before attaching selected-tab control" })
        if (connection?.connected)
          return yield* new BusyError({ message: "A Chrome extension bridge is already connected" })
        const current: Connection = {
          token: {},
          sessionID: input.sessionID,
          extensionID: originID,
          generation: nextGeneration++,
          transport: input.transport,
          tabs: new Map(),
          settlements: new Map(),
          connected: true,
          paused: false,
        }
        connection = current
        if (
          !current.transport.send({
            type: "paired",
            version: BrowserProtocol.VERSION,
            generation: current.generation,
            serverID: credential.serverID,
            credential: credential.secret,
          })
        ) {
          connection = undefined
          admission.release(input.sessionID, "selected")
          return yield* new BusyError({ message: "Chrome extension bridge output queue is full" })
        }

        const receive = Effect.fn("Browser.receive")(function* (
          message: Exclude<BrowserProtocol.ClientMessage, BrowserProtocol.Handshake>,
        ) {
          if (connection !== current || !current.connected) return
          if (message.type === "pong") return
          if (message.type === "forget") {
            yield* removeTrust()
            current.transport.send({ type: "control", action: "forget" })
            current.transport.close(1000, "pairing forgotten")
            failPending(current, "Browser pairing forgotten")
            current.tabs.clear()
            current.connected = false
            if (connection === current) connection = undefined
            admission.release(current.sessionID, "selected")
            return
          }
          if (message.type === "shared") {
            if (current.tabs.size >= BrowserProtocol.MAX_SHARED_TABS && !current.tabs.has(message.tabID)) {
              current.transport.send({ type: "error", message: "Shared tab limit reached" })
              return
            }
            const page = safePageMaybe(message.url)
            if (!page) {
              current.transport.send({
                type: "error",
                message: "Only credential-free HTTP and HTTPS tabs can be shared",
              })
              return
            }
            current.tabs.set(message.tabID, {
              id: message.tabID,
              sessionID: current.sessionID,
              title: bounded(message.title, Browser.MAX_TITLE_LENGTH),
              page,
              status: message.active ? "paused" : "shared",
              generation: current.generation,
              documentGeneration: message.documentGeneration,
              observationRevision: 0,
              ...(message.active ? { pauseReason: "user_active" as const } : {}),
              elements: new Map(),
            })
            return
          }
          if (message.type === "revoked") {
            if (current.pending?.tabID === message.tabID) failPending(current, "Chrome tab was revoked")
            current.tabs.delete(message.tabID)
            return
          }
          const tab = current.tabs.get(message.tabID)
          if (!tab) return
          if (message.type === "takeover") {
            tab.documentGeneration = message.documentGeneration
            tab.observationRevision = 0
            tab.elements.clear()
            tab.status = message.active ? "paused" : current.paused ? "paused" : "shared"
            if (message.active) tab.pauseReason = "user_active"
            else if (current.paused) tab.pauseReason = "requested"
            else delete tab.pauseReason
            return
          }
          if (message.type === "updated") {
            const page = safePageMaybe(message.url)
            if (!page) return
            tab.title = bounded(message.title, Browser.MAX_TITLE_LENGTH)
            tab.page = page
            tab.documentGeneration = message.documentGeneration
            tab.observationRevision = 0
            tab.elements.clear()
            return
          }
          const pending = current.pending
          if (!pending || pending.callID !== message.callID || pending.tabID !== message.tabID) return
          if (message.generation !== current.generation) return
          if (message.type === "error") {
            if (pending.mutation && message.dispatched) {
              tab.status = "paused"
              tab.pauseReason = "uncertain"
              tab.uncertainCallID = pending.callID
              const uncertain: ActionResult = {
                callID: pending.callID,
                tab: publicTab(tab),
                status: "uncertain",
                message: bounded(
                  `The extension could not prove whether the mutation completed: ${message.message}`,
                  1024,
                ),
              }
              remember(current, pending.fingerprint, uncertain)
              Deferred.doneUnsafe(pending.deferred, Effect.succeed(uncertain))
              current.pending = undefined
              return
            }
            if (pending.kind === "action") {
              const rejected: ActionResult = {
                callID: pending.callID,
                tab: publicTab(tab),
                status: "rejected",
                message: bounded(`The extension rejected the action before dispatch: ${message.message}`, 1024),
              }
              remember(current, pending.fingerprint, rejected)
              Deferred.doneUnsafe(pending.deferred, Effect.succeed(rejected))
              current.pending = undefined
              return
            }
            Deferred.doneUnsafe(pending.deferred, Effect.fail(new BridgeError({ message: message.message })))
            current.pending = undefined
            return
          }
          if (message.type === "observation" && pending.kind === "observe") {
            const observation = sanitizeObservation(message)
            if (!observation) {
              Deferred.doneUnsafe(
                pending.deferred,
                Effect.fail(new BridgeError({ message: "Extension returned an unsafe page URL" })),
              )
              current.pending = undefined
              return
            }
            tab.title = observation.title
            tab.page = observation.page
            tab.documentGeneration = observation.documentGeneration
            tab.observationRevision = observation.revision
            tab.elements = new Map(observation.elements.map((element) => [element.ref, element]))
            Deferred.doneUnsafe(pending.deferred, Effect.succeed(observation))
            current.pending = undefined
            return
          }
          if (message.type !== "result" || pending.kind !== "action") return
          const page = safePageMaybe(message.url)
          if (!page) {
            Deferred.doneUnsafe(
              pending.deferred,
              Effect.fail(new BridgeError({ message: "Extension returned an unsafe page URL" })),
            )
            current.pending = undefined
            return
          }
          tab.title = bounded(message.title, Browser.MAX_TITLE_LENGTH)
          tab.page = page
          tab.documentGeneration = message.documentGeneration
          tab.observationRevision = message.observationRevision
          tab.elements.clear()
          tab.status = message.status === "paused" ? "paused" : "shared"
          if (message.status === "paused") tab.pauseReason = "user_active"
          else {
            delete tab.pauseReason
            delete tab.uncertainCallID
          }
          const result: ActionResult = {
            callID: message.callID,
            tab: publicTab(tab),
            status: message.status,
            message: message.message,
            capture: message.capture,
          }
          remember(current, pending.fingerprint, result)
          Deferred.doneUnsafe(pending.deferred, Effect.succeed(result))
          current.pending = undefined
        })

        const detach = Effect.sync(() => {
          if (connection !== current || !current.connected) return
          current.connected = false
          current.paused = true
          failPending(current, "Chrome extension bridge disconnected")
          for (const tab of current.tabs.values()) {
            tab.status = "unavailable"
            tab.pauseReason = "disconnected"
            tab.observationRevision = 0
            tab.elements.clear()
          }
        })
        return { receive, detach }
      })

      yield* events.subscribe([SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived]).pipe(
        Stream.runForEach((event) => releaseSession(event.data.sessionID, event.type.slice("session.".length))),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (pairing) admission.release(pairing.sessionID, "selected")
          pairing = undefined
          if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
          pairingExpiryTimer = undefined
          if (!connection) return
          admission.release(connection.sessionID, "selected")
          connection.transport.close(1012, "service shutdown")
          failPending(connection, "Browser service shut down")
          connection.tabs.clear()
          connection = undefined
        }),
      )

      const authenticatePairing = Effect.fn("Browser.authenticatePairing")(function* (
        sessionID: Browser.Tab["sessionID"],
        extensionID: string,
        secret: string,
      ) {
        const expected = pairing
        const supplied = createHash("sha256").update(secret).digest()
        const valid =
          expected?.sessionID === sessionID &&
          expected.expiresAt > Date.now() &&
          expected.attempts < MAX_PAIRING_ATTEMPTS &&
          expected.digest.byteLength === supplied.byteLength &&
          timingSafeEqual(expected.digest, supplied)
        if (!valid) {
          if (expected?.sessionID === sessionID) expected.attempts++
          return yield* new AuthenticationError({ message: "Invalid or expired Chrome pairing" })
        }
        pairing = undefined
        if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
        pairingExpiryTimer = undefined
        const credential = randomBytes(32).toString("base64url")
        yield* credentials.create({
          integrationID,
          label: extensionID,
          value: {
            type: "key",
            key: createHash("sha256").update(credential).digest("hex"),
            metadata: {
              type: "browser-extension-trust",
              extensionID,
              locationKey,
              serverID: expected.serverID,
              sessionID,
            },
          },
        })
        return { serverID: expected.serverID, secret: credential }
      })

      const authenticateTrust = Effect.fn("Browser.authenticateTrust")(function* (
        sessionID: Browser.Tab["sessionID"],
        extensionID: string,
        handshake: Extract<BrowserProtocol.Handshake, { readonly type: "authenticate" }>,
      ) {
        const trust = yield* loadTrust()
        const supplied = createHash("sha256").update(handshake.credential).digest()
        const valid =
          trust?.sessionID === sessionID &&
          trust.extensionID === extensionID &&
          trust.serverID === handshake.serverID &&
          trust.locationKey === locationKey &&
          trust.digest.byteLength === supplied.byteLength &&
          timingSafeEqual(trust.digest, supplied)
        if (!valid) return yield* new AuthenticationError({ message: "Unknown or revoked Chrome pairing" })
        return { serverID: trust.serverID, secret: undefined }
      })

      return Service.of({ status, list, start, observe, action, control, stop, forget, attach })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [BrowserAdmission.node, Credential.node, EventV2.node, Location.node, SessionStore.node],
})

function safePage(input: string): Browser.Page {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only credential-free HTTP and HTTPS pages can be shared")
  return { origin: url.origin, path: url.pathname || "/" }
}

function safePageMaybe(input: string) {
  try {
    return safePage(input)
  } catch {
    return undefined
  }
}

function bounded(input: string, length: number) {
  return input.length <= length ? input : input.slice(0, length)
}

function actionFingerprint(input: ActionInput) {
  const fence = [input.sessionID, input.tabID, input.generation, input.documentGeneration, input.observationRevision]
  if (input.action.type === "navigate") return JSON.stringify([...fence, "navigate", input.action.url])
  if (input.action.type === "click") return JSON.stringify([...fence, "click", input.action.ref])
  if (input.action.type === "type") return JSON.stringify([...fence, "type", input.action.ref, input.action.text])
  if (input.action.type === "scroll") return JSON.stringify([...fence, "scroll", input.action.deltaY])
  return JSON.stringify([...fence, "capture"])
}

function sanitizeObservation(
  message: Extract<BrowserProtocol.ClientMessage, { readonly type: "observation" }>,
): Observation | undefined {
  const page = safePageMaybe(message.url)
  if (!page) return undefined
  const elements = message.elements.slice(0, Browser.MAX_OBSERVATION_ELEMENTS).map((element) => ({
    ref: element.ref,
    role: bounded(element.role, 64),
    name: bounded(element.name, Browser.MAX_NAME_LENGTH),
    description: element.description ? bounded(element.description, Browser.MAX_NAME_LENGTH) : undefined,
    disabled: element.disabled,
    destination: element.destination ? safePageMaybe(element.destination) : undefined,
  }))
  return {
    tabID: message.tabID,
    generation: message.generation,
    documentGeneration: message.documentGeneration,
    revision: message.revision,
    title: bounded(message.title, Browser.MAX_TITLE_LENGTH),
    page,
    elements,
    truncated: message.truncated || message.elements.length > Browser.MAX_OBSERVATION_ELEMENTS,
  }
}
