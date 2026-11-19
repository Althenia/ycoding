import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendAppLog } from "../app-log"
import { BackendController } from "../backend-controller"
import { DesktopError } from "../contract"
import { saveSessionExport } from "../export-file"
import {
  assertCanonicalIsolatedPaths,
  installIsolatedBrowserViewGuard,
  resolveIsolatedTestConfig,
  validateIsolatedPreferences,
  validateIsolatedSelection,
} from "../isolated-mode"
import { readPreferences, savePreferences, validateSelection } from "../preferences"
import { buildDesktopApplicationMenu, createDesktopRPC, DESKTOP_NAVIGATION_RULES, DESKTOP_RPC_MAX_REQUEST_TIME, forwardDesktopEvent, menuActionFromEvent, startDesktopConnection, type DesktopRPCSchema } from "../rpc"
import { checkForUpdates, installUpdate, resolveAppBundlePath } from "../updater"
import { clampDesktopWindowFrame, DESKTOP_DEFAULT_WINDOW_HEIGHT, DESKTOP_DEFAULT_WINDOW_WIDTH, enforceNativeWindowMinimumSize } from "../window-bounds"

const isolated = resolveIsolatedTestConfig({ argv: process.argv.slice(2), env: process.env, realHome: os.homedir() })
if (isolated.enabled) await assertCanonicalIsolatedPaths(isolated, os.homedir())

const resources = process.env.YCODING_DESKTOP_RESOURCES ?? path.resolve(import.meta.dir, "../runtime")
let rpc: ReturnType<typeof import("electrobun/bun").BrowserView.defineRPC<DesktopRPCSchema>>
const preferencesPath = isolated.enabled
  ? isolated.preferencesPath
  : (process.env.YCODING_DESKTOP_PREFERENCES ?? path.join(os.homedir(), "Library/Application Support/app.ycoding.desktop/backend-preferences.json"))
if (!path.isAbsolute(resources) || !path.isAbsolute(preferencesPath)) throw new Error("Native resource and preference paths must be absolute.")
const logPath = path.join(path.dirname(preferencesPath), "desktop.log")
const log = (line: string) => { console.error(line); void appendAppLog(logPath, line) }
const currentVersion = await fs.readFile(path.join(resources, "backend.json"), "utf8").then((text) => {
  const version: unknown = JSON.parse(text)?.version
  return typeof version === "string" && version ? version : "0.0.0"
}, () => "0.0.0").catch(() => "0.0.0")
const preferences = await readPreferences(preferencesPath)
if (isolated.enabled) validateIsolatedPreferences(preferences, isolated)

const appBundlePath = resolveAppBundlePath(process.execPath) ?? resolveAppBundlePath(resources)
const startup = new AbortController()
const readNative = <T>(operation: () => T): T | null => {
  try { return operation() } catch { return null }
}
const pickDirectory = isolated.enabled
  ? async () => null
  : async (startingFolder?: string) => {
      const selected = await Electrobun.Utils.openFileDialog({ startingFolder: startingFolder || os.homedir(), canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false })
      return selected[0]?.trim() ? selected[0] : null
    }
const controller = isolated.enabled
  ? new BackendController(resources, {
      cwd: isolated.root,
      env: isolated.backendEnv,
      editor: { read: async () => ({ status: "disabled" }), close: () => {} },
      openEditor: async () => ({ kind: "fallback", notice: "External editor is disabled in isolated test mode." }),
      log,
      onState: (state) => rpc.send.state(state),
      onEvent: (event) => forwardDesktopEvent(event, rpc.send),
    })
  : new BackendController(resources, {
      cwd: os.homedir(),
      log,
      onState: (state) => rpc.send.state(state),
      onEvent: (event) => forwardDesktopEvent(event, rpc.send),
    })
