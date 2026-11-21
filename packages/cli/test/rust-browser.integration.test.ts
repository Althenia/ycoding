import { expect, test } from "bun:test"
import { YCoding, type V5Client } from "@ycoding-ai/client/v5"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import { connect, type Client } from "../../core/src/browser/isolated-cdp"
import { BrowserExtension } from "../src/assets"
import { copyChromeExtension } from "../script/chrome-extension"
import {
  PRIVATE_MARKER,
  captureSmokeOutput,
  isolatedBrowserSmokeEnvironment,
  stopSmokeRuntime,
} from "../script/isolated-browser-smoke"

const mode = process.env.YCODING_TEST_RUST_BROWSER_MODE
if (mode !== undefined && mode !== "source" && mode !== "packaged")
  throw new Error("YCODING_TEST_RUST_BROWSER_MODE must be source or packaged")
const scenario = mode ? test : test.skip

const sourceExtension = resolve(import.meta.dir, "../../../extensions/chrome")
const crossSiteMarker = "synthetic-cross-site-private-marker"
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

for (const variant of ["source", "bundled"] as const) {
  scenario(
    `${mode ?? "opt-in"} runtime pairs the ${variant} Chrome extension for owned and profile tab flows`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ycoding-rust-browser-"))
      try {
        const extension = variant === "source" ? sourceExtension : await bundledExtension(root)
        await run(root, extension)
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    100_000,
  )
}

async function bundledExtension(root: string) {
  if (mode === "packaged") {
    const binary = process.env.YCODING_TEST_PACKAGED_CLI
    if (!binary) throw new Error("YCODING_TEST_PACKAGED_CLI must name the packaged native ycoding executable")
    const packaged = join(dirname(resolve(binary)), BrowserExtension.directory)
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: packaged }))).sort()
    expect(files).toEqual([...BrowserExtension.files].sort())
    return packaged
  }
  const bin = join(root, "bin")
  await copyChromeExtension(bin)
  return join(bin, BrowserExtension.directory)
}

