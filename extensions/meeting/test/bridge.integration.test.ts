import { afterEach, expect, setSystemTime, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startBridge } from "../src/bridge"
import { sendControl } from "../src/bridge-client"
import { meetingControl, meetingDirectory } from "../src/discovery"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"
import { meetingConfigSchema } from "../src/config"
import { Message } from "../../../packages/ai/src/schema/messages"
import type { AnalysisContext } from "../src/plugin"
import { Agent, Model } from "@ycoding-ai/plugin"
import { Session } from "../../../packages/schema/src/session"
import { viewAssets, viewPolicy } from "../view/assets"

const origin = `chrome-extension://${"a".repeat(32)}`
const otherOrigin = `chrome-extension://${"b".repeat(32)}`
const controlToken = "controller-test-credential-with-32-bytes"
const bridges: Awaited<ReturnType<typeof startBridge>>[] = []
afterEach(async () => {
  setSystemTime()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

async function fixture(onCapture: (input: unknown) => Promise<unknown> = async (input) => input) {
  const calls: unknown[] = []
  const bridge = await startBridge({
    port: 0,
    controlToken,
    onControl: async (input) => {
      calls.push(input)
      return { ok: true }
    },
    onCapture,
  })
  bridges.push(bridge)
  const request = (
    route: string,
    body: unknown,
    token?: string,
    requestOrigin: string | null = origin,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${bridge.url}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(requestOrigin ? { origin: requestOrigin } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    })
  const pair = async () => {
    const code = bridge.pairing().code
    const response = await request("/pair", { code })
    expect(response.status).toBe(200)
    const result = (await response.json()) as { token: string }
    return { token: result.token, code }
  }
  return { bridge, request, pair, calls }
}

test("Reader static page and exact assets are key-free, no-store and protected by loopback Host", async () => {
  const f = await fixture()
  const view = await sendControl(f.bridge.url, controlToken, { action: "view" })
  if (!view || typeof view !== "object" || !("url" in view) || typeof view.url !== "string")
    throw new Error("Bridge did not return the view URL")
  const key = new URL(view.url).hash.slice(5)
  expect(key).toMatch(/^[0-9a-f]{64}$/)
  for (const [route, asset] of viewAssets) {
    const response = await fetch(`${f.bridge.url}${route}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(asset.type)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-security-policy")).toBe(viewPolicy)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    const body = await response.text()
    expect(body).toBe(asset.body)
    expect(body).not.toContain(key)
    expect(body).not.toContain(controlToken)
    expect((await fetch(`${f.bridge.url}${route}`, { headers: { host: "localhost:1234" } })).status).toBe(403)
    expect((await fetch(`${f.bridge.url}${route}`, { headers: { origin: "https://example.com" } })).status).toBe(403)
    expect((await fetch(`${f.bridge.url}${route}`, { method: "POST" })).status).toBe(405)
  }
  expect((await fetch(`${f.bridge.url}/view/unknown.js`)).status).toBe(404)
  expect((await fetch(`${f.bridge.url}/view?key=${key}`)).status).toBe(400)
  const page = viewAssets.get("/view")!.body
  expect(page).not.toMatch(/<script[^>]*>\s*[^<\s]/)
})

test("one-use pairing pins exact extension Origin and separates controller authority", async () => {
  const f = await fixture()
  const code = f.bridge.pairing().code
  expect((await f.request("/pair", { code }, undefined, "https://meet.google.com")).status).toBe(403)
  const responses = await Promise.all([f.request("/pair", { code }), f.request("/pair", { code })])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401])
  const token = ((await responses.find((r) => r.status === 200)!.json()) as { token: string }).token
  expect((await f.request("/control", { type: "analysis" }, token, null)).status).toBe(401)
  expect((await f.request("/control", { type: "analysis" }, controlToken)).status).toBe(403)
  expect((await f.request("/control", { type: "analysis" }, controlToken, null)).status).toBe(200)
  expect(f.calls).toEqual([{ type: "analysis" }])
  expect((await f.request("/capture", { type: "heartbeat", captureID: "capture-1" }, token, otherOrigin)).status).toBe(
    403,
  )
  expect((await f.request("/capture", { type: "heartbeat", captureID: "capture-1" }, token, null)).status).toBe(403)
  expect((await f.request("/capture", { type: "heartbeat", captureID: "capture-1" }, controlToken)).status).toBe(401)
})

test("pairing rotation invalidates older codes and capture credentials", async () => {
  const f = await fixture()
  const first = await f.pair()
  const stale = f.bridge.pairing().code
  const next = f.bridge.pairing().code
  expect((await f.request("/pair", { code: stale })).status).toBe(401)
  expect((await f.request("/pair", { code: next }, undefined, otherOrigin)).status).toBe(200)
  expect((await f.request("/capture", { type: "heartbeat", captureID: "c" }, first.token)).status).toBe(403)
})

test("pairing expires after sixty seconds without consumption, and close disconnects active capture once", async () => {
  let disconnected = 0
  const f = await fixture()
  const pairing = f.bridge.pairing()
  expect(pairing.expiresAt - Date.now()).toBeLessThanOrEqual(60_000)
  setSystemTime(pairing.expiresAt)
  expect((await f.request("/pair", { code: pairing.code })).status).toBe(401)
  setSystemTime()
  const bridge = await startBridge({
    port: 0,
    controlToken,
    onControl: async () => null,
    onCapture: async () => ({ accepted: true }),
    onDisconnect: () => {
      disconnected++
    },
  })
  bridges.push(bridge)
  const token = await pairingToken(bridge)
  expect(
    (
      await fetch(`${bridge.url}/capture`, {
        method: "POST",
        headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "start", captureID: "c", tabID: 1, microphone: false, consent: true }),
      })
    ).status,
  ).toBe(200)
  await bridge.close()
  await bridge.close()
  expect(disconnected).toBe(1)
})

test("rejects rebinding Host, queries, browser control, invalid content type and oversized body", async () => {
  const f = await fixture()
  const { token } = await f.pair()
  const body = { type: "heartbeat", captureID: "c" }
  expect((await f.request("/capture", body, token, origin, { host: "evil.invalid" })).status).toBe(403)
  expect((await f.request(`/capture?token=${token}`, body, token)).status).toBe(400)
  expect((await f.request("/control", {}, controlToken, "null")).status).toBe(403)
  expect((await f.request("/capture", body, token, origin, { "content-type": "text/plain" })).status).toBe(415)
  expect((await f.request("/control", { text: "x".repeat(1_048_576) }, controlToken, null)).status).toBe(413)
  const preflight = await fetch(`${f.bridge.url}/capture`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe(origin)
  expect(preflight.headers.get("access-control-allow-credentials")).toBeNull()
})

test("validates capture PCM and every union field before delivery", async () => {
  const received: unknown[] = []
  const f = await fixture(async (input) => {
    received.push(input)
    return { ok: true }
  })
  const { token } = await f.pair()
  const audio = {
    type: "audio",
    captureID: "c",
    source: "remote",
    sequence: 0,
    startMs: 0,
    sampleRate: 48000,
    pcm: pcm([0, -1, 1, 0.5]),
  }
  for (const invalid of [
    { type: "start", captureID: "c", tabID: 1, microphone: false, consent: false },
    { type: "start", captureID: "c", tabID: -1, microphone: false, consent: true },
    { ...audio, source: "both" },
    { ...audio, sequence: -1 },
    { ...audio, sequence: 0.5 },
    { ...audio, startMs: -1 },
    { ...audio, sampleRate: 192001 },
    { ...audio, pcm: "AA==" },
    { ...audio, pcm: pcm([NaN]) },
    { ...audio, pcm: pcm([Infinity]) },
    { ...audio, pcm: pcm([1.1]) },
    { ...audio, pcm: pcm(Array.from({ length: 48001 }, () => 0)) },
    { ...audio, pcm: "not base64" },
    { type: "stop", captureID: "c", reason: "" },
    { type: "heartbeat", captureID: "" },
    { type: "heartbeat", captureID: "c", token: "injected" },
    { type: "analysis", captureID: "c" },
  ])
    expect((await f.request("/capture", invalid, token)).status).toBe(400)
  expect(received).toEqual([])
  for (const valid of [
    { type: "start", captureID: "c", tabID: 1, microphone: true, consent: true },
    audio,
    { type: "heartbeat", captureID: "c" },
    { type: "stop", captureID: "c", reason: "user" },
  ]) {
    expect((await f.request("/capture", valid, token)).status).toBe(200)
  }
  expect(received).toHaveLength(4)
})

test("429 retains backend authority over pressure and duplicate idempotency; failures expose no details", async () => {
  const received: unknown[] = []
  const f = await fixture(async (input) => {
    received.push(input)
    if (received.length === 1) return { busy: true }
    if (received.length === 4) throw new Error("secret callback details")
    return { ok: true }
  })
  const { token } = await f.pair()
  const audio = {
    type: "audio",
    captureID: "c",
    source: "microphone",
    sequence: 10,
    startMs: 20,
    sampleRate: 16000,
    pcm: pcm([0]),
  }
  const busy = await f.request("/capture", audio, token)
  expect(busy.status).toBe(429)
  expect(busy.headers.get("retry-after")).toBe("1")
  expect((await f.request("/capture", audio, token)).status).toBe(200)
  expect((await f.request("/capture", audio, token)).status).toBe(200)
  expect(received.slice(0, 3)).toEqual([audio, audio, audio])
  const failed = await f.request("/capture", audio, token)
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: "callback_failed" })
  expect(failed.headers.get("cache-control")).toBe("no-store")
})

test("native control client preserves safe parent errors, and heartbeat is independent of blocked audio ACK", async () => {
  const release: { audio?: () => void; entered?: () => void } = {}
  const entered = new Promise<void>((resolve) => {
    release.entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release.audio = resolve
  })
  const bridge = await startBridge({
    port: 0,
    controlToken,
    onControl: async () => ({ error: "Select an available model in the TUI" }),
    onCapture: async (message) => {
      if (message.type === "audio") {
        release.entered!()
        await waiting
      }
      return message.type === "heartbeat" ? { stop: true } : { accepted: true }
    },
  })
  bridges.push(bridge)
  expect(await sendControl(bridge.url, controlToken, { type: "start" })).toEqual({
    error: "Select an available model in the TUI",
  })
  const token = await pairingToken(bridge)
  const post = (input: unknown) =>
    fetch(`${bridge.url}/capture`, {
      method: "POST",
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  const audio = post({
    type: "audio",
    captureID: "c",
    source: "remote",
    sequence: 0,
    startMs: 0,
    sampleRate: 48000,
    pcm: pcm([0]),
  })
  await entered
  const heartbeat = await post({ type: "heartbeat", captureID: "c" })
  expect(heartbeat.status).toBe(200)
  expect(await heartbeat.json()).toEqual({ stop: true })
  release.audio!()
  expect((await audio).status).toBe(200)
})

function pcm(values: number[]) {
  const buffer = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  return buffer.toString("base64")
}

async function pairingToken(bridge: Awaited<ReturnType<typeof startBridge>>) {
  const response = await fetch(`${bridge.url}/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: bridge.pairing().code }),
  })
  const value: unknown = await response.json()
  if (
    !response.ok ||
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string"
  )
    throw new Error("Invalid pairing response")
  return value.token
}

test("successful pairing reports redemption once and failed codes do not", async () => {
  let paired = 0
  const bridge = await startBridge({
    controlToken,
    onControl: async () => null,
    onCapture: async () => null,
    onPaired: () => {
      paired++
    },
  })
  bridges.push(bridge)
  const pair = (code: string) =>
    fetch(`${bridge.url}/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
  const code = bridge.pairing().code
  expect((await pair("wrong-code")).status).toBe(401)
  expect(paired).toBe(0)
  expect((await pair(code)).status).toBe(200)
  expect(paired).toBe(1)
  expect((await pair(code)).status).toBe(401)
  expect(paired).toBe(1)
})

test("the TUI controller reconnects after the runtime publishes or replaces its bridge descriptor", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-project-"))
  const data = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-data-"))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = data
  try {
    const control = meetingControl(project)
    const missing = await control({ action: "status" }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(missing).toMatchObject({ code: "ENOENT" })
    const directory = await meetingDirectory(project)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const publish = async (response: unknown) => {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
      const bridge = await startBridge({
        controlToken: token,
        onControl: async () => response,
        onCapture: async () => null,
      })
      bridges.push(bridge)
      await writeFile(
        path.join(directory, "bridge.json"),
        JSON.stringify({ url: bridge.url, token, pid: process.pid }),
        {
          mode: 0o600,
        },
      )
      return bridge
    }
    const first = await publish({ runtime: "first" })
    expect(await control({ action: "status" })).toEqual({ runtime: "first" })
    await first.close()
    await publish({ runtime: "restarted" })
    expect(await control({ action: "status" })).toEqual({ runtime: "restarted" })
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await Promise.all([project, data].map((directory) => rm(directory, { recursive: true, force: true })))
  }
})

test("live-view key is independent, native-only to obtain, and enforces exact Host/Origin without CORS", async () => {
  const calls: unknown[] = []
  const bridge = await startBridge({
    controlToken,
    onControl: async (input) => {
      calls.push(input)
      return { meeting: { id: "m" } }
    },
    onCapture: async () => ({ stop: true, reason: "inference_failed" }),
    onView: () => ({
      meeting: { id: "m" },
      meetings: [],
      segments: [],
      findings: [],
      health: {},
      audio: {},
      analysis: {},
      config: {},
      ask: { history: [], busy: false },
      controlToken: "must-not-be-visible",
    }),
    onAsk: async (question) => ({ question, answer: "Supported by transcript", status: "answered" }),
  })
  bridges.push(bridge)
  const result = await sendControl(bridge.url, controlToken, { action: "view" })
  if (typeof result !== "object" || result === null || !("url" in result) || typeof result.url !== "string")
    throw new Error("Missing live-view URL")
  const address = new URL(result.url)
  const key = new URLSearchParams(address.hash.slice(1)).get("key")!
  expect(address.pathname).toBe("/view")
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(key).not.toBe(controlToken)
  const captureToken = await pairingToken(bridge)
  expect(key).not.toBe(captureToken)
  const get = (token: string, extra: Record<string, string> = {}) =>
    fetch(`${bridge.url}/view/state`, { headers: { authorization: `Bearer ${token}`, ...extra } })
  expect((await get(controlToken)).status).toBe(401)
  expect((await get(captureToken)).status).toBe(401)
  const extensionView = await get(key, { origin })
  expect(extensionView.status).toBe(403)
  expect(extensionView.headers.get("access-control-allow-origin")).toBeNull()
  expect((await get(key, { origin: "https://evil.invalid" })).status).toBe(403)
  expect((await get(key, { host: "localhost" })).status).toBe(403)
  const state = await get(key, { origin: bridge.url })
  expect(state.status).toBe(200)
  expect(state.headers.get("access-control-allow-origin")).toBeNull()
  expect(state.headers.get("cache-control")).toBe("no-store")
  const text = await state.text()
  expect(text).not.toContain("must-not-be-visible")
  expect(JSON.parse(text).ask).toEqual({ history: [], busy: false })
  expect(
    (await fetch(`${bridge.url}/view/state?key=${key}`, { headers: { authorization: `Bearer ${key}` } })).status,
  ).toBe(400)
  expect((await fetch(`${bridge.url}/view/state`, { method: "OPTIONS", headers: { origin: bridge.url } })).status).toBe(
    405,
  )
  const post = (route: string, body: unknown, token = key) =>
    fetch(`${bridge.url}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: bridge.url },
      body: JSON.stringify(body),
    })
  for (const action of ["pair", "stop", "retry"]) expect((await post("/view/control", { action })).status).toBe(200)
  for (const body of [
    { action: "start" },
    { action: "configure" },
    { action: "approve" },
    { action: "stop", meetingID: "other" },
    { action: ["stop"] },
  ])
    expect((await post("/view/control", body)).status).toBe(400)
  expect(calls).toEqual([{ action: "pair" }, { action: "stop" }, { action: "retry" }])
  expect((await post("/control", { action: "stop" }, key)).status).toBe(403)
  expect((await post("/view/ask", { question: "What is the decision?" })).status).toBe(200)
  for (const body of [{ question: "" }, { question: "x".repeat(2001) }, { question: "Hello", meetingID: "other" }])
    expect((await post("/view/ask", body)).status).toBe(400)
  expect((await post("/view/control", { action: "stop", text: "x".repeat(20000) })).status).toBe(413)
  const capture = await fetch(`${bridge.url}/capture`, {
    method: "POST",
    headers: { origin, authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", captureID: "c" }),
  })
  expect(await capture.json()).toEqual({ stop: true, reason: "inference_failed" })
})

