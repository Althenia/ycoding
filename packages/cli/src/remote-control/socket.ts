import { execFile } from "node:child_process"
import type { RemoteControlSocket } from "./host"
import { deviceKindFromMachineName, handshakeTimeoutMs } from "./types"

export async function connectRemoteControlSocket(
  url: string,
  headers: Record<string, string>,
): Promise<RemoteControlSocket> {
  const { WebSocket } = await import("ws")
  const ws = new WebSocket(url, { headers })
  return new Promise((resolve, reject) => {
    const socket: RemoteControlSocket = {
      send: (text) => ws.send(text),
      close: (code?: number) => ws.close(code),
      ping: () => ws.ping(),
      onMessage: (handler) =>
        ws.on("message", (data: unknown, isBinary: unknown) => {
          if (isBinary === true) return
          handler(String(data))
        }),
      onClose: (handler) => ws.on("close", () => handler()),
      onError: (handler) => ws.on("error", (error: unknown) => handler(error)),
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onError = (error: unknown) => {
      clearTimeout(timer)
      const status =
        typeof error === "object" && error !== null && "response" in error
          ? Reflect.get(Reflect.get(error, "response") as object, "statusCode")
          : undefined
      reject(
        typeof status === "number"
          ? Object.assign(new Error("Remote-control connection failed"), { status })
          : error instanceof Error
            ? error
            : new Error("Remote-control connection failed"),
      )
    }
    timer = setTimeout(() => {
      ws.close()
      reject(Object.assign(new Error("Remote-control connection timed out"), { status: 408 }))
    }, handshakeTimeoutMs)
    ws.once("error", onError)
    ws.once("open", () => {
      clearTimeout(timer)
      ws.off("error", onError)
      resolve(socket)
    })
    ws.on("ping", () => ws.pong())
  })
}

export function macDeviceKind(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile("system_profiler", ["SPHardwareDataType", "-json"], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(undefined)
      try {
        const parsed: unknown = JSON.parse(stdout)
        const items = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "SPHardwareDataType") : undefined
        const first = Array.isArray(items) ? items[0] : undefined
        const name = typeof first === "object" && first !== null ? Reflect.get(first, "machine_name") : undefined
        resolve(deviceKindFromMachineName(typeof name === "string" ? name : undefined))
      } catch {
        resolve(undefined)
      }
    })
  })
}
