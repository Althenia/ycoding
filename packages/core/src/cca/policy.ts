export * as CcaPolicy from "./policy"

import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

export type ErrorCode = "invalid_path" | "outside_roots" | "invalid_sandbox" | "invalid_env" | "invalid_argv"

export class PolicyError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message.slice(0, 256))
    this.name = "CcaPolicy.PolicyError"
    this.code = code
  }
}

export const MAX_PATH_LENGTH = 4096
export const MAX_ENV_ENTRIES = 256
export const MAX_ENV_BYTES = 65_536
export const MAX_ARGV = 512
export const MAX_ARG_BYTES = 32_768
export const DEFAULT_SECRET_ENV_KEYS: RegExp =
  /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL/i

const CONTROL = /[\x00-\x1f\x7f]/
const DRIVE_PATH = /^\/([A-Za-z]):(?:\/(.*))?$/
const DRIVE_NATIVE = /^([A-Za-z]):(?:[\\/](.*))?$/

const STRERROR: Readonly<Record<string, string>> = {
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  EIO: "Input/output error",
  EBADF: "Bad file descriptor",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EINVAL: "Invalid argument",
  ENFILE: "Too many open files in system",
  EMFILE: "Too many open files",
  ETXTBSY: "Text file busy",
  EFBIG: "File too large",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  EMLINK: "Too many links",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
  ENOTEMPTY: "Directory not empty",
  EAGAIN: "Resource temporarily unavailable",
  ENOTSUP: "Operation not supported",
  EOPNOTSUPP: "Operation not supported",
  ...(process.platform === "darwin"
    ? { ENXIO: "Device not configured", EBUSY: "Resource busy", EXDEV: "Cross-device link", EDQUOT: "Disc quota exceeded" }
    : { ENXIO: "No such device or address", EBUSY: "Device or resource busy", EXDEV: "Invalid cross-device link", EDQUOT: "Disk quota exceeded" }),
}

export function osErrorMessage(errno: string, number: number, message?: unknown): string {
  const known = STRERROR[errno]
  const raw = typeof message === "string" ? message.replace(new RegExp(`^${errno}: `), "").split(", ")[0] : errno
  const text = known ?? (raw.length === 0 ? errno : raw[0].toUpperCase() + raw.slice(1))
  return `${text} (os error ${number})`
}

function osErrorText(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = Reflect.get(error, "code")
  const errno = Reflect.get(error, "errno")
  if (typeof code !== "string" || typeof errno !== "number") return undefined
  return osErrorMessage(code, Math.abs(errno), Reflect.get(error, "message"))
}

function outsideRoots(): PolicyError {
  return new PolicyError("outside_roots", "path is outside the allowed roots")
}

function insideRoots(resolved: string, canonicalRoots: readonly string[]): boolean {
  return canonicalRoots.some((root) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
}

async function failureInsideRoots(
  failed: string,
  resolve: (candidate: string) => Promise<string>,
  canonicalRoots: readonly string[],
): Promise<boolean> {
  let child = failed
  for (let ancestor = path.dirname(failed); ; child = ancestor, ancestor = path.dirname(ancestor)) {
    const real = await resolve(ancestor).catch(() => undefined)
    if (real !== undefined) {
      if (!insideRoots(real, canonicalRoots)) return false
      return !(await lstat(child).then((stats) => stats.isSymbolicLink(), () => false))
    }
    if (path.dirname(ancestor) === ancestor) return false
  }
}

async function canonicalizeFailure(
  failed: string,
  error: unknown,
  resolve: (candidate: string) => Promise<string>,
  canonicalRoots: readonly string[],
): Promise<PolicyError> {
  if (!(await failureInsideRoots(failed, resolve, canonicalRoots))) return outsideRoots()
  return invalidPath(osErrorText(error) ?? "path cannot be canonicalized")
}

function invalidPath(message: string): PolicyError {
  return new PolicyError("invalid_path", message)
}

function checkPathText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || CONTROL.test(value)) {
    throw invalidPath("path must be a bounded non-empty string without control characters")
  }
}

