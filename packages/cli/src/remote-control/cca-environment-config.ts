import { lstat, readFile, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import { CcaRpcError } from "./cca-executor-rpc"
import { mergeToml, parseToml, projectToml, stringifyToml, tomlTable, TomlParseError, type TomlTable, type TomlValue } from "./cca-toml"

export interface CcaEnvironmentConfigReadParams {
  readonly cwd: string
  readonly configPaths: readonly (readonly string[])[]
  readonly requirementsPaths: readonly (readonly string[])[]
}

export interface CcaEnvironmentConfigLayer {
  readonly source: string
  readonly baseDir: string
  readonly toml: string
}

export interface CcaEnvironmentConfigLayerStack {
  readonly layers: readonly CcaEnvironmentConfigLayer[]
  readonly cloudInsertionIndex: number
}

export interface CcaEnvironmentConfigReadResult {
  readonly userHomeDir: string | null
  readonly codexHomeDir: string
  readonly hostname: string | null
  readonly config: CcaEnvironmentConfigLayerStack
  readonly requirements: CcaEnvironmentConfigLayerStack
}

export interface CcaEnvironmentConfigOptions {
  readonly homeDirectory: string
  readonly codexHomeEnv?: string
  readonly systemConfigPath?: string
  readonly systemRequirementsPath?: string
  readonly managedConfigPath?: string
  readonly hostname?: () => string
}

export const ccaSystemConfigPath = "/etc/codex/config.toml"
export const ccaSystemRequirementsPath = "/etc/codex/requirements.toml"
export const ccaManagedConfigPath = "/etc/codex/managed_config.toml"

const CONFIG_TOML_FILE = "config.toml"
const PROJECT_LOCAL_CONFIG_DENYLIST = [
  "openai_base_url",
  "chatgpt_base_url",
  "apps_mcp_product_sku",
  "responses_api_metadata",
  "model_provider",
  "model_providers",
  "notify",
  "profile",
  "profiles",
  "experimental_realtime_webrtc_call_base_url",
  "experimental_realtime_ws_base_url",
  "otel",
]

type Layer = { readonly source: string; readonly baseDir: string; readonly toml: TomlValue }
type Stack = { readonly layers: readonly Layer[]; readonly cloudInsertionIndex: number }
type TrustLevel = "trusted" | "untrusted"

class LoadError extends Error {}

function code(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined
}

function ioMessage(error: unknown) {
  if (code(error) === "ENOENT") return "No such file or directory (os error 2)"
  if (code(error) === "EACCES" || code(error) === "EPERM") return "Permission denied (os error 13)"
  if (code(error) === "EISDIR") return "Is a directory (os error 21)"
  if (code(error) === "ENOTDIR") return "Not a directory (os error 20)"
  return error instanceof Error ? error.message : String(error)
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }
}

function parseFile(file: string, contents: string): TomlTable {
  try {
    return parseToml(contents)
  } catch (error) {
    if (error instanceof TomlParseError) throw new LoadError(`${file}:${error.line}:${error.column}: ${error.detail}`)
    throw error
  }
}

async function requiredLayer(file: string): Promise<TomlTable> {
  let contents: string | undefined
  try {
    contents = await readText(file)
  } catch (error) {
    throw new LoadError(`Failed to read config file ${file}: ${ioMessage(error)}`)
  }
  return contents === undefined ? tomlTable() : parseFile(file, contents)
}

async function isDirectory(file: string) {
  return stat(file).then((info) => info.isDirectory(), () => false)
}

async function exists(file: string) {
  return stat(file).then(() => true, () => false)
}

async function canonical(file: string) {
  return realpath(file).catch(() => file)
}

function ancestors(dir: string): string[] {
  const out = [dir]
  for (let current = dir; path.dirname(current) !== current; current = path.dirname(current)) out.push(path.dirname(current))
  return out
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return value?.kind === "table" ? value : undefined
}

function projectRootMarkers(config: TomlTable): string[] {
  const markers = config.entries.get("project_root_markers")
  if (markers === undefined) return [".git"]
  if (markers.kind !== "array" || markers.items.some((item) => item.kind !== "string"))
    throw new LoadError("project_root_markers must be an array of strings")
  return markers.items.map((item) => (item.kind === "string" ? item.value : ""))
}

