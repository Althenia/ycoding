import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  launchBrowser,
  decodeArray,
  decodeBoolean,
  decodeDictionary,
  decodeNumber,
  decodeRecord,
  decodeString,
  type Page,
} from "./cdp"

const port = 4497
const origin = `http://127.0.0.1:${port}`
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>
let page: Awaited<ReturnType<typeof browser.openPage>>

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let index = 0; index < 60; index++) {
    if (
      await fetch(`http://127.0.0.1:${port}/verify/router-fixture.html`)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break
    await Bun.sleep(100)
  }
  browser = await launchBrowser(chrome, 1280, 900)
  page = await browser.openPage()
  await page.navigate(`http://127.0.0.1:${port}/verify/router-fixture.html`)
  for (let index = 0; index < 100; index++) {
    if (await page.evaluate(`window.routerProbe !== undefined`)) return
    await Bun.sleep(50)
  }
  throw new Error("Router fixture did not load")
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

type Probe = {
  readonly pathname: string
  readonly hash: string
  readonly search: Readonly<Record<string, unknown>>
  readonly routes: readonly string[]
  readonly params: readonly (readonly [string, string])[]
}
const probe = (url: string) =>
  page.evaluate(`window.routerProbe.probe(${JSON.stringify(url)})`, (value: unknown) => {
    const record = decodeRecord(value)
    return {
      ...record,
      pathname: decodeString(record["pathname"]),
      hash: decodeString(record["hash"]),
      search: decodeRecord(record["search"]),
      routes: decodeArray(decodeString)(record["routes"]),
      params: decodeArray((value: unknown) => {
        const items = decodeArray((item: unknown) => item)(value)
        if (items.length !== 2) throw new Error("Expected 2 tuple items")
        return [decodeString(items[0]), decodeString(items[1])] as const
      })(record["params"]),
    }
  })
const rendered = (url: string) =>
  page.evaluate(`window.routerProbe.rendered(${JSON.stringify(url)})`, (value: unknown) => {
    const record = decodeRecord(value)
    return {
      ...record,
      notFound: decodeBoolean(record["notFound"]),
      marketing: decodeBoolean(record["marketing"]),
      docs: decodeBoolean(record["docs"]),
      docsIndex: decodeBoolean(record["docsIndex"]),
      title: decodeString(record["title"]),
    }
  })
const leaf = (result: Probe) => result.routes.at(-1)
const splat = (result: Probe) => result.params.find(([name]) => name === "_splat")?.[1]

async function waitFor(tab: Page, predicate: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await tab.evaluate(predicate).catch(() => false)) return
    await Bun.sleep(50)
  }
  throw new Error(`Page did not reach ${predicate}`)
}

