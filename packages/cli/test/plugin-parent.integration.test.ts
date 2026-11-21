import { YCoding } from "@ycoding-ai/client/v5"
import { beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { streamResponse } from "../script/runtime-smoke"
import { selectEvent } from "./fixtures/plugin-parent/events"

type Evidence = Record<string, unknown>
const fixture = path.resolve(import.meta.dir, "fixtures/plugin-parent/process.ts")
const modulePlugin = path.resolve(import.meta.dir, "fixtures/plugin-parent/module.ts")
const failedModulePlugin = path.resolve(import.meta.dir, "fixtures/plugin-parent/failed-module.ts")
const native = process.env.YCODING_RUNTIME_EXECUTABLE
const password = "synthetic-parent-password"

beforeAll(() => {
  if (!native || !existsSync(native)) throw new Error("Prerequisite: bind YCODING_RUNTIME_EXECUTABLE to the approved actual native executable; no fallback path is used")
})

function object(value: unknown): Evidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected evidence object")
  return value as Evidence
}

function entries(value: unknown): Evidence[] {
  if (Array.isArray(value)) return value.flatMap(entries)
  if (value === null || typeof value !== "object") return []
  return [object(value), ...Object.values(value).flatMap(entries)]
}

async function within<T>(value: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([value, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function launch(mode = "normal") {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-parent-native-"))
  const config = path.join(root, "config/ycoding")
  const first = path.join(root, "first")
  const second = path.join(root, "second")
  await Promise.all([config, first, second].map((directory) => mkdir(directory, { recursive: true })))
  const requests: string[] = []
  const setupRunnerRequest = Promise.withResolvers<Evidence>()
  let sequence = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const raw = await request.text()
      requests.push(raw)
      const input = object(JSON.parse(raw))
      const messages = Array.isArray(input.messages) ? input.messages.map(object) : []
      const completed = messages.at(-1)?.role === "tool"
      const module = (JSON.stringify(messages.findLast((message) => message.role === "user")?.content) ?? "").includes("genuine-module")
      const generation = JSON.stringify(messages).includes("parent-setup-generation") || JSON.stringify(messages).includes("parent-postpublication-generation")
      const setupRunner = mode === "setup-runner" && (JSON.stringify(messages.findLast((message) => message.role === "user")?.content) ?? "").includes("parent-setup-runner")
      if (setupRunner) setupRunnerRequest.resolve(input)
      const stream = setupRunner
        ? streamResponse({ index: ++sequence, content: "Synthetic parent setup runner output" })
        : generation
        ? streamResponse({ index: ++sequence, content: "Synthetic parent generation" })
        : completed
        ? streamResponse({ index: ++sequence, content: "Parent native tool settled" })
        : [
            { id: "chatcmpl_parent", object: "chat.completion.chunk", model: "parent-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_parent_${++sequence}`, type: "function", function: { name: module ? "module_counter" : "parent_counter", arguments: "{}" } }] }, finish_reason: null }] },
            { id: "chatcmpl_parent", object: "chat.completion.chunk", model: "parent-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ].map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const configuration = {
    plugins: [modulePlugin, ...(mode === "selector" ? ["-parent.shared"] : mode === "module-failed" ? [failedModulePlugin] : [])],
    providers: { "parent-fixture": {
      name: "Synthetic parent provider",
      package: "@ycoding-ai/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic-parent-provider-key" },
      models: { "parent-model": { name: "Parent", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 100000, output: 4096 } } },
    } },
  }
  await writeFile(path.join(config, "ycoding.json"), JSON.stringify(configuration))
  const child = spawn(process.execPath, [fixture], {
    cwd: first,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      YCODING_CONFIG_DIR: config,
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_FILEWATCHER_DISABLE: "1",
      YCODING_DISABLE_FFF: "1",
      YCODING_PASSWORD: password,
      YCODING_RUNTIME_EXECUTABLE: native,
      YCODING_TEST_PARENT_MODE: mode,
      ...(mode === "ambient" ? { YCODING_PLUGIN_PARENT_FD: "99", YCODING_PLUGIN_PARENT_CLEANUP_FD: "98" } : {}),
    },
  })
  const evidence: Evidence[] = []
  const observers = new Set<() => void>()
  const aborted = Promise.withResolvers<never>()
  void aborted.promise.catch(() => undefined)
  const urls: string[] = []
  let stderrBytes = 0
  const stderrKinds = new Set<string>()
  let pending = ""
  const notify = () => observers.forEach((resolve) => resolve())
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve))
  child.once("error", (error) => {
    evidence.push({ kind: "fixture-prerequisite", detail: error.message })
    notify()
  })
  child.on("message", (value) => { evidence.push(object(value)); notify() })
  child.stderr?.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.byteLength
    const text = bytes.toString("utf8")
    for (const [kind, pattern] of [
      ["module", /cannot find (?:module|package)|module not found|could not resolve/i],
      ["sdk-asset", /plugin sdk|sdk asset/i],
      ["parent-binding", /parent|descriptor|generation|binding/i],
      ["authentication", /unauthorized|authentication/i],
      ["configuration", /invalid configuration|config.*(?:failed|rejected)/i],
      ["embedding-replay", /embedding entrypoint replayed/i],
    ] as const) if (pattern.test(text)) stderrKinds.add(kind)
  })
  child.stdout?.on("data", (bytes: Buffer) => {
    pending += bytes.toString("utf8")
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("{")) continue
      const value = object(JSON.parse(line))
      if (typeof value.url === "string") urls.push(value.url)
    }
    notify()
  })
  const next = async (predicate: () => boolean) => {
    while (!predicate()) {
      const prerequisite = evidence.find((item) => item.kind === "fixture-prerequisite")
      if (prerequisite) throw new Error(`Fixture prerequisite: ${String(prerequisite.detail)}`)
      let resolve: () => void = () => undefined
      const changed = new Promise<void>((done) => { resolve = done; observers.add(resolve) })
      try {
        await within(Promise.race([changed, aborted.promise, exited.then((code) => {
          if (!predicate()) throw new Error(`Actual parent process exited ${code} before expected evidence`)
        })]), 20_000, "Owned fixture evidence deadline exceeded")
      } finally {
        observers.delete(resolve)
      }
    }
  }
  const event = async (kind: string, matches: (item: Evidence) => boolean = () => true, from = 0) => {
    await next(() => selectEvent(evidence, kind, matches, from) !== undefined)
    return selectEvent(evidence, kind, matches, from)!
  }
  const control = async (command: string, signal?: string) => {
    if (!child.connected) return
    await new Promise<void>((resolve, reject) => {
      child.send({ command, signal }, (error) => error ? reject(error) : resolve())
    })
  }
  const clients: ReturnType<typeof YCoding.make>[] = []
  return {
    child,
    evidence,
    requests,
    setupRunnerRequest: setupRunnerRequest.promise,
    first,
    second,
    event,
    next,
    get exited() { return within(exited, 20_000, "Owned embedding exit deadline exceeded") },
    async body(operation: () => Promise<void>) {
      try { await within(operation(), 30_000, "Owned native fixture body deadline exceeded") }
      catch (error) { aborted.reject(error); throw error }
    },
    control,
    async updateProviderName() {
      configuration.providers["parent-fixture"].name = "Synthetic parent provider refreshed"
      await writeFile(path.join(config, "ycoding.json"), JSON.stringify(configuration))
    },
    async client(directory = first) {
      await next(() => urls.length > 0)
      const client = YCoding.make({ endpoint: { url: urls[0]!, auth: { type: "basic", username: "ycoding", password } }, location: { directory } })
      clients.push(client)
      return client
    },
    async close(bodyFailures: readonly unknown[]) {
      const failures = [...bodyFailures]
      const attempt = async (stage: string, operation: () => unknown) => {
        try { await operation() }
        catch (error) { failures.push(new Error(`Owned fixture cleanup failed: ${stage}`, { cause: error })) }
      }
      for (const client of clients) await attempt("V5 transport", () => client.transport.close())
      if (mode === "setup-runner") await attempt("setup release", () => within(control("release-setup"), 1_000, "Setup release IPC deadline exceeded"))
      await attempt("cleanup release", () => within(control("release-cleanup"), 1_000, "Cleanup release IPC deadline exceeded"))
      await attempt("stdin EOF", () => child.stdin?.end())
      let joined = false
      await attempt("process settlement", async () => {
        await within(exited, 10_000, "Owned fixture did not settle during cleanup")
        joined = true
      })
      if (!joined) {
        if (child.connected) await attempt("native stop acknowledgement", async () => {
          const from = evidence.length
          await within(control("force-stop"), 1_000, "Native stop IPC deadline exceeded")
          await within(new Promise<void>((resolve) => {
            const check = () => { if (evidence.slice(from).some((item) => item.kind === "force-stop")) resolve() }
            observers.add(check)
            check()
            void exited.finally(() => { observers.delete(check); resolve() })
          }), 2_000, "Owned fixture did not acknowledge native stop")
        })
        await attempt("embedding join after native stop", async () => {
          await within(exited, 2_000, "Embedding did not join after native stop")
          joined = true
        })
        if (!joined) {
          await attempt("native forced stop", () => within(control("force-stop", "SIGKILL"), 1_000, "Native forced-stop IPC deadline exceeded"))
          await attempt("embedding stop", () => child.kill("SIGTERM"))
          await attempt("embedding bounded join", async () => {
            await within(exited, 2_000, "Embedding SIGTERM join deadline exceeded")
            joined = true
          })
        }
        if (!joined) {
          await attempt("embedding forced stop", () => child.kill("SIGKILL"))
          await attempt("embedding forced bounded join", async () => {
            await within(exited, 2_000, "Embedding SIGKILL join deadline exceeded")
            joined = true
          })
        }
      }
      await attempt("provider stop", () => provider.stop(true))
      let nativeGone = true
      for (const item of evidence.filter((item) => item.kind === "native")) {
        const pid = Number(item.pid)
        if (!Number.isSafeInteger(pid) || pid <= 0) { nativeGone = false; continue }
        try { process.kill(pid, 0); nativeGone = false }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
            nativeGone = false
            failures.push(error)
          }
        }
      }
      if (!joined || !nativeGone) failures.push(new Error("Owned process absence is unproved; synthetic fixture data retained"))
      else await attempt("synthetic fixture removal", () => rm(root, { recursive: true, force: true }))
      if (!failures.length) return
      const fields = ["kind", "pid", "code", "signal", "setup", "closes", "original", "cleanup", "boundary", "injected", "cleanupStarted", "plugin", "witness", "signalled"]
      console.error("Parent fixture owner evidence", JSON.stringify({
        mode, pid: child.pid, code: child.exitCode, signal: child.signalCode, stderrBytes, stderrKinds: [...stderrKinds],
        events: evidence.slice(-24).map((item) => Object.fromEntries(fields.flatMap<[string, string | number | boolean | null]>((field) => {
          const value = item[field]
          if (typeof value === "string") return [[field, value.slice(0, 160)]]
          if (typeof value === "boolean" || typeof value === "number" || value === null) return [[field, value]]
          return []
        }))),
      }))
      if (failures.length === 1) throw failures[0]
      throw new AggregateError(failures, "Parent fixture body and cleanup failures", { cause: failures[0] })
    },
  }
}

