export * as CcaExecutor from "./executor"

export type { CcaAttribution, CcaAuthorizationGrant, CcaAuthorizationInput, CcaDecisionTrace, CcaPendingDecision, CcaRpcHandlerContext } from "./errors"
export { CCA_BUSY_TEXT, CcaRefusalError, ccaRefusalText } from "./errors"

import { AsyncLocalStorage } from "node:async_hooks"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID, createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exec } from "node:child_process"
import { Effect } from "effect"
import { CcaAuthorizationDeniedError } from "./authorization"
import {
  CcaExecutorError,
  CcaRefusalError,
  ccaRefusalText,
  type CcaAttribution,
  type CcaAuthorizationGrant,
  type CcaAuthorizationInput,
  type CcaDecisionTrace,
  type CcaRpcHandlerContext,
} from "./errors"
import { create as createCcaFsExtended, type Handlers as CcaFsExtendedHandlers, type OpenMode } from "./fs-extended"
import { CCA_HTTP_NETWORK_ACTION, createCcaHttpHandler, type CcaHttpHandler, type CcaHttpRequestContext } from "./http"
import { createCcaCredentialBrokerCache } from "./credential-broker"
import {
  CcaNetworkProxyError,
  startCcaNetworkProxy,
  type CcaNetworkPolicyAuditEvent,
  type CcaNetworkPolicyDecider,
  type CcaNetworkProxyHandle,
  type CcaRemoteNetworkProxyLaunchConfig,
} from "./network-proxy"
import { CcaPolicy } from "./policy"
import {
  CcaShellSnapshotError,
  ccaShellSnapshotStdio,
  createCcaShellSnapshotCache,
  type CcaShellSnapshotLaunch,
  type CcaShellSnapshotRequest,
} from "./shell-snapshot"
import type { CcaTranscript } from "./transcript"
import { Platform } from "../util/platform"


export interface CcaShellInfo {
  readonly name: string
  readonly path: string
}

export interface CcaEnvironmentCapabilities {
  readonly networkProxyLaunch?: boolean
  readonly networkProxyReviewDomains?: boolean
  readonly credentialMasking?: boolean
  readonly credentialMaskingCustomProviders?: boolean
  readonly capabilityDiscoverySandbox?: boolean
  readonly fsWatchMissing?: boolean
  readonly capabilityDiscoveryV2?: boolean
  readonly environmentConfigRead?: boolean
  readonly httpHeaderEnvVars?: boolean
  readonly sandboxedFileStreaming?: boolean
  readonly fileWriteStreaming?: boolean
  readonly shellSnapshotV2?: boolean
  readonly windowsMxc?: boolean
  readonly linuxRootWritePreservesDevices?: boolean
  readonly linuxApprovedRootWritePreservesRestrictions?: boolean
  readonly [key: string]: unknown
}

export interface CcaEnvironmentInfo {
  readonly shell: CcaShellInfo
  readonly executorVersion?: string
  readonly providerId?: string
  readonly cwd?: string | null
  readonly userHomeDir?: string | null
  readonly platformOs?: string | null
  readonly prependPathDirs?: readonly string[]
  readonly temporaryDirectories?: readonly string[]
  readonly tempDir?: string | null
  readonly capabilities: CcaEnvironmentCapabilities
}

export interface CcaEnvironmentInfoInput {
  readonly cwd: string
  readonly shell?: { readonly name: string; readonly path: string }
  readonly executorVersion?: string
  readonly userHomeDir?: string
  readonly tempDir?: string
  readonly temporaryDirectories?: readonly string[]
}

function defaultTemporaryDirectories(): string[] {
  const names = process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"]
  const directories: string[] = []
  for (const name of names) {
    const value = process.env[name]
    if (!value || (process.platform === "win32" && !path.isAbsolute(value))) continue
    const resolved = path.resolve(value)
    if (!directories.includes(resolved)) directories.push(resolved)
  }
  return directories
}

function pathUris(paths: readonly string[]): string[] {
  const uris: string[] = []
  for (const entry of paths) {
    try {
      const uri = CcaPolicy.toPathUri(entry)
      if (!uris.includes(uri)) uris.push(uri)
    } catch {}
  }
  return uris
}

export function ccaEnvironmentInfo(input: CcaEnvironmentInfoInput): CcaEnvironmentInfo {
  const shellPath =
    input.shell?.path ??
    process.env.SHELL ??
    (process.platform === "win32" ? "powershell.exe" : "/bin/sh")
  const defaultName = path.basename(shellPath).replace(/\.exe$/i, "")
  const shellName =
    input.shell?.name ?? (defaultName || (process.platform === "win32" ? "powershell" : "sh"))

  const capabilities: CcaEnvironmentCapabilities = {
    networkProxyLaunch: false,
    capabilityDiscoverySandbox: false,
    capabilityDiscoveryV2: false,
    environmentConfigRead: false,
    httpHeaderEnvVars: false,
    sandboxedFileStreaming: false,
    fileWriteStreaming: false,
    shellSnapshotV2: false,
    windowsMxc: false,
  }

  const result: {
    shell: CcaShellInfo
    executorVersion: string
    platformOs: string
    cwd: string
    capabilities: CcaEnvironmentCapabilities
    userHomeDir?: string
    tempDir?: string
    temporaryDirectories: string[]
  } = {
    shell: {
      name: shellName,
      path: shellPath,
    },
    executorVersion: input.executorVersion ?? "0.0.0",
    platformOs: Platform.upstreamOs(),
    cwd: CcaPolicy.toPathUri(input.cwd),
    capabilities,
    temporaryDirectories: pathUris(input.temporaryDirectories ?? defaultTemporaryDirectories()),
  }

  if (input.userHomeDir !== undefined) {
    result.userHomeDir = CcaPolicy.toPathUri(input.userHomeDir)
  }
  if (input.tempDir !== undefined) {
    result.tempDir = CcaPolicy.toPathUri(input.tempDir)
  }

  return result
}

export interface CcaInitializeParams {
  readonly clientName: string
  readonly resumeSessionId?: string
}

export interface CcaInitializeResult {
  readonly sessionId: string
}

export interface CcaSessionCallOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type CcaSessionCall = (method: string, params: unknown, options?: CcaSessionCallOptions) => Promise<unknown>

export interface CcaInitializeContext {
  readonly signal: AbortSignal
  readonly notify?: (method: string, params: unknown) => Promise<void> | void
  readonly call?: CcaSessionCall
}


export interface CcaExecParams {
  readonly processId: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly tty?: boolean
  readonly pipeStdin?: boolean
  readonly arg0?: string
  readonly metadata?: unknown
  readonly envPolicy?: unknown
  readonly shellSnapshot?: CcaShellSnapshotRequest
  readonly sandbox?: unknown
  readonly enforceManagedNetwork?: boolean
  readonly managedNetwork?: unknown
  readonly networkProxy?: CcaRemoteNetworkProxyLaunchConfig
}

export interface CcaExecResult {
  readonly processId: string
  readonly sandboxType?:
    | "none"
    | "macosSeatbelt"
    | "linuxSeccomp"
    | "windowsRestrictedToken"
    | "windowsMxc"
    | null
}

export interface CcaReadParams {
  readonly processId: string
  readonly afterSeq?: number
  readonly maxBytes?: number
  readonly waitMs?: number
}

export interface CcaProcessOutputChunk {
  readonly seq: number
  readonly stream: "stdout" | "stderr" | "pty"
  readonly chunk: string
}

export interface CcaReadResult {
  readonly chunks: readonly CcaProcessOutputChunk[]
  readonly nextSeq: number
  readonly exited: boolean
  readonly exitCode?: number | null
  readonly closed: boolean
  readonly failure?: string | null
  readonly sandboxDenied?: boolean
}

export interface CcaWriteParams {
  readonly processId: string
  readonly chunk: string
  readonly writeId: string
}

export interface CcaWriteResult {
  readonly status: "accepted" | "unknownProcess" | "stdinClosed" | "starting"
}

export interface CcaSignalParams {
  readonly processId: string
  readonly signal: "interrupt"
}

export type CcaSignalResult = Record<string, never>

export interface CcaTerminateParams {
  readonly processId: string
}

export interface CcaTerminateResult {
  readonly running: boolean
}

export interface CcaFsReadFileParams {
  readonly path: string
  readonly followSymlinks?: boolean
  readonly sandbox?: unknown
}

export interface CcaFsReadFileResult {
  readonly dataBase64: string
}

export interface CcaFsWriteFileParams {
  readonly path: string
  readonly dataBase64: string
  readonly followSymlinks?: boolean
  readonly sandbox?: unknown
}

export type CcaFsWriteFileResult = Record<string, never>

export interface CcaFsGetMetadataParams {
  readonly path: string
  readonly followSymlinks?: boolean
  readonly sandbox?: unknown
}

export interface CcaFsGetMetadataResult {
  readonly isDirectory: boolean
  readonly isFile: boolean
  readonly isSymlink: boolean
  readonly size: number
  readonly createdAtMs: number
  readonly modifiedAtMs: number
}

export interface CcaFsReadDirectoryParams {
  readonly path: string
  readonly sandbox?: unknown
}

export interface CcaFsReadDirectoryEntry {
  readonly fileName: string
  readonly isDirectory: boolean
  readonly isFile: boolean
}

export interface CcaFsReadDirectoryResult {
  readonly entries: readonly CcaFsReadDirectoryEntry[]
}

export interface CcaFsCanonicalizeParams {
  readonly path: string
  readonly sandbox?: unknown
}