function projectsTrust(config: TomlTable): Map<string, TrustLevel> {
  const out = new Map<string, TrustLevel>()
  const projects = config.entries.get("projects")
  if (projects === undefined) return out
  if (projects.kind !== "table") throw new LoadError("invalid type: projects, expected a map")
  for (const [key, project] of projects.entries) {
    if (project.kind !== "table") throw new LoadError(`invalid type: projects.${key}, expected a map`)
    const level = project.entries.get("trust_level")
    if (level === undefined) continue
    if (level.kind !== "string" || (level.value !== "trusted" && level.value !== "untrusted"))
      throw new LoadError(`unknown variant for projects.${key}.trust_level, expected \`trusted\` or \`untrusted\``)
    out.set(key, level.value)
  }
  return out
}

async function trustKeys(dir: string): Promise<string[]> {
  const resolved = await canonical(dir)
  return resolved === dir ? [dir] : [resolved, dir]
}

async function gitMarker(dir: string): Promise<boolean> {
  const marker = path.join(dir, ".git")
  const info = await stat(marker).catch(() => undefined)
  if (info === undefined) return false
  return !info.isDirectory() || (await exists(path.join(marker, "HEAD")))
}

async function discoverProjectRoot(cwd: string, markers: readonly string[]): Promise<string | undefined> {
  if (markers.length === 0) return undefined
  for (const ancestor of ancestors(cwd)) {
    for (const marker of markers) {
      if (marker === ".git" ? await gitMarker(ancestor) : await exists(path.join(ancestor, marker))) return ancestor
    }
  }
  return undefined
}

async function gitCheckoutRoot(cwd: string): Promise<string | undefined> {
  const base = (await isDirectory(cwd)) ? cwd : path.dirname(cwd)
  for (const dir of ancestors(base)) if (await gitMarker(dir)) return dir
  return undefined
}

const MAX_GIT_METADATA_FILE_BYTES = 64 * 1024

async function metadata(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (info === undefined) return undefined
  const link = await lstat(file).catch(() => undefined)
  return { isDirectory: info.isDirectory(), isFile: info.isFile(), isSymlink: link?.isSymbolicLink() === true, size: info.size }
}

const trimAscii = (text: string) => text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")

async function readGitMetadataFile(file: string): Promise<string | undefined> {
  const info = await metadata(file)
  if (info === undefined || !info.isFile || info.isSymlink || info.size > MAX_GIT_METADATA_FILE_BYTES) return undefined
  const bytes = await readFile(file).catch(() => undefined)
  return bytes === undefined || bytes.length > MAX_GIT_METADATA_FILE_BYTES ? undefined : bytes.toString("utf8")
}

async function readGitdirFile(file: string): Promise<string | undefined> {
  const contents = trimAscii((await readGitMetadataFile(file)) ?? "")
  if (!contents.startsWith("gitdir:")) return undefined
  const target = trimAscii(contents.slice("gitdir:".length))
  return target === "" ? undefined : path.resolve(path.dirname(file), target)
}

const canonicalOrUndefined = (file: string) => realpath(file).catch(() => undefined)

