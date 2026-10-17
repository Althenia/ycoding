import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { viewAssets, viewPolicy } from "../view/assets"
import type { OwnerSettingsUpdate } from "./runtime"

export type CaptureMessage =
  | { type: "start"; captureID: string; microphone: boolean; consent: true }
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
  onView?: () => unknown
  onAsk?: (question: string) => Promise<unknown>
  onOwnerRead?: () => Promise<unknown>
  onOwnerUpdate?: (input: OwnerSettingsUpdate) => Promise<unknown>
}): Promise<{ url: string; close: () => Promise<void> }> {
  if (!/^[\x21-\x7e]{32,256}$/.test(options.controlToken)) throw new Error("Invalid controller credential")
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535))
    throw new Error("Invalid bridge port")
  const controlDigest = digest(options.controlToken)
  const viewKey = randomBytes(32).toString("hex")
  const viewDigest = digest(viewKey)
  const ownerKey = randomBytes(32).toString("hex")
  const ownerDigest = digest(ownerKey)
  const state: {
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
      const viewRoute = ["/view/state", "/view/control", "/view/ask", "/view/capture"].includes(address.pathname)
      const ownerRoute = address.pathname === "/view/owner/settings"
      const headers: Record<string, string> = {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      }
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
      if (address.pathname !== "/control" && !viewRoute && !ownerRoute) return reply(404, { error: "not_found" })
      if ((viewRoute || ownerRoute) && origin !== null && origin !== `http://127.0.0.1:${server.port}`)
        return reply(403, { error: "invalid_origin" })
      if (address.pathname === "/control" && origin !== null) return reply(403, { error: "origin_forbidden" })
      const methodAllowed = ownerRoute
        ? request.method === "GET" || request.method === "POST"
        : request.method === (address.pathname === "/view/state" ? "GET" : "POST")
      if (!methodAllowed) return reply(405, { error: "method_not_allowed" })
      const authorization = request.headers.get("authorization")
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
      if (
        token.length > 256 ||
        !timingSafeEqual(digest(token), ownerRoute ? ownerDigest : viewRoute ? viewDigest : controlDigest)
      )
        return reply(401, { error: "unauthorized" })
      if (ownerRoute && request.method === "GET") {
        if (!options.onOwnerRead) return reply(503, { error: "owner_unavailable" })
        const result = await options.onOwnerRead().then(
          (value) => ({ value }),
          () => undefined,
        )
        return result ? safeReply(reply, result.value) : reply(500, { error: "owner_failed" })
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
      const maxBody = address.pathname === "/view/capture" || address.pathname === "/control" ? 1_048_576 : 16_384
      if (length && Number(length) > maxBody) return reply(413, { error: "payload_too_large" })
      const text = await request.text().catch(() => undefined)
      if (text === undefined) return reply(400, { error: "invalid_body" })
      if (Buffer.byteLength(text) > maxBody) return reply(413, { error: "payload_too_large" })
      const body = parse(text)
      if (!body.valid) return reply(400, { error: "invalid_json" })
      if (ownerRoute) {
        const update = ownerSettingsUpdate(body.value)
        if (!update) return reply(400, { error: "invalid_settings" })
        if (!options.onOwnerUpdate) return reply(503, { error: "owner_unavailable" })
        const result = await options.onOwnerUpdate(update).then(
          (value) => ({ value }),
          () => undefined,
        )
        if (!result) return reply(500, { error: "owner_failed" })
        if (record(result.value) && result.value.error === "selection_unavailable")
          return reply(422, { error: "selection_unavailable" })
        return safeReply(reply, result.value)
      }
      if (address.pathname === "/view/control") {
        if (
          !record(body.value) ||
          !keys(body.value, ["action"]) ||
          typeof body.value.action !== "string" ||
          !["stop", "retry"].includes(body.value.action)
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
      if (address.pathname === "/control") {
        if (record(body.value) && body.value.action === "view") {
          if (!keys(body.value, ["action"])) return reply(400, { error: "invalid_action" })
          return reply(200, { url: `http://127.0.0.1:${server.port}/view#key=${viewKey}` })
        }
        if (record(body.value) && body.value.action === "owner-view") {
          if (!keys(body.value, ["action"])) return reply(400, { error: "invalid_action" })
          return reply(200, {
            url: `http://127.0.0.1:${server.port}/view#key=${viewKey}&owner=${ownerKey}`,
          })
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
      if (!state.closed) {
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
    async close() {
      if (state.closed) return
      state.closed = true
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
function keysWithin(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function boundedName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
}
function ownerSettingsUpdate(value: unknown): OwnerSettingsUpdate | undefined {
  if (!record(value) || !keysWithin(value, ["askModel", "knowledge"]) || !Object.keys(value).length) return undefined
  const update: OwnerSettingsUpdate = {}
  if (Object.hasOwn(value, "askModel")) {
    if (value.askModel === "inherit") update.askModel = "inherit"
    else if (
      record(value.askModel) &&
      keysWithin(value.askModel, ["providerID", "id", "variant", "profile"]) &&
      boundedName(value.askModel.providerID) &&
      boundedName(value.askModel.id) &&
      (value.askModel.variant === undefined || boundedName(value.askModel.variant)) &&
      (value.askModel.profile === undefined || boundedName(value.askModel.profile))
    )
      update.askModel = {
        providerID: value.askModel.providerID,
        id: value.askModel.id,
        ...(value.askModel.variant ? { variant: value.askModel.variant } : {}),
        ...(value.askModel.profile ? { profile: value.askModel.profile } : {}),
      }
    else return undefined
  }
  if (Object.hasOwn(value, "knowledge")) {
    if (
      !record(value.knowledge) ||
      !keys(value.knowledge, ["mcpEnabled", "bindings"]) ||
      typeof value.knowledge.mcpEnabled !== "boolean" ||
      !Array.isArray(value.knowledge.bindings) ||
      value.knowledge.bindings.length > 4
    )
      return undefined
    const bindings: NonNullable<OwnerSettingsUpdate["knowledge"]>["bindings"] = []
    for (const binding of value.knowledge.bindings) {
      if (
        !record(binding) ||
        !keysWithin(binding, ["server", "search", "read", "write", "enabled"]) ||
        !boundedName(binding.server) ||
        !boundedName(binding.search) ||
        !boundedName(binding.read) ||
        (binding.write !== undefined && !boundedName(binding.write)) ||
        (binding.enabled !== undefined && typeof binding.enabled !== "boolean")
      )
        return undefined
      bindings.push({
        server: binding.server,
        search: binding.search,
        read: binding.read,
        ...(binding.write ? { write: binding.write } : {}),
        enabled: binding.enabled ?? true,
      })
    }
    update.knowledge = { mcpEnabled: value.knowledge.mcpEnabled, bindings }
  }
  return update
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
    keys(value, ["type", "captureID", "microphone", "consent"]) &&
    typeof value.microphone === "boolean" &&
    value.consent === true
  )
    return {
      type: "start",
      captureID: value.captureID,
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
