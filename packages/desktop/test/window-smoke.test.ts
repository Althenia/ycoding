import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import type { AppChannel } from "./window-channel"
import * as windowSmoke from "./window-smoke"
import { resourcesFor, setupWindowSmoke, type Confinement, type WindowSmokeDeps } from "./window-smoke"

const application = "/synthetic/Fixture.app/Contents/MacOS/fixture"
const RESOURCES = "/synthetic/Fixture.app/Contents/Resources"
const OPEN = `${JSON.stringify({ type: "desktop.channel", state: "open", resources: RESOURCES })}\n`
const CLOSED = `${JSON.stringify({ type: "desktop.channel", state: "closed" })}\n`
const T = { launch: 30_000, abort: 5_000, worker: 15_000, stop: 10_000, grace: 20_000, kill: 5_000, pump: 2_000 }
const encoder = new TextEncoder()
const never = () => new Promise<never>(() => undefined)

function gate() {
  const open = new Set<number>()
  const waiting = new Map<number, (() => void)[]>()
  return {
    wait: (ms: number) => open.has(ms) ? Promise.resolve() : new Promise<void>((resolve) => { waiting.set(ms, [...(waiting.get(ms) ?? []), resolve]) }),
    release: (...values: number[]) => {
      for (const ms of values) {
        open.add(ms)
        for (const resolve of waiting.get(ms) ?? []) resolve()
        waiting.delete(ms)
      }
    },
  }
}

function fakeApp(trace: string[], options: { exitOnEnd?: boolean; stuck?: boolean } = {}) {
  const lines = new TransformStream<Uint8Array, Uint8Array>()
  const writer = lines.writable.getWriter()
  const exit = Promise.withResolvers<number>()
  const app: AppChannel = {
    stdin: {
      write: async () => undefined,
      flush: async () => undefined,
      end: async () => { trace.push("app-end"); if (options.exitOnEnd) exit.resolve(0) },
    },
    stdout: lines.readable,
    exited: exit.promise,
    kill: () => { trace.push("app-kill"); if (!options.stuck) exit.resolve(137) },
  }
  return { app, exit, send: (text: string) => writer.write(encoder.encode(text)), eof: () => writer.close() }
}

function harness(options: { worker?: WindowSmokeDeps["worker"]; stop?: () => Promise<void>; provenance?: WindowSmokeDeps["provenance"] } = {}) {
  const trace: string[] = []
  const requests: { method: string; path: string }[] = []
  const launches: number[][] = []
  const workers: Parameters<WindowSmokeDeps["worker"]>[0][] = []
  const g = gate()
  const confinement: Confinement = {
    backend: { resources: RESOURCES, directory: "/synthetic/backend", manifest: "/synthetic/backend.json", executable: "/synthetic/backend/ycoding", version: "0" },
    provider: { url: "http://127.0.0.1:1/v1", endpoint: { port: 1 }, requests },
    root: async () => { trace.push("root"); return { path: "/synthetic/owned" } },
    release: async () => { trace.push("release") },
    launch: (_owned, endpoints) => { launches.push(endpoints.map((endpoint) => endpoint.port)); return (command) => command },
    shared: async () => ({ url: "http://127.0.0.1:2", pid: 7, endpoint: { port: 2 }, stop: options.stop ?? (async () => { trace.push("shared-stop") }) }),
    close: async () => { trace.push("close") },
  }
  const deps: WindowSmokeDeps = {
    isolate: async (resources) => { trace.push(`isolate:${resources}`); return confinement },
    environment: async (root) => ({ TMPDIR: `${root}/tmp` }),
    worker: options.worker ?? (async (worker) => {
      workers.push(worker)
      const input = worker.input
      if (!input) return
      input.resume()
      await new Promise<void>((resolve) => { input.once("end", () => resolve()) })
    }),
    canonical: async () => { trace.push("canonical") },
    provenance: options.provenance ?? (async (target) => { trace.push(`provenance:${target}`) }),
    channel: { wait: g.wait },
    limits: { launchMs: T.launch, abortMs: T.abort, workerMs: T.worker, stopMs: T.stop },
  }
  return { trace, requests, launches, workers, deps, g }
}

