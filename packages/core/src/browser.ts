export * as Browser from "./browser"
import { BrowserOperation } from "./browser/operation"
import { Hash } from "./util/hash"

import { Browser } from "@ycoding-ai/schema/browser"
import { Integration } from "@ycoding-ai/schema/integration"
import { Context, Deferred, Duration, Effect, Layer, Schema, Stream, Types } from "effect"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Global } from "./global"
import { BrowserProtocol } from "./browser/protocol"
import { BrowserAdmission } from "./browser/admission"
import { Credential } from "./credential"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { EventRuntime } from "./event"
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
export const OpenInput = Browser.OpenInput
export const CloseInput = Browser.CloseInput
export const ReleaseInput = Browser.ReleaseInput
export const ActionResult = Browser.ActionResult
export const HistoryInput = Browser.HistoryInput
export const HistoryResult = Browser.HistoryResult
export const ControlInput = Browser.ControlInput
export const MAX_CAPTURE_BYTES = Browser.MAX_CAPTURE_BYTES

export type Status = Browser.Status
export type Tab = Browser.Tab
export type Pairing = Browser.Pairing
export type Observation = Browser.Observation
export type ActionInput = Browser.ActionInput
export type ObserveInput = Browser.ObserveInput
export type OpenInput = Browser.OpenInput
export type CloseInput = Browser.CloseInput
export type ReleaseInput = Browser.ReleaseInput
export type ActionResult = Browser.ActionResult
export type HistoryInput = Browser.HistoryInput
export type HistoryResult = Browser.HistoryResult

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
  readonly actionIdentity: (input: Omit<ActionInput, "callID">) => Effect.Effect<BrowserOperation.Identity, SessionErrors.NotFoundError | OwnershipError | FenceError | UnavailableError>
  readonly status: (sessionID: Browser.Tab["sessionID"]) => Effect.Effect<Status, SessionErrors.NotFoundError>
  readonly list: (sessionID: Browser.Tab["sessionID"]) => Effect.Effect<ReadonlyArray<Tab>, SessionErrors.NotFoundError>
  readonly start: (
    sessionID: Browser.Tab["sessionID"],
  ) => Effect.Effect<Pairing, SessionErrors.NotFoundError | BusyError>
  readonly open: (input: OpenInput) => Effect.Effect<Tab, SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError>
  readonly close: (input: CloseInput) => Effect.Effect<void, SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError>
  readonly release: (
    input: ReleaseInput,
  ) => Effect.Effect<void, SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError>
  readonly observe: (
    input: ObserveInput,
  ) => Effect.Effect<
    Observation,
    SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError
  >
  readonly clickDestination: (
    input: Pick<ActionInput, "sessionID" | "tabID" | "generation" | "documentGeneration" | "observationRevision"> & {
      readonly ref: string
    },
  ) => Effect.Effect<Browser.Page | undefined, SessionErrors.NotFoundError | OwnershipError | FenceError | UnavailableError>
  readonly elementFrame: (
    input: Pick<ActionInput, "sessionID" | "tabID" | "generation" | "documentGeneration" | "observationRevision"> & {
      readonly ref: string
    },
  ) => Effect.Effect<Browser.Page | undefined, SessionErrors.NotFoundError | OwnershipError | FenceError | UnavailableError>
  readonly action: (
    input: ActionInput,
  ) => Effect.Effect<
    ActionResult,
    SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError | BridgeError
  >
  readonly history: (
    input: HistoryInput,
  ) => Effect.Effect<
    HistoryResult,
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
    readonly origin: string
    readonly handshake: BrowserProtocol.Handshake
    readonly transport: Transport
  }) => Effect.Effect<Attachment, SessionErrors.NotFoundError | AuthenticationError | BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Browser") {}

export interface Options {
  readonly pairingTTL?: Duration.Input
  readonly commandTimeout?: Duration.Input
}

const DEFAULT_PAIRING_TTL = Duration.minutes(2)
const DEFAULT_COMMAND_TIMEOUT = Duration.seconds(30)
const MAX_PAIRING_ATTEMPTS = 5
const SETTLEMENT_LIMIT = 64
const LEASE_HELD = "Chrome tab is controlled by another Session; wait for it to release control"