test("every public URL matches its own route", async () => {
  const leaves = await Promise.all(
    [
      "/",
      "/docs",
      "/changelog",
      "/remote",
      "/remote/sessions",
      "/remote/session",
      "/remote/usage",
      "/remote/settings",
      "/remote/invite",
    ].map(async (url) => [url, leaf(await probe(url))] as const),
  )
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
  for (const [url, slug] of [
    ["/docs/usage/tui", "usage/tui"],
    ["/docs/configuration/permissions", "configuration/permissions"],
    ["/docs/usage%20guide/setup", "usage guide/setup"],
    ["/docs/usage/", "usage"],
    ["/docs//usage", "usage"],
  ] as const) {
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
  for (const url of [
    "/unknown",
    "/changelog/extra",
    "/docsx",
    "/Docs",
    "/Docs/installation",
    "/Remote/sessions",
    "/remotes",
  ]) {
    expect({ url, ...(await rendered(url)) }).toMatchObject({
      url,
      notFound: true,
      marketing: true,
      title: "Not found — YCoding",
    })
  }
  expect(await rendered("/docs")).toMatchObject({ notFound: false, marketing: true, docsIndex: true })
  expect(await rendered("/docs/installation")).toMatchObject({
    notFound: false,
    marketing: true,
    docs: true,
    docsIndex: false,
  })
  expect(await rendered("/docs/does-not-exist")).toMatchObject({ marketing: true, title: "Not found — YCoding docs" })
})

test("unknown remote paths render not found inside the remote branch, except the invite page", async () => {
  for (const url of ["/remote/unknown", "/remote/sessions/extra", "/remote/usage/a/b"]) {
    expect({ url, ...(await rendered(url)) }).toMatchObject({ url, notFound: true, marketing: false })
  }
  expect(await rendered("/remote/invite")).toMatchObject({ notFound: false, marketing: false })
})

test("locations build Session query identity and document anchors", async () => {
  const build = (to: string, hash?: string) =>
    page.evaluate(`window.routerProbe.build(${JSON.stringify(to)}, ${JSON.stringify(hash)})`, decodeString)
  const sessionURL = new URL(
    await page.evaluate(`window.routerProbe.buildSession('ses_1', 'dev_1')`, decodeString),
    "http://ycoding.test",
  )
  expect(sessionURL.pathname).toBe("/remote/session")
  expect(sessionURL.searchParams.get("session_id")).toBe("ses_1")
  expect(sessionURL.searchParams.get("device_id")).toBe("dev_1")
  expect(await build("/docs/usage/tui", "installation")).toBe("/docs/usage/tui#installation")
  expect(await build("/docs")).toBe("/docs")
})

test("navigation pushes Session and landing query state, replaces on request, and follows back", async () => {
  const result = await page.evaluate(`window.routerProbe.browserHistory()`, (value: unknown) => {
    const record = decodeRecord(value)
    return {
      ...record,
      pushed: ((value: unknown) => {
        const record = decodeRecord(value)
        return {
          ...record,
          added: decodeNumber(record["added"]),
          pathname: decodeString(record["pathname"]),
          search: decodeDictionary(decodeString)(record["search"]),
          view: decodeString(record["view"]),
        }
      })(record["pushed"]),
      landing: ((value: unknown) => {
        const record = decodeRecord(value)
        return {
          ...record,
          added: decodeNumber(record["added"]),
          pathname: decodeString(record["pathname"]),
          search: decodeDictionary(decodeString)(record["search"]),
          view: decodeString(record["view"]),
        }
      })(record["landing"]),
      selected: ((value: unknown) => {
        const record = decodeRecord(value)
        return {
          ...record,
          added: decodeNumber(record["added"]),
          pathname: decodeString(record["pathname"]),
          search: decodeDictionary(decodeString)(record["search"]),
          view: decodeString(record["view"]),
        }
      })(record["selected"]),
      replaced: ((value: unknown) => {
        const record = decodeRecord(value)
        return {
          ...record,
          added: decodeNumber(record["added"]),
          pathname: decodeString(record["pathname"]),
          search: decodeDictionary(decodeString)(record["search"]),
          view: decodeString(record["view"]),
        }
      })(record["replaced"]),
      back: ((value: unknown) => {
        const record = decodeRecord(value)
        return {
          ...record,
          added: decodeNumber(record["added"]),
          pathname: decodeString(record["pathname"]),
          search: decodeDictionary(decodeString)(record["search"]),
          view: decodeString(record["view"]),
        }
      })(record["back"]),
    }
  })
  expect(result.pushed).toEqual({ added: 1, pathname: "/docs", search: {}, view: "/docs" })
  expect(result.landing).toMatchObject({
    added: 2,
    pathname: "/remote",
    search: { workspace_id: "workspace_fixture", source: "sidebar", device_id: "dev_studio" },
    view: "/remote",
  })
  expect(result.selected).toMatchObject({
    added: 3,
    pathname: "/remote/session",
    search: { session_id: "ses_1", device_id: "dev_studio" },
    view: "/remote/session",
  })
  expect(result.replaced).toEqual({ added: 3, pathname: "/remote/sessions", search: {}, view: "/remote/sessions" })
  expect(result.back).toMatchObject({
    added: 3,
    pathname: "/remote",
    search: { workspace_id: "workspace_fixture", source: "sidebar", device_id: "dev_studio" },
    view: "/remote",
  })
})

test("legacy workspace deep links keep query state and use the canonical views", async () => {
  const cases = [
    ["/remote/rust", "/remote/"],
    ["/remote/rust/sessions", "/remote/sessions"],
    ["/remote/rust/session", "/remote/session"],
    ["/remote/rust/projects", "/remote/projects"],
    ["/remote/rust/workspaces", "/remote/workspaces"],
    ["/remote/rust/usage", "/remote/usage"],
    ["/remote/rust/settings", "/remote/settings"],
    ["/remote/rust/invite", "/remote/invite"],
    ["/remote/rusty", "/remote/$"],
    ["/remote/rust/rust", "/remote/"],
  ] as const
  for (const [url, route] of cases) expect(leaf(await probe(url))).toBe(route)
  expect(await probe("/remote/rust/session/?session_id=ses_1&device_id=dev_1#panel")).toMatchObject({
    pathname: "/remote/session",
    search: { session_id: "ses_1", device_id: "dev_1" },
    hash: "panel",
  })
  const href = await page.evaluate(`window.routerProbe.buildSession('ses_1', 'dev_1', '/remote/rust/usage')`, decodeString)
  const url = new URL(href, "https://ycoding.test")
  expect(url.pathname).toBe("/remote/session")
  expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: "ses_1", device_id: "dev_1" })
})

