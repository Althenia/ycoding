import { realpathSync, statSync, watch, type FSWatcher } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml"
import type { Document, Node as YamlNode } from "yaml"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import {
  discoverCcaCapabilityRoots,
  type CcaCapabilityFileSystem,
  type CcaCapabilityRootDiscovery,
  type CcaCapabilityTextFile,
  type CcaCapabilityTree,
  type CcaDiscoveredPluginFiles,
} from "./cca-capability-discovery"
import { ccaSystemConfigPath, type CcaEnvironmentConfigOptions } from "./cca-environment-config"
import { CcaRpcError, type CcaRpcHandlerContext } from "./cca-executor-rpc"
import { ycodingDotsSkillsRoot } from "./ycoding-operator-skill"

export interface CcaDiscoverV2CapabilitiesParams {
  readonly cwd: string
  readonly sandbox?: Readonly<Record<string, unknown>>
}

export interface CcaSkillDiscoveryRoot {
  readonly id: string
  readonly path: string
}

export interface CcaSkillToolDependency {
  readonly type: string
  readonly value: string
  readonly description: string | null
  readonly transport: string | null
  readonly command: string | null
  readonly url: string | null
  readonly oauthCallbackPort: number | null
}

export interface CcaSkillDependencies {
  readonly tools: readonly CcaSkillToolDependency[]
}

export type CcaSkillProduct = "chatgpt" | "codex" | "atlas"

export interface CcaSkillPolicy {
  readonly allowImplicitInvocation: boolean | null
  readonly products: readonly CcaSkillProduct[]
}

export interface CcaExecutorSkill {
  readonly name: string
  readonly description: string
  readonly shortDescription: string | null
  readonly path: string
  readonly discoveryRoot?: CcaSkillDiscoveryRoot
  readonly dependencies: CcaSkillDependencies | null
  readonly policy: CcaSkillPolicy | null
}

export interface CcaExecutorPlugin {
  readonly id: string
  readonly displayName: string
  readonly remotePluginId: string | null
  readonly version: string
  readonly root: string
  readonly files: CcaDiscoveredPluginFiles
  readonly skills: readonly CcaExecutorSkill[]
}

export interface CcaDiscoverV2CapabilitiesResult {
  readonly plugins: readonly CcaExecutorPlugin[]
  readonly skills: readonly CcaExecutorSkill[]
  readonly warnings: readonly string[]
}

export type CcaCapabilityDiscoveryV2Environment = Pick<CcaEnvironmentConfigOptions, "homeDirectory" | "codexHomeEnv" | "systemConfigPath"> & {
  readonly dataDirectory?: string
}

export interface CcaCapabilityWatchPath {
  readonly path: string
  readonly recursive: boolean
}

export interface CcaCapabilityWatchSubscription {
  readonly registered: boolean
  readonly close: () => void
}

export type CcaCapabilityWatcher = (
  paths: readonly CcaCapabilityWatchPath[],
  onChange: (paths: readonly string[]) => void,
) => CcaCapabilityWatchSubscription

export interface CcaCapabilityDiscoveryV2Change {
  readonly paths: readonly string[]
}

export interface CcaCapabilityDiscoveryV2Options {
  readonly fs: CcaCapabilityFileSystem
  readonly environment: CcaCapabilityDiscoveryV2Environment
  readonly watcher?: CcaCapabilityWatcher | null
  readonly throttleMs?: number
}

export interface CcaCapabilityDiscoveryV2 {
  readonly discover: (params: unknown, ctx: CcaRpcHandlerContext) => Promise<CcaDiscoverV2CapabilitiesResult>
  readonly subscribe: (listener: (change: CcaCapabilityDiscoveryV2Change) => void) => () => void
  readonly close: () => Promise<void>
}

export interface CcaParsedSkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly shortDescription: string | null
}

export interface CcaParsedSkillMetadata {
  readonly dependencies: CcaSkillDependencies | null
  readonly policy: CcaSkillPolicy | null
}

const PLUGINS_CACHE_DIR = "plugins/cache"
const REMOTE_PLUGIN_INSTALL_METADATA_FILE = ".codex-remote-plugin-install.json"
const DEFAULT_PLUGIN_VERSION = "local"
const AGENTS_SKILLS_SUFFIX = ".agents/skills"
const MAX_LOCATIONS = 512
const MAX_LOCATION_WARNINGS = 64
const MAX_REMOTE_INSTALL_METADATA_BYTES = 16 * 1024
const MAX_REMOTE_PLUGIN_ID_BYTES = 1024
const MAX_CACHE_WALK_DIRECTORIES = 2_000
const MAX_CACHE_WALK_ENTRIES = 20_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_CAPABILITIES = 2_048
const MAX_WARNINGS = 64
const MAX_QUALIFIED_NAME_LEN = 64 * 2 + 1
const MAX_CONCURRENT_LOCATIONS = 8
const MAX_CACHED_SANDBOX_CONTEXTS = 16
const DEFAULT_THROTTLE_MS = 10_000
const MAX_SKILL_NAME_LEN = 64
const LOCATIONS_INCOMPLETE = "some capability locations could not be resolved; discovery may be incomplete"
const METADATA_INCOMPLETE = "some capability metadata could not be loaded; discovery may be incomplete"
const SIZE_LIMIT_REACHED = "capability discovery size limit reached"

const WHITESPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const WHITESPACE_RUN = new RegExp(`[${WHITESPACE}]+`, "g")
const IS_WHITESPACE = new RegExp(`^[${WHITESPACE}]$`)
const COLON_SEPARATOR = new RegExp(`:[${WHITESPACE}]`)
const TRIM = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, "g")

const uri = (native: string) => CcaPolicy.toPathUri(native)
const native = (pathUri: string) => CcaPolicy.parsePathUri(pathUri)
const collapse = (raw: string) => raw.split(WHITESPACE_RUN).filter((part) => part.length > 0).join(" ")
const trim = (raw: string) => raw.replace(TRIM, "")
const isWhitespace = (character: string | undefined) => character !== undefined && IS_WHITESPACE.test(character)
function charCount(text: string) {
  let count = 0
  for (const _ of text) count++
  return count
}

function compareBytes(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function comparePaths(left: string, right: string) {
  const a = left.split("/")
  const b = right.split("/")
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = compareBytes(a[index], b[index])
    if (order !== 0) return order
  }
  return a.length - b.length
}

function errorCode(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown) {
  return errorCode(error) === -32004
}

function isPermissionDenied(error: unknown) {
  const code = errorCode(error)
  return code === -32001 || (code === -32600 && errorMessage(error) === "Permission denied")
}

function ioText(error: unknown) {
  if (errorCode(error) === -32600 && errorMessage(error) === "Permission denied") return "Permission denied (os error 13)"
  return errorMessage(error)
}

const NODE_IO_MESSAGES: Readonly<Record<string, string>> = {
  EACCES: "Permission denied (os error 13)",
  EPERM: "Operation not permitted (os error 1)",
  ENOTDIR: "Not a directory (os error 20)",
}

function nodeIoText(error: unknown) {
  const code = errorCode(error)
  return (typeof code === "string" ? NODE_IO_MESSAGES[code] : undefined) ?? errorMessage(error)
}

class ParamsError extends CcaRpcError {
  constructor(message: string) {
    super(-32602, message)
  }
}

