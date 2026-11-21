#!/usr/bin/env bun

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { YCoding } from "@ycoding-ai/client/v5"

const PASSWORD = "isolated-browser-smoke-password"
export const PRIVATE_MARKER = "isolated-browser-private-marker-4f17"
const SESSION_ID = "ses_isolated_packaged_smoke"
const READINESS_LIMIT = 64 * 1024
const TAIL_LIMIT = 8_192
const STEP_TIMEOUT = 15_000
const STOP_TIMEOUT = 5_000

type Client = ReturnType<typeof YCoding.make>
type Exit = { readonly code: number } | { readonly error: unknown }
type SmokeRuntime = {
  readonly stdin: { end(): unknown }
  kill(signal?: number): unknown
  readonly exited: Promise<number>
}

export function isolatedBrowserSmokeEnvironment(
  root: string,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
) {
  const home = path.join(root, "home")
  const temporary = path.join(root, "tmp")
  return {
    ...ambient,
    HOME: home,
    YCODING_TEST_HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    YCODING_DB: undefined,
    YCODING_CONFIG_DIR: path.join(root, "config", "ycoding"),
    YCODING_CONFIG: undefined,
    YCODING_CONFIG_CONTENT: undefined,
    YCODING_REMOTE_URL: undefined,
    NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    YCODING_CONFIG_PROJECT_DISABLE: "1",
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_DISABLE_CHANNEL_DB: "1",
    YCODING_PASSWORD: PASSWORD,
  }
}

export function captureSmokeOutput(stream: ReadableStream<Uint8Array>) {
  const first = Promise.withResolvers<string>()
  first.promise.catch(() => undefined)
  const decoder = new TextDecoder()
  let settled = false
  let pending = ""
  let carry = ""
  let retained = ""
  let leaked = false

  const resolveFirst = (line: string) => {
    settled = true
    pending = ""
    first.resolve(line)
  }
  const rejectFirst = (error: unknown) => {
    settled = true
    pending = ""
    first.reject(error)
  }
  const readiness = (text: string) => {
    pending += text
    for (let newline = pending.indexOf("\n"); !settled && newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line.length > READINESS_LIMIT) return rejectFirst(new Error("Packaged runtime readiness exceeded 64 KiB"))
      if (line) return resolveFirst(line)
    }
    if (!settled && pending.length > READINESS_LIMIT)
      rejectFirst(new Error("Packaged runtime readiness exceeded 64 KiB"))
  }
  const observe = (text: string) => {
    if (!text) return
    const window = carry + text
    if (window.includes(PRIVATE_MARKER)) leaked = true
    carry = window.slice(-(PRIVATE_MARKER.length - 1))
    retained = (retained + text).slice(-(TAIL_LIMIT + PRIVATE_MARKER.length))
    if (!settled) readiness(text)
  }

  const done = (async () => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        observe(decoder.decode(next.value, { stream: true }))
      }
      observe(decoder.decode())
      if (settled) return
      const line = pending.trim()
      if (line) resolveFirst(line)
      else rejectFirst(new Error("Packaged runtime produced no readiness line"))
    } catch (error) {
      if (!settled) rejectFirst(error)
      throw error
    } finally {
      reader.releaseLock()
    }
  })()
  done.catch(() => undefined)

  return {
    firstLine: first.promise,
    done,
    leaked: () => leaked,
    tail: () => retained.replaceAll(PRIVATE_MARKER, "[private marker]").slice(-TAIL_LIMIT),
  }
}

export async function stopSmokeRuntime(child: SmokeRuntime, timeout = STOP_TIMEOUT) {
  const failures: unknown[] = []
  const exit: Promise<Exit> = child.exited.then(
    (code) => ({ code }),
    (error: unknown) => ({ error }),
  )
  try {
    await child.stdin.end()
  } catch (error) {
    failures.push(error)
  }
  let outcome = failures.length === 0 ? await within(exit, timeout) : undefined
  for (const signal of [15, 9]) {
    if (outcome) break
    try {
      child.kill(signal)
    } catch (error) {
      failures.push(error)
      continue
    }
    outcome = await within(exit, timeout)
  }
  if (!outcome) failures.push(new Error("Packaged runtime did not exit after termination"))
  else if ("error" in outcome) failures.push(outcome.error)
  else if (outcome.code !== 0) failures.push(new Error(`Packaged runtime exited with code ${outcome.code}`))
  raise(failures)
}