const requests = createDesktopRPC(controller, {
  path: preferencesPath,
  read: readPreferences,
  save: savePreferences,
  validate: isolated.enabled ? (input) => validateIsolatedSelection(validateSelection(input), isolated) : validateSelection,
}, {
  pickDirectory,
  saveExport: (exported, current) => saveSessionExport(exported, current, { pickDirectory }),
  openExternal: isolated.enabled
    ? () => false
    : (url) => {
        if (new URL(url).protocol !== "https:") return false
        return Electrobun.Utils.openExternal(url)
      },
  readClipboard: () => {
    const png = readNative(() => Electrobun.Utils.clipboardReadImage())
    return {
      text: readNative(() => Electrobun.Utils.clipboardReadText()),
      imageBase64: png ? Buffer.from(png).toString("base64") : null,
      formats: readNative(() => Electrobun.Utils.clipboardAvailableFormats()) ?? [],
    }
  },
  writeClipboard: (text) => { Electrobun.Utils.clipboardWriteText(text) },
  quit: () => { startup.abort(); Electrobun.Utils.quit() },
  notify: isolated.enabled
    ? () => {}
    : ({ kind, silent }) => Electrobun.Utils.showNotification({ title: "YCoding", body: kind === "request" ? "A Session is waiting for your decision." : kind === "complete" ? "A Session finished running." : "A Session failed. Open YCoding to review it.", silent }),
  checkForUpdates: isolated.enabled
    ? async () => ({
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        releaseUrl: "",
        publishedAt: "",
        releaseNotes: "",
        canInstall: false,
        cannotInstallReason: "Updates are disabled in isolated test mode.",
      })
    : () => checkForUpdates({ currentVersion, appBundlePath }),
  installUpdate: isolated.enabled
    ? async () => { throw new DesktopError("Updates are disabled in isolated test mode.") }
    : ({ version } = {}) => installUpdate({
        currentVersion,
        ...(version === undefined ? {} : { targetVersion: version }),
        appBundlePath,
        relaunch: async (bundlePath) => {
          await requests.disconnect().catch(() => undefined)
          spawn("/usr/bin/open", ["-n", bundlePath], { detached: true, stdio: "ignore" }).unref()
          Electrobun.Utils.quit()
        },
      }),
})
const { default: Electrobun, BrowserWindow, BrowserView, ApplicationMenu } = await import("electrobun/bun")
const isolatedViewGuard = isolated.enabled ? installIsolatedBrowserViewGuard(BrowserView, isolated.partition) : undefined
const rendererRequests = {
  ...requests,
  connect: (input: Parameters<typeof requests.connect>[0]) => { startup.abort(); return requests.connect(input) },
  disconnect: () => { startup.abort(); return requests.disconnect() },
}
rpc = BrowserView.defineRPC<DesktopRPCSchema>({ maxRequestTime: DESKTOP_RPC_MAX_REQUEST_TIME, handlers: { requests: rendererRequests } })
ApplicationMenu.setApplicationMenu(buildDesktopApplicationMenu("YCoding Desktop"))
ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const action = menuActionFromEvent(event)
  if (action) rpc.send.menuAction(action)
})

let closed = false
let quitting = false
Electrobun.events.on("before-quit", (event: { response: { allow: boolean } }) => {
  startup.abort()
  if (closed) return
  event.response = { allow: false }
  if (quitting) return
  quitting = true
  void requests.disconnect().catch((error: unknown) => { log(`Desktop backend shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`) }).finally(() => { closed = true; Electrobun.Utils.quit() })
})
const frame = clampDesktopWindowFrame({
  x: 80,
  y: 80,
  width: isolated.enabled ? isolated.frame.width : DESKTOP_DEFAULT_WINDOW_WIDTH,
  height: isolated.enabled ? isolated.frame.height : DESKTOP_DEFAULT_WINDOW_HEIGHT,
})
const window = new BrowserWindow({
  title: "YCoding Desktop",
  url: null,
  frame,
  titleBarStyle: "default",
  rpc,
})
if (isolatedViewGuard) isolatedViewGuard.verifyWindow(window)
enforceNativeWindowMinimumSize(window)
window.webview.setNavigationRules([...DESKTOP_NAVIGATION_RULES])
window.webview.loadURL("views://mainview/index.html")
void startDesktopConnection(preferences, (selection) => controller.connect(selection), log, { signal: startup.signal })