function unexpected(value: unknown) {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return `boolean \`${value}\``
  if (typeof value === "number") return "number"
  if (typeof value === "string") return `string ${JSON.stringify(value)}`
  if (Array.isArray(value)) return "sequence"
  return "map"
}

function taggedUnexpected(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``
  return unexpected(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function decodePathUri(value: unknown): string {
  if (typeof value !== "string") throw new ParamsError(`invalid type: ${unexpected(value)}, expected a string`)
  const text = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)
  if (scheme === null) throw new ParamsError("invalid URI: relative URL without a base")
  const name = scheme[1].toLowerCase()
  if (name !== "file") throw new ParamsError(`unsupported path URI scheme \`${name}\``)
  const hash = text.indexOf("#")
  if ((hash === -1 ? text : text.slice(0, hash)).includes("?")) throw new ParamsError("query parameters are not allowed in path URIs")
  if (hash !== -1) throw new ParamsError("fragments are not allowed in path URIs")
  return value
}

const PERMISSION_PROFILE_TYPES = ["managed", "disabled", "external"]
const WINDOWS_SANDBOX_LEVELS = ["disabled", "restricted-token", "elevated", "mxc"]
const variants = (names: readonly string[]) => names.map((name) => `\`${name}\``).join(", ")

function decodeSandbox(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    if (value.length === 0) throw new ParamsError("invalid length 0, expected struct FileSystemSandboxContext with 9 elements")
    throw new ParamsError("invalid type: sequence, expected struct FileSystemSandboxContext")
  }
  if (!isRecord(value)) throw new ParamsError(`invalid type: ${unexpected(value)}, expected struct FileSystemSandboxContext`)
  for (const [key, field] of Object.entries(value)) {
    if (key === "permissions") {
      if (Array.isArray(field)) throw new ParamsError("missing field `type`")
      if (!isRecord(field)) throw new ParamsError(`invalid type: ${taggedUnexpected(field)}, expected internally tagged enum ExecPermissionProfile`)
      if (!("type" in field)) throw new ParamsError("missing field `type`")
      if (typeof field.type === "string" && !PERMISSION_PROFILE_TYPES.includes(field.type))
        throw new ParamsError(`unknown variant \`${field.type}\`, expected one of ${variants(PERMISSION_PROFILE_TYPES)}`)
    } else if (key === "cwd") decodePathUri(field)
    else if (key === "workspaceRoots") {
      if (!Array.isArray(field)) throw new ParamsError(`invalid type: ${unexpected(field)}, expected a sequence`)
      field.forEach(decodePathUri)
    } else if (key === "userHomeDir") {
      if (field !== null) decodePathUri(field)
    } else if (key === "temporaryDirectories") {
      if (field === null) continue
      if (!Array.isArray(field)) throw new ParamsError(`invalid type: ${unexpected(field)}, expected a sequence`)
      field.forEach(decodePathUri)
    } else if (key === "windowsSandboxLevel") {
      if (typeof field === "string") {
        if (!WINDOWS_SANDBOX_LEVELS.includes(field)) throw new ParamsError(`unknown variant \`${field}\`, expected one of ${variants(WINDOWS_SANDBOX_LEVELS)}`)
      } else if (!isRecord(field)) throw new ParamsError(`invalid type: ${unexpected(field)}, expected string or map`)
    } else if (key === "useLegacyLandlock") {
      if (typeof field !== "boolean") throw new ParamsError(`invalid type: ${unexpected(field)}, expected a boolean`)
    }
  }
  for (const required of ["permissions", "cwd", "windowsSandboxLevel"]) if (!(required in value)) throw new ParamsError(`missing field \`${required}\``)
  return value
}

export function decodeCcaDiscoverV2Params(params: unknown): CcaDiscoverV2CapabilitiesParams {
  let cwd: string | undefined
  let sandbox: Readonly<Record<string, unknown>> | undefined
  if (Array.isArray(params)) {
    if (params.length === 0) throw new ParamsError("invalid length 0, expected struct DiscoverV2CapabilitiesRequest with 2 elements")
    cwd = decodePathUri(params[0])
    if (params.length > 1) sandbox = decodeSandbox(params[1])
    if (params.length > 2) throw new ParamsError(`invalid length ${params.length}, expected fewer elements in array`)
  } else if (isRecord(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (key === "cwd") cwd = decodePathUri(value)
      else if (key === "sandbox") sandbox = decodeSandbox(value)
    }
    if (cwd === undefined) throw new ParamsError("missing field `cwd`")
  } else throw new ParamsError(`invalid type: ${unexpected(params)}, expected struct DiscoverV2CapabilitiesRequest`)
  return sandbox === undefined ? { cwd } : { cwd, sandbox }
}

type SemVer = { readonly core: readonly bigint[]; readonly pre: readonly string[]; readonly build: readonly string[] }

const NUMERIC = /^(0|[1-9][0-9]*)$/
const IDENTIFIER = /^[0-9A-Za-z-]+$/
const U64_MAX = 18_446_744_073_709_551_615n

function parseSemVer(text: string): SemVer | undefined {
  const match = /^([^-+]*)(?:-([^+]*))?(?:\+(.*))?$/.exec(text)
  if (match === null) return undefined
  const core = match[1].split(".")
  if (core.length !== 3 || !core.every((part) => NUMERIC.test(part) && BigInt(part) <= U64_MAX)) return undefined
  const pre = match[2] === undefined ? [] : match[2].split(".")
  if (pre.some((part) => !IDENTIFIER.test(part) || (/^[0-9]+$/.test(part) && !NUMERIC.test(part)))) return undefined
  const build = match[3] === undefined ? [] : match[3].split(".")
  if (build.some((part) => !IDENTIFIER.test(part))) return undefined
  return { core: core.map(BigInt), pre, build }
}

function compareIdentifiers(left: readonly string[], right: readonly string[], numeric: (a: string, b: string) => number) {
  for (let index = 0; index < left.length; index++) {
    if (index >= right.length) return 1
    const a = left[index]
    const b = right[index]
    const aNumeric = /^[0-9]*$/.test(a)
    const bNumeric = /^[0-9]*$/.test(b)
    const order = aNumeric && bNumeric ? numeric(a, b) : aNumeric ? -1 : bNumeric ? 1 : compareBytes(a, b)
    if (order !== 0) return order
  }
  return left.length === right.length ? 0 : -1
}

function compareSemVer(left: SemVer, right: SemVer) {
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length !== right.pre.length) return left.pre.length === 0 ? 1 : -1
  } else {
    const order = compareIdentifiers(left.pre, right.pre, (a, b) => a.length - b.length || compareBytes(a, b))
    if (order !== 0) return order
  }
  return compareIdentifiers(left.build.length === 0 ? [""] : left.build, right.build.length === 0 ? [""] : right.build, (a, b) => {
    const x = a.replace(/^0+/, "")
    const y = b.replace(/^0+/, "")
    return x.length - y.length || compareBytes(x, y) || a.length - b.length
  })
}

function comparePluginVersions(left: string, right: string) {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  return a !== undefined && b !== undefined ? compareSemVer(a, b) : compareBytes(left, right)
}

function validPluginVersion(version: string) {
  return version.length > 0 && version !== "." && version !== ".." && /^[A-Za-z0-9._+-]+$/.test(version)
}

