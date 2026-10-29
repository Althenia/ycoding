import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import type { CcaFsGetMetadataResult, CcaFsReadDirectoryResult, CcaFsReadFileResult, CcaRpcHandlerContext } from "./cca-executor-rpc"
import { CcaRpcError } from "./cca-executor-rpc"

export interface CcaCapabilityRootRequest {
  readonly id: string
  readonly path: string
  readonly sandbox?: unknown
}

export interface CcaCapabilityRootsDiscoverParams {
  readonly roots: readonly CcaCapabilityRootRequest[]
}

export interface CcaCapabilityTextFile {
  readonly path: string
  readonly contents: string
}

export interface CcaDiscoveredPluginFiles {
  readonly manifest: CcaCapabilityTextFile
  readonly mcpConfig: CcaCapabilityTextFile | null
  readonly appsConfig: CcaCapabilityTextFile | null
}

export interface CcaDiscoveredSkillFiles {
  readonly instructions: CcaCapabilityTextFile
  readonly metadata: CcaCapabilityTextFile | null
}

export interface CcaCapabilityRootDiscovery {
  readonly id: string
  readonly path: string
  readonly plugin: CcaDiscoveredPluginFiles | null
  readonly skills: readonly CcaDiscoveredSkillFiles[]
  readonly namespaceManifests: readonly CcaCapabilityTextFile[]
  readonly warnings: readonly string[]
  readonly error: string | null
}

export interface CcaCapabilityRootsDiscoverResult {
  readonly roots: readonly CcaCapabilityRootDiscovery[]
}

export interface CcaCapabilityTree {
  readonly getMetadata: (params: { readonly path: string }) => Promise<CcaFsGetMetadataResult>
  readonly readDirectory: (params: { readonly path: string }) => Promise<CcaFsReadDirectoryResult>
  readonly readFile: (params: { readonly path: string }) => Promise<CcaFsReadFileResult>
  readonly release: () => Promise<void>
}

export interface CcaCapabilityFileSystem {
  readonly openReadTree: (params: { readonly path: string; readonly sandbox?: unknown }, ctx: CcaRpcHandlerContext) => Promise<CcaCapabilityTree>
}

export const ccaMaxCapabilityRootsPerRequest = 128
const MAX_SCAN_DEPTH = 6
const MAX_DIRECTORIES_PER_ROOT = 2_000
const MAX_ENTRIES_PER_ROOT = 20_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_BUNDLE_BYTES_PER_ROOT = 16 * 1024 * 1024
const MAX_CONCURRENT_ROOTS = 8
const SKILL_FILE_NAME = "SKILL.md"
const SKILL_METADATA_PATH = "agents/openai.yaml"
const DEFAULT_MCP_CONFIG_PATH = ".mcp.json"
const DEFAULT_APP_CONFIG_PATH = ".app.json"
const PLUGIN_MANIFEST_PATHS = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]

function errorCode(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined
}

const OS_ERROR_TEXT: Readonly<Record<string, string>> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOTDIR: "Not a directory",
  ELOOP: "Too many levels of symbolic links",
}

function errorText(error: unknown) {
  const code = errorCode(error)
  if (code === -32600 && error instanceof Error && error.message === "Permission denied") return "Operation not permitted (os error 1)"
  const errno: Readonly<Record<string, number | undefined>> = os.constants.errno
  if (typeof code === "string" && OS_ERROR_TEXT[code] !== undefined && errno[code] !== undefined) return `${OS_ERROR_TEXT[code]} (os error ${errno[code]})`
  return error instanceof Error ? error.message : String(error)
}

const uri = (native: string) => CcaPolicy.toPathUri(native)

const byteOrder = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right))

function cancelled(): never {
  throw new CcaRpcError(-32603, "capability root discovery cancelled")
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) cancelled()
}

function continuationByte(byte: number | undefined) {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf
}

function utf8Error(bytes: Uint8Array): string | undefined {
  const invalid = (index: number, length: number) => `invalid utf-8 sequence of ${length} bytes from index ${index}`
  const incomplete = (index: number) => `incomplete utf-8 byte sequence from index ${index}`
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index]
    if (first < 0x80) {
      index++
      continue
    }
    const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
    if (width === 0) return invalid(index, 1)
    const second = bytes[index + 1]
    if (second === undefined) return incomplete(index)
    const [low, high] =
      first === 0xe0 ? [0xa0, 0xbf] : first === 0xed ? [0x80, 0x9f] : first === 0xf0 ? [0x90, 0xbf] : first === 0xf4 ? [0x80, 0x8f] : [0x80, 0xbf]
    if (second < low || second > high) return invalid(index, 1)
    for (let offset = 2; offset < width; offset++) {
      if (index + offset >= bytes.length) return incomplete(index)
      if (!continuationByte(bytes[index + offset])) return invalid(index, offset)
    }
    index += width
  }
  return undefined
}

