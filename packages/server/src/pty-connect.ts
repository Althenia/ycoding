export * as PtyConnect from "./pty-connect"

import { SessionV2 } from "@ycoding-ai/core/session"

const servers = new WeakMap<
  object,
  { readonly sockets: Set<() => void>; readonly close: () => void; readonly restore: () => void }
>()

export function parse(url: string) {
  const query = new URL(url, "http://localhost").searchParams
  const ticket = query.get("ticket")
  const rawSessionID = query.get("sessionID")
  const access = query.get("access")
  const generation = Number(query.get("generation"))
  const offset = Number(query.get("offset") ?? "0")
  const rawFence = query.get("fence")
  const fence = rawFence === null ? undefined : Number(rawFence)
  if (
    !ticket ||
    !rawSessionID?.startsWith("ses") ||
    (access !== "inspect" && access !== "control") ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (access === "control" && (!Number.isSafeInteger(fence) || (fence ?? 0) <= 0))
  )
    return undefined
  return {
    ticket,
    sessionID: SessionV2.ID.make(rawSessionID),
    access: access === "control" ? ("control" as const) : ("inspect" as const),
    generation,
    offset,
    fence,
  }
}

export function track(socket: unknown, close: () => void) {
  const server = socketServer(socket)
  if (!server) return () => {}
  const current = servers.get(server)
  const tracked = current ?? makeTracked(server)
  tracked.sockets.add(close)
  return () => {
    tracked.sockets.delete(close)
    if (tracked.sockets.size > 0) return
    call(server, "off", "close", tracked.close)
    tracked.restore()
    servers.delete(server)
  }
}

function makeTracked(server: object) {
  const sockets = new Set<() => void>()
  const close = () => {
    servers.delete(server)
    for (const shutdown of sockets) shutdown()
    sockets.clear()
  }
  const tracked = { sockets, close, restore: instrumentServerClose(server, close) }
  servers.set(server, tracked)
  call(server, "once", "close", close)
  return tracked
}

function instrumentServerClose(server: object, closeSockets: () => void) {
  const ownedClose = Object.hasOwn(server, "close")
  const originalClose = Reflect.get(server, "close")
  if (typeof originalClose !== "function") return () => {}
  const instrumentedClose = new Proxy(originalClose, {
    apply(target, self, args) {
      closeSockets()
      return Reflect.apply(target, self, args)
    },
  })
  Reflect.set(server, "close", instrumentedClose)
  const ownedCloseAll = Object.hasOwn(server, "closeAllConnections")
  const closeAllConnections = Reflect.get(server, "closeAllConnections")
  const originalCloseAll = typeof closeAllConnections === "function" ? closeAllConnections : undefined
  const instrumentedCloseAll = originalCloseAll
    ? () => {
        closeSockets()
        originalCloseAll.call(server)
      }
    : undefined
  if (instrumentedCloseAll) Reflect.set(server, "closeAllConnections", instrumentedCloseAll)
  return () => {
    if (Reflect.get(server, "close") === instrumentedClose)
      ownedClose ? Reflect.set(server, "close", originalClose) : Reflect.deleteProperty(server, "close")
    if (instrumentedCloseAll && Reflect.get(server, "closeAllConnections") === instrumentedCloseAll) {
      ownedCloseAll
        ? Reflect.set(server, "closeAllConnections", originalCloseAll)
        : Reflect.deleteProperty(server, "closeAllConnections")
    }
  }
}

function socketServer(socket: unknown) {
  if (!socket || typeof socket !== "object") return undefined
  const server = Reflect.get(socket, "server")
  if (!server || typeof server !== "object") return undefined
  return ["close", "once", "off"].every((key) => typeof Reflect.get(server, key) === "function") ? server : undefined
}

function call(target: object, key: string, ...args: unknown[]) {
  const method = Reflect.get(target, key)
  if (typeof method === "function") Reflect.apply(method, target, args)
}
