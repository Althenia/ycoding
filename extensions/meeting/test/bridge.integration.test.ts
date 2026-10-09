import { afterEach, expect, setSystemTime, test } from "bun:test"
import { startBridge } from "../src/bridge"
import { sendControl } from "../src/bridge-client"

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
