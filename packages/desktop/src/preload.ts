import { contextBridge, ipcRenderer } from "electron"
import type { DesktopAPI, ConnectionState } from "./contract"
import type { YCodingEvent } from "@ycoding-ai/client"

const api: DesktopAPI = {
  preferences: () => ipcRenderer.invoke("desktop:preferences"),
  state: () => ipcRenderer.invoke("desktop:state"),
  connect: (selection) => ipcRenderer.invoke("desktop:connect", selection),
  disconnect: () => ipcRenderer.invoke("desktop:disconnect"),
  sessions: () => ipcRenderer.invoke("desktop:sessions"),
  onState: (listen) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ConnectionState) => listen(state)
    ipcRenderer.on("desktop:state", handler)
    return () => ipcRenderer.off("desktop:state", handler)
  },
  onEvent: (listen) => {
    const handler = (_event: Electron.IpcRendererEvent, event: YCodingEvent) => listen(event)
    ipcRenderer.on("desktop:event", handler)
    return () => ipcRenderer.off("desktop:event", handler)
  },
}

contextBridge.exposeInMainWorld("ycodingDesktop", api)