async function session(fake: ReturnType<typeof fakeApp>, ...frames: string[]) {
  await fake.send(OPEN)
  for (const frame of frames) await fake.send(frame)
  await fake.eof()
}

test("derives Resources only from an exact app bundle executable path", () => {
  expect(resourcesFor(application)).toBe(RESOURCES)
  for (const bad of ["relative/Fixture.app/Contents/MacOS/fixture", "/synthetic/Fixture/Contents/MacOS/fixture", "/synthetic/.app/Contents/MacOS/fixture", "/synthetic/Fixture.app/Contents/Other/fixture", "/synthetic/Fixture.app/Contents/MacOS/../MacOS/fixture", "/synthetic/Fixture.app/Contents/MacOS/fixture/", "/fixture"])
    expect(() => resourcesFor(bad)).toThrow()
})

test("one admitted launch, a synthetic-only GUI environment, derived resources and an own-mode grant set", async () => {
  const { deps, launches, trace, workers } = harness()
  const fake = fakeApp(trace, { exitOnEnd: true })
  const launched: { application: string; env: Readonly<Record<string, string>>; signal: AbortSignal }[] = []
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: async (input) => { launched.push(input); return fake.app } }, deps)
  const first = smoke.run()
  const second = smoke.run()
  await expect(second).rejects.toThrow("already ran")
  await session(fake, CLOSED)
  await first
  expect(launched).toHaveLength(1)
  expect(launched[0]).toMatchObject({ application, env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" } })
  expect(Object.keys(launched[0]?.env ?? {}).sort()).toEqual(["HOME", "PATH"])
  expect(launched[0]?.signal.aborted).toBe(false)
  expect(trace).toContain(`isolate:${RESOURCES}`)
  expect(launches).toEqual([[1]])
  expect(workers[0]?.controller?.env?.YCODING_PASSWORD).toBeUndefined()
  expect(smoke.counters()).toEqual({ operations: {}, prompts: 0, providerRequests: 0, failure: undefined, appExit: 0, killed: false, workerResolved: true, retained: false, quiet: true })
  await smoke.cleanup()
  expect(trace.slice(-2)).toEqual(["release", "close"])
})

test("shared mode keeps its password in the worker environment only and grants the shared endpoint", async () => {
  const { deps, launches, trace, workers } = harness()
  const fake = fakeApp(trace, { exitOnEnd: true })
  let guiEnv: Readonly<Record<string, string>> = {}
  const smoke = await setupWindowSmoke({ application, mode: "shared", launch: async (input) => { guiEnv = input.env; return fake.app } }, deps)
  const running = smoke.run()
  await session(fake, CLOSED)
  await running
  const password = workers[0]?.controller?.env?.YCODING_PASSWORD
  expect(launches).toEqual([[1, 2]])
  expect(typeof password).toBe("string")
  expect(JSON.stringify(guiEnv)).not.toContain(password ?? "unreachable")
  expect(JSON.stringify(smoke.counters())).not.toContain(password ?? "unreachable")
  await smoke.cleanup()
  expect(trace.indexOf("shared-stop")).toBeLessThan(trace.indexOf("release"))
})

