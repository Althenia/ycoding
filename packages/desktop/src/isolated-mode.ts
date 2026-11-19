import fs from "node:fs/promises"
import path from "node:path"
import { DesktopError, type Preferences, type Selection } from "./contract"

export type IsolatedTestConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly root: string
      readonly partition: "ephemeral"
      readonly preferencesPath: string
      readonly channel: string
      readonly frame: { readonly width: number; readonly height: number }
      readonly tmpDir: string
      readonly testHome: string
      readonly xdgCacheHome: string
      readonly xdgConfigHome: string
      readonly xdgDataHome: string
      readonly xdgStateHome: string
      readonly dbPath: string
      readonly backendEnv: Record<string, string>
    }

type IsolatedViewTarget = {
  readonly id?: number
  partition?: string | null
}

type IsolatedViewConstructor = {
  prototype: {
    init: (this: IsolatedViewTarget) => unknown
  }
}

const credentialPattern = /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SOCK)/i
const releaseChannels = new Set(["prod", "latest", "beta", "dev", "main"])
const isolatedChannelPattern = /^isolated-[a-z0-9][a-z0-9_-]*$/
const isolatedPartition = "ephemeral"

function isInside(target: string, parent: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isStrictlyInside(target: string, parent: string) {
  return path.resolve(target) !== path.resolve(parent) && isInside(target, parent)
}

function requireAbsolutePath(value: string | undefined, name: string) {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`Isolated Desktop test mode requires an absolute ${name}.`)
  }
  const normalized = path.resolve(value)
  if (normalized !== value.replace(/\/+$/, "") && value !== "/") {
    throw new Error(`Isolated Desktop test mode requires a normalized ${name}.`)
  }
  return normalized
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1"
}

function assertOutsideLiveHome(target: string, realHome: string, name: string) {
  const resolvedHome = path.resolve(realHome)
  if (isInside(target, resolvedHome) || isInside(resolvedHome, target)) {
    throw new Error(`Isolated Desktop test ${name} must be outside the real user home directory.`)
  }
  if (/\/Library(?:\/|$)/i.test(target)) {
    throw new Error(`Isolated Desktop test ${name} must not target a macOS Library directory.`)
  }
}

function requireInsideRoot(value: string | undefined, name: string, root: string, realHome: string) {
  const resolved = requireAbsolutePath(value, name)
  assertOutsideLiveHome(resolved, realHome, name)
  if (!isStrictlyInside(resolved, root)) {
    throw new Error(`Isolated Desktop test ${name} must reside inside YCODING_DESKTOP_ISOLATED_ROOT.`)
  }
  return resolved
}

