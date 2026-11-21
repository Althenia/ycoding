import { expect, test } from "bun:test"
import { makeAuthority } from "@ycoding-ai/core/interaction/authority"
import { chromeConnectPath, chromeExtensionID, makeChromeTransport } from "@ycoding-ai/core/interaction/chrome"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { Schema } from "effect"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const chrome = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
const sampler = process.env.YCODING_TEST_FOCUS_SAMPLER
const artifacts = process.env.YCODING_TEST_INTERACTION_ARTIFACTS
const extension = resolve(import.meta.dir, "../../../../extensions/interaction-chrome")
const desktop = "live-desktop-passive"
const browserMode = "headless-isolated"
const measured = ["browser-ops", "script", "code", "two-tab", "opener", "second-session", "two-sessions", "dialog-script", "dialog-perform",
  "file-chooser", "stop", "revoke", "revoke-await"]
const dwellMs = 160
const markers = ["MARKER-B-TITLE", "MARKER-B-BODY", "MARKER-B-INPUT", "MARKER-B-LOG", "MARKER-B-COOKIE", "MARKER-B-STORAGE", "MARKER-B-URL",
  "MARKER-S-BODY", "MARKER-S-LOG", "MARKER-S-STORAGE", "MARKER-S-SESSION", "MARKER-S-TITLE", "owned-password", "owned-main-world"]

const FocusSample = Schema.Struct({
  t: Schema.Number,
  label: Schema.String,
  front: Schema.optional(Schema.NullOr(Schema.Struct({ pid: Schema.optional(Schema.Number), bundleID: Schema.optional(Schema.String) }))),
  cursor: Schema.optional(Schema.Unknown),
  focus: Schema.optional(Schema.NullOr(Schema.Struct({ appPID: Schema.optional(Schema.Number), window: Schema.optional(Schema.Unknown), element: Schema.optional(Schema.Unknown) }))),
  hidIdleSeconds: Schema.optional(Schema.Number),
})
type Sample = typeof FocusSample.Type
const CommandLog = Schema.Array(Schema.Struct({ tabId: Schema.optional(Schema.Number), method: Schema.String, kind: Schema.optional(Schema.String), phase: Schema.String }))
const Selected = Schema.Struct({ active: Schema.Unknown, focusedWindows: Schema.Unknown })
const TabIDs = Schema.Array(Schema.Number)
const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Targets = Schema.Struct({ targetInfos: Schema.Array(Schema.Struct({ targetId: Schema.String, type: Schema.String, url: Schema.String })) })
const Version = Schema.Struct({ webSocketDebuggerUrl: Schema.String })
const Reply = Schema.Struct({ id: Schema.optional(Schema.Number), method: Schema.optional(Schema.String), sessionId: Schema.optional(Schema.String), result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.Struct({ message: Schema.String })) })
const Evaluated = Schema.Struct({ result: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
  exceptionDetails: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String), exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })) })) })
const Attached = Schema.Struct({ sessionId: Schema.String })
const Screenshot = Schema.Struct({ data: Schema.String })
const Frame = Schema.Struct({ type: Schema.optional(Schema.String), id: Schema.optional(Schema.String), op: Schema.optional(Schema.String),
  deadline: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })
const PrivateState = Schema.Struct({ title: Schema.String, url: Schema.String, marker: Schema.String, html: Schema.Number, storage: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String), keys: Schema.Number, received: Schema.Array(Schema.String) })
type Peer = { url: string; origin: string | undefined; peerAddress: string | undefined }

