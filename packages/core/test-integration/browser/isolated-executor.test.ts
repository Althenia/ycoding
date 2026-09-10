import { describe, expect, test } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { connect, type Client, type Event } from "@ycoding-ai/core/browser/isolated-cdp"
import { IsolatedBrowserExecutor } from "@ycoding-ai/core/browser/isolated-executor"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { Cause, Effect, Exit } from "effect"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

describe("real isolated Chrome executor", () => {
  test("uses the private pipe and enforces semantic, clipboard, file, origin, and observation boundaries", async () => {
    const state: Record<string, number> = {}
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        state[`other:${path}`] = (state[`other:${path}`] ?? 0) + 1
        return new Response("cross origin")
      },
    })
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        state[path] = (state[path] ?? 0) + 1
        if (path === "/redirect") return Response.redirect(`http://127.0.0.1:${other.port}/escaped`, 302)
        if (path.endsWith("-marker")) return new Response("marked")
        return new Response(boundaryFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const rootsBefore = await isolatedRoots()
    const runtime = await launch(`${origin}/fixture`)
    const root = await requireNewRoot(rootsBefore)
    try {
      const observed = await Effect.runPromise(runtime.observe)
      expect(observed.elements.length).toBeLessThanOrEqual(Browser.Schema.MAX_OBSERVATION_ELEMENTS)
      expect(observed.elements.length).toBeGreaterThan(190)
      expect(observed.truncated).toBe(true)
      expect(JSON.stringify(observed)).not.toContain("private-input-value")
      expect(observed.elements.some((element) => element.name === "Password")).toBe(false)
      expect(observed.elements.some((element) => element.name === "Upload")).toBe(false)

      for (const access of ["Clipboard read", "Clipboard write"]) {
        const clipboard = requireElement(await Effect.runPromise(runtime.observe), access)
        const clipboardResult = await Effect.runPromise(runtime.action({ type: "click", ref: clipboard.ref }, [origin]))
        expect(clipboardResult.rejected).toBeUndefined()
      }
      await waitFor(() => state["/clipboard-read-denied-marker"] === 1, "clipboard read denial marker")
      await waitFor(() => state["/clipboard-write-denied-marker"] === 1, "clipboard write denial marker")
      expect(state["/clipboard-read-allowed-marker"] ?? 0).toBe(0)
      expect(state["/clipboard-write-allowed-marker"] ?? 0).toBe(0)

      const unapproved = await Effect.runPromiseExit(
        runtime.action({ type: "navigate", url: `http://127.0.0.1:${other.port}/unapproved` }, [origin]),
      )
      expectFailurePhase(unapproved, "predispatch")
      expect(state["other:/unapproved"] ?? 0).toBe(0)

      const external = requireElement(await Effect.runPromise(runtime.observe), "External")
      const externalExit = await Effect.runPromiseExit(runtime.action({ type: "click", ref: external.ref }, [origin]))
      expectFailurePhase(externalExit, "predispatch")
      const captureExit = await Effect.runPromiseExit(runtime.action({ type: "capture" }, [origin]))
      expectFailurePhase(captureExit, "predispatch")
    } finally {
      await Effect.runPromise(runtime.close)
      await waitForAsync(async () => (await ownedProcesses(root)).length === 0, "clipboard fixture shutdown")
      expect(await isolatedRoots()).not.toContain(root)
      await Bun.sleep(1_000)
      expect(await ownedProcesses(root)).toEqual([])
    }

    const scriptExternalRuntime = await launch(`${origin}/fixture`)
    try {
      const scriptExternal = requireElement(await Effect.runPromise(scriptExternalRuntime.observe), "Script external")
      const exit = await Effect.runPromiseExit(
        scriptExternalRuntime.action({ type: "click", ref: scriptExternal.ref }, [origin]),
      )
      expectFailurePhase(exit, "postdispatch")
    } finally {
      await Effect.runPromise(scriptExternalRuntime.close)
    }

    const pickerRuntime = await launch(`${origin}/fixture`)
    try {
      const filePicker = requireElement(await Effect.runPromise(pickerRuntime.observe), "File picker")
      const exit = await Effect.runPromiseExit(pickerRuntime.action({ type: "click", ref: filePicker.ref }, [origin]))
      expectFailurePhase(exit, "postdispatch")
    } finally {
      await Effect.runPromise(pickerRuntime.close)
      await fixture.stop(true)
    }

    const redirectFixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/redirect")
          return Response.redirect(`http://127.0.0.1:${other.port}/escaped`, 302)
        return new Response("<!doctype html><title>Redirect fixture</title>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const redirectOrigin = `http://127.0.0.1:${redirectFixture.port}`
    const redirected = await launch(`${redirectOrigin}/fixture`)
    try {
      const exit = await Effect.runPromiseExit(
        redirected.action({ type: "navigate", url: `${redirectOrigin}/redirect` }, [redirectOrigin]),
      )
      expectFailurePhase(exit, "postdispatch")
    } finally {
      await Effect.runPromise(redirected.close)
      await redirectFixture.stop(true)
      await other.stop(true)
    }
  }, 60_000)

  test("denies all six proven download trigger classes and contains popups without wedging the opener", async () => {
    const state: Record<string, number> = {}
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        state[path] = (state[path] ?? 0) + 1
        if (path === "/attachment")
          return new Response("synthetic", {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "attachment; filename=synthetic.txt",
            },
          })
        if (path === "/network-attachment")
          return new Response("synthetic", {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "attachment; filename=network.txt",
            },
          })
        if (path === "/popup-download")
          return new Response("<script>fetch('/popup-script-marker');saveBlob('popup.txt')</script>", {
            headers: { "content-type": "text/html" },
          })
        if (path.endsWith("-marker")) return new Response("marked")
        return new Response(downloadFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const cases = [
      {
        name: "navigate attachment",
        action: { type: "navigate" as const, url: `${origin}/attachment` },
        phase: "postdispatch" as const,
      },
      { name: "click network", label: "Network download", phase: "predispatch" as const },
      { name: "click blob", label: "Blob download", phase: "postdispatch" as const },
      { name: "click data", label: "Data download", phase: "predispatch" as const },
      { name: "type handler blob", label: "Type download", phase: "postdispatch" as const, type: true },
    ]
    for (const item of cases) {
      const rootsBefore = await isolatedRoots()
      const runtime = await launch(`${origin}/fixture`)
      const root = await requireNewRoot(rootsBefore)
      try {
        expect(await readdir(join(root, "downloads"))).toEqual([])
        const observed = await Effect.runPromise(runtime.observe)
        const action = item.action
          ? item.action
          : item.type
            ? ({ type: "type", ref: requireElement(observed, item.label).ref, text: "x" } as const)
            : ({ type: "click", ref: requireElement(observed, item.label).ref } as const)
        const exit = await Effect.runPromiseExit(runtime.action(action, [origin]))
        expectFailurePhase(exit, item.phase, item.name)
        expect(await readdir(join(root, "downloads"))).toEqual([])
      } finally {
        await Effect.runPromise(runtime.close)
        expect(await isolatedRoots()).not.toContain(root)
      }
    }

    const rootsBefore = await isolatedRoots()
    const popupRuntime = await launch(`${origin}/fixture`)
    const popupRoot = await requireNewRoot(rootsBefore)
    try {
      const popup = requireElement(await Effect.runPromise(popupRuntime.observe), "Popup download")
      const result = await Effect.runPromise(popupRuntime.action({ type: "click", ref: popup.ref }, [origin]))
      expect(result.rejected).toBe("A popup was safely blocked")
      expect(state["/popup-download"] ?? 0).toBe(0)
      expect(state["/popup-script-marker"] ?? 0).toBe(0)
      expect(await readdir(join(popupRoot, "downloads"))).toEqual([])
      const opener = requireElement(await Effect.runPromise(popupRuntime.observe), "Opener input")
      await Effect.runPromise(
        popupRuntime.action({ type: "type", ref: opener.ref, text: "still responsive" }, [origin]),
      )
    } finally {
      await Effect.runPromise(popupRuntime.close)
      expect(await isolatedRoots()).not.toContain(popupRoot)
      await fixture.stop(true)
    }
  }, 90_000)

  test("proves all download fixtures in a separate owned positive-control Chrome", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/attachment")
          return new Response("synthetic", {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "attachment; filename=synthetic.txt",
            },
          })
        if (path === "/network-attachment")
          return new Response("synthetic", {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "attachment; filename=network.txt",
            },
          })
        if (path === "/popup-download")
          return new Response(
            "<script>const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['synthetic']));a.download='popup.txt';a.click()</script>",
            { headers: { "content-type": "text/html" } },
          )
        return new Response(downloadFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    try {
      const result = await positiveDownloadControl(`http://127.0.0.1:${fixture.port}`)
      expect(result.completed).toBe(6)
      expect(result.files.length).toBe(6)
      expect(result.bytes.every((bytes) => bytes > 0)).toBe(true)
      expect(result.suggested.sort()).toEqual(
        ["blob.txt", "data.txt", "network.txt", "popup.txt", "synthetic.txt", "type.txt"].sort(),
      )
    } finally {
      await fixture.stop(true)
    }
  }, 60_000)

  test("rejects repeated and concurrent popups while preserving the opener", async () => {
    const state: Record<string, number> = {}
    let concurrentOpened = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        const path = url.pathname
        state[path] = (state[path] ?? 0) + 1
        if (path === "/popup-opened-marker") {
          concurrentOpened = Number(url.searchParams.get("count"))
          return new Response("marked")
        }
        if (path === "/popup")
          return new Response("<script>fetch('/popup-script-marker')</script>", {
            headers: { "content-type": "text/html" },
          })
        if (path.endsWith("-marker")) return new Response("marked")
        return new Response(
          `<!doctype html><title>Popup fixture</title>
          <button aria-label="Concurrent popups" onclick="{const one=window.open('/popup?one','_blank');const two=window.open('/popup?two','_blank');fetch('/popup-opened-marker?count='+(Number(Boolean(one))+Number(Boolean(two))))}">Concurrent</button>
          <button aria-label="Repeated popup" onclick="window.open('/popup?repeat','_blank')">Repeated</button>
          <input aria-label="Opener input">`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/fixture`)
    try {
      const concurrent = requireElement(await Effect.runPromise(runtime.observe), "Concurrent popups")
      expect((await Effect.runPromise(runtime.action({ type: "click", ref: concurrent.ref }, [origin]))).rejected).toBe(
        "A popup was safely blocked",
      )
      await waitFor(() => concurrentOpened > 0, "concurrent popup positive marker")
      expect(concurrentOpened).toBe(2)
      for (let attempt = 0; attempt < 2; attempt++) {
        const repeated = requireElement(await Effect.runPromise(runtime.observe), "Repeated popup")
        expect((await Effect.runPromise(runtime.action({ type: "click", ref: repeated.ref }, [origin]))).rejected).toBe(
          "A popup was safely blocked",
        )
      }
      expect(state["/popup"] ?? 0).toBe(0)
      expect(state["/popup-script-marker"] ?? 0).toBe(0)
      const opener = requireElement(await Effect.runPromise(runtime.observe), "Opener input")
      await Effect.runPromise(runtime.action({ type: "type", ref: opener.ref, text: "responsive" }, [origin]))
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 30_000)

  test("rejects child frames before their document or script effects run", async () => {
    let frameDocument = 0
    let frameScript = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/frame") {
          frameDocument++
          return new Response("<script>fetch('/frame-script-marker')</script>", {
            headers: { "content-type": "text/html" },
          })
        }
        if (path === "/frame-script-marker") {
          frameScript++
          return new Response("marked")
        }
        return new Response("<!doctype html><title>Frame fixture</title><iframe src='/frame'></iframe>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const rootsBefore = await isolatedRoots()
    const exit = await launchExit(`http://127.0.0.1:${fixture.port}/fixture`)
    if (Exit.isSuccess(exit)) await Effect.runPromise(exit.value.close)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(frameDocument).toBe(0)
    expect(frameScript).toBe(0)
    await waitForAsync(async () => (await isolatedRoots()).length === rootsBefore.length, "frame startup cleanup")
    await fixture.stop(true)
  }, 30_000)

  test("bounds owned process count and removes its profile and download resources on close", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<!doctype html><title>Resource fixture</title>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const rootsBefore = await isolatedRoots()
    const startupAt = performance.now()
    const runtime = await launch(`http://127.0.0.1:${fixture.port}/fixture`)
    const startupMs = performance.now() - startupAt
    const root = await requireNewRoot(rootsBefore)
    try {
      const processes = await ownedProcesses(root)
      expect(startupMs).toBeLessThan(15_000)
      expect(processes.length).toBeGreaterThan(0)
      expect(processes.length).toBeLessThanOrEqual(8)
      expect(await readdir(join(root, "downloads"))).toEqual([])
    } finally {
      const shutdownAt = performance.now()
      await Effect.runPromise(runtime.close)
      expect(performance.now() - shutdownAt).toBeLessThan(10_000)
      await waitForAsync(async () => (await ownedProcesses(root)).length === 0, "owned Chrome process shutdown")
      expect(await isolatedRoots()).not.toContain(root)
      await fixture.stop(true)
    }
  }, 30_000)

  test("closes and removes owned resources after spontaneous browser exit", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<!doctype html><title>Browser exit fixture</title>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const rootsBefore = await isolatedRoots()
    const runtime = await launch(`http://127.0.0.1:${fixture.port}/fixture`)
    const root = await requireNewRoot(rootsBefore)
    try {
      const browser = (await ownedProcesses(root)).find((line) => !line.includes(" --type="))
      if (!browser) throw new Error("Missing owned Chrome browser process")
      process.kill(processID(browser), "SIGTERM")
      await withDeadline(Effect.runPromise(runtime.closed), 5_000, "owned browser exit cleanup")
      expect(await isolatedRoots()).not.toContain(root)
      expect(await ownedProcesses(root)).toEqual([])
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 30_000)

  test("closes and removes owned resources after the controllable target crashes", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<!doctype html><title>Target crash fixture</title>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const rootsBefore = await isolatedRoots()
    const runtime = await launch(`http://127.0.0.1:${fixture.port}/fixture`)
    const root = await requireNewRoot(rootsBefore)
    try {
      const renderers = (await ownedProcesses(root)).filter((line) => line.includes(" --type=renderer"))
      expect(renderers.length).toBeGreaterThan(0)
      renderers.forEach((line) => process.kill(processID(line), "SIGKILL"))
      await withDeadline(Effect.runPromise(runtime.closed), 5_000, "target crash cleanup")
      await Bun.sleep(1_000)
      expect(await isolatedRoots()).not.toContain(root)
      expect(await ownedProcesses(root)).toEqual([])
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 30_000)

  test("bounds shutdown and removes all owned resources when Chrome is deliberately hung", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<!doctype html><title>Hung shutdown fixture</title>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const rootsBefore = await isolatedRoots()
    const runtime = await launch(`http://127.0.0.1:${fixture.port}/fixture`)
    const root = await requireNewRoot(rootsBefore)
    try {
      const browser = (await ownedProcesses(root)).find((line) => !line.includes(" --type="))
      if (!browser) throw new Error("Missing owned Chrome browser process")
      process.kill(processID(browser), "SIGSTOP")
      const shutdownAt = performance.now()
      await Effect.runPromise(runtime.close)
      expect(performance.now() - shutdownAt).toBeLessThan(8_000)
      expect(await ownedProcesses(root)).toEqual([])
      expect(await isolatedRoots()).not.toContain(root)
    } finally {
      const remaining = await ownedProcesses(root)
      remaining.forEach((line) => {
        try {
          process.kill(processID(line), "SIGCONT")
        } catch {
          return
        }
      })
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 35_000)

  test("rejects a real screenshot larger than 1 MiB without returning capture data", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(oversizedCaptureFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/fixture`)
    try {
      expect((await Effect.runPromise(runtime.observe)).title).toBe("Oversized capture ready")
      const exit = await Effect.runPromiseExit(runtime.action({ type: "capture" }, [origin]))
      expectFailurePhase(exit, "predispatch")
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toMatchObject({ message: "Capture exceeds the 1 MiB limit" })
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 30_000)

  test("rejects capture when a password input is inside a shadow root", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          "<!doctype html><title>Shadow password</title><div id='host'></div><script>host.attachShadow({mode:'closed'}).innerHTML=\"<input type='password'>\"</script>",
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/fixture`)
    try {
      expect((await Effect.runPromise(runtime.observe)).title).toBe("Shadow password")
      const exit = await Effect.runPromiseExit(runtime.action({ type: "capture" }, [origin]))
      expectFailurePhase(exit, "predispatch")
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toMatchObject({
          message: "Capture is disabled while password fields are present",
        })
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 30_000)

  test("destroys delayed page work when the owning controller closes", async () => {
    let delayed = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/delayed-marker") {
          delayed++
          return new Response("marked")
        }
        return new Response(
          "<!doctype html><title>Cleanup fixture</title><button aria-label='Schedule' onclick=\"setTimeout(()=>fetch('/delayed-marker'),750)\">Schedule</button>",
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/fixture`)
    const schedule = requireElement(await Effect.runPromise(runtime.observe), "Schedule")
    await Effect.runPromise(runtime.action({ type: "click", ref: schedule.ref }, [origin]))
    await Effect.runPromise(runtime.close)
    await Bun.sleep(1_000)
    expect(delayed).toBe(0)
    await fixture.stop(true)
  }, 30_000)
})

async function launch(url: string) {
  return Effect.runPromise(launchEffect(url))
}

function launchExit(url: string) {
  return Effect.runPromiseExit(launchEffect(url))
}

function launchEffect(url: string) {
  return Effect.gen(function* () {
    const executor = yield* IsolatedBrowserExecutor.Service
    const available = yield* executor.availability
    if (!available.available) throw new Error(available.reason)
    return yield* executor.launch({
      instanceID: IsolatedBrowser.InstanceID.create(),
      tabID: Browser.TabID.create(),
      url,
    })
  }).pipe(Effect.provide(IsolatedBrowserExecutor.layer))
}

function requireElement(observation: IsolatedBrowserExecutor.Snapshot, name: string) {
  const element = observation.elements.find((candidate) => candidate.name === name)
  if (!element) throw new Error(`Missing synthetic element: ${name}`)
  return element
}

function expectFailurePhase(
  exit: Exit.Exit<unknown, IsolatedBrowserExecutor.Error>,
  phase: IsolatedBrowserExecutor.Error["phase"],
  label?: string,
) {
  expect(Exit.isFailure(exit), label).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause), label).toMatchObject({ phase })
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForAsync(predicate: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function isolatedRoots() {
  return (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^ycoding-isolated-browser-[A-Za-z0-9]{6}$/.test(entry.name))
    .map((entry) => join(tmpdir(), entry.name))
}

async function requireNewRoot(before: ReadonlyArray<string>) {
  const root = (await isolatedRoots()).find((candidate) => !before.includes(candidate))
  if (!root) throw new Error("Missing owned isolated Chrome root")
  return root
}

async function ownedProcesses(root: string) {
  const processList = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(processList.stdout).text()
  if ((await processList.exited) !== 0) throw new Error("Failed to inspect owned Chrome processes")
  return output.split("\n").filter((line) => line.includes(root))
}

function processID(line: string) {
  const value = Number(line.trim().split(/\s+/, 1)[0])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid owned Chrome process ID")
  return value
}

function withDeadline<A>(promise: Promise<A>, ms: number, label: string) {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`Timed out waiting for ${label}`)
    }),
  ])
}

async function positiveDownloadControl(origin: string) {
  const root = await mkdtemp(join(tmpdir(), "ycoding-isolated-download-positive-"))
  const downloads = join(root, "downloads")
  await mkdir(downloads, { mode: 0o700 })
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${join(root, "profile")}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-popup-blocking",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  )
  const readable = child.stdio[4]
  const writable = child.stdio[3]
  if (!(readable instanceof Readable) || !(writable instanceof Writable)) {
    child.kill("SIGTERM")
    await rm(root, { recursive: true, force: true })
    throw new Error("Positive-control Chrome did not expose its private pipe")
  }
  const cdp = connect(readable, writable)
  try {
    return await runPositiveDownloadControl(cdp, origin, downloads)
  } finally {
    await cdp.send("Browser.close").catch(() => {})
    cdp.close()
    await Promise.race([onceExit(child), Bun.sleep(5_000)])
    if (child.exitCode === null) child.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
  }
}

async function runPositiveDownloadControl(cdp: Client, origin: string, downloads: string) {
  const version = testRecord(await cdp.send("Browser.getVersion"))
  expect(version.product).toMatch(/^Chrome\/152\./)
  const context = testRecord(await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }))
  const browserContextId = testString(context.browserContextId)
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    browserContextId,
    downloadPath: downloads,
    eventsEnabled: true,
  })
  const created = testRecord(await cdp.send("Target.createTarget", { url: "about:blank", browserContextId }))
  const targetId = testString(created.targetId)
  const attached = testRecord(await cdp.send("Target.attachToTarget", { targetId, flatten: true }))
  const sessionId = testString(attached.sessionId)
  const begun: Event[] = []
  const completed = new Set<string>()
  const unsubscribe = cdp.subscribe((event) => {
    if (event.method === "Browser.downloadWillBegin") begun.push(event)
    if (event.method === "Browser.downloadProgress" && event.params?.state === "completed")
      completed.add(testString(event.params.guid))
  })
  try {
    await cdp.send("Page.enable", {}, sessionId)
    await cdp.send("Page.navigate", { url: `${origin}/fixture` }, sessionId)
    await waitForCDPDocument(cdp, sessionId, origin)
    await triggerPositiveDownload(
      cdp,
      sessionId,
      () => cdp.send("Page.navigate", { url: `${origin}/attachment` }, sessionId),
      () => completed.size,
    )
    for (const expression of [
      `document.querySelector('[aria-label="Network download"]').click()`,
      `document.querySelector('[aria-label="Blob download"]').click()`,
      `document.querySelector('[aria-label="Data download"]').click()`,
      `{const input=document.querySelector('[aria-label="Type download"]');input.value='x';input.dispatchEvent(new Event('input',{bubbles:true}))}`,
      `window.open('/popup-download','_blank')`,
    ])
      await triggerPositiveDownload(
        cdp,
        sessionId,
        () => cdp.send("Runtime.evaluate", { expression, userGesture: true }, sessionId),
        () => completed.size,
      )
    const files = await readdir(downloads)
    return {
      completed: completed.size,
      files,
      bytes: await Promise.all(files.map((file) => stat(join(downloads, file)).then((info) => info.size))),
      suggested: begun.map((event) => testString(event.params?.suggestedFilename)),
    }
  } finally {
    unsubscribe()
    await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {})
  }
}

async function triggerPositiveDownload(
  cdp: Client,
  sessionId: string,
  trigger: () => Promise<unknown>,
  completed: () => number,
) {
  const before = completed()
  await trigger()
  await waitForAsync(async () => completed() > before, "positive-control download event")
  const target = testRecord(await cdp.send("Target.getTargetInfo", {}, sessionId))
  expect(testRecord(target.targetInfo).browserContextId).toBeDefined()
}

async function waitForCDPDocument(cdp: Client, sessionId: string, origin: string) {
  await waitForAsync(async () => {
    const tree = testRecord(await cdp.send("Page.getFrameTree", {}, sessionId))
    const frame = testRecord(testRecord(tree.frameTree).frame)
    return typeof frame.url === "string" && new URL(frame.url).origin === origin
  }, "positive-control document")
}

function testRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isTestRecord(value)) throw new Error("Invalid positive-control Chrome response")
  return value
}

function isTestRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
}

function testString(value: unknown) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing positive-control Chrome value")
  return value
}

function onceExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => child.once("exit", () => resolve()))
}

function boundaryFixture() {
  return `<!doctype html><title>Boundary fixture</title>
    <button aria-label="Clipboard read" onclick="navigator.clipboard.readText().then(()=>fetch('/clipboard-read-allowed-marker')).catch(()=>fetch('/clipboard-read-denied-marker'))">Clipboard read</button>
    <button aria-label="Clipboard write" onclick="navigator.clipboard.writeText('forbidden').then(()=>fetch('/clipboard-write-allowed-marker')).catch(()=>fetch('/clipboard-write-denied-marker'))">Clipboard write</button>
    <a aria-label="External" href="mailto:synthetic@example.invalid">External</a>
    <button aria-label="Script external" onclick="location.href='mailto:synthetic@example.invalid'">Script external</button>
    <button aria-label="File picker" onclick="document.getElementById('upload').click()">File picker</button>
    <input id="upload" type="file" aria-label="Upload">
    <input type="password" aria-label="Password" value="private-input-value">
    ${Array.from({ length: 205 }, (_, index) => `<button aria-label="Bound ${index}">Bound</button>`).join("")}`
}

function downloadFixture() {
  return `<!doctype html><title>Download fixture</title>
    <a aria-label="Network download" href="/network-attachment" download="network.txt">Network</a>
    <button aria-label="Blob download" onclick="saveBlob('blob.txt')">Blob</button>
    <a aria-label="Data download" href="data:text/plain,synthetic" download="data.txt">Data</a>
    <input aria-label="Type download" oninput="saveBlob('type.txt')">
    <button aria-label="Popup download" onclick="window.open('/popup-download','_blank')">Popup</button>
    <input aria-label="Opener input">
    <script>function saveBlob(name){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['synthetic']));a.download=name;a.click()}</script>`
}

function oversizedCaptureFixture() {
  return `<!doctype html><title>Preparing oversized capture</title><style>html,body{margin:0}canvas{display:block}</style>
    <canvas width="800" height="600"></canvas><script>
      const canvas=document.querySelector('canvas');const context=canvas.getContext('2d');const image=context.createImageData(800,600);
      for(let offset=0;offset<image.data.length;offset+=65536)crypto.getRandomValues(image.data.subarray(offset,Math.min(offset+65536,image.data.length)));
      for(let index=3;index<image.data.length;index+=4)image.data[index]=255;
      context.putImageData(image,0,0);document.title='Oversized capture ready'
    </script>`
}