function decodeSegment(segment: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw invalidPath("path URI contains invalid percent-encoding")
  }
  if (CONTROL.test(decoded) || decoded.includes("/") || decoded.includes("\\")) {
    throw invalidPath("path URI segment contains a forbidden character")
  }
  if (decoded === "." || decoded === "..") {
    throw invalidPath("path URI must not contain dot segments")
  }
  return decoded
}

function checkPlainSegment(segment: string): void {
  if (segment === "." || segment === "..") {
    throw invalidPath("path must not contain dot segments")
  }
}

export function parsePathUri(uri: string): string {
  checkPathText(uri)
  if (!/^file:\/\//i.test(uri) || uri.includes("?") || uri.includes("#") || uri.includes("\\")) {
    throw invalidPath("path must be a file:// URI without query, fragment, or backslashes")
  }
  const rest = uri.slice("file://".length)
  const slash = rest.indexOf("/")
  if (slash === -1) {
    throw invalidPath("file:// URI must contain an absolute path")
  }
  const authority = rest.slice(0, slash).toLowerCase()
  if (authority !== "" && authority !== "localhost") {
    throw invalidPath("file:// URI authority must be empty or localhost")
  }
  const rawPath = rest.slice(slash)
  const segments = rawPath.split("/")
  for (let index = 1; index < segments.length - 1; index++) {
    if (segments[index] === "") {
      throw invalidPath("path URI must not contain empty segments")
    }
  }
  const decoded = segments.map((segment) => (segment === "" ? "" : decodeSegment(segment))).join("/")
  const drive = DRIVE_PATH.exec(decoded)
  if (drive) {
    return `${drive[1]}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`
  }
  return decoded
}

export function toPathUri(absPath: string): string {
  checkPathText(absPath)
  const drive = DRIVE_NATIVE.exec(absPath)
  if (drive) {
    const tail = (drive[2] ?? "").replaceAll("\\", "/")
    const segments = tail === "" ? [] : tail.split("/")
    for (const segment of segments) {
      if (segment === "") throw invalidPath("path must not contain empty segments")
      checkPlainSegment(segment)
    }
    return `file:///${drive[1]}:${segments.length === 0 ? "/" : `/${segments.map(encodeURIComponent).join("/")}`}`
  }
  if (!absPath.startsWith("/") || absPath.includes("\\")) {
    throw invalidPath("path must be absolute without backslashes")
  }
  if (absPath === "/") {
    return "file:///"
  }
  const segments = absPath.split("/").slice(1)
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index] === "") throw invalidPath("path must not contain empty segments")
    checkPlainSegment(segments[index]!)
  }
  const last = segments[segments.length - 1]!
  if (last !== "") checkPlainSegment(last)
  return `file:///${segments.map((segment) => (segment === "" ? "" : encodeURIComponent(segment))).join("/")}`
}

export interface ResolveContainedOptions {
  readonly allowMissingFinal?: boolean
  readonly realpath?: (candidate: string) => Promise<string>
}

function checkAbsolute(candidate: string): void {
  checkPathText(candidate)
  if (!candidate.startsWith("/") && !DRIVE_NATIVE.test(candidate)) {
    throw invalidPath("path must be absolute")
  }
  for (const segment of candidate.split(/[\\/]/)) {
    checkPlainSegment(segment)
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

async function canonicalize(
  candidate: string,
  resolve: (candidate: string) => Promise<string>,
  allowMissingFinal: boolean,
  canonicalRoots: readonly string[],
): Promise<string> {
  try {
    return await resolve(candidate)
  } catch (error) {
    if (!isMissing(error)) {
      throw await canonicalizeFailure(candidate, error, resolve, canonicalRoots)
    }
    if (!allowMissingFinal) {
      throw invalidPath("path does not exist")
    }
  }
  const missing: string[] = []
  let ancestor = candidate
  for (;;) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) {
      throw invalidPath("path has no existing ancestor")
    }
    missing.unshift(path.basename(ancestor))
    ancestor = parent
    try {
      return path.join(await resolve(ancestor), ...missing)
    } catch (error) {
      if (!isMissing(error)) {
        throw await canonicalizeFailure(ancestor, error, resolve, canonicalRoots)
      }
    }
  }
}

