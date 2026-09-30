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

type Probe = { readonly pathname: string; readonly hash: string; readonly routes: readonly string[]; readonly params: readonly (readonly [string, string])[] }
type Rendered = { readonly notFound: boolean; readonly marketing: boolean; readonly docs: boolean; readonly docsIndex: boolean; readonly title: string }
const probe = (url: string) => page.evaluate<Probe>(`window.routerProbe.probe(${JSON.stringify(url)})`)
const rendered = (url: string) => page.evaluate<Rendered>(`window.routerProbe.rendered(${JSON.stringify(url)})`)
const leaf = (result: Probe) => result.routes.at(-1)
const splat = (result: Probe) => result.params.find(([name]) => name === "_splat")?.[1]

test("every public URL matches its own route", async () => {
  const leaves = await Promise.all(["/", "/docs", "/changelog", "/remote", "/remote/sessions", "/remote/usage", "/remote/settings", "/remote/invite"].map(async (url) => [url, leaf(await probe(url))] as const))
  expect(leaves).toEqual([
    ["/", "/_marketing/"],
    ["/docs", "/_marketing/docs/"],
    ["/changelog", "/_marketing/changelog"],
    ["/remote", "/remote/"],
    ["/remote/sessions", "/remote/sessions"],
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
  expect((await probe("/docs//usage")).pathname).toBe("/docs/usage")
})

test("query strings never select a route and the hash survives decoding", async () => {
  const withQuery = await probe("/docs/installation?token=abc#fragment")
  expect(withQuery.pathname).toBe("/docs/installation")
  expect(withQuery.hash).toBe("fragment")
  const session = await probe("/remote#session=ses_abc123")
  expect(leaf(session)).toBe("/remote/")
  expect(session.hash).toBe("session=ses_abc123")
  expect((await probe("/remote#new-session")).hash).toBe("new-session")
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

test("locations build with the selected hash and no other state", async () => {
  const build = (to: string, hash?: string) => page.evaluate<string>(`window.routerProbe.build(${JSON.stringify(to)}, ${JSON.stringify(hash)})`)
  expect(await build("/remote", "new-session")).toBe("/remote#new-session")
  expect(await build("/remote", "session=ses_1")).toBe("/remote#session=ses_1")
  expect(await build("/docs/usage/tui", "installation")).toBe("/docs/usage/tui#installation")
  expect(await build("/docs")).toBe("/docs")
})

test("navigation pushes by default, replaces on request, and follows back", async () => {
  type Step = { added: number; url: string; view: string }
  const result = await page.evaluate<{ pushed: Step; pushedHash: Step; replaced: Step; back: Step }>(`window.routerProbe.browserHistory()`)
  expect(result.pushed).toEqual({ added: 1, url: "/docs", view: "/docs#" })
  expect(result.pushedHash).toEqual({ added: 2, url: "/remote#new-session", view: "/remote#new-session" })
  expect(result.replaced).toEqual({ added: 2, url: "/remote", view: "/remote#" })
  expect(result.back).toMatchObject({ url: "/docs", view: "/docs#" })
})