async function run(root: string, extension: string) {
  const chrome = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
  if (!chrome) throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to an installed Chrome for Testing executable")
  if (!(await Bun.file(chrome).exists())) throw new Error("Chrome for Testing executable is unavailable")
  const project = join(root, "project")
  await mkdir(project)

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  const owner = `ses_rust_browser_owner_${suffix}`
  const other = `ses_rust_browser_other_${suffix}`
  const created: string[] = []
  const seen: string[] = []
  const keep = <A>(value: A) => {
    seen.push(JSON.stringify(value))
    return value
  }
  const call = (name: string) => `${name}-${suffix}`

  let redirectLoads = 0
  const submissions: string[] = []
  const ownedClicks: string[] = []
  const crossOrigin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(crossSiteMarker),
  })
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/redirect") {
        redirectLoads++
        return Response.redirect(`http://127.0.0.1:${crossOrigin.port}/forbidden`)
      }
      if (url.pathname === "/owned-clicked") {
        ownedClicks.push(url.searchParams.get("visibility") ?? "")
        return new Response("recorded")
      }
      if (url.pathname === "/submitted") {
        submissions.push(url.searchParams.get("value") ?? "")
        return new Response("recorded")
      }
      const page = (body: string, title: string) =>
        new Response(`<!doctype html><title>${title}</title>${body}`, { headers: { "content-type": "text/html" } })
      if (url.pathname === "/foreground")
        return page(
          `<input aria-label='Message'><input aria-label='Private' value='${PRIVATE_MARKER}'><button aria-label='Submit' onclick="fetch('/submitted?value='+encodeURIComponent(document.querySelector('input').value))">Submit</button>`,
          "Foreground fixture",
        )
      if (url.pathname === "/fixture")
        return page(
          `<button aria-label='Fixture button' onclick="fetch('/owned-clicked?visibility='+document.visibilityState)">OK</button>`,
          "Private fixture",
        )
      return page(`<p>${url.pathname}</p>`, "Profile fixture")
    },
  })
  const origin = `http://127.0.0.1:${fixture.port}`

  let runtime: Runtime | undefined
  let client: V5Client | undefined
  let chromeProcess: ReturnType<typeof spawn> | undefined
  let cdp: Client | undefined
  let completed = false
  try {
    runtime = await startRuntime(root, project)
    const api = YCoding.make({
      endpoint: { url: runtime.url, ...(runtime.password ? { auth: basic(runtime.password) } : {}) },
      location: { directory: project },
    })
    client = api
    for (const sessionID of [owner, other]) {
      const session = await api.session.create({ id: sessionID, location: { directory: project } })
      created.push(sessionID)
      expect(session.id).toBe(sessionID)
    }

    expect((await api.browser.status({ sessionID: owner })).state).toBe("unavailable")
    const pairing = await api.browser.start({ sessionID: owner })
    expect(pairing.secret.length).toBeGreaterThanOrEqual(32)

    chromeProcess = spawn(
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
        "--disable-breakpad",
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "about:blank",
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    )
    const readable = chromeProcess.stdio[4]
    const writable = chromeProcess.stdio[3]
    if (!(readable instanceof Readable) || !(writable instanceof Writable))
      throw new Error("Chrome for Testing did not expose its control pipe")
    const browser = connect(readable, writable)
    cdp = browser
    const version = record(await browser.send("Browser.getVersion"))
    expect(Number(/^Chrome\/(\d+)\./.exec(String(version.product))?.[1])).toBeGreaterThanOrEqual(152)
    await browser.send("Target.setDiscoverTargets", { discover: true })
    const worker = await eventually(async () => {
      const infos = record(await browser.send("Target.getTargets")).targetInfos
      return Array.isArray(infos)
        ? infos
            .map(record)
            .find(
              (info) =>
                info.type === "service_worker" &&
                /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/.test(String(info.url)),
            )
        : undefined
    }, "extension service worker")
    const extensionID = /^chrome-extension:\/\/([a-p]{32})\//.exec(string(worker.url))?.[1]
    if (!extensionID) throw new Error("Extension identity unavailable")
    const workerSession = await attach(browser, string(worker.targetId))
    await browser.send("Runtime.enable", {}, workerSession)
    const popup = record(
      await browser.send("Target.createTarget", { url: `chrome-extension://${extensionID}/popup.html` }),
    )
    const popupSession = await attach(browser, string(popup.targetId))
    await browser.send("Runtime.enable", {}, popupSession)
    await eventually(
      async () =>
        (await evaluate(browser, popupSession, "typeof chrome === 'object' && !!chrome.runtime?.sendMessage")) === true
          ? true
          : undefined,
      "extension popup",
    )
    await eventually(
      async () =>
        (await evaluate(
          browser,
          popupSession,
          "document.querySelector('#connection-state')?.textContent === 'Disconnected' && !document.querySelector('#pairing-view')?.hidden",
        )) === true
          ? true
          : undefined,
      "popup initial pairing view",
    )
    const loadedManifest = record(await evaluate(browser, popupSession, "chrome.runtime.getManifest()"))
    const diskManifest = record(JSON.parse(await readFile(join(extension, "manifest.json"), "utf8")))
    expect(loadedManifest.name).toBe("YCoding")
    expect(loadedManifest.version).toBe(diskManifest.version)

    const existing = number(
      record(
        await evaluate(
          browser,
          popupSession,
          `chrome.tabs.create({url:${JSON.stringify(`${origin}/profile-existing`)},active:false})`,
        ),
      ).id,
    )
    await eventually(async () => {
      const native = record(await evaluate(browser, popupSession, `chrome.tabs.get(${existing})`))
      return native.url === `${origin}/profile-existing` && native.status === "complete" ? true : undefined
    }, "loaded existing tab before pairing")

    expect(
      await evaluate(
        browser,
        popupSession,
        `chrome.runtime.sendMessage({type:'pair',serverURL:${JSON.stringify(runtime.url)},secret:${JSON.stringify(pairing.secret)}})`,
      ),
    ).toMatchObject({ paired: true, connected: true, profileGranted: true })
    const status = await eventually(async () => {
      const current = keep(await api.browser.status({ sessionID: owner }))
      return current.state === "connected" ? current : undefined
    }, "connected bridge status")
    expect(status.profileGranted).toBe(true)
    if (status.generation === undefined) throw new Error("Connected bridge reported no generation")
    const generation = status.generation
    await eventually(
      async () =>
        (await evaluate(
          browser,
          popupSession,
          "document.querySelector('#connection-state')?.textContent === 'Connected' && document.querySelector('#pairing-view')?.hidden && document.querySelector('#forget')?.hidden === false",
        )) === true
          ? true
          : undefined,
      "popup connected view",
    )

    const foreground = record(await browser.send("Target.createTarget", { url: `${origin}/foreground` }))
    await browser.send("Target.activateTarget", { targetId: string(foreground.targetId) })
    const activeBefore = await activeTabIDs(browser, workerSession)
    expect(activeBefore).toHaveLength(1)

    const futureID = number(
      record(
        await evaluate(
          browser,
          popupSession,
          `chrome.tabs.create({url:${JSON.stringify(`${origin}/profile-future`)},active:false})`,
        ),
      ).id,
    )
    const inventory = await eventually(async () => {
      const listed = keep(await api.browser.tabs({ sessionID: other }))
      return ["/profile-existing", "/profile-future", "/foreground"].every((path) =>
        listed.some((tab) => tab.mode === "profile" && tab.page.path === path),
      )
        ? listed
        : undefined
    }, "automatic profile inventory")
    expect(inventory.every((tab) => tab.mode === "profile" && tab.status === "shared")).toBe(true)
    const countBefore = await tabCount(browser, workerSession)
    const foregroundTab = inventory.find((tab) => tab.page.path === "/foreground")!
    const existingTab = inventory.find((tab) => tab.page.path === "/profile-existing")!
    expect(inventory.find((tab) => tab.page.path === "/profile-future")?.page.origin).toBe(origin)

    const foregroundObserved = keep(
      await api.browser.observe({
        sessionID: other,
        tabID: foregroundTab.id,
        generation: foregroundTab.generation,
        callID: call("foreground-read"),
      }),
    )
    expect(foregroundObserved.elements).toContainEqual(expect.objectContaining({ role: "button", name: "Submit" }))
    const messageInput = foregroundObserved.elements.find((element) => element.name === "Message")
    if (!messageInput) throw new Error("Foreground input was not observed")
    const staleSubmit = foregroundObserved.elements.find((element) => element.name === "Submit")
    if (!staleSubmit) throw new Error("Foreground submit button was not observed")
    const act = async (
      sessionID: string,
      tab: { id: string; generation: number },
      observation: { documentGeneration: number; revision: number },
      action: Parameters<V5Client["browser"]["action"]>[0]["action"],
      name: string,
    ) =>
      keep(
        await api.browser.action({
          sessionID,
          tabID: tab.id,
          generation: tab.generation,
          documentGeneration: observation.documentGeneration,
          observationRevision: observation.revision,
          callID: call(name),
          action,
        }),
      )
    const typed = await act(
      other,
      foregroundTab,
      foregroundObserved,
      { type: "type", ref: messageInput.ref, text: "synthetic-value" },
      "foreground-type",
    )
    expect(typed).toMatchObject({ status: "completed", callID: call("foreground-type") })
    expect(typed.tab.id).toBe(foregroundTab.id)
    expect(
      await category(
        act(other, foregroundTab, foregroundObserved, { type: "click", ref: staleSubmit.ref }, "foreground-stale"),
      ),
    ).toBe("conflict")
    expect(submissions).toEqual([])
    const afterType = keep(
      await api.browser.observe({
        sessionID: other,
        tabID: foregroundTab.id,
        generation: foregroundTab.generation,
        callID: call("foreground-after-type"),
      }),
    )
    expect(afterType.revision).toBeGreaterThan(foregroundObserved.revision)
    const submit = afterType.elements.find((element) => element.name === "Submit")
    if (!submit) throw new Error("Foreground button was not observed")
    expect(
      (await act(other, foregroundTab, afterType, { type: "click", ref: submit.ref }, "foreground-click")).status,
    ).toBe("completed")
    await eventually(async () => (submissions.length >= 1 ? true : undefined), "foreground fixture submit")
    expect(submissions).toEqual(["synthetic-value"])
    expect(
      (await act(other, foregroundTab, afterType, { type: "scroll", deltaY: 20 }, "foreground-scroll")).status,
    ).toBe("completed")
    const captured = await act(other, foregroundTab, afterType, { type: "capture" }, "foreground-capture")
    expect(captured.status).toBe("completed")
    expect(captured.capture?.mediaType).toBe("image/png")
    expect([...Buffer.from(captured.capture?.data ?? "", "base64").subarray(0, 8)]).toEqual(pngSignature)
    expect(captured.capture?.bytes).toBeGreaterThan(0)
    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)

    const opened = keep(
      await api.browser.open({
        sessionID: owner,
        generation,
        url: `${origin}/fixture?private=${PRIVATE_MARKER}`,
        callID: call("owned-open"),
      }),
    )
    expect(opened).toMatchObject({
      sessionID: owner,
      mode: "owned",
      status: "shared",
      page: { origin, path: "/fixture" },
    })
    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)
    expect(await tabCount(browser, workerSession)).toBe(countBefore + 1)
    expect((await api.browser.tabs({ sessionID: other })).every((tab) => tab.mode !== "owned")).toBe(true)
    expect(
      await category(
        api.browser.observe({
          sessionID: other,
          tabID: opened.id,
          generation: opened.generation,
          callID: call("foreign-read"),
        }),
      ),
    ).toBe("forbidden")
    const ownedObserved = keep(
      await api.browser.observe({
        sessionID: owner,
        tabID: opened.id,
        generation: opened.generation,
        callID: call("owned-observe"),
      }),
    )
    const fixtureButton = ownedObserved.elements.find((element) => element.name === "Fixture button")
    expect(fixtureButton).toMatchObject({ role: "button" })
    if (!fixtureButton) throw new Error("Owned button was not observed")
    const ownedClick = await act(owner, opened, ownedObserved, { type: "click", ref: fixtureButton.ref }, "owned-click")
    expect(ownedClick.status).toBe("completed")
    expect(ownedClick).not.toHaveProperty("input")
    await eventually(async () => (ownedClicks.length >= 1 ? true : undefined), "background owned click")
    expect(ownedClicks).toEqual(["visible"])
    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)
    expect(
      await category(act(owner, opened, ownedObserved, { type: "navigate", url: "file:///private" }, "owned-unsafe")),
    ).toBe("conflict")
    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)
    await api.browser.close({
      sessionID: owner,
      tabID: opened.id,
      generation: opened.generation,
      callID: call("owned-close"),
    })
    await eventually(
      async () => ((await tabCount(browser, workerSession)) === countBefore ? true : undefined),
      "owned tab close",
    )
    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)

    const redirected = await category(
      api.browser.open({ sessionID: owner, generation, url: `${origin}/redirect`, callID: call("owned-redirect") }),
    )
    expect(redirected).toBe("invalid")
    expect(redirectLoads).toBe(1)
    await eventually(
      async () => ((await tabCount(browser, workerSession)) === countBefore ? true : undefined),
      "redirected tab revocation",
    )
    expect((await api.browser.tabs({ sessionID: owner })).every((tab) => tab.mode !== "owned")).toBe(true)
    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)

    expect(await debuggerAttached(browser, workerSession, existing)).toBe(false)
    keep(
      await api.browser.observe({
        sessionID: other,
        tabID: existingTab.id,
        generation: existingTab.generation,
        callID: call("profile-observe"),
      }),
    )
    expect(await debuggerAttached(browser, workerSession, existing)).toBe(true)
    expect(await evaluate(browser, popupSession, `chrome.action.getBadgeText({tabId:${existing}})`)).toBe("ON")
    await api.browser.forget({ sessionID: other })
    await eventually(async () => {
      const state = record(await evaluate(browser, popupSession, "chrome.runtime.sendMessage({type:'status'})"))
      return state.paired === false && state.connected === false ? true : undefined
    }, "extension pairing forgotten")
    expect(await evaluate(browser, popupSession, `chrome.action.getBadgeText({tabId:${existing}})`)).toBe("")
    expect(await debuggerAttached(browser, workerSession, existing)).toBe(false)
    expect((await api.browser.status({ sessionID: owner })).state).toBe("unavailable")
    expect((await api.browser.tabs({ sessionID: other })).filter((tab) => tab.mode === "profile")).toEqual([])
    expect(await tabIDs(browser, workerSession)).toEqual(expect.arrayContaining([existing, futureID]))
    await api.browser.stop({ sessionID: owner })

    expect(await activeTabIDs(browser, workerSession)).toEqual(activeBefore)
    expect(submissions).toEqual(["synthetic-value"])
    expect(ownedClicks).toEqual(["visible"])
    const disclosed = seen.join("\n")
    for (const secret of [PRIVATE_MARKER, crossSiteMarker, pairing.secret]) expect(disclosed).not.toContain(secret)

    for (const sessionID of created.splice(0)) await api.session.remove({ sessionID })
    expect(await category(api.browser.status({ sessionID: owner }))).toBe("sessionnotfound")
    completed = true
  } finally {
    const failures: unknown[] = []
    const attempt = async (cleanup: () => unknown) => {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    await attempt(async () => {
      if (cdp) {
        await cdp.send("Browser.close").catch(() => {})
        cdp.close()
      }
    })
    await attempt(() => chromeProcess && terminate(chromeProcess))
    await attempt(async () => {
      for (const sessionID of created) await client?.session.remove({ sessionID })
    })
    await attempt(() => client?.transport.close())
    await attempt(() => runtime?.stop())
    await attempt(() => fixture.stop(true))
    await attempt(() => crossOrigin.stop(true))
    if (completed && failures.length) throw new AggregateError(failures, "Rust browser acceptance cleanup failed")
  }
}