type MutableTab = Types.DeepMutable<Tab> & {
  pageIdentity: string
  elements: Map<string, BrowserOperation.Element>
  allowedOrigins?: Set<string>
  frameOrigins?: Set<string>
  leaseSessionID?: Browser.Tab["sessionID"]
}
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
  readonly serverID: string
  readonly sessionID: Browser.Tab["sessionID"]
}
type PendingBase = {
  readonly callID: string
  readonly tabID: Browser.TabID
  readonly sessionID: Browser.Tab["sessionID"]
  readonly generation: number
  readonly deferred: Deferred.Deferred<Observation | ActionResult, BridgeError>
  timedOut: boolean
}
type Pending = PendingBase &
  (
    | {
        readonly kind: "observe" | "relinquish"
        readonly mutation: false
      }
    | {
        readonly kind: "action"
        readonly mutation: boolean
        readonly fingerprint: string
        readonly documentGeneration: number
        readonly actionType?: Browser.Action["type"]
        exportData?: string
      }
    | { readonly kind: "open" | "close"; readonly mutation: true; readonly fingerprint: string }
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
  readonly openCalls: Map<string, { readonly url: string; readonly tabID: Browser.TabID }>
  readonly closeCalls: Set<string>
  connected: boolean
  paused: boolean
  profileGranted: boolean
  pending?: Pending
  historyPending?: {
    readonly callID: string
    readonly sessionID: Browser.Tab["sessionID"]
    readonly deferred: Deferred.Deferred<HistoryResult, BridgeError>
  }
}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const sessions = yield* SessionStore.Service
      const credentials = yield* Credential.Service
      const admission = yield* BrowserAdmission.Service
      const events = yield* EventRuntime.Service
      const pairingTTL = Duration.toMillis(Duration.fromInputUnsafe(options.pairingTTL ?? DEFAULT_PAIRING_TTL))
      const commandTimeout = options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT
      let pairing: PairingState | undefined
      let pairingExpiryTimer: ReturnType<typeof setTimeout> | undefined
      let connection: Connection | undefined
      let nextGeneration = 1
      const integrationID = Integration.ID.make("ycoding.browser")

      const loadTrust = Effect.fn("Browser.loadTrust")(function* () {
        const stored = (yield* credentials.list(integrationID))[0]
        if (!stored || stored.value.type !== "key") return undefined
        const metadata = stored.value.metadata
        if (
          metadata?.type !== "browser-extension-trust" ||
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
        return session
      })

      function publicTab(tab: MutableTab, sessionID: Browser.Tab["sessionID"]): Tab {
        const { elements: _elements, pageIdentity: _pageIdentity, allowedOrigins: _allowedOrigins, frameOrigins: _frameOrigins, leaseSessionID, ...info } = tab
        return {
          ...info,
          sessionID: tab.mode === "owned" ? tab.sessionID : sessionID,
          ...(tab.mode === "profile" && leaseSessionID !== undefined
            ? { lease: leaseSessionID === sessionID ? ("self" as const) : ("other" as const) }
            : {}),
        }
      }

      function heldByOther(tab: MutableTab | undefined, sessionID: Browser.Tab["sessionID"]) {
        return tab?.mode === "profile" && tab.leaseSessionID !== undefined && tab.leaseSessionID !== sessionID
      }

      function bridgeStatus(sessionID: Browser.Tab["sessionID"], paired: boolean): Status {
        if (connection) {
          return {
            state: !connection.connected
              ? "unavailable"
              : connection.paused || connection.pending?.timedOut
                ? "paused"
                : "connected",
            paired,
            generation: connection.generation,
            extensionID: connection.extensionID,
            profileGranted: connection.profileGranted,
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
        return { state: "unavailable", paired }
      }

      const requireConnection = Effect.fn("Browser.requireConnection")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (admission.current(sessionID) === "isolated")
          return yield* new OwnershipError({ message: "Stop the isolated browser before using paired Chrome tabs" })
        if (!connection?.connected)
          return yield* new UnavailableError({ message: "Chrome extension bridge is unavailable" })
        return connection
      })

      const requireTab = Effect.fn("Browser.requireTab")(function* (
        sessionID: Browser.Tab["sessionID"],
        tabID: Browser.TabID,
      ) {
        const current = yield* requireConnection(sessionID)
        const tab = current.tabs.get(tabID)
        if (!tab || (tab.mode === "owned" && tab.sessionID !== sessionID))
          return yield* new OwnershipError({ message: "Chrome tab is not owned by this Session" })
        if (heldByOther(tab, sessionID)) return yield* new OwnershipError({ message: LEASE_HELD })
        return { current, tab }
      })

      function remember(current: Connection, fingerprint: string, result: ActionResult, key: string) {
        current.settlements.delete(key)
        current.settlements.set(key, { fingerprint, result })
        while (current.settlements.size > SETTLEMENT_LIMIT) {
          const oldest = current.settlements.keys().next().value
          if (oldest === undefined) break
          current.settlements.delete(oldest)
        }
      }

      function failPending(current: Connection, message: string) {
        if (current.historyPending) {
          Deferred.doneUnsafe(current.historyPending.deferred, Effect.fail(new BridgeError({ message })))
          current.historyPending = undefined
        }
        const pending = current.pending
        if (!pending) return
        const tab = current.tabs.get(pending.tabID)
        if (pending.mutation && tab) {
          tab.status = "paused"
          tab.pauseReason = "uncertain"
          tab.uncertainCallID = pending.callID
          const uncertain: ActionResult = {
            callID: pending.callID,
            tab: publicTab(tab, pending.sessionID),
            status: "uncertain",
            message: bounded(`The browser bridge was lost while the mutation was settling: ${message}`, 1024),
          }
          remember(current, pending.fingerprint, uncertain, `${pending.sessionID}\0${pending.callID}`)
          Deferred.doneUnsafe(pending.deferred, Effect.succeed(uncertain))
          current.pending = undefined
          return
        }
        Deferred.doneUnsafe(pending.deferred, Effect.fail(new BridgeError({ message })))
        current.pending = undefined
      }

      const releaseSession = Effect.fn("Browser.releaseSession")((sessionID: Browser.Tab["sessionID"]) =>
        Effect.sync(() => {
          if (pairing?.sessionID === sessionID) {
            pairing = undefined
            if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
            pairingExpiryTimer = undefined
          }
          if (connection?.pending?.sessionID === sessionID)
            failPending(connection, "Browser caller Session ended while a command was settling")
          if (connection) {
            for (const tab of connection.tabs.values()) {
              if (tab.mode !== "owned" || tab.sessionID !== sessionID) continue
              connection.tabs.delete(tab.id)
              connection.transport.send({ type: "release", tabID: tab.id, generation: connection.generation })
            }
          }
          admission.release(sessionID, "selected")
        }),
      )

      const status = Effect.fn("Browser.status")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (admission.current(sessionID) === "isolated") return { state: "unavailable" as const }
        return bridgeStatus(sessionID, !!(yield* loadTrust()))
      })

      const list = Effect.fn("Browser.list")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (!connection || admission.current(sessionID) === "isolated") return []
        return Array.from(connection.tabs.values())
          .filter((tab) => tab.mode !== "owned" || tab.sessionID === sessionID)
          .map((tab) => publicTab(tab, sessionID))
      })

      const start = Effect.fn("Browser.start")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        if (!admission.claim(sessionID, "selected"))
          return yield* new BusyError({ message: "Stop the isolated browser before starting Chrome pairing" })
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
        claim: ReadonlyArray<MutableTab> = [],
      ) {
        if (claim.some((tab) => heldByOther(tab, pending.sessionID)))
          return yield* new OwnershipError({ message: LEASE_HELD })
        if (current.pending)
          return yield* new BusyError({ message: `Browser command ${current.pending.callID} is still unsettled` })
        if (current.historyPending)
          return yield* new BusyError({ message: `Browser command ${current.historyPending.callID} is still unsettled` })
        const claimed = claim.filter((tab) => tab.mode === "profile" && tab.leaseSessionID === undefined)
        for (const tab of claimed) tab.leaseSessionID = pending.sessionID
        const unclaim = () => {
          for (const tab of claimed) if (tab.leaseSessionID === pending.sessionID) delete tab.leaseSessionID
        }
        current.pending = pending
        if (!current.transport.send(message)) {
          current.pending = undefined
          unclaim()
          return yield* new UnavailableError({ message: "Chrome extension bridge output queue is full" })
        }
        const result = yield* Deferred.await(pending.deferred).pipe(
          Effect.tapError(() => Effect.sync(unclaim)),
          Effect.timeoutOrElse({
            duration: commandTimeout,
            orElse: () => Effect.succeed(undefined),
          }),
        )
        if (result !== undefined) {
          if (current.pending === pending) current.pending = undefined
          if ("status" in result && result.status === "rejected") unclaim()
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
          tab: publicTab(tab, pending.sessionID),
          status: "uncertain",
          message:
            "The extension response was lost or late. The action will not be replayed; inspect or stop after reconciliation.",
        }
        remember(current, pending.fingerprint, uncertain, `${pending.sessionID}\0${pending.callID}`)
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
            sessionID: input.sessionID,
            generation: input.generation,
            mutation: false,
            deferred,
            timedOut: false,
          },
          {
            type: "observe",
            callID: input.callID,
            tabID: input.tabID,
            generation: input.generation,
            frameOrigins: [...(tab.frameOrigins ?? [])],
          },
          [tab],
        )
        if (!("elements" in result))
          return yield* new BridgeError({ message: "Extension returned an action result for observe" })
        return result
      })

      const history = Effect.fn("Browser.history")(function* (input: HistoryInput) {
        const current = yield* requireConnection(input.sessionID)
        if (current.paused)
          return yield* new FenceError({ message: "Chrome tab control is paused" })
        if (input.generation !== current.generation)
          return yield* new FenceError({ message: "Chrome bridge generation is stale" })
        if (current.pending)
          return yield* new BusyError({ message: `Browser command ${current.pending.callID} is still unsettled` })
        if (current.historyPending)
          return yield* new BusyError({ message: `Browser command ${current.historyPending.callID} is still unsettled` })
        const deferred = yield* Deferred.make<HistoryResult, BridgeError>()
        const pending = { callID: input.callID, sessionID: input.sessionID, deferred }
        current.historyPending = pending
        if (
          !current.transport.send({
            type: "history",
            callID: input.callID,
            generation: current.generation,
            query: input.query,
            limit: input.limit,
            startTime: input.startTime,
            endTime: input.endTime,
          })
        ) {
          if (current.historyPending === pending) current.historyPending = undefined
          return yield* new UnavailableError({ message: "Chrome extension bridge output queue is full" })
        }
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({ duration: commandTimeout, orElse: () => Effect.succeed(undefined) }),
        )
        if (current.historyPending === pending) current.historyPending = undefined
        if (result === undefined)
          return yield* new UnavailableError({ message: "Chrome extension did not answer before the command deadline" })
        return result
      })

      const writeExport = Effect.fn("Browser.writeExport")(function* (tab: MutableTab, data: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const bytes = Buffer.byteLength(data, "utf8")
            if (bytes > Browser.MAX_EXPORT_BYTES) throw new Error("Export exceeds the 8 MiB limit")
            const directory = join(Global.Path.data, "browser-exports")
            await mkdir(directory, { recursive: true, mode: 0o700 })
            const name = `${(tab.title || "page").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64) || "page"}-${Date.now()}-${randomBytes(3).toString("hex")}.mhtml`
            const path = join(directory, name)
            await writeFile(path, data, { encoding: "utf8", mode: 0o600 })
            return { path, bytes }
          },
          catch: (cause) =>
            new BridgeError({
              message: bounded(cause instanceof Error ? cause.message : "Browser export could not be saved", 1024),
            }),
        })
      })

      const open = Effect.fn("Browser.open")(function* (input: OpenInput) {
        const current = yield* requireConnection(input.sessionID)
        if (input.generation !== current.generation)
          return yield* new FenceError({ message: "Chrome bridge generation is stale" })
        if (current.paused) return yield* new FenceError({ message: "Chrome bridge is paused" })
        const page = yield* Effect.try({
          try: () => safePage(input.url),
          catch: () => new FenceError({ message: "Only credential-free HTTP and HTTPS navigation is supported" }),
        })
        const key = `${input.sessionID}\0${input.callID}`
        const prior = current.openCalls.get(key)
        if (prior) return yield* new FenceError({ message: "Browser open call ID was already used; list tabs before continuing" })
        if (current.openCalls.size >= SETTLEMENT_LIMIT)
          return yield* new BusyError({ message: "Chrome open call limit reached; reconnect before opening more tabs" })
        if ([...current.tabs.values()].filter((tab) => tab.mode !== "profile").length >= BrowserProtocol.MAX_SHARED_TABS)
          return yield* new BusyError({ message: "Chrome tab limit reached" })
        const tabID = Browser.TabID.create()
        current.openCalls.set(key, { url: input.url, tabID })
        const deferred = yield* Deferred.make<Observation | ActionResult, BridgeError>()
        const result = yield* dispatch(current, {
          kind: "open", mutation: true, callID: input.callID, tabID, sessionID: input.sessionID,
          generation: current.generation, fingerprint: JSON.stringify([key, input.url]), deferred, timedOut: false,
        }, { type: "open", callID: input.callID, tabID, generation: current.generation, url: input.url })
        if (!("status" in result) || result.tab.page.origin !== page.origin)
          return yield* new BridgeError({ message: "Chrome tab reached an unapproved site" })
        return result.tab
      })

      const close = Effect.fn("Browser.close")(function* (input: CloseInput) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (tab.mode !== "owned")
          return yield* new OwnershipError({ message: "Only agent-created tabs can be closed" })
        if (tab.generation !== input.generation)
          return yield* new FenceError({ message: "Chrome bridge generation is stale" })
        const key = `${input.sessionID}\0${input.callID}`
        if (current.closeCalls.has(key))
          return yield* new FenceError({ message: "Browser close call ID was already used; list tabs before continuing" })
        if (current.closeCalls.size >= SETTLEMENT_LIMIT)
          return yield* new BusyError({ message: "Chrome close call limit reached; reconnect before closing more tabs" })
        if (current.pending)
          return yield* new BusyError({ message: `Browser command ${current.pending.callID} is still unsettled` })
        current.closeCalls.add(key)
        const deferred = yield* Deferred.make<Observation | ActionResult, BridgeError>()
        const result = yield* dispatch(current, {
          kind: "close", mutation: true, callID: input.callID, tabID: input.tabID,
          sessionID: input.sessionID, generation: input.generation,
          fingerprint: JSON.stringify([input.sessionID, input.callID, input.tabID, input.generation]),
          deferred, timedOut: false,
        }, { type: "close", callID: input.callID, tabID: input.tabID, generation: input.generation })
        if (!("status" in result) || result.status !== "completed")
          return yield* new BridgeError({ message: "Chrome tab close did not settle" })
        return yield* Effect.void
      })

      const relinquishTab = Effect.fn("Browser.relinquishTab")(function* (
        current: Connection,
        tab: MutableTab,
        sessionID: Browser.Tab["sessionID"],
        callID: string,
      ) {
        const deferred = yield* Deferred.make<Observation | ActionResult, BridgeError>()
        const settled = yield* dispatch(
          current,
          {
            kind: "relinquish", mutation: false, callID, tabID: tab.id, sessionID,
            generation: current.generation, deferred, timedOut: false,
          },
          { type: "relinquish", callID, tabID: tab.id, generation: current.generation },
        ).pipe(
          Effect.as(true),
          Effect.catchTag("Browser.BridgeError", (error) =>
            current.tabs.get(tab.id) === tab ? Effect.fail(error) : Effect.succeed(false),
          ),
        )
        if (!settled || tab.leaseSessionID !== sessionID) return
        delete tab.leaseSessionID
        tab.observationRevision = 0
        tab.elements.clear()
      })

      const release = Effect.fn("Browser.release")(function* (input: ReleaseInput) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (tab.mode !== "profile")
          return yield* new OwnershipError({ message: "Only paired profile tab control can be released" })
        if (tab.generation !== input.generation)
          return yield* new FenceError({ message: "Chrome bridge generation is stale" })
        if (tab.leaseSessionID === undefined) return yield* Effect.void
        return yield* relinquishTab(current, tab, input.sessionID, input.callID)
      })

      const relinquishSession = Effect.fn("Browser.relinquishSession")(function* (sessionID: Browser.Tab["sessionID"]) {
        const current = connection
        if (!current) return yield* Effect.void
        const held = (tab: MutableTab) =>
          connection === current && current.connected && current.tabs.get(tab.id) === tab && tab.leaseSessionID === sessionID
        for (const tab of current.tabs.values()) {
          while (held(tab)) {
            const busy = current.pending
            if (busy) {
              yield* Deferred.await(busy.deferred).pipe(Effect.ignore)
              continue
            }
            const outcome = yield* relinquishTab(current, tab, sessionID, `relinquish-${randomBytes(9).toString("base64url")}`).pipe(
              Effect.as("settled" as const),
              Effect.catchTag("Browser.BusyError", () => Effect.succeed("busy" as const)),
              Effect.catch((error) =>
                Effect.logWarning("Failed to release paired Chrome tab control", { tabID: tab.id, error }).pipe(
                  Effect.as("failed" as const),
                ),
              ),
            )
            if (outcome !== "busy") break
          }
        }
        return yield* Effect.void
      })

      const clickDestination = Effect.fn("Browser.clickDestination")(function* (
        input: Parameters<Interface["clickDestination"]>[0],
      ) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (current.paused || tab.status !== "shared")
          return yield* new FenceError({ message: "Chrome tab control is paused" })
        if (
          tab.generation !== input.generation ||
          tab.documentGeneration !== input.documentGeneration ||
          tab.observationRevision !== input.observationRevision
        )
          return yield* new FenceError({ message: "Chrome tab observation is stale; observe again" })
        const element = tab.elements.get(input.ref)
        if (!element || element.disabled)
          return yield* new FenceError({ message: "Semantic element reference is stale or disabled" })
        return element.destination
      })

      const elementFrame = Effect.fn("Browser.elementFrame")(function* (
        input: Parameters<Interface["elementFrame"]>[0],
      ) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (current.paused || tab.status !== "shared")
          return yield* new FenceError({ message: "Chrome tab control is paused" })
        if (
          tab.generation !== input.generation ||
          tab.documentGeneration !== input.documentGeneration ||
          tab.observationRevision !== input.observationRevision
        )
          return yield* new FenceError({ message: "Chrome tab observation is stale; observe again" })
        const element = tab.elements.get(input.ref)
        if (!element || element.disabled)
          return yield* new FenceError({ message: "Semantic element reference is stale or disabled" })
        return element.frame
      })

      const actionIdentity: Interface["actionIdentity"] = Effect.fn("Browser.actionIdentity")(function* (input) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (current.paused || tab.status !== "shared" || tab.generation !== input.generation ||
          tab.documentGeneration !== input.documentGeneration || tab.observationRevision !== input.observationRevision)
          return yield* new FenceError({ message: "Chrome tab observation is stale or paused; observe again" })
        const identity = BrowserOperation.actionIdentity(tab, input.action, tab.elements)
        if (identity === undefined) return yield* new FenceError({ message: "Semantic target is stale or disabled; observe again" })
        return identity
      })

      const action = Effect.fn("Browser.action")(function* (input: ActionInput) {
        const { current, tab } = yield* requireTab(input.sessionID, input.tabID)
        if (input.action.type === "group" || input.action.type === "ungroup") {
          if (!current.profileGranted || tab.mode !== "profile" || !input.action.tabIDs.includes(tab.id) ||
              new Set(input.action.tabIDs).size !== input.action.tabIDs.length ||
              input.action.tabIDs.some((id) => current.tabs.get(id)?.mode !== "profile"))
            return yield* new OwnershipError({ message: "Group actions require granted profile tabs" })
          if (input.action.tabIDs.some((id) => heldByOther(current.tabs.get(id), input.sessionID)))
            return yield* new OwnershipError({ message: LEASE_HELD })
        }
        const fingerprint = actionFingerprint(input)
        const settlementKey = `${input.sessionID}\0${input.callID}`
        const settled = current.settlements.get(settlementKey)
        if (settled) {
          if (settled.fingerprint !== fingerprint)
            return yield* new FenceError({ message: "Browser call ID was already used for a different action" })
          return { ...settled.result, tab: { ...settled.result.tab, sessionID: input.sessionID } }
        }
        if (current.paused || tab.status !== "shared")
          return yield* new FenceError({ message: "Chrome tab control is paused" })
        if (
          tab.generation !== input.generation ||
          tab.documentGeneration !== input.documentGeneration ||
          tab.observationRevision !== input.observationRevision
        )
          return yield* new FenceError({ message: "Chrome tab observation is stale; observe again" })
        if (input.action.type === "click" || input.action.type === "type" || input.action.type === "upload") {
          const element = tab.elements.get(input.action.ref)
          if (!element) return yield* new FenceError({ message: "Semantic element reference is stale" })
          if (element.disabled) return yield* new FenceError({ message: "Semantic element is disabled" })
        }
        if (input.action.type === "upload") {
          const uploadPaths = input.action.paths
          yield* Effect.tryPromise({
            try: async () => {
              for (const path of uploadPaths) {
                if (!isAbsolute(path)) throw new Error("Upload paths must be absolute")
                const info = await stat(path)
                if (!info.isFile()) throw new Error("Upload path is not a regular file")
              }
            },
            catch: () => new FenceError({ message: "Upload file does not exist or is not a regular file" }),
          })
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
        const allowedOrigins = [...new Set([tab.page.origin, ...(destination ? [destination.origin] : []),
          ...((input.action.type === "group" || input.action.type === "ungroup")
            ? input.action.tabIDs.map((id) => current.tabs.get(id)!.page.origin) : [])])]
        if (tab.mode === "owned") tab.allowedOrigins = new Set(allowedOrigins)
        const actionRef =
          input.action.type === "click" || input.action.type === "type" || input.action.type === "wait" || input.action.type === "upload"
            ? input.action.ref
            : undefined
        const targetElement = actionRef ? tab.elements.get(actionRef) : undefined
        const frameOrigins = [...new Set([...(tab.frameOrigins ?? []),
          ...(targetElement?.frame ? [targetElement.frame.origin] : [])])]
        const deferred = yield* Deferred.make<Observation | ActionResult, BridgeError>()
        const pendingAction: Pending = {
          kind: "action",
          callID: input.callID,
          tabID: input.tabID,
          sessionID: input.sessionID,
          generation: input.generation,
          documentGeneration: input.documentGeneration,
          mutation: ["navigate", "click", "type", "group", "ungroup", "back", "forward", "reload", "key", "clipboard_write", "upload", "webmcp_invoke"].includes(input.action.type),
          fingerprint,
          actionType: input.action.type,
          deferred,
          timedOut: false,
        }
        const result = yield* dispatch(
          current,
          pendingAction,
          {
            type: "action",
            callID: input.callID,
            tabID: input.tabID,
            generation: input.generation,
            documentGeneration: input.documentGeneration,
            observationRevision: input.observationRevision,
            allowedOrigins,
            frameOrigins,
            action: input.action,
          },
          input.action.type === "group" || input.action.type === "ungroup"
            ? input.action.tabIDs.flatMap((id) => current.tabs.get(id) ?? [])
            : [tab],
        )
        if (!("status" in result))
          return yield* new BridgeError({ message: "Extension returned an observation for action" })
        let finalResult = result
        if (input.action.type === "export" && result.status === "completed") {
          const exportData = pendingAction.kind === "action" ? pendingAction.exportData : undefined
          if (!exportData) return yield* new BridgeError({ message: "Extension returned no MHTML data for export" })
          finalResult = { ...result, savedFile: yield* writeExport(tab, exportData) }
        }
        remember(current, fingerprint, finalResult, settlementKey)
        return { ...finalResult, tab: { ...finalResult.tab, sessionID: input.sessionID } }
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
          return bridgeStatus(sessionID, !!(yield* loadTrust()))
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
        return bridgeStatus(sessionID, !!(yield* loadTrust()))
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
        if (admission.current(sessionID) === "isolated")
          yield* new OwnershipError({ message: "Stop the isolated browser before using paired Chrome tabs" })
        const bootstrapSessionID = connection.sessionID
        connection.transport.send({ type: "control", action: "stop" })
        connection.transport.close(1000, "stopped")
        failPending(connection, "Browser bridge stopped")
        connection.tabs.clear()
        connection.connected = false
        connection = undefined
        admission.release(bootstrapSessionID, "selected")
      })

      const forget = Effect.fn("Browser.forget")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        yield* removeTrust()
        if (pairing) {
          admission.release(pairing.sessionID, "selected")
          pairing = undefined
          if (pairingExpiryTimer) clearTimeout(pairingExpiryTimer)
          pairingExpiryTimer = undefined
        }
        if (!connection) return
        const bootstrapSessionID = connection.sessionID
        connection.transport.send({ type: "control", action: "forget" })
        connection.transport.close(1000, "pairing forgotten")
        failPending(connection, "Browser pairing forgotten")
        connection.tabs.clear()
        connection.connected = false
        connection = undefined
        admission.release(bootstrapSessionID, "selected")
      })

      const attach: Interface["attach"] = Effect.fn("Browser.attach")(function* (input) {
        const originID = BrowserProtocol.extensionIDFromOrigin(input.origin)
        if (!originID || originID !== input.handshake.extensionID)
          return yield* new AuthenticationError({ message: "Invalid Chrome extension identity" })
        const credential =
          input.handshake.type === "pair"
            ? yield* authenticatePairing(originID, input.handshake.secret)
            : yield* authenticateTrust(originID, input.handshake)
        const sessionID = credential.sessionID
        if (!admission.claim(sessionID, "selected"))
          return yield* new BusyError({ message: "Stop the isolated browser before attaching Chrome control" })
        if (connection?.connected)
          return yield* new BusyError({ message: "A Chrome extension bridge is already connected" })
        const current: Connection = {
          token: {},
          sessionID,
          extensionID: originID,
          generation: nextGeneration++,
          transport: input.transport,
          tabs: new Map(),
          settlements: new Map(),
          openCalls: new Map(),
          closeCalls: new Set(),
          connected: true,
          paused: false,
          profileGranted: false,
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
          admission.release(sessionID, "selected")
          return yield* new BusyError({ message: "Chrome extension bridge output queue is full" })
        }

        const receive = Effect.fn("Browser.receive")(function* (
          message: Exclude<BrowserProtocol.ClientMessage, BrowserProtocol.Handshake>,
        ) {
          if (connection !== current || !current.connected) return
          if (message.type === "pong") return
          if (message.type === "history_result" || message.type === "history_error") {
            const historyPending = current.historyPending
            if (!historyPending || historyPending.callID !== message.callID || message.generation !== current.generation) return
            current.historyPending = undefined
            Deferred.doneUnsafe(
              historyPending.deferred,
              message.type === "history_error"
                ? Effect.fail(new BridgeError({ message: bounded(message.message, 1024) }))
                : Effect.succeed(sanitizeHistory(message)),
            )
            return
          }
          if (message.type === "profile_access") {
            current.profileGranted = message.enabled
            if (!message.enabled)
              for (const tab of current.tabs.values()) if (tab.mode === "profile") current.tabs.delete(tab.id)
            return
          }
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
            if (current.tabs.get(message.tabID)?.mode === "owned") return
            if (message.mode !== "profile" || !current.profileGranted) return
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
              page, pageIdentity: Hash.sha256(message.url),
              status: current.paused ? "paused" : "shared",
              generation: current.generation,
              documentGeneration: message.documentGeneration,
              observationRevision: 0,
              mode: "profile",
              ...(current.paused ? { pauseReason: "requested" as const } : {}),
              elements: new Map(),
            })
            return
          }
          if (message.type === "revoked") {
            if (current.pending?.tabID === message.tabID) failPending(current, "Chrome tab was revoked")
            current.tabs.delete(message.tabID)
            return
          }
          const pending = current.pending
          if (pending?.kind === "open" && message.type === "opened" &&
              pending.callID === message.callID && pending.tabID === message.tabID &&
              message.generation === current.generation) {
            const request = current.openCalls.get(`${pending.sessionID}\0${pending.callID}`)
            const page = safePageMaybe(message.url)
            const expected = request && safePageMaybe(request.url)
            if (!page || !expected || page.origin !== expected.origin) {
              Deferred.doneUnsafe(pending.deferred, Effect.fail(new BridgeError({ message: "Chrome tab reached an unapproved site" })))
              current.pending = undefined
              current.transport.send({ type: "close", callID: pending.callID, tabID: pending.tabID, generation: current.generation })
              return
            }
            const owned: MutableTab = {
              id: message.tabID, sessionID: pending.sessionID, mode: "owned",
              title: bounded(message.title, Browser.MAX_TITLE_LENGTH), page, pageIdentity: Hash.sha256(message.url),
              status: current.paused ? "paused" : "shared", generation: current.generation,
              documentGeneration: message.documentGeneration, observationRevision: 0,
              ...(current.paused ? { pauseReason: "requested" as const } : {}),
              elements: new Map(), allowedOrigins: new Set([page.origin]),
            }
            current.tabs.set(owned.id, owned)
            Deferred.doneUnsafe(pending.deferred, Effect.succeed({ callID: pending.callID, tab: publicTab(owned, pending.sessionID), status: "completed" }))
            current.pending = undefined
            return
          }
          if (
            pending?.kind === "relinquish" && message.type === "relinquished" &&
            pending.callID === message.callID && pending.tabID === message.tabID &&
            message.generation === current.generation
          ) {
            const released = current.tabs.get(message.tabID)
            Deferred.doneUnsafe(
              pending.deferred,
              released
                ? Effect.succeed({ callID: pending.callID, tab: publicTab(released, pending.sessionID), status: "completed" })
                : Effect.fail(new BridgeError({ message: "Chrome tab was revoked" })),
            )
            current.pending = undefined
            return
          }
          const tab = current.tabs.get(message.tabID)
          if (!tab && !(pending?.kind === "open" && message.type === "error")) return
          if (message.type === "error" && pending?.kind === "open" &&
              pending.callID === message.callID && pending.tabID === message.tabID &&
              message.generation === current.generation) {
            Deferred.doneUnsafe(pending.deferred, Effect.fail(new BridgeError({ message: "Chrome could not open a background tab" })))
            current.pending = undefined
            return
          }
          if (!tab) return
          if (message.type === "takeover") {
            tab.documentGeneration = message.documentGeneration
            tab.observationRevision = 0
            tab.elements.clear()
            tab.status = current.paused ? "paused" : "shared"
            if (current.paused) tab.pauseReason = "requested"
            else delete tab.pauseReason
            return
          }
          if (message.type === "updated") {
            const page = safePageMaybe(message.url)
            if (!page) return
            if (tab.mode === "owned" && !tab.allowedOrigins?.has(page.origin)) {
              current.tabs.delete(tab.id)
              current.transport.send({ type: "close", callID: "unapproved-origin", tabID: tab.id, generation: current.generation })
              return
            }
            tab.title = bounded(message.title, Browser.MAX_TITLE_LENGTH)
            tab.page = page
            tab.pageIdentity = Hash.sha256(message.url)
            tab.documentGeneration = message.documentGeneration
            tab.observationRevision = 0
            tab.elements.clear()
            return
          }
          if (!pending || pending.callID !== message.callID || pending.tabID !== message.tabID) return
          if (message.generation !== current.generation) return
          if (message.type === "error") {
            if (pending.mutation && message.dispatched) {
              tab.status = "paused"
              tab.pauseReason = "uncertain"
              tab.uncertainCallID = pending.callID
              const uncertain: ActionResult = {
                callID: pending.callID,
                tab: publicTab(tab, pending.sessionID),
                status: "uncertain",
                message: bounded(
                  `The extension could not prove whether the mutation completed: ${message.message}`,
                  1024,
                ),
              }
              remember(current, pending.fingerprint, uncertain, `${pending.sessionID}\0${pending.callID}`)
              Deferred.doneUnsafe(pending.deferred, Effect.succeed(uncertain))
              current.pending = undefined
              return
            }
            if (pending.kind === "action") {
              const rejected: ActionResult = {
                callID: pending.callID,
                tab: publicTab(tab, pending.sessionID),
                status: "rejected",
                message: bounded(`The extension rejected the action before dispatch: ${message.message}`, 1024),
              }
              remember(current, pending.fingerprint, rejected, `${pending.sessionID}\0${pending.callID}`)
              Deferred.doneUnsafe(pending.deferred, Effect.succeed(rejected))
              current.pending = undefined
              return
            }
            Deferred.doneUnsafe(pending.deferred, Effect.fail(new BridgeError({ message: message.message })))
            current.pending = undefined
            return
          }
          if (message.type === "closed" && pending.kind === "close") {
            const result: ActionResult = { callID: pending.callID, tab: publicTab(tab, pending.sessionID), status: "completed" }
            current.tabs.delete(tab.id)
            Deferred.doneUnsafe(pending.deferred, Effect.succeed(result))
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
            tab.pageIdentity = Hash.sha256(message.url)
            tab.documentGeneration = observation.documentGeneration
            tab.observationRevision = observation.revision
            tab.elements = new Map(observation.elements.map((element) => {
              const raw = message.elements.find((candidate) => candidate.ref === element.ref)
              return [element.ref, { ...element,
                identity: BrowserOperation.elementIdentity(raw?.frame ?? message.url, element, raw?.destination) }]
            }))
            tab.frameOrigins = new Set([...(tab.frameOrigins ?? []),
              ...(observation.frames ?? []).map((frame) => frame.page.origin),
              ...observation.elements.flatMap((element) => element.frame ? [element.frame.origin] : [])])
            Deferred.doneUnsafe(pending.deferred, Effect.succeed(observation))
            current.pending = undefined
            return
          }
          if (message.type !== "result" || pending.kind !== "action") return
          if (message.data !== undefined && Buffer.byteLength(message.data, "utf8") > Browser.MAX_EXPORT_BYTES) {
            Deferred.doneUnsafe(
              pending.deferred,
              Effect.fail(new BridgeError({ message: "Extension returned an export larger than the 8 MiB limit" })),
            )
            current.pending = undefined
            return
          }
          if (message.data !== undefined) pending.exportData = message.data
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
          tab.pageIdentity = Hash.sha256(message.url)
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
            tab: publicTab(tab, pending.sessionID),
            status: message.status,
            message: message.message,
            capture: message.capture,
            groupID: message.groupID,
            text: message.text === undefined ? undefined : boundedUtf8Text(message.text, Browser.MAX_CLIPBOARD_BYTES),
            download: sanitizeDownload(message.download),
            logs: sanitizeLogs(message.logs),
            webmcpTools: sanitizeWebMcpTools(message.webmcpTools),
          }
          if (pending.actionType !== "export") remember(current, pending.fingerprint, result, `${pending.sessionID}\0${pending.callID}`)
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

      const executionEnds = [SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted]
      const executionEndTypes: ReadonlyArray<string> = executionEnds.map((definition) => definition.type)
      yield* events
        .subscribe([SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived, ...executionEnds])
        .pipe(
          Stream.runForEach((event) =>
            (executionEndTypes.includes(event.type) ? Effect.void : releaseSession(event.data.sessionID)).pipe(
              Effect.andThen(Effect.forkScoped(relinquishSession(event.data.sessionID))),
            ),
          ),
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
        extensionID: string,
        secret: string,
      ) {
        const expected = pairing
        const supplied = createHash("sha256").update(secret).digest()
        const valid =
          expected !== undefined &&
          expected.expiresAt > Date.now() &&
          expected.attempts < MAX_PAIRING_ATTEMPTS &&
          expected.digest.byteLength === supplied.byteLength &&
          timingSafeEqual(expected.digest, supplied)
        if (!valid) {
          if (expected) expected.attempts++
          return yield* new AuthenticationError({ message: "Invalid or expired Chrome pairing" })
        }
        yield* assertSession(expected.sessionID)
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
              serverID: expected.serverID,
              sessionID: expected.sessionID,
            },
          },
        })
        return { sessionID: expected.sessionID, serverID: expected.serverID, secret: credential }
      })

      const authenticateTrust = Effect.fn("Browser.authenticateTrust")(function* (
        extensionID: string,
        handshake: Extract<BrowserProtocol.Handshake, { readonly type: "authenticate" }>,
      ) {
        const trust = yield* loadTrust()
        const supplied = createHash("sha256").update(handshake.credential).digest()
        const valid =
          trust?.extensionID === extensionID &&
          trust.serverID === handshake.serverID &&
          trust.digest.byteLength === supplied.byteLength &&
          timingSafeEqual(trust.digest, supplied)
        if (!valid) return yield* new AuthenticationError({ message: "Unknown or revoked Chrome pairing" })
        return { sessionID: trust.sessionID, serverID: trust.serverID, secret: undefined }
      })

      return Service.of({ status, list, start, open, close, release, observe, clickDestination, elementFrame, actionIdentity, action, history, control, stop, forget, attach })
    }),
  )

