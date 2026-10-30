import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { CcaLibraryFactory, CcaLibraryProcess } from "./library"
import { CcaAuthorizationDeniedError } from "./authorization"
import { ccaRefusalText } from "./errors"

export const CCA_LIBRARY_PROCESS_URL = "ycoding-library://process"
const bodyLimit = 256 * 1024
const responseLimit = 4 * 1024 * 1024

export interface CcaLibraryProcessLease {
  readonly env: Readonly<Record<string, string>>
  readonly close: () => Promise<void>
  readonly redactOutput: (stream: "stdout" | "stderr", bytes: Buffer, settled?: boolean) => Buffer
}

function body(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > bodyLimit) { chunks.length = 0; resolve(undefined); return }
      chunks.push(chunk)
    })
    request.once("end", () => resolve(bytes > bodyLimit ? undefined : Buffer.concat(chunks).toString("utf8")))
    request.once("error", reject)
  })
}

function json(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  response.end(JSON.stringify(value))
}

function error(response: ServerResponse, status: number, id: unknown, code: number, message: string) {
  json(response, status, { jsonrpc: "2.0", id, error: { code, message } })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createCcaLibraryProcessBridge() {
  const owners = new Map<string, { readonly backend: CcaLibraryProcess; readonly close: () => Promise<void>; active: number }>()
  let closed = false
  let address: Promise<string> | undefined
  let host = ""
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch(() => error(response, 500, null, -32603, "Private Library channel failed"))
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.on("clientError", (_error, socket) => socket.destroy())

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== host || request.headers.origin !== undefined) return error(response, 403, null, -32001, "Private Library channel unavailable")
    if (request.url !== "/mcp") return error(response, 404, null, -32600, "Unknown private endpoint")
    const token = request.headers.authorization ?? ""
    const owner = owners.get(token)
    if (!owner || closed) return error(response, 401, null, -32001, "Private Library capability unavailable")
    if (request.method !== "POST") return error(response, 405, null, -32601, "Only POST is supported")
    if (owner.active >= 4) return error(response, 429, null, -32603, "Private Library channel is busy")
    owner.active++
    const current = async () => {
      if (closed || owners.get(token) !== owner) throw new Error("retired")
      await owner.backend.check()
      if (closed || owners.get(token) !== owner) throw new Error("retired")
    }
    response.once("close", () => { if (!response.writableEnded) void owner.close().catch(() => {}) })
    let id: string | number | null = null
    try {
      try { await current() } catch { void owner.close().catch(() => {}); return error(response, 403, id, -32001, "Private Library capability retired") }
      const source = await body(request)
      if (source === undefined) return error(response, 413, id, -32600, "Request exceeds private channel limit")
      let value: unknown
      try { value = JSON.parse(source) } catch { return error(response, 400, id, -32700, "Invalid JSON") }
      if (!record(value) || value.jsonrpc !== "2.0" || (typeof value.id !== "string" && !(typeof value.id === "number" && Number.isSafeInteger(value.id))) ||
        Object.keys(value).some((key) => !["jsonrpc", "id", "method", "params"].includes(key)))
        return error(response, 400, id, -32600, "Invalid private JSON-RPC request")
      id = value.id
      const params = value.params ?? {}
      if (!record(params)) return error(response, 400, id, -32602, "Invalid parameters")
      await current()
      if (value.method === "tools/list") {
        if (Object.keys(params).some((key) => key !== "_meta")) return error(response, 400, id, -32602, "Unsupported list parameters")
        await current()
        return json(response, 200, { jsonrpc: "2.0", id, result: { tools: owner.backend.tools } })
      }
      if (value.method !== "tools/call") return error(response, 400, id, -32601, "Unsupported private method")
      if (Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key)) || typeof params.name !== "string" ||
        !owner.backend.tools.some((tool) => tool.name === params.name) || !record(params.arguments))
        return error(response, 400, id, -32602, "Unknown tool or invalid arguments")
      let result: unknown
      try {
        result = await owner.backend.call(params.name, params.arguments)
      } catch (cause) {
        const text = cause instanceof CcaAuthorizationDeniedError ? ccaRefusalText(cause) ?? "Library permission denied." : "Library operation failed. Do not retry an uncertain upload."
        await current()
        return json(response, 200, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } })
      }
      await current()
      const text = JSON.stringify(result)
      if (text === undefined || Buffer.byteLength(text) > responseLimit) return error(response, 413, id, -32603, "Library result exceeds private channel limit")
      return json(response, 200, { jsonrpc: "2.0", id, result: { structuredContent: result, content: [{ type: "text", text }] } })
    } catch {
      void owner.close().catch(() => {})
      return error(response, 403, id, -32001, "Private Library operation retired; do not replay an uncertain upload")
    } finally {
      owner.active--
    }
  }

  function listen() {
    address ??= new Promise<string>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const bound = server.address()
        if (!bound || typeof bound === "string") { reject(new Error("Private Library listener unavailable")); return }
        host = `127.0.0.1:${bound.port}`
        server.unref()
        resolve(`http://${host}/mcp`)
      })
    })
    return address
  }

  return {
    open: async (factory: CcaLibraryFactory, input: Parameters<CcaLibraryFactory["open"]>[0], signal?: AbortSignal): Promise<CcaLibraryProcessLease> => {
      if (closed || signal?.aborted) throw new Error("Private Library channel unavailable")
      const url = await listen()
      const backend = await factory.open(input)
      const secret = randomBytes(32).toString("hex")
      const token = `Bearer ${secret}`
      let closing: Promise<void> | undefined
      const close = () => {
        owners.delete(token)
        signal?.removeEventListener("abort", abort)
        closing ??= backend.close()
        return closing
      }
      const abort = () => { void close().catch(() => {}) }
      if (closed || signal?.aborted) { await close(); throw new Error("Private Library channel unavailable") }
      try { await backend.check() } catch { await close(); throw new Error("Private Library channel unavailable") }
      if (closed || signal?.aborted) { await close(); throw new Error("Private Library channel unavailable") }
      owners.set(token, { backend, close, active: 0 })
      signal?.addEventListener("abort", abort, { once: true })
      const pending = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      const needle = Buffer.from(secret)
      return {
        env: { CODEX_APPS_MCP_URL: url, CODEX_APPS_AUTHORIZATION: token }, close,
        redactOutput: (stream, bytes, settled = false) => {
          const data = Buffer.concat([pending[stream], bytes])
          const parts: Buffer[] = []
          let offset = 0
          for (let found = data.indexOf(needle, offset); found >= 0; found = data.indexOf(needle, offset)) {
            parts.push(data.subarray(offset, found), Buffer.from("[redacted]"))
            offset = found + needle.length
          }
          const tail = data.subarray(offset)
          let held = 0
          if (!settled) for (let size = Math.min(tail.length, needle.length - 1); size > 0; size--) {
            if (tail.subarray(tail.length - size).equals(needle.subarray(0, size))) { held = size; break }
          }
          pending[stream] = Buffer.from(tail.subarray(tail.length - held))
          parts.push(tail.subarray(0, tail.length - held))
          return Buffer.concat(parts)
        },
      }
    },
    close: async () => {
      closed = true
      await Promise.allSettled([...owners.values()].map((owner) => owner.close()))
      owners.clear()
      if (!address) return
      await address.catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
