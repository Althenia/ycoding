#!/usr/bin/env bun

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { YCoding, type V5Client } from "@ycoding-ai/client/v5"

const PASSWORD = "isolated-browser-smoke-password"
export const PRIVATE_MARKER = "isolated-browser-private-marker-4f17"

export async function runIsolatedBrowserSmoke(
  client: V5Client,
  input: { project: string; url: string; actions: () => number; timeout?: number },
) {
  const owner = { sessionID: "ses_isolated_packaged_smoke" }
  const timeout = input.timeout ?? 30_000
  const failures: unknown[] = []
  try {
    const session = await phase("create Session", timeout, (signal) =>
      client.session.create({ id: owner.sessionID, location: { directory: input.project } }, { signal }),
    )
    if (session.id !== owner.sessionID) throw new Error("Packaged server returned a different Session owner")
    const started = await phase("start isolated browser", timeout, (signal) =>
      client.isolatedBrowser.start({ ...owner, url: input.url }, { signal }),
    )
    privateResponse(started)
    if (started.mode !== "isolated" || started.state !== "ready" || !started.instanceID || !started.tab)
      throw new Error(`Packaged isolated browser did not become ready: ${started.state}`)
    if (started.tab.sessionID !== owner.sessionID) throw new Error("Packaged browser tab has a different owner")
    const instanceID = started.instanceID
    const tab = started.tab
    const observed = await phase("observe isolated browser", timeout, (signal) =>
      client.isolatedBrowser.observe(
        { ...owner, instanceID, tabID: tab.id, generation: tab.generation, callID: "observe-packaged" },
        { signal },
      ),
    )
    privateResponse(observed)
    if (
      observed.mode !== "isolated" ||
      observed.instanceID !== instanceID ||
      observed.tabID !== tab.id ||
      observed.generation !== tab.generation
    )
      throw new Error("Packaged observation changed browser ownership or generation")
    const url = new URL(input.url)
    if (observed.page.origin !== url.origin || observed.page.path !== url.pathname)
      throw new Error("Packaged browser observation left the local fixture")
    const button = observed.elements.find(
      (element) => element.role === "button" && element.name === "Submit" && !element.disabled,
    )
    if (!button) throw new Error("Packaged browser observation omitted the enabled semantic Submit button")
    const completed = await phase("click isolated browser", timeout, (signal) =>
      client.isolatedBrowser.action(
        {
          ...owner,
          instanceID,
          tabID: observed.tabID,
          generation: observed.generation,
          documentGeneration: observed.documentGeneration,
          observationRevision: observed.revision,
          callID: "click-packaged",
          action: { type: "click", ref: button.ref },
        },
        { signal },
      ),
    )
    privateResponse(completed)
    if (
      completed.mode !== "isolated" ||
      completed.instanceID !== instanceID ||
      completed.tab.id !== tab.id ||
      completed.tab.sessionID !== owner.sessionID ||
      completed.callID !== "click-packaged"
    )
      throw new Error("Packaged click changed browser ownership or call identity")
    if (completed.status !== "completed") throw new Error(`Packaged click did not complete: ${completed.status}`)
    await phase("wait for browser action fixture", Math.min(timeout, 5_000), async (signal) => {
      while (!signal.aborted) {
        if (input.actions() > 1) throw new Error("Packaged browser dispatched the fixture action more than once")
        if (input.actions() === 1) return
        await Bun.sleep(25)
      }
    })
  } catch (error) {
    failures.push(error)
  } finally {
    // The fixed ID belongs only to this freshly isolated runtime. Also clean it after an uncertain create/start.
    await phase("stop isolated browser", Math.min(timeout, 10_000), (signal) =>
      client.isolatedBrowser.stop(owner, { signal }),
    )
      .then(async () => {
        const stopped = await phase("verify isolated browser stopped", Math.min(timeout, 10_000), (signal) =>
          client.isolatedBrowser.status(owner, { signal }),
        )
        privateResponse(stopped)
        if (stopped.state !== "stopped" || stopped.instanceID || stopped.tab)
          throw new Error("Packaged isolated browser retained its instance after stop")
      })
      .catch((error: unknown) => failures.push(error))
    await phase("remove smoke Session", Math.min(timeout, 10_000), (signal) =>
      client.session.remove(owner, { signal }),
    ).catch((error: unknown) => failures.push(error))
    client.transport.close()
  }
  if (failures.length) throw new Error(failures.map(diagnostic).join("\n"))
  if (input.actions() !== 1) throw new Error(`Packaged fixture received ${input.actions()} actions instead of one`)
}