async function gitRepoRoot(cwd: string): Promise<string | undefined> {
  let base: string | undefined = (await metadata(cwd))?.isDirectory ? cwd : parent(cwd)
  let repoRoot: string | undefined
  while (repoRoot === undefined) {
    if (base === undefined) return undefined
    let candidate: string | undefined
    for (const dir of ancestors(base)) {
      if ((await metadata(path.join(dir, ".git"))) !== undefined) {
        candidate = dir
        break
      }
    }
    if (candidate === undefined) return undefined
    const dotGit = await metadata(path.join(candidate, ".git"))
    if (dotGit === undefined) return undefined
    if (!dotGit.isDirectory || (await metadata(path.join(candidate, ".git", "HEAD"))) !== undefined) repoRoot = candidate
    else base = parent(candidate)
  }
  const dotGitPath = path.join(repoRoot, ".git")
  const dotGit = await metadata(dotGitPath)
  if (dotGit === undefined) return undefined
  if (dotGit.isDirectory) return repoRoot
  if (!dotGit.isFile || dotGit.isSymlink || dotGit.size > MAX_GIT_METADATA_FILE_BYTES) return undefined
  const gitDir = await readGitdirFile(dotGitPath)
  if (gitDir === undefined) return undefined
  const gitDirInfo = await metadata(gitDir)
  if (gitDirInfo === undefined || !gitDirInfo.isDirectory || gitDirInfo.isSymlink) return undefined
  const canonicalGitDir = await canonicalOrUndefined(gitDir)
  if (canonicalGitDir === undefined || path.basename(path.dirname(canonicalGitDir)) !== "worktrees") return undefined
  const commonDir = path.dirname(path.dirname(canonicalGitDir))
  const [worktreeGitdir, commondir] = await Promise.all([
    readGitMetadataFile(path.join(canonicalGitDir, "gitdir")),
    readGitMetadataFile(path.join(canonicalGitDir, "commondir")),
  ])
  const registeredDotGit = trimAscii(worktreeGitdir ?? "")
  const linkedCommon = trimAscii(commondir ?? "")
  if (registeredDotGit === "" || linkedCommon === "") return undefined
  const worktreeDotGit = path.resolve(canonicalGitDir, registeredDotGit)
  if (path.basename(worktreeDotGit) !== ".git") return undefined
  const [registeredCheckout, checkout, linkedCommonDir] = await Promise.all([
    canonicalOrUndefined(path.dirname(worktreeDotGit)),
    canonicalOrUndefined(repoRoot),
    canonicalOrUndefined(path.resolve(canonicalGitDir, linkedCommon)),
  ])
  if (registeredCheckout === undefined || registeredCheckout !== checkout || linkedCommonDir !== commonDir) return undefined
  const mainRoot = path.dirname(path.dirname(path.dirname(gitDir)))
  const mainDotGit = path.join(mainRoot, ".git")
  const mainInfo = await metadata(mainDotGit)
  if (mainInfo === undefined) return undefined
  const mainGitDir = mainInfo.isDirectory ? mainDotGit : await readGitdirFile(mainDotGit)
  if (mainGitDir === undefined || (await canonicalOrUndefined(mainGitDir)) !== commonDir) return undefined
  return mainRoot
}

function parent(dir: string): string | undefined {
  const up = path.dirname(dir)
  return up === dir ? undefined : up
}

function hooksFolderForDir(dir: string, checkout: string | undefined, repo: string | undefined): string | undefined {
  if (checkout === undefined || repo === undefined || checkout === repo) return undefined
  const relative = path.relative(checkout, dir)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return path.join(repo, relative, ".codex")
}

function lookup(trust: Map<string, TrustLevel>, keys: readonly string[]): TrustLevel | undefined {
  for (const key of keys) {
    const level = trust.get(key)
    if (level !== undefined) return level
  }
  return undefined
}

type BrokerState = "unconfigured" | "disabled" | "enabled"
type Broker = { readonly state: BrokerState; readonly providerEnvKeys: readonly string[] }

const CREDENTIAL_BROKER_PROVIDER_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "OPENAI_API_KEY", "OPENAI_BASE_URL"]

const asciiLower = (text: string) => text.replace(/[A-Z]/g, (char) => char.toLowerCase())
const envKeysMatch = (left: string, right: string) => left === right || (process.platform === "win32" && asciiLower(left) === asciiLower(right))