export async function runIsolatedBrowserSmoke(
  client: Client,
  input: { project: string; url: string; actions: () => number; timeout?: number },
) {
  const timeout = input.timeout ?? STEP_TIMEOUT
  const sessionID = SESSION_ID
  const step = async <T>(phase: string, operation: Promise<T>): Promise<T> => {
    operation.catch(() => undefined)
    const expired = Symbol("expired")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        operation,
        new Promise<typeof expired>((resolve) => {
          timer = setTimeout(resolve, timeout, expired)
        }),
      ])
      if (result === expired) throw new Error(`${phase}: timed out`)
      return result
    } catch (error) {
      if (error instanceof Error && error.message === `${phase}: timed out`) throw error
      throw new Error(`${phase}: ${describe(error)}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
  }
  const failures: unknown[] = []
  const attempt = async (cleanup: () => Promise<unknown>) => {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  let created = false
  let started = false
  try {
    await step("create Session", client.session.create({ id: sessionID, location: { directory: input.project } }))
    created = true
    started = true
    const browser = await step("start isolated browser", client.isolatedBrowser.start({ sessionID, url: input.url }))
    if (browser.instanceID === undefined || browser.tab === undefined)
      throw new Error(`Packaged isolated browser did not start a tab: ${browser.state}`)
    const { instanceID, tab } = browser
    const observed = await step(
      "observe isolated browser",
      client.isolatedBrowser.observe({
        sessionID,
        instanceID,
        tabID: tab.id,
        generation: tab.generation,
        callID: "observe-packaged",
      }),
    )
    if (observed.instanceID !== instanceID || observed.tabID !== tab.id)
      throw new Error("Packaged isolated-browser observation changed browser ownership")
    if (JSON.stringify({ browser, observed }).includes(PRIVATE_MARKER))
      throw new Error("Packaged isolated-browser API disclosed a private marker")
    const button = observed.elements.find((element) => element.role === "button" && element.name === "Submit")
    if (button === undefined) throw new Error("Packaged isolated browser did not expose the semantic button")
    const completed = await step(
      "click isolated browser",
      client.isolatedBrowser.action({
        sessionID,
        instanceID,
        tabID: observed.tabID,
        generation: observed.generation,
        documentGeneration: observed.documentGeneration,
        observationRevision: observed.revision,
        callID: "click-packaged",
        action: { type: "click", ref: button.ref },
      }),
    )
    if (completed.status !== "completed") throw new Error(`Packaged click did not complete: ${completed.status}`)
    if (JSON.stringify({ browser, observed, completed }).includes(PRIVATE_MARKER))
      throw new Error("Packaged isolated-browser API disclosed a private marker")
    const deadline = Date.now() + timeout
    while (input.actions() < 1) {
      if (Date.now() >= deadline) throw new Error("wait for browser action fixture: timed out")
      await Bun.sleep(25)
    }
    if (input.actions() > 1) throw new Error("Packaged browser action fixture received the click more than once")
  } catch (error) {
    failures.push(error)
  }
  if (started) {
    await attempt(() => step("stop isolated browser", client.isolatedBrowser.stop({ sessionID })))
    await attempt(async () => {
      const status = await step("read isolated browser status", client.isolatedBrowser.status({ sessionID }))
      if (status.state !== "stopped") throw new Error(`Packaged isolated browser did not stop: ${status.state}`)
    })
  }
  if (created) await attempt(() => step("remove Session", client.session.remove({ sessionID })))
  client.transport.close()
  raise(failures)
}

async function main() {
  const binary = process.argv.find((arg) => arg.startsWith("--binary="))?.slice("--binary=".length)
  if (!binary) throw new Error("Usage: bun script/isolated-browser-smoke.ts --binary=/path/to/ycoding")
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Isolated-browser packaging smoke is approved only for macOS arm64")
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-isolated-browser-packaged-"))
  const project = path.join(root, "project")
  const environment = isolatedBrowserSmokeEnvironment(root)
  await Promise.all(
    [
      environment.HOME,
      environment.YCODING_CONFIG_DIR,
      environment.XDG_DATA_HOME,
      environment.XDG_CACHE_HOME,
      environment.XDG_STATE_HOME,
      environment.TMPDIR,
      project,
    ].map((directory) => mkdir(directory, { recursive: true })),
  )

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
    env: environment,
  })
  const stdout = captureSmokeOutput(child.stdout)
  const stderr = captureSmokeOutput(child.stderr)
  const failures: unknown[] = []
  let client: Client | undefined
  try {
    const ready: unknown = JSON.parse(await stdout.firstLine)
    const url = typeof ready === "object" && ready !== null && "url" in ready ? ready.url : undefined
    if (typeof url !== "string") throw new Error("Packaged server readiness omitted its URL")
    const base = new URL(url)
    if (base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
      throw new Error(`Packaged server did not bind loopback: ${base.hostname}`)
    client = YCoding.make({
      endpoint: { url: base.origin, auth: { type: "basic", username: "ycoding", password: PASSWORD } },
      location: { directory: project },
    })
    await runIsolatedBrowserSmoke(client, {
      project,
      url: `http://127.0.0.1:${fixture.port}/fixture?private=${PRIVATE_MARKER}`,
      actions: () => actions,
    })
  } catch (error) {
    failures.push(error)
  }
  client?.transport.close()
  await fixture.stop(true).catch((error: unknown) => failures.push(error))
  await stopSmokeRuntime(child).catch((error: unknown) => failures.push(error))
  await Promise.all([stdout.done, stderr.done]).catch((error: unknown) => failures.push(error))
  if (stdout.leaked() || stderr.leaked()) failures.push(new Error("Packaged server logs disclosed a private marker"))
  await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  raise(failures)
  console.log(`Isolated-browser packaged smoke passed: ${path.basename(binary)} typed v5 start/observe/click/stop`)
}

function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds, undefined)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const message = "message" in error ? `: ${String(error.message)}` : ""
    return `${String(error._tag)}${message}`
  }
  return String(error)
}

function raise(failures: readonly unknown[]) {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, failures.map(describe).join("; "))
}

if (import.meta.main) await main()
