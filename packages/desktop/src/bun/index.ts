import os from "node:os"
import path from "node:path"
import { appendAppLog } from "../app-log"
import { BackendController } from "../backend-controller"
import { readPreferences, savePreferences, validateSelection } from "../preferences"
import { createDesktopRPC, DESKTOP_NAVIGATION_RULES, DESKTOP_RPC_MAX_REQUEST_TIME, forwardDesktopEvent, startDesktopConnection, type DesktopRPCSchema } from "../rpc"

const resources = process.env.YCODING_DESKTOP_RESOURCES ?? path.resolve(import.meta.dir, "../runtime")
let rpc: ReturnType<typeof import("electrobun/bun").BrowserView.defineRPC<DesktopRPCSchema>>
const preferencesPath = process.env.YCODING_DESKTOP_PREFERENCES ?? path.join(os.homedir(), "Library/Application Support/app.ycoding.desktop/backend-preferences.json")
if (!path.isAbsolute(resources) || !path.isAbsolute(preferencesPath)) throw new Error("Native resource and preference paths must be absolute.")
const logPath = path.join(path.dirname(preferencesPath), "desktop.log")
const log = (line: string) => { console.error(line); void appendAppLog(logPath, line) }
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
})
const { default: Electrobun, BrowserWindow, BrowserView } = await import("electrobun/bun")
rpc = BrowserView.defineRPC<DesktopRPCSchema>({ maxRequestTime: DESKTOP_RPC_MAX_REQUEST_TIME, handlers: { requests } })

let closed = false
let quitting = false
Electrobun.events.on("before-quit", (event: { response: { allow: boolean } }) => {
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
startDesktopConnection(preferences, (selection) => controller.connect(selection), log)