export async function resolveContained(
  candidate: string,
  roots: readonly string[],
  options: ResolveContainedOptions = {},
): Promise<string> {
  checkAbsolute(candidate)
  if (roots.length === 0) {
    throw invalidPath("at least one containing root is required")
  }
  for (const root of roots) {
    checkAbsolute(root)
  }
  const resolve = options.realpath ?? ((target: string) => realpath(target))
  const canonicalRoots: string[] = []
  for (const root of roots) {
    try {
      canonicalRoots.push(await resolve(root))
    } catch {
      throw invalidPath("containing root cannot be canonicalized")
    }
  }
  const resolved = await canonicalize(candidate, resolve, options.allowMissingFinal === true, canonicalRoots)
  if (insideRoots(resolved, canonicalRoots)) return resolved
  throw outsideRoots()
}

export interface SandboxIntent {
  readonly sandbox?: unknown
  readonly enforceManagedNetwork?: boolean
  readonly managedNetwork?: unknown
  readonly networkProxy?: unknown
}

export type SandboxAccess = "none" | "read" | "write"

export interface SandboxPolicy {
  readonly sandboxed: boolean
  readonly fileSystem: "restricted" | "unrestricted"
  readonly access: (canonicalPath: string, requestedPath?: string) => SandboxAccess
  readonly metadata: Readonly<Record<string, string>>
}

export interface ResolveSandboxOptions {
  readonly cwd?: string
  readonly readablePolicyCwd?: boolean
  readonly temporaryDirectories?: readonly string[]
  readonly realpath?: (candidate: string) => Promise<string>
}

export const MAX_SANDBOX_ENTRIES = 1024

type Grant = { readonly root: string; readonly access: SandboxAccess }
type Entry =
  | { readonly kind: "path"; readonly native: string; readonly access: SandboxAccess | "deny" }
  | { readonly kind: "glob"; readonly pattern: string; readonly access: SandboxAccess | "deny" }
  | { readonly kind: "special"; readonly value: string; readonly subpath?: string; readonly access: SandboxAccess | "deny" }

const OVERRIDES = ["noOverride", "escalatedSandboxWithRestrictions", "bypassSandboxFirstAttempt"] as const
const NETWORK = ["restricted", "enabled"] as const
const ACCESS = { read: "read", write: "write", deny: "deny" } as const

function invalidSandbox(message = "invalid sandbox request"): PolicyError {
  return new PolicyError("invalid_sandbox", message)
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidSandbox()
  return value as Record<string, unknown>
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalidSandbox()
  return value as T
}

function optional<T>(value: unknown, read: (value: unknown) => T): T | undefined {
  return value == null ? undefined : read(value)
}

function hostPath(value: unknown): string {
  if (typeof value !== "string") throw invalidSandbox()
  let native: string
  try {
    native = parsePathUri(value)
  } catch {
    throw invalidSandbox()
  }
  if (!path.isAbsolute(native)) throw invalidSandbox("sandbox path is not valid on this executor")
  return native
}

function hostPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidSandbox()
  return value.map(hostPath)
}

function relativeSubpath(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== "string" || CONTROL.test(value) || path.isAbsolute(value)) throw invalidSandbox()
  if (value.split(/[\\/]/).some((segment) => segment === "..")) throw invalidSandbox()
  return value
}

