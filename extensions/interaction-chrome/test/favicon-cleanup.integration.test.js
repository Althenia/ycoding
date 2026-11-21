import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MARK, pageOperation } from "../page.js"

const chrome = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
const extension = join(import.meta.dir, "..")
const icon = `data:image/svg+xml,${encodeURIComponent(MARK)}`
const ownIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#C02030"/></svg>`
const svg = { headers: { "content-type": "image/svg+xml" } }
const html = (title, head = "") => new Response(`<!doctype html><html><head><title>${title}</title>${head}</head><body>${title}</body></html>`,
  { headers: { "content-type": "text/html" } })
const requests = []
const bare = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path === "/own.svg") return new Response(ownIcon, svg)
    if (path === "/icon") return html("Icon", '<link rel="icon" href="/own.svg">')
    if (path.startsWith("/plain")) return html("Plain")
    return new Response("missing", { status: 404 })
  },
})
const fallback = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/favicon.ico") return new Response(ownIcon, svg)
    return html("Default icon")
  },
})
const state = {}

beforeAll(async () => {
  if (!chrome || !(await Bun.file(chrome).exists())) throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to the pinned Chrome for Testing executable")
  state.profile = await mkdtemp(join(tmpdir(), "ycoding-favicon-cleanup-"))
  state.browser = Bun.spawn([chrome, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${state.profile}`, "--no-first-run",
    "--no-default-browser-check", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"],
  { stdout: "ignore", stderr: "ignore" })
  const port = await waitFor(async () => {
    const file = Bun.file(join(state.profile, "DevToolsActivePort"))
    return await file.exists() ? (await file.text()).split("\n")[0] : undefined
  }, (value) => !!value, "DevTools port")
  state.cdp = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const worker = await waitFor(async () => (await state.cdp.send("Target.getTargets")).targetInfos
    .find((target) => target.type === "service_worker" && target.url.endsWith("/service-worker.js")), Boolean, "extension service worker")
  state.worker = (await state.cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId
}, 30_000)

afterAll(async () => {
  state.cdp?.close()
  state.browser?.kill()
  await state.browser?.exited
  await bare.stop(true)
  await fallback.stop(true)
  if (state.profile) await rm(state.profile, { recursive: true, force: true })
})

test.each([
  { name: "a page with no icon of its own", url: () => `http://127.0.0.1:${bare.port}/plain`, before: undefined, links: [] },
  { name: "a page whose only icon is the default favicon.ico", url: () => `http://127.0.0.1:${fallback.port}/`,
    before: () => `http://127.0.0.1:${fallback.port}/favicon.ico`, links: [] },
  { name: "a page with its own icon link", url: () => `http://127.0.0.1:${bare.port}/icon`, before: () => `http://127.0.0.1:${bare.port}/own.svg`,
    links: [["icon", "/own.svg"]] },
])("Stop cleanup gives the tab back the favicon it showed before control on $name", async (page) => {
  const opened = await open(page.url(), page.before?.())
  expect(await operate(opened, "mark")).toEqual({ marked: true })
  await waitFor(() => tabFavicon(opened.url), (value) => value === icon, "the control favicon")
  expect(await operate(opened, "clear")).toEqual({ cleared: true })
  expect(await settledFavicon(opened.url)).toBe(page.before?.())
  expect(await links(opened)).toEqual(page.links)
  await state.cdp.send("Target.closeTarget", { targetId: opened.targetId })
}, 30_000)

test("an expired control mark on a page with no icon leaves Chrome's default favicon and no YCoding element", async () => {
  const opened = await open(`http://127.0.0.1:${bare.port}/plain-expiry`, undefined)
  expect(await operate(opened, "mark")).toEqual({ marked: true })
  await waitFor(() => tabFavicon(opened.url), (value) => value === icon, "the control favicon")
  expect(await settledFavicon(opened.url, 15_000)).toBeUndefined()
  expect(await links(opened)).toEqual([])
  await state.cdp.send("Target.closeTarget", { targetId: opened.targetId })
}, 30_000)

async function open(url, before) {
  const { targetId } = await state.cdp.send("Target.createTarget", { url, background: true })
  const session = (await state.cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId
  await waitFor(() => evaluate(session, "document.readyState"), (ready) => ready === "complete", "page load")
  if (before) await waitFor(() => tabFavicon(url), (value) => value === before, "the page's own favicon")
  if (!before) await waitFor(async () => requests.filter((path) => path === "/favicon.ico").length, (count) => count > 0, "the default favicon request")
  const frame = (await state.cdp.send("Page.getFrameTree", {}, session)).frameTree.frame
  const world = await state.cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "ycoding-interaction" }, session)
  return { targetId, session, url, context: world.executionContextId, location: new URL(url) }
}

async function operate(opened, operation) {
  const result = await state.cdp.send("Runtime.callFunctionOn", { executionContextId: opened.context, functionDeclaration: pageOperation.toString(),
    returnByValue: true, awaitPromise: true,
    arguments: [{ value: { operation, origin: opened.location.origin, pathname: opened.location.pathname, icon } }] }, opened.session)
  return result.result.value
}

function tabFavicon(url) {
  return evaluate(state.worker, `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.favIconUrl ?? null)`)
}

async function settledFavicon(url, timeout = 5000) {
  await waitFor(() => tabFavicon(url), (value) => value !== icon, "the control favicon to leave the tab", timeout)
  await Bun.sleep(500)
  return (await tabFavicon(url)) || undefined
}

function links(opened) {
  return evaluate(opened.session, `[...document.querySelectorAll("link")].map((link) => [link.getAttribute("rel"), link.getAttribute("href")])`)
}

async function evaluate(session, expression) {
  const result = await state.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function waitFor(read, done, label, timeout = 10_000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read().catch((error) => ({ error: String(error) }))
    if (done(value)) return value
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${label}; last value ${JSON.stringify(value)}`)
    await Bun.sleep(50)
  }
}

async function connect(address) {
  const socket = new WebSocket(address)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  const pending = new Map()
  let next = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    const settle = pending.get(message.id)
    if (!settle) return
    pending.delete(message.id)
    settle(message)
  })
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result))
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    }),
    close: () => socket.close(),
  }
}