test("legacy workspace navigation uses canonical URLs and replacement", async () => {
  const tab = await browser.openPage()
  try {
    await tab.navigate(`${origin}/verify/router-fixture.html`)
    await waitFor(tab, `window.routerProbe !== undefined`)
    const result = await tab.evaluate(`window.routerProbe.browserHistory('/remote/rust/usage?device_id=dev_1')`)
    expect(result).toMatchObject({
      pushed: { added: 1, pathname: "/docs", view: "/docs" },
      landing: { added: 2, pathname: "/remote", view: "/remote" },
      selected: { added: 3, pathname: "/remote/session", view: "/remote/session", search: { session_id: "ses_1", device_id: "dev_studio" } },
      replaced: { added: 3, pathname: "/remote/sessions", view: "/remote/sessions" },
      back: { added: 3, pathname: "/remote", view: "/remote" },
    })
  } finally {
    await tab.close()
  }
})

test("legacy deep links replace history and preserve search and hash", async () => {
  const tab = await browser.openPage()
  try {
    await tab.navigate(`${origin}/verify/router-fixture.html`)
    await waitFor(tab, `window.routerProbe !== undefined`)
    const result = await tab.evaluate(`(async () => {
      history.replaceState(null, '', '/remote/rust/session?session_id=ses_1&device_id=dev_1#panel');
      const before = history.length;
      const result = await window.routerProbe.browserHistory();
      return { result, before };
    })()`)
    expect(result).toMatchObject({ result: { initial: { pathname: "/remote/session", search: "?session_id=ses_1&device_id=dev_1", hash: "#panel", added: 0 }, landing: { pathname: "/remote" }, selected: { pathname: "/remote/session" } } })
    await tab.navigate(`${origin}/remote/rust/session?session_id=ses_1&device_id=dev_1#panel`)
    await waitFor(tab, `location.pathname === '/remote/session'`)
    expect(await tab.evaluate(`location.search + location.hash`)).toBe("?session_id=ses_1&device_id=dev_1#panel")
  } finally {
    await tab.close()
  }
})

test("landing workspace choices load documents and Rust sign-in keeps the deep link", async () => {
  const tab = await browser.openPage()
  try {
    await tab.injectOnNewDocument(`window.fetch = new Proxy(window.fetch, { apply(fetch, receiver, args) {
      if (args[0] === '/api/me?relay=5') return Promise.resolve(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
      return Reflect.apply(fetch, receiver, args);
    } });`)
    for (const path of ["/remote"]) {
      await tab.navigate(`${origin}/`)
      const link = `.hero__actions a[href="${path}"]`
      expect(await tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(link)}))`)).toBe(true)
      await tab.evaluate(`window.beforeEditionNavigation = true; setTimeout(() => document.querySelector(${JSON.stringify(link)}).click(), 0)`)
      await waitFor(tab, `location.pathname === ${JSON.stringify(path)} && !!document.querySelector('#remote-access-key')`)
      expect(await tab.evaluate(`({ path: location.pathname, newDocument: window.beforeEditionNavigation === undefined, signIn: !!document.querySelector('#remote-access-key') })`)).toEqual({ path, newDocument: true, signIn: true })
    }
    const deepLink = "/remote/session?session_id=ses_1&device_id=dev_1"
    await tab.navigate(`${origin}${deepLink}`)
    await waitFor(tab, `!!document.querySelector('#remote-access-key')`)
    await tab.evaluate(`setTimeout(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Continue with Google')).click(), 0)`)
    await waitFor(tab, `location.pathname === '/api/auth/google/start'`)
    expect(await tab.evaluate(`({ path: location.pathname, target: new URLSearchParams(location.search).get('redirect_after') })`)).toEqual({ path: "/api/auth/google/start", target: deepLink })
  } finally {
    await tab.close()
  }
}, 30_000)