export function ccaActivePluginVersion(versions: readonly string[]): string | undefined {
  const valid = versions.filter(validPluginVersion).sort(comparePluginVersions)
  if (valid.length === 0) return undefined
  return valid.includes(DEFAULT_PLUGIN_VERSION) ? DEFAULT_PLUGIN_VERSION : valid.at(-1)
}

function validPluginSegment(segment: string, allowDots: boolean) {
  if (segment.length === 0) return false
  if (allowDots && (segment.startsWith(".") || segment.endsWith(".") || segment.includes(".."))) return false
  return (allowDots ? /^[A-Za-z0-9_.-]+$/ : /^[A-Za-z0-9_-]+$/).test(segment)
}

type Json =
  | { readonly kind: "object"; readonly entries: readonly (readonly [string, Json])[] }
  | { readonly kind: "array"; readonly items: readonly Json[] }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "literal"; readonly value: boolean | null }

class JsonError extends Error {}

function parseJson(text: string): Json {
  let index = 0
  const space = () => {
    while (index < text.length && " \t\n\r".includes(text[index])) index++
  }
  const fail = (): never => {
    throw new JsonError(`invalid JSON at ${index}`)
  }
  const value = (): Json => {
    space()
    const character = text[index]
    if (character === "{") {
      index++
      const entries: [string, Json][] = []
      space()
      if (text[index] === "}") {
        index++
        return { kind: "object", entries }
      }
      for (;;) {
        space()
        if (text[index] !== '"') fail()
        const key = string()
        space()
        if (text[index] !== ":") fail()
        index++
        entries.push([key, value()])
        space()
        if (text[index] === ",") index++
        else if (text[index] === "}") {
          index++
          return { kind: "object", entries }
        } else fail()
      }
    }
    if (character === "[") {
      index++
      const items: Json[] = []
      space()
      if (text[index] === "]") {
        index++
        return { kind: "array", items }
      }
      for (;;) {
        items.push(value())
        space()
        if (text[index] === ",") index++
        else if (text[index] === "]") {
          index++
          return { kind: "array", items }
        } else fail()
      }
    }
    if (character === '"') return { kind: "string", value: string() }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, index)) {
        index += word.length
        return { kind: "literal", value: literal }
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index))
    if (number === null) return fail()
    index += number[0].length
    if (!/^-?[0-9]+$/.test(number[0]) && !Number.isFinite(Number(number[0]))) fail()
    return { kind: "number", raw: number[0] }
  }
  const string = () => {
    const start = index
    index++
    while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1
    if (index >= text.length) fail()
    index++
    try {
      const decoded: unknown = JSON.parse(text.slice(start, index))
      return typeof decoded === "string" ? decoded : fail()
    } catch {
      return fail()
    }
  }
  const result = value()
  space()
  if (index !== text.length) fail()
  return result
}