async function prompt(client: ReturnType<typeof YCoding.make>, text: string) {
  const session = await client.session.create({ model: { providerID: "parent-fixture", id: "parent-model" } })
  await client.session.prompt({ sessionID: session.id, text })
  await client.session.wait({ sessionID: session.id })
  return session
}

test("PN01 actual native execution calls original parent closures, preserves duplicate order/version, and keeps genuine module loading", async () => {
  const run = await launch()
  const failures: unknown[] = []
  try {
    await run.body(async () => {
    const client = await run.client()
    const health = await client.health.get()
    expect(health.healthy).toBe(true)
    expect(health.pid).not.toBe(run.child.pid)
    const native = await run.event("native")
    if (typeof native.pid !== "number") throw new Error("Native fixture did not report its process ID")
    expect(health.pid).toBe(native.pid)
    const session = await prompt(client, "Run the parent closure once")
    await prompt(client, "Run the same parent closure again")
    const tools = run.evidence.filter((item) => item.kind === "tool")
    expect(tools.map((item) => [item.pid, item.count, item.local, item.witness])).toEqual([[run.child.pid, 1, 1, true], [run.child.pid, 2, 2, true]])
    expect(run.evidence.filter((item) => item.kind === "embedding")).toHaveLength(1)
    expect(run.evidence.some((item) => item.kind === "superseded")).toBe(false)
    expect(run.evidence.filter((item) => item.kind === "setup").map((item) => item.plugin)).toEqual(["winner", "stable"])
    expect(run.evidence.filter((item) => item.kind === "hook").every((item) => item.pid === run.child.pid)).toBe(true)
    expect(run.evidence.some((item) => item.kind === "event")).toBe(true)
    expect(run.requests.some((request) => request.includes("parent-original-context"))).toBe(true)
    expect(run.requests.some((request) => request.includes("genuine-module-context"))).toBe(true)
    expect(JSON.stringify(await client.message.list({ sessionID: session.id }))).toContain("Parent native tool settled")
    const metadata = entries(await client.plugin.list())
    const shared = metadata.find((item) => item.id === "parent.shared")
    const stable = metadata.find((item) => item.id === "parent.stable")
    expect(typeof shared?.version).toBe("string")
    expect(Number(shared?.version)).toBeGreaterThan(Number(stable?.version))
    expect(metadata.some((item) => item.id === "parent.module-path")).toBe(true)
    const moduleSession = await prompt(client, "Run genuine-module")
    const moduleMessages = JSON.stringify(await client.message.list({ sessionID: moduleSession.id }))
    expect(moduleMessages).toContain("module_counter")
    expect(moduleMessages).toContain("module")
    expect(run.evidence.filter((item) => item.kind === "tool")).toHaveLength(2)
    })
  } catch (error) {
    failures.push(error)
  } finally {
    await run.close(failures)
  }
}, 60_000)

