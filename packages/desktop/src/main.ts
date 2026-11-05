import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BackendController } from "./backend-controller"
import { readPreferences, savePreferences, validateSelection } from "./preferences"

let window: BrowserWindow | undefined
let controller: BackendController | undefined
let closing = false
let quitting = false
let starting = false
let preferenceError: string | undefined
const renderer = path.join(__dirname, "renderer", "index.html")

function authorize(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
    !event.senderFrame || fileURLToPath(new URL(event.senderFrame.url)) !== renderer)
    throw new Error("This desktop operation belongs to the native app's main frame.")
}

app.setName("YCoding Desktop")

void app.whenReady().then(async () => {
  window = new BrowserWindow({
    title: "YCoding Desktop",
    width: 1100,
    height: 780,
    minWidth: 360,
    minHeight: 540,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  controller = new BackendController(process.resourcesPath, {
    onState: (state) => {
      if (window && !window.isDestroyed()) window.webContents.send("desktop:state", { ...state, ...(preferenceError ? { notice: preferenceError } : {}) })
    },
    onEvent: (event) => { if (window && !window.isDestroyed()) window.webContents.send("desktop:event", event) },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => {
    try { if (fileURLToPath(new URL(url)) !== renderer) event.preventDefault() } catch { event.preventDefault() }
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const preferences = path.join(app.getPath("userData"), "backend-preferences.json")
  ipcMain.handle("desktop:preferences", (event) => { authorize(event); return readPreferences(preferences) })
  ipcMain.handle("desktop:state", (event) => { authorize(event); return controller!.state() })
  ipcMain.handle("desktop:connect", async (event, input: unknown) => {
    authorize(event)
    if (starting) throw new Error("A backend connection is pending. Cancel it before changing backend.")
    const selection = validateSelection(input)
    starting = true
    try {
      preferenceError = undefined
      try { await savePreferences(preferences, selection) } catch { preferenceError = "Backend choice was not saved. This connection is for this launch only." }
      const state = await controller!.connect(selection)
      return { ...state, ...(preferenceError ? { notice: preferenceError } : {}) }
    } finally { starting = false }
  })
  ipcMain.handle("desktop:disconnect", (event) => { authorize(event); return controller!.disconnect() })
  ipcMain.handle("desktop:sessions", (event) => { authorize(event); return controller!.sessions() })
  window.on("close", (event) => {
    if (closing) return
    event.preventDefault()
    closing = true
    void controller!.disconnect().finally(() => window?.destroy())
  })
  window.webContents.on("render-process-gone", () => { void controller!.disconnect() })
  await window.loadFile(renderer)
})

app.on("before-quit", (event) => {
  if (quitting || !controller) return
  event.preventDefault()
  quitting = true
  void controller.disconnect().finally(() => app.quit())
})
app.on("window-all-closed", () => app.quit())