function sanitizeProjectConfig(config: TomlTable, broker: Broker): TomlTable {
  const out = tomlTable(config.entries)
  for (const key of PROJECT_LOCAL_CONFIG_DENYLIST) out.entries.delete(key)
  const configured = broker.state !== "unconfigured"
  const features = table(out.entries.get("features"))
  if (features !== undefined) {
    const nextFeatures = tomlTable(features.entries)
    if (broker.state === "enabled") nextFeatures.entries.delete("shell_snapshot")
    const multiAgent = table(nextFeatures.entries.get("multi_agent_v2"))
    if (multiAgent !== undefined && multiAgent.entries.has("message_board_remote")) {
      const next = tomlTable(multiAgent.entries)
      next.entries.delete("message_board_remote")
      nextFeatures.entries.set("multi_agent_v2", next)
    }
    for (const key of ["respect_system_proxy", "system_proxy_fallback", "credential_masking"]) nextFeatures.entries.delete(key)
    const networkProxy = nextFeatures.entries.get("network_proxy")
    if (configured && networkProxy?.kind === "boolean") nextFeatures.entries.delete("network_proxy")
    else if (networkProxy?.kind === "table") {
      const next = tomlTable(networkProxy.entries)
      next.entries.delete("credential_broker")
      next.entries.delete("credentials")
      if (configured) next.entries.delete("enabled")
      nextFeatures.entries.set("network_proxy", next)
    }
    out.entries.set("features", nextFeatures)
  }
  const policy = table(out.entries.get("shell_environment_policy"))
  if (broker.state === "enabled" && policy !== undefined) {
    const nextPolicy = tomlTable(policy.entries)
    nextPolicy.entries.delete("experimental_use_profile")
    const overrides = table(nextPolicy.entries.get("set"))
    if (overrides !== undefined) {
      const injected = (key: string) =>
        asciiLower(key) === "zdotdir" ||
        asciiLower(key) === "bash_env" ||
        CREDENTIAL_BROKER_PROVIDER_ENV_KEYS.some((candidate) => envKeysMatch(key, candidate)) ||
        broker.providerEnvKeys.some((candidate) => envKeysMatch(key, candidate))
      nextPolicy.entries.set("set", tomlTable([...overrides.entries].filter(([key]) => !injected(key))))
    }
    out.entries.set("shell_environment_policy", nextPolicy)
  }
  const tui = table(out.entries.get("tui"))
  const keymap = table(tui?.entries.get("keymap"))
  const chat = table(keymap?.entries.get("chat"))
  if (tui !== undefined && keymap !== undefined && chat !== undefined) {
    const nextChat = tomlTable(chat.entries)
    nextChat.entries.delete("previous_permission_mode")
    nextChat.entries.delete("next_permission_mode")
    out.entries.set("tui", tomlTable([...tui.entries, ["keymap", tomlTable([...keymap.entries, ["chat", nextChat]])]]))
  }
  return out
}

function credentialBroker(config: TomlTable): Broker {
  const networkProxy = table(table(config.entries.get("features"))?.entries.get("network_proxy"))
  const broker = networkProxy?.entries.get("credential_broker")
  const enabled = networkProxy?.entries.get("enabled")
  const state: BrokerState = broker?.kind !== "boolean" || !broker.value ? "unconfigured" : enabled?.kind === "boolean" && enabled.value ? "enabled" : "disabled"
  const providerEnvKeys: string[] = []
  for (const provider of table(networkProxy?.entries.get("credentials"))?.entries.values() ?? []) {
    if (provider.kind !== "table") continue
    const env = provider.entries.get("env")
    if (env?.kind === "array") for (const item of env.items) if (item.kind === "string") providerEnvKeys.push(item.value)
    const prefix = provider.entries.get("url_prefix_from_env")
    if (prefix?.kind === "string") providerEnvKeys.push(prefix.value)
  }
  return { state, providerEnvKeys }
}

const BROKER_REQUIREMENT_PATHS = [
  ["features", "network_proxy"],
  ["features", "credential_masking"],
  ["feature_requirements", "network_proxy"],
  ["feature_requirements", "credential_masking"],
  ["experimental_network", "enabled"],
]

type BrokerRequirements = { readonly features: ReadonlyMap<string, boolean>; readonly networkEnabled: boolean | undefined }

function brokerRequirements(layers: readonly Layer[]): BrokerRequirements {
  let merged = tomlTable()
  for (const layer of layers) {
    const projected = projectToml(layer.toml, BROKER_REQUIREMENT_PATHS)
    if (projected?.kind !== "table") continue
    const fail = (message: string): never => {
      throw new LoadError(`failed to parse requirements layer ${layer.source}: ${message}`)
    }
    if (projected.entries.has("features") && projected.entries.has("feature_requirements")) fail("duplicate field `features`")
    const regular = tomlTable(projected.entries)
    const aliased = regular.entries.get("feature_requirements")
    if (aliased !== undefined) {
      regular.entries.delete("feature_requirements")
      regular.entries.set("features", aliased)
    }
    const features = regular.entries.get("features")
    if (features !== undefined) {
      if (features.kind !== "table") fail(`invalid type: ${features.kind}, expected a map for key \`features\``)
      else
        for (const [key, value] of features.entries)
          if (value.kind !== "boolean") fail(`invalid type: ${value.kind}, expected a boolean for key \`features.${key}\``)
    }
    const network = regular.entries.get("experimental_network")
    if (network !== undefined) {
      if (network.kind !== "table") fail(`invalid type: ${network.kind}, expected struct NetworkRequirementsToml for key \`experimental_network\``)
      else {
        const enabled = network.entries.get("enabled")
        if (enabled !== undefined && enabled.kind !== "boolean") fail(`invalid type: ${enabled.kind}, expected a boolean for key \`experimental_network.enabled\``)
      }
    }
    merged = mergeToml(merged, regular)
  }
  const features = new Map<string, boolean>()
  for (const [key, value] of table(merged.entries.get("features"))?.entries ?? []) if (value.kind === "boolean") features.set(key, value.value)
  const enabled = table(merged.entries.get("experimental_network"))?.entries.get("enabled")
  return { features, networkEnabled: enabled?.kind === "boolean" ? enabled.value : undefined }
}