type Runtime = { url: string; password?: string; stop(): Promise<void> }

async function startRuntime(root: string, project: string): Promise<Runtime> {
  if (mode === "source") {
    const url = process.env.YCODING_V5_TEST_URL
    if (!url)
      throw new Error(
        "YCODING_V5_TEST_URL must name a disposable Rust runtime; run through rust/crates/runtime/tests/support/ready-runtime.ts",
      )
    return { url: new URL(url).origin, password: process.env.YCODING_V5_TEST_PASSWORD, stop: async () => {} }
  }
  const binary = process.env.YCODING_TEST_PACKAGED_CLI
  if (!binary) throw new Error("YCODING_TEST_PACKAGED_CLI must name the packaged native ycoding executable")
  if (!(await Bun.file(binary).exists())) throw new Error("Packaged ycoding executable is unavailable")
  await Promise.all(
    ["home", "config", "data", "cache", "state", "tmp"].map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  )
  const environment = isolatedBrowserSmokeEnvironment(root)
  const child = Bun.spawn([resolve(binary), "serve", "--stdio", "--port", "0"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: project,
    env: environment,
  })
  const stdout = captureSmokeOutput(child.stdout)
  const stderr = captureSmokeOutput(child.stderr)
  const stop = async () => {
    await stopSmokeRuntime(child)
    await Promise.all([stdout.done, stderr.done])
    if (stdout.leaked() || stderr.leaked()) throw new Error("Packaged runtime logs disclosed a private marker")
  }
  try {
    const ready = record(JSON.parse(await stdout.firstLine))
    const base = new URL(string(ready.url))
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(base.hostname) ||
      base.username ||
      base.password
    )
      throw new Error("Packaged runtime did not advertise a credential-free loopback HTTP endpoint")
    return { url: base.origin, password: environment.YCODING_PASSWORD, stop }
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}

