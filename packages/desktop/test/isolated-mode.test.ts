import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertCanonicalIsolatedPaths,
  installIsolatedBrowserViewGuard,
  resolveIsolatedTestConfig,
  validateIsolatedPreferences,
  validateIsolatedSelection,
} from "../src/isolated-mode"
import { clampDesktopWindowFrame } from "../src/window-bounds"

function baseEnv(root: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: "/usr/bin:/bin",
    YCODING_DESKTOP_ISOLATED_TEST: "1",
    YCODING_DESKTOP_ISOLATED_ROOT: root,
    YCODING_DESKTOP_PREFERENCES: path.join(root, "preferences.json"),
    YCODING_CHANNEL: "isolated-desktop-test",
    TMPDIR: path.join(root, "tmp"),
    YCODING_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    YCODING_DB: path.join(root, "runtime.db"),
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_DISABLE_AUTOUPDATE: "1",
    YCODING_DISABLE_PROJECT_CONFIG: "1",
    ...overrides,
  }
}

const realHome = "/Users/synthetic-user"
const tempRoot = "/tmp/ycoding-desktop-isolated-fixture"

test("returns disabled when isolated test flags and env are absent", () => {
  expect(resolveIsolatedTestConfig({ argv: ["bun", "index.js"], env: { PATH: "/usr/bin" }, realHome })).toEqual({ enabled: false })
})

test("rejects malformed opt-in values and unisolated smoke flags", () => {
  for (const value of ["", "0", "true", "yes"]) {
    expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot, { YCODING_DESKTOP_ISOLATED_TEST: value }), realHome })).toThrow()
  }
  expect(() => resolveIsolatedTestConfig({ argv: ["--smoke"], env: { PATH: "/usr/bin" }, realHome })).toThrow()
  expect(() => resolveIsolatedTestConfig({ argv: [], env: { PATH: "/usr/bin", YCODING_DESKTOP_TEST_SMOKE: "1" }, realHome })).toThrow()
})

test("requires isolated root, preferences, non-release channel, and confined state paths", () => {
  for (const key of [
    "YCODING_DESKTOP_ISOLATED_ROOT",
    "YCODING_DESKTOP_PREFERENCES",
    "YCODING_CHANNEL",
    "TMPDIR",
    "YCODING_TEST_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "YCODING_DB",
    "YCODING_DISABLE_MODELS_FETCH",
    "YCODING_DISABLE_AUTOUPDATE",
    "YCODING_DISABLE_PROJECT_CONFIG",
  ]) {
    expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot, { [key]: undefined }), realHome })).toThrow()
  }

  for (const channel of ["prod", "latest", "beta", "dev", "main", "isolated-", ""]) {
    expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot, { YCODING_CHANNEL: channel }), realHome })).toThrow()
  }

  for (const partition of ["", "persist:default", "persist:isolated", "default"]) {
    expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot, { YCODING_DESKTOP_ISOLATED_PARTITION: partition }), realHome })).toThrow()
  }
})

test("refuses isolated root or paths overlapping real home or live Library directories", () => {
  expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(path.join(realHome, "tmp-isolated")), realHome })).toThrow()
  expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(realHome), realHome })).toThrow()
  expect(() => resolveIsolatedTestConfig({
    argv: [],
    env: baseEnv(tempRoot, { YCODING_DESKTOP_PREFERENCES: path.join(realHome, "Library/Application Support/app.ycoding.desktop/backend-preferences.json") }),
    realHome,
  })).toThrow()
  expect(() => resolveIsolatedTestConfig({
    argv: [],
    env: baseEnv(tempRoot, { YCODING_DB: "/tmp/outside-root/runtime.db" }),
    realHome,
  })).toThrow()
})

