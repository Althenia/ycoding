import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4497
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>
let page: Awaited<ReturnType<typeof browser.openPage>>

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let index = 0; index < 60; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/router-fixture.html`).then((response) => response.ok).catch(() => false)) break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(chrome, 1280, 900)
  page = await browser.openPage()
  await page.navigate(`http://127.0.0.1:${port}/verify/router-fixture.html`)
  for (let index = 0; index < 100; index++) {
    if (await page.evaluate<boolean>(`window.routerProbe !== undefined`)) return
    await Bun.sleep(50)
  }
  throw new Error("Router fixture did not load")
})

afterAll(async () => { await page?.close(); await browser?.close(); server?.kill(); if (server) await server.exited })

type Probe = { readonly pathname: string; readonly hash: string; readonly search: Readonly<Record<string, unknown>>; readonly routes: readonly string[]; readonly params: readonly (readonly [string, string])[] }
type Rendered = { readonly notFound: boolean; readonly marketing: boolean; readonly docs: boolean; readonly docsIndex: boolean; readonly title: string }
const probe = (url: string) => page.evaluate<Probe>(`window.routerProbe.probe(${JSON.stringify(url)})`)
const rendered = (url: string) => page.evaluate<Rendered>(`window.routerProbe.rendered(${JSON.stringify(url)})`)
const leaf = (result: Probe) => result.routes.at(-1)
const splat = (result: Probe) => result.params.find(([name]) => name === "_splat")?.[1]

test("every public URL matches its own route", async () => {
  const leaves = await Promise.all(["/", "/docs", "/changelog", "/remote", "/remote/sessions", "/remote/session", "/remote/usage", "/remote/settings", "/remote/invite"].map(async (url) => [url, leaf(await probe(url))] as const))
  expect(leaves).toEqual([
    ["/", "/_marketing/"],
    ["/docs", "/_marketing/docs/"],
    ["/changelog", "/_marketing/changelog"],
    ["/remote", "/remote/"],
    ["/remote/sessions", "/remote/sessions"],
    ["/remote/session", "/remote/session"],
    ["/remote/usage", "/remote/usage"],
    ["/remote/settings", "/remote/settings"],
    ["/remote/invite", "/remote/invite"],
  ])
})

test("docs pages capture the whole slug and decode its segments", async () => {
  for (const [url, slug] of [["/docs/usage/tui", "usage/tui"], ["/docs/configuration/permissions", "configuration/permissions"], ["/docs/usage%20guide/setup", "usage guide/setup"], ["/docs/usage/", "usage"], ["/docs//usage", "usage"]] as const) {
    const result = await probe(url)
    expect({ url, leaf: leaf(result), slug: splat(result) }).toEqual({ url, leaf: "/_marketing/docs/$", slug })
  }
  expect(leaf(await probe("/docs/"))).toBe("/_marketing/docs/")
})

test("trailing slashes never change the pathname a view compares against", async () => {
  expect((await probe("/remote/")).pathname).toBe("/remote")
  expect((await probe("/remote/sessions/")).pathname).toBe("/remote/sessions")
  expect((await probe("/remote/session/")).pathname).toBe("/remote/session")
  expect((await probe("/docs//usage")).pathname).toBe("/docs/usage")
})

test("query strings preserve remote Session identity without changing route matching", async () => {
  const withQuery = await probe("/docs/installation?token=abc#fragment")
  expect(withQuery.pathname).toBe("/docs/installation")
  expect(withQuery.hash).toBe("fragment")
  const landing = await probe("/remote?workspace_id=workspace_fixture&source=sidebar&device_id=dev_studio")
  expect(leaf(landing)).toBe("/remote/")
  expect(landing.hash).toBe("")
  const session = await probe("/remote/session?session_id=ses_abc123&device_id=dev_studio#fragment")
  expect(leaf(session)).toBe("/remote/session")
  expect(session.pathname).toBe("/remote/session")
  expect(session.search).toMatchObject({ session_id: "ses_abc123", device_id: "dev_studio" })
  expect(session.hash).toBe("fragment")
  expect((await probe("/remote/sessions#panel%20one")).hash).toBe("panel one")
})

test("unknown public paths render not found inside the marketing layout", async () => {
  for (const url of ["/unknown", "/changelog/extra", "/docsx", "/Docs", "/Docs/installation", "/Remote/sessions", "/remotes"]) {
    expect({ url, ...(await rendered(url)) }).toMatchObject({ url, notFound: true, marketing: true, title: "Not found — YCoding" })
  }
  expect(await rendered("/docs")).toMatchObject({ notFound: false, marketing: true, docsIndex: true })
  expect(await rendered("/docs/installation")).toMatchObject({ notFound: false, marketing: true, docs: true, docsIndex: false })
  expect(await rendered("/docs/does-not-exist")).toMatchObject({ marketing: true, title: "Not found — YCoding docs" })
})

test("unknown remote paths render not found inside the remote branch, except the invite page", async () => {
  for (const url of ["/remote/unknown", "/remote/sessions/extra", "/remote/usage/a/b"]) {
    expect({ url, ...(await rendered(url)) }).toMatchObject({ url, notFound: true, marketing: false })
  }
  expect(await rendered("/remote/invite")).toMatchObject({ notFound: false, marketing: false })
})

test("locations build Session query identity and document anchors", async () => {
  const build = (to: string, hash?: string) => page.evaluate<string>(`window.routerProbe.build(${JSON.stringify(to)}, ${JSON.stringify(hash)})`)
  const sessionURL = new URL(await page.evaluate<string>(`window.routerProbe.buildSession('ses_1', 'dev_1')`), "http://ycoding.test")
  expect(sessionURL.pathname).toBe("/remote/session")
  expect(sessionURL.searchParams.get("session_id")).toBe("ses_1")
  expect(sessionURL.searchParams.get("device_id")).toBe("dev_1")
  expect(await build("/docs/usage/tui", "installation")).toBe("/docs/usage/tui#installation")
  expect(await build("/docs")).toBe("/docs")
})

test("navigation pushes Session and landing query state, replaces on request, and follows back", async () => {
  type Step = { readonly added: number; readonly pathname: string; readonly search: Readonly<Record<string, string>>; readonly view: string }
  const result = await page.evaluate<{ readonly pushed: Step; readonly landing: Step; readonly selected: Step; readonly replaced: Step; readonly back: Step }>(`window.routerProbe.browserHistory()`)
  expect(result.pushed).toEqual({ added: 1, pathname: "/docs", search: {}, view: "/docs" })
  expect(result.landing).toMatchObject({ added: 2, pathname: "/remote", search: { workspace_id: "workspace_fixture", source: "sidebar", device_id: "dev_studio" }, view: "/remote" })
  expect(result.selected).toMatchObject({ added: 3, pathname: "/remote/session", search: { session_id: "ses_1", device_id: "dev_studio" }, view: "/remote/session" })
  expect(result.replaced).toEqual({ added: 3, pathname: "/remote/sessions", search: {}, view: "/remote/sessions" })
  expect(result.back).toMatchObject({ added: 3, pathname: "/remote", search: { workspace_id: "workspace_fixture", source: "sidebar", device_id: "dev_studio" }, view: "/remote" })
})