test("cleanup racing a pending launch aborts it, closes the late app, starts no worker and releases only afterwards", async () => {
  const { deps, trace, workers } = harness()
  const fake = fakeApp(trace, { exitOnEnd: true })
  const arrival = Promise.withResolvers<AppChannel>()
  let aborted = false
  const smoke = await setupWindowSmoke({ application, mode: "shared", launch: (input) => { input.signal.addEventListener("abort", () => { aborted = true }); return arrival.promise } }, deps)
  const running = smoke.run()
  const cleaning = smoke.cleanup()
  arrival.resolve(fake.app)
  await fake.eof()
  await Promise.allSettled([running, cleaning])
  expect(aborted).toBe(true)
  expect(workers).toEqual([])
  expect(trace.filter((entry) => entry === "app-end")).toHaveLength(1)
  expect(trace.indexOf("app-end")).toBeLessThan(trace.indexOf("shared-stop"))
  expect(trace.indexOf("shared-stop")).toBeLessThan(trace.indexOf("release"))
  expect(trace.indexOf("release")).toBeLessThan(trace.indexOf("close"))
  await expect(smoke.run()).rejects.toThrow("cleaned up")
})

test("run is refused after cleanup even when it never ran and no launch happens", async () => {
  const { deps, trace } = harness()
  let launched = 0
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: async () => { launched++; return fakeApp(trace).app } }, deps)
  await smoke.cleanup()
  await expect(smoke.run()).rejects.toThrow("cleaned up")
  expect(launched).toBe(0)
  expect(trace.slice(-2)).toEqual(["release", "close"])
})

test("a launch that never settles is aborted, reported as unsettled and retains everything", async () => {
  const { deps, trace, g, workers } = harness()
  let aborted = false
  const smoke = await setupWindowSmoke({ application, mode: "shared", launch: (input) => { input.signal.addEventListener("abort", () => { aborted = true }); return never() } }, deps)
  g.release(T.launch, T.abort)
  await expect(smoke.run()).rejects.toThrow("did not settle")
  expect(aborted).toBe(true)
  expect(smoke.counters()).toMatchObject({ failure: "launch-unsettled", retained: true, quiet: false })
  await smoke.cleanup()
  expect(workers).toEqual([])
  expect(trace).not.toContain("release")
  expect(trace).not.toContain("close")
})

test("a launch failure is reported and an unsettled worker or shared stop retains the roots", async () => {
  const failing = harness()
  const broken = await setupWindowSmoke({ application, mode: "own", launch: async () => { throw new Error("synthetic launch failure") } }, failing.deps)
  await expect(broken.run()).rejects.toThrow("synthetic launch failure")
  expect(broken.counters()).toMatchObject({ failure: "launch-failed", quiet: false })
  await broken.cleanup()

  const hungWorker = harness({ worker: () => never() })
  const fake = fakeApp(hungWorker.trace, { exitOnEnd: true })
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: async () => fake.app }, hungWorker.deps)
  void smoke.run().catch(() => undefined)
  await session(fake)
  hungWorker.g.release(T.worker)
  await smoke.cleanup()
  expect(smoke.counters()).toMatchObject({ failure: "worker-unsettled", retained: true, quiet: false })
  expect(hungWorker.trace).not.toContain("release")
  expect(hungWorker.trace).not.toContain("close")

  const hungStop = harness({ stop: () => never() })
  const idle = await setupWindowSmoke({ application, mode: "shared", launch: async () => fakeApp(hungStop.trace).app }, hungStop.deps)
  hungStop.g.release(T.stop)
  await idle.cleanup()
  expect(idle.counters()).toMatchObject({ failure: "shared-unsettled", retained: true, quiet: false })
  expect(hungStop.trace).not.toContain("release")
  expect(hungStop.trace).not.toContain("close")
})

test("an app that survives the kill retains the roots instead of trusting the bridge close", async () => {
  const { deps, trace, g } = harness()
  g.release(T.grace, T.kill, T.pump)
  const fake = fakeApp(trace, { stuck: true })
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: async () => fake.app }, deps)
  const running = smoke.run()
  await session(fake, CLOSED)
  await running
  await smoke.cleanup()
  expect(smoke.counters()).toMatchObject({ killed: true, appExit: undefined, retained: true, quiet: false })
  expect(trace).not.toContain("release")
  expect(trace).not.toContain("close")
})

