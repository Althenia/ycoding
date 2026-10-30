import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { listPage, parseListQuery } from "../../../packages/cli/src/remote-operations"
import { startRelayDouble } from "../test/relay-double"

const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

const webRoot = import.meta.dir.replace(/\/verify$/, "")
const dotsTitle = "Dots · unattributed"
const directory = "/workspace/picker"

let port = 0
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
  const chosen = probe.port
  probe.stop(true)
  if (chosen === undefined) throw new Error("No free port was assigned for the picker fixture server")
  return chosen
}

beforeAll(async () => {
  port = freePort()
  server = Bun.spawn([`${webRoot}/node_modules/.bin/vite`, "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: webRoot, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 980, 760)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Picker fixture server did not start")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const info = (id: string, title: string, updated: number, origin?: "dots-executor") => ({
  id, title, projectID: "prj_picker", location: { directory }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated, active: updated }, ...(origin === undefined ? {} : { origin }),
})

const backgroundCount = 40
const ordinaryCount = 60
const background = Array.from({ length: backgroundCount }, (_, index) =>
  info(`ses_bg_${String(index).padStart(2, "0")}`, index % 4 === 0 ? dotsTitle : index % 4 === 1 ? `Alpha executor ${index}` : `Executor job ${index}`, 10_000 - index, "dots-executor"))
const ordinary = Array.from({ length: ordinaryCount }, (_, index) =>
  info(`ses_ord_${String(index).padStart(2, "0")}`, index === 1 ? dotsTitle : index === 40 || index === 41 ? `Alpha ordinary ${index}` : `Ordinary work ${index}`, 5_000 - index))
const inventory = [...background, ...ordinary]
const alphaOrdinary = ordinary.filter((session) => session.title.toLowerCase().includes("alpha")).map((session) => session.id)

async function relayFor() {
  return startRelayDouble({ handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [{ id: "wsp_picker", name: "Picker", projectID: "prj_picker", directory }] } }
    if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [] } }
    if (request.operation !== "session.list") return "default"
    return { ok: true, value: listPage(inventory, parseListQuery({ ...request.input, workspace: undefined }), new Set(), new Set()) }
  } })
}

type PageReport = { readonly store: readonly string[]; readonly dom: readonly string[]; readonly domTitles: readonly string[]; readonly loading: boolean }
const report = `(() => {
  const rows = [...document.querySelectorAll('.sessions-table__row')]
  return {
    store: window.providerAuthState().sessions.map(item => item.id),
    dom: rows.map(row => row.dataset.sessionId),
    domTitles: rows.map(row => row.textContent ?? ''),
    loading: window.providerAuthState().sessionPageLoading,
  }
})()`

describe("background Sessions in the Sessions picker", () => {
  test("a real browser lists only ordinary roots across the first page, pagination and search", async () => {
    for (const width of [1440, 390]) {
      const relay = await relayFor()
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&noSelection=1&relaySessions=1&relay=${encodeURIComponent(relay.wsURL("dev_studio"))}`)
        for (let attempt = 0; attempt < 120 && !await page.evaluate<boolean>(`window.providerAuthState?.().sessions.length === 25 && window.providerAuthState().carouselStatus === 'ready'`); attempt++) await Bun.sleep(25)

        const first = await page.evaluate<PageReport>(report)
        expect(first.store, `${width}px store`).toEqual(ordinary.slice(0, 25).map((session) => session.id))
        expect(first.dom.length, `${width}px mounted rows`).toBeGreaterThan(0)
        expect(first.dom.every((id) => id.startsWith("ses_ord_")), `${width}px DOM ids`).toBe(true)
        expect(first.dom, `${width}px DOM order`).toEqual(first.store.slice(0, first.dom.length))
        const dotsRows = first.dom.filter((_, index) => first.domTitles[index]!.includes(dotsTitle))
        expect(dotsRows, `${width}px ordinary Dots-titled row`).toEqual(["ses_ord_01"])
        expect(first.domTitles.some((title) => /Executor job|Alpha executor/.test(title))).toBe(false)

        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = root.scrollHeight; root.dispatchEvent(new WheelEvent('wheel', { deltaY: 250, bubbles: true })); })()`)
        for (let attempt = 0; attempt < 120 && !await page.evaluate<boolean>(`window.providerAuthState().sessions.length === 50 && !window.providerAuthState().sessionPageLoading`); attempt++) await Bun.sleep(25)
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const second = await page.evaluate<PageReport>(report)
        expect(second.store, `${width}px paginated store`).toEqual(ordinary.slice(0, 50).map((session) => session.id))
        expect(second.dom.length).toBeGreaterThan(0)
        expect(second.dom.every((id) => id.startsWith("ses_ord_"))).toBe(true)
        expect(second.dom.some((id) => Number(id.slice("ses_ord_".length)) >= 25), `${width}px DOM shows the next ordinary page`).toBe(true)

        await page.evaluate(`(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = 0; root.dispatchEvent(new Event('scroll')); })()`)
        await page.evaluate(`(() => { const input = document.querySelector('input[type=search][placeholder="Search sessions…"]'); input.value = 'alpha'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
        for (let attempt = 0; attempt < 160 && !await page.evaluate<boolean>(`window.providerAuthState().sessionQuery === 'alpha' && window.providerAuthState().sessionListStatus === 'ready' && !window.providerAuthState().sessionPageLoading && window.providerAuthState().sessions.length === ${alphaOrdinary.length}`); attempt++) await Bun.sleep(25)
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const searched = await page.evaluate<PageReport>(report)
        expect(searched.store, `${width}px searched store`).toEqual(alphaOrdinary)
        expect(searched.dom, `${width}px searched DOM`).toEqual(alphaOrdinary)
        expect(searched.domTitles.every((title) => title.includes("Alpha ordinary"))).toBe(true)
        expect(searched.domTitles.some((title) => title.includes("Alpha executor"))).toBe(false)

        const lists = relay.requests.filter((request) => request.operation === "session.list")
        expect(lists.length).toBeGreaterThanOrEqual(3)
        expect(lists.every((request) => request.input?.background === "exclude"), `${width}px every session.list excludes background`).toBe(true)
        expect(lists.some((request) => request.input?.search === "alpha")).toBe(true)
        expect(lists.some((request) => typeof request.input?.cursor === "string")).toBe(true)
      } finally { await page.close(); await relay.stop() }
    }
  }, 60_000)
})
