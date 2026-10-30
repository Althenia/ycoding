import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { executorScopeFor, type NativeDots } from "@ycoding-ai/core/dots/native"
import type { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { runCcaChannelRpc } from "./cca-channel-rpc"
import { createCcaRpcAdapter } from "./cca-executor-adapter"
import { createCcaSessionRegistry, type CcaSessionRegistry, type CcaSessionResources } from "./cca-executor-rpc"
import {
  ccaExecutorCapabilityRoots,
  loadCcaExperimentState,
  renameCcaExecutor,
  reregisterCcaExecutor,
  runCcaRegistration,
  sameCcaCapabilityRoots,
  type CcaCredential,
  type CcaExperimentState,
} from "./cca-executor-registration"
import {
  ccaCompatibleExecServerVersion,
  ccaExecServerPrependPathDir,
  ccaExecServerProviderId,
  CcaRegistryHttpError,
  defaultWsMaxPayload,
  registerExecutorEnvironmentWithRetry,
  startCcaExecutorTransport,
  type CcaChannel,
  type CcaCredentialRefresh,
  type CcaExecutorCredential,
  type CcaNoiseTransport,
  type CcaRegistrationResult,
} from "./cca-executor-transport"
import { acceptCcaNoiseHandshake, createCcaNoiseIdentity, type AcceptCcaNoiseHandshakeInput, type CcaNoiseIdentity } from "./cca-noise"
import { awaitWebSocketOpen, waitForAbort, type CcaWebSocketConnector } from "./cca-proof-common"
import type { CcaProofJournalRecordInput } from "./cca-proof-journal"
import { answerCcaTaskWorkspace, type CcaTaskWorkspaceHost } from "./cca-task-workspace"
import { defaultDotsLabel } from "./label"
import { accountHash } from "./state"
import { ensureYcodingOperatorSkill } from "./ycoding-operator-skill"

export const ccaExecutorHostDiagnostics = [
  "credential-unavailable",
  "enrollment-failed",
  "enrollment-rejected",
  "enrollment-uncertain",
  "enrollment-unreadable",
  "enrollment-account-mismatch",
  "registration-rejected",
  "connected",
  "connection-failed",
  "connection-dropped",
  "scope-unavailable",
  "channel-opened",
  "channel-failed",
  "channel-summary",
  "registration-executor-changed",
  "registration-rename-executor-changed",
  "registration-rename-unconfirmed",
  "registration-update-failed",
  "cleanup-failed",
] as const

const maxChannelSummaryEntries = 64

function channelSummaryEntry(record: CcaProofJournalRecordInput): string | undefined {
  if (record.method === undefined) return undefined
  if (record.phase === "rpc-received") return `>${record.method}${record.resumeRequested ? "(resume)" : ""}`
  if (record.phase === "rpc-response") return `<${record.method}=${record.outcome ?? "other_error"}`
  if (record.phase === "rpc-notification")
    return record.outcome === "notification" ? `~${record.method}` : `~${record.method}=${record.outcome ?? "other_error"}`
  return undefined
}

export type CcaExecutorHostDiagnostic = (typeof ccaExecutorHostDiagnostics)[number]

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
type EnabledConfiguration = Extract<NativeDots.Configuration, { readonly enabled: true }>
type Attempt = { readonly retry: false } | { readonly retry: true; readonly connectedMs: number }

export interface CcaExecutorHostDeps {
  readonly native: Pick<NativeDots.Host, "configuration" | "credential" | "subscribeConfiguration" | "name" | "threadScope" | "unattributedScope"> &
    CcaTaskWorkspaceHost
  readonly statePath: string
  readonly installationID: () => Promise<string>
  readonly homeDirectory?: string
  readonly dataDirectory?: string
  readonly hostname?: () => string
  readonly fetch?: FetchFn
  readonly registryBaseURL?: string
  readonly connectWebSocket?: CcaWebSocketConnector
  readonly acceptHandshake?: (
    input: AcceptCcaNoiseHandshakeInput,
  ) => Promise<{ readonly response: Uint8Array; readonly transport: CcaNoiseTransport }>
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
  readonly random?: () => number
  readonly onDiagnostic?: (message: string) => void
  readonly detachedSessionTtlMs?: number
}

export const ccaReconnectInitialMs = 1_000
export const ccaReconnectMaxMs = 30_000
export const ccaStableConnectionMs = 120_000
export const ccaRendezvousConnectTimeoutMs = 10_000
export function ccaReconnectDelay(backoffMs: number, random: () => number = Math.random) {
  const lower = Math.floor(backoffMs / 2)
  return lower + Math.floor(random() * (backoffMs - lower + 1))
}

type ServeRun = {
  identity: CcaNoiseIdentity | undefined
  registration: { readonly executorID: string; readonly result: CcaRegistrationResult } | undefined
  labelSynced: boolean
  readonly sessions: CcaSessionRegistry
}

class EnrollmentProblem extends Error {
  constructor(readonly category: CcaExecutorHostDiagnostic) {
    super(category)
  }
}

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function statusDetail(status: number) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `status=${status}` : undefined
}