test("PN02 independent native Locations use original parent functions with separately owned scopes", async () => {
  const run = await launch()
  const failures: unknown[] = []
  try {
    await run.body(async () => {
    const first = await run.client()
    expect((await first.health.get()).pid).not.toBe(run.child.pid)
    await prompt(first, "First Location")
    const second = await run.client(run.second)
    await prompt(second, "Second Location")
    expect(run.evidence.filter((item) => item.kind === "tool").map((item) => [item.setup, item.count, item.local, item.pid])).toEqual([[1, 1, 1, run.child.pid], [2, 2, 1, run.child.pid]])
    const versions = [await first.plugin.list(), await second.plugin.list()].map((value) => entries(value).find((item) => item.id === "parent.shared")?.version)
    expect(versions[0]).toBe(versions[1])
    run.child.stdin?.end()
    const done = await run.event("done")
    expect(done.setup).toBe(2)
    expect(done.closes).toBe(2)
    expect(run.evidence.filter((item) => item.kind === "cleanup-end")).toHaveLength(2)
    expect((await run.event("retired")).rejected).toBe(true)
    })
  } catch (error) {
    failures.push(error)
  } finally {
    await run.close(failures)
  }
}, 60_000)

for (const mode of ["held-cleanup", "broken-data"] as const) {
  test(`PN03 ${mode} keeps the actual native owner alive until the JS finalizer and cleanup lease settle`, async () => {
    const run = await launch(mode)
    const failures: unknown[] = []
    try {
      await run.body(async () => {
      const client = await run.client()
      const health = await client.health.get()
      expect(health.pid).not.toBe(run.child.pid)
      await client.agent.list()
      await run.event("setup")
      if (mode === "broken-data") await run.control("break-data")
      else run.child.stdin?.end()
      await run.event("cleanup-start")
      expect(run.evidence.filter((item) => item.kind === "native-exit")).toHaveLength(0)
      expect(run.evidence.filter((item) => item.kind === "cleanup-end")).toHaveLength(0)
      process.kill(Number(health.pid), 0)
      await run.control("release-cleanup")
      await run.event("cleanup-end")
      const exit = await run.event("native-exit")
      expect(exit.closes).toBe(1)
      expect(run.evidence.findIndex((item) => item.kind === "cleanup-end")).toBeLessThan(run.evidence.findIndex((item) => item.kind === "native-exit"))
      if (mode === "broken-data") {
        expect(await run.exited).not.toBe(0)
        expect(run.evidence.some((item) => item.kind === "done")).toBe(false)
      } else expect(await run.exited).toBe(0)
      })
    } catch (error) {
      failures.push(error)
    } finally {
      await run.close(failures)
    }
  }, 60_000)
}