test("Script and Code runs stay inside the granted background tab and never move focus", async () => {
  if (process.platform !== "darwin") throw new Error("The Interaction script E2E runs on macOS only")
  if (!chrome || !(await Bun.file(chrome).exists())) throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to the pinned Chrome for Testing executable")
  if (!sampler || !(await Bun.file(sampler).exists())) throw new Error("Set YCODING_TEST_FOCUS_SAMPLER to the built focus sampler")
  const directory = await mkdtemp(join(tmpdir(), "ycoding-interaction-script-"))
  const output = artifacts ?? join(directory, "artifacts")
  await mkdir(output, { recursive: true })
  const samplesFile = join(output, "focus-samples.jsonl")
  await rm(samplesFile, { force: true })
  const profile = join(directory, "profile")
  const wire: string[] = []
  const changes: unknown[] = []
  const confirms: unknown[] = []
  const owner = SessionID.create()
  const other = SessionID.create()
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => sitePage(new URL(request.url).pathname) })
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => foreignPage() })
  const siteOrigin = `http://127.0.0.1:${site.port}`
  const workURL = `${siteOrigin}/work`
  const foreignURL = `http://127.0.0.1:${foreign.port}/private?MARKER-B-URL=1`
  const reachURL = `http://127.0.0.1:${foreign.port}/private`
  const authority = makeAuthority({
    currentlyUsable: async () => true,
    sessionLabel: async (sessionID) => sessionID === owner ? "Script owner Session" : "Second Session",
    changed: (sessionID, generation) => changes.push({ sessionID, generation, status: authority.status(sessionID) }),
  })
  const transport = { current: undefined as ReturnType<typeof makeChromeTransport> | undefined }
  const sockets = { current: undefined as { send: (text: string) => number } | undefined }
  const server = Bun.serve<{ peer: Peer; channel?: { receive: (text: string) => Promise<void>; disconnect: () => void } }, string>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, current) {
      const url = new URL(request.url)
      const peer = { url: url.pathname, origin: request.headers.get("origin") ?? undefined, peerAddress: current.requestIP(request)?.address }
      if (url.pathname !== chromeConnectPath || !transport.current?.admit(peer)) return new Response(null, { status: 403 })
      return current.upgrade(request, { data: { peer } }) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        sockets.current = socket
        socket.data.channel = transport.current?.connect({
          ...socket.data.peer,
          send: (text) => {
            wire.push(`out ${text}`)
            socket.send(text)
            return true
          },
          close: (code) => socket.close(code),
        })
      },
      message(socket, message) {
        wire.push(`in ${String(message)}`)
        void socket.data.channel?.receive(String(message))
      },
      close(socket) {
        socket.data.channel?.disconnect()
      },
    },
  })
  transport.current = makeChromeTransport({
    origin: `http://127.0.0.1:${server.port}`,
    register: (driver) => authority.register(driver),
    confirm: async (input) => {
      confirms.push(input)
      return true
    },
    profiles: join(directory, "interaction-chrome-profiles.json"),
  })
  const focus = Bun.spawn([sampler, "--label", `${desktop}:launch`, "--interval-ms", "50"], { stdin: "pipe", stdout: Bun.file(samplesFile) })
  await Bun.sleep(300)
  const browser = Bun.spawn([chrome, "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
    "--no-default-browser-check", "--enable-unsafe-extension-debugging", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    "--window-size=1100,800", foreignURL], { stdout: "ignore", stderr: "ignore" })
  const guard = { running: true, violation: undefined as Sample | undefined }
  const watching = (async () => {
    while (guard.running) {
      const bad = readSamples(await Bun.file(samplesFile).text()).find((sample) => sample.front?.bundleID === "com.google.chrome.for.testing" ||
        sample.front?.pid === browser.pid || sample.focus?.appPID === browser.pid)
      if (bad) {
        guard.violation = bad
        browser.kill("SIGKILL")
        return
      }
      await Bun.sleep(50)
    }
  })()
  const note = (text: string) => appendFile(join(output, "progress.log"), `${new Date().toISOString()} [${desktop}/${browserMode}] ${text}\n`)
  const tabs = { label: `${browserMode}:launch`, samples: [] as { t: number; label: string; active: unknown; focusedWindows: unknown }[], running: true }
  const cdp = await connectBrowser(profile)
  const commands = { current: [] as (typeof CommandLog.Type)[number][] }
  try {
    const worker = await cdp.attach(await cdp.waitTarget((target) => target.type === "service_worker" &&
      target.url === `chrome-extension://${chromeExtensionID}/service-worker.js`))
    await cdp.waitFor(worker, `typeof chrome.debugger?.sendCommand === "function"`)
    expect(await cdp.evaluate(worker, recorder)).toBe(true)
    const sampleTabs = () => cdp.evaluate(worker, selectedTabs).then(Schema.decodeUnknownSync(Selected), () => ({ active: "unavailable", focusedWindows: [] }))
    const mark = async (label: string) => {
      void focus.stdin.write(`${desktop}:${label}\n`)
      tabs.label = `${browserMode}:${label}`
      tabs.samples.push({ t: Date.now(), label: tabs.label, ...(await sampleTabs()) })
    }
    const active = { phase: "setup" }
    const phase = async (name: string) => {
      if (measured.includes(active.phase)) {
        await mark(`${active.phase}:after`)
        await Bun.sleep(dwellMs)
      }
      if (measured.includes(name)) {
        await mark(`${name}:before`)
        await Bun.sleep(dwellMs)
      }
      await note(`phase ${name}`)
      await mark(name)
      active.phase = name
      await cdp.evaluate(worker, `globalThis.__ycodingInteractionPhase = ${JSON.stringify(name)}`)
    }
    const sampling = (async () => {
      while (tabs.running) {
        tabs.samples.push({ t: Date.now(), label: tabs.label, ...(await sampleTabs()) })
        await Bun.sleep(50)
      }
    })()
    const foreignTab = await cdp.waitTab((url) => url === foreignURL)
    await cdp.send("Target.createTarget", { url: `${siteOrigin}/same-origin-private`, background: true })
    await Bun.sleep(500)
    const popupURL = `chrome-extension://${chromeExtensionID}/popup.html`
    const popup = async (shot: string) => {
      const open = await cdp.waitTarget((target) => target.url === popupURL, 1).catch(() => undefined)
      if (open) await cdp.send("Target.closeTarget", { targetId: open })
      await cdp.send("Extensions.triggerAction", { id: chromeExtensionID, targetId: foreignTab })
      const session = await cdp.attach(await cdp.waitTarget((target) => target.url === popupURL))
      await cdp.waitFor(session, `document.querySelector("#status")?.innerText.trim().length > 0`)
      return { session, shot: (name: string) => cdp.screenshot(session, join(output, `${shot}-${name}.png`)) }
    }

    await phase("enroll")
    const enrolling = await popup("01-enroll")
    await enrolling.shot("before")
    await cdp.evaluate(enrolling.session, `(() => { document.querySelector("#advanced").open = true; const input = document.querySelector("input[name=address]");
      input.value = "http://127.0.0.1:${server.port}"; return true })()`)
    await cdp.click(enrolling.session, "#connect")
    await cdp.waitFor(enrolling.session, `/^Connected/.test(document.querySelector("#status").innerText)`)
    await enrolling.shot("connected")
    expect(confirms).toHaveLength(1)

    const grant = async (shot: string, session = owner, url = workURL) => {
      const pending = await authority.request(session, { platform: "chrome", mode: "owned", url })
      if (pending.state !== "pending") throw new Error(`grant request returned ${pending.state}`)
      const approval = await popup(shot)
      await cdp.waitFor(approval.session, `!!document.querySelector('#requests button[data-kind="approve"]')`)
      await approval.shot("approval")
      await cdp.click(approval.session, '#requests button[data-kind="approve"]')
      await until(() => authority.status(session).state === "active")
      await approval.shot("active")
      return pending.generation
    }
    await phase("grant")
    const generation = await grant("02-grant")
    const owned = await cdp.evaluate(worker, `chrome.tabs.query({ url: ${JSON.stringify(workURL)} }).then((tabs) => tabs.map((tab) => ({ id: tab.id, active: tab.active })))`)
    expect(owned).toEqual([{ id: expect.any(Number), active: false }])
    const user = await cdp.attach(await cdp.waitTarget((target) => target.type === "page" && target.url === workURL))
    await cdp.send("Page.enable", {}, user)
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, user)

    const run = async (request: Interaction.ScriptRequest, signal?: AbortSignal) => {
      const observed = await authority.observe(owner, generation)
      return authority.run(owner, generation, observed.revision, request, signal)
    }
    const act = async (label: string | undefined, action: (elementID: Interaction.ID | undefined) => Interaction.Action) => {
      const observed = await authority.observe(owner, generation)
      const element = observed.elements.find((item) => item.label === label)
      if (label !== undefined && !element) throw new Error(`${label} was not observed`)
      return authority.perform(owner, generation, observed.revision, Interaction.ID.create(), action(element?.id))
    }
    const element = (elementID: Interaction.ID | undefined) => {
      if (!elementID) throw new Error("missing element")
      return elementID
    }
    await phase("browser-ops")
    const operations = {
      click: await act("Continue", (elementID) => ({ platform: "chrome", type: "click", elementID: element(elementID) })),
      fill: await act("Note", (elementID) => ({ platform: "chrome", type: "fill", elementID: element(elementID), text: "background note" })),
      scroll: await act(undefined, () => ({ platform: "chrome", type: "scroll", deltaY: 400 })),
      state: await run({ mode: "script", source: "return { clicked: document.body.dataset.clicked, note: document.querySelector('#note').value, scrolled: scrollY > 0 }" }),
      navigate: await act(undefined, () => ({ platform: "chrome", type: "navigate", url: workURL })),
      reloaded: await run({ mode: "script", source: "return { clicked: document.body.dataset.clicked ?? null, scrolled: scrollY > 0 }" }),
    }
    expect(operations).toEqual({
      click: { outcome: "applied" },
      fill: { outcome: "applied" },
      scroll: { outcome: "applied" },
      state: { outcome: "completed", value: { clicked: "yes", note: "background note", scrolled: true }, logs: [] },
      navigate: { outcome: "applied" },
      reloaded: { outcome: "completed", value: { clicked: null, scrolled: false }, logs: [] },
    })

    await phase("script")
    const pagesBefore = await cdp.pages()
    const scoped = await run({ mode: "script", source: `console.log("scoped-log", location.pathname)
      console.error("scoped-error")
      const opened = window.open(${JSON.stringify(reachURL)})
      const fetched = await fetch(${JSON.stringify(reachURL)}, { mode: "no-cors" }).then((response) => response.type, (error) => error.name)
      const blocked = (read) => { try { read(); return "readable" } catch (error) { return error.name } }
      const channels = [() => new BroadcastChannel("private"), () => navigator.locks, () => navigator.storage, () => caches, () => new SharedWorker("data:,")].map(blocked)
      return { visibility: document.visibilityState, focused: document.hasFocus(), title: document.title, opened: opened === null, fetched, channels }` })
    const opener = await run({ mode: "code", source: `[window.open(${JSON.stringify(reachURL)}), open(${JSON.stringify(reachURL)}, "named"), document.open(${JSON.stringify(reachURL)}, "named", "")]` })
    expect(opener).toEqual({ outcome: "completed", value: [null, null, null], logs: [] })
    await Bun.sleep(300)
    const pagesAfter = await cdp.pages()
    expect(pagesAfter).toEqual(pagesBefore)
    expect(scoped).toEqual({
      outcome: "completed",
      value: { visibility: "hidden", focused: false, title: "Owned work page", opened: true, fetched: "opaque", channels: Array(5).fill("SecurityError") },
      logs: [{ level: "log", text: "scoped-log /work" }, { level: "error", text: "scoped-error" }],
    })
    const failed = await run({ mode: "script", source: `throw new RangeError("out of range")` })
    expect(failed).toMatchObject({ outcome: "error", error: { name: "RangeError", message: "out of range" } })
    const hardened = await run({ mode: "script", source: `const blocked = (read) => { try { return read() } catch (error) { return error.name } }
      return [document.querySelector("#password").value, blocked(() => document.cookie), blocked(() => localStorage.length), blocked(() => indexedDB)]` })
    expect(hardened).toEqual({ outcome: "completed", value: ["", "SecurityError", "SecurityError", "SecurityError"], logs: [] })
    const chooser = await run({ mode: "script", source: "document.querySelector('#file').showPicker()" })
    expect(chooser).toMatchObject({ outcome: "error", error: { name: "NotAllowedError" } })

    await phase("code")
    const codeRuns = [
      await run({ mode: "code", source: "let count = 1; await Promise.resolve(); count" }),
      await run({ mode: "code", source: "count += 1; console.info('count', count); count" }),
      await run({ mode: "script", source: "return typeof count" }),
    ]
    expect(codeRuns).toEqual([
      { outcome: "completed", value: 1, logs: [] },
      { outcome: "completed", value: 2, logs: [{ level: "info", text: "count 2" }] },
      { outcome: "completed", value: "undefined", logs: [] },
    ])

    const readCommands = async () => Schema.decodeUnknownSync(CommandLog)(await cdp.evaluate(worker, "globalThis.__ycodingInteractionCommands"))
    const attempt = (body: string) => run({ mode: "script", source:
      `try { const value = await (async () => { ${body} })(); return value === undefined ? "no-error" : value } catch (error) { return error.name }` })
    await phase("two-tab")
    const privateURL = `${siteOrigin}/same-origin-private`
    const privateTab = await cdp.attach(await cdp.waitTarget((target) => target.type === "page" && target.url === privateURL))
    const readPrivate = async () => Schema.decodeUnknownSync(PrivateState)(await cdp.evaluate(privateTab, `({ title: document.title, url: location.href,
      marker: document.querySelector("#marker").textContent, html: document.body.innerHTML.length, storage: localStorage.getItem("s"),
      session: sessionStorage.getItem("s"), keys: localStorage.length, received: received.slice() })`))
    const privateBefore = await readPrivate()
    const twoTabPagesBefore = await cdp.pages()
    const toPrivate = JSON.stringify(privateURL)
    const opens = {
      "window.open of the other tab URL": `return String(window.open(${toPrivate}))`,
      "named window.open": `return String(open("", "private-tab"))`,
      "three-argument document.open": `return String(document.open(${toPrivate}, "private-tab", ""))`,
    }
    const reaches = {
      "opener": "return opener",
      "BroadcastChannel to the other tab": "new BroadcastChannel('private').postMessage('from-owned')",
      "Worker": "new Worker('data:,')",
      "SharedWorker": "new SharedWorker('data:,')",
      "navigator.serviceWorker": "return navigator.serviceWorker",
      "localStorage": "return localStorage.getItem('s')",
      "sessionStorage": "return sessionStorage.getItem('s')",
      "indexedDB": "return indexedDB",
      "document.cookie": "return document.cookie",
      "cookieStore": "return cookieStore",
      "navigator.locks": "return navigator.locks.request('held', { ifAvailable: true }, (lock) => String(lock))",
      "caches": "return caches",
      "postMessage to a non-own window": "Reflect.apply(postMessage, { top: {} }, ['from-owned', '*'])",
      "URL.createObjectURL": "return URL.createObjectURL(new Blob(['x'], { type: 'text/html' }))",
    }
    const escalations = {
      ...Object.fromEntries(["script", "iframe", "frame", "object", "embed", "base", "meta", "link", "portal"]
        .map((tag) => [`createElement ${tag}`, `document.createElement("${tag}")`])),
      "append a cloned page script": "document.body.append(document.querySelector('#pagescript').cloneNode(true))",
      "setAttribute onclick": "document.querySelector('h1').setAttribute('onclick', 'void 0')",
      "href javascript:": "document.querySelector('#blank').href = 'javascript:void 0'",
      "form action javascript:": "document.querySelector('#away').action = 'javascript:void 0'",
      "innerHTML": "document.querySelector('h1').innerHTML = '<b>x</b>'",
      "outerHTML": "document.querySelector('h1').outerHTML = '<b>x</b>'",
      "insertAdjacentHTML": "document.body.insertAdjacentHTML('beforeend', '<b>x</b>')",
      "document.write": "document.write('<b>x</b>')",
      "document.writeln": "document.writeln('x')",
      "Range.createContextualFragment": "document.createRange().createContextualFragment('<b>x</b>')",
      "setHTMLUnsafe": "document.querySelector('h1').setHTMLUnsafe('<b>x</b>')",
      "DOMParser": "new DOMParser()",
      "click a _blank link": "document.querySelector('#blank').click()",
      "click a named-target link": "document.querySelector('#named').click()",
      "dispatch click on a _blank link": "document.querySelector('#blank').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
      "submit a _blank form": "document.querySelector('#away').submit()",
      "requestSubmit a _blank form": "document.querySelector('#away').requestSubmit()",
      "click the submit button of a _blank form": "document.querySelector('#away-submit').click()",
    }
    const twoTab = {
      opens: Object.fromEntries(await Array.fromAsync(Object.entries(opens), async ([name, body]) => [name, await attempt(body)])),
      reaches: Object.fromEntries(await Array.fromAsync(Object.entries(reaches), async ([name, body]) => [name, await attempt(body)])),
      escalations: Object.fromEntries(await Array.fromAsync(Object.entries(escalations), async ([name, body]) => [name, await attempt(body)])),
      code: await run({ mode: "code", source: "new BroadcastChannel('private')" }),
    }
    await Bun.sleep(500)
    const privateAfter = await readPrivate()
    const twoTabPagesAfter = await cdp.pages()
    const completed = (value: string) => ({ outcome: "completed" as const, value, logs: [] })
    expect(twoTab.opens).toEqual(Object.fromEntries(Object.keys(opens).map((name) => [name, completed("null")])))
    expect(twoTab.reaches).toEqual(Object.fromEntries(Object.keys(reaches).map((name) => [name, completed("SecurityError")])))
    expect(twoTab.escalations).toEqual(Object.fromEntries(Object.keys(escalations).map((name) => [name, completed("SecurityError")])))
    expect(twoTab.code).toMatchObject({ outcome: "error", error: { name: "SecurityError" } })
    expect(privateAfter).toEqual(privateBefore)
    expect(privateAfter).toMatchObject({ title: "MARKER-S-TITLE", marker: "MARKER-S-BODY", storage: "MARKER-S-STORAGE", session: "MARKER-S-SESSION", received: [] })
    expect(twoTabPagesAfter).toEqual(twoTabPagesBefore)
    expect(await cdp.evaluate(user, "JSON.stringify(window.mainHits)")).toBe("[]")

    await phase("opener")
    const ownedTab = await cdp.evaluate(worker, `chrome.tabs.query({ url: ${JSON.stringify(workURL)} }).then((tabs) => tabs[0].id)`)
    const relate = (direction: "opened-by-owned" | "opened-owned") => cdp.evaluate(worker, `(async () => {
      const owned = ${JSON.stringify(ownedTab)}
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(`${siteOrigin}/opened`)}, active: false, index: 0,
        ...(${JSON.stringify(direction)} === "opened-by-owned" ? { openerTabId: owned } : {}) })
      if (${JSON.stringify(direction)} === "opened-owned") await chrome.tabs.update(owned, { openerTabId: tab.id })
      const tabs = await chrome.tabs.query({})
      return { id: tab.id, ownedOpener: tabs.find((item) => item.id === owned).openerTabId === tab.id,
        relatedOpener: tabs.find((item) => item.id === tab.id).openerTabId === owned }
    })()`).then(Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number, ownedOpener: Schema.Boolean, relatedOpener: Schema.Boolean })))
    const relatedRun = async (direction: "opened-by-owned" | "opened-owned") => {
      const before = (await readCommands()).length
      const relation = await relate(direction)
      const result = await run({ mode: "script", source: "console.log('related-ran')\nreturn 1" })
      const executed = (await readCommands()).slice(before).filter((command) =>
        command.kind === "script" || command.kind === "code" || command.method === "Page.createIsolatedWorld")
      const status = authority.status(owner).state
      await cdp.evaluate(worker, `chrome.tabs.remove(${relation.id}).then(() => true)`)
      await Bun.sleep(300)
      return { relation, result, executed: executed.length, status }
    }
    const related = { openedByOwned: await relatedRun("opened-by-owned"), openedOwned: await relatedRun("opened-owned") }
    const unrelatedRun = await run({ mode: "script", source: "return 'unrelated again'" })
    await note(`opener ${JSON.stringify({ related, unrelatedRun })}`)
    expect(related).toEqual({
      openedByOwned: { relation: { id: expect.any(Number), ownedOpener: false, relatedOpener: true }, result: { outcome: "refused", reason: "policy" }, executed: 0, status: "active" },
      openedOwned: { relation: { id: expect.any(Number), ownedOpener: true, relatedOpener: false }, result: { outcome: "refused", reason: "policy" }, executed: 0, status: "active" },
    })
    expect(unrelatedRun).toEqual(completed("unrelated again"))

    await phase("second-session")
    const current = await authority.observe(owner, generation)
    const intruder = {
      run: await authority.run(other, generation, current.revision, { mode: "script", source: "return document.title" }),
      observe: await authority.observe(other, generation).then(() => "observed", (error: Error) => error.message),
      status: authority.status(other),
    }
    expect(intruder).toEqual({ run: { outcome: "refused", reason: "stale" }, observe: "Interaction stale", status: { state: "unavailable" } })

    await phase("two-sessions")
    const otherURL = `${siteOrigin}/other`
    const otherGeneration = await grant("04-other", other, otherURL)
    const otherRun = async (request: Interaction.ScriptRequest) => {
      const observed = await authority.observe(other, otherGeneration)
      return authority.run(other, otherGeneration, observed.revision, request)
    }
    const loop = (label: string) => `for (let index = 0; index < 4; index++) { console.log("${label}-log", index); await new Promise((resolve) => setTimeout(resolve, 25)) }
      console.error("${label}-error")`
    const sessions = await Promise.all([
      run({ mode: "script", source: `${loop("owner")}\nreturn location.pathname` }),
      otherRun({ mode: "script", source: `${loop("other")}\nreturn location.pathname` }),
    ])
    const sessionErrors = await Promise.all([
      run({ mode: "code", source: "throw new TypeError('owner-thrown')" }),
      otherRun({ mode: "code", source: "throw new TypeError('other-thrown')" }),
    ])
    const logs = (label: string) => [...[0, 1, 2, 3].map((index) => ({ level: "log" as const, text: `${label}-log ${index}` })),
      { level: "error" as const, text: `${label}-error` }]
    expect(sessions).toEqual([
      { outcome: "completed", value: "/work", logs: logs("owner") },
      { outcome: "completed", value: "/other", logs: logs("other") },
    ])
    expect(sessionErrors).toMatchObject([
      { outcome: "error", error: { name: "TypeError", message: "owner-thrown" } },
      { outcome: "error", error: { name: "TypeError", message: "other-thrown" } },
    ])
    expect(JSON.stringify(sessionErrors[0]).includes("other-thrown") || JSON.stringify(sessionErrors[1]).includes("owner-thrown")).toBe(false)
    const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))
    const outRuns = wire.filter((line) => line.startsWith("out ")).map((line) => decodeFrame(line.slice(4))).filter((frame) => frame.op === "run")
    const requester = new Map(outRuns.map((frame) => [frame.id, frame.input?.sessionID]))
    const deliveredTo = (text: string) => [...new Set(wire.filter((line) => line.startsWith("in ") && line.includes(text))
      .map((line) => requester.get(decodeFrame(line.slice(3)).id)))]
    const delivery = { owner: deliveredTo("owner-log"), ownerError: deliveredTo("owner-thrown"), other: deliveredTo("other-log"), otherError: deliveredTo("other-thrown") }
    expect(delivery).toEqual({ owner: [owner], ownerError: [owner], other: [other], otherError: [other] })
    authority.revoke(other)

    const handleDialog = () => cdp.send("Page.handleJavaScriptDialog", { accept: true }, user)
    await phase("dialog-script")
    const dialogRun = await run({ mode: "script", source: "alert('Synthetic dialog')\nreturn 1" })
    await note(`dialog run ${JSON.stringify(dialogRun)} status ${JSON.stringify(authority.status(owner))}`)
    expect(dialogRun).toEqual({ outcome: "paused", reason: "dialog" })
    expect(authority.status(owner)).toMatchObject({ state: "paused", reason: "dialog" })
    expect(await authority.run(owner, generation, current.revision, { mode: "script", source: "return 1" })).toEqual({ outcome: "paused", reason: "dialog" })
    expect(await authority.observe(owner, generation).then(() => "observed", (error: Error) => error.message)).toBe("Interaction paused")
    await handleDialog()
    await note("dialog handled")
    expect(await authority.resume(owner, generation)).toBe(true)
    expect(authority.status(owner).state).toBe("active")

    await phase("dialog-perform")
    const page = await authority.observe(owner, generation)
    const button = page.elements.find((element) => element.label === "Show dialog")
    if (!button) throw new Error("dialog button was not observed")
    const clicked = await authority.perform(owner, generation, page.revision, Interaction.ID.create(), { platform: "chrome", type: "click", elementID: button.id })
    expect(clicked).toEqual({ outcome: "paused", reason: "dialog" })
    expect(authority.status(owner)).toMatchObject({ state: "paused", reason: "dialog" })
    await handleDialog()
    expect(await authority.resume(owner, generation)).toBe(true)
    const confirmed = await act("Confirm action", (elementID) => ({ platform: "chrome", type: "click", elementID: element(elementID) }))
    expect(confirmed).toEqual({ outcome: "paused", reason: "dialog" })
    await handleDialog()
    expect(await authority.resume(owner, generation)).toBe(true)

    await phase("file-chooser")
    const chooserClick = await act("Choose file", (elementID) => ({ platform: "chrome", type: "click", elementID: element(elementID) }))
    await Bun.sleep(300)
    const chooserStatus = authority.status(owner)
    const chooserEvents = cdp.events.filter((event) => event.method === "Page.fileChooserOpened")
    await note(`file chooser click ${JSON.stringify(chooserClick)} status ${JSON.stringify(chooserStatus)} events ${chooserEvents.length}`)

    await phase("stop")
    const stopped = timed(run({ mode: "script", source: "console.log('spinning')\nwhile (true) {}", timeoutMs: 60_000 }))
    await Bun.sleep(500)
    expect(authority.stop(owner, generation)).toBe(true)
    const stopResult = await stopped
    expect(stopResult.ms).toBeLessThan(5_000)
    expect(stopResult.result).toMatchObject({ outcome: "stopped" })
    await until(() => { const status = authority.status(owner); return status.state === "stopped" && status.cleanup !== "pending" })

    const revokeDuring = async (name: string, shot: string, source: string) => {
      const lease = await grant(shot)
      const tabId = await cdp.evaluate(worker, `chrome.tabs.query({ url: ${JSON.stringify(workURL)} }).then((tabs) => tabs[0]?.id)`)
      const revision = (await authority.observe(owner, lease)).revision
      const armed = await authority.run(owner, lease, revision, { mode: "code", source: "setInterval(() => console.log('world-alive'), 20); 'armed'" })
      const running = authority.run(owner, lease, (await authority.observe(owner, lease)).revision, { mode: "code", source, timeoutMs: 60_000 })
      await Bun.sleep(500)
      const started = performance.now()
      authority.revoke(owner)
      const result = await running
      const settledMs = performance.now() - started
      const list = await (async () => {
        const end = Date.now() + 10_000
        while (Date.now() < end) {
          const current = await readCommands()
          if (current.some((command) => command.phase === name && command.method === "detach")) return current
          await Bun.sleep(50)
        }
        throw new Error(`${name} never detached`)
      })()
      const order = list.filter((command) => command.phase === name && command.tabId === tabId && (command.method === "Runtime.terminateExecution" ||
        command.kind === "dispose" || command.method === "Page.removeScriptToEvaluateOnNewDocument" || command.method === "detach"))
        .map((command) => command.kind === "dispose" ? "dispose" : command.method)
      const nextRun = await authority.run(owner, lease, revision, { mode: "script", source: "return 1" })
      const original = wire.filter((line) => line.startsWith("out ")).map((line) => decodeFrame(line.slice(4)))
        .findLast((frame) => frame.op === "run" && frame.input?.sessionID === owner)
      if (!original?.input || !sockets.current) throw new Error("no run frame to replay")
      const mark = wire.length
      const send = async () => {
        const replayID = crypto.randomUUID()
        const replay = JSON.stringify({ ...original, id: replayID, deadline: Date.now() + 30_000, input: { ...original.input, runID: crypto.randomUUID(), source: "console.log('replayed')\nreturn 1" } })
        wire.push(`out ${replay}`)
        sockets.current?.send(replay)
        await until(() => wire.some((line) => line.startsWith("in ") && line.includes(replayID)), 3_000).catch(() => {})
        return wire.find((line) => line.startsWith("in ") && line.includes(replayID))
      }
      const replayed = await send() ?? await send() ?? ""
      await Bun.sleep(300)
      await note(`${name} replay answer ${JSON.stringify(wire.slice(mark).map((line) => line.slice(0, 400)))}`)
      const tabGone = !(await cdp.evaluate(worker, `chrome.tabs.get(${JSON.stringify(tabId)}).then(() => true, () => false)`))
      return { armed, result, settledMs, order, nextRun, replayed: replayed.slice(3), tabGone }
    }
    const checkRevoke = (revoked: Awaited<ReturnType<typeof revokeDuring>>) => {
      expect(revoked.armed).toEqual({ outcome: "completed", value: "armed", logs: [] })
      expect(revoked.result).toMatchObject({ outcome: "stopped" })
      expect(revoked.settledMs).toBeLessThan(250)
      const at = (method: string) => revoked.order.indexOf(method)
      expect(revoked.order.at(-1)).toBe("detach")
      expect(at("Runtime.terminateExecution")).toBe(0)
      expect([at("dispose"), at("Page.removeScriptToEvaluateOnNewDocument")].every((index) => index > 0 && index < at("detach"))).toBe(true)
      expect(revoked.nextRun).toEqual({ outcome: "refused", reason: "stale" })
      expect(revoked.replayed).toContain(`"code":"ownership"`)
      expect(revoked.replayed).not.toContain("replayed")
      expect(revoked.tabGone).toBe(true)
    }
    await phase("revoke")
    const revokeBusy = await revokeDuring("revoke", "03-regrant", "while (true) {}")
    await note(`revoke busy ${JSON.stringify(revokeBusy)}`)
    await phase("revoke-await")
    const revokeAwait = await revokeDuring("revoke-await", "05-regrant", "while (true) await new Promise((resolve) => setTimeout(resolve, 10))")
    await note(`revoke awaited ${JSON.stringify(revokeAwait)}`)

    await phase("after")
    await Bun.sleep(500)
    await cdp.screenshot(await cdp.attach(await cdp.waitTarget((target) => target.type === "page" && target.url === foreignURL)), join(output, "04-user-tab.png"))
    commands.current = [...await readCommands()]
    const foreignTabs = await cdp.evaluate(worker, `chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.url !== ${JSON.stringify(workURL)}).map((tab) => tab.id))`).then(Schema.decodeUnknownSync(TabIDs))
    tabs.running = false
    await sampling
    guard.running = false
    await watching
    focus.kill("SIGTERM")
    await focus.exited
    const samples = readSamples(await Bun.file(samplesFile).text())
    const focusSummary = summarize(samples, tabs.samples.filter((sample) => sample.label !== `${browserMode}:launch`))
    const evidence = { commands: commands.current, wire, changes, confirms, operations, confirmed, chooserClick, chooserStatus, opener, pagesBefore, pagesAfter, scoped, failed, hardened, chooser, codeRuns, intruder, dialogRun, clicked, stopResult, twoTab, related, unrelatedRun, sessions, sessionErrors, delivery,
      revokeBusy, revokeAwait, harnessTargetCommands: cdp.targetCommands }
    await Bun.write(join(output, "commands.json"), JSON.stringify(commands.current, null, 1))
    await Bun.write(join(output, "wire.log"), wire.join("\n"))
    await Bun.write(join(output, "results.json"), JSON.stringify(evidence, null, 1))
    await Bun.write(join(output, "tab-samples.jsonl"), tabs.samples.map((sample) => JSON.stringify(sample)).join("\n"))
    await Bun.write(join(output, "focus-summary.json"), JSON.stringify(focusSummary, null, 1))
    await Bun.write(join(output, "invariants.jsonl"), [...samples.map((sample) => ({ stream: "os", ...sample })),
      ...tabs.samples.map((sample) => ({ stream: "chrome-tab", ...sample }))].toSorted((a, b) => a.t - b.t).map((row) => JSON.stringify(row)).join("\n"))

    checkRevoke(revokeBusy)
    checkRevoke(revokeAwait)
    expect(guard.violation).toBeUndefined()
    expect(focusSummary.violations).toEqual([])
    expect(focusSummary.tabValues).toEqual({ active: 1, focusedWindows: 1 })
    expect(focusSummary.coverage.filter((row) => row.os.before < 2 || row.os.during < 1 || row.os.after < 2 ||
      row.tab.before < 1 || row.tab.during < 1 || row.tab.after < 1)).toEqual([])
    expect(commands.current.length).toBeGreaterThan(0)
    expect(commands.current.filter((command) => command.method.startsWith("Emulation.") || command.method.startsWith("Target.") ||
      command.method === "Page.bringToFront")).toEqual([])
    expect(commands.current.filter((command) => command.tabId !== undefined && foreignTabs.includes(command.tabId))).toEqual([])
    expect(commands.current.filter((command) => command.phase === "dialog-script" && command.kind === "script")).toHaveLength(1)
    expect(commands.current.filter((command) => command.phase === "dialog-perform" && command.kind === "click")).toHaveLength(2)
    expect(markers.filter((marker) => JSON.stringify(evidence).includes(marker))).toEqual([])
    expect(wire.some((frame) => frame.includes("scoped-log"))).toBe(true)
    expect(commands.current.filter((command) => command.phase === "file-chooser" && command.kind === "click")).toHaveLength(1)
    expect({ chooserClick, chooserStatus: chooserStatus.state, chooserEvents })
      .toEqual({ chooserClick: { outcome: "applied" }, chooserStatus: "active", chooserEvents: [] })
  } finally {
    tabs.running = false
    guard.running = false
    focus.kill("SIGTERM")
    cdp.close()
    browser.kill("SIGTERM")
    await browser.exited
    await Promise.all([server.stop(true), site.stop(true), foreign.stop(true)])
    authority.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)