test("Rust invite redemption strips the token and continues into Rust", async () => {
  const tab = await browser.openPage()
  const token = "A".repeat(43)
  try {
    await tab.injectOnNewDocument(`window.inviteCalls = []; window.fetch = new Proxy(window.fetch, { apply(fetch, receiver, args) {
      if (args[0] === '/api/auth/invite') {
        window.inviteCalls.push(JSON.parse(args[1].body));
        return Promise.resolve(Response.json({ accessKey: '0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ' }, { status: 201 }));
      }
      if (args[0] === '/api/me?relay=5') return Promise.resolve(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
      return Reflect.apply(fetch, receiver, args);
    } });`)
    await tab.navigate(`${origin}/remote/rust/invite#${token}`)
    await waitFor(tab, `!!document.querySelector('.sign-in__title')`)
    expect(await tab.evaluate(`({ path: location.pathname, hash: location.hash, title: document.querySelector('h1')?.textContent, calls: window.inviteCalls })`)).toEqual({ path: "/remote/invite", hash: "", title: "You're invited to YCoding Remote", calls: [] })
    await tab.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Accept invite').click()`)
    await waitFor(tab, `!!document.querySelector('#new-access-key')`)
    expect(await tab.evaluate(`({ revealed: !!document.querySelector('#new-access-key'), calls: window.inviteCalls })`)).toEqual({ revealed: true, calls: [{ token }] })
    await tab.evaluate(`setTimeout(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Continue').click(), 0)`)
    await waitFor(tab, `location.pathname === '/remote' && !!document.querySelector('#remote-access-key')`)
    expect(await tab.evaluate(`({ path: location.pathname, signIn: !!document.querySelector('#remote-access-key') })`)).toEqual({ path: "/remote", signIn: true })
    await tab.navigate(`${origin}/remote/rust/invite`)
    expect(await tab.evaluate(`document.querySelector('a.text-link')?.getAttribute('href')`)).toBe("/remote")
  } finally {
    await tab.close()
  }
}, 30_000)

test("workspace links stay canonical when followed from a legacy bookmark", async () => {
  const tab = await browser.openPage()
  try {
    await tab.injectOnNewDocument(`window.fetch = new Proxy(window.fetch, { apply(fetch, receiver, args) {
      if (args[0] === '/api/me?relay=5') return Promise.resolve(Response.json({ user: { id: 'fixture' }, session: { expiresAt: Date.now() + 60000 }, devices: [] }));
      if (args[0] === '/api/devices?relay=5') return Promise.resolve(Response.json({ devices: [] }));
      return Reflect.apply(fetch, receiver, args);
    } });`)
    const usage = 'a[data-destination="usage"]'
    const sessions = 'a[data-destination="sessions"]'
    await tab.navigate(`${origin}/remote/rust`)
    await waitFor(tab, `!!document.querySelector(${JSON.stringify(usage)})`)
    expect(await tab.evaluate(`document.querySelector(${JSON.stringify(usage)}).getAttribute('href')`)).toBe("/remote/usage")
    await tab.evaluate(`window.inWorkspace = true; document.querySelector(${JSON.stringify(usage)}).click()`)
    await waitFor(tab, `location.pathname === '/remote/usage' && document.querySelector(${JSON.stringify(usage)}).getAttribute('aria-current') === 'page'`)
    expect(await tab.evaluate(`window.inWorkspace`)).toBe(true)
    await tab.navigate(`${origin}/remote/rust/usage?device_id=dev_fixture`)
    await waitFor(tab, `document.querySelector(${JSON.stringify(usage)})?.getAttribute('aria-current') === 'page'`)
    expect(await tab.evaluate(`({ device: new URLSearchParams(location.search).get('device_id'), sessions: document.querySelector(${JSON.stringify(sessions)}).getAttribute('href') })`)).toEqual({ device: "dev_fixture", sessions: "/remote/sessions" })
  } finally {
    await tab.close()
  }
}, 30_000)
