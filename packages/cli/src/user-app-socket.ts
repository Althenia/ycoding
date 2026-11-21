import type { Socket } from "@ycoding-ai/client/v5"
import { defaultBudgets } from "@ycoding-ai/protocol/v5/connection"
import { UserAppError } from "./user-app-packet"
import { openNodeSocket, type NodeSocket, type SocketOptions } from "./user-app-node-socket"

export function userAppSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
  open: (url: string, options: SocketOptions) => NodeSocket = openNodeSocket,
) {
  const raw = open(url, {
    headers,
    maxPayload: defaultBudgets.serverFrameBytes,
    perMessageDeflate: false,
    followRedirects: false,
  })
  raw.binaryType = "arraybuffer"
  const events = new EventTarget()
  const receipt = Promise.withResolvers<void>()
  let retiring = false
  let abortingHandshake = false
  let failed = false
  let openingFailure: "authentication" | "unavailable" | undefined
  raw.on("open", () => events.dispatchEvent(new Event("open")))
  raw.on("message", (data, binary) =>
    events.dispatchEvent(new MessageEvent("message", { data: binary ? data : "non-binary frame" })),
  )
  raw.on("unexpected-response", (_request, response) => {
    openingFailure = response.statusCode === 401 || response.statusCode === 403 ? "authentication" : "unavailable"
    response.resume()
    raw.terminate()
  })
  raw.on("error", () => {
    if (retiring && !abortingHandshake) failed = true
    openingFailure ??= "unavailable"
    events.dispatchEvent(new Event("error"))
  })
  raw.on("close", () => {
    events.dispatchEvent(new Event("close"))
    if (failed) receipt.reject(new UserAppError("shutdown"))
    else receipt.resolve()
  })
  const socket: Socket = {
    get readyState() {
      return raw.readyState
    },
    get binaryType() {
      return raw.binaryType
    },
    set binaryType(_value: string) {
      raw.binaryType = "arraybuffer"
    },
    send: (bytes) => raw.send(bytes),
    close: (code, reason) => {
      if (retiring || raw.readyState === 3) return
      retiring = true
      try {
        if (raw.readyState === 0) {
          abortingHandshake = true
          raw.terminate()
        } else raw.close(code, reason)
      } catch {
        failed = true
        raw.terminate()
      }
    },
    addEventListener: (type, listener) => events.addEventListener(type, listener),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
  }
  return { socket, closed: receipt.promise, failure: () => openingFailure }
}
