import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer, type ViteDevServer } from "vite"
import { decodeBoolean, decodeRecord, launchBrowser, type Page } from "./cdp"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome for Testing executable.")

const path = "/verify/mcp-app-render"
const fixture = `
  import { createComponent, createSignal, Show } from "solid-js"
  import { render } from "solid-js/web"
  import "/src/styles/tokens.css"

  const entries = import.meta.glob("/src/remote/ui/mcp-app.tsx")
  const entry = entries["/src/remote/ui/mcp-app.tsx"]
  const McpApp = entry ? (await entry()).McpApp : undefined
  if (entry && typeof McpApp !== "function") throw new Error("McpApp is not exported")
  const fallback = document.createElement("p")
  fallback.textContent = "Canonical text result"
  const [open, setOpen] = createSignal(true)
  const [view, setView] = createSignal()
  window.setApp = (html) => setView({
    resourceUri: "ui://sample/report",
    html,
    tool: { name: "private-tool-name", config: "private-config" },
    input: { region: "west" },
    output: { content: [{ type: "text", text: "12 entries" }], structuredContent: { count: 12 }, _meta: { ignored: "private-result-metadata" } },
  })
  window.closeSession = () => setOpen(false)
  window.setApp("<h1>Weekly report</h1><p>Summary of entries</p>")
  render(() => createComponent(Show, {
    get when() { return open() },
    get children() {
      return McpApp ? createComponent(McpApp, { get view() { return view() }, fallback }) : fallback
    },
  }), document.querySelector("main"))
  document.documentElement.dataset.fixture = "ready"
`

let server: ViteDevServer | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let origin: string
const unexpectedRequests: string[] = []

beforeAll(async () => {
  server = await createServer({
    root: new URL("../", import.meta.url).pathname,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "mcp-app-render-fixture",
      resolveId(id) { return id === `${path}.js` ? `\0${id}` : undefined },
      load(id) { return id === `\0${path}.js` ? fixture : undefined },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1")
          if (url.pathname === `${path}/unexpected`) {
            unexpectedRequests.push(url.pathname)
            res.statusCode = 204
            res.end()
            return
          }
          if (url.pathname !== path) return next()
          res.setHeader("Content-Type", "text/html; charset=utf-8")
          if (url.searchParams.has("block")) res.setHeader("Content-Security-Policy", "script-src 'self'")
          res.end(`<!doctype html><html><body><main></main><script type="module" src="${path}.js"></script></body></html>`)
        })
      },
    }],
  })
  await server.listen()
  origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "")
  browser = await launchBrowser(chrome, 960, 700)
}, 15_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function openFixture(query = "", inspectChild = false) {
  const page = await browser!.openPage()
  try {
    await page.injectOnNewDocument(`(() => {
      if (window !== window.top) return;
      window.appEvents = []
      window.addEventListener("message", (event) => {
        if (event.source === document.querySelector("main iframe")?.contentWindow && event.origin === "null") {
          window.appEvents.push(event.data)
        }
      })
      if (${inspectChild}) {
        const srcdoc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")
        Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
          ...srcdoc,
          set(html) {
            const nonce = /<script nonce="([a-f0-9]+)">/.exec(html)?.[1]
            if (nonce) {
              const report =
                '<script nonce="' + nonce + '">' + ${JSON.stringify(`
                  addEventListener("message", (event) => {
                    if (event.source === parent && event.data?.jsonrpc === "2.0") parent.postMessage({ observed: event.data }, "*")
                  })
                  document.addEventListener("DOMContentLoaded", () => parent.postMessage({
                    rendered: document.querySelector("h1")?.textContent,
                    policy: document.querySelector("meta[http-equiv='Content-Security-Policy']")?.content,
                    opaque: (() => { try { return !parent.document } catch { return true } })(),
                  }, "*"))
                `)} + '</script>'
              html = html.replace("</head>", report + "</head>")
            }
            srcdoc.set.call(this, html)
          },
        })
      }
    })()`)
    await page.navigate(`${origin}${path}${query}`)
    await waitFor(page, `document.documentElement.dataset.fixture === "ready"`, "Vite and Solid did not render the fixture")
    return page
  } catch (error) {
    await page.close()
    throw error
  }
}

async function waitFor(page: Page, expression: string, failure: string) {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    if (await page.evaluate(expression, decodeBoolean)) return
    await Bun.sleep(25)
  }
  const state = await page.evaluate(`({ ready: document.documentElement.dataset.fixture, frame: document.querySelector("main iframe")?.hidden, events: window.appEvents })`)
  throw new Error(`${failure}: ${JSON.stringify(state)}`)
}