async function main() {
  const binary = process.argv.find((arg) => arg.startsWith("--binary="))?.slice("--binary=".length)
  if (!binary) throw new Error("Usage: bun script/isolated-browser-smoke.ts --binary=/path/to/ycoding")
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Isolated-browser packaging smoke is approved only for macOS arm64")

  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-isolated-browser-packaged-"))
  const project = path.join(root, "project")
  const failures: unknown[] = []
  try {
    await Promise.all(
      ["home", "config", "data", "cache", "state", "project", "tmp"].map((directory) =>
        mkdir(path.join(root, directory)),
      ),
    )
    let actions = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/action" && request.method === "POST") {
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
    try {
      const child = Bun.spawn([path.resolve(binary), "serve", "--stdio", "--port", "0"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: project,
        env: isolatedBrowserSmokeEnvironment(root),
      })
      // Drain both pipes immediately: Chrome startup diagnostics must not fill a pipe and deadlock readiness.
      const stdout = captureSmokeOutput(child.stdout)
      const stderr = captureSmokeOutput(child.stderr)
      try {
        const line = await phase("runtime readiness", 30_000, () => stdout.firstLine)
        const ready: unknown = JSON.parse(line)
        if (typeof ready !== "object" || ready === null || !("url" in ready) || typeof ready.url !== "string")
          throw new Error("Packaged server readiness omitted its URL")
        const base = new URL(ready.url)
        if (
          base.protocol !== "http:" ||
          !["127.0.0.1", "localhost"].includes(base.hostname) ||
          base.username ||
          base.password
        )
          throw new Error("Packaged server did not advertise a credential-free loopback HTTP endpoint")
        const client = YCoding.make({
          endpoint: { url: base.href, auth: { type: "basic", username: "ycoding", password: PASSWORD } },
          location: { directory: project },
        })
        await runIsolatedBrowserSmoke(client, {
          project,
          url: `http://127.0.0.1:${fixture.port}/fixture?private=${PRIVATE_MARKER}`,
          actions: () => actions,
        })
      } catch (error) {
        failures.push(error)
      } finally {
        await stopSmokeRuntime(child).catch((error: unknown) => failures.push(error))
        await phase("drain runtime diagnostics", 5_000, () => Promise.all([stdout.done, stderr.done])).catch(
          (error: unknown) => failures.push(error),
        )
        if (stdout.leaked() || stderr.leaked())
          failures.push(new Error("Packaged server logs disclosed a private marker"))
        if (failures.length && stderr.tail()) failures.push(new Error(`Runtime stderr (tail): ${stderr.tail()}`))
      }
    } finally {
      await fixture.stop(true)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (failures.length)
    throw new Error(`Isolated-browser packaged smoke failed:\n${failures.map(diagnostic).join("\n")}`)
  console.log(
    `Isolated-browser packaged smoke passed: ${path.basename(binary)} v5 private-pipe start/observe/click/stop`,
  )
}

export function isolatedBrowserSmokeEnvironment(
  root: string,
  ambient: Record<string, string | undefined> = process.env,
) {
  return {
    ...ambient,
    NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    HOME: path.join(root, "home"),
    YCODING_TEST_HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    YCODING_PASSWORD: PASSWORD,
    YCODING_DB: undefined,
    YCODING_SQLITE_IMPORT_SOURCE: undefined,
    YCODING_CONFIG_DIR: path.join(root, "config", "ycoding"),
    YCODING_CONFIG: undefined,
    YCODING_CONFIG_CONTENT: undefined,
    YCODING_REMOTE_URL: undefined,
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_DISABLE_CHANNEL_DB: "1",
    YCODING_CONFIG_PROJECT_DISABLE: "1",
  }
}

function privateResponse(value: unknown) {
  if (JSON.stringify(value).includes(PRIVATE_MARKER))
    throw new Error("Packaged isolated-browser API disclosed a private marker")
}

function diagnostic(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? ["_tag", "message", "reason", "operation"]
            .flatMap((key) => (key in error ? [String(Reflect.get(error, key))] : []))
            .join(": ")
        : String(error)
  return message.replaceAll(PRIVATE_MARKER, "[private marker]").replaceAll(PASSWORD, "[password]")
}

async function phase<T>(name: string, timeout: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }),
      ),
    ])
  } catch (error) {
    throw new Error(`${name}: ${controller.signal.aborted ? "timed out" : diagnostic(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

export function captureSmokeOutput(stream: ReadableStream<Uint8Array>) {
  const firstLine = Promise.withResolvers<string>()
  void firstLine.promise.catch(() => {})
  let tail = ""
  let prefix = ""
  let found = false
  let leaked = false
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const text = decoder.decode(next.value, { stream: true })
        leaked ||= (tail + text).includes(PRIVATE_MARKER)
        tail = (tail + text).slice(-8_192)
        if (found) continue
        prefix += text
        const line = prefix
          .split("\n")
          .slice(0, -1)
          .map((value) => value.trim())
          .find(Boolean)
        if (line && line.length <= 65_536) {
          found = true
          firstLine.resolve(line)
          prefix = ""
        }
        if (prefix.length > 65_536) {
          found = true
          firstLine.reject(new Error("Packaged server readiness exceeded 64 KiB"))
          prefix = ""
        }
      }
      if (!found) firstLine.reject(new Error("Packaged server produced no readiness line"))
    } catch (error) {
      firstLine.reject(error)
      throw error
    } finally {
      reader.releaseLock()
    }
  })()
  void done.catch(() => {})
  return { firstLine: firstLine.promise, done, tail: () => diagnostic(tail), leaked: () => leaked }
}

export async function stopSmokeRuntime(
  child: { stdin: { end(): unknown }; kill(signal?: number): void; exited: Promise<number> },
  timeout = 5_000,
) {
  const failures: unknown[] = []
  await phase("close runtime stdin", timeout, async () => {
    await child.stdin.end()
  }).catch((error: unknown) => failures.push(error))
  for (const [name, signal] of [
    ["graceful runtime shutdown", 0],
    ["runtime termination", 15],
    ["forced runtime termination", 9],
  ] as const) {
    if (signal) {
      try {
        child.kill(signal)
      } catch (error) {
        failures.push(error)
      }
    }
    const exitCode = await phase(name, timeout, () => child.exited).catch((error: unknown) => {
      if (signal === 9) failures.push(error)
      return undefined
    })
    if (exitCode === undefined) continue
    if (exitCode !== 0) failures.push(new Error(`Packaged runtime exited with code ${exitCode}`))
    if (failures.length) throw new Error(failures.map(diagnostic).join("\n"))
    return
  }
  throw new Error(failures.map(diagnostic).join("\n"))
}

if (import.meta.main) await main()
