import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4326
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("new session opens in the main area with repository names, selected model and prompt", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    await wait(page, `document.querySelector('.sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__toolbar .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.workspace__main .new-session-composer textarea') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["YCoding", "Other repository"])
    await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.trim() === 'Other repository')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Model"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", "Start a new task")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.create')?.input`)).toMatchObject({ workspace: "workspace_other", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } })
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.prompt' && item.input?.text === 'Start a new task')`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
  } finally { await page.close() }
}, 30_000)

test("unknown creation retries the same admission without a second create", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&creation=unknown`)
    await wait(page, `document.querySelector('.sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__toolbar .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Create session"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    await wait(page, `document.querySelector('.new-session__outcome--unknown') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session__outcome--unknown')?.textContent`)).toContain("Check Sessions before dismissing")
    await page.evaluate(`document.querySelector('.new-session__outcome--unknown button')?.click()`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(item => item.operation === 'session.create').length`)).toBe(1)
  } finally { await page.close() }
}, 30_000)

test("new-session hero centers in both Conversation placements and remains top-scrollable on a short phone", async () => {
  for (const noSelection of [false, true]) for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}${noSelection ? "&noSelection=1" : ""}`)
      if (!noSelection) {
        await wait(page, `document.querySelector('.workspace__rail .pane__head--sessions button:not([disabled])') !== null`)
        await page.evaluate(`document.querySelector('.workspace__rail .pane__head--sessions button')?.click()`)
      }
      await wait(page, `document.querySelector('.workspace__scroll .new-session-composer textarea') !== null`)
      const measure = () => page.evaluate<{ centerX: number; centerY: number; repositoryEdge: number; heroRatio: number; mark: number; name: number; fullLockup: boolean; ordered: boolean; overflow: boolean }>(`(() => { const scroll=document.querySelector('.workspace__scroll'), block=scroll.querySelector('.new-session-composer'), brand=block.querySelector('.new-session-composer__brand'), repository=block.querySelector('.new-session-composer__repository'), card=block.querySelector('.composer__row'), mark=brand.querySelector('img'), name=brand.querySelector('.brand__name'), descriptor=brand.querySelector('.brand__descriptor'), s=scroll.getBoundingClientRect(), b=block.getBoundingClientRect(), a=brand.getBoundingClientRect(), c=card.getBoundingClientRect(), r=repository.getBoundingClientRect(); return { centerX:Math.abs((b.left+b.right-s.left-s.right)/2), centerY:Math.abs((a.top+c.bottom-s.top-s.bottom)/2), repositoryEdge:Math.abs(r.left-c.left), heroRatio:a.width/c.width, mark:mark.getBoundingClientRect().height, name:parseFloat(getComputedStyle(name).fontSize), fullLockup:!!descriptor && descriptor.getBoundingClientRect().height>0, ordered:a.bottom<=r.top && r.bottom<=c.top, overflow:document.documentElement.scrollWidth>innerWidth || scroll.scrollWidth>scroll.clientWidth+1 } })()`)
      const layout = await measure()
      expect(layout.centerX).toBeLessThanOrEqual(8)
      expect(layout.centerY).toBeLessThanOrEqual(8)
      expect(layout.repositoryEdge).toBeLessThanOrEqual(1)
      expect(layout.mark).toBeGreaterThanOrEqual(width! < 480 ? 40 : 56)
      expect(layout.name).toBeGreaterThanOrEqual(width! < 480 ? 32 : 40)
      expect(layout.fullLockup).toBe(true)
      expect(layout.heroRatio).toBeGreaterThanOrEqual(width! < 480 ? .5 : .6)
      expect(layout.ordered).toBe(true)
      expect(layout.overflow).toBe(false)
      if (!noSelection) await Bun.write(new URL(`../../../.cache/tmp/new-session-hero-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      if (width !== 390) continue
      await page.setViewport(390, 320)
      const short = await page.evaluate<{ top: number; scrollTop: number; scrollable: boolean; composerReachable: boolean; overflow: boolean }>(`(() => { const scroll=document.querySelector('.workspace__scroll'), brand=scroll.querySelector('.new-session-composer__brand'), card=scroll.querySelector('.new-session-composer .composer__row'); const top=brand.getBoundingClientRect().top-scroll.getBoundingClientRect().top; const scrollable=scroll.scrollHeight>scroll.clientHeight; scroll.scrollTop=scroll.scrollHeight; return { top, scrollTop:scroll.scrollTop, scrollable, composerReachable:card.getBoundingClientRect().bottom<=scroll.getBoundingClientRect().bottom-8, overflow:document.documentElement.scrollWidth>innerWidth } })()`)
      expect(short.top).toBeGreaterThanOrEqual(8)
      expect(short.top).toBeLessThanOrEqual(48)
      expect(short.scrollable).toBe(true)
      expect(short.scrollTop).toBeGreaterThan(0)
      expect(short.composerReachable).toBe(true)
      expect(short.overflow).toBe(false)
    } finally { await page.close() }
  }
}, 60_000)

test("repository loading holds the picker's box and keeps Refresh in place", async () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]') !== null`)
      await page.evaluate(`window.composerSetWorkspaceLoading(true)`)
      await wait(page, `document.querySelector('.new-session-composer__repository .loading-placeholder--repository') !== null`)
      const loading = await page.evaluate<{ width: number; height: number; left: number; refresh: number; announced: boolean; pickerAbsent: boolean; disabled: boolean }>(`(() => { const row=document.querySelector('.new-session-composer__repository'), placeholder=row.querySelector('.loading-placeholder--repository'), shape=placeholder.querySelector('.loading-placeholder__shape').getBoundingClientRect(), refresh=row.querySelector('.new-session-composer__refresh'); return { width:shape.width, height:shape.height, left:shape.left, refresh:refresh.getBoundingClientRect().left, announced:placeholder.getAttribute('role')==='status' && placeholder.textContent.includes('Loading previously opened repositories…'), pickerAbsent:row.querySelector('[aria-label="Repository"]')===null, disabled:refresh.disabled } })()`)
      expect(loading.announced).toBe(true)
      expect(loading.pickerAbsent).toBe(true)
      expect(loading.disabled).toBe(true)
      expect(loading.height).toBe(width! < 768 ? 44 : 36)
      await page.evaluate(`window.composerSetWorkspaceLoading(false)`)
      await wait(page, `document.querySelector('.new-session-composer__repository button[aria-label="Repository"]') !== null`)
      const ready = await page.evaluate<{ width: number; height: number; left: number; refresh: number }>(`(() => { const row=document.querySelector('.new-session-composer__repository'), picker=row.querySelector('[aria-label="Repository"]').getBoundingClientRect(); return { width:picker.width, height:picker.height, left:picker.left, refresh:row.querySelector('.new-session-composer__refresh').getBoundingClientRect().left } })()`)
      expect(Math.abs(ready.width - loading.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.height - loading.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.left - loading.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.refresh - loading.refresh)).toBeLessThanOrEqual(1)
    } finally { await page.close() }
  }
}, 30_000)

async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate<string>(`JSON.stringify({ url: location.href, breadcrumb: document.querySelector('.conversation-breadcrumb')?.textContent, composer: document.querySelector('.new-session-composer')?.outerHTML?.slice(0, 800), body: document.body.innerText.slice(-500), requests: window.remoteMutationReport?.().slice(-3) })`)} `)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
