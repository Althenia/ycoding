import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../packages/tui/src/config"
import { ThemeProvider } from "../../../packages/tui/src/context/theme"
import { createTuiResolvedConfig } from "../../../packages/tui/test/fixture/tui-runtime"
import { sendControl } from "../src/bridge-client"
import { connectControl, meetingDirectory } from "../src/discovery"
import { MeetingPage, type MeetingContext } from "../src/tui"
import { isMeetingView } from "../src/view"
import { viewAssets, viewPolicy } from "../view/assets"
import { createDelivery } from "../view/delivery.js"
import { describeView, readViewKey } from "../view/model.js"
import { readFile } from "node:fs/promises"

test("existing discovery, native control, page delivery and TUI consume the real Rust Meeting bridge", async () => {
  const directory = process.env.YCODING_TEST_MEETING_DIRECTORY
  if (!directory) throw new Error("Run through cargo test -p ycoding-runtime --test meeting_clients")
  const descriptor: unknown = JSON.parse(await readFile(`${await meetingDirectory(directory)}/bridge.json`, "utf8"))
  if (typeof descriptor !== "object" || descriptor === null || !("token" in descriptor))
    throw new Error("Missing Rust bridge descriptor")
  const control = await connectControl(directory)
  const page = await control({ action: "view" })
  if (typeof page !== "object" || page === null || !("url" in page) || typeof page.url !== "string")
    throw new Error("Missing Rust live page URL")
  const url = new URL(page.url)
  const key = readViewKey(url.hash)
  if (!key) throw new Error("Rust view key is not usable by the live page")
  expect(key).not.toBe(descriptor.token)
  for (const [route, asset] of viewAssets) {
    const response = await fetch(new URL(route, url))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(asset.type)
    expect(response.headers.get("content-security-policy")).toBe(viewPolicy)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(await response.text()).toBe(asset.body)
  }
  await expect(sendControl(url.origin, key, { action: "start" })).rejects.toThrow("Bridge control rejected (401)")
  const viewRequest = (route: string, body?: unknown) =>
    fetch(new URL(route, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin: url.origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  expect((await viewRequest("/view/control", { action: "start" })).status).toBe(400)
  const armed = await control({ action: "start", title: "Bridge parity meeting" })
  expect(armed).not.toHaveProperty("error")
  if (!isMeetingView(armed)) throw new Error("Rust did not return the TUI Meeting view")
  expect(armed.meeting?.status).toBe("ready")
  expect(describeView(armed).status).toBe("Ready · nothing is recording")
  const unavailable = await viewRequest("/view/ask", { question: "What was agreed?" })
  expect(unavailable.status).toBe(422)
  expect(await unavailable.json()).toMatchObject({ status: "error", error: "no_transcript" })
  const failure = await control({ action: "model-install", model: "openai/whisper-large-v3" })
  expect(failure).toEqual({ error: "Explicit model download authorization is required" })
  const failures: string[] = []
  const phases: string[] = []
  const delivery = createDelivery({
    key,
    fetch: (route, options) => {
      const headers = new Headers(options.headers)
      headers.set("origin", url.origin)
      return fetch(new URL(route, url), { ...options, headers })
    },
    wait: async () => {
      throw new Error("Unexpected pressure in a single-packet integration fixture")
    },
    onFailure: (reason) => failures.push(reason),
    onState: (phase) => phases.push(phase),
  })
  try {
    await delivery.send({ type: "start", captureID: "rust-client", microphone: false, consent: true })
    const recording = await viewRequest("/view/state")
    expect(recording.status).toBe(200)
    const recordingView = await recording.json()
    if (!isMeetingView(recordingView)) throw new Error("Rust recording state is not a Meeting view")
    expect(describeView(recordingView).status).toBe("REC · Recording")
    const samples = new Float32Array(16000).fill(0.1)
    await delivery.send({
      type: "audio",
      captureID: "rust-client",
      source: "remote",
      sequence: 0,
      startMs: 0,
      sampleRate: 16000,
      pcm: Buffer.from(samples.buffer).toString("base64"),
    })
    await delivery.send({ type: "heartbeat", captureID: "rust-client" })
    const stopped = await viewRequest("/view/control", { action: "stop" })
    expect(stopped.status).toBe(200)
    const state = await stopped.json()
    if (!isMeetingView(state)) throw new Error("Rust stop did not return the TUI Meeting view")
    expect(state.meeting?.status).toBe("stopped")
    expect(state.audio).not.toHaveProperty("error")
    expect(state.segments).toContainEqual(
      expect.objectContaining({ text: "สวัสดี Rust bridge", rawText: "สวัสดี Rust bridge", state: "final" }),
    )
    expect(phases).toEqual(["connected", "connected", "connected"])
    expect(failures).toEqual([])
  } finally {
    delivery.close()
  }
  const context: MeetingContext = {
    keymap: { layer: () => undefined },
    ui: {
      router: {
        current: () => ({ type: "plugin", id: "ycoding.meeting", name: "meeting" }),
        navigate: () => undefined,
      },
    },
  }
  const screen = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
          <MeetingPage context={context} control={control} />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 120, height: 40 },
  )
  screen.renderer.start()
  try {
    await screen.waitForFrame((frame) => frame.includes("Original: สวัสดี Rust bridge"))
    expect(screen.captureCharFrame()).toContain("Bridge parity meeting")
    expect(screen.captureCharFrame()).not.toContain("invalid view")
  } finally {
    screen.renderer.destroy()
  }
})