function definitiveRejection(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal.addEventListener("abort", finish, { once: true })
  })
}

export function createCcaExecutorHost(deps: CcaExecutorHostDeps) {
  const home = deps.homeDirectory ?? os.homedir()
  const hostname = deps.hostname ?? os.hostname
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init))
  const connect: CcaWebSocketConnector =
    deps.connectWebSocket ?? ((url, headers) => new WebSocket(url, { headers, maxPayload: defaultWsMaxPayload }))
  const acceptHandshake = deps.acceptHandshake ?? acceptCcaNoiseHandshake
  const wait = deps.wait ?? delay
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const report = (category: CcaExecutorHostDiagnostic, detail?: string) =>
    deps.onDiagnostic?.(`CCA executor ${category}${detail === undefined ? "" : ` ${detail}`}`)

  let unsubscribe: (() => void) | undefined
  let selected: string | undefined
  let run: { readonly controller: AbortController; readonly done: Promise<void> } | undefined
  let work = Promise.resolve()

  async function readEnrollment(): Promise<CcaExperimentState | undefined> {
    try {
      return await loadCcaExperimentState(deps.statePath)
    } catch (error) {
      if (missing(error)) return undefined
      throw new EnrollmentProblem("enrollment-unreadable")
    }
  }

  function floraRefresher(configuration: EnabledConfiguration) {
    return async (rejected: CcaCredential) => {
      const refreshed = await deps.native.credential(configuration.profile, rejected.access)
      if (
        !refreshed ||
        refreshed.credentialID !== configuration.credentialID ||
        refreshed.accountID !== configuration.accountID ||
        refreshed.accountGeneration !== configuration.accountGeneration
      )
        return undefined
      return { access: refreshed.access, accountID: refreshed.accountID }
    }
  }

  async function enrolledExecutorID(
    credential: RemoteControlCredential.Resolved,
    configuration: EnabledConfiguration,
    signal: AbortSignal,
    run: ServeRun,
  ): Promise<{ readonly executorID: string; readonly state: CcaExperimentState; readonly configuredName: string | undefined }> {
    const roots = ccaExecutorCapabilityRoots(home, deps.dataDirectory)
    const refreshFloraCredential = floraRefresher(configuration)
    const configuredName = await deps.native.name()
    let state = await readEnrollment()
    if (state?.status === "failed") {
      await rm(deps.statePath, { force: true })
      state = undefined
    }
    if (state === undefined) {
      const installationID = await deps.installationID()
      state = await runCcaRegistration({
        credential: { access: credential.access, accountID: credential.accountID },
        installationID,
        displayName: configuredName ?? defaultDotsLabel(hostname(), installationID),
        statePath: deps.statePath,
        roots,
        fetch: fetchFn,
        refreshCredential: refreshFloraCredential,
      }).then(
        (result) => result.state,
        async (error: unknown) => {
          const recorded = await readEnrollment()
          if (recorded === undefined) throw error
          return recorded
        },
      )
    }
    if (state.status === "failed") throw new EnrollmentProblem("enrollment-rejected")
    if (state.status === "pending" || state.status === "uncertain") throw new EnrollmentProblem("enrollment-uncertain")
    if (state.status !== "completed") throw new EnrollmentProblem("enrollment-unreadable")
    if (state.accountHash !== accountHash(credential.accountID)) throw new EnrollmentProblem("enrollment-account-mismatch")
    if (typeof state.executorID !== "string" || !state.executorID.trim()) throw new EnrollmentProblem("enrollment-unreadable")
    const registered = state.displayName ?? hostname()
    const label = configuredName ?? registered
    const rootsChanged = !sameCcaCapabilityRoots(state.selectedCapabilityRoots, roots)
    if (rootsChanged) {
      run.labelSynced = true
      try {
        const updated = await reregisterCcaExecutor({
          credential: { access: credential.access, accountID: credential.accountID },
          state,
          displayName: label,
          statePath: deps.statePath,
          roots,
          fetch: fetchFn,
          refreshCredential: refreshFloraCredential,
          wait: (ms) => wait(ms, signal),
          signal,
        })
        if (updated.executorChanged) report("registration-executor-changed")
        state = updated.state
      } catch {
        report("registration-update-failed")
      }
    }
    const executorID = typeof state.executorID === "string" ? state.executorID.trim() : ""
    if (!executorID) throw new EnrollmentProblem("enrollment-unreadable")
    return { executorID, state, configuredName }
  }

  async function syncLabel(
    credential: RemoteControlCredential.Resolved,
    configuration: EnabledConfiguration,
    enrolled: { readonly state: CcaExperimentState; readonly configuredName: string | undefined },
    signal: AbortSignal,
    run: ServeRun,
  ) {
    const label = enrolled.configuredName?.trim().slice(0, 100)
    if (!label || run.labelSynced) return
    run.labelSynced = true
    const current = (enrolled.state.customDisplayName ?? enrolled.state.displayName ?? hostname()).trim().slice(0, 100)
    if (label === current || enrolled.state.renameDeclined?.label === label) return
    try {
      const result = await renameCcaExecutor({
        credential: { access: credential.access, accountID: credential.accountID },
        state: enrolled.state,
        label,
        statePath: deps.statePath,
        fetch: fetchFn,
        signal,
      })
      if (signal.aborted) return
      if (result.outcome === "unrecorded" || !result.persisted) report("registration-update-failed")
      if (result.outcome === "executor-changed") report("registration-rename-executor-changed")
      if (result.outcome === "unconfirmed" || result.outcome === "uncertain") report("registration-rename-unconfirmed")
    } catch {
      return
    }
  }

  function openSession(environmentID: string) {
    const scopeFor = executorScopeFor(deps.native, environmentID)
    return async (): Promise<CcaSessionResources> => {
      const adapter = createCcaRpcAdapter({
        scopeFor: (attribution, context) =>
          scopeFor(attribution, context).catch((error: unknown) => {
            report("scope-unavailable")
            throw error
          }),
        answerProcess: (params, context) =>
          answerCcaTaskWorkspace({
            argv: params.argv,
            environmentID,
            ...(context.attribution?.threadId ? { threadID: context.attribution.threadId } : {}),
            host: deps.native,
          }),
        environmentInfo: {
          userHomeDir: home,
          executorVersion: ccaCompatibleExecServerVersion,
          providerId: ccaExecServerProviderId,
          prependPathDirs: [ccaExecServerPrependPathDir],
        },
        networkProxyCaDirectory: path.join(path.dirname(deps.statePath), "cca-proxy"),
      })
      return {
        handler: adapter.handler,
        environmentInfo: adapter.environmentInfo,
        close: () => adapter.close().catch(() => report("cleanup-failed")),
      }
    }
  }

  async function serveChannel(
    channel: CcaChannel,
    attempt: {
      readonly signal: AbortSignal
      readonly sessions: CcaSessionRegistry
      readonly environmentID: string
    },
  ) {
    const connection = attempt.sessions.connect(openSession(attempt.environmentID))
    const entries: string[] = []
    let omitted = 0
    let end: "channel" | "connection" | "failed" = "channel"
    try {
      await runCcaChannelRpc({
        channel,
        environmentInfo: connection.environmentInfo,
        handler: connection.handler,
        signal: attempt.signal,
        onDiagnostic: (record) => {
          const entry = channelSummaryEntry(record)
          if (entry === undefined) return
          if (entries.length < maxChannelSummaryEntries) entries.push(entry)
          else omitted++
        },
      })
      if (attempt.signal.aborted) end = "connection"
    } catch {
      if (attempt.signal.aborted) end = "connection"
      else {
        end = "failed"
        report("channel-failed")
      }
    } finally {
      connection.detach()
      deps.onDiagnostic?.(
        `CCA executor channel-summary end=${end} rpc=${entries.length ? entries.join(",") : "-"}${omitted ? ` omitted=${omitted}` : ""}`,
      )
    }
  }

  function refreshCredential(configuration: EnabledConfiguration): CcaCredentialRefresh {
    return async (rejected) => {
      const next = await deps.native.credential(configuration.profile, rejected.accessToken).catch(() => undefined)
      if (
        next === undefined ||
        next.accountID !== configuration.accountID ||
        next.credentialID !== configuration.credentialID ||
        next.accountGeneration !== configuration.accountGeneration
      )
        return undefined
      return { accessToken: next.access, accountID: next.accountID }
    }
  }

  async function connectOnce(configuration: EnabledConfiguration, signal: AbortSignal, run: ServeRun): Promise<Attempt> {
    const stopped: Attempt = { retry: false }
    const rejected = (category: CcaExecutorHostDiagnostic, detail?: string): Attempt => {
      if (!signal.aborted) report(category, detail)
      return stopped
    }
    const retry = (category: CcaExecutorHostDiagnostic): Attempt => {
      if (signal.aborted) return stopped
      report(category)
      return { retry: true, connectedMs: 0 }
    }

    let credential: RemoteControlCredential.Resolved | undefined
    try {
      credential = await deps.native.credential(configuration.profile)
    } catch {
      return retry("credential-unavailable")
    }
    if (signal.aborted) return stopped
    if (
      credential === undefined ||
      credential.accountID !== configuration.accountID ||
      credential.credentialID !== configuration.credentialID ||
      credential.accountGeneration !== configuration.accountGeneration
    )
      return rejected("credential-unavailable")

    let enrolled: Awaited<ReturnType<typeof enrolledExecutorID>>
    try {
      enrolled = await enrolledExecutorID(credential, configuration, signal, run)
    } catch (error) {
      return error instanceof EnrollmentProblem ? rejected(error.category) : retry("enrollment-failed")
    }
    const executorID = enrolled.executorID
    if (signal.aborted) return stopped

    run.identity ??= await createCcaNoiseIdentity().catch(() => undefined)
    const identity = run.identity
    if (identity === undefined) return retry("connection-failed")

    const executorCredential: CcaExecutorCredential = { accessToken: credential.access, accountID: credential.accountID }
    const refresh = refreshCredential(configuration)
    const register = async (): Promise<Attempt | undefined> => {
      try {
        const result = await registerExecutorEnvironmentWithRetry({
          environmentID: executorID,
          credential: executorCredential,
          refreshCredential: refresh,
          identity,
          signal,
          fetch: fetchFn,
          wait: (ms) => wait(ms, signal),
          random,
          ...(deps.registryBaseURL === undefined ? {} : { registryBaseURL: deps.registryBaseURL }),
        })
        run.registration = { executorID, result }
        return undefined
      } catch (error) {
        if (signal.aborted) return stopped
        if (error instanceof CcaRegistryHttpError && definitiveRejection(error.status)) return rejected("registration-rejected", statusDetail(error.status))
        return retry("connection-failed")
      }
    }
    if (run.registration?.executorID !== executorID) {
      run.registration = undefined
      const failed = await register()
      if (failed !== undefined) return failed
    }
    const registration = run.registration!.result
    await syncLabel(credential, configuration, enrolled, signal, run)
    if (signal.aborted) return stopped

    const ended = new AbortController()
    const end = () => ended.abort()
    signal.addEventListener("abort", end, { once: true })
    let dialStatus: number | undefined
    let connectedAt = now()
    const bridges = new Set<Promise<void>>()
    try {
      let transport: { close(): Promise<void> }
      try {
        transport = await startCcaExecutorTransport({
          environmentID: executorID,
          credential: executorCredential,
          refreshCredential: refresh,
          identity,
          registration,
          signal: ended.signal,
          ...(deps.registryBaseURL === undefined ? {} : { registryBaseURL: deps.registryBaseURL }),
          fetch: fetchFn,
          connectWebSocket: async (url, headers) => {
            const dial = (dialURL: string, dialHeaders: Record<string, string>) => {
              const pending = connect(dialURL, dialHeaders)
              return Promise.resolve(pending).then((socket) => {
                const listen = socket.on ?? socket.addEventListener
                listen?.call(socket, "unexpected-response", (_request: unknown, response: { readonly statusCode?: number }) => {
                  dialStatus = response?.statusCode
                  const terminate = (socket as typeof socket & { readonly terminate?: () => void }).terminate
                  if (terminate) terminate.call(socket)
                  else socket.close()
                })
                return socket
              })
            }
            const socket = await awaitWebSocketOpen(dial, url, headers, { signal: ended.signal, timeoutMs: ccaRendezvousConnectTimeoutMs })
            connectedAt = now()
            report("connected")
            const listen = socket.on ?? socket.addEventListener
            listen?.call(socket, "close", end)
            return socket
          },
          acceptHandshake: (input) => acceptHandshake({ ...input, identity }),
          onChannel: (channel) => {
            if (ended.signal.aborted) return undefined
            report("channel-opened")
            const bridge = serveChannel(channel, { signal: ended.signal, sessions: run.sessions, environmentID: executorID })
            bridges.add(bridge)
            void bridge.finally(() => bridges.delete(bridge))
            return bridge
          },
        })
      } catch {
        if (signal.aborted) return stopped
        if (dialStatus !== undefined && dialStatus >= 400 && dialStatus < 500) {
          run.registration = undefined
          const failed = await register()
          if (failed !== undefined) return failed
        }
        return retry("connection-failed")
      }
      await waitForAbort(ended.signal)
      const connectedMs = now() - connectedAt
      const closed = await transport.close().then(() => true, () => false)
      await Promise.allSettled([...bridges])
      if (!closed) report("cleanup-failed")
      if (signal.aborted) return stopped
      report("connection-dropped")
      return { retry: true, connectedMs }
    } finally {
      signal.removeEventListener("abort", end)
    }
  }

  async function serve(configuration: EnabledConfiguration, signal: AbortSignal) {
    const run: ServeRun = {
      identity: undefined,
      registration: undefined,
      labelSynced: false,
      sessions: createCcaSessionRegistry(deps.detachedSessionTtlMs === undefined ? {} : { ttlMs: deps.detachedSessionTtlMs }),
    }
    let backoff = ccaReconnectInitialMs
    try {
      while (!signal.aborted) {
        const attempt = await connectOnce(configuration, signal, run)
        if (!attempt.retry || signal.aborted) return
        if (attempt.connectedMs >= ccaStableConnectionMs) backoff = ccaReconnectInitialMs
        const pause = ccaReconnectDelay(backoff, random)
        backoff = Math.min(backoff * 2, ccaReconnectMaxMs)
        await wait(pause, signal)
      }
    } finally {
      await run.sessions.shutdown()
    }
  }

  async function halt() {
    const current = run
    run = undefined
    if (current === undefined) return
    current.controller.abort()
    await current.done
  }

  function reconcile() {
    work = work.then(async () => {
      if (!unsubscribe) return
      const configuration = await deps.native.configuration().catch(() => undefined)
      if (!unsubscribe) return
      const key = configuration?.enabled ? JSON.stringify(configuration) : undefined
      if (key === selected) return
      selected = key
      await halt()
      if (!configuration?.enabled) return
      const controller = new AbortController()
      run = { controller, done: serve(configuration, controller.signal) }
    })
    return work
  }

  return {
    start: async () => {
      await ensureYcodingOperatorSkill(deps.dataDirectory)
      unsubscribe ??= deps.native.subscribeConfiguration(() => void reconcile())
      await reconcile()
    },
    stop: async () => {
      unsubscribe?.()
      unsubscribe = undefined
      selected = undefined
      work = work.then(halt)
      await work
    },
  }
}