test("a shared Session renders its MCP App inline and in its companion", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`${origin}/verify/remote.html?acceptedPreview=1&mcpApp=1`)
    const disclosure = `document.querySelector('.transcript-tool__toggle')`
    await waitFor(page, `!!${disclosure}`, "The shared tool result did not render")
    await page.evaluate(`${disclosure}.click()`)
    const show = `[...document.querySelectorAll('.transcript-tool button')].find(button => button.textContent === 'Show MCP App')`
    await waitFor(page, `!!${show}`, "The completed tool does not offer its preview")
    await page.evaluate(`${show}.click()`)
    await waitFor(page, `!!document.querySelector('.transcript-tool iframe[sandbox="allow-scripts"]:not([hidden])')`, "The inline App did not initialize")
    await page.evaluate(`[...document.querySelectorAll('.transcript-tool button')].find(button => button.textContent === 'Show App in companion').click()`)
    await waitFor(page, `!!document.querySelector('#session-companion-panel [aria-label="MCP App in companion"] iframe:not([hidden])')`, "The companion App did not initialize")
    expect(await page.evaluate(`window.requestLog.filter(entry => entry.operation === 'mcp.app.view').map(entry => entry.input)`)).toEqual([{ messageID: "msg_mcp_app", callID: "call_report" }])
    const other = `document.querySelector('button[data-session-id="ses_running"]')`
    await waitFor(page, `!!${other}`, "The other shared Session did not appear")
    await page.evaluate(`${other}.click()`)
    await waitFor(page, `(${other})?.getAttribute('aria-pressed') === 'true'`, "The other shared Session did not open")
    await waitFor(page, `!document.querySelector('[aria-label="MCP App in companion"], .transcript-tool .mcp-app-frame')`, "The old Session's preview remained after navigation")
  } finally { await page.close() }
}, 15_000)

test("MCP Apps render in an opaque frame and exchange only the read-only bridge messages", async () => {
  const page = await openFixture("", true)
  try {
    const frame = await page.evaluate(`(() => {
      const frame = document.querySelector("main iframe")
      return { sandbox: frame?.getAttribute("sandbox") ?? null, parentHeading: document.querySelector("main h1")?.textContent ?? null }
    })()`, decodeRecord)
    expect(frame.sandbox).toBe("allow-scripts")
    await waitFor(page, `document.querySelector("main iframe:not([hidden])") !== null && window.appEvents.some((e) => e.observed?.method === "ui/notifications/tool-result")`, "The app never became ready and received its result")
    expect(await page.evaluate(`document.querySelector("main").textContent.trim()`)).toBe("")
    expect(frame.parentHeading).toBeNull()
    const events = await page.evaluate(`window.appEvents`)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ jsonrpc: "2.0", method: "ui/initialize", params: expect.objectContaining({ protocolVersion: "2026-01-26" }) }),
      expect.objectContaining({ jsonrpc: "2.0", method: "ui/notifications/initialized" }),
    ]))
    const documentReport = await page.evaluate(`window.appEvents.find((event) => event.rendered)`, decodeRecord)
    expect(documentReport).toMatchObject({ rendered: "Weekly report", opaque: true })
    expect(String(documentReport.policy).split("; ")).toEqual(expect.arrayContaining([
      "default-src 'none'", "connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "object-src 'none'",
      "base-uri 'none'", "form-action 'none'", expect.stringMatching(/^script-src 'nonce-[a-f0-9]+'$/),
    ]))
    const received = await page.evaluate(`window.appEvents.flatMap((event) => event.observed ? [event.observed] : [])`)
    expect(received).toEqual([
      expect.objectContaining({ jsonrpc: "2.0", result: {
        protocolVersion: "2026-01-26", hostInfo: expect.objectContaining({ name: "YCoding", version: expect.any(String) }), hostCapabilities: {}, hostContext: {},
      } }),
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { region: "west" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "12 entries" }], structuredContent: { count: 12 } } },
    ])
    await page.evaluate(`window.closeSession()`)
    expect(await page.evaluate(`document.querySelector("main").children.length`)).toBe(0)
  } finally {
    await page.close()
  }
}, 12_000)

test("MCP Apps retain the canonical fallback for unavailable or active resources", async () => {
  const page = await openFixture()
  try {
    const endpoint = `${origin}${path}/unexpected`
    for (const html of [
      null,
      "",
      "<p>not isolated</p><script>void 0</script>",
      `<a href="${endpoint}">Open report</a>`,
      `<meta http-equiv="refresh" content="0; url=${endpoint}"><p>Report</p>`,
      `<img src="${endpoint}" alt="Report">`,
      `<iframe src="${endpoint}"></iframe>`,
    ]) {
      await page.evaluate(`window.setApp(${JSON.stringify(html)})`)
      expect(await page.evaluate(`({ frames: document.querySelectorAll("main iframe").length, text: document.querySelector("main").textContent.trim() })`)).toEqual({ frames: 0, text: "Canonical text result" })
    }
    await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
    expect(unexpectedRequests).toEqual([])
  } finally {
    await page.close()
  }
}, 12_000)

test("MCP Apps discard an unready frame and ignore ready messages from another window", async () => {
  const page = await openFixture("?block")
  try {
    expect(await page.evaluate(`document.querySelector("main iframe")?.hidden`)).toBe(true)
    await page.evaluate(`(() => {
      const sibling = document.createElement("iframe")
      document.body.append(sibling)
      const id = /const id = "([^"]+)"/.exec(document.querySelector("main iframe").srcdoc)[1]
      for (const payload of [
        { jsonrpc: "2.0", method: "ui/initialize", id, params: { appInfo: { name: "Foreign", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } },
        { jsonrpc: "2.0", method: "ui/notifications/initialized" },
      ]) window.dispatchEvent(new MessageEvent("message", { origin: "null", source: sibling.contentWindow, data: payload }))
      sibling.remove()
    })()`)
    await waitFor(page, `document.querySelector("main iframe") === null`, "The failed bridge left its frame mounted")
    expect(await page.evaluate(`document.querySelector("main").textContent.trim()`)).toBe("Canonical text result")
    expect(await page.evaluate(`window.appEvents.some((e) => e.observed?.result || e.observed?.method)`)).toBe(false)
  } finally {
    await page.close()
  }
}, 12_000)
