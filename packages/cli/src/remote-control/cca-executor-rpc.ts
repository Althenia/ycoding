import type { CcaCapabilityRootsDiscoverParams, CcaCapabilityRootsDiscoverResult } from "./cca-capability-discovery"
import type { CcaEnvironmentConfigReadParams, CcaEnvironmentConfigReadResult } from "./cca-environment-config"
import type { CcaRemoteNetworkProxyLaunchConfig } from "@ycoding-ai/core/cca/network-proxy"
import type { CcaShellSnapshotRequest } from "@ycoding-ai/core/cca/shell-snapshot"
import { decodeCcaProcessStartExtensions } from "./cca-executor-process-wire"

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

export interface CcaInitializeParams {
  readonly clientName: string
  readonly resumeSessionId?: string
}

export interface CcaInitializeResult {
  readonly sessionId: string
}

export interface CcaInitializeContext {
  readonly signal: AbortSignal
  readonly notify: (method: string, params: unknown) => Promise<void> | void
  readonly call: (method: string, params: unknown, options?: CcaRpcCallOptions) => Promise<unknown>
}

export interface CcaRpcHandlerContext {
  readonly signal: AbortSignal
  readonly sessionId: string
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

export interface CcaRpcHandler {
  readonly initialize: (
    params: CcaInitializeParams,
    ctx: CcaInitializeContext,
  ) => Promise<CcaInitializeResult>
  readonly resume?: (
    sessionId: string,
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
  readonly readEnvironmentConfig?: (
    params: CcaEnvironmentConfigReadParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaEnvironmentConfigReadResult>
  readonly discoverCapabilityRoots?: (
    params: CcaCapabilityRootsDiscoverParams,
    ctx: CcaRpcHandlerContext,
  ) => Promise<CcaCapabilityRootsDiscoverResult>
  readonly openRpcConnection?: () => CcaRpcConnection
}

export interface CreateCcaRpcSessionOptions {
  readonly environmentInfo: () => CcaEnvironmentInfo | Promise<CcaEnvironmentInfo>
  readonly handler: CcaRpcHandler
  readonly sendNotification?: (method: string, params: unknown) => Promise<void> | void
  readonly sendFrame?: (bytes: Uint8Array) => Promise<void>
  readonly signal?: AbortSignal
}

export interface CcaRpcCallOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface CcaRpcSession {
  readonly receive: (applicationBytes: Uint8Array) => Promise<readonly Uint8Array[]>
  readonly call: (method: string, params: unknown, options?: CcaRpcCallOptions) => Promise<unknown>
  readonly close: () => Promise<void>
}

export interface CcaRpcConnectionContext extends CcaRpcHandlerContext {
  readonly notify: (method: string, params: unknown) => Promise<void>
}

export interface CcaRpcReply {
  readonly result: unknown
  readonly afterSend?: () => void
  readonly unsent?: () => void
}

export type CcaRpcConnectionMethod = (params: unknown, ctx: CcaRpcConnectionContext) => Promise<CcaRpcReply>

export interface CcaRpcConnection {
  readonly methods: Readonly<Record<string, CcaRpcConnectionMethod>>
  readonly close: () => Promise<void>
}

export const ccaRpcCallTimeoutMs = 30_000

export const CCA_SESSION_ALREADY_ATTACHED_ERROR_CODE = -32010
export const ccaDetachedSessionTtlMs = 30_000

export class CcaRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = "CcaRpcError"
  }
}

const unknownSession = (sessionId: string) => new CcaRpcError(-32600, `unknown session id ${sessionId}`)

export interface CcaSessionResources {
  readonly handler: CcaRpcHandler
  readonly environmentInfo: () => CcaEnvironmentInfo | Promise<CcaEnvironmentInfo>
  readonly close: () => Promise<void>
}

export interface CcaSessionConnection {
  readonly handler: CcaRpcHandler
  readonly environmentInfo: () => CcaEnvironmentInfo | Promise<CcaEnvironmentInfo>
  readonly detach: () => void
}

export interface CcaSessionRegistry {
  readonly connect: (open: () => Promise<CcaSessionResources>) => CcaSessionConnection
  readonly shutdown: () => Promise<void>
}

export interface CcaSessionRegistryOptions {
  readonly ttlMs?: number
  readonly now?: () => number
}

type SessionEntry = {
  sessionId: string
  readonly resources: CcaSessionResources
  readonly controller: AbortController
  notify: CcaInitializeContext["notify"] | undefined
  call: CcaInitializeContext["call"] | undefined
  attachment: symbol | undefined
  detached: { readonly connection: symbol; readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> } | undefined
}

export function createCcaSessionRegistry(options: CcaSessionRegistryOptions = {}): CcaSessionRegistry {
  const ttlMs = options.ttlMs ?? ccaDetachedSessionTtlMs
  const now = options.now ?? Date.now
  const sessions = new Map<string, SessionEntry>()
  const closing = new Set<Promise<void>>()
  let shut = false

  const retire = (entry: SessionEntry): Promise<void> => {
    if (sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId)
    if (entry.detached !== undefined) clearTimeout(entry.detached.timer)
    entry.detached = undefined
    entry.attachment = undefined
    entry.notify = undefined
    entry.call = undefined
    entry.controller.abort()
    const closed = entry.resources.close()
    closing.add(closed)
    const settle = () => {
      closing.delete(closed)
    }
    void closed.then(settle, settle)
    return closed.catch(() => {})
  }

  const shutDown = () => new CcaRpcError(-32603, "Executor session registry is shut down")

  const connect = (open: () => Promise<CcaSessionResources>): CcaSessionConnection => {
    const connection = Symbol("connection")
    let entry: SessionEntry | undefined

    const attached = (): SessionEntry => {
      if (entry === undefined || entry.attachment !== connection) throw new CcaRpcError(-32600, "session is no longer attached to this connection")
      return entry
    }

    const initialize = async (params: CcaInitializeParams, ctx: CcaInitializeContext): Promise<CcaInitializeResult> => {
      if (shut) throw shutDown()
      const resources = await open()
      const created: SessionEntry = {
        sessionId: "",
        resources,
        controller: new AbortController(),
        notify: ctx.notify,
        call: ctx.call,
        attachment: connection,
        detached: undefined,
      }
      let result: CcaInitializeResult
      try {
        if (shut) throw shutDown()
        result = await resources.handler.initialize(
          { clientName: params.clientName },
          {
            signal: created.controller.signal,
            notify: (method, notification) => created.notify?.(method, notification),
            call: (method, callParams, callOptions) =>
              created.call === undefined ? Promise.reject(new Error("Connection closed")) : created.call(method, callParams, callOptions),
          },
        )
        if (shut) throw shutDown()
      } catch (error) {
        await retire(created)
        throw error
      }
      created.sessionId = result.sessionId
      sessions.set(result.sessionId, created)
      entry = created
      return { sessionId: result.sessionId }
    }

    const resume = async (sessionId: string, _params: CcaInitializeParams, ctx: CcaInitializeContext): Promise<CcaInitializeResult> => {
      if (shut) throw shutDown()
      const found = sessions.get(sessionId)
      if (found === undefined) throw unknownSession(sessionId)
      if (found.detached !== undefined && now() >= found.detached.expiresAt) {
        await retire(found)
        throw unknownSession(sessionId)
      }
      if (found.attachment !== undefined) {
        throw new CcaRpcError(CCA_SESSION_ALREADY_ATTACHED_ERROR_CODE, `session ${sessionId} is already attached to another connection`)
      }
      if (found.detached !== undefined) clearTimeout(found.detached.timer)
      found.detached = undefined
      found.attachment = connection
      found.notify = ctx.notify
      found.call = ctx.call
      entry = found
      return { sessionId }
    }

    const detach = () => {
      const current = entry
      if (current === undefined || current.attachment !== connection) return
      current.attachment = undefined
      current.notify = undefined
      current.call = undefined
      const timer = setTimeout(() => {
        if (current.detached?.connection === connection) void retire(current)
      }, ttlMs)
      timer.unref?.()
      current.detached = { connection, expiresAt: now() + ttlMs, timer }
    }

    const handler: CcaRpcHandler = {
      initialize,
      resume,
      startProcess: (params, ctx) => attached().resources.handler.startProcess(params, ctx),
      readProcess: (params, ctx) => attached().resources.handler.readProcess(params, ctx),
      writeProcess: (params, ctx) => attached().resources.handler.writeProcess(params, ctx),
      signalProcess: (params, ctx) => attached().resources.handler.signalProcess(params, ctx),
      terminateProcess: (params, ctx) => attached().resources.handler.terminateProcess(params, ctx),
      readFile: (params, ctx) => attached().resources.handler.readFile(params, ctx),
      writeFile: (params, ctx) => attached().resources.handler.writeFile(params, ctx),
      getMetadata: (params, ctx) => attached().resources.handler.getMetadata(params, ctx),
      readDirectory: (params, ctx) => attached().resources.handler.readDirectory(params, ctx),
      canonicalize: (params, ctx) => attached().resources.handler.canonicalize(params, ctx),
      readEnvironmentConfig: (params, ctx) => {
        const read = attached().resources.handler.readEnvironmentConfig
        if (read === undefined) throw new CcaRpcError(-32601, "Method not supported: environmentConfig/read")
        return read(params, ctx)
      },
      discoverCapabilityRoots: (params, ctx) => {
        const discover = attached().resources.handler.discoverCapabilityRoots
        if (discover === undefined) throw new CcaRpcError(-32601, "Method not supported: capabilityRoots/discoverV1")
        return discover(params, ctx)
      },
      openRpcConnection: () => {
        const open = attached().resources.handler.openRpcConnection
        return open === undefined ? { methods: {}, close: async () => {} } : open()
      },
    }

    return { handler, environmentInfo: () => attached().resources.environmentInfo(), detach }
  }

  const shutdown = async () => {
    shut = true
    for (const entry of [...sessions.values()]) void retire(entry)
    while (closing.size > 0) await Promise.allSettled([...closing])
  }

  return { connect, shutdown }
}

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_JSON_NODES = 262144
const MAX_JSON_DEPTH = 128
const MAX_BASE64_DECODED_BYTES = 16 * 1024 * 1024

type RequestId = string | number

interface WireError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

function checkJsonComplexity(value: unknown, maxNodes = MAX_JSON_NODES, maxDepth = MAX_JSON_DEPTH): boolean {
  let nodes = 0
  const stack: { val: unknown; depth: number }[] = [{ val: value, depth: 1 }]
  while (stack.length > 0) {
    const item = stack.pop()!
    nodes++
    if (nodes > maxNodes) return false
    if (item.depth > maxDepth) return false
    if (item.val && typeof item.val === "object") {
      if (Array.isArray(item.val)) {
        for (let i = item.val.length - 1; i >= 0; i--) {
          stack.push({ val: item.val[i], depth: item.depth + 1 })
        }
      } else {
        for (const key of Object.keys(item.val)) {
          stack.push({ val: (item.val as Record<string, unknown>)[key], depth: item.depth + 1 })
        }
      }
    }
  }
  return true
}

function isValidFileUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 4096) return false
  try {
    const url = new URL(uri)
    return url.protocol === "file:"
  } catch {
    return false
  }
}

