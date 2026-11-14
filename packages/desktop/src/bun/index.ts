import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendAppLog } from "../app-log"
import { BackendController } from "../backend-controller"
import { readPreferences, savePreferences, validateSelection } from "../preferences"
import { buildDesktopApplicationMenu, createDesktopRPC, DESKTOP_NAVIGATION_RULES, DESKTOP_RPC_MAX_REQUEST_TIME, forwardDesktopEvent, menuActionFromEvent, startDesktopConnection, type DesktopRPCSchema } from "../rpc"
import { checkForUpdates, installUpdate, resolveAppBundlePath } from "../updater"

const resources = process.env.YCODING_DESKTOP_RESOURCES ?? path.resolve(import.meta.dir, "../runtime")
let rpc: ReturnType<typeof import("electrobun/bun").BrowserView.defineRPC<DesktopRPCSchema>>
const preferencesPath = process.env.YCODING_DESKTOP_PREFERENCES ?? path.join(os.homedir(), "Library/Application Support/app.ycoding.desktop/backend-preferences.json")
if (!path.isAbsolute(resources) || !path.isAbsolute(preferencesPath)) throw new Error("Native resource and preference paths must be absolute.")
const logPath = path.join(path.dirname(preferencesPath), "desktop.log")
const log = (line: string) => { console.error(line); void appendAppLog(logPath, line) }
const currentVersion = await fs.readFile(path.join(resources, "backend.json"), "utf8").then((text) => {
  const version: unknown = JSON.parse(text)?.version
  return typeof version === "string" && version ? version : "0.0.0"
}, () => "0.0.0").catch(() => "0.0.0")
const appBundlePath = resolveAppBundlePath(process.execPath) ?? resolveAppBundlePath(resources)
const startup = new AbortController()
const readNative = <T>(operation: () => T): T | null => {
  try { return operation() } catch { return null }
}
const controller = new BackendController(resources, {
  cwd: os.homedir(),
  log,
  onState: (state) => rpc.send.state(state),
  onEvent: (event) => forwardDesktopEvent(event, rpc.send),
})
const requests = createDesktopRPC(controller, {
  path: preferencesPath, read: readPreferences, save: savePreferences, validate: validateSelection,
}, {
  pickDirectory: async (startingFolder) => {
    const selected = await Electrobun.Utils.openFileDialog({ startingFolder: startingFolder || os.homedir(), canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false })
    return selected[0]?.trim() ? selected[0] : null
  },
  openExternal: (url) => {
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
  checkForUpdates: () => checkForUpdates({ currentVersion, appBundlePath }),
  installUpdate: ({ version } = {}) => installUpdate({
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
const preferences = await readPreferences(preferencesPath)
const window = new BrowserWindow({ title: "YCoding Desktop", url: null, frame: { x: 80, y: 80, width: 1360, height: 860 }, titleBarStyle: "default", rpc })
window.webview.setNavigationRules([...DESKTOP_NAVIGATION_RULES])
window.webview.loadURL("views://mainview/index.html")
void startDesktopConnection(preferences, (selection) => controller.connect(selection), log, { signal: startup.signal })