test("canonical path check refuses symlinks resolving back inside real home", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ycd-iso-test-"))
  const fakeHome = path.join(base, "fake-home")
  const linkedRoot = path.join(base, "linked-root")
  const targetInHome = path.join(fakeHome, "Library/WebKit/app.ycoding.desktop")
  await fs.mkdir(targetInHome, { recursive: true })
  await fs.symlink(targetInHome, linkedRoot)
  try {
    const config = resolveIsolatedTestConfig({ argv: [], env: baseEnv(linkedRoot), realHome: fakeHome })
    expect(config.enabled).toBe(true)
    if (!config.enabled) throw new Error("expected enabled")
    const canonicalError = await assertCanonicalIsolatedPaths(config, fakeHome).then(() => undefined, (error: unknown) => error)
    expect(canonicalError).toBeInstanceOf(Error)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test("strips inherited credential-named env vars and confines backendEnv", () => {
  const config = resolveIsolatedTestConfig({
    argv: ["--isolated-test"],
    env: baseEnv(tempRoot, {
      YCODING_DESKTOP_ISOLATED_TEST: undefined,
      OPENAI_API_KEY: "sk-live-secret",
      ANTHROPIC_API_KEY: "sk-ant-live",
      YCODING_PASSWORD: "live-password",
      GITHUB_TOKEN: "ghp_live",
      SSH_AUTH_SOCK: "/tmp/live-ssh.sock",
      YCODING_DESKTOP_ISOLATED_PASSWORD: "synthetic-loopback-password",
      YCODING_CONFIG_CONTENT: '{"autoupdate":false}',
    }),
    realHome,
  })
  expect(config.enabled).toBe(true)
  if (!config.enabled) throw new Error("expected enabled")
  expect(config.partition).toBe("ephemeral")
  expect(config.backendEnv.HOME).toBe(path.join(tempRoot, "home"))
  expect(config.backendEnv.YCODING_CHANNEL).toBe("isolated-desktop-test")
  expect(config.backendEnv.YCODING_PASSWORD).toBe("synthetic-loopback-password")
  expect(config.backendEnv.OPENAI_API_KEY).toBeUndefined()
  expect(config.backendEnv.ANTHROPIC_API_KEY).toBeUndefined()
  expect(config.backendEnv.GITHUB_TOKEN).toBeUndefined()
  expect(config.backendEnv.SSH_AUTH_SOCK).toBeUndefined()
  expect(config.backendEnv.YCODING_CONFIG_CONTENT).toBe('{"autoupdate":false}')
})

test("isolated preferences and selections require explicit loopback shared or confined own backend", () => {
  const config = resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot, { YCODING_CONFIG_CONTENT: '{"autoupdate":false}' }), realHome })
  if (!config.enabled) throw new Error("expected enabled")

  expect(() => validateIsolatedPreferences({ error: "corrupt" }, config)).toThrow()
  expect(() => validateIsolatedPreferences({}, config)).toThrow()
  expect(() => validateIsolatedPreferences({ selection: { mode: "shared" } }, config)).toThrow()
  expect(() => validateIsolatedPreferences({ selection: { mode: "shared", server: "https://remote.example.test/" } }, config)).toThrow()
  expect(() => validateIsolatedSelection({ mode: "shared" }, config)).toThrow()
  expect(() => validateIsolatedSelection({ mode: "shared", server: "http://192.0.2.1:8080/" }, config)).toThrow()

  expect(validateIsolatedPreferences({ selection: { mode: "shared", server: "http://127.0.0.1:41234/" } }, config)).toEqual({ mode: "shared", server: "http://127.0.0.1:41234/" })
  expect(validateIsolatedPreferences({ selection: { mode: "own" } }, config)).toEqual({ mode: "own" })

  const ownWithoutConfig = resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot), realHome })
  if (!ownWithoutConfig.enabled) throw new Error("expected enabled")
  expect(() => validateIsolatedPreferences({ selection: { mode: "own" } }, ownWithoutConfig)).toThrow()
})