function isValidBase64(str: unknown, maxDecodedBytes = MAX_BASE64_DECODED_BYTES): str is string {
  if (typeof str !== "string") return false
  if (str.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str)) return false
  let padding = 0
  if (str.endsWith("==")) padding = 2
  else if (str.endsWith("=")) padding = 1
  const decodedLen = (str.length / 4) * 3 - padding
  return decodedLen <= maxDecodedBytes
}

function methodFamily(method: string): string {
  if (method.startsWith("process/")) return "exec"
  if (method.startsWith("fs/")) return "filesystem"
  if (method === "environment/info") return "environment info"
  if (method === "environment/status") return "environment status"
  if (method === "environmentConfig/read") return "environment config"
  if (method === "capabilityRoots/discoverV1") return "capability discovery"
  const prefix = method.split("/")[0]
  return prefix && prefix.length > 0 ? prefix : method
}

const FIXED_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  [-32600]: "Invalid Request",
  [-32601]: "Method not found",
  [-32602]: "Invalid params",
  [-32603]: "Internal error",
  [-32001]: "Permission denied",
  [-32004]: "Not found",
  [CCA_SESSION_ALREADY_ATTACHED_ERROR_CODE]: "Session already attached",
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "environment/info",
  "environment/status",
  "process/start",
  "process/read",
  "process/write",
  "process/signal",
  "process/terminate",
  "fs/readFile",
  "fs/writeFile",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/canonicalize",
  "environmentConfig/read",
  "capabilityRoots/discoverV1",
  "capabilities/discoverV2",
  "fs/createDirectory",
  "fs/open",
  "fs/readBlock",
  "fs/writeBlock",
  "fs/close",
  "fs/walk",
  "fs/remove",
  "fs/copy",
  "http/request",
])