function basic(password: string) {
  return { type: "basic" as const, username: "ycoding", password }
}

async function category(call: Promise<unknown>) {
  const error = await call.then(
    () => {
      throw new Error("Expected the call to be rejected")
    },
    (rejected: unknown) => rejected,
  )
  if (typeof error !== "object" || error === null || !("_tag" in error) || typeof error._tag !== "string")
    throw new Error(`Expected a typed rejection, received ${String(error)}`)
  if (error._tag === "V5ClientError")
    throw new Error(`Expected a typed rejection, received a transport failure: ${error.constructor.name}`)
  if (JSON.stringify(error).includes(crossSiteMarker)) throw new Error("Rejection disclosed other-site content")
  if (error._tag === "InvalidRequestError")
    return "kind" in error && typeof error.kind === "string" ? error.kind : "invalid"
  return error._tag.replace(/Error$/, "").toLowerCase()
}

async function attach(cdp: Client, targetId: string) {
  return string(record(await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId)
}

async function evaluate(cdp: Client, sessionID: string, expression: string) {
  const result = record(
    await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionID),
  )
  if (result.exceptionDetails) throw new Error("Extension evaluation failed")
  return record(result.result).value
}

async function numbers(cdp: Client, sessionID: string, expression: string) {
  const value = await evaluate(cdp, sessionID, expression)
  if (!Array.isArray(value) || value.some((id) => typeof id !== "number"))
    throw new Error("Extension did not report tab IDs")
  return value.map(number)
}

