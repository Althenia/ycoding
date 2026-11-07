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
      const password = requireElement(observed, "Password")
      expect(password.sensitive).toBe(true)
      expect(password.value).toBeUndefined()
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

  test("observes an approved same-origin child frame merged with the top document", async () => {
    let frameDocument = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/frame") {
          frameDocument++
          return new Response("<!doctype html><title>Frame</title><p>Frame text</p><button>Frame button</button>", {
            headers: { "content-type": "text/html" },
          })
        }
        return new Response("<!doctype html><title>Frame fixture</title><h1>Shell heading</h1><iframe src='/frame'></iframe>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/fixture`)
    try {
      const observed = await Effect.runPromise(runtime.observe)
      expect(frameDocument).toBeGreaterThan(0)
      expect(observed.frames).toContainEqual(
        expect.objectContaining({ page: { origin, path: "/frame" }, observed: true }),
      )
      expect(observed.elements).toContainEqual(
        expect.objectContaining({ name: "Frame button", frame: { origin, path: "/frame" } }),
      )
      expect(observed.texts).toContainEqual(expect.objectContaining({ name: "Frame text" }))
      expect(observed.texts).toContainEqual(expect.objectContaining({ name: "Shell heading" }))
      const button = requireElement(observed, "Frame button")
      const clicked = await Effect.runPromise(runtime.action({ type: "click", ref: button.ref }, [origin]))
      expect(clicked.rejected).toBeUndefined()
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
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
      const browserID = processID(browser)
      expect(new Set((await ownedProcesses(root)).map(processGroupID))).toEqual(new Set([browserID]))
      process.kill(browserID, "SIGSTOP")
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

  test("fills, selects, checks, and hovers real controls and reports their state", async () => {
    const state: Record<string, number> = {}
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("-marker")) {
          state[path] = (state[path] ?? 0) + 1
          return new Response("marked")
        }
        return new Response(formFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/form`)
    const on = async (name: string, make: (ref: Browser.Schema.Element["ref"]) => Browser.Schema.Action) =>
      Effect.runPromise(runtime.action(make(requireElement(await Effect.runPromise(runtime.observe), name).ref), [origin]))
    const refused = async (name: string, make: (ref: Browser.Schema.Element["ref"]) => Browser.Schema.Action, message: string) => {
      const exit = await Effect.runPromiseExit(
        runtime.action(make(requireElement(await Effect.runPromise(runtime.observe), name).ref), [origin]),
      )
      expectFailurePhase(exit, "predispatch", name)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: expect.stringContaining(message) })
    }
    try {
      const initial = await Effect.runPromise(runtime.observe)
      expect(requireElement(initial, "Subscribe").checked).toBe(false)
      expect(requireElement(initial, "Dark mode").checked).toBe(false)
      expect(requireElement(initial, "Full name").value).toBeUndefined()

      expect((await on("Full name", (ref) => ({ type: "fill", ref, text: "Ada Lovelace" }))).control).toEqual({ value: "Ada Lovelace" })
      expect(requireElement(await Effect.runPromise(runtime.observe), "Full name").value).toBe("Ada Lovelace")
      expect((await on("Full name", (ref) => ({ type: "fill", ref, text: "Grace" }))).control).toEqual({ value: "Grace" })
      expect((await on("Full name", (ref) => ({ type: "fill", ref, text: "" }))).control).toEqual({ value: "" })
      expect((await on("Notes", (ref) => ({ type: "fill", ref, text: "line one\nline two" }))).control).toEqual({ value: "line one\nline two" })
      expect((await on("Rich note", (ref) => ({ type: "fill", ref, text: "Rich text" }))).control).toEqual({ value: "Rich text" })
      expect((await on("Volume", (ref) => ({ type: "fill", ref, text: "7" }))).control).toEqual({ value: "7" })
      const dated = await Effect.runPromise(runtime.observe)
      expect(requireElement(dated, "Birthday").role).toBe("Date")
      for (const [name, text] of [
        ["Birthday", "2024-02-29"],
        ["Alarm", "13:45"],
        ["Meeting", "2024-02-29T13:45"],
        ["Billing month", "2024-02"],
        ["Review week", "2024-W09"],
        ["Accent", "#ff8800"],
      ] as const)
        expect((await on(name, (ref) => ({ type: "fill", ref, text }))).control, name).toEqual({ value: text })
      const invalid = await Effect.runPromiseExit(
        runtime.action({ type: "fill", ref: requireElement(await Effect.runPromise(runtime.observe), "Birthday").ref, text: "not-a-date" }, [origin]),
      )
      expectFailurePhase(invalid, "postdispatch", "invalid date")
      if (Exit.isFailure(invalid)) expect(messageOf(Cause.squash(invalid.cause))).toContain("rejected the value")
      await refused("Subscribe", (ref) => ({ type: "fill", ref, text: "x" }), "cannot be filled")
      await refused("Hover target", (ref) => ({ type: "fill", ref, text: "x" }), "cannot be filled")

      expect((await on("Colour", (ref) => ({ type: "select", ref, values: ["g"] }))).control).toEqual({
        selected: [{ value: "g", label: "Green", index: 1 }],
      })
      expect((await on("Colour", (ref) => ({ type: "select", ref, labels: ["Red"] }))).control).toEqual({
        selected: [{ value: "r", label: "Red", index: 0 }],
      })
      expect((await on("Colour", (ref) => ({ type: "select", ref, indexes: [1] }))).control).toEqual({
        selected: [{ value: "g", label: "Green", index: 1 }],
      })
      expect((await on("Toppings", (ref) => ({ type: "select", ref, values: ["a", "p"] }))).control).toEqual({
        selected: [
          { value: "a", label: "Almond", index: 0 },
          { value: "p", label: "Pecan", index: 2 },
        ],
      })
      await refused("Colour", (ref) => ({ type: "select", ref, values: ["missing"] }), "Option not found")
      await refused("Colour", (ref) => ({ type: "select", ref, labels: ["Blue"] }), "Option is disabled")
      await refused("Colour", (ref) => ({ type: "select", ref, values: ["r", "g"] }), "Select accepts one option")
      await refused("Full name", (ref) => ({ type: "select", ref, values: ["r"] }), "not a select")

      expect((await on("Fruit", (ref) => ({ type: "select", ref, labels: ["Banana"] }))).control).toEqual({
        selected: [{ label: "Banana", index: 1 }],
      })
      expect(state["/pick-Banana-marker"]).toBe(1)
      expect((await on("Fruit", (ref) => ({ type: "select", ref, labels: ["Banana"] }))).control).toEqual({
        selected: [{ label: "Banana", index: 1 }],
      })
      expect(state["/pick-Banana-marker"]).toBe(1)
      expect((await on("Fruit", (ref) => ({ type: "select", ref, indexes: [0] }))).control).toEqual({
        selected: [{ label: "Apple", index: 0 }],
      })
      await refused("Fruit", (ref) => ({ type: "select", ref, values: ["Apple"] }), "values")
      await refused("Menu combo", (ref) => ({ type: "select", ref, labels: ["Apple"] }), "Open the list first")

      expect((await on("Subscribe", (ref) => ({ type: "check", ref, checked: true }))).control).toEqual({ checked: true })
      expect(state["/subscribe-click-marker"]).toBe(1)
      expect((await on("Subscribe", (ref) => ({ type: "check", ref, checked: true }))).control).toEqual({ checked: true })
      expect(state["/subscribe-click-marker"]).toBe(1)
      expect((await on("Subscribe", (ref) => ({ type: "check", ref, checked: false }))).control).toEqual({ checked: false })
      expect(state["/subscribe-click-marker"]).toBe(2)
      expect((await on("Dark mode", (ref) => ({ type: "check", ref, checked: true }))).control).toEqual({ checked: true })
      expect((await on("Large", (ref) => ({ type: "check", ref, checked: true }))).control).toEqual({ checked: true })
      expect(requireElement(await Effect.runPromise(runtime.observe), "Small").checked).toBe(false)
      await refused("Large", (ref) => ({ type: "check", ref, checked: false }), "radio")
      await refused("Hover target", (ref) => ({ type: "check", ref, checked: true }), "checked state")

      expect(
        (await Effect.runPromise(runtime.observe)).elements.some((element) => element.name === "Revealed"),
      ).toBe(false)
      const hovered = await on("Hover target", (ref) => ({ type: "hover", ref }))
      expect(hovered.rejected).toBeUndefined()
      expect(requireElement(await Effect.runPromise(runtime.observe), "Revealed").role).toBe("button")
      expect(state["/hover-click-marker"] ?? 0).toBe(0)
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 90_000)

  test("refuses to fill or type into password, one-time-code, and payment fields", async () => {
    const state: Record<string, number> = {}
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("-marker")) {
          state[path] = (state[path] ?? 0) + 1
          return new Response("marked")
        }
        return new Response(sensitiveFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/sensitive`)
    try {
      const observed = await Effect.runPromise(runtime.observe)
      expect(JSON.stringify(observed)).not.toContain("private-input-value")
      const names = ["Account secret", "Password by label", "One-time code", "Card", "Security", "Recovery"]
      for (const name of names) {
        const element = requireElement(observed, name)
        expect(element.sensitive, name).toBe(true)
        expect(element.value, name).toBeUndefined()
      }
      const ordinary = requireElement(observed, "Nickname")
      expect(ordinary.sensitive).toBeUndefined()
      expect(ordinary.value).toBe("visible-value")

      for (const name of names) {
        for (const make of [
          (ref: Browser.Schema.Element["ref"]) => ({ type: "fill", ref, text: "typed-secret" }) as const,
          (ref: Browser.Schema.Element["ref"]) => ({ type: "type", ref, text: "typed-secret" }) as const,
        ]) {
          const fresh = requireElement(await Effect.runPromise(runtime.observe), name)
          const exit = await Effect.runPromiseExit(runtime.action(make(fresh.ref), [origin]))
          expectFailurePhase(exit, "predispatch", name)
          if (Exit.isFailure(exit)) {
            const message = messageOf(Cause.squash(exit.cause))
            expect(message, name).not.toContain("typed-secret")
            expect(message, name).not.toContain("private-input-value")
          }
        }
      }
      await Bun.sleep(300)
      expect(state["/typed-marker"] ?? 0).toBe(0)
      const typed = await Effect.runPromise(
        runtime.action({ type: "type", ref: requireElement(await Effect.runPromise(runtime.observe), "Nickname").ref, text: "!" }, [origin]),
      )
      expect(typed.rejected).toBeUndefined()
      await waitFor(() => state["/typed-marker"] === 1, "ordinary field input marker")
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 60_000)

  test("waits for locator states, a URL pattern, load states including networkidle, and text", async () => {
    let flags: Record<string, boolean> = {}
    const hang = Promise.withResolvers<void>()
    let slowFinishedAt = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/state") return Response.json(flags)
        if (path === "/waits-frame")
          return new Response("<!doctype html><title>Wait frame</title><p>Frame ready</p>", { headers: { "content-type": "text/html" } })
        if (path === "/hang") {
          await hang.promise
          return new Response("hung", { headers: { "content-type": "text/plain" } })
        }
        if (path === "/slow") {
          await Bun.sleep(1_500)
          slowFinishedAt = Date.now()
          return new Response("slow")
        }
        if (path === "/late") {
          await Bun.sleep(1_000)
          slowFinishedAt = Date.now()
          return new Response("late")
        }
        if (path === "/loading") return new Response(loadingFixture(), { headers: { "content-type": "text/html" } })
        if (path === "/idle-slow") return new Response(idleFixture("fetch('/slow')"), { headers: { "content-type": "text/html" } })
        if (path === "/idle-late")
          return new Response(idleFixture("setTimeout(() => fetch('/late'), 300)"), { headers: { "content-type": "text/html" } })
        return new Response(waitFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/waits`)
    const act = async (action: Browser.Schema.Action) => {
      const exit = await Effect.runPromiseExit(runtime.action(action, [origin]))
      if (Exit.isFailure(exit)) throw new Error(`${JSON.stringify(action)}: ${messageOf(Cause.squash(exit.cause))}`)
      return exit.value
    }
    const flip = async (key: string) => {
      await Bun.sleep(300)
      flags = { ...flags, [key]: true }
    }
    const expectTimeout = async (action: Browser.Schema.Action) => {
      const exit = await Effect.runPromiseExit(runtime.action(action, [origin]))
      expectFailurePhase(exit, "predispatch", JSON.stringify(action))
    }
    try {
      const late = `role=button[name=${JSON.stringify("Late button")}]`
      await expectTimeout({ type: "wait", locator: late, timeoutMs: 300 })
      const lateWait = act({ type: "wait", locator: late, timeoutMs: 5_000 })
      await flip("late")
      expect((await lateWait).frame).toBeUndefined()
      await act({ type: "wait", locator: late, state: "attached" })

      let observed = await Effect.runPromise(runtime.observe)
      const temp = requireElement(observed, "Temp")
      expect(await act({ type: "wait", ref: temp.ref, state: "visible" })).toMatchObject({ rejected: undefined })
      observed = await Effect.runPromise(runtime.observe)
      const tempRef = requireElement(observed, "Temp").ref
      const hiddenWait = act({ type: "wait", ref: tempRef, state: "hidden", timeoutMs: 5_000 })
      await flip("temp")
      await hiddenWait
      await act({ type: "wait", locator: `role=button[name=${JSON.stringify("Temp")}]`, state: "hidden" })
      await expectTimeout({ type: "wait", locator: `role=button[name=${JSON.stringify("Temp")}]`, state: "visible", timeoutMs: 300 })

      observed = await Effect.runPromise(runtime.observe)
      const goneRef = requireElement(observed, "Gone").ref
      const goneWait = act({ type: "wait", ref: goneRef, state: "detached", timeoutMs: 5_000 })
      await flip("gone")
      await goneWait
      await act({ type: "wait", locator: `role=button[name=${JSON.stringify("Gone")}]`, state: "detached" })

      const textWait = act({ type: "wait", text: "Order  complete", timeoutMs: 5_000 })
      await flip("text")
      expect((await textWait).frame).toBeUndefined()
      expect((await act({ type: "wait", text: "Frame ready" })).frame).toEqual({ origin, path: "/waits-frame" })
      await expectTimeout({ type: "wait", text: "never rendered", timeoutMs: 300 })

      await expectTimeout({ type: "wait", url: `${origin}/waits/done?step=1`, timeoutMs: 300 })
      const urlWait = act({ type: "wait", url: `${origin}/waits/d*`, timeoutMs: 5_000 })
      await flip("url")
      await urlWait
      await expectTimeout({ type: "wait", url: `${origin}/waits/done?step=1`, timeoutMs: 300 })
      await expectTimeout({ type: "wait", url: `${origin}/waits/done#frag`, timeoutMs: 300 })
      await act({ type: "wait", url: `${origin}/waits/done` })
    } finally {
      await Effect.runPromise(runtime.close)
    }

    const loading = await launch(`${origin}/loading`)
    const loadingAct = (action: Browser.Schema.Action) => Effect.runPromise(loading.action(action, [origin]))
    try {
      await loadingAct({ type: "wait", load: "domcontentloaded", timeoutMs: 2_000 })
      const exit = await Effect.runPromiseExit(loading.action({ type: "wait", load: "load", timeoutMs: 300 }, [origin]))
      expectFailurePhase(exit, "predispatch", "load before the image answers")
      const loaded = loadingAct({ type: "wait", timeoutMs: 5_000 })
      await Bun.sleep(300)
      hang.resolve()
      await loaded
      await loadingAct({ type: "wait", load: "load" })
    } finally {
      await Effect.runPromise(loading.close)
    }

    for (const path of ["/idle-slow", "/idle-late"]) {
      slowFinishedAt = 0
      const idle = await launch(`${origin}${path}`)
      try {
        const early = await Effect.runPromiseExit(
          idle.action({ type: "wait", load: "networkidle", timeoutMs: 300 }, [origin]),
        )
        expectFailurePhase(early, "predispatch", `${path} networkidle while a request is pending`)
        const settled = await Effect.runPromise(idle.action({ type: "wait", load: "networkidle", timeoutMs: 8_000 }, [origin]))
        expect(settled.rejected).toBeUndefined()
        expect(slowFinishedAt, path).toBeGreaterThan(0)
        expect(Date.now() - slowFinishedAt, path).toBeGreaterThanOrEqual(500)
      } finally {
        await Effect.runPromise(idle.close)
      }
    }
    await fixture.stop(true)
  }, 120_000)

  test("refuses editing keys while a password, label-named, shadow, or framed secret field has focus", async () => {
    const state: Record<string, number> = {}
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("-marker")) {
          state[path] = (state[path] ?? 0) + 1
          return new Response("marked")
        }
        if (path === "/key-frame")
          return new Response(
            "<!doctype html><title>Key frame</title><input type='password' aria-label='Frame secret' value='private-input-value' onkeydown=\"fetch('/keydown-'+event.key+'-marker')\" oninput=\"fetch('/input-secret-marker')\">",
            { headers: { "content-type": "text/html" } },
          )
        return new Response(keyFixture(), { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/keys`)
    const key = (value: string, modifiers?: Parameters<typeof keyAction>[1]) =>
      Effect.runPromiseExit(runtime.action(keyAction(value, modifiers), [origin]))
    const refusedKey = async (value: string) => {
      for (const [chord, modifiers] of editingKeys) {
        const exit = await key(chord, modifiers)
        expectFailurePhase(exit, "predispatch", `${value} ${(modifiers ?? []).join("+")}+${chord}`)
        if (Exit.isFailure(exit)) expect(messageOf(Cause.squash(exit.cause))).toContain("sensitive field")
      }
      const exit = await key(value)
      expectFailurePhase(exit, "predispatch", `key ${value}`)
      if (Exit.isFailure(exit)) expect(messageOf(Cause.squash(exit.cause))).toContain("sensitive field")
    }
    const allowedKey = async (value: string, modifiers?: Parameters<typeof keyAction>[1]) => {
      const exit = await key(value, modifiers)
      expect(Exit.isSuccess(exit), `key ${value}`).toBe(true)
    }
    try {
      const start = requireElement(await Effect.runPromise(runtime.observe), "Start")
      await Effect.runPromise(runtime.action({ type: "click", ref: start.ref }, [origin]))
      await allowedKey("a")
      await waitFor(() => state["/keydown-a-marker"] === 1, "key a on an ordinary field")
      await waitFor(() => state["/input-ok-marker"] === 1, "input on an ordinary field")
      await allowedKey("Tab")
      await refusedKey("b")
      await allowedKey("Tab")
      await refusedKey("c")
      await allowedKey("Tab")
      await allowedKey("d")
      await waitFor(() => state["/keydown-d-marker"] === 1, "key d on an ordinary field")
      await allowedKey("v", ["Meta"])
      await allowedKey("v", ["Control"])
      await allowedKey("Insert", ["Shift"])
      await waitFor(() => state["/keydown-v-marker"] === 2, "paste chords on an ordinary field")
      await waitFor(() => state["/keydown-Insert-marker"] === 1, "Shift+Insert on an ordinary field")
      await allowedKey("Tab")
      await refusedKey("e")
      await allowedKey("Tab")
      await refusedKey("f")
      await Bun.sleep(300)
      for (const letter of ["b", "c", "e", "f"]) expect(state[`/keydown-${letter}-marker`] ?? 0, letter).toBe(0)
      expect(state["/input-secret-marker"] ?? 0).toBe(0)
      expect(state["/keydown-v-marker"]).toBe(2)
      expect(state["/keydown-Insert-marker"]).toBe(1)
      expect(state["/input-ok-marker"]).toBeGreaterThanOrEqual(2)
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 60_000)

  test("observes and fills date, time, color, and range inputs inside a same-origin iframe", async () => {
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/date-frame")
          return new Response(
            "<!doctype html><title>Date frame</title><input type='date' aria-label='Frame birthday'><input type='time' aria-label='Frame alarm'><input type='color' aria-label='Frame accent'><input type='range' min='0' max='10' aria-label='Frame volume'>",
            { headers: { "content-type": "text/html" } },
          )
        return new Response("<!doctype html><title>Date shell</title><h1>Shell</h1><iframe src='/date-frame'></iframe>", {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/shell`)
    try {
      const observed = await Effect.runPromise(runtime.observe)
      for (const [name, role] of [
        ["Frame birthday", "Date"],
        ["Frame alarm", "InputTime"],
        ["Frame accent", "ColorWell"],
        ["Frame volume", "slider"],
      ] as const)
        expect(requireElement(observed, name), name).toMatchObject({ role, frame: { origin, path: "/date-frame" } })
      for (const [name, text] of [
        ["Frame birthday", "2024-02-29"],
        ["Frame alarm", "13:45"],
        ["Frame accent", "#ff8800"],
        ["Frame volume", "7"],
      ] as const) {
        const element = requireElement(await Effect.runPromise(runtime.observe), name)
        const result = await Effect.runPromise(runtime.action({ type: "fill", ref: element.ref, text }, [origin]))
        expect(result.control, name).toEqual({ value: text })
      }
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 60_000)

  test("refuses editing keys when focus sits in a frame or closed shadow root that cannot be proven safe", async () => {
    const state: Record<string, number> = {}
    const frameServer = (kind: "password" | "plain") =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname
          if (path.endsWith("-marker")) {
            const key = `${kind}${path}`
            state[key] = (state[key] ?? 0) + 1
            return new Response("marked")
          }
          const field =
            kind === "password"
              ? "<input type='password' aria-label='Frame secret' value='private-input-value'"
              : "<input aria-label='Frame plain'"
          return new Response(
            `<!doctype html><title>Remote frame</title>${field} onkeydown="fetch('http://127.0.0.1:'+location.port+'/keydown-'+event.key+'-marker',{mode:'no-cors'})">`,
            { headers: { "content-type": "text/html", "access-control-allow-origin": "*" } },
          )
        },
      })
    const passwordFrame = frameServer("password")
    const plainFrame = frameServer("plain")
    const shell = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/shadow-keydown-marker") {
          state.shadowKeydown = (state.shadowKeydown ?? 0) + 1
          return new Response("marked")
        }
        if (url.pathname === "/shadow")
          return new Response(
            `<!doctype html><title>Closed shadow</title><input aria-label="Start"><div id="shadow-host"></div><script>
              const root = document.getElementById('shadow-host').attachShadow({ mode: 'closed' })
              root.innerHTML = "<input aria-label='Closed shadow field'>"
              root.firstChild.addEventListener('keydown', (event) => {
                if (event.key !== 'Tab') fetch('/shadow-keydown-marker')
              })
            </script>`,
            { headers: { "content-type": "text/html" } },
          )
        return new Response(
          `<!doctype html><title>Cross frame</title><input aria-label="Start"><button aria-label="Add frame" onclick="addFrame()">Add frame</button><div id="slot"></div><script>
            function addFrame() {
              const frame = document.createElement('iframe')
              frame.src = new URLSearchParams(location.search).get('frame')
              document.getElementById('slot').append(frame)
            }
          </script>`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${shell.port}`
    const crossSite = (server: { readonly port?: number }) => `http://localhost:${server.port}`
    const sameSite = (server: { readonly port?: number }) => `http://127.0.0.1:${server.port}`
    type KeyExit = Exit.Exit<unknown, IsolatedBrowserExecutor.Error>
    type KeyModifiers = Parameters<typeof keyAction>[1]
    const scenario = async (
      path: string,
      frame: { readonly origin: string } | undefined,
      keyApproved: ReadonlyArray<string>,
      run: (key: (value: string, modifiers?: KeyModifiers) => Promise<KeyExit>) => Promise<void>,
    ) => {
      const runtime = await launch(`${origin}${path}`)
      try {
        const loadOrigins = frame ? [origin, frame.origin] : [origin]
        const ref = async (name: string) => requireElement(await Effect.runPromise(runtime.observe), name).ref
        if (frame) {
          await Effect.runPromise(runtime.action({ type: "click", ref: await ref("Add frame") }, loadOrigins))
          await Bun.sleep(800)
        } else await Effect.runPromise(runtime.action({ type: "click", ref: await ref("Start") }, loadOrigins))
        const key = (value: string, modifiers?: KeyModifiers) =>
          Effect.runPromiseExit(runtime.action(keyAction(value, modifiers), [origin, ...keyApproved]))
        expect(Exit.isSuccess(await key("Tab")), `${path} Tab`).toBe(true)
        await run(key)
      } finally {
        await Effect.runPromise(runtime.close)
      }
    }
    const refuses = async (key: (value: string, modifiers?: KeyModifiers) => Promise<KeyExit>, label: string) => {
      for (const [chord, modifiers] of editingKeys) {
        const exit = await key(chord, modifiers)
        expectFailurePhase(exit, "predispatch", `${label} ${(modifiers ?? []).join("+")}+${chord}`)
        if (Exit.isFailure(exit)) expect(messageOf(Cause.squash(exit.cause)), label).toContain("sensitive field")
      }
    }
    try {
      const passwordURL = `/cross?frame=${encodeURIComponent(crossSite(passwordFrame))}`
      const passwordOrigin = { origin: crossSite(passwordFrame) }
      await scenario(passwordURL, passwordOrigin, [passwordOrigin.origin], (key) => refuses(key, "approved cross-origin password frame"))
      await scenario(passwordURL, passwordOrigin, [], (key) => refuses(key, "unapproved cross-origin password frame"))

      const plainURL = `/cross?frame=${encodeURIComponent(crossSite(plainFrame))}`
      const plainOrigin = { origin: crossSite(plainFrame) }
      await scenario(plainURL, plainOrigin, [], (key) => refuses(key, "unapproved cross-origin plain frame"))
      await scenario(plainURL, plainOrigin, [plainOrigin.origin], (key) =>
        refuses(key, "approved cross-origin plain frame without an inspectable session"),
      )

      const sameSiteURL = `/cross?frame=${encodeURIComponent(sameSite(plainFrame))}`
      const sameSiteOrigin = { origin: sameSite(plainFrame) }
      await scenario(sameSiteURL, sameSiteOrigin, [sameSiteOrigin.origin], (key) =>
        refuses(key, "same-site cross-origin frame without a session"),
      )

      await scenario("/shadow", undefined, [], (key) => refuses(key, "closed shadow root"))
      await Bun.sleep(300)
      for (const marker of editingKeys.map(([key]) => key)) {
        expect(state[`password/keydown-${marker}-marker`] ?? 0, marker).toBe(0)
        expect(state[`plain/keydown-${marker}-marker`] ?? 0, marker).toBe(0)
      }
      expect(state.shadowKeydown ?? 0).toBe(0)
    } finally {
      await shell.stop(true)
      await passwordFrame.stop(true)
      await plainFrame.stop(true)
    }
  }, 120_000)
  test("allows only safe navigation on password and file fields and allows editing ordinary inputs", async () => {
    const events: string[] = []
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/event") {
          events.push(url.searchParams.get("field") ?? "")
          return new Response("marked")
        }
        return new Response(
          `<!doctype html><title>Editing policy</title>
            <input aria-label="Start">
            <input id="password" type="password" value="synthetic-secret">
            <input id="file" type="file">
            <input id="ordinary" aria-label="Ordinary" value="abc">
            <script>
              for (const field of document.querySelectorAll('[id]')) {
                field.addEventListener('keydown', () => fetch('/event?field=' + field.id))
                field.addEventListener('focus', () => fetch('/event?field=focus-' + field.id))
              }
            </script>`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const runtime = await launch(`${origin}/keys`)
    const key = (value: string, modifiers?: Parameters<typeof keyAction>[1]) =>
      Effect.runPromiseExit(runtime.action(keyAction(value, modifiers), [origin]))
    const allowed = async (value: string, modifiers?: Parameters<typeof keyAction>[1]) => {
      const exit = await key(value, modifiers)
      expect(Exit.isSuccess(exit), `${(modifiers ?? []).join("+")}+${value}`).toBe(true)
    }
    try {
      const start = requireElement(await Effect.runPromise(runtime.observe), "Start")
      await Effect.runPromise(runtime.action({ type: "click", ref: start.ref }, [origin]))
      await allowed("Tab")
      await waitFor(() => events.includes("focus-password"), "password focus")
      await allowed("Tab", ["Shift"])
      await allowed("Tab")
      for (const field of ["password", "file"]) {
        await waitFor(() => events.includes(`focus-${field}`), `${field} focus`)
        for (const navigation of ["Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"])
          await allowed(navigation)
        const before = events.filter((event) => event === field).length
        for (const [value, modifiers] of editingKeys) {
          const exit = await key(value, modifiers)
          expectFailurePhase(exit, "predispatch", `${field} ${(modifiers ?? []).join("+")}+${value}`)
        }
        expect(events.filter((event) => event === field).length, field).toBe(before)
        await allowed("Tab")
      }
      await waitFor(() => events.includes("focus-ordinary"), "ordinary input focus")
      await allowed("a", ["Control"])
      await allowed("q")
      expect(requireElement(await Effect.runPromise(runtime.observe), "Ordinary").value).toBe("q")
      await allowed("Backspace")
      expect(requireElement(await Effect.runPromise(runtime.observe), "Ordinary").value ?? "").toBe("")
      for (const [value, modifiers] of editingKeys) await allowed(value, modifiers)
      expect(events.filter((event) => event === "ordinary").length).toBe(editingKeys.length + 3)
    } finally {
      await Effect.runPromise(runtime.close)
      await fixture.stop(true)
    }
  }, 60_000)
})

async function launch(url: string) {
  return Effect.runPromise(launchEffect(url))
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

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : ""
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
  const processList = Bun.spawn(["ps", "-axo", "pid=,pgid=,command="], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(processList.stdout).text()
  if ((await processList.exited) !== 0) throw new Error("Failed to inspect owned Chrome processes")
  return output.split("\n").filter((line) => line.includes(root))
}

function processID(line: string) {
  const value = Number(line.trim().split(/\s+/, 1)[0])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid owned Chrome process ID")
  return value
}

function processGroupID(line: string) {
  const value = Number(line.trim().split(/\s+/, 2)[1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid owned Chrome process group ID")
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
      "--use-mock-keychain",
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
  expect(version.product).toMatch(/^Chrome\/\d+\./)
  expect(Number(/^Chrome\/(\d+)\./.exec(String(version.product))?.[1])).toBeGreaterThanOrEqual(152)
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

function formFixture() {
  return `<!doctype html><title>Form fixture</title>
    <input aria-label="Full name" id="name">
    <textarea aria-label="Notes"></textarea>
    <div contenteditable="true" role="textbox" aria-label="Rich note"></div>
    <input type="range" min="0" max="10" aria-label="Volume">
    <input type="date" aria-label="Birthday"><input type="time" aria-label="Alarm"><input type="datetime-local" aria-label="Meeting">
    <input type="month" aria-label="Billing month"><input type="week" aria-label="Review week"><input type="color" aria-label="Accent">
    <select aria-label="Colour"><option value="r">Red</option><option value="g">Green</option><option value="b" disabled>Blue</option></select>
    <select aria-label="Toppings" multiple><option value="a">Almond</option><option value="c">Cherry</option><option value="p">Pecan</option></select>
    <input type="checkbox" aria-label="Subscribe" onclick="fetch('/subscribe-click-marker')">
    <input type="radio" name="size" aria-label="Small"><input type="radio" name="size" aria-label="Large">
    <button role="switch" aria-checked="false" aria-label="Dark mode" onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))"></button>
    <div role="listbox" aria-label="Fruit">
      <div role="option" aria-selected="true" tabindex="0" onclick="pick(this)">Apple</div>
      <div role="option" aria-selected="false" tabindex="0" onclick="pick(this)">Banana</div>
    </div>
    <div role="combobox" aria-expanded="false" aria-label="Menu combo" tabindex="0"></div>
    <button aria-label="Hover target" onmouseover="document.getElementById('menu').hidden = false" onclick="fetch('/hover-click-marker')">Hover target</button>
    <ul id="menu" hidden><li><button>Revealed</button></li></ul>
    <script>function pick(option) { fetch('/pick-' + option.textContent + '-marker'); for (const item of option.parentElement.children) item.setAttribute('aria-selected', String(item === option)) }</script>`
}

const editingKeys = [
  ["a", undefined],
  [" ", undefined],
  ["Space", undefined],
  ["Enter", undefined],
  ["Backspace", undefined],
  ["Delete", undefined],
  ["Insert", undefined],
  ["a", ["Shift"]],
  ["a", ["Alt"]],
  ["v", ["Meta"]],
  ["v", ["Control"]],
  ["Insert", ["Shift"]],
  ["a", ["Control"]],
  ["a", ["Meta"]],
  ["c", ["Meta"]],
  ["x", ["Control"]],
  ["x", ["Meta"]],
  ["ArrowLeft", ["Shift"]],
  ["Home", ["Alt"]],
  ["Enter", ["Control"]],
] as const

function keyAction(key: string, modifiers?: ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift">): Browser.Schema.Action {
  return { type: "key", key, ...(modifiers ? { modifiers: [...modifiers] } : {}) }
}

function keyFixture() {
  return `<!doctype html><title>Key fixture</title>
    <input aria-label="Start" onkeydown="fetch('/keydown-'+event.key+'-marker')" oninput="fetch('/input-ok-marker')">
    <input type="password" aria-label="Account secret" value="private-input-value" onkeydown="fetch('/keydown-'+event.key+'-marker')" oninput="fetch('/input-secret-marker')">
    <label for="by-label">Password by label</label><input id="by-label" type="text" value="private-input-value" onkeydown="fetch('/keydown-'+event.key+'-marker')" oninput="fetch('/input-secret-marker')">
    <input aria-label="Plain after" onkeydown="fetch('/keydown-'+event.key+'-marker')" oninput="fetch('/input-ok-marker')">
    <div id="host"></div>
    <iframe src="/key-frame"></iframe>
    <script>
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML = "<input type='password' aria-label='Shadow secret'>"
      root.firstChild.addEventListener('keydown', (event) => fetch('/keydown-' + event.key + '-marker'))
      root.firstChild.addEventListener('input', () => fetch('/input-secret-marker'))
    </script>`
}

function sensitiveFixture() {
  return `<!doctype html><title>Sensitive fixture</title>
    <input type="password" aria-label="Account secret" value="private-input-value" oninput="fetch('/typed-marker')">
    <label for="by-label">Password by label</label><input id="by-label" type="text" value="private-input-value" oninput="fetch('/typed-marker')">
    <span id="code-label">One-time code</span><input type="text" aria-labelledby="code-label" value="private-input-value" oninput="fetch('/typed-marker')">
    <input type="text" aria-label="Card" autocomplete="cc-number" value="private-input-value" oninput="fetch('/typed-marker')">
    <input type="text" aria-label="Security" name="cvv" value="private-input-value" oninput="fetch('/typed-marker')">
    <input type="text" aria-label="Recovery" placeholder="Enter your passphrase" value="private-input-value" oninput="fetch('/typed-marker')">
    <input type="text" aria-label="Nickname" value="visible-value" oninput="fetch('/typed-marker')">`
}

function waitFixture() {
  return `<!doctype html><title>Wait fixture</title>
    <h1>Wait fixture</h1>
    <button id="temp">Temp</button>
    <button id="gone">Gone</button>
    <p id="status">Pending</p>
    <iframe src="/waits-frame"></iframe>
    <script>
      async function sync() {
        const flags = await (await fetch('/state')).json()
        if (flags.late && !document.getElementById('late')) {
          const button = document.createElement('button')
          button.id = 'late'
          button.textContent = 'Late button'
          document.body.append(button)
        }
        document.getElementById('temp').hidden = Boolean(flags.temp)
        if (flags.gone) document.getElementById('gone')?.remove()
        document.getElementById('status').textContent = flags.text ? 'Order complete' : 'Pending'
        if (flags.url && location.pathname !== '/waits/done') history.replaceState(null, '', '/waits/done?step=1')
        setTimeout(sync, 50)
      }
      sync()
    </script>`
}

function loadingFixture() {
  return `<!doctype html><title>Loading fixture</title><p>Loading</p><img src="/hang" alt="Slow image">`
}

function idleFixture(script: string) {
  return `<!doctype html><title>Idle fixture</title><p>Idle fixture</p><script>${script}</script>`
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
  // Classic scrollbars shrink the noise area below 1 MiB; force their geometry so hidden overflow is regression-tested.
  return `<!doctype html><title>Preparing oversized capture</title><style>html,body{margin:0;overflow:hidden}canvas{display:block}::-webkit-scrollbar{width:15px;height:15px}</style>
    <canvas width="800" height="600"></canvas><script>
      const canvas=document.querySelector('canvas');const context=canvas.getContext('2d');const image=context.createImageData(800,600);
      for(let offset=0;offset<image.data.length;offset+=65536)crypto.getRandomValues(image.data.subarray(offset,Math.min(offset+65536,image.data.length)));
      for(let index=3;index<image.data.length;index+=4)image.data[index]=255;
      context.putImageData(image,0,0);document.title='Oversized capture ready'
    </script>`
}