class CoordinatorService extends Context.Service<CoordinatorService, Interface>()("@ycoding/BrowserCoordinator") {}

const coordinatorLayer = Layer.effect(
  CoordinatorService,
  Effect.map(Service, (browser) => CoordinatorService.of(browser)),
).pipe(
  Layer.provide(
    layer().pipe(
      Layer.provide(
        Layer.effect(
          BrowserAdmission.Service,
          Effect.map(BrowserAdmission.CoordinatorService, (admission) => BrowserAdmission.Service.of(admission)),
        ),
      ),
    ),
  ),
)

const coordinatorNode = makeGlobalNode({
  service: CoordinatorService,
  layer: coordinatorLayer,
  deps: [BrowserAdmission.coordinatorNode, Credential.node, EventRuntime.node, SessionStore.node],
})

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.map(CoordinatorService, (browser) => Service.of(browser)),
  ),
  deps: [coordinatorNode],
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
  return JSON.stringify([...fence, input.action])
}

const utf8Encoder = new TextEncoder()

function boundedUtf8Text(input: string, bytes: number) {
  if (utf8Encoder.encode(input).byteLength <= bytes) return input
  let used = 0
  let output = ""
  for (const char of input) {
    const size = utf8Encoder.encode(char).byteLength
    if (used + size > bytes) break
    used += size
    output += char
  }
  return output
}

