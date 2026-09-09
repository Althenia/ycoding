import type { SessionInfo } from "@ycoding-ai/client"
import { Pty } from "@ycoding-ai/schema/pty"
import { PtyTicket } from "@ycoding-ai/schema/pty-ticket"
import { Option, Schema } from "effect"
import type { TerminalInspectorTransport } from "./terminal-inspector"

type TerminalSocket = {
  binaryType: string
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: Uint8Array): void
  close(): void
}

type LocationRef = SessionInfo["location"]
type LocationInput = { directory: string; workspace?: string }
type RequestOptions = { signal?: AbortSignal }
export type TerminalInspectorApi = {
  pty: {
    connect: {
      token(
        input: {
          ptyID: Pty.ID
          sessionID: string
          access: Pty.Access
          generation: number
          expectedFence?: number
          location: LocationInput
          "x-ycoding-ticket": "1"
        },
        options?: RequestOptions,
      ): Promise<{ data: unknown }>
    }
    control(
      input: Pty.ControlInput & { ptyID: Pty.ID; location: LocationInput },
      options?: RequestOptions,
    ): Promise<{ data: unknown }>
    update(
      input: Pty.UpdateInput & { ptyID: Pty.ID; location: LocationInput },
      options?: RequestOptions,
    ): Promise<{ data: unknown }>
  }
}
const decodeInfo = Schema.decodeUnknownOption(Pty.Info)
const decodeToken = Schema.decodeUnknownOption(PtyTicket.ConnectToken)

export function createTerminalInspectorTransport(input: {
  api: TerminalInspectorApi | (() => TerminalInspectorApi)
  baseUrl: string | (() => string | undefined)
  ptyID: Pty.ID
  sessionID: string
  location: LocationRef
  socket?: (url: string) => TerminalSocket
}): TerminalInspectorTransport {
  let active: { socket: TerminalSocket; access: Pty.Access } | undefined
  const location = { directory: input.location.directory, workspace: input.location.workspaceID }
  const api = () => (typeof input.api === "function" ? input.api() : input.api)

  return {
    connect(connection, handlers) {
      const controller = new AbortController()
      let disposed = false
      let failed = false
      let socket: TerminalSocket | undefined
      void api()
        .pty.connect.token(
          {
            ptyID: input.ptyID,
            sessionID: input.sessionID,
            access: connection.access,
            generation: connection.generation,
            expectedFence: connection.fence,
            location,
            "x-ycoding-ticket": "1",
          },
          { signal: controller.signal },
        )
        .then((response) => {
          if (disposed) return
          const token = Option.getOrUndefined(decodeToken(response.data))
          if (
            !token ||
            token.access !== connection.access ||
            token.generation !== connection.generation ||
            (connection.access === "control" && token.fence !== connection.fence)
          ) {
            handlers.error?.()
            return
          }
          const endpoint = typeof input.baseUrl === "function" ? input.baseUrl() : input.baseUrl
          if (!endpoint) {
            handlers.error?.()
            return
          }
          socket =
            input.socket?.(
              terminalSocketUrl(endpoint, input.ptyID, input.sessionID, input.location, connection, token.ticket),
            ) ??
            browserSocket(
              terminalSocketUrl(endpoint, input.ptyID, input.sessionID, input.location, connection, token.ticket),
            )
          socket.binaryType = "arraybuffer"
          socket.onopen = () => {
            if (disposed || !socket) return
            active = { socket, access: connection.access }
          }
          socket.onmessage = (event) => {
            if (disposed) return
            if (typeof event.data === "string" || event.data instanceof ArrayBuffer) handlers.frame(event.data)
          }
          socket.onerror = () => {
            if (disposed || failed) return
            failed = true
            handlers.error?.()
          }
          socket.onclose = () => {
            if (active?.socket === socket) active = undefined
            if (!disposed && !failed) handlers.close()
          }
        })
        .catch(() => {
          if (!disposed && !controller.signal.aborted) handlers.error?.()
        })

      return () => {
        if (disposed) return
        disposed = true
        controller.abort()
        if (active?.socket === socket) active = undefined
        if (socket && socket.readyState < 2) socket.close()
      }
    },
    async control(control, options) {
      return requireInfo(
        await api().pty.control(
          {
            ptyID: input.ptyID,
            ...control,
            location,
          },
          options,
        ),
      )
    },
    async resize(update, options) {
      return requireInfo(
        await api().pty.update(
          {
            ptyID: input.ptyID,
            ...update,
            location,
          },
          options,
        ),
      )
    },
    write(data) {
      if (!active || active.access !== "control" || active.socket.readyState !== 1) return
      active.socket.send(data)
    },
  }
}

function browserSocket(url: string): TerminalSocket {
  const socket = new WebSocket(url)
  let onopen: TerminalSocket["onopen"] = null
  let onmessage: TerminalSocket["onmessage"] = null
  let onclose: TerminalSocket["onclose"] = null
  let onerror: TerminalSocket["onerror"] = null
  socket.onopen = () => onopen?.()
  socket.onmessage = (event) => onmessage?.({ data: event.data })
  socket.onclose = () => onclose?.()
  socket.onerror = () => onerror?.()
  return {
    get binaryType() {
      return socket.binaryType
    },
    set binaryType(value) {
      socket.binaryType = value === "arraybuffer" ? "arraybuffer" : "blob"
    },
    get readyState() {
      return socket.readyState
    },
    get onopen() {
      return onopen
    },
    set onopen(value) {
      onopen = value
    },
    get onmessage() {
      return onmessage
    },
    set onmessage(value) {
      onmessage = value
    },
    get onclose() {
      return onclose
    },
    set onclose(value) {
      onclose = value
    },
    get onerror() {
      return onerror
    },
    set onerror(value) {
      onerror = value
    },
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
}

function requireInfo(response: { data: unknown }) {
  const info = Option.getOrUndefined(decodeInfo(response.data))
  if (!info) throw new Error("Malformed terminal response")
  return info
}

function terminalSocketUrl(
  baseUrl: string,
  ptyID: Pty.ID,
  sessionID: string,
  location: LocationRef,
  connection: { generation: number; offset: number; access: Pty.Access; fence?: number },
  ticket: string,
) {
  const url = new URL(`/api/pty/${encodeURIComponent(ptyID)}/connect`, baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("location[directory]", location.directory)
  if (location.workspaceID) url.searchParams.set("location[workspace]", location.workspaceID)
  url.searchParams.set("sessionID", sessionID)
  url.searchParams.set("generation", String(connection.generation))
  url.searchParams.set("offset", String(connection.offset))
  url.searchParams.set("access", connection.access)
  if (connection.fence !== undefined) url.searchParams.set("fence", String(connection.fence))
  url.searchParams.set("ticket", ticket)
  return url.toString()
}