test("live-view ask busy and answer errors remain visible without exposing exception details", async () => {
  const bridge = await startBridge({
    controlToken,
    onControl: async () => null,
    onCapture: async () => null,
    onView: () => ({ meeting: { id: "m" }, ask: { history: [], busy: false } }),
    onAsk: async (question) => {
      if (question === "busy") return { busy: true }
      throw new Error("private provider details")
    },
  })
  bridges.push(bridge)
  const result = await sendControl(bridge.url, controlToken, { action: "view" })
  if (typeof result !== "object" || result === null || !("url" in result) || typeof result.url !== "string")
    throw new Error("Missing live-view URL")
  const key = new URLSearchParams(new URL(result.url).hash.slice(1)).get("key")!
  const ask = (question: string) =>
    fetch(`${bridge.url}/view/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ question }),
    })
  expect((await ask("busy")).status).toBe(409)
  const failed = await ask("failure")
  expect(failed.status).toBe(502)
  expect(await failed.json()).toEqual({ error: "answer_failed" })
})

test("advisory questions use bounded labelled real transcript, isolate meeting ownership and retain only fifty results", async () => {
  const { createMeetingQuestions } = await import("../src/plugin")
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-view-questions-"))
  const store = new MeetingStore(path.join(directory, "meetings.sqlite"))
  const prompts: string[] = []
  const entered = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  const registered = new Set<string>()
  const service = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse({ analysis: { maxCharacters: 8000 } }),
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("Tools must not be invoked")
      },
    },
    createSession: async () => {
      const id = crypto.randomUUID()
      registered.add(id)
      return id
    },
    generate: async (sessionID, prompt) => {
      expect(registered.has(sessionID)).toBe(true)
      prompts.push(prompt)
      if (prompts.length === 1) {
        entered.resolve()
        return answer.promise
      }
      if (prompt.includes("force answer failure")) throw new Error("private provider token")
      return "Evidence-based advisory answer"
    },
  })
  try {
    for (const id of ["m-one", "m-two"]) store.createMeeting({ id, title: id, sessionID: `s-${id}` })
    store.putSegment({
      id: "final",
      meetingID: "m-one",
      sequence: 1,
      source: "remote",
      speakerID: "remote",
      startMs: 0,
      endMs: 1000,
      rawText: "Approved the proposal",
      text: "Approved the proposal",
      state: "final",
      model: "fixture",
      createdAt: new Date().toISOString(),
    })
    store.putSegment({
      id: "temporary",
      meetingID: "m-one",
      sequence: 2,
      source: "microphone",
      speakerID: "local",
      startMs: 1000,
      endMs: 2000,
      rawText: "Maybe later",
      text: "Maybe later",
      state: "temporary",
      model: "fixture",
      createdAt: new Date().toISOString(),
    })
    await service.control({ action: "select", meetingID: "m-one" })
    const questions = createMeetingQuestions(service)
    const first = questions.ask("What was approved?")
    await entered.promise
    expect(questions.state().ask.busy).toBe(true)
    let settled = false
    const settling = questions.settled().then(() => {
      settled = true
    })
    expect(await questions.ask("Another question")).toEqual({ busy: true })
    expect(prompts[0].length).toBeLessThanOrEqual(8000)
    expect(prompts[0]).toContain('"source":"remote"')
    expect(prompts[0]).toContain('"state":"final"')
    expect(prompts[0]).toContain('"source":"microphone"')
    expect(prompts[0]).toContain('"state":"temporary"')
    expect(prompts[0]).toContain("untrusted")
    await service.control({ action: "select", meetingID: "m-two" })
    expect(questions.state().ask.history).toEqual([])
    expect(settled).toBe(false)
    answer.resolve("The proposal was approved [final]")
    expect(await first).toMatchObject({ answer: "The proposal was approved [final]", status: "answered" })
    await settling
    expect(settled).toBe(true)
    await service.control({ action: "select", meetingID: "m-one" })
    for (let index = 0; index < 51; index++) await questions.ask(`Question ${index}`)
    expect(questions.state().ask.history).toHaveLength(50)
    expect(questions.state().ask.history[0].question).toBe("Question 1")
    const failed = await questions.ask("force answer failure")
    expect(failed).toMatchObject({ status: "error", error: "answer_failed" })
    expect(JSON.stringify(questions.state().ask.history)).not.toContain("private provider token")
    expect(createMeetingQuestions(service).state().ask.history).toEqual([])
    await service.control({ action: "select", meetingID: "m-two" })
    const beforeEmpty = prompts.length
    expect(await questions.ask("Can you answer without evidence?")).toMatchObject({
      status: "error",
      error: "no_transcript",
    })
    expect(prompts).toHaveLength(beforeEmpty)
    store.putSegment({
      id: "large",
      meetingID: "m-two",
      sequence: 1,
      source: "remote",
      speakerID: "remote",
      startMs: 0,
      endMs: 1000,
      rawText: "x".repeat(9000),
      text: "x".repeat(9000),
      state: "final",
      model: "fixture",
      createdAt: new Date().toISOString(),
    })
    expect(await questions.ask("What does the long segment say?")).toMatchObject({
      status: "error",
      error: "answer_failed",
    })
    expect(prompts).toHaveLength(beforeEmpty)
    expect(prompts.every((prompt) => prompt.length <= 8000)).toBe(true)
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("registered analysis context keeps exactly one bounded text input and strips every tool", async () => {
  const { restrictAnalysisContext } = await import("../src/plugin")
  const sessionID = Session.ID.make("ses_analysis_session")
  const make = (messages: Message[]): AnalysisContext => ({
    sessionID,
    agent: Agent.ID.make("meeting-intelligence"),
    model: Model.Ref.parse("fixture/fixture"),
    messages,
    system: [],
    tools: { shell: { description: "must be removed", input: {} } },
  })
  const event = make([Message.user("old question"), Message.assistant("old answer"), Message.user("bounded evidence")])
  restrictAnalysisContext(event, new Set([sessionID]), 8000)
  expect(event.messages).toHaveLength(1)
  expect(event.messages[0].content).toEqual([{ type: "text", text: "bounded evidence" }])
  expect(event.tools).toEqual({})
  expect(event.system[0].text).toContain("untrusted evidence")
  expect(() => restrictAnalysisContext(make([Message.user("x".repeat(8001))]), new Set([sessionID]), 8000)).toThrow(
    "bounded user-data input",
  )
  expect(() =>
    restrictAnalysisContext(
      make([Message.user([{ type: "media", mediaType: "image/png", data: "unsupported" }])]),
      new Set([sessionID]),
      8000,
    ),
  ).toThrow("bounded user-data input")
  const ordinary = make([Message.user("ordinary session")])
  restrictAnalysisContext(ordinary, new Set(), 8000)
  expect(ordinary.tools).toHaveProperty("shell")
})

test("Ask labels evidence omitted by its bounded recent-transcript read", async () => {
  const { createMeetingQuestions } = await import("../src/plugin")
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-view-window-"))
  const store = new MeetingStore(path.join(directory, "meetings.sqlite"))
  const prompts: string[] = []
  const service = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse({ analysis: { maxCharacters: 64000 } }),
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("No tools")
      },
    },
    createSession: async () => "analysis",
    generate: async (_, prompt) => {
      prompts.push(prompt)
      return "Advisory answer"
    },
  })
  try {
    store.createMeeting({ id: "long", title: "Long", sessionID: "analysis" })
    store.transaction(() => {
      for (let sequence = 1; sequence <= 502; sequence++)
        store.putSegment({
          id: `s-${sequence}`,
          meetingID: "long",
          sequence,
          source: "remote",
          speakerID: "remote",
          startMs: sequence * 1000,
          endMs: (sequence + 1) * 1000,
          rawText: "Evidence",
          text: "Evidence",
          state: "final",
          model: "fixture",
          createdAt: new Date().toISOString(),
        })
    })
    await service.control({ action: "select", meetingID: "long" })
    await createMeetingQuestions(service).ask("What evidence is available?")
    expect(prompts[0]).toContain('"omittedEarlierEvidence":true')
    expect(prompts[0].length).toBeLessThanOrEqual(64000)
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