type Budget = { bytes: number }

const MAX_WALK_RESPONSE_BYTES = 4 * 1024 * 1024
const WALK_RESPONSE_ITEM_OVERHEAD_BYTES = 64
const READ_CHUNK_BASE64_CHARS = 64 * 1024

class RootScan {
  readonly warnings: string[] = []
  private readonly budget: Budget = { bytes: 0 }

  constructor(
    private readonly tree: CcaCapabilityTree,
    private readonly signal: AbortSignal,
  ) {}

  metadata(native: string) {
    checkCancelled(this.signal)
    return this.tree.getMetadata({ path: uri(native) })
  }

  directory(native: string) {
    checkCancelled(this.signal)
    return this.tree.readDirectory({ path: uri(native) })
  }

  private async identity(native: string) {
    checkCancelled(this.signal)
    const resolved = await realpath(native)
    checkCancelled(this.signal)
    return resolved
  }

  async walk(root: string): Promise<{ readonly files: string[]; readonly truncated: boolean }> {
    const files: string[] = []
    let truncated = false
    let responseBytes = 0
    const reserve = (bytes: number) => {
      responseBytes += bytes + WALK_RESPONSE_ITEM_OVERHEAD_BYTES
      if (responseBytes <= MAX_WALK_RESPONSE_BYTES) return true
      truncated = true
      return false
    }
    const walkError = (native: string, error: unknown) => {
      const item = `failed to scan capability path ${uri(native)}: ${errorText(error)}`
      if (!reserve(Buffer.byteLength(uri(native)) + Buffer.byteLength(errorText(error)))) return false
      this.warnings.push(item)
      return true
    }
    const visited = new Set([await this.identity(root)])
    let directories = 1
    let entries = 0
    const pending: { readonly dir: string; readonly depth: number }[] = [{ dir: root, depth: 0 }]
    while (pending.length > 0) {
      const { dir, depth } = pending.shift()!
      let listing: CcaFsReadDirectoryResult
      try {
        listing = await this.directory(dir)
      } catch (error) {
        checkCancelled(this.signal)
        if (!walkError(dir, error)) return { files, truncated }
        continue
      }
      checkCancelled(this.signal)
      for (const entry of [...listing.entries].sort((left, right) => byteOrder(left.fileName, right.fileName))) {
        checkCancelled(this.signal)
        if (entries === MAX_ENTRIES_PER_ROOT) return { files, truncated: true }
        entries++
        const child = path.join(dir, entry.fileName)
        if (!entry.isDirectory && !entry.isFile) {
          const followed = await this.metadata(child).catch(() => undefined)
          checkCancelled(this.signal)
          if (followed?.isDirectory !== true) continue
        }
        if (!reserve(Buffer.byteLength(uri(child)))) return { files, truncated }
        if (entry.isFile) {
          files.push(child)
          continue
        }
        if (depth >= MAX_SCAN_DEPTH) continue
        let identity: string
        try {
          identity = await this.identity(child)
        } catch (error) {
          checkCancelled(this.signal)
          if (!walkError(child, error)) return { files, truncated }
          continue
        }
        if (visited.has(identity)) continue
        visited.add(identity)
        if (directories === MAX_DIRECTORIES_PER_ROOT) {
          truncated = true
          continue
        }
        directories++
        pending.push({ dir: child, depth: depth + 1 })
      }
    }
    return { files, truncated }
  }