export interface CcaFsCanonicalizeResult {
  readonly path: string
}

export interface CcaFsCreateDirectoryParams {
  readonly path: string
}

export type CcaFsCreateDirectoryResult = { readonly created: true; readonly path: string } | { readonly created: false }

export interface CcaExecutorHandler {
  readonly initialize: (
    params: CcaInitializeParams,
    ctx: CcaInitializeContext,
  ) => Promise<CcaInitializeResult>
  readonly startProcess: (
    params: CcaExecParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaExecResult>
  readonly readProcess: (
    params: CcaReadParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaReadResult>
  readonly writeProcess: (
    params: CcaWriteParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaWriteResult>
  readonly signalProcess: (
    params: CcaSignalParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaSignalResult>
  readonly terminateProcess: (
    params: CcaTerminateParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaTerminateResult>
  readonly readFile: (
    params: CcaFsReadFileParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaFsReadFileResult>
  readonly writeFile: (
    params: CcaFsWriteFileParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaFsWriteFileResult>
  readonly getMetadata: (
    params: CcaFsGetMetadataParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaFsGetMetadataResult>
  readonly readDirectory: (
    params: CcaFsReadDirectoryParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaFsReadDirectoryResult>
  readonly canonicalize: (
    params: CcaFsCanonicalizeParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaFsCanonicalizeResult>
  readonly createDirectory: (
    params: CcaFsCreateDirectoryParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaFsCreateDirectoryResult>
  readonly openReadTree: (
    params: CcaReadTreeParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaReadTree>
  readonly openConnection: () => CcaExecutorConnection
}

export interface CcaExecutorConnection {
  readonly fs: Omit<CcaFsExtendedHandlers, "shutdown">
  readonly http: {
    readonly request: (
      params: Parameters<CcaHttpHandler["request"]>[0],
      ctx: CcaHttpRequestContext & { readonly sessionId: string },
    ) => ReturnType<CcaHttpHandler["request"]>
  }
  readonly close: () => Promise<void>
}

export interface CcaReadTreeParams {
  readonly path: string
  readonly sandbox?: unknown
}

export interface CcaReadTree {
  readonly getMetadata: (params: { readonly path: string }) => Promise<CcaFsGetMetadataResult>
  readonly readDirectory: (params: { readonly path: string }) => Promise<CcaFsReadDirectoryResult>
  readonly readFile: (params: { readonly path: string }) => Promise<CcaFsReadFileResult>
  readonly release: () => Promise<void>
}


export interface CcaExecutorScope {
  readonly sessionID: string
  readonly roots: readonly string[]
  readonly authorization: {
    readonly authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>
    readonly defers?: boolean
  }
  readonly transcript?: CcaTranscript.Recorder
  readonly close: () => Promise<void>
}

export interface CcaScopeContext {
  readonly sessionId: string
  readonly cwd?: string
}

export type CcaScopeFor = (attribution: CcaAttribution | undefined, context: CcaScopeContext) => Promise<CcaExecutorScope>

export interface CcaProcessAnswer {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type CcaAnswerProcess = (
  params: CcaExecParams,
  context: { readonly attribution: CcaAttribution | undefined; readonly sessionId: string },
) => Promise<CcaProcessAnswer | undefined>

export interface CcaExecutorOptions {
  readonly scopeFor: CcaScopeFor
  readonly answerProcess?: CcaAnswerProcess
  readonly baseEnv?: Readonly<Record<string, string>>
  readonly sessionId?: () => string
  readonly processTimeoutMs?: number
  readonly maxBufferedBytesPerProcess?: number
  readonly maxLiveProcesses?: number
  readonly spawnImpl?: typeof spawn
  readonly networkProxyCaDirectory?: string
  readonly networkPolicy?: (input: CcaNetworkPolicyInput) => CcaNetworkPolicyHooks
}

export interface CcaNetworkPolicyInput {
  readonly processId: string
  readonly launch: CcaRemoteNetworkProxyLaunchConfig
  readonly call: CcaSessionCall
  readonly notify: (method: string, params: unknown) => void
  readonly signal: AbortSignal
}

export interface CcaNetworkPolicyHooks {
  readonly decider?: CcaNetworkPolicyDecider
  readonly onPolicyDecision?: (event: CcaNetworkPolicyAuditEvent) => void
}

interface StdioChunk {
  readonly seq: number
  readonly stream: "stdout" | "stderr"
  readonly chunkBuffer: Buffer
}

interface ActiveScope {
  readonly id: number
  readonly sessionID: string
  readonly outside: readonly string[]
  readonly roots: readonly string[]
  readonly authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>
  readonly record: (write: (transcript: CcaTranscript.Recorder) => void) => void
}

interface RunningProcessEntry {
  readonly processId: string
  readonly sessionId: string
  active?: ActiveScope
  recording?: CcaTranscript.ProcessRecording
  child?: ChildProcess
  spawned: boolean
  readonly acceptedWriteIds: Map<string, string>
  readonly chunks: StdioChunk[]
  retainedBytes: number
  nextSeq: number
  exited: boolean
  exitCode: number | null
  closed: boolean
  terminationRequested: boolean
  pendingInterrupt: boolean
  stdoutEnded: boolean
  stderrEnded: boolean
  sandboxDenied: boolean
  exitedNotified: boolean
  closedNotified: boolean
  readonly waiters: Set<() => void>
  timeoutTimer?: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
  grant?: CcaAuthorizationGrant
  grantSettled?: Promise<void>
  networkProxy?: CcaNetworkProxyHandle
  networkShutdown?: AbortController
  releaseSnapshot?: () => void
  releaseFailed: boolean
  readonly done: Promise<void>
  readonly resolveDone: () => void
  doneResolved: boolean
}

const CHUNK_SPLIT_SIZE = 64 * 1024
const MAX_FS_READ_BYTES = 16 * 1024 * 1024
const MAX_FS_DIR_ENTRIES = 50_000
const MAX_RETAINED_EXITED_PROCESSES = 25
const MAX_ACCEPTED_WRITE_IDS = 4096
const DEFAULT_MAX_LIVE_PROCESSES = 64

const SANDBOX_DENIAL_OUTPUT = "sandbox denied: Permission denied by YCoding policy\n"

function sandboxPermissionDenied(): CcaExecutorError {
  return new CcaExecutorError(-32600, "Permission denied")
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (Reflect.get(value, key) as unknown) : undefined
}

function sandboxOperationRoots(sandbox: unknown): string[] {
  if (sandbox == null) return []
  const context = field(sandbox, "policyContext") ?? sandbox
  const roots: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== "string") return
    try {
      roots.push(CcaPolicy.parsePathUri(value))
    } catch {}
  }
  add(field(context, "cwd"))
  const workspaceRoots = field(context, "workspaceRoots")
  if (Array.isArray(workspaceRoots)) for (const root of workspaceRoots) add(root)
  const entries = field(field(field(sandbox, "permissions"), "file_system"), "entries")
  if (!Array.isArray(entries)) return roots
  const temporaryDirectories = field(sandbox, "temporaryDirectories")
  for (const entry of entries) {
    const access = field(entry, "access")
    const target = field(entry, "path")
    if ((access !== "read" && access !== "write") || field(target, "type") !== "special") continue
    const kind = field(field(target, "value"), "kind")
    if (kind === "tmpdir") {
      if (Array.isArray(temporaryDirectories)) for (const root of temporaryDirectories) add(root)
      else roots.push(...defaultTemporaryDirectories())
    } else if (kind === "slash_tmp" && process.platform !== "win32") roots.push("/tmp")
  }
  return roots
}

function withinDirectory(target: string, root: string): boolean {
  if (root === path.parse(root).root) return target.startsWith(root)
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

function combineGrants(first: CcaAuthorizationGrant | undefined, second: CcaAuthorizationGrant): CcaAuthorizationGrant {
  if (first === undefined) return second
  return {
    release: async () => {
      const results = await Promise.allSettled([second.release(), first.release()])
      const failed = results.find((result) => result.status === "rejected")
      if (failed) throw failed.reason
    },
  }
}

function permits(access: CcaPolicy.SandboxAccess, need: "read" | "write"): boolean {
  return access === "write" || (need === "read" && access === "read")
}

const OUTSIDE_ROOTS_MESSAGE = CcaPolicy.osErrorMessage("EPERM", 1)
const outsideRoots = () => new CcaExecutorError(-32600, OUTSIDE_ROOTS_MESSAGE)

function isOutsideRoots(err: unknown): boolean {
  return err instanceof CcaExecutorError && err.code === -32600 && err.message === OUTSIDE_ROOTS_MESSAGE
}

function mapPolicyError(err: unknown): CcaExecutorError {
  if (err instanceof CcaPolicy.PolicyError) {
    return err.code === "outside_roots" ? outsideRoots() : new CcaExecutorError(-32602, err.message)
  }
  if (err instanceof CcaExecutorError) return err
  return new CcaExecutorError(-32603, "Internal error")
}

const notFound = () => new CcaExecutorError(-32004, "No such file or directory (os error 2)")
const notADirectory = () => new CcaExecutorError(-32603, "Not a directory (os error 20)")

async function missingFsPath(native: string): Promise<CcaExecutorError> {
  const code = await fs.stat(native).then(
    () => undefined,
    (err: unknown) => (err as { readonly code?: unknown } | null)?.code,
  )
  return code === "ENOTDIR" ? notADirectory() : notFound()
}

function mapFsError(err: unknown): CcaExecutorError {
  if (err instanceof CcaExecutorError) return err
  const code = (err as { readonly code?: unknown } | null)?.code
  if (code === "ENOENT") return notFound()
  if (code === "ENOTDIR") return notADirectory()
  if (code === "EINVAL") return new CcaExecutorError(-32600, "Invalid path")
  if (code === "EACCES" || code === "EPERM") return new CcaExecutorError(-32600, "Permission denied")
  return new CcaExecutorError(-32603, "Filesystem error")
}

function missingPath(err: unknown) {
  return err instanceof CcaPolicy.PolicyError && err.message === "path does not exist"
}


async function checkAuthorization(
  authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>,
  action: string,
  resources: readonly string[],
  metadata?: Readonly<Record<string, string>>,
): Promise<CcaAuthorizationGrant> {
  let grant: CcaAuthorizationGrant
  try {
    grant = await authorize({ action, resources, ...(metadata === undefined ? {} : { metadata }) })
  } catch (error) {
    const text = error instanceof CcaAuthorizationDeniedError ? ccaRefusalText(error) : undefined
    throw text === undefined ? new CcaExecutorError(-32001, "Permission denied") : new CcaRefusalError(text)
  }
  if (!grant || typeof grant.release !== "function") {
    throw new CcaExecutorError(-32001, "Permission denied")
  }
  return grant
}

async function runWithGrant<T>(grant: CcaAuthorizationGrant, fn: () => Promise<T>): Promise<T> {
  let failed = false
  let failure: unknown
  let result: T | undefined
  try {
    result = await fn()
  } catch (err) {
    failed = true
    failure = err
  }
  try {
    await grant.release()
  } catch {
    if (!failed) throw new CcaExecutorError(-32603, "Internal error")
  }
  if (failed) throw failure
  return result as T
}

type StdioPipe = "pipe" | "ignore"

const SHELL_WRAPPER_NAMES: ReadonlySet<string> = new Set(["sh", "bash", "zsh"])
const SHELL_WRAPPER_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc", "-ic"])

function shellWrapperScript(argv: readonly string[]): string | undefined {
  if (argv.length !== 3 || !SHELL_WRAPPER_NAMES.has(path.basename(argv[0])) || !SHELL_WRAPPER_FLAGS.has(argv[1])) return undefined
  return argv[2]
}

function releaseEntrySnapshot(entry: RunningProcessEntry): void {
  const release = entry.releaseSnapshot
  entry.releaseSnapshot = undefined
  release?.()
}

function finishEntry(entry: RunningProcessEntry): void {
  if (entry.doneResolved) return
  entry.doneResolved = true
  entry.resolveDone()
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid
  if (!pid) {
    try {
      child.kill(signal)
    } catch {}
    return
  }
  if (process.platform === "win32") {
    exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => {})
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

function clearEntryTimers(entry: RunningProcessEntry): void {
  if (entry.timeoutTimer) {
    clearTimeout(entry.timeoutTimer)
    entry.timeoutTimer = undefined
  }
  if (entry.killTimer) {
    clearTimeout(entry.killTimer)
    entry.killTimer = undefined
  }
}

function terminateEntryGraceful(entry: RunningProcessEntry): void {
  const child = entry.child
  if (!child || entry.exited) return
  killProcessGroup(child, "SIGTERM")
  if (entry.killTimer) return
  entry.killTimer = setTimeout(() => {
    entry.killTimer = undefined
    if (entry.child && !entry.exited) killProcessGroup(entry.child, "SIGKILL")
  }, 3000)
  entry.killTimer.unref?.()
}

function attributionOf(metadata: unknown): CcaAttribution | undefined {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" && value.length <= 256 ? value : undefined)
  const threadId = text(field(metadata, "threadId"))
  const toolCallId = text(field(metadata, "toolCallId"))
  if (threadId === undefined && toolCallId === undefined) return undefined
  return { ...(threadId === undefined ? {} : { threadId }), ...(toolCallId === undefined ? {} : { toolCallId }) }
}

function deniedSubject(input: CcaAuthorizationInput): string {
  const subject = input.resources[0] ?? ""
  if (input.action !== CCA_HTTP_NETWORK_ACTION) return subject
  const url = URL.parse(subject)
  return url === null ? "" : `${url.origin}${url.pathname}`
}

function traceOf(error: unknown): CcaDecisionTrace {
  const trace = field(error, "trace")
  return Array.isArray(trace) ? (trace as CcaDecisionTrace) : []
}

function recordingFailed(cause: unknown) {
  Effect.runFork(Effect.logWarning("CCA transcript recording failed", { cause }))
}

type RefusalSlot = { text?: string }
const refusals = new AsyncLocalStorage<RefusalSlot>()

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  const slot: RefusalSlot = {}
  try {
    return await refusals.run(slot, run)
  } catch (error) {
    if (slot.text !== undefined && !(error instanceof CcaRefusalError)) throw new CcaRefusalError(slot.text)
    throw error
  }
}

const unavailableScope = () => new CcaExecutorError(-32603, "Executor scope unavailable")

async function previousContent(target: string): Promise<Uint8Array | undefined> {
  const info = await fs.stat(target).catch(() => undefined)
  if (info === undefined) return new Uint8Array()
  if (!info.isFile() || info.size > CONTENT_CAPTURE_BYTES) return undefined
  return fs.readFile(target).catch(() => undefined)
}

const CONTENT_CAPTURE_BYTES = 1024 * 1024
const FILESYSTEM_ROOT = path.parse(process.cwd()).root

export function createCcaExecutor(options: CcaExecutorOptions): CcaExecutorHandler & { close(): Promise<void> } {
  const getSessionId = options.sessionId ?? (() => randomUUID())
  const timeoutMs = options.processTimeoutMs ? Math.min(options.processTimeoutMs, 3_600_000) : 600_000
  const maxBufferedBytes = options.maxBufferedBytesPerProcess ?? 1024 * 1024
  const maxLiveProcesses =
    options.maxLiveProcesses !== undefined && options.maxLiveProcesses > 0
      ? Math.floor(options.maxLiveProcesses)
      : DEFAULT_MAX_LIVE_PROCESSES
  const spawnImpl = options.spawnImpl ?? spawn

  let closed = false
  let releaseFailureRecorded = false
  const notifyBySession = new Map<string, (method: string, params: unknown) => Promise<void> | void>()
  const callBySession = new Map<string, CcaSessionCall>()
  const credentialBrokers = createCcaCredentialBrokerCache()
  const processes = new Map<string, RunningProcessEntry>()
  const shellSnapshots = createCcaShellSnapshotCache({
    authorize: (input) => {
      const active = processes.get(input.metadata?.processId ?? "")?.active
      return active === undefined ? Promise.reject(new CcaExecutorError(-32001, "Permission denied")) : active.authorize(input)
    },
  })
  const scopes = new Map<string, Promise<{ readonly scope: CcaExecutorScope; readonly active: ActiveScope }>>()
  const bindings = new Map<string, string | null>()
  let scopeIds = 0
  let scopesReleased = false

  const activate = (scope: CcaExecutorScope): ActiveScope => {
    if (!scope.roots || scope.roots.length === 0) throw new CcaExecutorError(-32602, "at least one containing root is required")
    const record = (write: (transcript: CcaTranscript.Recorder) => void) => {
      if (scope.transcript === undefined) return
      try {
        write(scope.transcript)
      } catch (cause) {
        recordingFailed(cause)
      }
    }
    return {
      id: ++scopeIds,
      sessionID: scope.sessionID,
      outside: scope.authorization.defers ? [FILESYSTEM_ROOT] : [],
      get roots() {
        return scope.roots
      },
      record,
      authorize: async (input) => {
        try {
          return await scope.authorization.authorize(input)
        } catch (error) {
          record((transcript) => transcript.denied({ action: input.action, subject: deniedSubject(input), trace: traceOf(error) }))
          const text = error instanceof CcaAuthorizationDeniedError ? ccaRefusalText(error) : undefined
          const slot = refusals.getStore()
          if (text !== undefined && slot !== undefined) slot.text ??= text
          throw error
        }
      },
    }
  }

  const resolveScope = (attribution: CcaAttribution | undefined, context: CcaScopeContext): Promise<ActiveScope> => {
    const threadId = attribution?.threadId
    const key = threadId ?? ""
    if (scopesReleased) return Promise.reject(new CcaExecutorError(-32603, "Executor session closed"))
    const existing = scopes.get(key)
    if (existing !== undefined) return existing.then((entry) => entry.active)
    const pending = options.scopeFor(threadId === undefined ? undefined : attribution, context).then((scope) => {
      if (scopesReleased) {
        void scope.close().catch((cause: unknown) => Effect.runFork(Effect.logWarning("CCA executor scope cleanup failed", { cause })))
        throw new CcaExecutorError(-32603, "Executor session closed")
      }
      return { scope, active: activate(scope) }
    })
    scopes.set(key, pending)
    pending.catch(() => {
      if (scopes.get(key) === pending) scopes.delete(key)
    })
    return pending.then(
      (entry) => entry.active,
      (error: unknown) => {
        throw error instanceof CcaExecutorError ? error : unavailableScope()
      },
    )
  }

  const sessionScope = (ctx: { readonly sessionId: string }) => {
    const threadId = bindings.get(ctx.sessionId)
    return resolveScope(typeof threadId === "string" ? { threadId } : undefined, { sessionId: ctx.sessionId })
  }

  const bind = (sessionId: string, threadId: string | undefined) => {
    if (threadId === undefined) return
    if (!bindings.has(sessionId)) bindings.set(sessionId, threadId)
    else if (bindings.get(sessionId) !== threadId) bindings.set(sessionId, null)
  }

  const emit = (entry: RunningProcessEntry, method: string, params: unknown) => {
    const notify = notifyBySession.get(entry.sessionId)
    if (!notify) return
    Promise.resolve(notify(method, params)).catch(() => {})
  }

  const resolveExistingPath = async (
    roots: readonly string[],
    uri: string,
    allowMissingFinal: boolean,
    missingInsideRoots: (native: string) => CcaExecutorError | Promise<CcaExecutorError>,
    extraRoots: readonly string[] = [],
    missingOutsideRoots?: (native: string) => CcaExecutorError | Promise<CcaExecutorError>,
  ): Promise<string> => {
    const scope = extraRoots.length === 0 ? roots : [...roots, ...extraRoots]
    let native: string
    try {
      native = CcaPolicy.parsePathUri(uri)
    } catch (err) {
      throw mapPolicyError(err)
    }
    try {
      return await CcaPolicy.resolveContained(native, scope, { allowMissingFinal })
    } catch (err) {
      if (!missingPath(err)) throw mapPolicyError(err)
    }
    for (let ancestor = path.dirname(native); ; ancestor = path.dirname(ancestor)) {
      const contained = await CcaPolicy.resolveContained(ancestor, scope).then(
        () => true,
        (err: unknown) => {
          if (missingPath(err)) return false
          if (missingOutsideRoots !== undefined && err instanceof CcaPolicy.PolicyError && err.code === "outside_roots") return undefined
          throw mapPolicyError(err)
        },
      )
      if (contained) throw await missingInsideRoots(native)
      if (contained === undefined || path.dirname(ancestor) === ancestor) {
        throw missingOutsideRoots === undefined ? outsideRoots() : await missingOutsideRoots(native)
      }
    }
  }

  const resolveFsPath = (roots: readonly string[], uri: string, allowMissingFinal: boolean, extraRoots: readonly string[] = []) =>
    resolveExistingPath(roots, uri, allowMissingFinal, missingFsPath, extraRoots, missingFsPath)

  const insideRoots = (roots: readonly string[], resolved: string) =>
    CcaPolicy.resolveContained(resolved, roots, { allowMissingFinal: true }).then(() => true, () => false)

  const authorizeExternalDirectory = async (
    active: ActiveScope,
    resolved: string,
  ): Promise<CcaAuthorizationGrant | undefined> => {
    if (await insideRoots(active.roots, resolved)) return undefined
    const isDirectory = await fs.stat(resolved).then((info) => info.isDirectory(), () => false)
    const directory = isDirectory ? resolved : path.dirname(resolved)
    return checkAuthorization(active.authorize, "external_directory", [path.join(directory, "*")], {
      filepath: resolved,
      parentDir: directory,
    })
  }

  const authorizeFsPath = async (
    active: ActiveScope,
    params: { readonly path: string; readonly sandbox?: unknown },
    allowMissingFinal: boolean,
    action: "read" | "edit",
    need: "read" | "write",
    checkSandboxAccess = true,
  ): Promise<{
    readonly resolvedPath: string
    readonly grant: CcaAuthorizationGrant
    readonly native: string
    readonly sandbox: CcaPolicy.SandboxPolicy | undefined
    readonly extraRoots: readonly string[]
  }> => {
    let native: string
    let sandbox: CcaPolicy.SandboxPolicy | undefined
    try {
      native = CcaPolicy.parsePathUri(params.path)
      sandbox = await CcaPolicy.resolveSandbox(
        { sandbox: params.sandbox },
        { temporaryDirectories: defaultTemporaryDirectories() },
      )
    } catch (err) {
      throw mapPolicyError(err)
    }
    const confined = sandbox?.fileSystem === "restricted"
    const extraRoots = [...sandboxOperationRoots(params.sandbox), ...active.outside]
    let resolvedPath: string
    try {
      resolvedPath = await resolveFsPath(active.roots, params.path, allowMissingFinal, extraRoots)
    } catch (err) {
      if (confined && isOutsideRoots(err)) throw sandboxPermissionDenied()
      throw err
    }
    if (checkSandboxAccess && confined && !permits(sandbox!.access(resolvedPath, native), need)) throw sandboxPermissionDenied()
    let external: CcaAuthorizationGrant | undefined
    try {
      external = await authorizeExternalDirectory(active, resolvedPath)
    } catch (err) {
      if (confined && err instanceof CcaExecutorError && err.code === -32001) throw sandboxPermissionDenied()
      throw err
    }
    try {
      const grant = await checkAuthorization(active.authorize, action, [resolvedPath])
      return { resolvedPath, grant: combineGrants(external, grant), native, sandbox, extraRoots }
    } catch (err) {
      await external?.release().catch(() => {})
      if (confined && err instanceof CcaExecutorError && err.code === -32001) throw sandboxPermissionDenied()
      throw err
    }
  }

  const checkNotClosed = () => {
    if (closed) {
      throw new CcaExecutorError(-32603, "Executor session closed")
    }
  }

  const settleEntryGrant = (entry: RunningProcessEntry): Promise<void> => {
    if (entry.grantSettled) return entry.grantSettled
    const grant = entry.grant
    if (!grant) return Promise.resolve()
    entry.grant = undefined
    entry.grantSettled = (async () => {
      try {
        await grant.release()
      } catch {
        entry.releaseFailed = true
        releaseFailureRecorded = true
      }
    })()
    return entry.grantSettled
  }

  const releaseNetwork = (entry: RunningProcessEntry): Promise<void> => {
    entry.networkShutdown?.abort()
    entry.networkShutdown = undefined
    const proxy = entry.networkProxy
    entry.networkProxy = undefined
    return proxy === undefined ? Promise.resolve() : proxy.close().catch(() => {})
  }

  const sessionCall = (sessionId: string): CcaSessionCall => (method, params, callOptions) => {
    const call = callBySession.get(sessionId)
    return call === undefined ? Promise.reject(new CcaExecutorError(-32603, "Connection closed")) : call(method, params, callOptions)
  }

  const pruneExitedProcesses = () => {
    if (processes.size <= MAX_RETAINED_EXITED_PROCESSES) return
    for (const [id, proc] of processes) {
      if (proc.closed && proc.doneResolved) {
        processes.delete(id)
        if (processes.size <= MAX_RETAINED_EXITED_PROCESSES) break
      }
    }
  }

  const initialize = async (
    _params: CcaInitializeParams,
    ctx: CcaInitializeContext,
  ): Promise<CcaInitializeResult> => {
    checkNotClosed()
    const sessionId = getSessionId()
    if (ctx.notify) notifyBySession.set(sessionId, ctx.notify)
    if (ctx.call) callBySession.set(sessionId, ctx.call)
    return { sessionId }
  }

  const startProcess = (params: CcaExecParams, ctx: CcaRpcHandlerContext): Promise<CcaExecResult> => {
    const slot: RefusalSlot = {}
    return refusals.run(slot, () => startProcessIn(params, ctx, slot))
  }

  const startProcessIn = async (
    params: CcaExecParams,
    ctx: CcaRpcHandlerContext,
    slot: RefusalSlot,
  ): Promise<CcaExecResult> => {
    checkNotClosed()

    if (params.tty === true) {
      throw new CcaExecutorError(-32602, "tty is unsupported")
    }

    try {
      CcaPolicy.assertArgv(params.argv)
    } catch (err) {
      throw mapPolicyError(err)
    }

    const existing = processes.get(params.processId)
    if (existing && !existing.closed && !existing.exited) {
      throw new CcaExecutorError(-32600, `process ${params.processId} already exists`)
    }

    let liveCount = 0
    for (const proc of processes.values()) {
      if (!proc.exited && !proc.closed) liveCount++
    }
    if (liveCount >= maxLiveProcesses) {
      throw new CcaExecutorError(-32602, "Too many processes")
    }

    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const procEntry: RunningProcessEntry = {
      processId: params.processId,
      sessionId: ctx.sessionId,
      spawned: false,
      releaseFailed: false,
      done,
      resolveDone,
      doneResolved: false,
      acceptedWriteIds: new Map<string, string>(),
      chunks: [],
      retainedBytes: 0,
      nextSeq: 1,
      exited: false,
      exitCode: null,
      closed: false,
      terminationRequested: false,
      pendingInterrupt: false,
      stdoutEnded: false,
      stderrEnded: false,
      sandboxDenied: false,
      exitedNotified: false,
      closedNotified: false,
      waiters: new Set<() => void>(),
    }
    processes.set(params.processId, procEntry)

    const attribution = attributionOf(params.metadata)
    bind(ctx.sessionId, attribution?.threadId)
    const command = shellWrapperScript(params.argv) ?? params.argv.join(" ")

    const completeWithoutSpawn = (
      outputs: readonly { readonly stream: "stdout" | "stderr"; readonly data: Buffer }[],
      exitCode: number,
      sandboxDenied: boolean,
    ): CcaExecResult => {
      if (closed || processes.get(params.processId) !== procEntry) {
        throw new CcaExecutorError(-32603, "Executor session closed")
      }
      const chunks = outputs.flatMap((output) =>
        Array.from({ length: Math.ceil(output.data.length / CHUNK_SPLIT_SIZE) }, (_, index) => ({
          stream: output.stream,
          chunkBuffer: output.data.subarray(index * CHUNK_SPLIT_SIZE, (index + 1) * CHUNK_SPLIT_SIZE),
        })),
      ).map((chunk, index) => ({ ...chunk, seq: index + 1 }))
      procEntry.chunks.push(...chunks)
      procEntry.retainedBytes = chunks.reduce((sum, chunk) => sum + chunk.chunkBuffer.length, 0)
      while (procEntry.retainedBytes > maxBufferedBytes && procEntry.chunks.length > 0) {
        procEntry.retainedBytes -= procEntry.chunks.shift()!.chunkBuffer.length
      }
      const exitedSeq = chunks.length + 1
      procEntry.nextSeq = exitedSeq + 2
      procEntry.exited = true
      procEntry.exitCode = exitCode
      procEntry.closed = true
      procEntry.stdoutEnded = true
      procEntry.stderrEnded = true
      procEntry.sandboxDenied = sandboxDenied
      procEntry.exitedNotified = true
      procEntry.closedNotified = true
      const recording = procEntry.recording
      if (recording !== undefined) {
        procEntry.active?.record(() => {
          for (const chunk of chunks) recording.output(chunk.chunkBuffer)
          recording.ended({ exitCode, sandboxDenied })
        })
      }
      void settleEntryGrant(procEntry)
      finishEntry(procEntry)
      for (const w of procEntry.waiters) w()
      setImmediate(() => {
        for (const chunk of chunks) {
          emit(procEntry, "process/output", {
            processId: params.processId,
            seq: chunk.seq,
            stream: chunk.stream,
            chunk: chunk.chunkBuffer.toString("base64"),
          })
        }
        emit(procEntry, "process/exited", { processId: params.processId, seq: exitedSeq, exitCode, sandboxDenied })
        emit(procEntry, "process/closed", { processId: params.processId, seq: exitedSeq + 1 })
      })
      pruneExitedProcesses()
      return { processId: params.processId, sandboxType: "none" }
    }

    const startRecording = (cwd: string) => {
      procEntry.active?.record((transcript) => {
        procEntry.recording = transcript.process({
          processId: params.processId,
          command,
          shell: path.basename(params.argv[0] ?? ""),
          cwd,
          ...(attribution?.threadId === undefined ? {} : { threadId: attribution.threadId }),
          ...(attribution?.toolCallId === undefined ? {} : { toolCallId: attribution.toolCallId }),
        })
      })
    }

    const denyAsSandbox = (cwd: string): CcaExecResult => {
      if (closed || processes.get(params.processId) !== procEntry) {
        throw new CcaExecutorError(-32603, "Executor session closed")
      }
      startRecording(cwd)
      return completeWithoutSpawn([{ stream: "stderr", data: Buffer.from(SANDBOX_DENIAL_OUTPUT) }], 1, true)
    }

    let refusalCwd = ""
    try {
    let nativeCwd: string
    let sandbox: CcaPolicy.SandboxPolicy | undefined
    try {
      nativeCwd = CcaPolicy.parsePathUri(params.cwd)
      refusalCwd = nativeCwd
      sandbox = await CcaPolicy.resolveSandbox(params, {
        cwd: nativeCwd,
        readablePolicyCwd: true,
        temporaryDirectories: defaultTemporaryDirectories(),
      })
    } catch (err) {
      throw mapPolicyError(err)
    }

    const active = attribution?.threadId === undefined
      ? await sessionScope(ctx)
      : await resolveScope(attribution, { sessionId: ctx.sessionId, cwd: nativeCwd })
    procEntry.active = active

    let resolvedCwd: string
    try {
      resolvedCwd = await resolveExistingPath(
        active.roots,
        params.cwd,
        false,
        () => new CcaExecutorError(-32603, "Failed to start process"),
        [...sandboxOperationRoots(params.sandbox), ...active.outside],
      )
    } catch (err) {
      if (sandbox?.sandboxed && isOutsideRoots(err)) return denyAsSandbox(nativeCwd)
      throw err
    }
    refusalCwd = resolvedCwd
    if (sandbox?.sandboxed && !permits(sandbox.access(resolvedCwd, nativeCwd), "read")) return denyAsSandbox(resolvedCwd)

    let external: CcaAuthorizationGrant | undefined
    try {
      external = await authorizeExternalDirectory(active, resolvedCwd)
    } catch (err) {
      if (sandbox?.sandboxed && err instanceof CcaExecutorError && err.code === -32001) return denyAsSandbox(resolvedCwd)
      throw err
    }
    const script = shellWrapperScript(params.argv)
    try {
      procEntry.grant = combineGrants(
        external,
        await checkAuthorization(active.authorize, "shell", [command], {
          cwd: resolvedCwd,
          workdir: resolvedCwd,
          ...(script === undefined ? {} : { argv: JSON.stringify(params.argv) }),
        }),
      )
    } catch (err) {
      await external?.release().catch(() => {})
      if (sandbox?.sandboxed && err instanceof CcaExecutorError && err.code === -32001) return denyAsSandbox(resolvedCwd)
      throw err
    }

    if (closed || processes.get(params.processId) !== procEntry) {
      throw new CcaExecutorError(-32603, "Executor session closed")
    }

    startRecording(resolvedCwd)
    const answer = await options.answerProcess?.(params, { attribution, sessionId: ctx.sessionId })
    if (answer !== undefined) {
      return completeWithoutSpawn(
        [
          { stream: "stdout" as const, data: Buffer.from(answer.stdout) },
          { stream: "stderr" as const, data: Buffer.from(answer.stderr) },
        ].filter((output) => output.data.length > 0),
        answer.exitCode,
        false,
      )
    }

    if (closed || processes.get(params.processId) !== procEntry) {
      throw new CcaExecutorError(-32603, "Executor session closed")
    }

    const baseEnv = params.envPolicy == null
      ? {
          PATH: process.env.PATH ?? "",
          HOME: os.homedir(),
          TMPDIR: os.tmpdir(),
          ...(options.baseEnv ?? {}),
        }
      : { ...process.env, ...(options.baseEnv ?? {}) }

    let childEnv: Record<string, string>
    try {
      childEnv = CcaPolicy.buildProcessEnv({
        base: baseEnv,
        env: params.env,
        envPolicy: params.envPolicy,
      })
    } catch (err) {
      throw mapPolicyError(err)
    }

    let argv = params.argv
    if (params.networkProxy !== undefined) {
      const shutdown = new AbortController()
      procEntry.networkShutdown = shutdown
      const hooks = options.networkPolicy?.({
        processId: params.processId,
        launch: params.networkProxy,
        call: sessionCall(ctx.sessionId),
        notify: (method, notification) => emit(procEntry, method, notification),
        signal: shutdown.signal,
      })
      try {
        procEntry.networkProxy = await startCcaNetworkProxy({
          processId: params.processId,
          launch: params.networkProxy,
          env: childEnv,
          authorize: active.authorize,
          ...(hooks?.decider === undefined ? {} : { decider: hooks.decider }),
          ...(hooks?.onPolicyDecision === undefined ? {} : { onPolicyDecision: hooks.onPolicyDecision }),
          credentialBrokers,
          ...(options.networkProxyCaDirectory === undefined ? {} : { caDirectory: options.networkProxyCaDirectory }),
          command: {
            argv: params.argv,
            ...(params.arg0 === undefined ? {} : { arg0: params.arg0 }),
            ...(params.shellSnapshot === undefined ? {} : { shellSnapshot: { shell: params.shellSnapshot.shell } }),
          },
        })
      } catch (err) {
        if (err instanceof CcaNetworkProxyError) throw new CcaExecutorError(err.code, err.message)
        throw err
      }
      childEnv = { ...procEntry.networkProxy.env }
      if (closed || processes.get(params.processId) !== procEntry) {
        throw new CcaExecutorError(-32603, "Executor session closed")
      }
    }

    let snapshot: CcaShellSnapshotLaunch | undefined
    if (params.shellSnapshot !== undefined) {
      try {
        snapshot = await shellSnapshots.prepare({
          sessionId: ctx.sessionId,
          processId: params.processId,
          request: params.shellSnapshot,
          argv: params.argv,
          ...(params.arg0 === undefined ? {} : { arg0: params.arg0 }),
          cwd: resolvedCwd,
          env: childEnv,
          requestEnv: params.env,
          ...(params.envPolicy == null ? {} : { envPolicy: params.envPolicy }),
          ...(params.sandbox == null ? {} : { sandboxKey: JSON.stringify(params.sandbox) }),
          ...(procEntry.networkProxy?.credentialBroker === undefined ? {} : { credentialBroker: procEntry.networkProxy.credentialBroker }),
        })
      } catch (err) {
        if (err instanceof CcaShellSnapshotError) throw new CcaExecutorError(err.code, err.message)
        throw err
      }
      if (snapshot !== undefined) {
        argv = snapshot.argv
        childEnv = { ...snapshot.env }
      }
      if (closed || processes.get(params.processId) !== procEntry) {
        snapshot?.release()
        throw new CcaExecutorError(-32603, "Executor session closed")
      }
    }
    if (snapshot !== undefined) procEntry.releaseSnapshot = snapshot.release

    let child: ChildProcess
    try {
      const stdio: [StdioPipe, StdioPipe, StdioPipe] = [params.pipeStdin ? "pipe" : "ignore", "pipe", "pipe"]
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd: resolvedCwd,
        env: { ...childEnv, YCODING_SESSION_ID: active.sessionID },
        shell: false,
        argv0: params.arg0,
        detached: process.platform !== "win32",
        stdio: snapshot === undefined ? stdio : ccaShellSnapshotStdio(stdio, snapshot),
        windowsHide: true,
      })
    } catch {
      throw new CcaExecutorError(-32603, "Failed to start process")
    }
    procEntry.child = child
    child.stdin?.on("error", () => {})
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})

    const onData = (stream: "stdout" | "stderr", data: Buffer) => {
      let offset = 0
      while (offset < data.length) {
        const slice = data.subarray(offset, offset + CHUNK_SPLIT_SIZE)
        offset += CHUNK_SPLIT_SIZE
        const seq = procEntry.nextSeq++
        procEntry.chunks.push({ seq, stream, chunkBuffer: slice })
        procEntry.retainedBytes += slice.length
        const recording = procEntry.recording
        if (recording !== undefined) active.record(() => recording.output(slice))

        while (procEntry.retainedBytes > maxBufferedBytes && procEntry.chunks.length > 0) {
          const dropped = procEntry.chunks.shift()!
          procEntry.retainedBytes -= dropped.chunkBuffer.length
        }

        emit(procEntry, "process/output", {
          processId: procEntry.processId,
          seq,
          stream,
          chunk: slice.toString("base64"),
        })
      }
      for (const w of procEntry.waiters) w()
    }

    const maybeEmitExited = () => {
      if (!procEntry.spawned || !procEntry.exited || procEntry.exitedNotified) return
      if (!procEntry.stdoutEnded || !procEntry.stderrEnded) return
      procEntry.exitedNotified = true
      const seq = procEntry.nextSeq++
      emit(procEntry, "process/exited", {
        processId: procEntry.processId,
        seq,
        exitCode: procEntry.exitCode,
        sandboxDenied: false,
      })
      void settleEntryGrant(procEntry)
    }

    child.stdout?.on("data", (data: Buffer) => onData("stdout", data))
    child.stderr?.on("data", (data: Buffer) => onData("stderr", data))
    if (!child.stdout) procEntry.stdoutEnded = true
    if (!child.stderr) procEntry.stderrEnded = true
    child.stdout?.on("end", () => {
      procEntry.stdoutEnded = true
      maybeEmitExited()
    })
    child.stdout?.on("close", () => {
      procEntry.stdoutEnded = true
      maybeEmitExited()
    })
    child.stderr?.on("end", () => {
      procEntry.stderrEnded = true
      maybeEmitExited()
    })
    child.stderr?.on("close", () => {
      procEntry.stderrEnded = true
      maybeEmitExited()
    })

    child.on("exit", (code, signal) => {
      procEntry.exited = true
      procEntry.exitCode = code !== null ? code : (signal ? 128 + ((os.constants.signals as Record<string, number>)[signal] ?? 1) : 1)
      clearEntryTimers(procEntry)
      maybeEmitExited()
      for (const w of procEntry.waiters) w()
      pruneExitedProcesses()
    })

    child.on("close", () => {
      clearEntryTimers(procEntry)
      void releaseNetwork(procEntry)
      procEntry.closed = true
      procEntry.stdoutEnded = true
      procEntry.stderrEnded = true
      if (procEntry.spawned) {
        if (!procEntry.exited) {
          procEntry.exited = true
          if (procEntry.exitCode === null) procEntry.exitCode = 1
        }
        maybeEmitExited()
        const recording = procEntry.recording
        if (recording !== undefined) active.record(() => recording.ended({ exitCode: procEntry.exitCode, sandboxDenied: false }))
        if (!procEntry.closedNotified) {
          procEntry.closedNotified = true
          const seq = procEntry.nextSeq++
          emit(procEntry, "process/closed", {
            processId: procEntry.processId,
            seq,
          })
        }
      }
      for (const w of procEntry.waiters) w()
      void settleEntryGrant(procEntry)
      finishEntry(procEntry)
    })

    child.on("error", () => {
      clearEntryTimers(procEntry)
      if (procEntry.spawned) {
        procEntry.exited = true
        if (procEntry.exitCode === null) procEntry.exitCode = 1
      }
      for (const w of procEntry.waiters) w()
    })

    if (timeoutMs > 0) {
      procEntry.timeoutTimer = setTimeout(() => {
        terminateEntryGraceful(procEntry)
      }, timeoutMs)
      procEntry.timeoutTimer.unref?.()
    }

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        procEntry.spawned = true
        resolve()
      })
      child.once("error", () => {
        reject(new CcaExecutorError(-32603, "Failed to start process"))
      })
    }).finally(() => releaseEntrySnapshot(procEntry))

    if (closed || processes.get(params.processId) !== procEntry) {
      killProcessGroup(child, "SIGKILL")
      throw new CcaExecutorError(-32603, "Executor session closed")
    }
    if (procEntry.terminationRequested) {
      terminateEntryGraceful(procEntry)
    } else if (procEntry.pendingInterrupt) {
      procEntry.pendingInterrupt = false
      killProcessGroup(child, "SIGINT")
    }

    pruneExitedProcesses()

    return {
      processId: params.processId,
      sandboxType: "none",
    }
    } catch (err) {
      const refusal = err instanceof CcaRefusalError ? err.text : slot.text
      if (refusal !== undefined && !closed && processes.get(params.processId) === procEntry && !procEntry.spawned) {
        clearEntryTimers(procEntry)
        releaseEntrySnapshot(procEntry)
        await releaseNetwork(procEntry)
        if (procEntry.recording === undefined) startRecording(refusalCwd)
        return completeWithoutSpawn([{ stream: "stderr", data: Buffer.from(`${refusal}\n`) }], 1, false)
      }
      const recording = procEntry.recording
      if (recording !== undefined) procEntry.active?.record(() => recording.ended({ exitCode: null, sandboxDenied: false }))
      clearEntryTimers(procEntry)
      releaseEntrySnapshot(procEntry)
      await releaseNetwork(procEntry)
      await settleEntryGrant(procEntry)
      finishEntry(procEntry)
      if (processes.get(params.processId) === procEntry) {
        processes.delete(params.processId)
      }
      for (const w of procEntry.waiters) w()
      throw err instanceof CcaExecutorError ? err : new CcaExecutorError(-32603, "Internal error")
    }
  }

  const processScope = async (processId: string, ctx: CcaRpcHandlerContext) =>
    processes.get(processId)?.active ?? sessionScope(ctx)

  const readProcess = async (
    params: CcaReadParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaReadResult> => {
    checkNotClosed()

    const grant = await checkAuthorization((await processScope(params.processId, ctx)).authorize, "read", [params.processId])
    return runWithGrant(grant, async () => {
    const proc = processes.get(params.processId)
    if (!proc) {
      throw new CcaExecutorError(-32600, `unknown process id ${params.processId}`)
    }

    const afterSeq = params.afterSeq ?? 0
    const maxBytes = params.maxBytes ?? Number.MAX_SAFE_INTEGER
    const waitMs = Math.min(params.waitMs ?? 0, 30_000)

    const filterChunks = (): { chunks: CcaProcessOutputChunk[]; nextSeq: number } => {
      const result: CcaProcessOutputChunk[] = []
      let totalBytes = 0
      let nextSeq = proc.nextSeq
      for (const c of proc.chunks) {
        if (c.seq > afterSeq) {
          if (result.length > 0 && totalBytes + c.chunkBuffer.length > maxBytes) {
            break
          }
          totalBytes += c.chunkBuffer.length
          result.push({
            seq: c.seq,
            stream: c.stream,
            chunk: c.chunkBuffer.toString("base64"),
          })
          nextSeq = c.seq + 1
          if (totalBytes >= maxBytes) break
        }
      }
      return { chunks: result, nextSeq: params.maxBytes === undefined ? proc.nextSeq : nextSeq }
    }

    let { chunks, nextSeq } = filterChunks()
    if (chunks.length === 0 && !proc.closed && waitMs > 0 && !ctx.signal.aborted) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const onNotify = () => {
          cleanup()
          resolve()
        }
        const onAbort = () => {
          cleanup()
          resolve()
        }
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          proc.waiters.delete(onNotify)
          ctx.signal.removeEventListener("abort", onAbort)
        }
        proc.waiters.add(onNotify)
        ctx.signal.addEventListener("abort", onAbort, { once: true })
        timer = setTimeout(() => {
          cleanup()
          resolve()
        }, waitMs)
      })
      ;({ chunks, nextSeq } = filterChunks())
    }

    return {
      chunks,
      nextSeq,
      exited: proc.exited,
      exitCode: proc.exitCode,
      closed: proc.closed,
      failure: null,
      sandboxDenied: proc.sandboxDenied,
    }
    })
  }

  const writeProcess = async (
    params: CcaWriteParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaWriteResult> => {
    checkNotClosed()

    let buf: Buffer
    try {
      buf = Buffer.from(params.chunk, "base64")
    } catch {
      throw new CcaExecutorError(-32602, "invalid base64 payload")
    }

    if (buf.length > 16 * 1024 * 1024) {
      throw new CcaExecutorError(-32602, "chunk exceeds max size")
    }

    const fullText = buf.toString("utf8")
    const preview = fullText.slice(0, 200).replace(/[\x00-\x1f\x7f]/g, "")
    const grant = await checkAuthorization((await processScope(params.processId, ctx)).authorize, "shell", [params.processId, fullText], {
      writeId: params.writeId,
      bytes: String(buf.length),
      preview,
    })
    return runWithGrant(grant, async () => {
    const proc = processes.get(params.processId)
    if (!proc) {
      return { status: "unknownProcess" }
    }
    if (!proc.child) {
      return { status: proc.exited ? "stdinClosed" : "starting" }
    }

    const chunkHash = createHash("sha256").update(params.chunk).digest("hex")
    const existing = proc.acceptedWriteIds.get(params.writeId)
    if (existing !== undefined) {
      if (existing === chunkHash) {
        return { status: "accepted" }
      }
      throw new CcaExecutorError(-32602, "writeId reused with different payload")
    }

    if (!proc.child.stdin || proc.child.stdin.destroyed || !proc.child.stdin.writable) {
      return { status: "stdinClosed" }
    }

    const stdin = proc.child.stdin
    const accepted = await new Promise<boolean>((resolve) => {
      try {
        stdin.write(buf, (err) => resolve(!err))
      } catch {
        resolve(false)
      }
    })
    if (!accepted) {
      return { status: "stdinClosed" }
    }
    proc.acceptedWriteIds.set(params.writeId, chunkHash)
    while (proc.acceptedWriteIds.size > MAX_ACCEPTED_WRITE_IDS) {
      const oldest = proc.acceptedWriteIds.keys().next().value as string | undefined
      if (oldest === undefined) break
      proc.acceptedWriteIds.delete(oldest)
    }
    return { status: "accepted" }
    })
  }

  const signalProcess = async (
    params: CcaSignalParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaSignalResult> => {
    checkNotClosed()

    const grant = await checkAuthorization((await processScope(params.processId, ctx)).authorize, "shell", [params.processId])
    return runWithGrant(grant, async () => {
    const proc = processes.get(params.processId)
    if (!proc || proc.exited) {
      return {}
    }
    if (!proc.child) {
      proc.pendingInterrupt = true
      return {}
    }

    killProcessGroup(proc.child, "SIGINT")
    return {}
    })
  }

  const terminateProcess = async (
    params: CcaTerminateParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaTerminateResult> => {
    checkNotClosed()

    const grant = await checkAuthorization((await processScope(params.processId, ctx)).authorize, "shell", [params.processId])
    return runWithGrant(grant, async () => {
    const proc = processes.get(params.processId)
    if (!proc || proc.exited) {
      return { running: false }
    }

    const running = !proc.terminationRequested && !proc.exited
    proc.terminationRequested = true
    if (running) {
      terminateEntryGraceful(proc)
    }
    return { running }
    })
  }

  const fileContents = async (resolvedPath: string): Promise<CcaFsReadFileResult> => {
    let st: import("node:fs").Stats
    try {
      st = await fs.stat(resolvedPath)
    } catch (err) {
      throw mapFsError(err)
    }

    if (!st.isFile()) {
      throw new CcaExecutorError(-32600, "Path is not a file")
    }
    if (st.size > MAX_FS_READ_BYTES) {
      throw new CcaExecutorError(-32602, "file exceeds max read size")
    }

    let data: Buffer
    try {
      data = await fs.readFile(resolvedPath)
    } catch (err) {
      throw mapFsError(err)
    }
    if (data.length > MAX_FS_READ_BYTES) {
      throw new CcaExecutorError(-32602, "file exceeds max read size")
    }
    return { dataBase64: data.toString("base64") }
  }

  const pathMetadata = async (resolvedPath: string): Promise<CcaFsGetMetadataResult> => {
    let st: import("node:fs").Stats
    let lst: import("node:fs").Stats
    try {
      st = await fs.stat(resolvedPath)
      lst = await fs.lstat(resolvedPath)
    } catch (err) {
      throw mapFsError(err)
    }

    return {
      isDirectory: st.isDirectory(),
      isFile: st.isFile(),
      isSymlink: lst.isSymbolicLink(),
      size: st.size,
      createdAtMs: Math.round(st.birthtimeMs),
      modifiedAtMs: Math.round(st.mtimeMs),
    }
  }

  const directoryEntries = async (resolvedPath: string): Promise<CcaFsReadDirectoryResult> => {
    let dirents: import("node:fs").Dirent[]
    try {
      dirents = await fs.readdir(resolvedPath, { withFileTypes: true })
    } catch (err) {
      throw mapFsError(err)
    }
    const entries: CcaFsReadDirectoryEntry[] = []
    for (const d of dirents) {
      if (entries.length >= MAX_FS_DIR_ENTRIES) break
      entries.push({
        fileName: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
      })
    }
    return { entries }
  }

  const readFileIn = async (active: ActiveScope, params: CcaFsReadFileParams) => {
    const { resolvedPath, grant } = await authorizeFsPath(active, params, false, "read", "read")
    return { resolvedPath, result: await runWithGrant(grant, () => fileContents(resolvedPath)) }
  }

  const readFile = async (
    params: CcaFsReadFileParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaFsReadFileResult> => {
    checkNotClosed()

    const active = await sessionScope(ctx)
    const read = await readFileIn(active, params)
    active.record((transcript) => transcript.read({ path: read.resolvedPath, bytes: Buffer.byteLength(read.result.dataBase64, "base64") }))
    return read.result
  }

  const writeFile = async (
    params: CcaFsWriteFileParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaFsWriteFileResult> => {
    checkNotClosed()

    const active = await sessionScope(ctx)
    const { resolvedPath, grant } = await authorizeFsPath(active, params, true, "edit", "write")
    return runWithGrant(grant, async () => {
    let buf: Buffer
    try {
      buf = Buffer.from(params.dataBase64, "base64")
    } catch {
      throw new CcaExecutorError(-32602, "invalid base64 payload")
    }

    const before = await previousContent(resolvedPath)
    try {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
      await fs.writeFile(resolvedPath, buf)
    } catch (err) {
      throw mapFsError(err)
    }
    active.record((transcript) => transcript.write({
      operation: "write",
      path: resolvedPath,
      bytes: buf.length,
      ...(before === undefined ? {} : { before }),
      ...(buf.length > CONTENT_CAPTURE_BYTES ? {} : { after: buf }),
    }))
    return {}
    })
  }

  const getMetadata = async (
    params: CcaFsGetMetadataParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaFsGetMetadataResult> => {
    checkNotClosed()

    const { resolvedPath, grant } = await authorizeFsPath(await sessionScope(ctx), params, false, "read", "read")
    return runWithGrant(grant, () => pathMetadata(resolvedPath))
  }

  const readDirectory = async (
    params: CcaFsReadDirectoryParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaFsReadDirectoryResult> => {
    checkNotClosed()

    const { resolvedPath, grant } = await authorizeFsPath(await sessionScope(ctx), params, false, "read", "read")
    return runWithGrant(grant, () => directoryEntries(resolvedPath))
  }

  const openReadTree = async (params: CcaReadTreeParams, ctx: CcaRpcHandlerContext): Promise<CcaReadTree> => {
    checkNotClosed()

    const active = await sessionScope(ctx)
    const opened = await authorizeFsPath(active, params, false, "read", "read", false)
    const treeRoot = opened.resolvedPath
    const sandbox = opened.sandbox?.fileSystem === "restricted" ? opened.sandbox : undefined
    let released: Promise<void> | undefined
    const covered = async (target: { readonly path: string }) => {
      checkNotClosed()
      if (released !== undefined) throw new CcaExecutorError(-32603, "Read tree released")
      let native: string
      try {
        native = CcaPolicy.parsePathUri(target.path)
      } catch (err) {
        throw mapPolicyError(err)
      }
      let resolved: string
      try {
        resolved = await resolveFsPath(active.roots, target.path, false, opened.extraRoots)
      } catch (err) {
        if (err instanceof CcaExecutorError && err.code === -32004) throw err
        return undefined
      }
      return withinDirectory(resolved, treeRoot) ? { resolved, native } : undefined
    }
    const readable = (target: { readonly resolved: string; readonly native: string }) => {
      if (sandbox !== undefined && !permits(sandbox.access(target.resolved, target.native), "read")) throw sandboxPermissionDenied()
      return target.resolved
    }
    const fallback = (target: { readonly path: string }) =>
      params.sandbox === undefined ? { path: target.path } : { path: target.path, sandbox: params.sandbox }
    return {
      getMetadata: async (target) => {
        const local = await covered(target)
        return local === undefined ? getMetadata(fallback(target), ctx) : pathMetadata(local.resolved)
      },
      readDirectory: async (target) => {
        const local = await covered(target)
        return local === undefined ? readDirectory(fallback(target), ctx) : directoryEntries(readable(local))
      },
      readFile: async (target) => {
        const local = await covered(target)
        return local === undefined ? (await readFileIn(active, fallback(target))).result : fileContents(readable(local))
      },
      release: () => {
        released ??= opened.grant.release()
        return released
      },
    }
  }

  const canonicalize = async (
    params: CcaFsCanonicalizeParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaFsCanonicalizeResult> => {
    checkNotClosed()

    const { resolvedPath, grant } = await authorizeFsPath(await sessionScope(ctx), params, false, "read", "read")
    return runWithGrant(grant, async () => {
      return { path: CcaPolicy.toPathUri(resolvedPath) }
    })
  }

  const createDirectory = async (
    params: CcaFsCreateDirectoryParams,
    ctx: CcaRpcHandlerContext,
  ): Promise<CcaFsCreateDirectoryResult> => {
    checkNotClosed()

    let native: string
    try {
      native = CcaPolicy.parsePathUri(params.path)
    } catch (err) {
      throw mapPolicyError(err)
    }
    const name = path.basename(native)
    if (name === "" || name === "." || name === "..") throw new CcaExecutorError(-32602, "Invalid path")
    const active = await sessionScope(ctx)
    const parent = await resolveFsPath(active.roots, CcaPolicy.toPathUri(path.dirname(native)), true, active.outside)
    const target = path.join(parent, name)

    const external = await authorizeExternalDirectory(active, target)
    const grant = combineGrants(external, await checkAuthorization(active.authorize, "edit", [target]).catch(async (error: unknown) => {
      await external?.release().catch(() => {})
      throw error
    }))
    return runWithGrant(grant, async (): Promise<CcaFsCreateDirectoryResult> => {
      try {
        await fs.lstat(target)
        return { created: false }
      } catch (err) {
        if ((err as { readonly code?: unknown } | null)?.code !== "ENOENT") throw mapFsError(err)
      }
      try {
        await fs.mkdir(parent, { recursive: true })
        await fs.mkdir(target)
      } catch (err) {
        if ((err as { readonly code?: unknown } | null)?.code === "EEXIST") return { created: false }
        throw mapFsError(err)
      }
      active.record((transcript) => transcript.write({ operation: "createDirectory", path: target }))
      return { created: true, path: CcaPolicy.toPathUri(target) }
    })
  }

  const authorizeWithExternalDirectories = (active: ActiveScope) => async (input: CcaAuthorizationInput): Promise<CcaAuthorizationGrant> => {
    const grants: CcaAuthorizationGrant[] = []
    try {
      for (const resource of input.resources) {
        if (!path.isAbsolute(resource)) continue
        const external = await authorizeExternalDirectory(active, resource)
        if (external !== undefined) grants.push(external)
      }
      const grant = await active.authorize(input)
      return grants.reduceRight<CcaAuthorizationGrant>((combined, external) => combineGrants(external, combined), grant)
    } catch (err) {
      await Promise.allSettled(grants.map((grant) => grant.release()))
      throw err
    }
  }

  const guarded = <P, C, R>(handler: (params: P, ctx: C) => Promise<R>) => (params: P, ctx: C) => refusing(() => handler(params, ctx))

  const openConnection = (): CcaExecutorConnection => {
    checkNotClosed()
    const https = new Map<number, CcaHttpHandler>()
    const fileSystems = new Map<string, CcaFsExtendedHandlers>()
    type Handle = {
      readonly handlers: CcaFsExtendedHandlers
      readonly active: ActiveScope
      readonly path: string
      readonly mode: OpenMode
      readonly before: Uint8Array | undefined
      readonly blocks: Uint8Array[]
      bytes: number
      sequential: boolean
    }
    const handles = new Map<string, Handle>()
    const httpFor = (active: ActiveScope) => {
      const existing = https.get(active.id)
      if (existing !== undefined) return existing
      const created = createCcaHttpHandler({ authorize: active.authorize })
      https.set(active.id, created)
      return created
    }
    const fileSystemFor = (active: ActiveScope, sandbox: unknown): CcaFsExtendedHandlers => {
      const extraRoots = [...new Set([...sandboxOperationRoots(sandbox), ...active.outside])]
      const key = JSON.stringify([active.id, active.roots, extraRoots])
      let handlers = fileSystems.get(key)
      if (handlers === undefined) {
        handlers = createCcaFsExtended({
          roots: [...active.roots, ...extraRoots],
          authorize: extraRoots.length === 0 ? active.authorize : authorizeWithExternalDirectories(active),
          temporaryDirectories: defaultTemporaryDirectories,
        })
        fileSystems.set(key, handlers)
      }
      return handlers
    }
    const scoped = async (ctx: CcaRpcHandlerContext, sandbox: unknown) => {
      const active = await sessionScope(ctx)
      return { active, handlers: fileSystemFor(active, sandbox) }
    }
    const owner = async (handleId: string, ctx: CcaRpcHandlerContext) =>
      handles.get(handleId)?.handlers ?? (await scoped(ctx, undefined)).handlers
    const nativePath = (uri: string) => {
      try {
        return CcaPolicy.parsePathUri(uri)
      } catch {
        return uri
      }
    }
    let closing: Promise<void> | undefined
    return {
      fs: {
        createDirectory: guarded(async (params, ctx) => {
          const target = await scoped(ctx, params.sandbox)
          const result = await target.handlers.createDirectory(params, ctx)
          target.active.record((transcript) => transcript.write({ operation: "createDirectory", path: nativePath(params.path) }))
          return result
        }),
        open: guarded(async (params, ctx) => {
          const target = await scoped(ctx, params.sandbox)
          const native = nativePath(params.path)
          const before = params.mode === "replace" ? await previousContent(native) : undefined
          const result = await target.handlers.open(params, ctx)
          handles.set(params.handleId, { ...target, path: native, mode: params.mode, before, blocks: [], bytes: 0, sequential: true })
          return result
        }),
        readBlock: guarded(async (params, ctx) => {
          const result = await (await owner(params.handleId, ctx)).readBlock(params, ctx)
          const handle = handles.get(params.handleId)
          if (handle !== undefined) handle.bytes += result.chunk.byteLength
          return result
        }),
        writeBlock: guarded(async (params, ctx) => {
          const result = await (await owner(params.handleId, ctx)).writeBlock(params, ctx)
          const handle = handles.get(params.handleId)
          if (handle !== undefined) {
            handle.sequential &&= params.offset === handle.bytes && handle.bytes + params.chunk.byteLength <= CONTENT_CAPTURE_BYTES
            if (handle.sequential) handle.blocks.push(Uint8Array.from(params.chunk))
            handle.bytes += params.chunk.byteLength
          }
          return result
        }),
        close: guarded(async (params, ctx) => {
          const result = await (await owner(params.handleId, ctx)).close(params, ctx)
          const handle = handles.get(params.handleId)
          handles.delete(params.handleId)
          if (handle?.mode === "read") handle.active.record((transcript) => transcript.read({ path: handle.path, bytes: handle.bytes }))
          if (handle?.mode === "replace") {
            handle.active.record((transcript) => transcript.write({
              operation: "write",
              path: handle.path,
              bytes: handle.bytes,
              ...(handle.before === undefined ? {} : { before: handle.before }),
              ...(handle.sequential ? { after: Buffer.concat(handle.blocks) } : {}),
            }))
          }
          return result
        }),
        walk: guarded(async (params, ctx) => (await scoped(ctx, params.sandbox)).handlers.walk(params, ctx)),
        remove: guarded(async (params, ctx) => {
          const target = await scoped(ctx, params.sandbox)
          const result = await target.handlers.remove(params, ctx)
          target.active.record((transcript) => transcript.write({ operation: "remove", path: nativePath(params.path) }))
          return result
        }),
        copy: guarded(async (params, ctx) => {
          const target = await scoped(ctx, params.sandbox)
          const result = await target.handlers.copy(params, ctx)
          target.active.record((transcript) => transcript.write({
            operation: "copy",
            path: nativePath(params.sourcePath),
            destination: nativePath(params.destinationPath),
          }))
          return result
        }),
      },
      http: {
        request: guarded(async (params, ctx) => {
          const active = await sessionScope(ctx)
          let streamed = 0
          const record = (status: number | undefined, bytes: number) =>
            active.record((transcript) => transcript.http({ method: params.method, url: params.url, ...(status === undefined ? {} : { status }), bytes }))
          let status: number | undefined
          const outcome = await httpFor(active).request(params, {
            signal: ctx.signal,
            emit: (delta) => {
              streamed += delta.delta.byteLength
              if (delta.done) record(status, streamed)
              return ctx.emit(delta)
            },
          }).catch((error: unknown) => {
            if (!(error instanceof CcaExecutorError && error.code === -32001)) record(undefined, 0)
            throw error
          })
          status = outcome.response.status
          if (outcome.stream === undefined) record(status, outcome.response.body.byteLength)
          return outcome
        }),
      },
      close: () => {
        closing ??= (async () => {
          const results = await Promise.allSettled([
            ...[...fileSystems.values()].map((handlers) => handlers.shutdown()),
            ...[...https.values()].map((handler) => handler.close()),
          ])
          handles.clear()
          if (results.some((result) => result.status === "rejected")) throw new CcaExecutorError(-32603, "Internal error")
        })()
        return closing
      },
    }
  }

  const close = async (): Promise<void> => {
    closed = true
    notifyBySession.clear()
    callBySession.clear()
    const entries = [...processes.values()]
    for (const proc of entries) {
      proc.terminationRequested = true
      if (proc.child && !proc.exited) {
        killProcessGroup(proc.child, "SIGKILL")
      }
      clearEntryTimers(proc)
      for (const w of proc.waiters) w()
      proc.waiters.clear()
      if (!proc.child && proc.exited) finishEntry(proc)
    }
    await Promise.all(entries.map((proc) => proc.done))
    await Promise.all(entries.map((proc) => releaseNetwork(proc)))
    await shellSnapshots.close()
    await Promise.all(entries.map((proc) => settleEntryGrant(proc)))
    processes.clear()
    scopesReleased = true
    const opened = [...scopes.values()]
    scopes.clear()
    bindings.clear()
    const scopeResults = await Promise.allSettled(opened.map((pending) => pending.then((entry) => entry.scope.close(), () => undefined)))
    if (releaseFailureRecorded || entries.some((proc) => proc.releaseFailed) || scopeResults.some((result) => result.status === "rejected")) {
      throw new CcaExecutorError(-32603, "Internal error")
    }
  }

  return {
    initialize,
    startProcess,
    readProcess,
    writeProcess,
    signalProcess,
    terminateProcess,
    readFile,
    writeFile,
    getMetadata,
    readDirectory,
    canonicalize,
    createDirectory,
    openReadTree,
    openConnection,
    close,
  }
}