function serdeUnexpected(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return `boolean \`${value}\``
  if (typeof value === "number") return "number"
  if (typeof value === "string") return `string ${JSON.stringify(value)}`
  if (Array.isArray(value)) return "sequence"
  return "map"
}

class ParamsError extends Error {}

function expectStruct(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ParamsError(`invalid type: ${serdeUnexpected(value)}, expected struct ${name}`)
  return value as Record<string, unknown>
}

function expectString(value: unknown): string {
  if (typeof value !== "string") throw new ParamsError(`invalid type: ${serdeUnexpected(value)}, expected a string`)
  return value
}

function expectPathUri(value: unknown): string {
  const text = expectString(value)
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)
  if (!scheme) throw new ParamsError("invalid URI: relative URL without a base")
  if (scheme[1]!.toLowerCase() !== "file") throw new ParamsError(`unsupported path URI scheme \`${scheme[1]}\``)
  return text
}

function expectTomlPaths(value: unknown): string[][] {
  if (!Array.isArray(value)) throw new ParamsError(`invalid type: ${serdeUnexpected(value)}, expected a sequence`)
  return value.map((item) => {
    if (!Array.isArray(item)) throw new ParamsError(`invalid type: ${serdeUnexpected(item)}, expected a sequence`)
    return item.map(expectString)
  })
}

function requireFields(record: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) if (!(field in record)) throw new ParamsError(`missing field \`${field}\``)
}