for (const mode of ["invalid-descriptor", "aliased-descriptor", "foreign-binding", "foreign-generation"] as const) {
  test(`PN04 actual native ${mode} is rejected without an accepted SDK invocation`, async () => {
    const run = await launch(mode)
    const failures: unknown[] = []
    try {
      await run.body(async () => {
      if (mode === "foreign-generation") {
        const client = await run.client()
        expect((await client.health.get()).pid).not.toBe(run.child.pid)
        await client.agent.list().catch(() => undefined)
        run.child.stdin?.end()
      }
      await run.event("injected")
      expect(await run.exited).not.toBe(0)
      expect(run.evidence.filter((item) => item.kind === "tool")).toHaveLength(0)
      expect(run.evidence.filter((item) => item.kind === "done")).toHaveLength(0)
      expect(run.evidence.some((item) => item.kind === "error" && item.boundary === true)).toBe(true)
      })
    } catch (error) {
      failures.push(error)
    } finally {
      await run.close(failures)
    }
  }, 60_000)
}

test("PN05 an ambient descriptor variable cannot create a parent plugin attachment", async () => {
  const run = await launch("ambient")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
    const client = await run.client()
    expect((await client.health.get()).pid).not.toBe(run.child.pid)
    const metadata = entries(await client.plugin.list())
    expect(metadata.some((item) => item.id === "parent.shared" || item.id === "parent.stable")).toBe(false)
    expect(metadata.some((item) => item.id === "parent.module-path")).toBe(true)
    expect(run.evidence.some((item) => item.kind === "setup")).toBe(false)
    })
  } catch (error) {
    failures.push(error)
  } finally {
    await run.close(failures)
  }
}, 60_000)