function applyBrokerRequirements(broker: Broker, requirements: BrokerRequirements, trusted: TomlTable): Broker {
  const trustedMasking = table(trusted.entries.get("features"))?.entries.get("credential_masking")
  const masking = requirements.features.get("credential_masking") ?? (trustedMasking?.kind === "boolean" && trustedMasking.value)
  if (!masking && broker.state === "unconfigured") return broker
  const enabled = masking || (requirements.features.get("network_proxy") ?? broker.state === "enabled")
  return { ...broker, state: enabled && requirements.networkEnabled !== false ? "enabled" : "disabled" }
}

async function readProjectFile(file: string, label: string): Promise<string | undefined> {
  try {
    return await readText(file)
  } catch (error) {
    throw new LoadError(`Failed to read ${label} ${file}: ${ioMessage(error)}`)
  }
}

async function rootCheckoutHooks(folder: string): Promise<TomlValue | undefined> {
  const file = path.join(folder, CONFIG_TOML_FILE)
  const contents = await readProjectFile(file, "project hooks config file")
  if (contents === undefined) return undefined
  try {
    return parseToml(contents).entries.get("hooks")
  } catch (error) {
    if (error instanceof TomlParseError) throw new LoadError(`Error parsing project hooks config file ${file}: ${error.message}`)
    throw error
  }
}

async function projectLayers(input: {
  readonly cwd: string
  readonly codexHome: string
  readonly discovery: TomlTable
  readonly requirements: readonly Layer[]
}): Promise<Layer[]> {
  const markers = projectRootMarkers(input.discovery)
  const trust = projectsTrust(input.discovery)
  const requirements = brokerRequirements(input.requirements)
  const projectRoot = (await discoverProjectRoot(input.cwd, markers)) ?? input.cwd
  const checkoutRoot = await gitCheckoutRoot(input.cwd)
  const repoRoot = await gitRepoRoot(input.cwd)
  const rootKeys = await trustKeys(projectRoot)
  const repoKeys = repoRoot === undefined ? [] : await trustKeys(repoRoot)
  const broker = applyBrokerRequirements(credentialBroker(input.discovery), requirements, input.discovery)
  const codexHome = await canonical(input.codexHome)
  const dirs: string[] = []
  for (const dir of ancestors(input.cwd)) {
    dirs.push(dir)
    if (dir === projectRoot) break
  }
  dirs.reverse()
  const layers: Layer[] = []
  for (const dir of dirs) {
    const dotCodex = path.join(dir, ".codex")
    if (!(await isDirectory(dotCodex))) continue
    if (dotCodex === input.codexHome || (await canonical(dotCodex)) === codexHome) continue
    const trusted = (lookup(trust, await trustKeys(dir)) ?? lookup(trust, rootKeys) ?? lookup(trust, repoKeys)) === "trusted"
    const file = path.join(dotCodex, CONFIG_TOML_FILE)
    const contents = await readProjectFile(file, "project config file")
    let config = tomlTable()
    if (contents !== undefined) {
      try {
        config = parseToml(contents)
      } catch (error) {
        if (!(error instanceof TomlParseError)) throw error
        if (trusted) throw new LoadError(`Error parsing project config file ${file}: ${error.message}`)
        continue
      }
    }
    if (!trusted) continue
    const sanitized = sanitizeProjectConfig(config, broker)
    const hooksFolder = hooksFolderForDir(dir, checkoutRoot, repoRoot)
    if (hooksFolder !== undefined) sanitized.entries.delete("hooks")
    layers.push({ source: `project (${dotCodex}/${CONFIG_TOML_FILE})`, baseDir: dotCodex, toml: sanitized })
    if (hooksFolder === undefined) continue
    const hooks = await rootCheckoutHooks(hooksFolder)
    if (hooks !== undefined) layers.push({ source: `project (${hooksFolder}/${CONFIG_TOML_FILE})`, baseDir: hooksFolder, toml: tomlTable([["hooks", hooks]]) })
  }
  return layers
}