const activeTabIDs = (cdp: Client, sessionID: string) =>
  numbers(cdp, sessionID, "chrome.tabs.query({active:true}).then(tabs=>tabs.map(tab=>tab.id))")
const tabIDs = (cdp: Client, sessionID: string) =>
  numbers(cdp, sessionID, "chrome.tabs.query({}).then(tabs=>tabs.map(tab=>tab.id))")
const tabCount = async (cdp: Client, sessionID: string) => (await tabIDs(cdp, sessionID)).length

async function debuggerAttached(cdp: Client, sessionID: string, tabID: number) {
  const value = await evaluate(
    cdp,
    sessionID,
    `chrome.debugger.getTargets().then(targets=>targets.find(target=>target.tabId===${tabID})?.attached)`,
  )
  if (typeof value !== "boolean") throw new Error("Chrome did not report debugger attachment")
  return value
}

async function eventually<A>(check: () => Promise<A | undefined>, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object response")
  return Object.fromEntries(Object.entries(value))
}

function string(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string")
  return value
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Expected an integer")
  return value
}

async function terminate(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = () =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  if (await exited()) return
  if (child.pid) process.kill(-child.pid, "SIGTERM")
  if (await exited()) return
  if (child.pid) process.kill(-child.pid, "SIGKILL")
  if (!(await exited())) throw new Error("Chrome for Testing process did not exit")
}