function sanitizeDownload(
  download: Extract<BrowserProtocol.ClientMessage, { readonly type: "result" }>["download"],
): Browser.DownloadInfo | undefined {
  if (!download) return undefined
  const count = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  return {
    filename: bounded(download.filename, 1024),
    state: bounded(download.state, 32),
    bytesReceived: count(download.bytesReceived),
    totalBytes: count(download.totalBytes),
    mime: download.mime ? bounded(download.mime, 128) : undefined,
  }
}

function sanitizeLogs(logs: Extract<BrowserProtocol.ClientMessage, { readonly type: "result" }>["logs"]) {
  if (!logs) return undefined
  return logs.slice(0, Browser.MAX_LOG_ENTRIES).map((entry) => ({
    level: bounded(entry.level, 16),
    text: bounded(entry.text, Browser.MAX_NAME_LENGTH),
    frame: entry.frame ? safePageMaybe(entry.frame) : undefined,
  }))
}

function sanitizeWebMcpTools(tools: Extract<BrowserProtocol.ClientMessage, { readonly type: "result" }>["webmcpTools"]) {
  if (!tools) return undefined
  return tools.slice(0, Browser.MAX_LOG_ENTRIES).map((tool) => ({
    name: bounded(tool.name, 128),
    description: tool.description ? bounded(tool.description, Browser.MAX_NAME_LENGTH) : undefined,
  }))
}