  async text(native: string): Promise<CcaCapabilityTextFile | null> {
    const fileUri = uri(native)
    let info: CcaFsGetMetadataResult
    try {
      info = await this.metadata(native)
    } catch (error) {
      checkCancelled(this.signal)
      if (errorCode(error) !== -32004) this.warnings.push(`failed to inspect capability file ${fileUri}: ${errorText(error)}`)
      return null
    }
    if (!info.isFile) return null
    if (info.size > MAX_FILE_BYTES) {
      this.warnings.push(`capability file ${fileUri} exceeds the ${MAX_FILE_BYTES}-byte limit`)
      return null
    }
    if (this.budget.bytes + info.size > MAX_BUNDLE_BYTES_PER_ROOT) {
      this.warnings.push(`capability root bundle exceeds the ${MAX_BUNDLE_BYTES_PER_ROOT}-byte limit`)
      return null
    }
    let encoded: string
    try {
      checkCancelled(this.signal)
      encoded = (await this.tree.readFile({ path: fileUri })).dataBase64
    } catch (error) {
      checkCancelled(this.signal)
      this.warnings.push(`failed to read capability file ${fileUri}: ${errorText(error)}`)
      return null
    }
    checkCancelled(this.signal)
    const chunks: Buffer[] = []
    let length = 0
    for (let offset = 0; offset < encoded.length; offset += READ_CHUNK_BASE64_CHARS) {
      const chunk = Buffer.from(encoded.slice(offset, offset + READ_CHUNK_BASE64_CHARS), "base64")
      if (length + chunk.length > MAX_FILE_BYTES || this.budget.bytes + length + chunk.length > MAX_BUNDLE_BYTES_PER_ROOT) {
        this.warnings.push(`capability file ${fileUri} exceeded its read limit`)
        return null
      }
      chunks.push(chunk)
      length += chunk.length
    }
    const bytes = Buffer.concat(chunks, length)
    const invalid = utf8Error(bytes)
    if (invalid !== undefined) {
      this.warnings.push(`capability file ${fileUri} is not UTF-8: ${invalid}`)
      return null
    }
    this.budget.bytes += bytes.length
    return { path: fileUri, contents: bytes.toString("utf8") }
  }

  async firstManifest(dir: string): Promise<CcaCapabilityTextFile | null> {
    for (const relative of PLUGIN_MANIFEST_PATHS) {
      const manifest = await this.text(path.join(dir, relative))
      if (manifest !== null) return manifest
    }
    return null
  }
}

function manifestPriority(native: string): number | undefined {
  if (path.basename(native) !== "plugin.json") return undefined
  const directory = path.basename(path.dirname(native))
  const index = PLUGIN_MANIFEST_PATHS.findIndex((relative) => relative === `${directory}/plugin.json`)
  return index === -1 ? undefined : index
}

function pluginRoot(native: string) {
  return path.dirname(path.dirname(native))
}

function declaredPath(root: string, field: string, value: unknown, manifestPath: string, warnings: string[]): string | undefined {
  if (typeof value !== "string") return undefined
  if (!value.startsWith("./")) {
    warnings.push(`ignoring ${field} in ${manifestPath}: path must start with \`./\``)
    return undefined
  }
  const relative = value.slice(2)
  if (relative.length === 0 || relative.split(/[/\\]/).some((component) => component === "..")) {
    warnings.push(`ignoring ${field} in ${manifestPath}: path must remain below the capability root`)
    return undefined
  }
  const joined = path.join(root, relative)
  if (joined !== root && !joined.startsWith(`${root}${path.sep}`)) {
    warnings.push(`ignoring ${field} in ${manifestPath}: path must remain below the capability root`)
    return undefined
  }
  return joined
}

async function discoverRoot(fs: CcaCapabilityFileSystem, request: CcaCapabilityRootRequest, ctx: CcaRpcHandlerContext): Promise<CcaCapabilityRootDiscovery> {
  const result = (fields: Partial<CcaCapabilityRootDiscovery>): CcaCapabilityRootDiscovery => ({
    id: request.id,
    path: request.path,
    plugin: null,
    skills: [],
    namespaceManifests: [],
    warnings: [],
    error: null,
    ...fields,
  })
  let root: string
  try {
    root = CcaPolicy.parsePathUri(request.path)
  } catch (error) {
    return result({ error: `failed to inspect capability root ${request.path}: ${errorText(error)}` })
  }
  checkCancelled(ctx.signal)
  let tree: CcaCapabilityTree
  try {
    tree = await fs.openReadTree(request.sandbox === undefined ? { path: request.path } : { path: request.path, sandbox: request.sandbox }, ctx)
  } catch (error) {
    checkCancelled(ctx.signal)
    return result({ error: `failed to inspect capability root ${request.path}: ${errorText(error)}` })
  }
  try {
    return await scanRoot(new RootScan(tree, ctx.signal), root, request, result, ctx.signal)
  } finally {
    await tree.release().catch(() => {})
  }
}