function variantError(key: string, value: TomlValue, variants: readonly string[]): never {
  const expected = variants.map((variant) => `\`${variant}\``).join(", ")
  if (value.kind === "string") throw new LoadError(`Failed to parse config requirements as TOML: unknown variant \`${value.value}\` for \`${key}\`, expected one of ${expected}`)
  throw new LoadError(`Failed to parse config requirements as TOML: invalid type ${value.kind} for \`${key}\`, expected one of ${expected}`)
}

const GRANULAR_FIELDS = [
  ["sandbox_approval", true],
  ["rules", true],
  ["skill_approval", false],
  ["request_permissions", false],
  ["mcp_elicitations", true],
] as const

function legacyApprovalPolicy(value: TomlValue): TomlValue {
  const variants = ["untrusted", "on-request", "on-failure", "granular", "never"]
  if (value.kind === "string") {
    if (value.value === "on-failure" || value.value === "on-request") return { kind: "string", value: "on-request" }
    if (value.value === "untrusted" || value.value === "never") return value
    return variantError("approval_policy", value, variants)
  }
  const granular = value.kind === "table" && value.entries.size === 1 ? value.entries.get("granular") : undefined
  if (granular?.kind !== "table") return variantError("approval_policy", value, variants)
  const fields = GRANULAR_FIELDS.map(([field, required]): [string, TomlValue] => {
    const entry = granular.entries.get(field)
    if (entry === undefined) {
      if (required) throw new LoadError(`Failed to parse config requirements as TOML: missing field \`${field}\``)
      return [field, { kind: "boolean", value: false }]
    }
    if (entry.kind !== "boolean") throw new LoadError(`Failed to parse config requirements as TOML: invalid type ${entry.kind} for \`${field}\`, expected a boolean`)
    return [field, entry]
  })
  return tomlTable([["granular", tomlTable(fields)]])
}

const strings = (...values: string[]): TomlValue => ({ kind: "array", items: values.map((value) => ({ kind: "string", value })) })

function legacyRequirements(managed: TomlTable): TomlTable {
  const out = tomlTable()
  const approvalPolicy = managed.entries.get("approval_policy")
  if (approvalPolicy !== undefined) out.entries.set("allowed_approval_policies", { kind: "array", items: [legacyApprovalPolicy(approvalPolicy)] })
  const reviewer = managed.entries.get("approvals_reviewer")
  if (reviewer !== undefined) {
    if (reviewer.kind === "string" && reviewer.value === "user") out.entries.set("allowed_approvals_reviewers", strings("user"))
    else if (reviewer.kind === "string" && (reviewer.value === "auto_review" || reviewer.value === "guardian_subagent"))
      out.entries.set("allowed_approvals_reviewers", strings("auto_review", "user"))
    else variantError("approvals_reviewer", reviewer, ["user", "auto_review", "guardian_subagent"])
  }
  const sandboxMode = managed.entries.get("sandbox_mode")
  if (sandboxMode !== undefined) {
    if (sandboxMode.kind !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode.value))
      variantError("sandbox_mode", sandboxMode, ["read-only", "workspace-write", "danger-full-access"])
    out.entries.set("allowed_sandbox_modes", sandboxMode.value === "read-only" ? strings("read-only") : strings("read-only", sandboxMode.value))
  }
  return out
}

