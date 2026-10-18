export const bridgeProtocolVersion = "2026-01-26"

export class McpAppBridgeError extends Error {
  constructor(code, message, hostMessage) {
    super(message)
    this.name = "McpAppBridgeError"
    this.code = code
    if (hostMessage !== undefined) this.hostMessage = hostMessage
  }
}

const bounded = (value) => (typeof value === "string" && value ? value.slice(0, 64) : undefined)
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

export function createMcpAppBridge(options = {}) {
  const self = options.window ?? globalThis.window
  const parent = options.parent ?? self?.parent
  const appInfo = options.appInfo ?? { name: "ycoding-mcp-app", version: "0.0.0" }
  const allowedTools = new Set(options.allowedTools ?? [])
  const initializeTimeoutMs = options.initializeTimeoutMs ?? 3000
  const requestTimeoutMs = options.requestTimeoutMs ?? 10000
  const onToolResult = typeof options.onToolResult === "function" ? options.onToolResult : undefined

  let state = "idle"
  let hostOrigin
  let hostInfo
  let nextID = 1
  let initializePromise
  const pending = new Map()
  const bufferedToolResults = []

  const fail = (code, message, hostMessage) => new McpAppBridgeError(code, message, hostMessage)
  const targetOrigin = () => (hostOrigin && hostOrigin !== "null" ? hostOrigin : "*")
  const post = (message) => parent.postMessage(message, targetOrigin())

  function settle(entry, action) {
    if (!pending.delete(entry.id)) return
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener("abort", entry.onAbort)
    action()
  }

  function request(method, params, timeoutMs, signal) {
    const id = nextID++
    return new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, signal, timer: undefined, onAbort: undefined }
      entry.timer = setTimeout(() => settle(entry, () => reject(fail("timeout", "The host did not answer in time."))), timeoutMs)
      entry.onAbort = () => settle(entry, () => reject(fail("aborted", "The request was cancelled.")))
      if (signal) {
        if (signal.aborted) {
          clearTimeout(entry.timer)
          reject(fail("aborted", "The request was cancelled."))
          return
        }
        signal.addEventListener("abort", entry.onAbort, { once: true })
      }
      pending.set(id, entry)
      post({ jsonrpc: "2.0", id, method, params })
    })
  }

  function deliverToolResult(params) {
    if (state === "disposed") return
    if (state !== "initialized") {
      bufferedToolResults.push(params)
      return
    }
    onToolResult?.(params)
  }

  function onMessage(event) {
    if (state === "disposed") return
    if (!parent || event.source !== parent) return
    if (hostOrigin !== undefined && event.origin !== hostOrigin) return
    const data = event.data
    if (!record(data) || data.jsonrpc !== "2.0") return
    if (data.method === "ui/notifications/tool-result" && data.id === undefined) {
      if (record(data.params)) deliverToolResult(data.params)
      return
    }
    if (data.method !== undefined) return
    const entry = pending.get(data.id)
    if (!entry) return
    const hasResult = "result" in data
    const hasError = "error" in data
    if (hasResult === hasError) {
      settle(entry, () => entry.reject(fail("invalid-result", "The host answer was not a valid result.")))
      return
    }
    if (hasError) {
      const message = record(data.error) ? bounded(data.error.message) : undefined
      settle(entry, () => entry.reject(fail("rejected", "The host rejected the request.", message)))
      return
    }
    if (hostOrigin === undefined) hostOrigin = typeof event.origin === "string" ? event.origin : ""
    settle(entry, () => entry.resolve(data.result))
  }

  self?.addEventListener("message", onMessage)

  function initialize() {
    if (state === "disposed") return Promise.reject(fail("disposed", "This app connection is closed."))
    if (initializePromise) return initializePromise
    if (!self || !parent || parent === self) {
      state = "failed"
      return Promise.reject(fail("not-embedded", "No host window. This document is not embedded."))
    }
    state = "pending"
    initializePromise = request(
      "ui/initialize",
      { protocolVersion: bridgeProtocolVersion, appInfo: { name: bounded(appInfo.name) ?? "ycoding-mcp-app", version: bounded(appInfo.version) ?? "0.0.0" }, appCapabilities: {} },
      initializeTimeoutMs,
    ).then(
      (result) => {
        if (state === "disposed") throw fail("disposed", "This app connection is closed.")
        if (!record(result)) {
          state = "failed"
          throw fail("invalid-result", "The host answered ui/initialize without a result.")
        }
        if (result.protocolVersion !== bridgeProtocolVersion) {
          state = "failed"
          const error = fail("protocol-mismatch", "The host selected an unsupported protocol version.")
          error.hostProtocolVersion = bounded(result.protocolVersion)
          throw error
        }
        const info = record(result.hostInfo) ? result.hostInfo : {}
        hostInfo = { name: bounded(info.name), version: bounded(info.version) }
        state = "initialized"
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" })
        for (const params of bufferedToolResults.splice(0)) onToolResult?.(params)
        return hostInfo
      },
      (error) => {
        if (state !== "disposed") state = "failed"
        throw error
      },
    )
    return initializePromise
  }

  function callTool(name, args = {}, callOptions = {}) {
    if (state === "disposed") return Promise.reject(fail("disposed", "This app connection is closed."))
    if (!allowedTools.has(name)) return Promise.reject(fail("tool-not-allowed", "This app may not call that tool."))
    if (state !== "initialized") return Promise.reject(fail("unavailable", "The host connection is not initialized."))
    if (!record(args)) return Promise.reject(fail("unavailable", "Tool arguments must be an object."))
    return request("tools/call", { name, arguments: args }, requestTimeoutMs, callOptions.signal)
  }

  function dispose() {
    if (state === "disposed") return
    state = "disposed"
    self?.removeEventListener("message", onMessage)
    bufferedToolResults.length = 0
    for (const entry of [...pending.values()]) settle(entry, () => entry.reject(fail("disposed", "This app connection is closed.")))
  }

  return {
    get state() {
      return state
    },
    get hostInfo() {
      return hostInfo
    },
    initialize,
    callTool,
    dispose,
  }
}