const recorder = `(() => {
  if (globalThis.__ycodingInteractionCommands) return true
  const log = []
  const send = chrome.debugger.sendCommand
  const attach = chrome.debugger.attach
  const kind = (method, params) => method === "Runtime.evaluate" && params?.replMode === true ? "code" :
    params?.functionDeclaration === "function () { this() }" ? "dispose" :
    method !== "Runtime.callFunctionOn" ? undefined : params?.arguments?.[0]?.value?.operation ??
    (String(params?.functionDeclaration).startsWith("async function () {") ? "script" : undefined)
  chrome.debugger.sendCommand = function (target, method, params, ...rest) {
    log.push({ tabId: target?.tabId, method, kind: kind(method, params), phase: globalThis.__ycodingInteractionPhase ?? "setup" })
    return send.call(chrome.debugger, target, method, params, ...rest)
  }
  chrome.debugger.attach = function (target, ...rest) {
    log.push({ tabId: target?.tabId, method: "attach", phase: globalThis.__ycodingInteractionPhase ?? "setup" })
    return attach.call(chrome.debugger, target, ...rest)
  }
  const detach = chrome.debugger.detach
  chrome.debugger.detach = function (target, ...rest) {
    log.push({ tabId: target?.tabId, method: "detach", phase: globalThis.__ycodingInteractionPhase ?? "setup" })
    return detach.call(chrome.debugger, target, ...rest)
  }
  globalThis.__ycodingInteractionCommands = log
  return chrome.debugger.sendCommand !== send
})()`