function parseDimension(value: string | undefined, fallback: number, max: number, name: string) {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`Isolated Desktop test ${name} must be an integer between 320 and ${max}.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 320 || parsed > max) {
    throw new Error(`Isolated Desktop test ${name} must be an integer between 320 and ${max}.`)
  }
  return parsed
}

export function resolveIsolatedTestConfig(options: {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly realHome: string
}): IsolatedTestConfig {
  const envFlag = options.env.YCODING_DESKTOP_ISOLATED_TEST
  const argvFlag = options.argv.includes("--isolated-test")
  const smokeRequested = options.argv.includes("--smoke") || options.env.YCODING_DESKTOP_TEST_SMOKE !== undefined
  if (envFlag === undefined && !argvFlag && !smokeRequested) return { enabled: false }
  if (envFlag !== undefined && envFlag !== "1") {
    throw new Error("Invalid YCODING_DESKTOP_ISOLATED_TEST value; expected '1' for isolated test mode.")
  }
  if (smokeRequested && envFlag !== "1") {
    throw new Error("Isolated Desktop smoke requires YCODING_DESKTOP_ISOLATED_TEST=1 with verified ephemeral store and synthetic confinement.")
  }

  const realHome = requireAbsolutePath(options.realHome, "real home directory")
  const root = requireAbsolutePath(options.env.YCODING_DESKTOP_ISOLATED_ROOT, "YCODING_DESKTOP_ISOLATED_ROOT")
  assertOutsideLiveHome(root, realHome, "YCODING_DESKTOP_ISOLATED_ROOT")

  const partition = options.env.YCODING_DESKTOP_ISOLATED_PARTITION ?? isolatedPartition
  if (partition !== isolatedPartition) {
    throw new Error("Isolated Desktop test mode requires YCODING_DESKTOP_ISOLATED_PARTITION=ephemeral; persistent partitions are refused.")
  }

  const channel = options.env.YCODING_CHANNEL
  if (!channel || releaseChannels.has(channel) || !isolatedChannelPattern.test(channel)) {
    throw new Error("Isolated Desktop test mode requires a non-release YCODING_CHANNEL matching /^isolated-[a-z0-9][a-z0-9_-]*$/.")
  }

  const preferencesPath = requireInsideRoot(options.env.YCODING_DESKTOP_PREFERENCES, "YCODING_DESKTOP_PREFERENCES", root, realHome)
  const tmpDir = requireInsideRoot(options.env.TMPDIR, "TMPDIR", root, realHome)
  const testHome = requireInsideRoot(options.env.YCODING_TEST_HOME, "YCODING_TEST_HOME", root, realHome)
  const xdgCacheHome = requireInsideRoot(options.env.XDG_CACHE_HOME, "XDG_CACHE_HOME", root, realHome)
  const xdgConfigHome = requireInsideRoot(options.env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME", root, realHome)
  const xdgDataHome = requireInsideRoot(options.env.XDG_DATA_HOME, "XDG_DATA_HOME", root, realHome)
  const xdgStateHome = requireInsideRoot(options.env.XDG_STATE_HOME, "XDG_STATE_HOME", root, realHome)
  const dbPath = requireInsideRoot(options.env.YCODING_DB, "YCODING_DB", root, realHome)

  for (const name of ["YCODING_DISABLE_MODELS_FETCH", "YCODING_DISABLE_AUTOUPDATE", "YCODING_DISABLE_PROJECT_CONFIG"] as const) {
    if (options.env[name] !== "1") {
      throw new Error(`Isolated Desktop test mode requires ${name}=1.`)
    }
  }

  const backendEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined || credentialPattern.test(key)) continue
    if (["PATH", "LANG", "LC_ALL", "USER", "LOGNAME", "TERM", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"].includes(key)) {
      backendEnv[key] = value
    }
  }
  backendEnv.HOME = testHome
  backendEnv.TMPDIR = tmpDir
  backendEnv.YCODING_TEST_HOME = testHome
  backendEnv.XDG_CACHE_HOME = xdgCacheHome
  backendEnv.XDG_CONFIG_HOME = xdgConfigHome
  backendEnv.XDG_DATA_HOME = xdgDataHome
  backendEnv.XDG_STATE_HOME = xdgStateHome
  backendEnv.YCODING_DB = dbPath
  backendEnv.YCODING_CHANNEL = channel
  backendEnv.YCODING_DISABLE_MODELS_FETCH = "1"
  backendEnv.YCODING_DISABLE_AUTOUPDATE = "1"
  backendEnv.YCODING_DISABLE_PROJECT_CONFIG = "1"
  backendEnv.GIT_CONFIG_GLOBAL = "/dev/null"
  backendEnv.GIT_CONFIG_NOSYSTEM = "1"
  backendEnv.BUN_ENABLE_CRASH_REPORTING = "0"
  if (options.env.YCODING_CONFIG_CONTENT !== undefined) {
    backendEnv.YCODING_CONFIG_CONTENT = options.env.YCODING_CONFIG_CONTENT
  }
  if (options.env.YCODING_DESKTOP_ISOLATED_PASSWORD !== undefined) {
    backendEnv.YCODING_PASSWORD = options.env.YCODING_DESKTOP_ISOLATED_PASSWORD
  }

  const width = parseDimension(options.env.YCODING_DESKTOP_ISOLATED_WIDTH, 1360, 3840, "YCODING_DESKTOP_ISOLATED_WIDTH")
  const height = parseDimension(options.env.YCODING_DESKTOP_ISOLATED_HEIGHT, 860, 2160, "YCODING_DESKTOP_ISOLATED_HEIGHT")

  return {
    enabled: true,
    root,
    partition,
    preferencesPath,
    channel,
    frame: { width, height },
    tmpDir,
    testHome,
    xdgCacheHome,
    xdgConfigHome,
    xdgDataHome,
    xdgStateHome,
    dbPath,
    backendEnv,
  }
}

async function existingAncestorRealpath(target: string) {
  let current = path.resolve(target)
  while (true) {
    try {
      return await fs.realpath(current)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

export async function assertCanonicalIsolatedPaths(config: Extract<IsolatedTestConfig, { enabled: true }>, realHome: string) {
  const canonicalHome = await existingAncestorRealpath(realHome)
  for (const [name, target] of [
    ["YCODING_DESKTOP_ISOLATED_ROOT", config.root],
    ["YCODING_DESKTOP_PREFERENCES", config.preferencesPath],
    ["TMPDIR", config.tmpDir],
    ["YCODING_TEST_HOME", config.testHome],
    ["XDG_CACHE_HOME", config.xdgCacheHome],
    ["XDG_CONFIG_HOME", config.xdgConfigHome],
    ["XDG_DATA_HOME", config.xdgDataHome],
    ["XDG_STATE_HOME", config.xdgStateHome],
    ["YCODING_DB", config.dbPath],
  ] as const) {
    const resolved = await existingAncestorRealpath(target)
    assertOutsideLiveHome(resolved, canonicalHome, name)
  }
}

export function validateIsolatedSelection(selection: Selection, config: Extract<IsolatedTestConfig, { enabled: true }>): Selection {
  if (selection.mode === "own") {
    if (!config.backendEnv.YCODING_CONFIG_CONTENT?.trim()) {
      throw new DesktopError("Isolated own backend requires explicit synthetic YCODING_CONFIG_CONTENT.")
    }
    return selection
  }
  if (!selection.server) {
    throw new DesktopError("Isolated shared backend requires an explicit loopback server URL.")
  }
  const url = new URL(selection.server)
  if (!isLoopbackHost(url.hostname)) {
    throw new DesktopError("Isolated shared backend must target a loopback origin.")
  }
  return selection
}

export function validateIsolatedPreferences(preferences: Preferences, config: Extract<IsolatedTestConfig, { enabled: true }>): Selection {
  if (preferences.error) {
    throw new Error(`Isolated Desktop test mode refused invalid preferences: ${preferences.error}`)
  }
  if (!preferences.selection) {
    throw new Error("Isolated Desktop test mode requires explicit synthetic backend preferences; refusing live shared fallback.")
  }
  return validateIsolatedSelection(preferences.selection, config)
}

export function installIsolatedBrowserViewGuard(
  BrowserViewClass: IsolatedViewConstructor,
  partition: "ephemeral",
  onInit?: (record: { readonly id: number | undefined; readonly partition: string }) => void,
) {
  if (partition !== isolatedPartition) {
    throw new Error("Isolated Desktop test mode requires an ephemeral WebKit partition.")
  }
  const originalInit = BrowserViewClass.prototype.init
  const records: Array<{ readonly id: number | undefined; readonly partition: string }> = []
  BrowserViewClass.prototype.init = function isolatedViewInit(this: IsolatedViewTarget) {
    if (this.partition !== null && this.partition !== undefined && this.partition !== partition) {
      throw new Error(`Isolated Desktop test mode refused non-isolated WebKit partition '${this.partition}'.`)
    }
    this.partition = partition
    const record = { id: this.id, partition: this.partition }
    records.push(record)
    onInit?.(record)
    return originalInit.call(this)
  }

  return {
    records,
    verifyWindow(window: { readonly webview?: { readonly partition?: string | null } }) {
      if (records.length === 0 || records.some((entry) => entry.partition !== partition)) {
        throw new Error("Isolated Desktop test mode could not verify ephemeral WebKit partition on all created views.")
      }
      if (window.webview?.partition !== partition) {
        throw new Error(`Isolated Desktop test mode refused window WebKit partition '${String(window.webview?.partition)}'.`)
      }
    },
  }
}