test("quiet is false for a prompt, a channel failure, a kill, a nonzero exit and a provider request", async () => {
  const scenarios: { name: string; exitOnEnd?: boolean; kill?: boolean; drive: (fake: ReturnType<typeof fakeApp>, requests: { method: string; path: string }[]) => Promise<void> }[] = [
    { name: "prompt", exitOnEnd: true, drive: (fake) => session(fake, '{"id":1,"operation":"prompt","input":{}}\n', CLOSED) },
    { name: "failure", exitOnEnd: true, drive: (fake) => session(fake, "not json\n") },
    { name: "kill", kill: true, drive: (fake) => session(fake, CLOSED) },
    { name: "nonzero", drive: async (fake) => { await session(fake, CLOSED); fake.exit.resolve(2) } },
    { name: "provider", exitOnEnd: true, drive: (fake, requests) => { requests.push({ method: "POST", path: "/v1/chat/completions" }); return session(fake, CLOSED) } },
  ]
  for (const scenario of scenarios) {
    const { deps, trace, requests, g } = harness()
    if (scenario.kill) g.release(T.grace, T.kill, T.pump)
    const fake = fakeApp(trace, { exitOnEnd: scenario.exitOnEnd })
    const smoke = await setupWindowSmoke({ application, mode: "own", launch: async () => fake.app }, deps)
    const running = smoke.run()
    await scenario.drive(fake, requests)
    await running
    expect(smoke.counters().quiet, scenario.name).toBe(false)
    await smoke.cleanup()
  }
})

test("a worker rejection is visible from run and never quiet", async () => {
  const { deps, trace } = harness({
    worker: async (worker) => {
      const input = worker.input
      if (!input) throw new Error("synthetic worker input missing")
      const forwarded = new Promise<void>((resolve) => { input.once("data", () => resolve()) })
      input.resume()
      await forwarded
      throw new Error("synthetic worker failure")
    },
  })
  const fake = fakeApp(trace, { exitOnEnd: true })
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: async () => fake.app }, deps)
  const running = smoke.run()
  await session(fake, '{"id":1,"operation":"state"}\n')
  await expect(running).rejects.toThrow("synthetic worker failure")
  expect(smoke.counters()).toMatchObject({ operations: { state: 1 }, failure: "worker-failed", workerResolved: false, quiet: false })
  await smoke.cleanup()
})

test("a launch that settles after cancellation with an app that survives the kill retains the roots", async () => {
  const { deps, trace, g } = harness()
  g.release(T.launch, T.grace, T.kill, T.pump)
  const fake = fakeApp(trace, { stuck: true })
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: (input) => new Promise<AppChannel>((resolve) => { input.signal.addEventListener("abort", () => resolve(fake.app)) }) }, deps)
  await assert.rejects(smoke.run(), /cancelled or timed out/)
  await smoke.cleanup()
  expect(smoke.counters()).toMatchObject({ failure: "launch-failed", retained: true, quiet: false })
  expect(trace).not.toContain("release")
  expect(trace).not.toContain("close")
})

test("a launch that arrives after cleanup began with an app that survives the kill retains the roots", async () => {
  const { deps, trace, g } = harness()
  g.release(T.grace, T.kill, T.pump)
  const fake = fakeApp(trace, { stuck: true })
  const arrival = Promise.withResolvers<AppChannel>()
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: () => arrival.promise }, deps)
  const running = smoke.run()
  const cleaning = smoke.cleanup()
  arrival.resolve(fake.app)
  await fake.eof()
  await Promise.allSettled([running, cleaning])
  expect(smoke.counters()).toMatchObject({ failure: "launch-failed", retained: true, quiet: false })
  expect(trace).not.toContain("release")
  expect(trace).not.toContain("close")
})