const selectedTabs = `Promise.all([chrome.tabs.query({ active: true }), chrome.windows.getAll()]).then(([tabs, windows]) => ({
  active: tabs.map((tab) => [tab.windowId, tab.id]), focusedWindows: windows.filter((window) => window.focused).map((window) => window.id) }))`

function sitePage(pathname: string) {
  const html = (title: string, body: string) => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html" } })
  if (pathname === "/work") return html("Owned work page", `<h1>Work</h1><button onclick="document.body.dataset.clicked = 'yes'">Continue</button>
    <input id="note" aria-label="Note"><button onclick="alert('Synthetic dialog')">Show dialog</button>
    <button onclick="document.body.dataset.confirmed = String(confirm('Synthetic confirm'))">Confirm action</button>
    <button onclick="document.querySelector('#file').click()">Choose file</button><div style="height:3000px"></div>
    <input id="password" type="password" aria-label="Password"><input id="file" type="file" aria-label="Upload">
    <a id="blank" href="/opened" target="_blank">Blank link</a><a id="named" href="/opened" target="private-tab">Named link</a>
    <form id="away" target="_blank" action="/opened"><button id="away-submit">Away</button></form>
    <script id="pagescript">window.mainHits = []; document.cookie = "owned=1"; document.querySelector("#password").value = "owned-password"
    setInterval(() => console.log("owned-main-world"), 20)</script>`)
  if (pathname === "/same-origin-private") return html("MARKER-S-TITLE", `<p id="marker">MARKER-S-BODY</p><script>window.received = []
    localStorage.setItem("s", "MARKER-S-STORAGE"); sessionStorage.setItem("s", "MARKER-S-SESSION")
    const channel = new BroadcastChannel("private"); channel.onmessage = (event) => received.push(String(event.data))
    addEventListener("message", (event) => received.push("message:" + String(event.data)))
    navigator.locks.request("held", () => new Promise(() => {}))
    setInterval(() => { channel.postMessage("MARKER-S-BODY"); console.log("MARKER-S-LOG") }, 20)</script>`)
  if (pathname === "/other") return html("Second Session page", "<h1>Other</h1>")
  if (pathname === "/opened") return html("Opened page", "<h1>Opened</h1>")
  return new Response("not found", { status: 404 })
}