test("BrowserView guard forces ephemeral on the first and every created view and never initializes persist:default", () => {
  const initWebviewCalls: string[] = []
  let nextViewId = 1

  class FakeBrowserView {
    id = nextViewId++
    partition: string | null
    ptr: string
    constructor(options: { partition?: string | null } = {}) {
      this.partition = options.partition || null
      this.ptr = this.init()
    }
    init() {
      const forwarded = this.partition || "persist:default"
      initWebviewCalls.push(forwarded)
      return `webview:${this.id}:${forwarded}`
    }
  }

  class FakeBrowserWindow {
    webviewId: number
    webview: FakeBrowserView
    constructor() {
      const view = new FakeBrowserView({})
      this.webviewId = view.id
      this.webview = view
    }
  }

  const guard = installIsolatedBrowserViewGuard(FakeBrowserView, "ephemeral")
  const window = new FakeBrowserWindow()
  const extra = new FakeBrowserView({})

  expect(initWebviewCalls).toEqual(["ephemeral", "ephemeral"])
  expect(initWebviewCalls).not.toContain("persist:default")
  expect(guard.records).toEqual([
    { id: 1, partition: "ephemeral" },
    { id: 2, partition: "ephemeral" },
  ])
  expect(() => guard.verifyWindow(window)).not.toThrow()
  expect(extra.partition).toBe("ephemeral")

  expect(() => new FakeBrowserView({ partition: "persist:default" })).toThrow()
  expect(initWebviewCalls).not.toContain("persist:default")
  expect(() => guard.verifyWindow({ webview: { partition: "persist:default" } })).toThrow()
})

test("native entry wires isolated test mode before BrowserWindow creation and verifies view isolation before loading URL", async () => {
  const entry = await fs.readFile(path.join(import.meta.dir, "../src/bun/index.ts"), "utf8")
  const installIdx = entry.indexOf("installIsolatedBrowserViewGuard")
  const windowIdx = entry.indexOf("new BrowserWindow(")
  const verifyIdx = entry.indexOf("verifyWindow(")
  const loadIdx = entry.indexOf("loadURL(")
  expect(installIdx).toBeGreaterThan(-1)
  expect(windowIdx).toBeGreaterThan(installIdx)
  expect(verifyIdx).toBeGreaterThan(windowIdx)
  expect(loadIdx).toBeGreaterThan(verifyIdx)
  expect(entry).toContain("cwd: os.homedir()")
})

test("isolated mode supports bounded custom window dimensions while preserving default 1360x860", () => {
  const defaults = resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot), realHome })
  expect(defaults.enabled && defaults.frame).toEqual({ width: 1360, height: 860 })
  for (const invalid of [
    { YCODING_DESKTOP_ISOLATED_WIDTH: "200" },
    { YCODING_DESKTOP_ISOLATED_HEIGHT: "5000" },
    { YCODING_DESKTOP_ISOLATED_WIDTH: "700px" },
  ]) {
    expect(() => resolveIsolatedTestConfig({ argv: [], env: baseEnv(tempRoot, invalid), realHome })).toThrow()
  }
  const sized = resolveIsolatedTestConfig({
    argv: [],
    env: baseEnv(tempRoot, { YCODING_DESKTOP_ISOLATED_WIDTH: "1440", YCODING_DESKTOP_ISOLATED_HEIGHT: "900" }),
    realHome,
  })
  expect(sized.enabled && sized.frame).toEqual({ width: 1440, height: 900 })
  const floor = resolveIsolatedTestConfig({
    argv: [],
    env: baseEnv(tempRoot, { YCODING_DESKTOP_ISOLATED_WIDTH: "1000", YCODING_DESKTOP_ISOLATED_HEIGHT: "600" }),
    realHome,
  })
  expect(floor.enabled && floor.frame).toEqual({ width: 1000, height: 600 })
  const below = resolveIsolatedTestConfig({
    argv: [],
    env: baseEnv(tempRoot, { YCODING_DESKTOP_ISOLATED_WIDTH: "800", YCODING_DESKTOP_ISOLATED_HEIGHT: "480" }),
    realHome,
  })
  expect(below.enabled && clampDesktopWindowFrame({ x: 80, y: 80, ...below.frame })).toEqual({ x: 80, y: 80, width: 1000, height: 600 })
})