async function loadStacks(cwd: string, codexHome: string, options: CcaEnvironmentConfigOptions): Promise<{ config: Stack; requirements: Stack }> {
  const systemFile = options.systemConfigPath ?? ccaSystemConfigPath
  const userFile = path.join(codexHome, CONFIG_TOML_FILE)
  const managedFile = options.managedConfigPath ?? ccaManagedConfigPath
  const system = await requiredLayer(systemFile)
  const user = await requiredLayer(userFile)
  const managedText = await readText(managedFile).catch((error: unknown) => {
    throw new LoadError(`Failed to read managed config file ${managedFile}: ${ioMessage(error)}`)
  })
  const managed = managedText === undefined ? undefined : parseFile(managedFile, managedText)
  let discovery = mergeToml(system, user)
  if (managed !== undefined) discovery = mergeToml(discovery, managed)
  const requirementsFile = options.systemRequirementsPath ?? ccaSystemRequirementsPath
  const requirementsText = await readText(requirementsFile).catch((error: unknown) => {
    throw new LoadError(`Failed to read requirements file ${requirementsFile}: ${ioMessage(error)}`)
  })
  const requirementsLayers: Layer[] =
    requirementsText === undefined
      ? []
      : [{ source: requirementsFile, baseDir: path.dirname(requirementsFile), toml: parseFile(requirementsFile, requirementsText) }]
  if (managed !== undefined) requirementsLayers.push({ source: managedFile, baseDir: path.dirname(managedFile), toml: legacyRequirements(managed) })
  const configLayers: Layer[] = [
    { source: `system (${systemFile})`, baseDir: path.dirname(systemFile), toml: system },
    { source: `user (${userFile})`, baseDir: codexHome, toml: user },
    ...(await projectLayers({ cwd, codexHome, discovery, requirements: requirementsLayers })),
  ]
  if (managed !== undefined)
    configLayers.push({ source: `legacy managed_config.toml (${managedFile})`, baseDir: path.dirname(managedFile), toml: managed })
  return {
    config: { layers: configLayers, cloudInsertionIndex: 1 },
    requirements: { layers: requirementsLayers, cloudInsertionIndex: requirementsText === undefined ? 0 : 1 },
  }
}

function project(stack: Stack, paths: readonly (readonly string[])[]): CcaEnvironmentConfigLayerStack {
  const layers: CcaEnvironmentConfigLayer[] = []
  let cloudInsertionIndex = 0
  stack.layers.forEach((layer, index) => {
    const projected = projectToml(layer.toml, paths)
    if (projected === undefined || projected.kind !== "table") return
    if (index < stack.cloudInsertionIndex) cloudInsertionIndex++
    layers.push({ source: layer.source, baseDir: CcaPolicy.toPathUri(layer.baseDir), toml: stringifyToml(projected) })
  })
  return { layers, cloudInsertionIndex }
}

async function codexHome(options: CcaEnvironmentConfigOptions): Promise<string> {
  const value = options.codexHomeEnv
  if (value === undefined || value === "") return path.join(options.homeDirectory, ".codex")
  const info = await stat(value).catch((error: unknown) => {
    throw new CcaRpcError(
      -32603,
      code(error) === "ENOENT"
        ? `failed to find Codex home: CODEX_HOME points to ${JSON.stringify(value)}, but that path does not exist`
        : `failed to find Codex home: failed to read CODEX_HOME ${JSON.stringify(value)}: ${ioMessage(error)}`,
    )
  })
  if (!info.isDirectory())
    throw new CcaRpcError(-32603, `failed to find Codex home: CODEX_HOME points to ${JSON.stringify(value)}, but that path is not a directory`)
  return realpath(value)
}

export function ccaHostName(read: () => string = os.hostname): string | null {
  const name = read().trim().replace(/\.+$/, "")
  return name.length === 0 ? null : name.toLowerCase()
}

export async function readCcaEnvironmentConfig(
  params: CcaEnvironmentConfigReadParams,
  options: CcaEnvironmentConfigOptions,
): Promise<CcaEnvironmentConfigReadResult> {
  if (params.configPaths.length === 0 && params.requirementsPaths.length === 0)
    throw new CcaRpcError(-32602, "at least one config or requirements path is required")
  if ([...params.configPaths, ...params.requirementsPaths].some((item) => item.length === 0))
    throw new CcaRpcError(-32602, "TOML paths must contain at least one key segment")
  let cwd: string
  try {
    cwd = CcaPolicy.parsePathUri(params.cwd)
  } catch (error) {
    throw new CcaRpcError(-32602, error instanceof Error ? error.message : "invalid path URI")
  }
  const home = await codexHome(options)
  let stacks: { config: Stack; requirements: Stack }
  try {
    stacks = await loadStacks(cwd, home, options)
  } catch (error) {
    if (error instanceof LoadError) throw new CcaRpcError(-32603, `failed to load executor-local config: ${error.message}`)
    throw new CcaRpcError(-32603, `failed to load executor-local config: ${ioMessage(error)}`)
  }
  let userHomeDir: string | null = null
  try {
    userHomeDir = CcaPolicy.toPathUri(options.homeDirectory)
  } catch {}
  return {
    userHomeDir,
    codexHomeDir: CcaPolicy.toPathUri(home),
    hostname: ccaHostName(options.hostname),
    config: project(stacks.config, params.configPaths),
    requirements: project(stacks.requirements, params.requirementsPaths),
  }
}
