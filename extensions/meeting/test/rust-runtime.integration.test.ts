import { expect, test } from "bun:test"
import { startMeetingRuntime } from "../script/dev"
import { startBackend } from "./fixture/runtime"

function transcription(config: Record<string, unknown>) {
  return record(config.transcription)
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return Object.fromEntries(Object.entries(value))
}

function viewKey(url: string) {
  const key = new URL(url).hash.slice("#key=".length)
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  return key
}

async function viewFetch(backend: Awaited<ReturnType<typeof startBackend>>, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${viewKey(backend.url)}`)
  return fetch(`${backend.origin}${pathname}`, { ...init, headers })
}

function pcm(samples: number) {
  const bytes = Buffer.alloc(samples * 4)
  for (let index = 0; index < samples; index++) bytes.writeFloatLE(0.2, index * 4)
  return bytes.toString("base64")
}

async function capture(backend: Awaited<ReturnType<typeof startBackend>>, body: unknown) {
  const response = await viewFetch(backend, "/view/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: record(await response.json()) }
}

test("the Rust runtime view serves the page and completes an HTTP capture lifecycle", async () => {
  const backend = await startBackend("beta")
  try {
    expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/view#key=[a-f0-9]{64}$/)
    const page = await fetch(backend.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("/view/app.js")

    expect((await fetch(`${backend.origin}/view/state`)).status).toBe(401)
    expect(
      (
        await fetch(`${backend.origin}/view/state`, {
          headers: { authorization: "Bearer 0000000000000000000000000000000000000000000000000000000000000000" },
        })
      ).status,
    ).toBe(401)
    expect((await viewFetch(backend, "/view/state", { method: "OPTIONS" })).status).toBe(405)
    expect((await viewFetch(backend, "/pair")).status).toBe(404)
    const queried = await viewFetch(backend, "/view/state?meeting=imported")
    expect(queried.status).toBe(400)
    expect(await queried.json()).toEqual({ error: "invalid_url" })

    const imported = await backend.status()
    expect(imported.meeting?.id).toBe("imported")
    expect(imported.segments[0]?.text).toBe("สวัสดี stable")
    expect(imported).not.toHaveProperty("pairing")

    for (const body of [
      { type: "start", captureID: "bad id!", microphone: false, consent: true },
      { type: "start", captureID: "http-flow", microphone: false, consent: false },
      {
        type: "audio",
        captureID: "http-flow",
        source: "remote",
        sequence: -1,
        startMs: 0,
        sampleRate: 16000,
        pcm: pcm(16),
      },
      { type: "audio", captureID: "http-flow", source: "remote", sequence: 0, startMs: 0, sampleRate: 0, pcm: pcm(16) },
      {
        type: "audio",
        captureID: "http-flow",
        source: "remote",
        sequence: 0,
        startMs: 0,
        sampleRate: 16000,
        pcm: "not base64!",
      },
      { type: "stop", captureID: "http-flow", reason: "" },
    ]) {
      const rejected = await capture(backend, body)
      expect(rejected.status, JSON.stringify(body)).toBe(400)
      expect(rejected.body).toEqual({ error: "invalid_capture" })
    }

    await backend.control({ action: "start", title: "HTTP capture flow" })
    expect(await capture(backend, { type: "start", captureID: "http-flow", microphone: false, consent: true })).toEqual(
      {
        status: 200,
        body: { accepted: true },
      },
    )
    expect(await capture(backend, { type: "start", captureID: "http-flow", microphone: false, consent: true })).toEqual(
      {
        status: 200,
        body: { accepted: true, duplicate: true },
      },
    )
    const audio = {
      type: "audio",
      captureID: "http-flow",
      source: "remote",
      sequence: 0,
      startMs: 0,
      sampleRate: 16000,
      pcm: pcm(16000),
    }
    expect(await capture(backend, audio)).toEqual({ status: 200, body: { accepted: true, duplicate: false } })
    expect(await capture(backend, audio)).toEqual({ status: 200, body: { accepted: true, duplicate: true } })
    expect(await capture(backend, { type: "heartbeat", captureID: "http-flow" })).toEqual({
      status: 200,
      body: { accepted: true },
    })
    expect(await capture(backend, { type: "stop", captureID: "http-flow", reason: "test_complete" })).toEqual({
      status: 200,
      body: { stop: true },
    })

    const settled = await backend.settled()
    expect(settled.meeting?.status).toBe("stopped")
    expect(settled.segments.map((segment) => segment.text)).toContain(
      "เราจะทดสอบ canary rollout และ transcription latency",
    )
    expect(settled.summary?.summary).toBe("สรุป rollout · unconfirmed")
    expect(settled.audio.sources?.remote).toBe("inactive")
  } finally {
    await backend.stop()
  }
}, 60000)

test("the Rust runtime view rejects invalid configuration and preserves the prior config", async () => {
  const backend = await startBackend("local")
  try {
    const before = await backend.status()
    expect(transcription(before.config).chunkSeconds).toBe(1)
    await expect(
      backend.control({
        action: "configure",
        config: { transcription: { pythonExecutable: "/missing/python", chunkSeconds: 31, overlapSeconds: 0 } },
      }),
    ).rejects.toThrow()
    await expect(
      backend.control({
        action: "configure",
        config: { transcription: { pythonExecutable: "/missing/python", chunkSeconds: 15, overlapSeconds: 15 } },
      }),
    ).rejects.toThrow()
    const after = await backend.status()
    expect(transcription(after.config).chunkSeconds).toBe(1)
    expect(transcription(after.config).overlapSeconds).toBe(0)
    expect(after.meeting).toBeUndefined()
    expect(after.meetings).toEqual([])
  } finally {
    await backend.stop()
  }
}, 60000)

test("the source launcher serves the Rust view, rejects unavailable executables and releases its listener on stop", async () => {
  const backend = await startBackend("local")
  try {
    expect((await backend.status()).health?.status).toBe("unloaded")
    await backend.control({ action: "start", title: "Launcher lifecycle" })
    const ready = await backend.status()
    expect(ready.meeting).toMatchObject({ title: "Launcher lifecycle", status: "ready" })
    expect(ready.health?.status).toBe("ready")
    expect(ready).not.toHaveProperty("pairing")
  } finally {
    await backend.stop()
  }
  await expect(fetch(`${backend.origin}/view/state`)).rejects.toThrow()
  await expect(
    startMeetingRuntime({
      env: { PATH: process.env.PATH, YCODING_RUNTIME_EXECUTABLE: "/nonexistent/ycoding-runtime" },
    }),
  ).rejects.toThrow()
}, 60000)