function decodeEnvironmentConfigRead(params: unknown): CcaEnvironmentConfigReadParams {
  const record = expectStruct(params, "EnvironmentConfigReadParams")
  const decoded: { cwd?: string; configPaths?: string[][]; requirementsPaths?: string[][] } = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === "cwd") decoded.cwd = expectPathUri(value)
    else if (key === "configPaths") decoded.configPaths = expectTomlPaths(value)
    else if (key === "requirementsPaths") decoded.requirementsPaths = expectTomlPaths(value)
  }
  requireFields(record, ["cwd", "configPaths", "requirementsPaths"])
  return { cwd: decoded.cwd!, configPaths: decoded.configPaths!, requirementsPaths: decoded.requirementsPaths! }
}

function decodeCapabilityRootsDiscover(params: unknown): CcaCapabilityRootsDiscoverParams {
  const record = expectStruct(params, "WireCapabilityRootsDiscoverParams")
  requireFields(record, ["roots"])
  if (!Array.isArray(record.roots)) throw new ParamsError(`invalid type: ${serdeUnexpected(record.roots)}, expected a sequence`)
  return {
    roots: record.roots.map((root) => {
      const entry = expectStruct(root, "WireCapabilityRootDiscoverRequest")
      const decoded: { id?: string; path?: string; sandbox?: unknown } = {}
      for (const [key, value] of Object.entries(entry)) {
        if (key === "id") decoded.id = expectString(value)
        else if (key === "path") decoded.path = expectPathUri(value)
        else if (key === "sandbox" && value !== null && value !== undefined) decoded.sandbox = expectStruct(value, "WireFileSystemSandboxContext")
      }
      requireFields(entry, ["id", "path"])
      return { id: decoded.id!, path: decoded.path!, ...(decoded.sandbox === undefined ? {} : { sandbox: decoded.sandbox }) }
    }),
  }
}

const CONNECTION_METHODS: ReadonlySet<string> = new Set([
  "capabilities/discoverV2",
  "fs/createDirectory",
  "fs/open",
  "fs/readBlock",
  "fs/writeBlock",
  "fs/close",
  "fs/walk",
  "fs/remove",
  "fs/copy",
  "http/request",
])

const CONTROL_METHODS: ReadonlySet<string> = new Set([
  "process/signal",
  "process/terminate",
  "environment/info",
  "environment/status",
])

function isInvalidOptionalBoolean(value: unknown): boolean {
  return value !== undefined && typeof value !== "boolean"
}


function makeErrorResponse(id: RequestId, code: number, message: string): Uint8Array {
  const payload = {
    id,
    error: {
      code,
      message,
    },
  }
  return new TextEncoder().encode(JSON.stringify(payload))
}

function makeSuccessResponse(id: RequestId, result: unknown): Uint8Array {
  const payload = {
    id,
    result: result === undefined ? null : result,
  }
  return new TextEncoder().encode(JSON.stringify(payload))
}