function readEntry(value: unknown): Entry {
  const entry = record(value)
  const access = ACCESS[oneOf(entry.access, ["read", "write", "deny"])]
  const target = record(entry.path)
  switch (target.type) {
    case "path":
      return { kind: "path", native: hostPath(target.path), access }
    case "glob_pattern":
      if (typeof target.pattern !== "string" || target.pattern.length === 0 || CONTROL.test(target.pattern)) throw invalidSandbox()
      return { kind: "glob", pattern: target.pattern, access }
    case "special": {
      const special = record(target.value)
      if (typeof special.kind !== "string") throw invalidSandbox()
      return { kind: "special", value: special.kind, subpath: relativeSubpath(special.subpath), access }
    }
    default:
      throw invalidSandbox()
  }
}

interface ParsedSandbox {
  readonly profile: "managed" | "disabled" | "external"
  readonly fileSystem: "restricted" | "unrestricted"
  readonly network: (typeof NETWORK)[number]
  readonly entries: readonly Entry[]
  readonly override: (typeof OVERRIDES)[number]
  readonly cwd?: string
  readonly workspaceRoots?: readonly string[]
  readonly temporaryDirectories?: readonly string[]
}

function readSandbox(value: unknown): ParsedSandbox {
  const sandbox = record(value)
  const permissions = record(sandbox.permissions)
  const override = optional(sandbox.sandboxOverride, (item) => oneOf(item, OVERRIDES)) ?? "noOverride"
  const context = optional(sandbox.policyContext, record)
  const cwd = optional(context ? context.cwd : sandbox.cwd, hostPath)
  const workspaceRoots = optional(context ? context.workspaceRoots : sandbox.workspaceRoots, hostPaths)
  const temporaryDirectories = optional(sandbox.temporaryDirectories, hostPaths)
  optional(sandbox.userHomeDir, hostPath)
  const base = { override, cwd, workspaceRoots, temporaryDirectories }
  switch (permissions.type) {
    case "disabled":
      return { ...base, profile: "disabled", fileSystem: "unrestricted", network: "enabled", entries: [] }
    case "external":
      return { ...base, profile: "external", fileSystem: "unrestricted", network: oneOf(permissions.network, NETWORK), entries: [] }
    case "managed": {
      const fileSystem = record(permissions.file_system)
      const network = oneOf(permissions.network, NETWORK)
      if (fileSystem.type === "unrestricted") {
        return { ...base, profile: "managed", fileSystem: "unrestricted", network, entries: [] }
      }
      if (fileSystem.type !== "restricted" || !Array.isArray(fileSystem.entries)) throw invalidSandbox()
      if (fileSystem.entries.length > MAX_SANDBOX_ENTRIES) throw invalidSandbox("sandbox exceeds the entry limit")
      const depth = fileSystem.glob_scan_max_depth
      if (depth != null && (!Number.isSafeInteger(depth) || (depth as number) < 1)) throw invalidSandbox()
      return { ...base, profile: "managed", fileSystem: "restricted", network, entries: fileSystem.entries.map(readEntry) }
    }
    default:
      throw invalidSandbox()
  }
}

function readManagedNetwork(value: unknown): void {
  const context = record(value)
  const port = (item: unknown) => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 65_535
  if (!Array.isArray(context.loopbackPorts) || !context.loopbackPorts.every(port)) throw invalidSandbox()
  if (typeof context.allowLocalBinding !== "boolean") throw invalidSandbox()
  if (context.allowUnixSockets != null && (!Array.isArray(context.allowUnixSockets) || !context.allowUnixSockets.every((item) => typeof item === "string"))) {
    throw invalidSandbox()
  }
  if (context.dangerouslyAllowAllUnixSockets != null && typeof context.dangerouslyAllowAllUnixSockets !== "boolean") throw invalidSandbox()
}

function readNetworkProxy(value: unknown): void {
  record(record(value).proxy)
}