test("PN06 failed native Location setup joins JS cleanup and preserves both original causes", async () => {
  const run = await launch("failed-setup")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
    const client = await run.client()
    expect((await client.health.get()).pid).not.toBe(run.child.pid)
    const loading = client.agent.list()
    void loading.catch(() => undefined)
    await run.event("cleanup-start")
    expect(run.evidence.filter((item) => item.kind === "cleanup-end")).toHaveLength(0)
    await run.control("release-cleanup")
    await loading.catch(() => undefined)
    run.child.stdin?.end()
    const error = await run.event("error")
    expect(error.original).toBe(true)
    expect(error.cleanup).toBe(true)
    expect(error.closes).toBe(1)
    expect(await run.exited).not.toBe(0)
    })
  } catch (error) {
    failures.push(error)
  } finally {
    await run.close(failures)
  }
}, 60_000)

test("PN07 SDK prelude removals prevent only the selected original parent setup", async () => {
  const run = await launch("selector")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      await client.agent.list()
      const plugins = entries(await client.plugin.list())
      expect(plugins.some((item) => item.id === "parent.shared")).toBe(false)
      expect(plugins.some((item) => item.id === "parent.stable")).toBe(true)
      expect(plugins.some((item) => item.id === "parent.module-path")).toBe(true)
      expect(run.evidence.filter((item) => item.kind === "setup").map((item) => item.plugin)).toEqual(["stable"])
      run.child.stdin?.end()
      expect((await run.event("done")).setup).toBe(0)
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)

test("PN08 configured module setup failure remains diagnostic and does not abort original parent tools", async () => {
  const run = await launch("module-failed")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      await prompt(client, "Configured module failure remains nonfatal")
      const diagnostics = entries(await client.config.diagnostics())
      expect(diagnostics.some((item) => item.path === "extensions" && String(item.message).includes("failed-module.ts"))).toBe(true)
      expect(run.evidence.filter((item) => item.kind === "tool")).toHaveLength(1)
      run.child.stdin?.end()
      expect((await run.event("done")).closes).toBe(1)
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)

test("PN09 original setup uses completed native generate and first-admission runner before Location publication", async () => {
  const run = await launch("setup-session")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      await client.agent.list()
      const setup = await run.event("setup-session")
      expect(setup.generated).toBe("Synthetic parent generation")
      expect(setup.admitted).toBeDefined()
      expect((await run.event("reload-queued")).setup).toBe(1)
      expect(run.requests).toHaveLength(1)
      expect(run.evidence.filter((item) => item.kind === "tool")).toHaveLength(0)
      run.child.stdin?.end()
      expect((await run.event("done")).closes).toBe(1)
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)

test("PN14 original setup drains its bound native runner before Location publication", async () => {
  const run = await launch("setup-runner")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      let loadingSettled = false
      const loading = client.agent.list().finally(() => { loadingSettled = true })
      void loading.catch(() => undefined)
      const setup = await run.event("setup-runner")
      const sessionID = setup.sessionID
      if (typeof sessionID !== "string") throw new Error("Original setup did not report its runner Session")
      const request = await within(run.setupRunnerRequest, 20_000, "Original setup runner did not reach the provider before setup release")
      await run.next(() => run.evidence.some((item) => item.kind === "hook" && item.sessionID === sessionID && item.pid === run.child.pid))
      expect(loadingSettled).toBe(false)
      expect(setup.setup).toBe(1)
      expect(setup.admitted).toBeDefined()
      expect(JSON.stringify(request.messages)).toContain("parent-setup-runner")
      expect(JSON.stringify(request.messages)).toContain("parent-original-context")
      expect(run.requests).toHaveLength(1)
      expect(run.evidence.filter((item) => item.kind === "setup-runner-released")).toHaveLength(0)
      const original = run.evidence.filter((item) => item.kind === "setup" && item.plugin === "winner")
      expect(original).toHaveLength(1)
      expect(original[0]?.pid).toBe(run.child.pid)
      expect(original[0]?.witness).toBe(true)
      expect(run.evidence.some((item) => item.kind === "hook" && item.sessionID === sessionID && item.pid === run.child.pid)).toBe(true)
      await run.control("release-setup")
      await loading
      expect(loadingSettled).toBe(true)
      expect((await run.event("setup-runner-released")).sessionID).toBe(sessionID)
      await client.session.wait({ sessionID })
      expect(JSON.stringify(await client.message.list({ sessionID }))).toContain("Synthetic parent setup runner output")
      expect(run.requests).toHaveLength(1)
      run.child.stdin?.end()
      const done = await run.event("done")
      expect(done.setup).toBe(1)
      expect(done.contexts).toBe(1)
      expect(done.closes).toBe(1)
      expect(run.evidence.filter((item) => item.kind === "setup" && item.plugin === "winner")).toHaveLength(1)
      expect(run.evidence.filter((item) => item.kind === "cleanup-start")).toHaveLength(1)
      expect(run.evidence.filter((item) => item.kind === "cleanup-end")).toHaveLength(1)
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)

test("PN10 published native refresh opens one new parent scope and rejects its retired original Context", async () => {
  const run = await launch("refresh")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      await client.agent.list()
      await run.event("setup-session")
      await run.updateProviderName()
      const session = await client.session.create({ model: { providerID: "parent-fixture", id: "parent-model" } })
      expect((await client.session.generate({ sessionID: session.id, prompt: "parent-postpublication-generation" })).text).toBe("Synthetic parent generation")
      await run.next(() => run.evidence.filter((item) => item.kind === "setup-session").length === 2)
      expect(run.evidence.filter((item) => item.kind === "setup").map((item) => item.plugin)).toEqual(["winner", "stable", "winner", "stable"])
      expect(run.evidence.filter((item) => item.kind === "cleanup-end")).toHaveLength(1)
      await run.control("probe-retired")
      expect((await run.event("retired-generation")).rejected).toBe(true)
      run.child.stdin?.end()
      expect((await run.event("done")).closes).toBe(2)
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)

for (const mode of ["invalid-tool-path", "invalid-tool-namespace", "invalid-tool-name"] as const) {
  test(`PN11 actual native ${mode} rejects the registration and joins its original setup scope`, async () => {
    const run = await launch(mode)
    const failures: unknown[] = []
    try {
      await run.body(async () => {
        const client = await run.client()
        let rejected = false
        try { await client.agent.list() } catch { rejected = true }
        expect(rejected).toBe(true)
        expect((await run.event("cleanup-end")).closes).toBe(1)
        expect(run.evidence.filter((item) => item.kind === "tool")).toHaveLength(0)
        run.child.stdin?.end()
        await run.event("error")
        expect(await run.exited).not.toBe(0)
      })
    } catch (error) { failures.push(error) }
    finally { await run.close(failures) }
  }, 60_000)
}

test("PN12 actual native OAuth retains the original implementation across Flow clones and closed authorization scopes", async () => {
  const run = await launch("oauth")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      await client.agent.list()
      for (const authorization of [1, 2]) {
        const attempt = await client.integration.oauth.connect({ integrationID: "parent-oauth", methodID: "browser", inputs: {} })
        expect((await run.event("oauth-authorize", (item) => item.authorization === authorization)).witness).toBe(true)
        await client.integration.oauth.complete({ integrationID: "parent-oauth", attemptID: attempt.data.attemptID, code: `synthetic-parent-code-${authorization}` })
        expect((await run.event("oauth-callback", (item) => item.authorization === authorization)).witness).toBe(true)
        await run.event("oauth-close", (item) => item.authorization === authorization)
        expect(run.evidence.filter((item) => item.kind === "oauth-close" && item.authorization === authorization)).toHaveLength(1)
      }
      expect(run.evidence.filter((item) => item.kind === "oauth-authorize").map((item) => item.pid)).toEqual([run.child.pid, run.child.pid])
      run.child.stdin?.end()
      await run.event("done")
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)

test("PN13 a published original Context acknowledges agent reload only after its native rebuild completes", async () => {
  const run = await launch("post-reload")
  const failures: unknown[] = []
  try {
    await run.body(async () => {
      const client = await run.client()
      await client.agent.list()
      run.child.send({ command: "post-reload" })
      const reloaded = await run.event("post-reload")
      expect(reloaded.accepted).toBe(true)
      expect(Number(reloaded.after)).toBeGreaterThan(Number(reloaded.before))
      expect(run.evidence.some((item) => item.kind === "agent-rebuilt")).toBe(true)
      run.child.stdin?.end()
      await run.event("done")
      expect(await run.exited).toBe(0)
    })
  } catch (error) { failures.push(error) }
  finally { await run.close(failures) }
}, 60_000)