export function createCcaRpcSession(options: CreateCcaRpcSessionOptions): CcaRpcSession {
  const { environmentInfo, handler, sendNotification, sendFrame, signal: externalSignal } = options

  const sessionController = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) {
      sessionController.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener("abort", () => sessionController.abort(externalSignal.reason), { once: true })
    }
  }

  let closed = false
  let initializeRequested = false
  let initialized = false
  let sessionId: string | null = null

  let queue: Promise<void> = Promise.resolve()
  let controlQueue: Promise<void> = Promise.resolve()
  let connection: CcaRpcConnection | undefined
  const pendingCalls = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly cleanup: () => void }>()
  let nextCallId = 1

  const notifyHandler = async (method: string, params: unknown) => {
    if (sendNotification) {
      await sendNotification(method, params)
    }
  }

  const dispatchOne = async (applicationBytes: Uint8Array): Promise<readonly Uint8Array[]> => {
    if (closed || sessionController.signal.aborted) {
      return [makeErrorResponse(-1, -32603, "Connection closed")]
    }

    if (applicationBytes.byteLength > MAX_MESSAGE_BYTES) {
      return [makeErrorResponse(-1, -32600, "Message exceeds size limit")]
    }

    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(applicationBytes)
    } catch {
      return [makeErrorResponse(-1, -32600, "Invalid UTF-8 framing")]
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return [makeErrorResponse(-1, -32600, "Invalid JSON framing")]
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [makeErrorResponse(-1, -32600, "expected a JSON-RPC object")]
    }

    if (!checkJsonComplexity(parsed)) {
      const maybeId = (parsed as Record<string, unknown>).id
      const reqId: RequestId =
        (typeof maybeId === "string" && maybeId.length <= 256) || Number.isSafeInteger(maybeId)
          ? (maybeId as RequestId)
          : -1
      return [makeErrorResponse(reqId, -32600, "JSON-RPC message exceeds complexity limit")]
    }

    const msg = parsed as Record<string, unknown>
    const id = msg.id
    const isNotification = id === undefined

    if (!isNotification && !((typeof id === "string" && id.length <= 256) || (typeof id === "number" && Number.isSafeInteger(id)))) {
      return [makeErrorResponse(-1, -32600, "Invalid request ID")]
    }

    const reqId: RequestId =
      typeof id === "string" ? id : typeof id === "number" && Number.isSafeInteger(id) ? id : -1

    if (typeof msg.method !== "string" || msg.method.length === 0 || msg.method.length > 256) {
      if (isNotification) return []
      return [makeErrorResponse(reqId, -32600, "Invalid method name")]
    }

    const method = msg.method
    const params = msg.params

    if (isNotification) {
      if (method === "initialized") {
        if (initializeRequested) {
          initialized = true
        }
      }
      return []
    }

    if (!SUPPORTED_METHODS.has(method)) {
      return [makeErrorResponse(reqId, -32601, `Method not supported: ${method.slice(0, 64)}`)]
    }

    if (method === "initialize") {
      if (initializeRequested) {
        return [makeErrorResponse(reqId, -32600, "initialize may only be sent once per connection")]
      }
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
      }
      const initP = params as Record<string, unknown>
      if (typeof initP.clientName !== "string" || initP.clientName.length === 0 || initP.clientName.length > 256) {
        return [makeErrorResponse(reqId, -32602, "Invalid params: clientName is required")]
      }
      const resumeSessionId = initP.resumeSessionId
      if (resumeSessionId !== undefined && resumeSessionId !== null && typeof resumeSessionId !== "string") {
        return [makeErrorResponse(reqId, -32602, "Invalid params: invalid resumeSessionId")]
      }

      try {
        const initParams: CcaInitializeParams = { clientName: initP.clientName }
        const initCtx: CcaInitializeContext = { signal: sessionController.signal, notify: notifyHandler, call }
        let initResult: CcaInitializeResult
        if (typeof resumeSessionId === "string") {
          if (!handler.resume) throw unknownSession(resumeSessionId)
          initResult = await handler.resume(resumeSessionId, initParams, initCtx)
        } else {
          initResult = await handler.initialize(initParams, initCtx)
        }
        sessionId = initResult.sessionId
        initializeRequested = true
        connection = handler.openRpcConnection?.()
        const envInfo = await environmentInfo()
        return [makeSuccessResponse(reqId, { sessionId, environmentInfo: envInfo })]
      } catch (err: unknown) {
        return [mapHandlerError(reqId, err)]
      }
    }

    const family = methodFamily(method)
    if (!initializeRequested) {
      return [makeErrorResponse(reqId, -32600, `client must call initialize before using ${family} methods`)]
    }
    if (!initialized) {
      return [makeErrorResponse(reqId, -32600, `client must send initialized before using ${family} methods`)]
    }

    const handlerCtx: CcaRpcHandlerContext = {
      signal: sessionController.signal,
      sessionId: sessionId!,
    }

    const connectionMethod = connection?.methods[method]
    if (CONNECTION_METHODS.has(method)) {
      if (connectionMethod === undefined) return [makeErrorResponse(reqId, -32601, `Method not supported: ${method.slice(0, 64)}`)]
      let reply: CcaRpcReply
      try {
        reply = await connectionMethod(params, { ...handlerCtx, notify: notifyHandler })
      } catch (err: unknown) {
        return [mapHandlerError(reqId, err)]
      }
      const frame = makeSuccessResponse(reqId, reply.result)
      if (reply.afterSend === undefined) return [frame]
      if (sendFrame === undefined || closed) {
        reply.unsent?.()
        return [makeErrorResponse(reqId, -32603, "Internal error")]
      }
      try {
        await sendFrame(frame)
      } catch {
        reply.unsent?.()
        return []
      }
      reply.afterSend()
      return []
    }

    try {
      switch (method) {
        case "environment/info": {
          const info = await environmentInfo()
          return [makeSuccessResponse(reqId, info)]
        }
        case "environment/status": {
          return [makeSuccessResponse(reqId, { status: "ready" })]
        }
        case "process/start": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (typeof p.processId !== "string" || p.processId.length === 0 || p.processId.length > 256) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid processId")]
          }
          if (
            !Array.isArray(p.argv) ||
            p.argv.length === 0 ||
            p.argv.length > 1024 ||
            p.argv.some((arg) => typeof arg !== "string" || arg.length > 65536)
          ) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: argv must be non-empty string array")]
          }
          if (!isValidFileUri(p.cwd)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: cwd must be a valid file:// URI")]
          }
          if (!p.env || typeof p.env !== "object" || Array.isArray(p.env)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: env must be an object")]
          }
          const envEntries = Object.entries(p.env)
          if (envEntries.length > 4096 || envEntries.some(([k, v]) => typeof k !== "string" || typeof v !== "string")) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid env key/value")]
          }
          if (p.arg0 != null && typeof p.arg0 !== "string") {
            return [makeErrorResponse(reqId, -32602, "Invalid params: arg0 must be a string")]
          }
          for (const field of ["metadata", "envPolicy", "shellSnapshot", "sandbox", "managedNetwork", "networkProxy"]) {
            if (p[field] != null && (typeof p[field] !== "object" || Array.isArray(p[field]))) {
              return [makeErrorResponse(reqId, -32602, `Invalid params: ${field} must be an object`)]
            }
          }
          const metadata = p.metadata as Record<string, unknown> | null | undefined
          if (metadata != null) {
            if (metadata.threadId != null && (
              typeof metadata.threadId !== "string" ||
              !/^(?:[\da-fA-F]{32}|[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}|\{[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}\}|urn:uuid:[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12})$/.test(metadata.threadId)
            )) {
              return [makeErrorResponse(reqId, -32602, "Invalid params: invalid metadata.threadId")]
            }
            if (metadata.toolCallId != null && typeof metadata.toolCallId !== "string") {
              return [makeErrorResponse(reqId, -32602, "Invalid params: metadata.toolCallId must be a string")]
            }
          }
          const envPolicy = p.envPolicy as Record<string, unknown> | null | undefined
          if (envPolicy != null && (
            !["none", "core", "all"].includes(envPolicy.inherit as string) ||
            typeof envPolicy.ignoreDefaultExcludes !== "boolean" ||
            !Array.isArray(envPolicy.exclude) || envPolicy.exclude.some((value) => typeof value !== "string") ||
            !Array.isArray(envPolicy.includeOnly) || envPolicy.includeOnly.some((value) => typeof value !== "string") ||
            !envPolicy.set || typeof envPolicy.set !== "object" || Array.isArray(envPolicy.set) ||
            Object.values(envPolicy.set).some((value) => typeof value !== "string")
          )) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid envPolicy")]
          }
          if (isInvalidOptionalBoolean(p.tty)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: tty must be a boolean")]
          }
          if (isInvalidOptionalBoolean(p.pipeStdin)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: pipeStdin must be a boolean")]
          }
          if (isInvalidOptionalBoolean(p.enforceManagedNetwork)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: enforceManagedNetwork must be a boolean")]
          }
          const extensions = decodeCcaProcessStartExtensions({ processId: p.processId, networkProxy: p.networkProxy, shellSnapshot: p.shellSnapshot })

          const execParams: CcaExecParams = {
            processId: p.processId,
            argv: p.argv as string[],
            cwd: p.cwd,
            env: p.env as Record<string, string>,
            tty: (p.tty as boolean | undefined) ?? false,
            pipeStdin: (p.pipeStdin as boolean | undefined) ?? false,
            ...(typeof p.arg0 === "string" ? { arg0: p.arg0 } : {}),
            ...(metadata != null ? { metadata: {
              ...(typeof metadata.threadId === "string" ? { threadId: metadata.threadId } : {}),
              ...(typeof metadata.toolCallId === "string" ? { toolCallId: metadata.toolCallId } : {}),
            } } : {}),
            ...(envPolicy != null ? { envPolicy } : {}),
            ...(extensions.shellSnapshot === undefined ? {} : { shellSnapshot: extensions.shellSnapshot }),
            ...(p.sandbox != null ? { sandbox: p.sandbox } : {}),
            ...(p.enforceManagedNetwork !== undefined ? { enforceManagedNetwork: p.enforceManagedNetwork as boolean } : {}),
            ...(p.managedNetwork != null ? { managedNetwork: p.managedNetwork } : {}),
            ...(extensions.networkProxy === undefined ? {} : { networkProxy: extensions.networkProxy }),
          }

          const res = await handler.startProcess(execParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "process/read": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (typeof p.processId !== "string" || p.processId.length === 0 || p.processId.length > 256) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid processId")]
          }
          if (p.afterSeq != null && (!Number.isSafeInteger(p.afterSeq) || (p.afterSeq as number) < 0)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid afterSeq")]
          }
          if (p.maxBytes != null && (!Number.isSafeInteger(p.maxBytes) || (p.maxBytes as number) < 0 || (p.maxBytes as number) > 100 * 1024 * 1024)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid maxBytes")]
          }
          if (p.waitMs != null && (!Number.isSafeInteger(p.waitMs) || (p.waitMs as number) < 0 || (p.waitMs as number) > 120000)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid waitMs")]
          }

          const readParams: CcaReadParams = {
            processId: p.processId,
            ...(p.afterSeq != null ? { afterSeq: p.afterSeq as number } : {}),
            ...(p.maxBytes != null ? { maxBytes: p.maxBytes as number } : {}),
            ...(p.waitMs != null ? { waitMs: p.waitMs as number } : {}),
          }

          const res = await handler.readProcess(readParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "process/write": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (typeof p.processId !== "string" || p.processId.length === 0 || p.processId.length > 256) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid processId")]
          }
          if (typeof p.writeId !== "string" || p.writeId.length === 0 || p.writeId.length > 256) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: writeId must be non-empty")]
          }
          if (!isValidBase64(p.chunk)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: chunk must be valid standard base64")]
          }

          const writeParams: CcaWriteParams = {
            processId: p.processId,
            chunk: p.chunk,
            writeId: p.writeId,
          }

          const res = await handler.writeProcess(writeParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "process/signal": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (typeof p.processId !== "string" || p.processId.length === 0 || p.processId.length > 256) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid processId")]
          }
          if (p.signal !== "interrupt") {
            return [makeErrorResponse(reqId, -32602, "Invalid params: signal must be 'interrupt'")]
          }

          const sigParams: CcaSignalParams = {
            processId: p.processId,
            signal: "interrupt",
          }

          const res = await handler.signalProcess(sigParams, handlerCtx)
          return [makeSuccessResponse(reqId, res ?? {})]
        }
        case "process/terminate": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (typeof p.processId !== "string" || p.processId.length === 0 || p.processId.length > 256) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: invalid processId")]
          }

          const termParams: CcaTerminateParams = {
            processId: p.processId,
          }

          const res = await handler.terminateProcess(termParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "fs/readFile": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (!isValidFileUri(p.path)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: path must be a valid file:// URI")]
          }

          if (p.followSymlinks != null && typeof p.followSymlinks !== "boolean") {
            return [makeErrorResponse(reqId, -32602, "Invalid params: followSymlinks must be a boolean")]
          }
          if (p.sandbox != null && (typeof p.sandbox !== "object" || Array.isArray(p.sandbox))) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: sandbox must be an object")]
          }

          const fsParams: CcaFsReadFileParams = {
            path: p.path,
            ...(p.followSymlinks != null ? { followSymlinks: p.followSymlinks as boolean } : {}),
            ...(p.sandbox != null ? { sandbox: p.sandbox } : {}),
          }

          const res = await handler.readFile(fsParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "fs/writeFile": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (!isValidFileUri(p.path)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: path must be a valid file:// URI")]
          }
          if (!isValidBase64(p.dataBase64)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: dataBase64 must be valid standard base64")]
          }

          if (p.followSymlinks != null && typeof p.followSymlinks !== "boolean") {
            return [makeErrorResponse(reqId, -32602, "Invalid params: followSymlinks must be a boolean")]
          }
          if (p.sandbox != null && (typeof p.sandbox !== "object" || Array.isArray(p.sandbox))) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: sandbox must be an object")]
          }

          const fsParams: CcaFsWriteFileParams = {
            path: p.path,
            dataBase64: p.dataBase64,
            ...(p.followSymlinks != null ? { followSymlinks: p.followSymlinks as boolean } : {}),
            ...(p.sandbox != null ? { sandbox: p.sandbox } : {}),
          }

          const res = await handler.writeFile(fsParams, handlerCtx)
          return [makeSuccessResponse(reqId, res ?? {})]
        }
        case "fs/getMetadata": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (!isValidFileUri(p.path)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: path must be a valid file:// URI")]
          }

          if (p.followSymlinks != null && typeof p.followSymlinks !== "boolean") {
            return [makeErrorResponse(reqId, -32602, "Invalid params: followSymlinks must be a boolean")]
          }
          if (p.sandbox != null && (typeof p.sandbox !== "object" || Array.isArray(p.sandbox))) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: sandbox must be an object")]
          }

          const fsParams: CcaFsGetMetadataParams = {
            path: p.path,
            ...(p.followSymlinks != null ? { followSymlinks: p.followSymlinks as boolean } : {}),
            ...(p.sandbox != null ? { sandbox: p.sandbox } : {}),
          }

          const res = await handler.getMetadata(fsParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "fs/readDirectory": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (!isValidFileUri(p.path)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: path must be a valid file:// URI")]
          }
          if (p.sandbox != null && (typeof p.sandbox !== "object" || Array.isArray(p.sandbox))) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: sandbox must be an object")]
          }

          const fsParams: CcaFsReadDirectoryParams = {
            path: p.path,
            ...(p.sandbox != null ? { sandbox: p.sandbox } : {}),
          }

          const res = await handler.readDirectory(fsParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "environmentConfig/read": {
          if (!handler.readEnvironmentConfig) {
            return [makeErrorResponse(reqId, -32601, `Method not supported: ${method}`)]
          }
          let decoded: CcaEnvironmentConfigReadParams
          try {
            decoded = decodeEnvironmentConfigRead(params)
          } catch (err) {
            if (err instanceof ParamsError) return [makeErrorResponse(reqId, -32602, err.message)]
            throw err
          }
          const res = await handler.readEnvironmentConfig(decoded, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "capabilityRoots/discoverV1": {
          if (!handler.discoverCapabilityRoots) {
            return [makeErrorResponse(reqId, -32601, `Method not supported: ${method}`)]
          }
          let decoded: CcaCapabilityRootsDiscoverParams
          try {
            decoded = decodeCapabilityRootsDiscover(params)
          } catch (err) {
            if (err instanceof ParamsError) return [makeErrorResponse(reqId, -32602, err.message)]
            throw err
          }
          const res = await handler.discoverCapabilityRoots(decoded, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        case "fs/canonicalize": {
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: object expected")]
          }
          const p = params as Record<string, unknown>
          if (!isValidFileUri(p.path)) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: path must be a valid file:// URI")]
          }
          if (p.sandbox != null && (typeof p.sandbox !== "object" || Array.isArray(p.sandbox))) {
            return [makeErrorResponse(reqId, -32602, "Invalid params: sandbox must be an object")]
          }

          const fsParams: CcaFsCanonicalizeParams = {
            path: p.path,
            ...(p.sandbox != null ? { sandbox: p.sandbox } : {}),
          }

          const res = await handler.canonicalize(fsParams, handlerCtx)
          return [makeSuccessResponse(reqId, res)]
        }
        default: {
          return [makeErrorResponse(reqId, -32601, `Method not supported: ${method.slice(0, 64)}`)]
        }
      }
    } catch (err: unknown) {
      return [mapHandlerError(reqId, err)]
    }
  }

  function mapHandlerError(id: RequestId, err: unknown): Uint8Array {
    if (err instanceof CcaRpcError) return makeErrorResponse(id, err.code, err.message)
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>
      if (typeof e.code === "number" && Number.isSafeInteger(e.code) && FIXED_ERROR_MESSAGES[e.code] !== undefined) {
        const message = typeof e.message === "string" && e.message.length > 0 ? e.message : FIXED_ERROR_MESSAGES[e.code]!
        return makeErrorResponse(id, e.code, message)
      }
    }
    return makeErrorResponse(id, -32603, "Internal error")
  }

  const takePending = (id: number) => {
    const pending = pendingCalls.get(id)
    if (pending === undefined) return undefined
    pendingCalls.delete(id)
    pending.cleanup()
    return pending
  }

  const settleCall = (applicationBytes: Uint8Array): boolean => {
    if (nextCallId === 1 || applicationBytes.byteLength > MAX_MESSAGE_BYTES) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(applicationBytes))
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const message = parsed as Record<string, unknown>
    if (message.method !== undefined || typeof message.id !== "number") return false
    if (!("result" in message) && !("error" in message)) return false
    const pending = takePending(message.id)
    if (pending === undefined) return true
    const error = message.error
    if (error !== undefined && error !== null) {
      const record = typeof error === "object" ? (error as Record<string, unknown>) : {}
      pending.reject(new CcaRpcError(typeof record.code === "number" ? record.code : -32603, typeof record.message === "string" ? record.message : "Internal error"))
    } else pending.resolve(message.result)
    return true
  }

  const call = (method: string, params: unknown, callOptions: CcaRpcCallOptions = {}): Promise<unknown> => {
    if (closed || sessionController.signal.aborted || sendFrame === undefined) return Promise.reject(new Error("Connection closed"))
    if (callOptions.signal?.aborted) return Promise.reject(new Error(`executor request ${method} was cancelled`))
    const id = nextCallId++
    return new Promise<unknown>((resolve, reject) => {
      const fail = (message: string) => takePending(id)?.reject(new Error(message))
      const timer = setTimeout(() => fail(`executor request ${method} timed out`), callOptions.timeoutMs ?? ccaRpcCallTimeoutMs)
      timer.unref?.()
      const onAbort = () => fail(`executor request ${method} was cancelled`)
      callOptions.signal?.addEventListener("abort", onAbort, { once: true })
      pendingCalls.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          callOptions.signal?.removeEventListener("abort", onAbort)
        },
      })
      sendFrame(new TextEncoder().encode(JSON.stringify({ id, method, params }))).catch(() => fail("Connection closed"))
    })
  }

  const isControlRequest = (applicationBytes: Uint8Array): boolean => {
    if (!initializeRequested || !initialized) return false
    if (applicationBytes.byteLength > MAX_MESSAGE_BYTES) return false
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(applicationBytes)
    } catch {
      return false
    }
    let mentionsControl = false
    for (const controlMethod of CONTROL_METHODS) {
      if (text.includes(controlMethod)) {
        mentionsControl = true
        break
      }
    }
    if (!mentionsControl) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const msg = parsed as Record<string, unknown>
    if (msg.id === undefined) return false
    if (!((typeof msg.id === "string" && msg.id.length <= 256) || Number.isSafeInteger(msg.id))) return false
    return typeof msg.method === "string" && CONTROL_METHODS.has(msg.method)
  }

  const receive = (applicationBytes: Uint8Array): Promise<readonly Uint8Array[]> => {
    if (settleCall(applicationBytes)) return Promise.resolve([])
    if (isControlRequest(applicationBytes)) {
      const next = controlQueue.then(() => dispatchOne(applicationBytes))
      controlQueue = next.then(
        () => {},
        () => {},
      )
      return next
    }
    const next = queue.then(() => dispatchOne(applicationBytes))
    queue = next.then(
      () => {},
      () => {},
    )
    return next
  }

  const close = async (): Promise<void> => {
    closed = true
    sessionController.abort()
    for (const id of [...pendingCalls.keys()]) takePending(id)?.reject(new Error("Connection closed"))
    await Promise.all([queue, controlQueue])
    const current = connection
    connection = undefined
    await current?.close().catch(() => {})
  }

  return {
    receive,
    call,
    close,
  }
}