const BUNDLE = "/synthetic/out/YCoding Desktop.app"
const EXECUTABLE = `${BUNDLE}/Contents/MacOS/ycoding-desktop`
const RECEIPT = "/synthetic/out/build-receipt.json"
const D = "a".repeat(64)
const badApplications = ["relative/Fixture.app/Contents/MacOS/fixture", "/synthetic/Fixture/Contents/MacOS/fixture", "/synthetic/.app/Contents/MacOS/fixture", "/synthetic/Fixture.app/Contents/Other/fixture", "/synthetic/Fixture.app/Contents/MacOS/../MacOS/fixture", "/synthetic/Fixture.app/Contents/MacOS/fixture/", "/fixture"]

const ID = "app.ycoding.desktop.smoke.t0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"
const INFO = `${BUNDLE}/Contents/Info.plist`
const plist = (...identifiers: string[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>CFBundleName</key>",
    "\t<string>YCoding Desktop</string>",
    ...identifiers.flatMap((identifier) => ["\t<key>CFBundleIdentifier</key>", `\t<string>${identifier}</string>`]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
const PLIST = plist(ID)

const base = () => ({ application: BUNDLE, executable: { path: EXECUTABLE, sha256: D }, features: ["isolated-smoke"], build: { status: 0 }, isolation: { identifier: ID, incognito: true, config: { path: "/synthetic/out/smoke-config.json", sha256: D } } })
const text = (change: (value: ReturnType<typeof base>) => unknown) => JSON.stringify(change(base()))

test("the receipt path is the sibling of the validated app bundle and nothing else", () => {
  expect(windowSmoke.receiptFor(EXECUTABLE)).toBe(RECEIPT)
  expect(windowSmoke.receiptFor(application)).toBe("/synthetic/build-receipt.json")
  for (const bad of badApplications) expect(() => windowSmoke.receiptFor(bad), bad).toThrow()
})

test("admits only a receipt for exactly this bundle and executable with the streamed digest and the smoke feature", () => {
  expect(() => windowSmoke.admitReceipt(EXECUTABLE, text((value) => ({ ...value, unrelated: { nested: true } })), D, PLIST)).not.toThrow()
  const invalid: [string, string, string?][] = [
    ["not json", "not json"],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"x"'],
    ["missing features", text((value) => ({ ...value, features: undefined }))],
    ["string features", text((value) => ({ ...value, features: "isolated-smoke" }))],
    ["empty features", text((value) => ({ ...value, features: [] }))],
    ["extra feature", text((value) => ({ ...value, features: ["isolated-smoke", "other"] }))],
    ["wrong feature", text((value) => ({ ...value, features: ["other"] }))],
    ["duplicate feature", text((value) => ({ ...value, features: ["isolated-smoke", "isolated-smoke"] }))],
    ["missing hash", text((value) => ({ ...value, executable: { path: EXECUTABLE } }))],
    ["wrong hash", text((value) => ({ ...value, executable: { path: EXECUTABLE, sha256: "b".repeat(64) } }))],
    ["short hash", text((value) => ({ ...value, executable: { path: EXECUTABLE, sha256: "a".repeat(63) } }))],
    ["uppercase hash", text((value) => ({ ...value, executable: { path: EXECUTABLE, sha256: D.toUpperCase() } }))],
    ["uppercase hash and digest", text((value) => ({ ...value, executable: { path: EXECUTABLE, sha256: D.toUpperCase() } })), D.toUpperCase()],
    ["missing executable", text((value) => ({ ...value, executable: undefined }))],
    ["string executable", text((value) => ({ ...value, executable: EXECUTABLE }))],
    ["missing executable path", text((value) => ({ ...value, executable: { sha256: D } }))],
    ["other executable path", text((value) => ({ ...value, executable: { path: "/synthetic/out/Other.app/Contents/MacOS/ycoding-desktop", sha256: D } }))],
    ["dot-dot executable path", text((value) => ({ ...value, executable: { path: `${BUNDLE}/Contents/MacOS/../MacOS/ycoding-desktop`, sha256: D } }))],
    ["trailing slash executable path", text((value) => ({ ...value, executable: { path: `${EXECUTABLE}/`, sha256: D } }))],
    ["missing application", text((value) => ({ ...value, application: undefined }))],
    ["other application", text((value) => ({ ...value, application: "/synthetic/out/Other.app" }))],
    ["trailing slash application", text((value) => ({ ...value, application: `${BUNDLE}/` }))],
  ]
  for (const [name, receipt, digest] of invalid) expect(() => windowSmoke.admitReceipt(EXECUTABLE, receipt, digest ?? D, PLIST), name).toThrow()
})

test("admits only a receipt whose isolation names a valid smoke identifier with an incognito window", () => {
  const legacy = JSON.stringify({ application: BUNDLE, version: "0.0.0", features: ["isolated-smoke"], executable: { path: EXECUTABLE, sha256: D }, manifest: { sha256: D }, build: { argv: ["/bun", "run", "tauri", "build"], status: 0 } })
  const invalid: [string, string][] = [
    ["pre-change receipt shape", legacy],
    ["missing isolation", text((value) => ({ ...value, isolation: undefined }))],
    ["null isolation", text((value) => ({ ...value, isolation: null }))],
    ["string isolation", text((value) => ({ ...value, isolation: ID }))],
    ["array isolation", text((value) => ({ ...value, isolation: [] }))],
    ["empty isolation", text((value) => ({ ...value, isolation: {} }))],
    ["missing identifier", text((value) => ({ ...value, isolation: { ...value.isolation, identifier: undefined } }))],
    ["numeric identifier", text((value) => ({ ...value, isolation: { ...value.isolation, identifier: 4 } }))],
    ["empty identifier", text((value) => ({ ...value, isolation: { ...value.isolation, identifier: "" } }))],
    ["production identifier", text((value) => ({ ...value, isolation: { ...value.isolation, identifier: "app.ycoding.desktop" } }))],
    ["uppercase identifier", text((value) => ({ ...value, isolation: { ...value.isolation, identifier: ID.toUpperCase() } }))],
    ["extra identifier segment", text((value) => ({ ...value, isolation: { ...value.isolation, identifier: `${ID}.extra` } }))],
    ["incognito false", text((value) => ({ ...value, isolation: { ...value.isolation, incognito: false } }))],
    ["incognito absent", text((value) => ({ ...value, isolation: { ...value.isolation, incognito: undefined } }))],
    ["incognito string", text((value) => ({ ...value, isolation: { ...value.isolation, incognito: "true" } }))],
  ]
  for (const [name, receipt] of invalid) expect(() => windowSmoke.admitReceipt(EXECUTABLE, receipt, D, PLIST), name).toThrow()
  const production = text((value) => ({ ...value, isolation: { ...value.isolation, identifier: "app.ycoding.desktop" } }))
  expect(() => windowSmoke.admitReceipt(EXECUTABLE, production, D, plist("app.ycoding.desktop"))).toThrow()
})

test("admits a receipt only when the app Info.plist holds exactly one CFBundleIdentifier equal to the receipt identifier", () => {
  const receipt = text((value) => value)
  expect(() => windowSmoke.admitReceipt(EXECUTABLE, receipt, D, PLIST)).not.toThrow()
  const invalid: [string, string][] = [
    ["production identifier", plist("app.ycoding.desktop")],
    ["another smoke identifier", plist("app.ycoding.desktop.smoke.tffff")],
    ["longer identifier", plist(`${ID}0`)],
    ["missing key", plist()],
    ["duplicate key", plist(ID, ID)],
    ["receipt and production keys", plist(ID, "app.ycoding.desktop")],
    ["key without a string", '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleIdentifier</key>\n\t<integer>1</integer>\n</dict>\n</plist>\n'],
    ["not XML", "tampered"],
    ["empty", ""],
  ]
  for (const [name, installed] of invalid) expect(() => windowSmoke.admitReceipt(EXECUTABLE, receipt, D, installed), name).toThrow()
})

function fakeFiles(options: { receipt?: "file" | "dir" | "symlink" | "other" | "missing"; real?: string; digest?: string; text?: string; plist?: string } = {}) {
  const calls: string[] = []
  const files = {
    info: async (target: string) => {
      calls.push(`info:${target}`)
      const kind = options.receipt ?? "file"
      return target === RECEIPT && kind !== "missing" ? { kind } : undefined
    },
    real: async (target: string) => {
      calls.push(`real:${target}`)
      return target === RECEIPT ? options.real ?? RECEIPT : target
    },
    text: async (target: string) => {
      calls.push(`text:${target}`)
      return target === INFO ? options.plist ?? PLIST : options.text ?? text((value) => value)
    },
    digest: async (target: string) => {
      calls.push(`digest:${target}`)
      return options.digest ?? D
    },
  }
  return { calls, files }
}

test("the default provenance verifier admits a canonical regular sibling receipt and touches only the receipt, the executable and the Info.plist", async () => {
  const { calls, files } = fakeFiles()
  expect(await windowSmoke.verifyProvenance(EXECUTABLE, files)).toBeUndefined()
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((call) => call.endsWith(`:${RECEIPT}`) || call.endsWith(`:${EXECUTABLE}`) || call.endsWith(`:${INFO}`))).toBe(true)
  expect(calls).toContain(`digest:${EXECUTABLE}`)
  expect(calls).toContain(`text:${INFO}`)
})

test("the default provenance verifier refuses a missing, linked, special or non-canonical receipt and a digest or content mismatch", async () => {
  const cases: [string, Parameters<typeof fakeFiles>[0]][] = [
    ["missing", { receipt: "missing" }],
    ["symlink", { receipt: "symlink" }],
    ["directory", { receipt: "dir" }],
    ["special", { receipt: "other" }],
    ["non-canonical", { real: "/elsewhere/build-receipt.json" }],
    ["digest mismatch", { digest: "b".repeat(64) }],
    ["no smoke feature", { text: text((value) => ({ ...value, features: [] })) }],
    ["not json", { text: "not json" }],
    ["no isolation", { text: JSON.stringify({ application: BUNDLE, executable: { path: EXECUTABLE, sha256: D }, features: ["isolated-smoke"], build: { status: 0 } }) }],
    ["Info.plist identifier mismatch", { plist: plist("app.ycoding.desktop") }],
    ["duplicate Info.plist identifier", { plist: plist(ID, ID) }],
  ]
  for (const [name, options] of cases) {
    const { files } = fakeFiles(options)
    await assert.rejects(windowSmoke.verifyProvenance(EXECUTABLE, files), Error, name)
  }
})

test("the production dependencies use the real provenance verifier with no bypass", () => {
  expect(typeof windowSmoke.verifyProvenance).toBe("function")
  expect(windowSmoke.windowSmokeDeps.provenance).toBe(windowSmoke.verifyProvenance)
})

test("setup verifies provenance after the canonical check and before isolation or any launch", async () => {
  const { deps, trace } = harness()
  let launched = 0
  const smoke = await setupWindowSmoke({ application, mode: "own", launch: async () => { launched++; return fakeApp(trace).app } }, deps)
  expect(trace.slice(0, 3)).toEqual(["canonical", `provenance:${application}`, `isolate:${RESOURCES}`])
  await smoke.cleanup()
  expect(launched).toBe(0)
})

test("a refused provenance stops setup before isolation and any launch", async () => {
  const { deps, trace } = harness({ provenance: async () => { throw new Error("synthetic provenance refusal") } })
  let launched = 0
  await assert.rejects(setupWindowSmoke({ application, mode: "own", launch: async () => { launched++; return fakeApp(trace).app } }, deps), /synthetic provenance refusal/)
  expect(trace).toEqual(["canonical"])
  expect(launched).toBe(0)
})