function formatFloat(value: number) {
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"
  const sign = value < 0 ? "-" : ""
  const exponential = Math.abs(value).toExponential()
  const separator = exponential.indexOf("e")
  const mantissa = exponential.slice(0, separator)
  const exponent = exponential.slice(separator + 1)
  const digits = mantissa.replace(".", "")
  const point = Number(exponent) + 1
  const zeros = point - digits.length
  if (zeros >= 0 && point <= 16) return `${sign}${digits}${"0".repeat(zeros)}.0`
  if (point > 0 && point <= 16) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
  if (point > -5 && point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`
  return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${point - 1}`
}

function formatNumber(raw: string) {
  if (/^-?[0-9]+$/.test(raw)) {
    const integer = BigInt(raw)
    if (integer >= -9_223_372_036_854_775_808n && integer <= U64_MAX && raw !== "-0") return integer.toString()
  }
  return formatFloat(Number(raw))
}

function stringifyJson(value: Json): string {
  if (value.kind === "object") {
    const merged = new Map<string, Json>()
    for (const [key, item] of value.entries) merged.set(key, item)
    return `{${[...merged].map(([key, item]) => `${JSON.stringify(key)}:${stringifyJson(item)}`).join(",")}}`
  }
  if (value.kind === "array") return `[${value.items.map(stringifyJson).join(",")}]`
  if (value.kind === "string") return JSON.stringify(value.value)
  if (value.kind === "number") return formatNumber(value.raw)
  return String(value.value)
}

function jsonStruct(value: Json, fields: readonly string[]): Map<string, Json> {
  if (value.kind !== "object") throw new JsonError("expected an object")
  const decoded = new Map<string, Json>()
  for (const [key, item] of value.entries) {
    if (!fields.includes(key)) continue
    if (decoded.has(key)) throw new JsonError(`duplicate field \`${key}\``)
    decoded.set(key, item)
  }
  return decoded
}

function decodeJsonStruct(text: string, fields: readonly string[]): Map<string, Json> {
  return jsonStruct(parseJson(text), fields)
}

function jsonString(value: Json | undefined, nullable: boolean): string | undefined {
  if (value === undefined) return undefined
  if (value.kind === "string") return value.value
  if (nullable && value.kind === "literal" && value.value === null) return undefined
  throw new JsonError("expected a string")
}

function manifestName(contents: string): string | undefined {
  try {
    return jsonString(decodeJsonStruct(contents, ["name"]).get("name"), false) ?? ""
  } catch {
    return undefined
  }
}

interface PluginManifestMetadata {
  readonly name: string
  readonly displayName: string | undefined
  readonly mcpServers: Json | undefined
  readonly apps: string | undefined
}

function pluginManifestMetadata(contents: string): PluginManifestMetadata | undefined {
  try {
    const fields = decodeJsonStruct(contents, ["name", "interface", "mcpServers", "apps"])
    const face = fields.get("interface")
    let displayName: string | undefined
    if (face !== undefined && !(face.kind === "literal" && face.value === null)) {
      const faceFields = jsonStruct(face, ["displayName"])
      displayName = jsonString(faceFields.get("displayName"), true)
    }
    const mcpServers = fields.get("mcpServers")
    return {
      name: jsonString(fields.get("name"), false) ?? "",
      displayName,
      mcpServers: mcpServers?.kind === "literal" && mcpServers.value === null ? undefined : mcpServers,
      apps: jsonString(fields.get("apps"), true),
    }
  } catch {
    return undefined
  }
}

function parseRemotePluginId(contents: string): string {
  const fields = decodeJsonStruct(contents, ["schema_version", "remote_plugin_id"])
  const version = fields.get("schema_version")
  if (version === undefined) throw new JsonError("missing field `schema_version`")
  if (version.kind !== "number" || !/^[0-9]+$/.test(version.raw) || BigInt(version.raw) > 255n) throw new JsonError("invalid schema_version")
  const id = jsonString(fields.get("remote_plugin_id"), false)
  if (id === undefined) throw new JsonError("missing field `remote_plugin_id`")
  if (version.raw !== "1") throw new JsonError(`unsupported remote plugin install metadata schema version: ${version.raw}`)
  const trimmed = trim(id)
  if (trimmed.length === 0) throw new JsonError("invalid remote plugin install metadata: remote plugin id must not be blank")
  if (Buffer.byteLength(trimmed) > MAX_REMOTE_PLUGIN_ID_BYTES) throw new JsonError("remote plugin ID exceeds its byte limit")
  return trimmed
}

class YamlDecodeError extends Error {}

type Yaml =
  | { readonly kind: "scalar"; readonly value: string; readonly plain: boolean }
  | { readonly kind: "map"; readonly entries: readonly (readonly [string, Yaml])[] }
  | { readonly kind: "seq"; readonly items: readonly Yaml[] }

function yamlTree(document: Document, node: unknown): Yaml {
  const resolved = isAlias(node) ? node.resolve(document) : node
  if (resolved === null || resolved === undefined) return { kind: "scalar", value: "", plain: true }
  if (isScalar(resolved)) return { kind: "scalar", value: typeof resolved.value === "string" ? resolved.value : "", plain: resolved.type === Scalar.PLAIN || resolved.type === undefined }
  if (isMap(resolved))
    return {
      kind: "map",
      entries: resolved.items.map((pair) => {
        const key = yamlTree(document, pair.key)
        if (key.kind !== "scalar") throw new YamlDecodeError("expected a field identifier")
        return [key.value, yamlTree(document, pair.value)] as const
      }),
    }
  if (isSeq(resolved)) return { kind: "seq", items: resolved.items.map((item) => yamlTree(document, item)) }
  throw new YamlDecodeError("unsupported YAML node")
}

function parseYaml(text: string): Yaml {
  const document = parseDocument(text, { schema: "failsafe", uniqueKeys: false })
  if (document.errors.length > 0) throw new YamlDecodeError(document.errors[0].message)
  return yamlTree(document, document.contents as YamlNode | null)
}

const isYamlNull = (node: Yaml | undefined) =>
  node === undefined || (node.kind === "scalar" && node.plain && ["", "~", "null", "Null", "NULL"].includes(node.value))

function yamlStruct(node: Yaml, fields: readonly (readonly [string, ...string[]])[]): Map<string, Yaml> {
  if (node.kind !== "map") throw new YamlDecodeError("expected a struct")
  const decoded = new Map<string, Yaml>()
  for (const [key, value] of node.entries) {
    const field = fields.find((names) => names.includes(key))
    if (field === undefined) continue
    if (decoded.has(field[0])) throw new YamlDecodeError(`duplicate field \`${field[0]}\``)
    decoded.set(field[0], value)
  }
  return decoded
}

function yamlOptionalString(node: Yaml | undefined): string | undefined {
  if (isYamlNull(node)) return undefined
  if (node!.kind !== "scalar") throw new YamlDecodeError("expected a string")
  return node!.value
}

function yamlOptionalBool(node: Yaml | undefined): boolean | undefined {
  if (isYamlNull(node)) return undefined
  if (node!.kind === "scalar" && node!.plain) {
    if (["true", "True", "TRUE"].includes(node!.value)) return true
    if (["false", "False", "FALSE"].includes(node!.value)) return false
  }
  throw new YamlDecodeError("expected a boolean")
}

function yamlOptionalU16(node: Yaml | undefined): number | undefined {
  if (isYamlNull(node)) return undefined
  if (node!.kind !== "scalar" || !node!.plain) throw new YamlDecodeError("expected u16")
  const unsigned = node!.value.startsWith("+") ? node!.value.slice(1) : node!.value
  const radix = (prefix: string, base: number, digits: RegExp) => {
    if (!unsigned.startsWith(prefix)) return undefined
    const rest = unsigned.slice(prefix.length)
    return digits.test(rest) ? Number.parseInt(rest, base) : undefined
  }
  let value = radix("0x", 16, /^[0-9A-Fa-f]+$/) ?? radix("0o", 8, /^[0-7]+$/) ?? radix("0b", 2, /^[01]+$/)
  if (value === undefined && /^[0-9]+$/.test(unsigned) && !/^0[0-9]+$/.test(unsigned)) value = Number(unsigned)
  if (value === undefined || value > 65_535) throw new YamlDecodeError("expected u16")
  return value
}

function yamlSequence(node: Yaml | undefined): readonly Yaml[] {
  if (node === undefined) return []
  if (node.kind !== "seq") throw new YamlDecodeError("expected a sequence")
  return node.items
}

function yamlOptionalStruct(node: Yaml | undefined, fields: readonly (readonly [string, ...string[]])[]): Map<string, Yaml> | undefined {
  return isYamlNull(node) ? undefined : yamlStruct(node!, fields)
}

function extractFrontmatter(contents: string): string | undefined {
  const lines = contents.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  if (lines.at(-1) === "") lines.pop()
  if (lines.length === 0 || trim(lines[0]) !== "---") return undefined
  const frontmatter: string[] = []
  for (const line of lines.slice(1)) {
    if (trim(line) === "---") return frontmatter.length === 0 ? undefined : frontmatter.join("\n")
    frontmatter.push(line)
  }
  return undefined
}

function repairFrontmatterScalarFields(frontmatter: string): string | undefined {
  let changed = false
  let blockIndent: number | undefined
  const lines = frontmatter.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  const repaired: string[] = []
  for (const line of lines) {
    const indent = /^ */.exec(line)![0].length
    if (blockIndent !== undefined) {
      if (trim(line).length === 0 || indent > blockIndent) {
        repaired.push(line)
        continue
      }
      blockIndent = undefined
    }
    const colon = line.indexOf(":")
    if (colon === -1) {
      repaired.push(line)
      continue
    }
    const key = line.slice(0, colon)
    const value = line.slice(colon + 1)
    if (trim(key).length === 0 || (value.length > 0 && !isWhitespace(String.fromCodePoint(value.codePointAt(0)!)))) {
      repaired.push(line)
      continue
    }
    const trimmedStart = value.replace(new RegExp(`^[${WHITESPACE}]+`), "")
    const leading = value.slice(0, value.length - trimmedStart.length)
    let scalar = trimmedStart
    let comment = ""
    for (let index = 0; index < trimmedStart.length; index++) {
      if (trimmedStart[index] === "#" && (index === 0 || isWhitespace(trimmedStart[index - 1]))) {
        const commentStart = trimmedStart.slice(0, index).replace(new RegExp(`[${WHITESPACE}]+$`), "").length
        scalar = trimmedStart.slice(0, commentStart)
        comment = trimmedStart.slice(commentStart)
        break
      }
    }
    scalar = scalar.replace(new RegExp(`[${WHITESPACE}]+$`), "")
    const first = scalar[0]
    if (first === undefined) {
      repaired.push(line)
      continue
    }
    if (first === "|" || first === ">") {
      blockIndent = indent
      repaired.push(line)
      continue
    }
    if (first === "'" || first === '"') {
      repaired.push(line)
      continue
    }
    const colonSeparator = COLON_SEPARATOR.test(scalar)
    const invalidFlowLike = "[{@`".includes(first) && parseDocument(scalar).errors.length > 0
    if (!colonSeparator && !invalidFlowLike) {
      repaired.push(line)
      continue
    }
    repaired.push(`${key}:${leading}'${scalar.replaceAll("'", "''")}'${comment}`)
    changed = true
  }
  return changed ? repaired.join("\n") : undefined
}

function decodeFrontmatter(frontmatter: string) {
  const fields = yamlStruct(parseYaml(frontmatter), [["name"], ["description"], ["metadata"]])
  const metadata = fields.has("metadata") ? yamlStruct(fields.get("metadata")!, [["short-description"]]) : new Map<string, Yaml>()
  return {
    name: yamlOptionalString(fields.get("name")),
    description: yamlOptionalString(fields.get("description")),
    shortDescription: yamlOptionalString(metadata.get("short-description")),
  }
}

export function parseCcaSkillFrontmatter(contents: string, defaultName: () => string): CcaParsedSkillFrontmatter | Error {
  const frontmatter = extractFrontmatter(contents)
  if (frontmatter === undefined) return new Error("missing YAML frontmatter delimited by ---")
  let parsed: ReturnType<typeof decodeFrontmatter>
  try {
    parsed = decodeFrontmatter(frontmatter)
  } catch (error) {
    const repaired = repairFrontmatterScalarFields(frontmatter)
    if (repaired === undefined) return new Error(`invalid YAML: ${errorMessage(error)}`)
    try {
      parsed = decodeFrontmatter(repaired)
    } catch {
      return new Error(`invalid YAML: ${errorMessage(error)}`)
    }
  }
  const name = parsed.name === undefined || collapse(parsed.name).length === 0 ? defaultName() : collapse(parsed.name)
  const description = parsed.description === undefined ? "" : collapse(parsed.description)
  const shortDescription = parsed.shortDescription === undefined || collapse(parsed.shortDescription).length === 0 ? null : collapse(parsed.shortDescription)
  if (name.length === 0) return new Error("missing field `name`")
  if (charCount(name) > MAX_SKILL_NAME_LEN) return new Error(`invalid name: exceeds maximum length of ${MAX_SKILL_NAME_LEN} characters`)
  if (description.length === 0) return new Error("missing field `description`")
  return { name, description, shortDescription }
}

const PRODUCTS: Readonly<Record<string, CcaSkillProduct>> = {
  chatgpt: "chatgpt",
  CHATGPT: "chatgpt",
  codex: "codex",
  CODEX: "codex",
  atlas: "atlas",
  ATLAS: "atlas",
}

function boundedString(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null
  const collapsed = collapse(value)
  return collapsed.length === 0 || charCount(collapsed) > maxLength ? null : collapsed
}

export function parseCcaSkillMetadata(contents: string): CcaParsedSkillMetadata | Error {
  try {
    const file = parseYaml(contents)
    const fields = yamlStruct(file, [["interface"], ["dependencies"], ["policy"]])
    yamlOptionalStruct(fields.get("interface"), [["display_name"], ["short_description"], ["icon_small"], ["icon_large"], ["brand_color"], ["default_prompt"]])?.forEach(
      (value) => yamlOptionalString(value),
    )
    const dependencies = yamlOptionalStruct(fields.get("dependencies"), [["tools"]])
    const tools: CcaSkillToolDependency[] = []
    for (const item of yamlSequence(dependencies?.get("tools"))) {
      const tool = yamlStruct(item, [["type"], ["value"], ["description"], ["transport"], ["command"], ["url"], ["oauth"]])
      const strings = Object.fromEntries(["type", "value", "description", "transport", "command", "url"].map((key) => [key, yamlOptionalString(tool.get(key))]))
      const oauth = yamlOptionalStruct(tool.get("oauth"), [["callbackPort", "callback_port"]])
      const oauthCallbackPort = yamlOptionalU16(oauth?.get("callbackPort")) ?? null
      const type = boundedString(strings.type, 64)
      const value = boundedString(strings.value, 1024)
      if (type === null || value === null) continue
      tools.push({
        type,
        value,
        description: boundedString(strings.description, 1024),
        transport: boundedString(strings.transport, 64),
        command: boundedString(strings.command, 1024),
        url: boundedString(strings.url, 1024),
        oauthCallbackPort,
      })
    }
    const policyFields = yamlOptionalStruct(fields.get("policy"), [["allow_implicit_invocation"], ["products"]])
    const policy =
      policyFields === undefined
        ? null
        : {
            allowImplicitInvocation: yamlOptionalBool(policyFields.get("allow_implicit_invocation")) ?? null,
            products: yamlSequence(policyFields.get("products")).map((product) => {
              const name = product.kind === "scalar" ? PRODUCTS[product.value] : undefined
              if (name === undefined) throw new YamlDecodeError("unknown product")
              return name
            }),
          }
    return { dependencies: tools.length === 0 ? null : { tools }, policy }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

interface InstalledPlugin {
  readonly id: string
  readonly version: string
  readonly remotePluginId: string | null
}

interface CapabilityLocation {
  readonly root: string
  readonly standaloneRootId: string | null
  readonly plugin: InstalledPlugin | null
}

interface CapabilityLocations {
  readonly locations: CapabilityLocation[]
  readonly watches: CcaCapabilityWatchPath[]
  readonly warnings: string[]
}

interface CapabilityLocationRequest {
  readonly codexHome: string
  readonly userHome: string | null
  readonly systemSkillsRoot: string
  readonly dotsSkillsRoot: string
}

async function resolveLocationRequest(environment: CcaCapabilityDiscoveryV2Environment): Promise<CapabilityLocationRequest> {
  const value = environment.codexHomeEnv
  let codexHome: string
  if (value !== undefined && value !== "") {
    const quoted = JSON.stringify(value)
    const info = await stat(value).catch((error: unknown) => {
      throw new Error(
        errorCode(error) === "ENOENT" ? `CODEX_HOME points to ${quoted}, but that path does not exist` : `failed to read CODEX_HOME ${quoted}: ${nodeIoText(error)}`,
      )
    })
    if (!info.isDirectory()) throw new Error(`CODEX_HOME points to ${quoted}, but that path is not a directory`)
    codexHome = await realpath(value).catch((error: unknown) => {
      throw new Error(`failed to canonicalize CODEX_HOME ${quoted}: ${nodeIoText(error)}`)
    })
  } else {
    if (environment.homeDirectory === "") throw new Error("Could not find home directory")
    codexHome = path.join(environment.homeDirectory, ".codex")
  }
  return {
    codexHome,
    userHome: environment.homeDirectory === "" ? null : environment.homeDirectory,
    systemSkillsRoot: path.join(path.dirname(environment.systemConfigPath ?? ccaSystemConfigPath), "skills"),
    dotsSkillsRoot: ycodingDotsSkillsRoot(environment.dataDirectory),
  }
}

async function existingDirectoryTree(fs: CcaCapabilityFileSystem, directory: string, ctx: CcaRpcHandlerContext): Promise<CcaCapabilityTree | undefined> {
  let tree: CcaCapabilityTree
  try {
    tree = await fs.openReadTree({ path: uri(directory) }, ctx)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  try {
    if ((await tree.getMetadata({ path: uri(directory) })).isDirectory) return tree
  } catch (error) {
    await tree.release().catch(() => {})
    if (isNotFound(error)) return undefined
    throw error
  }
  await tree.release().catch(() => {})
  return undefined
}

type CacheEntryKind = "directory" | "file" | "other"

const TRAVERSAL_LIMIT = "plugin cache traversal limit reached"

async function cacheEntries(tree: CcaCapabilityTree, directory: string) {
  let listing: Awaited<ReturnType<CcaCapabilityTree["readDirectory"]>>
  try {
    listing = await tree.readDirectory({ path: uri(directory) })
  } catch (error) {
    throw new Error(`failed to scan plugin cache path ${uri(directory)}: ${ioText(error)}`, { cause: error })
  }
  const entries: { readonly name: string; readonly kind: CacheEntryKind }[] = []
  for (const entry of listing.entries) {
    if (entry.isDirectory) entries.push({ name: entry.fileName, kind: "directory" })
    else if (entry.isFile) entries.push({ name: entry.fileName, kind: "file" })
    else {
      const followed = await tree.getMetadata({ path: uri(path.join(directory, entry.fileName)) }).catch(() => undefined)
      if (followed !== undefined) entries.push({ name: entry.fileName, kind: followed.isDirectory ? "directory" : followed.isFile ? "file" : "other" })
    }
  }
  return entries.sort((left, right) => compareBytes(left.name, right.name))
}

async function cachePackages(tree: CcaCapabilityTree, cache: string, warnings: string[]) {
  const packages = new Map<string, string>()
  const marketplaces: string[] = []
  let directories = 1
  let entriesSeen = 0
  let truncated = false
  walk: for (const [depth, level] of [[0, [cache]], [1, marketplaces]] as const) {
    for (const directory of level) {
      for (const entry of await cacheEntries(tree, directory)) {
        if (entriesSeen === MAX_CACHE_WALK_ENTRIES) {
          truncated = true
          break walk
        }
        entriesSeen++
        if (entry.kind !== "directory") continue
        const child = path.join(directory, entry.name)
        if (depth === 1) {
          const marketplace = path.basename(directory)
          if (validPluginSegment(entry.name, true) && validPluginSegment(marketplace, false)) packages.set(`${entry.name}@${marketplace}`, child)
        } else if (directories === MAX_CACHE_WALK_DIRECTORIES) truncated = true
        else {
          directories++
          marketplaces.push(child)
        }
      }
    }
  }
  if (truncated) warnings.push(TRAVERSAL_LIMIT)
  return packages
}

async function readRemotePluginId(tree: CcaCapabilityTree, packageRoot: string): Promise<string | null> {
  let data: string
  try {
    data = (await tree.readFile({ path: uri(path.join(packageRoot, REMOTE_PLUGIN_INSTALL_METADATA_FILE)) })).dataBase64
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  const bytes = Buffer.from(data, "base64")
  if (bytes.length > MAX_REMOTE_INSTALL_METADATA_BYTES) throw new Error("remote installation metadata exceeds its byte limit")
  return parseRemotePluginId(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}

async function discoverCachedPlugins(tree: CcaCapabilityTree, cache: string): Promise<{ locations: CapabilityLocation[]; warnings: string[] }> {
  const warnings: string[] = []
  const locations: CapabilityLocation[] = []
  const packages = await cachePackages(tree, cache, warnings)
  for (const id of [...packages.keys()].sort(compareBytes)) {
    const packageRoot = packages.get(id)!
    const listing = await tree.readDirectory({ path: uri(packageRoot) }).catch(() => undefined)
    if (listing === undefined) continue
    const version = ccaActivePluginVersion(listing.entries.filter((entry) => entry.isDirectory).map((entry) => entry.fileName))
    if (version === undefined) continue
    if (locations.length === MAX_LOCATIONS) {
      warnings.push(`plugin cache reached its ${MAX_LOCATIONS}-location limit`)
      break
    }
    let remotePluginId: string | null = null
    try {
      remotePluginId = await readRemotePluginId(tree, packageRoot)
    } catch (error) {
      warnings.push(`could not read remote installation metadata for ${id}: ${errorMessage(error)}`)
    }
    locations.push({ root: uri(path.join(packageRoot, version)), standaloneRootId: null, plugin: { id, version, remotePluginId } })
  }
  return { locations, warnings }
}

async function prewarmLocations(fs: CcaCapabilityFileSystem, request: CapabilityLocationRequest, ctx: CcaRpcHandlerContext): Promise<CapabilityLocations> {
  const cache = path.join(request.codexHome, PLUGINS_CACHE_DIR)
  const standalone: { readonly id: string; readonly root: string }[] = []
  for (const [id, root] of [
    ["codex-home-skills", path.join(request.codexHome, "skills")],
    ...(request.userHome === null ? [] : [["user-agent-skills", path.join(request.userHome, AGENTS_SKILLS_SUFFIX)]]),
    ["system-skills", request.systemSkillsRoot],
    ["ycoding-dots-skills", request.dotsSkillsRoot],
  ] as const) {
    if (!standalone.some((existing) => uri(existing.root) === uri(root))) standalone.push({ id, root })
  }
  const watches: CcaCapabilityWatchPath[] = []
  const trees: { readonly tree: CcaCapabilityTree; readonly root: string; readonly id: string | null }[] = []
  try {
    for (const candidate of [{ id: null, root: cache }, ...standalone]) {
      const tree = await existingDirectoryTree(fs, candidate.root, ctx)
      watches.push({ path: candidate.root, recursive: true })
      if (tree !== undefined) trees.push({ tree, root: candidate.root, id: candidate.id })
    }
    const result: CapabilityLocations = { locations: [], watches, warnings: [] }
    for (const candidate of trees) {
      if (candidate.id === null) {
        const cached = await discoverCachedPlugins(candidate.tree, candidate.root)
        result.locations.push(...cached.locations)
        result.warnings.push(...cached.warnings)
      } else result.locations.push({ root: uri(candidate.root), standaloneRootId: candidate.id, plugin: null })
    }
    if (result.locations.length > MAX_LOCATIONS) {
      result.warnings.splice(MAX_LOCATION_WARNINGS - 1)
      result.warnings.push(`capability discovery reached its ${MAX_LOCATIONS}-location limit`)
      result.locations.splice(MAX_LOCATIONS)
    }
    result.warnings.splice(MAX_LOCATION_WARNINGS)
    return result
  } finally {
    await Promise.all(trees.map(({ tree }) => tree.release().catch(() => {})))
  }
}

type DiscoveredSource = { readonly kind: "plugin"; readonly plugin: CcaExecutorPlugin } | { readonly kind: "skills"; readonly skills: readonly CcaExecutorSkill[] }

interface CapabilityDiscovery {
  readonly content: DiscoveredSource
  readonly warnings: readonly string[]
}

const emptyDiscovery = (warnings: readonly string[] = []): CapabilityDiscovery => ({ content: { kind: "skills", skills: [] }, warnings })

function parseRoot(location: CapabilityLocation, discovery: CcaCapabilityRootDiscovery): CapabilityDiscovery {
  const warnings = [...discovery.warnings, ...(discovery.error === null ? [] : [discovery.error])]
  if (location.plugin !== null && discovery.plugin === null) {
    warnings.push(`installed plugin at ${location.root} has no readable manifest`)
    return emptyDiscovery(warnings)
  }
  const namespaces = new Map<string, string>()
  for (const manifest of discovery.namespaceManifests) {
    const owner = path.dirname(path.dirname(native(manifest.path)))
    const parsed = manifestName(manifest.contents)
    if (parsed === undefined) continue
    const name = trim(parsed).length === 0 ? path.basename(owner) : parsed
    if (name.length === 0) continue
    if (!namespaces.has(owner)) namespaces.set(owner, name)
  }
  const skills: CcaExecutorSkill[] = []
  skill: for (const file of discovery.skills) {
    const skillPath = native(file.instructions.path)
    const parsed = parseCcaSkillFrontmatter(file.instructions.contents, () => {
      const name = collapse(path.basename(path.dirname(skillPath)))
      return name.length === 0 ? "skill" : name
    })
    if (parsed instanceof Error) {
      warnings.push(`invalid skill metadata at ${file.instructions.path}: ${parsed.message}`)
      continue
    }
    let namespace: string | undefined
    for (let ancestor = path.dirname(skillPath); ; ancestor = path.dirname(ancestor)) {
      const name = namespaces.get(ancestor)
      if (name !== undefined) {
        if (Math.min(charCount(name), MAX_QUALIFIED_NAME_LEN + 1) + 1 + charCount(parsed.name) > MAX_QUALIFIED_NAME_LEN) {
          warnings.push(`invalid skill metadata at ${file.instructions.path}: qualified name exceeds ${MAX_QUALIFIED_NAME_LEN} characters`)
          continue skill
        }
        namespace = name
        break
      }
      if (path.dirname(ancestor) === ancestor) break
    }
    const metadata = file.metadata === null ? undefined : parseCcaSkillMetadata(file.metadata.contents)
    const resolved = metadata === undefined || metadata instanceof Error ? { dependencies: null, policy: null } : metadata
    skills.push({
      name: namespace === undefined ? parsed.name : `${namespace}:${parsed.name}`,
      description: parsed.description,
      shortDescription: parsed.shortDescription,
      path: file.instructions.path,
      ...(location.standaloneRootId === null ? {} : { discoveryRoot: { id: location.standaloneRootId, path: location.root } }),
      dependencies: resolved.dependencies,
      policy: resolved.policy,
    })
  }
  if (location.plugin === null || discovery.plugin === null) return { content: { kind: "skills", skills }, warnings }
  const files = discovery.plugin
  const manifest = pluginManifestMetadata(files.manifest.contents)
  if (manifest === undefined) {
    warnings.push(`invalid plugin manifest at ${files.manifest.path}`)
    return emptyDiscovery(warnings)
  }
  const name = trim(manifest.name).length === 0 ? path.basename(native(location.root)) || manifest.name : manifest.name
  const displayName = manifest.displayName === undefined || trim(manifest.displayName).length === 0 ? name : trim(manifest.displayName)
  let mcpConfig: CcaCapabilityTextFile | null = files.mcpConfig
  if (mcpConfig === null) {
    if (manifest.mcpServers?.kind === "object") mcpConfig = { path: files.manifest.path, contents: stringifyJson(manifest.mcpServers) }
    else if (manifest.mcpServers?.kind === "string")
      warnings.push(`plugin \`${location.plugin.id}\` at ${location.root} declares an MCP configuration file, but discovery returned no contents`)
  }
  if (files.appsConfig === null && manifest.apps !== undefined)
    warnings.push(`plugin \`${location.plugin.id}\` at ${location.root} declares an Apps configuration file, but discovery returned no contents`)
  return {
    content: {
      kind: "plugin",
      plugin: {
        id: location.plugin.id,
        displayName,
        remotePluginId: location.plugin.remotePluginId,
        version: location.plugin.version,
        root: location.root,
        files: { manifest: files.manifest, mcpConfig, appsConfig: files.appsConfig },
        skills,
      },
    },
    warnings,
  }
}

async function loadCapabilityDiscovery(
  fs: CcaCapabilityFileSystem,
  location: CapabilityLocation,
  sandbox: Readonly<Record<string, unknown>> | undefined,
  ctx: CcaRpcHandlerContext,
): Promise<CapabilityDiscovery> {
  const inspect = (error: unknown) =>
    isNotFound(error) || isPermissionDenied(error) ? emptyDiscovery() : emptyDiscovery([`could not inspect capability root ${location.root}: ${ioText(error)}`])
  let tree: CcaCapabilityTree
  try {
    tree = await fs.openReadTree(sandbox === undefined ? { path: location.root } : { path: location.root, sandbox }, ctx)
  } catch (error) {
    return inspect(error)
  }
  try {
    try {
      if (!(await tree.getMetadata({ path: location.root })).isDirectory) return emptyDiscovery()
    } catch (error) {
      return inspect(error)
    }
    const opened: CcaCapabilityFileSystem = { openReadTree: async () => ({ ...tree, release: async () => {} }) }
    const { roots } = await discoverCcaCapabilityRoots(opened, { roots: [{ id: location.plugin?.id ?? "", path: location.root }] }, ctx)
    return parseRoot(location, roots[0])
  } finally {
    await tree.release().catch(() => {})
  }
}

interface ResponseBudget {
  capabilities: number
  bytes: number
  truncated: boolean
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

function admit(budget: ResponseBudget, capabilities: number, bytes: number) {
  if (budget.capabilities + capabilities > MAX_CAPABILITIES || budget.bytes + bytes > MAX_RESPONSE_BYTES) {
    budget.truncated = true
    return false
  }
  budget.capabilities += capabilities
  budget.bytes += bytes
  return true
}

interface MutableResponse {
  plugins: CcaExecutorPlugin[]
  skills: CcaExecutorSkill[]
  warnings: string[]
}

function appendDiscovery(response: MutableResponse, discovery: CapabilityDiscovery, budget: ResponseBudget) {
  response.warnings.push(...discovery.warnings.slice(0, Math.max(0, MAX_WARNINGS - response.warnings.length)))
  if (discovery.content.kind === "plugin") {
    const remaining = MAX_CAPABILITIES - budget.capabilities
    if (remaining === 0) {
      budget.truncated = true
      return
    }
    const source = discovery.content.plugin
    if (source.skills.length > remaining - 1) budget.truncated = true
    const plugin = { ...source, skills: source.skills.slice(0, remaining - 1) }
    if (admit(budget, 1 + plugin.skills.length, jsonBytes(plugin))) response.plugins.push(plugin)
    return
  }
  for (const skill of discovery.content.skills) {
    if (budget.capabilities === MAX_CAPABILITIES) {
      budget.truncated = true
      break
    }
    if (admit(budget, 1, jsonBytes(skill))) response.skills.push(skill)
  }
}

function finishResponse(response: MutableResponse, truncated: boolean): CcaDiscoverV2CapabilitiesResult {
  response.plugins.sort((left, right) => compareBytes(left.id, right.id) || compareBytes(left.root, right.root))
  response.warnings.splice(MAX_WARNINGS)
  if (truncated || jsonBytes(response) > MAX_RESPONSE_BYTES) {
    response.warnings.splice(MAX_WARNINGS - 1)
    response.warnings.unshift(SIZE_LIMIT_REACHED)
    while (jsonBytes(response) > MAX_RESPONSE_BYTES) {
      if (response.warnings.length > 1) response.warnings.splice(1)
      else if (response.skills.pop() === undefined && response.plugins.pop() === undefined) break
    }
  }
  return { plugins: response.plugins, skills: response.skills, warnings: response.warnings }
}

async function loadCapabilityDiscoveries(
  fs: CcaCapabilityFileSystem,
  locations: CapabilityLocations,
  sandbox: Readonly<Record<string, unknown>> | undefined,
  ctx: CcaRpcHandlerContext,
): Promise<CcaDiscoverV2CapabilitiesResult> {
  const response: MutableResponse = { plugins: [], skills: [], warnings: locations.warnings.length > 0 ? [LOCATIONS_INCOMPLETE] : [] }
  const budget: ResponseBudget = { capabilities: 0, bytes: 0, truncated: false }
  const pending: Promise<CapabilityDiscovery>[] = []
  const launch = (until: number) => {
    while (pending.length < Math.min(until, locations.locations.length)) {
      const loading = loadCapabilityDiscovery(fs, locations.locations[pending.length], sandbox, ctx)
      loading.catch(() => {})
      pending.push(loading)
    }
  }
  for (let index = 0; index < locations.locations.length; index++) {
    launch(index + MAX_CONCURRENT_LOCATIONS)
    const discovery = await pending[index]
    appendDiscovery(response, discovery.warnings.length > 0 ? { ...discovery, warnings: [METADATA_INCOMPLETE] } : discovery, budget)
    if ((budget.capabilities === MAX_CAPABILITIES || budget.bytes === MAX_RESPONSE_BYTES) && index + 1 < locations.locations.length) {
      budget.truncated = true
      break
    }
  }
  return finishResponse(response, budget.truncated)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value ?? null)
}

interface CachedSandboxDiscovery {
  readonly key: string
  response: Promise<CcaDiscoverV2CapabilitiesResult> | undefined
}

interface LocationState {
  dirty: boolean
  readonly locations: CapabilityLocations
  readonly discoveries: CachedSandboxDiscovery[]
  readonly subscription: CcaCapabilityWatchSubscription | undefined
}

export function createCcaCapabilityDiscoveryV2(options: CcaCapabilityDiscoveryV2Options): CcaCapabilityDiscoveryV2 {
  const watcher = options.watcher === undefined ? nodeCcaCapabilityWatcher : options.watcher
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
  const listeners = new Set<(change: CcaCapabilityDiscoveryV2Change) => void>()
  let request: CapabilityLocationRequest | undefined
  let state: LocationState | undefined
  let refresh: Promise<unknown> = Promise.resolve()
  let closed = false
  let nextAllowed = 0
  let pendingPaths: Set<string> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const deliver = (paths: Iterable<string>) => {
    if (closed) return
    if (state !== undefined) state.dirty = true
    const change = { paths: [...new Set(paths)].sort(comparePaths) }
    for (const listener of listeners) listener(change)
  }

  const onChange = (paths: readonly string[]) => {
    if (closed) return
    if (pendingPaths !== undefined) {
      for (const changed of paths) pendingPaths.add(changed)
      return
    }
    const now = Date.now()
    if (now >= nextAllowed) {
      nextAllowed = now + throttleMs
      deliver(paths)
      return
    }
    pendingPaths = new Set(paths)
    timer = setTimeout(() => {
      timer = undefined
      const coalesced = pendingPaths ?? new Set<string>()
      pendingPaths = undefined
      nextAllowed = Date.now() + throttleMs
      deliver(coalesced)
    }, nextAllowed - now)
    timer.unref?.()
  }

  const register = (locations: CapabilityLocations): CcaCapabilityWatchSubscription | undefined => {
    if (watcher === null) return undefined
    try {
      return watcher(locations.watches, onChange)
    } catch {
      return undefined
    }
  }

  const usable = (): LocationState | undefined =>
    state !== undefined && state.subscription?.registered === true && !state.dirty ? state : undefined

  const currentLocations = async (locationRequest: CapabilityLocationRequest, ctx: CcaRpcHandlerContext): Promise<LocationState> => {
    const ready = usable()
    if (ready !== undefined) return ready
    const run = refresh.then(async () => {
      const settled = usable()
      if (settled !== undefined) return settled
      let locations: CapabilityLocations
      try {
        locations = await prewarmLocations(options.fs, locationRequest, ctx)
      } catch (error) {
        if (state !== undefined) return state
        throw error
      }
      const next: LocationState = { dirty: false, locations, discoveries: [], subscription: closed ? undefined : register(locations) }
      state?.subscription?.close()
      state = next
      return next
    })
    refresh = run.catch(() => {})
    return run
  }

  const discover = async (params: unknown, ctx: CcaRpcHandlerContext): Promise<CcaDiscoverV2CapabilitiesResult> => {
    if (closed) throw new CcaRpcError(-32603, "capability discovery closed")
    const decoded = decodeCcaDiscoverV2Params(params)
    try {
      request ??= await resolveLocationRequest(options.environment)
      const current = await currentLocations(request, ctx)
      const load = () => loadCapabilityDiscoveries(options.fs, current.locations, decoded.sandbox, ctx)
      if (current.subscription?.registered !== true) return await load()
      const key = decoded.sandbox === undefined ? "" : canonicalJson(decoded.sandbox)
      let entry = current.discoveries.find((discovery) => discovery.key === key)
      if (entry === undefined) {
        entry = { key, response: undefined }
        if (current.discoveries.length === MAX_CACHED_SANDBOX_CONTEXTS) current.discoveries.shift()
        current.discoveries.push(entry)
      }
      const cached = entry
      if (cached.response === undefined) {
        const loading = load()
        cached.response = loading
        loading.catch(() => {
          if (cached.response === loading) cached.response = undefined
        })
      }
      return await cached.response
    } catch (error) {
      throw new CcaRpcError(-32603, ioText(error))
    }
  }

  return {
    discover,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: async () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pendingPaths = undefined
      listeners.clear()
      state?.subscription?.close()
    },
  }
}

function nearestExisting(target: string): string | undefined {
  for (let candidate = target; ; candidate = path.dirname(candidate)) {
    try {
      statSync(candidate)
      return candidate
    } catch {}
    if (path.dirname(candidate) === candidate) return undefined
  }
}

function sameFile(left: string, right: string) {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

export const createNodeCcaCapabilityWatcher = (watchFile: typeof watch): CcaCapabilityWatcher => (paths, onChange) => {
  const handles = new Map<string, FSWatcher>()
  let registered = true
  let closed = false
  const unique = [...new Map(paths.map((watchPath) => [`${watchPath.recursive}:${watchPath.path}`, watchPath])).values()]
  const arm = (requested: CcaCapabilityWatchPath) => {
    const key = `${requested.recursive}:${requested.path}`
    handles.get(key)?.close()
    handles.delete(key)
    if (closed) return
    const actual = nearestExisting(requested.path)
    if (actual === undefined) {
      registered = false
      return
    }
    const direct = actual === requested.path || sameFile(actual, requested.path)
    try {
      const handle = watchFile(actual, { recursive: direct && requested.recursive, persistent: false }, (_event, filename) => {
        if (closed) return
        const moved = nearestExisting(requested.path) !== actual
        if (direct) onChange([filename === null ? requested.path : path.join(requested.path, filename)])
        else if (moved) onChange([requested.path])
        if (moved) arm(requested)
      })
      handle.on("error", () => {
        if (!closed) {
          onChange([requested.path])
          arm(requested)
        }
      })
      handles.set(key, handle)
    } catch {
      registered = false
    }
  }
  for (const requested of unique) arm(requested)
  return {
    get registered() { return registered && !closed },
    close: () => {
      closed = true
      for (const handle of handles.values()) handle.close()
      handles.clear()
    },
  }
}

export const nodeCcaCapabilityWatcher = createNodeCcaCapabilityWatcher(watch)
