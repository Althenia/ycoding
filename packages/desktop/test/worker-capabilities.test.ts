import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { runDesktopWorker } from "../src/worker"
import { env, launch, syntheticBundle } from "./synthetic-backend"

type Call = { method: string; route: string; query: URLSearchParams; body: Record<string, unknown> }
type Reply = { type: "reply"; id: number; data?: unknown; error?: string }

const parent = "ses_parent"
const repo = "/synthetic/repo"
const info = { id: parent, title: "Worker Export", location: { directory: repo }, time: { created: 1, updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, agent: "build" }
const messages = [{ id: "msg_1", type: "user", text: "Question" }]

function handle(call: Call): unknown {
  if (call.method === "GET" && call.route === `/api/session/${parent}`) return { data: info }
  if (call.route === `/api/session/${parent}/snapshot`) return { sourceEpoch: "epoch", session: info, messages, watermark: { type: "log.synced", aggregateID: parent, seq: 3 }, before: "cursor" }
  if (call.route === "/api/agent") return { location: { directory: repo }, data: [{ id: "plan", name: "plan", mode: "primary", hidden: false }] }
  if (call.route.endsWith("/message")) return { data: messages }
  return undefined
}

async function worker() {
  const resources = await syntheticBundle()
  const preferences = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-worker-capabilities-")), "preferences.json")
  const calls: Call[] = []
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (url.pathname === "/api/event") return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
      request.signal.addEventListener("abort", () => stream.close(), { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
    const body: unknown = request.body ? await request.json() : {}
    const call = { method: request.method, route: url.pathname, query: url.searchParams, body: { ...(body as Record<string, unknown>) } }
    calls.push(call)
    const value = handle(call)
    return value === undefined ? new Response(null, { status: 204 }) : Response.json(value)
  }, { preconnect: () => {} })
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = new Map<number, Reply>()
  const waiting = new Map<number, (reply: Reply) => void>()
  let buffer = ""
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const record = JSON.parse(buffer.slice(0, newline)) as Reply | { type: string }
      buffer = buffer.slice(newline + 1)
      if (record.type !== "reply") continue
      const reply = record as Reply
      replies.set(reply.id, reply)
      waiting.get(reply.id)?.(reply)
    }
  })
  const done = runDesktopWorker({ resources, preferences, input, output, controller: { env, launch, fetch } })
  let next = 0
  const request = (operation: string, value?: unknown) => {
    const id = ++next
    const reply = new Promise<Reply>((resolve) => waiting.set(id, resolve))
    input.write(JSON.stringify({ id, operation, ...(value === undefined ? {} : { input: value }) }) + "\n")
    return reply
  }
  const close = async () => {
    input.end()
    await done.catch(() => undefined)
    await fs.rm(resources, { recursive: true, force: true })
    await fs.rm(path.dirname(preferences), { recursive: true, force: true })
  }
  return { calls, request, close }
}

test("the stdio worker routes canonical capability operations through the real controller", async () => {
  const owned = await worker()
  try {
    const connected = await owned.request("connect", { mode: "shared", server: "http://synthetic.invalid" })
    expect(connected).toMatchObject({ id: 1, data: { status: "connected" } })
    const revision = (connected.data as { revision: number }).revision

    const snapshot = await owned.request("sessionSnapshot", { sessionID: parent })
    expect(snapshot).toMatchObject({ id: 2, data: { revision, sessionID: parent, sourceEpoch: "epoch", watermark: { seq: 3 }, before: "cursor", messages } })
    expect(owned.calls.at(-1)).toMatchObject({ method: "GET", route: `/api/session/${parent}/snapshot` })
    expect(owned.calls.at(-1)?.query.get("limit")).toBe("100")

    const switched = await owned.request("switchAgent", { sessionID: parent, revision, agent: "plan" })
    expect(switched).toEqual({ type: "reply", id: 3, data: null })
    expect(owned.calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.route, call.body])).toEqual([["POST", `/api/session/${parent}/agent`, { agent: "plan" }]])

    const exported = await owned.request("exportSession", { sessionID: parent, format: "json" })
    expect(exported).toMatchObject({ id: 4, data: { revision, sessionID: parent, format: "json", filename: `worker-export-${parent}.json`, mimeType: "application/json" } })
    expect(JSON.parse((exported.data as { content: string }).content)).toEqual({ info, messages })

    const before = owned.calls.length
    expect(await owned.request("saveExportSession", { sessionID: parent, format: "markdown" })).toEqual({ type: "reply", id: 5, error: "Saving exports to a folder is unavailable in this runtime. Copy the export instead." })
    expect(await owned.request("save-export-session", { sessionID: parent, format: "markdown" })).toEqual({ type: "reply", id: 6, error: "Unsupported native desktop operation." })
    expect(await owned.request("switch-agent", { sessionID: parent, revision, agent: "plan" })).toEqual({ type: "reply", id: 7, error: "Unsupported native desktop operation." })
    expect(owned.calls).toHaveLength(before)

    expect(await owned.request("terminals", { sessionID: "invalid" })).toMatchObject({ id: 8, error: "Choose a Session terminal." })
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
}, 30_000)

test("every canonical capability operation is accepted by the stdio worker", async () => {
  const owned = await worker()
  const operations = ["sessionSnapshot", "pendingInputs", "sessionInsights", "switchAgent", "activateSkill", "runShell", "sendEditorContext", "openSideChat", "steerParent", "prediction", "promptGenerate", "terminals", "terminal", "exportSession", "artifacts", "artifact", "manageArtifact", "usageDashboard", "incidents", "manageIncident", "appendTelemetry", "telemetryConsent"]
  try {
    for (const operation of operations) {
      const reply = await owned.request(operation, { invalid: true })
      expect(reply.error, operation).not.toBe("Unsupported native desktop operation.")
      expect(reply.error, operation).toBeTruthy()
    }
    expect(owned.calls).toEqual([])
  } finally { await owned.close() }
}, 30_000)