function foreignPage() {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>MARKER-B-TITLE</title></head><body><p>MARKER-B-BODY</p>
    <input value="MARKER-B-INPUT"><script>document.cookie = "b=MARKER-B-COOKIE"; localStorage.setItem("b", "MARKER-B-STORAGE")
    setInterval(() => console.log("MARKER-B-LOG"), 20)</script></body></html>`, { headers: { "content-type": "text/html" } })
}

async function until(check: () => boolean, timeout = 15_000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error("condition timed out")
    await Bun.sleep(50)
  }
}

async function timed<T>(promise: Promise<T>) {
  const started = performance.now()
  const result = await promise
  return { ms: performance.now() - started, result }
}

function readSamples(text: string) {
  return text.split("\n").slice(0, -1).map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(FocusSample))(line))
}

function summarize(samples: readonly Sample[], tabSamples: readonly { t: number; label: string; active: unknown; focusedWindows: unknown }[]) {
  const invariants = {
    foreground: (sample: Sample) => sample.front,
    cursor: (sample: Sample) => sample.cursor,
    keyboardFocus: (sample: Sample) => sample.focus,
  }
  const deltas = samples.slice(1).flatMap((sample, index) => {
    const previous = samples[index]
    const userInput = (sample.hidIdleSeconds ?? Infinity) <= (sample.t - previous.t) / 1000 + 0.05
    return Object.entries(invariants).filter(([, read]) => JSON.stringify(read(sample)) !== JSON.stringify(read(previous)))
      .map(([invariant]) => ({ t: sample.t, label: sample.label, invariant, attribution: userInput ? "user-input" : "violation" }))
  })
  const count = (labels: readonly string[], name: string, part: string) =>
    labels.filter((label) => label.split(":").slice(1).join(":") === (part === "during" ? name : `${name}:${part}`)).length
  const osLabels = samples.map((sample) => sample.label)
  const tabLabels = tabSamples.map((sample) => sample.label)
  return {
    modes: {
      [desktop]: { status: "RUN", stream: "OS metadata from the shared focus sampler, every 50 ms", chrome: browserMode },
      "isolated-gui-fixture": { status: "NOT RUN", reason: "no isolated GUI session exists; no fixture window may be raised on the live desktop, so strict cursor assertions are not run" },
    },
    samples: samples.length,
    tabSamples: tabSamples.length,
    userInputSamples: deltas.filter((delta) => delta.attribution === "user-input").length,
    deltas,
    violations: deltas.filter((delta) => delta.attribution === "violation"),
    tabValues: {
      active: new Set(tabSamples.map((sample) => JSON.stringify(sample.active))).size,
      focusedWindows: new Set(tabSamples.map((sample) => JSON.stringify(sample.focusedWindows))).size,
    },
    coverage: measured.map((name) => ({
      phase: name,
      os: { before: count(osLabels, name, "before"), during: count(osLabels, name, "during"), after: count(osLabels, name, "after") },
      tab: { before: count(tabLabels, name, "before"), during: count(tabLabels, name, "during"), after: count(tabLabels, name, "after") },
    })),
    notRun: ["isolated-gui-fixture mode, including strict cursor assertions", "headed Chrome frontmost evidence", "native tab-strip pixels",
      "OS window focus of a headed Chrome window"],
    notReachable: ["real-Chrome file_chooser pause by model input: model clicks carry no user activation, so Chrome opens no chooser"] }
}

async function connectBrowser(profile: string) {
  const port = await (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const file = Bun.file(join(profile, "DevToolsActivePort"))
      if (await file.exists()) return (await file.text()).split("\n")[0]
      await Bun.sleep(100)
    }
    throw new Error("Chrome for Testing did not publish a DevTools port")
  })()
  const version = Schema.decodeUnknownSync(Version)(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = fail
  })
  const waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  const counter = { next: 0 }
  const events: { method: string; sessionId: string | undefined }[] = []
  socket.onmessage = (event) => {
    const message = Schema.decodeUnknownSync(Schema.fromJsonString(Reply))(String(event.data))
    if (message.id === undefined) {
      if (message.method) events.push({ method: message.method, sessionId: message.sessionId })
      return
    }
    const entry = waiting.get(message.id)
    waiting.delete(message.id)
    if (message.error) entry?.reject(new Error(message.error.message))
    if (!message.error) entry?.resolve(message.result ?? {})
  }
  const targetCommands: string[] = []
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (method.startsWith("Target.")) targetCommands.push(method)
    const id = ++counter.next
    waiting.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const targets = async (filter?: unknown) => Schema.decodeUnknownSync(Targets)(await send("Target.getTargets", filter ? { filter } : {})).targetInfos
  const evaluate = async (sessionId: string, expression: string) => {
    const result = Schema.decodeUnknownSync(Evaluated)(await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId))
    const details = result.exceptionDetails
    if (details) throw new Error(details.exception?.description ?? details.text ?? "evaluation failed")
    return result.result?.value
  }
  const find = async (match: (target: { targetId: string; type: string; url: string }) => boolean, filter?: unknown, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const found = (await targets(filter)).find(match)
      if (found) return found.targetId
      await Bun.sleep(100)
    }
    throw new Error("target not found")
  }
  return {
    send,
    evaluate,
    events,
    targetCommands,
    pages: async () => (await targets()).filter((target) => target.type === "page").map((target) => target.targetId).toSorted(),
    close: () => socket.close(),
    attach: async (targetId: string) => Schema.decodeUnknownSync(Attached)(await send("Target.attachToTarget", { targetId, flatten: true })).sessionId,
    waitTarget: (match: (target: { targetId: string; type: string; url: string }) => boolean, attempts?: number) => find(match, undefined, attempts),
    waitTab: (match: (url: string) => boolean) => find((target) => match(target.url), [{ type: "tab" }]),
    async waitFor(sessionId: string, expression: string, timeout = 15_000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await evaluate(sessionId, expression).catch(() => false)) return
        await Bun.sleep(100)
      }
      throw new Error(`timed out waiting for ${expression}`)
    },
    async click(sessionId: string, selector: string) {
      const box = await evaluate(sessionId, `(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`).then(Schema.decodeUnknownSync(Point))
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId)
    },
    async screenshot(sessionId: string, file: string) {
      const image = await Promise.race([send("Page.captureScreenshot", { format: "png" }, sessionId).then(Schema.decodeUnknownSync(Screenshot)), Bun.sleep(5_000)])
      if (image) await Bun.write(file, Buffer.from(image.data, "base64"))
    },
  }
}