function globExpression(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "*" && pattern[index + 1] === "*") {
      index++
      if (pattern[index + 1] === "/") {
        index++
        source += "(?:.*/)?"
      } else source += ".*"
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else if (character === "[") {
      const close = pattern.indexOf("]", index + 2)
      if (close === -1) source += "\\["
      else {
        const body = pattern.slice(index + 1, close).replace(/^!/, "^").replaceAll("\\", "\\\\")
        source += `[${body}]`
        index = close
      }
    } else if (character === "{") {
      const close = pattern.indexOf("}", index)
      if (close === -1) source += "\\{"
      else {
        source += `(?:${pattern
          .slice(index + 1, close)
          .split(",")
          .map((part) => part.replace(/[.+^$()|\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]"))
          .join("|")})`
        index = close
      }
    } else source += character.replace(/[.+^$()|\\\]}]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

function within(target: string, root: string): boolean {
  if (root === path.parse(root).root) return target.startsWith(root)
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

function ancestors(target: string): string[] {
  const chain = [target]
  for (let current = target; path.dirname(current) !== current; ) {
    current = path.dirname(current)
    chain.push(current)
  }
  return chain
}

export async function resolveSandbox(
  input: SandboxIntent,
  options: ResolveSandboxOptions = {},
): Promise<SandboxPolicy | undefined> {
  const managedNetwork = input.managedNetwork == null ? undefined : (readManagedNetwork(input.managedNetwork), true)
  const networkProxy = input.networkProxy == null ? undefined : (readNetworkProxy(input.networkProxy), true)
  const sandbox = input.sandbox == null ? undefined : readSandbox(input.sandbox)
  if (sandbox === undefined && managedNetwork === undefined && networkProxy === undefined && input.enforceManagedNetwork !== true) {
    return undefined
  }

  const metadata: Record<string, string> = {}
  if (input.enforceManagedNetwork === true) metadata.sandboxManagedNetwork = "enforced"
  else if (managedNetwork) metadata.sandboxManagedNetwork = "requested"
  if (networkProxy) metadata.sandboxNetworkProxy = "requested"
  if (sandbox === undefined) return { sandboxed: false, fileSystem: "unrestricted", access: () => "write", metadata }

  metadata.sandboxProfile = sandbox.profile
  metadata.sandboxFileSystem = sandbox.fileSystem
  metadata.sandboxNetwork = sandbox.network
  if (sandbox.override !== "noOverride") metadata.sandboxOverride = sandbox.override

  const bypass = sandbox.override === "bypassSandboxFirstAttempt"
  const sandboxed =
    !bypass && sandbox.profile === "managed" && (sandbox.fileSystem === "restricted" || sandbox.network === "restricted")
  if (sandbox.fileSystem === "unrestricted" || bypass) {
    return { sandboxed, fileSystem: "unrestricted", access: () => "write", metadata }
  }

  const resolve = options.realpath ?? ((target: string) => realpath(target))
  const canonical = (native: string) => canonicalize(native, resolve, true, []).catch(() => native)
  const cwd = sandbox.cwd ?? options.cwd
  const dynamic = sandbox.entries.some(
    (entry) => (entry.kind === "special" && entry.value === "project_roots") || (entry.kind === "glob" && !path.isAbsolute(entry.pattern)),
  )
  if (dynamic && cwd === undefined) {
    throw invalidSandbox("file system sandbox context with dynamic permissions requires cwd")
  }
  const workspaceRoots = sandbox.workspaceRoots ?? (cwd === undefined ? [] : [cwd])
  const temporaryDirectories = sandbox.temporaryDirectories ?? options.temporaryDirectories ?? []

  const grants: Grant[] = []
  const denies: string[] = []
  const globs: RegExp[] = []
  let denyAll = false
  const add = async (native: string, access: SandboxAccess | "deny") => {
    const root = await canonical(native)
    if (access === "deny") denies.push(root)
    else grants.push({ root, access })
  }
  for (const entry of sandbox.entries) {
    if (entry.kind === "path") {
      await add(entry.native, entry.access)
      continue
    }
    if (entry.kind === "glob") {
      if (entry.access !== "deny") continue
      const absolute = path.isAbsolute(entry.pattern) ? entry.pattern : path.join(cwd!, entry.pattern)
      const segments = absolute.split("/")
      const literal = segments.findIndex((segment) => /[*?[{]/.test(segment))
      if (literal === -1) {
        await add(absolute, "deny")
        continue
      }
      const prefix = await canonical(segments.slice(0, literal).join("/") || "/")
      globs.push(globExpression(path.join(prefix, ...segments.slice(literal)).replaceAll("\\", "/")))
      continue
    }
    const targets =
      entry.value === "root"
        ? [path.parse(cwd ?? process.cwd()).root]
        : entry.value === "project_roots"
          ? workspaceRoots.map((root) => (entry.subpath ? path.join(root, entry.subpath) : root))
          : entry.value === "tmpdir"
            ? [...temporaryDirectories]
            : entry.value === "slash_tmp"
              ? process.platform === "win32"
                ? []
                : ["/tmp"]
              : undefined
    if (targets === undefined) {
      if (entry.value !== "minimal" && entry.access === "deny") denyAll = true
      continue
    }
    for (const target of targets) await add(target, entry.access)
  }
  if (options.readablePolicyCwd && cwd !== undefined) grants.push({ root: await canonical(cwd), access: "read" })

  const access = (canonicalPath: string, requestedPath?: string): SandboxAccess => {
    if (denyAll) return "none"
    const candidates = requestedPath === undefined || requestedPath === canonicalPath ? [canonicalPath] : [canonicalPath, requestedPath]
    for (const candidate of candidates) {
      if (denies.some((root) => within(candidate, root))) return "none"
      const chain = ancestors(candidate).map((item) => item.replaceAll("\\", "/"))
      if (globs.some((glob) => chain.some((item) => glob.test(item)))) return "none"
    }
    let best: Grant | undefined
    for (const grant of grants) {
      if (!within(canonicalPath, grant.root)) continue
      if (
        best === undefined ||
        grant.root.length > best.root.length ||
        (grant.root.length === best.root.length && grant.access === "read")
      ) {
        best = grant
      }
    }
    return best?.access ?? "none"
  }

  const listed = (kind: SandboxAccess) => JSON.stringify([...new Set(grants.filter((grant) => grant.access === kind).map((grant) => grant.root))])
  metadata.sandboxWritableRoots = listed("write")
  metadata.sandboxReadableRoots = listed("read")
  if (denies.length > 0 || globs.length > 0 || denyAll) metadata.sandboxDeniedPaths = "present"
  return { sandboxed, fileSystem: "restricted", access, metadata }
}

export interface EnvPolicy {
  readonly inherit: "none" | "core" | "all"
  readonly ignoreDefaultExcludes: boolean
  readonly exclude: readonly string[]
  readonly set: Readonly<Record<string, string>>
  readonly includeOnly: readonly string[]
}

export interface BuildProcessEnvInput {
  readonly base?: Readonly<Record<string, string | undefined>>
  readonly env?: Readonly<Record<string, string>>
  readonly envPolicy?: unknown
  readonly denylist?: RegExp
  readonly platform?: NodeJS.Platform
}

const UNIX_CORE_ENV = ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"]
const WINDOWS_CORE_ENV = [
  "PATH", "PATHEXT", "SHELL", "COMSPEC", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "USERNAME", "USERDOMAIN",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
  "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "TMPDIR", "POWERSHELL", "PWSH",
]
const NON_INHERITABLE_ENV = [
  "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN", "NODE_REPL_AUTH_TOKEN", "CODEX_GUARDIAN_DECISIONS_API_KEY",
  "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
]

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function envPatternMatches(name: string, pattern: string): boolean {
  const input = Array.from(name)
  const expression = Array.from(pattern)
  let position = 0
  let token = 0
  let star = -1
  let restart = 0
  while (position < input.length) {
    const current = expression[token]
    if (current === "*") {
      star = token++
      restart = position
    } else if (current === "?" || (current !== undefined && current.toLowerCase() === input[position]!.toLowerCase())) {
      position++
      token++
    } else if (star >= 0) {
      token = star + 1
      position = ++restart
    } else {
      return false
    }
  }
  while (expression[token] === "*") token++
  return token === expression.length
}

function readEnvPolicy(value: unknown): EnvPolicy | undefined {
  if (value == null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError("invalid_env", "invalid environment policy")
  }
  const policy = value as Record<string, unknown>
  if (
    (policy.inherit !== "none" && policy.inherit !== "core" && policy.inherit !== "all") ||
    typeof policy.ignoreDefaultExcludes !== "boolean" ||
    !Array.isArray(policy.exclude) || !Array.from(policy.exclude).every((entry) => typeof entry === "string") ||
    !Array.isArray(policy.includeOnly) || !Array.from(policy.includeOnly).every((entry) => typeof entry === "string") ||
    policy.set === null || typeof policy.set !== "object" || Array.isArray(policy.set)
  ) {
    throw new PolicyError("invalid_env", "invalid environment policy")
  }
  return value as EnvPolicy
}

function validEntry(key: string, value: unknown): value is string {
  return (
    key.length > 0 &&
    !key.includes("=") &&
    !CONTROL.test(key) &&
    typeof value === "string" &&
    !value.includes("\x00")
  )
}

export function buildProcessEnv(input: BuildProcessEnvInput): Record<string, string> {
  const policy = readEnvPolicy(input.envPolicy)
  const platform = input.platform ?? process.platform
  const core = platform === "win32" ? WINDOWS_CORE_ENV : UNIX_CORE_ENV
  const supplied = input.denylist ?? DEFAULT_SECRET_ENV_KEYS
  const denylist = new RegExp(supplied.source, supplied.flags.replaceAll("g", "").replaceAll("y", ""))
  const result = new Map<string, string>()
  const insert = (key: string, value: unknown) => {
    if (!validEntry(key, value)) return
    if (platform === "win32") {
      for (const existing of result.keys()) {
        if (asciiLower(existing) === asciiLower(key)) result.delete(existing)
      }
    }
    result.set(key, value)
  }
  if (policy?.inherit !== "none") {
    for (const [key, value] of Object.entries(input.base ?? {})) {
      if (policy?.inherit === "core" && !core.some((allowed) => asciiLower(allowed) === asciiLower(key))) continue
      if (DEFAULT_SECRET_ENV_KEYS.test(key) || denylist.test(key)) continue
      if (policy && !policy.ignoreDefaultExcludes && /KEY|SECRET|TOKEN/i.test(key)) continue
      insert(key, value)
    }
  }
  for (const key of result.keys()) {
    if (policy?.exclude.some((pattern) => envPatternMatches(key, pattern))) result.delete(key)
  }
  for (const [key, value] of Object.entries(policy?.set ?? {})) insert(key, value)
  if (policy && policy.includeOnly.length > 0) {
    for (const key of result.keys()) {
      if (!policy.includeOnly.some((pattern) => envPatternMatches(key, pattern))) result.delete(key)
    }
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    insert(key, value)
  }
  for (const key of result.keys()) {
    if (key === "CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE" || NON_INHERITABLE_ENV.some((name) => asciiLower(name) === asciiLower(key))) {
      result.delete(key)
    }
  }
  if (result.size > MAX_ENV_ENTRIES) {
    throw new PolicyError("invalid_env", "environment exceeds the entry limit")
  }
  let bytes = 0
  for (const [key, value] of result) {
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
    if (bytes > MAX_ENV_BYTES) {
      throw new PolicyError("invalid_env", "environment exceeds the byte limit")
    }
  }
  return Object.fromEntries(result)
}

export function assertArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || argv[0] === "") {
    throw new PolicyError("invalid_argv", "argv must contain a program and at most 512 arguments")
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("\x00") || Buffer.byteLength(arg) > MAX_ARG_BYTES) {
      throw new PolicyError("invalid_argv", "argv entry is invalid or exceeds the byte limit")
    }
  }
}