function sanitizeHistory(
  message: Extract<BrowserProtocol.ClientMessage, { readonly type: "history_result" }>,
): HistoryResult {
  const entries: Browser.HistoryEntry[] = []
  for (const entry of message.entries) {
    try {
      const url = new URL(entry.url)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue
      entries.push({
        url: boundedUtf8Text(url.toString(), 2048),
        title: bounded(entry.title, Browser.MAX_TITLE_LENGTH),
        lastVisitTime: Number.isFinite(entry.lastVisitTime) && entry.lastVisitTime >= 0 ? Math.floor(entry.lastVisitTime) : 0,
        visitCount:
          entry.visitCount !== undefined && Number.isFinite(entry.visitCount) && entry.visitCount >= 0
            ? Math.floor(entry.visitCount)
            : undefined,
      })
    } catch {}
    if (entries.length >= Browser.MAX_HISTORY_RESULTS) break
  }
  return { entries }
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
    frame: element.frame ? safePageMaybe(element.frame) : undefined,
  }))
  const texts = (message.texts ?? []).slice(0, Browser.MAX_OBSERVATION_TEXTS).map((text) => ({
    role: bounded(text.role, 64),
    name: bounded(text.name, Browser.MAX_NAME_LENGTH),
    frame: text.frame ? safePageMaybe(text.frame) : undefined,
  }))
  const frames = (message.frames ?? [])
    .slice(0, Browser.MAX_OBSERVATION_FRAMES)
    .flatMap((frame) => {
      const framePage = safePageMaybe(frame.url)
      return framePage ? [{ page: framePage, observed: frame.observed }] : []
    })
  return {
    tabID: message.tabID,
    generation: message.generation,
    documentGeneration: message.documentGeneration,
    revision: message.revision,
    title: bounded(message.title, Browser.MAX_TITLE_LENGTH),
    page,
    elements,
    ...(texts.length ? { texts } : {}),
    ...(frames.length ? { frames } : {}),
    truncated:
      message.truncated ||
      message.elements.length > Browser.MAX_OBSERVATION_ELEMENTS ||
      (message.texts?.length ?? 0) > Browser.MAX_OBSERVATION_TEXTS ||
      (message.frames?.length ?? 0) > Browser.MAX_OBSERVATION_FRAMES,
  }
}
