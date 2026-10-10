import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { viewAssets, viewPolicy } from "../view/assets"

export type CaptureMessage =
  | { type: "start"; captureID: string; tabID: number; microphone: boolean; consent: true }
  | {
      type: "audio"
      captureID: string
      source: "remote" | "microphone"
      sequence: number
      startMs: number
      sampleRate: number
      pcm: string
    }
  | { type: "stop"; captureID: string; reason: string }
  | { type: "heartbeat"; captureID: string }

export async function startBridge(options: {
  port?: number
  controlToken: string
  onControl: (input: unknown) => Promise<unknown>
  onCapture: (input: CaptureMessage) => Promise<unknown>
  onDisconnect?: () => void
  onPaired?: () => void
  onView?: () => unknown
  onAsk?: (question: string) => Promise<unknown>
}): Promise<{ url: string; pairing: () => { code: string; expiresAt: number }; close: () => Promise<void> }> {
  if (!/^[\x21-\x7e]{32,256}$/.test(options.controlToken)) throw new Error("Invalid controller credential")
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535))
    throw new Error("Invalid bridge port")
  const controlDigest = digest(options.controlToken)
  const viewKey = randomBytes(32).toString("hex")
  const viewDigest = digest(viewKey)
  const state: {
    pairing?: { hash: Buffer; expiresAt: number }
    capture?: { hash: Buffer; origin: string }
    active?: { captureID: string; seenAt: number }
    delivering: boolean
    closed: boolean
  } = { delivering: false, closed: false }
  const disconnect = () => {
    if (!state.active) return
    state.active = undefined
    options.onDisconnect?.()
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: 1_048_576,
    idleTimeout: 10,
    async fetch(request): Promise<Response> {
      const address = new URL(request.url)
      const origin = request.headers.get("origin")
      const viewRoute = ["/view/state", "/view/control", "/view/ask"].includes(address.pathname)
      const extensionOrigin = origin !== null && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
      const allowedOrigin =
        extensionOrigin &&
        (address.pathname === "/pair" || (address.pathname === "/capture" && state.capture?.origin === origin))
      const headers: Record<string, string> = {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
        vary: "Origin",
      }
      if (allowedOrigin) headers["access-control-allow-origin"] = origin
      const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers })
      if (state.closed) return reply(503, { error: "closed" })
      if (request.headers.get("host") !== `127.0.0.1:${server.port}` || address.hostname !== "127.0.0.1")
        return reply(403, { error: "invalid_host" })
      if (address.search || address.hash) return reply(400, { error: "invalid_url" })
      const asset = viewAssets.get(address.pathname)
      if (asset) {
        if (origin !== null && origin !== `http://127.0.0.1:${server.port}`)
          return reply(403, { error: "invalid_origin" })
        if (request.method !== "GET") return reply(405, { error: "method_not_allowed" })
        return new Response(asset.body, {
          headers: {
            "content-type": asset.type,
            "content-security-policy": viewPolicy,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        })
      }
      if (!["/pair", "/capture", "/control"].includes(address.pathname) && !viewRoute)
        return reply(404, { error: "not_found" })
      if (viewRoute && origin !== null && origin !== `http://127.0.0.1:${server.port}`)
        return reply(403, { error: "invalid_origin" })
      if (address.pathname === "/control" && origin !== null) return reply(403, { error: "origin_forbidden" })
      if (!viewRoute && address.pathname !== "/control" && !allowedOrigin)
        return reply(403, { error: "invalid_origin" })
      if (request.method === "OPTIONS") {
        if (viewRoute) return reply(405, { error: "method_not_allowed" })
        if (address.pathname === "/control" || request.headers.get("access-control-request-method") !== "POST")
          return reply(403, { error: "invalid_preflight" })
        const requested =
          request.headers
            .get("access-control-request-headers")
            ?.toLowerCase()
            .split(",")
            .map((value) => value.trim()) ?? []
        if (requested.some((header) => !["authorization", "content-type"].includes(header)))
          return reply(403, { error: "invalid_preflight" })
        return new Response(null, {
          status: 204,
          headers: {
            ...headers,
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "Authorization, Content-Type",
            "access-control-allow-private-network": "true",
          },
        })
      }
      if (request.method !== (address.pathname === "/view/state" ? "GET" : "POST"))
        return reply(405, { error: "method_not_allowed" })
      if (address.pathname !== "/pair") {
        const authorization = request.headers.get("authorization")
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
        const expected = viewRoute ? viewDigest : address.pathname === "/control" ? controlDigest : state.capture?.hash
        if (!expected || token.length > 256 || !timingSafeEqual(digest(token), expected))
          return reply(401, { error: "unauthorized" })
      }
      if (address.pathname === "/view/state") {
        if (!options.onView) return reply(503, { error: "view_unavailable" })
        const result = await Promise.resolve()
          .then(options.onView)
          .then(
            (value) => ({ value }),
            () => undefined,
          )
        if (!result || !record(result.value)) return reply(500, { error: "view_failed" })
        const view = result.value
        return safeReply(
          reply,
          Object.fromEntries(
            [
              "meeting",
              "meetings",
              "segments",
              "findings",
              "summary",
              "plan",
              "proposals",
              "health",
              "audio",
              "analysis",
              "pairing",
              "config",
              "ask",
            ]
              .filter((key) => Object.hasOwn(view, key))
              .map((key) => [key, view[key]]),
          ),
        )
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? ""))
        return reply(415, { error: "invalid_content_type" })
      const length = request.headers.get("content-length")
      const maxBody = viewRoute ? 16_384 : 1_048_576
      if (length && Number(length) > maxBody) return reply(413, { error: "payload_too_large" })
      const text = await request.text().catch(() => undefined)
      if (text === undefined) return reply(400, { error: "invalid_body" })
      if (Buffer.byteLength(text) > maxBody) return reply(413, { error: "payload_too_large" })
      const body = parse(text)
      if (!body.valid) return reply(400, { error: "invalid_json" })
      if (address.pathname === "/view/control") {
        if (
          !record(body.value) ||
          !keys(body.value, ["action"]) ||
          typeof body.value.action !== "string" ||
          !["pair", "stop", "retry"].includes(body.value.action)
        )
          return reply(400, { error: "invalid_action" })
        server.timeout(request, 180)
        const result = await options.onControl(body.value).then(
          (value) => ({ value }),
          () => undefined,
        )
        return result ? safeReply(reply, result.value) : reply(500, { error: "control_failed" })
      }
      if (address.pathname === "/view/ask") {
        if (
          !record(body.value) ||
          !keys(body.value, ["question"]) ||
          typeof body.value.question !== "string" ||
          !body.value.question.trim() ||
          body.value.question.length > 2000
        )
          return reply(400, { error: "invalid_question" })
        if (!options.onAsk) return reply(503, { error: "ask_unavailable" })
        server.timeout(request, 180)
        const result = await options.onAsk(body.value.question.trim()).then(
          (value) => ({ value }),
          () => undefined,
        )
        if (!result) return reply(502, { error: "answer_failed" })
        if (record(result.value) && result.value.busy === true) return reply(409, { error: "busy" })
        if (record(result.value) && result.value.status === "error")
          return reply(result.value.error === "answer_failed" ? 502 : 422, result.value)
        return safeReply(reply, result.value)
      }
      if (address.pathname === "/pair") {
        if (
          !record(body.value) ||
          !keys(body.value, ["code"]) ||
          typeof body.value.code !== "string" ||
          body.value.code.length > 256
        )
          return reply(400, { error: "invalid_pairing" })
        const pending = state.pairing
        if (!pending || pending.expiresAt <= Date.now() || !timingSafeEqual(digest(body.value.code), pending.hash))
          return reply(401, { error: "invalid_pairing" })
        if (state.delivering) {
          headers["retry-after"] = "1"
          return reply(429, { error: "busy" })
        }
        state.pairing = undefined
        const token = randomBytes(32).toString("base64url")
        state.capture = { hash: digest(token), origin: origin! }
        disconnect()
        options.onPaired?.()
        return reply(200, { token })
      }
      if (address.pathname === "/control") {
        if (record(body.value) && body.value.action === "view") {
          if (!keys(body.value, ["action"])) return reply(400, { error: "invalid_action" })
          return reply(200, { url: `http://127.0.0.1:${server.port}/view#key=${viewKey}` })
        }
        const result = await options.onControl(body.value).then(
          (value) => ({ value }),
          () => undefined,
        )
        return result ? safeReply(reply, result.value) : reply(500, { error: "callback_failed" })
      }
      const message = captureMessage(body.value)
      if (!message) return reply(400, { error: "invalid_capture" })
      if (state.active?.captureID === message.captureID && message.type === "heartbeat")
        state.active.seenAt = Date.now()
      if (state.delivering && message.type !== "heartbeat") {
        headers["retry-after"] = "1"
        return reply(429, { error: "busy" })
      }
      if (message.type !== "heartbeat") state.delivering = true
      const credential = state.capture
      const result = await options.onCapture(message).then(
        (value) => ({ value }),
        () => undefined,
      )
      if (message.type !== "heartbeat") state.delivering = false
      if (!result) return reply(500, { error: "callback_failed" })
      if (record(result.value) && result.value.busy === true) {
        headers["retry-after"] = "1"
        return reply(429, { error: "busy" })
      }
      if (credential === state.capture && !state.closed) {
        if (message.type === "start") state.active = { captureID: message.captureID, seenAt: Date.now() }
        if (state.active?.captureID === message.captureID) {
          state.active.seenAt = Date.now()
          if (message.type === "stop") state.active = undefined
        }
        if (record(result.value) && result.value.stop === true && state.active?.captureID === message.captureID)
          state.active = undefined
      }
      return safeReply(reply, result.value)
    },
    error() {
      return Response.json({ error: "request_failed" }, { status: 500, headers: { "cache-control": "no-store" } })
    },
  })
  const timer = setInterval(() => {
    if (state.active && Date.now() - state.active.seenAt > 20_000) disconnect()
  }, 1000)
  timer.unref()
  return {
    url: `http://127.0.0.1:${server.port}`,
    pairing() {
      if (state.closed) throw new Error("Bridge closed")
      const code = randomBytes(24).toString("base64url")
      const expiresAt = Date.now() + 60_000
      state.pairing = { hash: digest(code), expiresAt }
      return { code, expiresAt }
    },
    async close() {
      if (state.closed) return
      state.closed = true
      state.capture = undefined
      state.pairing = undefined
      clearInterval(timer)
      disconnect()
      await server.stop(true)
    },
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest()
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).length === allowed.length && allowed.every((key) => Object.hasOwn(value, key))
}
function parse(text: string): { valid: true; value: unknown } | { valid: false } {
  try {
    return { valid: true, value: JSON.parse(text) }
  } catch {
    return { valid: false }
  }
}
function safeReply(reply: (status: number, value: unknown) => Response, value: unknown) {
  try {
    return reply(200, value ?? null)
  } catch {
    return reply(500, { error: "callback_failed" })
  }
}
function captureMessage(value: unknown): CaptureMessage | undefined {
  if (!record(value) || typeof value.captureID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.captureID))
    return undefined
  if (value.type === "heartbeat" && keys(value, ["type", "captureID"]))
    return { type: "heartbeat", captureID: value.captureID }
  if (
    value.type === "start" &&
    keys(value, ["type", "captureID", "tabID", "microphone", "consent"]) &&
    typeof value.tabID === "number" &&
    Number.isSafeInteger(value.tabID) &&
    value.tabID >= 0 &&
    typeof value.microphone === "boolean" &&
    value.consent === true
  )
    return {
      type: "start",
      captureID: value.captureID,
      tabID: value.tabID,
      microphone: value.microphone,
      consent: true,
    }
  if (
    value.type === "stop" &&
    keys(value, ["type", "captureID", "reason"]) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 256 &&
    !/[\x00-\x1f]/.test(value.reason)
  )
    return { type: "stop", captureID: value.captureID, reason: value.reason }
  if (
    value.type !== "audio" ||
    !keys(value, ["type", "captureID", "source", "sequence", "startMs", "sampleRate", "pcm"])
  )
    return undefined
  if (value.source !== "remote" && value.source !== "microphone") return undefined
  if (
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.startMs !== "number" ||
    !Number.isFinite(value.startMs) ||
    value.startMs < 0
  )
    return undefined
  if (
    typeof value.sampleRate !== "number" ||
    !Number.isInteger(value.sampleRate) ||
    value.sampleRate < 1 ||
    value.sampleRate > 192000
  )
    return undefined
  if (
    typeof value.pcm !== "string" ||
    value.pcm.length === 0 ||
    value.pcm.length > 1_024_000 ||
    value.pcm.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.pcm)
  )
    return undefined
  const bytes = Buffer.from(value.pcm, "base64")
  if (
    bytes.length === 0 ||
    bytes.length % 4 !== 0 ||
    bytes.length / 4 > value.sampleRate ||
    bytes.toString("base64") !== value.pcm
  )
    return undefined
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const sample = bytes.readFloatLE(offset)
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) return undefined
  }
  return {
    type: "audio",
    captureID: value.captureID,
    source: value.source,
    sequence: value.sequence,
    startMs: value.startMs,
    sampleRate: value.sampleRate,
    pcm: value.pcm,
  }
}
