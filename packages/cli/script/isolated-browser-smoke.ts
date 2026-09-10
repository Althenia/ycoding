#!/usr/bin/env bun

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const PASSWORD = "isolated-browser-smoke-password"
const PRIVATE_MARKER = "isolated-browser-private-marker-4f17"
const binary = process.argv.find((arg) => arg.startsWith("--binary="))?.slice("--binary=".length)
if (!binary) throw new Error("Usage: bun script/isolated-browser-smoke.ts --binary=/path/to/ycoding")
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Isolated-browser packaging smoke is approved only for macOS arm64")
}

const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-isolated-browser-packaged-"))
const home = path.join(root, "home")
const config = path.join(root, "config")
const data = path.join(root, "data")
const cache = path.join(root, "cache")
const state = path.join(root, "state")
const project = path.join(root, "project")
await Promise.all([home, config, data, cache, state, project].map((directory) => mkdir(directory)))

let actions = 0
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/action") {
      actions++
      return new Response(null, { status: 204 })
    }
    if (url.pathname !== "/fixture") return new Response(null, { status: 204 })
    return new Response(
      "<!doctype html><title>Packaged fixture</title><button aria-label='Submit' onclick=\"fetch('/action',{method:'POST'});document.title='Clicked'\">Go</button>" +
        `<input aria-label="Private" value="${PRIVATE_MARKER}">`,
      { headers: { "content-type": "text/html" } },
    )
  },
})
const child = Bun.spawn([path.resolve(binary), "serve", "--stdio", "--port", "0"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  cwd: project,
  env: {
    ...process.env,
    NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    YCODING_PASSWORD: PASSWORD,
    YCODING_DISABLE_CHANNEL_DB: "1",
  },
})
let leakedPrivateMarker = false

try {
  const ready = await readiness(child.stdout)
  const base = new URL(ready.url)
  if (base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
    throw new Error(`Packaged server did not bind loopback: ${base.hostname}`)
  const auth = `Basic ${Buffer.from(`ycoding:${PASSWORD}`).toString("base64")}`
  const request = async (pathname: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers)
    headers.set("authorization", auth)
    const response = await fetch(new URL(pathname, base), { ...options, headers })
    return response
  }
  const post = (value: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
  const sessionID = "ses_isolated_packaged_smoke"
  await ok(await request("/api/session", post({ id: sessionID, location: { directory: project } })), "create Session")
  const started = await dataOf(
    await ok(
      await request(
        `/api/session/${sessionID}/browser/isolated/start`,
        post({ url: `http://127.0.0.1:${fixture.port}/fixture?private=${PRIVATE_MARKER}` }),
      ),
      "start isolated browser",
    ),
  )
  const tab = record(started.tab, "start tab")
  const observed = await dataOf(
    await ok(
      await request(
        `/api/session/${sessionID}/browser/isolated/observe`,
        post({
          instanceID: started.instanceID,
          tabID: tab.id,
          generation: tab.generation,
          callID: "observe-packaged",
        }),
      ),
      "observe isolated browser",
    ),
  )
  const elements = Array.isArray(observed.elements) ? observed.elements : []
  const button = elements.find(
    (element) =>
      typeof element === "object" &&
      element !== null &&
      "role" in element &&
      element.role === "button" &&
      "name" in element &&
      element.name === "Submit",
  )
  const ref = record(button, "semantic button").ref
  const completed = await dataOf(
    await ok(
      await request(
        `/api/session/${sessionID}/browser/isolated/action`,
        post({
          instanceID: started.instanceID,
          tabID: observed.tabID,
          generation: observed.generation,
          documentGeneration: observed.documentGeneration,
          observationRevision: observed.revision,
          callID: "click-packaged",
          action: { type: "click", ref },
        }),
      ),
      "click isolated browser",
    ),
  )
  if (completed.status !== "completed") throw new Error(`Packaged click did not complete: ${String(completed.status)}`)
  await eventually(() => actions === 1)
  if (JSON.stringify({ started, observed, completed }).includes(PRIVATE_MARKER))
    throw new Error("Packaged isolated-browser API disclosed a private marker")
  const stopped = await request(`/api/session/${sessionID}/browser/isolated`, { method: "DELETE" })
  if (stopped.status !== 204) throw new Error(`stop isolated browser returned ${stopped.status}`)
} finally {
  await fixture.stop(true)
  child.kill()
  const stderr = await new Response(child.stderr).text()
  await child.exited.catch(() => undefined)
  leakedPrivateMarker = stderr.includes(PRIVATE_MARKER)
  await rm(root, { recursive: true, force: true })
}
if (leakedPrivateMarker) throw new Error("Packaged server logs disclosed a private marker")
console.log(`Isolated-browser packaged smoke passed: ${path.basename(binary)} private-pipe start/observe/click/stop`)

async function readiness(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let output = ""
  while (!output.includes("\n")) {
    const next = await reader.read()
    if (next.done) break
    output += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  const line = output.split("\n").map((value) => value.trim()).find(Boolean)
  if (!line) throw new Error("Packaged server produced no readiness line")
  const value: unknown = JSON.parse(line)
  const ready = record(value, "readiness payload")
  if (typeof ready.url !== "string") throw new Error("Packaged server readiness omitted its URL")
  return { url: ready.url }
}

async function ok(response: Response, phase: string) {
  if (!response.ok) throw new Error(`${phase} returned ${response.status}: ${await response.text()}`)
  return response
}

async function dataOf(response: Response) {
  const body: unknown = await response.json()
  return record(record(body, "response").data, "response data")
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return Object.fromEntries(Object.entries(value))
}

async function eventually(condition: () => boolean) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for the packaged browser action fixture")
}