async function scanRoot(
  scan: RootScan,
  root: string,
  request: CcaCapabilityRootRequest,
  result: (fields: Partial<CcaCapabilityRootDiscovery>) => CcaCapabilityRootDiscovery,
  signal: AbortSignal,
): Promise<CcaCapabilityRootDiscovery> {
  try {
    const info = await scan.metadata(root)
    if (!info.isDirectory) return result({ error: `capability root ${request.path} is not a directory` })
  } catch (error) {
    checkCancelled(signal)
    return result({ error: `failed to inspect capability root ${request.path}: ${errorText(error)}` })
  }
  let walk: Awaited<ReturnType<RootScan["walk"]>>
  try {
    walk = await scan.walk(root)
  } catch (error) {
    checkCancelled(signal)
    return result({ error: `failed to scan capability root ${request.path}: ${errorText(error)}` })
  }
  if (walk.truncated) scan.warnings.push(`capability scan reached its traversal limit (root: ${request.path})`)
  const skillPaths = walk.files.filter((file) => path.basename(file) === SKILL_FILE_NAME).sort((left, right) => byteOrder(uri(left), uri(right)))
  const manifestPaths = walk.files
    .filter((file) => manifestPriority(file) !== undefined)
    .sort((left, right) => {
      const leftRoot = uri(pluginRoot(left))
      const rightRoot = uri(pluginRoot(right))
      if (leftRoot !== rightRoot) return byteOrder(leftRoot, rightRoot)
      return manifestPriority(left)! - manifestPriority(right)!
    })

  const rootManifest = await scan.firstManifest(root)
  let inherited = rootManifest
  if (inherited === null) {
    for (let ancestor = path.dirname(root); inherited === null; ancestor = path.dirname(ancestor)) {
      inherited = await scan.firstManifest(ancestor)
      if (path.dirname(ancestor) === ancestor) break
    }
  }
  const namespaceManifests: CcaCapabilityTextFile[] = []
  const seenRoots = new Set<string>()
  if (inherited !== null) {
    seenRoots.add(pluginRoot(CcaPolicy.parsePathUri(inherited.path)))
    namespaceManifests.push(inherited)
  }
  for (const manifestPath of manifestPaths) {
    const owner = pluginRoot(manifestPath)
    if (seenRoots.has(owner)) continue
    seenRoots.add(owner)
    const manifest = await scan.text(manifestPath)
    if (manifest !== null) namespaceManifests.push(manifest)
  }

  let plugin: CcaDiscoveredPluginFiles | null = null
  if (rootManifest !== null) {
    let declarations: { mcpServers?: unknown; apps?: unknown } = {}
    try {
      const parsed: unknown = JSON.parse(rootManifest.contents)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) declarations = parsed as typeof declarations
    } catch {}
    const mcpInline = declarations.mcpServers !== null && typeof declarations.mcpServers === "object" && !Array.isArray(declarations.mcpServers)
    const mcpDeclared = declaredPath(root, "mcpServers", declarations.mcpServers, rootManifest.path, scan.warnings)
    const appsDeclared = declaredPath(root, "apps", declarations.apps, rootManifest.path, scan.warnings)
    const mcpPath = mcpInline ? undefined : (mcpDeclared ?? path.join(root, DEFAULT_MCP_CONFIG_PATH))
    plugin = {
      manifest: rootManifest,
      mcpConfig: mcpPath === undefined ? null : await scan.text(mcpPath),
      appsConfig: await scan.text(appsDeclared ?? path.join(root, DEFAULT_APP_CONFIG_PATH)),
    }
  }

  const skills: CcaDiscoveredSkillFiles[] = []
  for (const skillPath of skillPaths) {
    const instructions = await scan.text(skillPath)
    if (instructions === null) continue
    skills.push({ instructions, metadata: await scan.text(path.join(path.dirname(skillPath), SKILL_METADATA_PATH)) })
  }
  return result({ plugin, skills, namespaceManifests, warnings: scan.warnings })
}

export async function discoverCcaCapabilityRoots(
  fs: CcaCapabilityFileSystem,
  params: CcaCapabilityRootsDiscoverParams,
  ctx: CcaRpcHandlerContext,
): Promise<CcaCapabilityRootsDiscoverResult> {
  if (params.roots.length > ccaMaxCapabilityRootsPerRequest)
    throw new CcaRpcError(-32600, `capability root discovery accepts at most ${ccaMaxCapabilityRootsPerRequest} roots`)
  const roots: CcaCapabilityRootDiscovery[] = []
  let next = 0
  checkCancelled(ctx.signal)
  const worker = async () => {
    while (next < params.roots.length) {
      checkCancelled(ctx.signal)
      const index = next++
      roots[index] = await discoverRoot(fs, params.roots[index], ctx)
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(MAX_CONCURRENT_ROOTS, params.roots.length) }, worker))
  const failed = settled.find((outcome) => outcome.status === "rejected")
  if (failed !== undefined) throw failed.reason
  return { roots }
}
