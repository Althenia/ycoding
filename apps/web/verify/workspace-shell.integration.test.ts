import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4276
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && !await ready(); attempt += 1) await Bun.sleep(100)
  if (!await ready()) throw new Error("Vite did not start the workspace fixture")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("quiet workspace", () => {
  test("keeps the machine state unknown while the account read is pending", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?account=pending&noSelection=1`)
      await until(page, `document.querySelector('.workspace__rail-footer strong') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.workspace__rail-footer strong').textContent`)).toBe("Checking account")
    } finally { await page.close() }
  })

  test("names repository-scoped creation separately from generic New session", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
      await until(page, `document.querySelector('.sessions-page__content .new-session__trigger') !== null`)
      expect(await page.evaluate<string>(`document.querySelector('.sessions-page > .page-head .new-session__trigger').getAttribute('aria-label')`)).toBe("New session")
      expect(await page.evaluate<string>(`document.querySelector('.sessions-page__content .new-session__trigger').getAttribute('aria-label')`)).toBe("New session in ycoding")
    } finally { await page.close() }
  })

  test("pins the Session title and Back action while reading the latest output", async () => {
    for (const [width, height] of [[1440, 900], [390, 400], [320, 568]]) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
        await until(page, `document.querySelector('.composer-resident textarea') !== null`)
        await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove();document.querySelector('.workspace__scroll').scrollTop=1000000`)
        const layout = await page.evaluate<{ pinned: boolean; visible: boolean; reading: number; composerVisible: boolean }>(`(() => {
          const back=document.querySelector('.conversation-back'), header=document.querySelector('.workspace__topbar'), scroll=document.querySelector('.workspace__scroll'), field=document.querySelector('.composer-resident textarea');
          const b=back.getBoundingClientRect(),f=field.getBoundingClientRect();return {pinned:header?.contains(back) ?? false,visible:b.top>=0&&b.bottom<=innerHeight&&b.width>=44&&b.height>=44,reading:scroll.clientHeight,composerVisible:f.top>=0&&f.bottom<=document.querySelector('.bottom-nav').getBoundingClientRect().top||innerWidth>=768&&f.bottom<=innerHeight}
        })()`)
        expect(layout.pinned).toBe(true)
        expect(layout.visible).toBe(true)
        expect(layout.reading).toBeGreaterThanOrEqual(48)
        expect(layout.composerVisible).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("owns three primary destinations across inventory, detail, creation and preferences", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const width of [390, 768, 1440]) {
        await page.setViewport(width, 900)
        for (const view of ["chat", "sessions", "usage", "settings"]) {
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=${view}&theme=light`)
          await until(page, `document.querySelector('.remote-connection-label')?.textContent.includes('Connected') && document.querySelector('.bottom-nav') !== null`)
          const state = await page.evaluate<{ links: string[]; current: string; rail: number; headerLinks: number; overflow: boolean; undersized: number }>(`(() => {
            const nav = document.querySelector(innerWidth < 768 ? '.bottom-nav' : '.workspace__rail .remote-nav')
            const links = [...(nav?.querySelectorAll('a') ?? [])]
            return {
              links: links.map(link => new URL(link.href).pathname),
              current: nav?.querySelector('[aria-current="page"]')?.textContent.trim() ?? '',
              rail: document.querySelector('.workspace__rail')?.getBoundingClientRect().width ?? 0,
              headerLinks: document.querySelectorAll('.app-header .remote-nav a').length,
              overflow: document.documentElement.scrollWidth > innerWidth,
              undersized: links.filter(link => { const box=link.getBoundingClientRect();return box.width < 44 || box.height < 44 }).length,
            }
          })()`)
          expect(state.links).toEqual(["/remote/sessions", "/remote/usage", "/remote/settings"])
          expect(state.current).toBe(view === "usage" ? "Usage" : view === "settings" ? "Settings" : "Sessions")
          expect(state.rail).toBe(width < 768 ? 0 : 288)
          expect(state.headerLinks).toBe(0)
          expect(state.overflow).toBe(false)
          expect(state.undersized).toBe(0)
        }
      }
    } finally { await page.close() }
  }, 120_000)

  test("creates only from the composer and resumes the identified Session without losing its draft", async () => {
    for (const width of [390, 1440]) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=dark`)
        await until(page, `document.querySelector('.composer-resident textarea') !== null`)
        await page.evaluate(`(() => { const field=document.querySelector('.composer-resident textarea');field.value='Keep this Session draft';field.dispatchEvent(new InputEvent('input',{bubbles:true})); })()`)
        await page.evaluate(`document.querySelector(innerWidth < 768 ? '.bottom-nav a[href="/remote/settings"]' : '.workspace__rail .remote-nav a[href="/remote/settings"]').click()`)
        await until(page, `document.querySelector('.app--settings') !== null`)
        const resume = width < 768 ? ".app-header .workspace-resume" : ".workspace__rail .workspace-resume"
        expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(resume)})?.getAttribute('href') ?? ''`)).toBe("/remote/session?session_id=ses_fixture&device_id=dev_studio")
        await page.evaluate(`document.querySelector(${JSON.stringify(resume)}).click()`)
        await until(page, `document.querySelector('.app--selected') !== null`)
        expect(await page.evaluate<string>(`document.querySelector('.composer-resident textarea').value`)).toBe("Keep this Session draft")
        await page.evaluate(`document.querySelector('.conversation-back').click()`)
        await until(page, `document.querySelector('.app--sessions') !== null`)
        await page.evaluate(`document.querySelector('.sessions-page > .page-head .new-session__trigger').click()`)
        await until(page, `document.querySelector('.new-session-composer') !== null && !document.querySelector('.new-session-composer').closest('[inert]')`)
        expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
        expect(await page.evaluate<number>(`window.remoteMutationReport().filter(item => item.operation === 'session.create' || item.operation === 'session.prompt').length`)).toBe(0)
      } finally { await page.close() }
    }
  }, 60_000)

  test("collapses the shared rail on non-conversation routes without hiding navigation or workspace selection", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&workspaces=many&theme=dark`)
      await until(page, `document.querySelectorAll('.sessions-table__name').length > 0`)
      await page.evaluate(`document.querySelector('.workspace__rail button[aria-label="Hide workspace sidebar"]').click()`)
      await until(page, `document.querySelector('.app--rail-collapsed') !== null`)
      expect(await page.evaluate<{ width: number; links: number; focus: string; picker: boolean; bodyHidden: boolean }>(`(() => {
        const rail=document.querySelector('.workspace__rail');const body=rail.querySelector('.workspace__rail-body');
        return {width:rail.getBoundingClientRect().width,links:rail.querySelectorAll('.remote-nav a').length,focus:document.activeElement?.getAttribute('aria-label') ?? '',picker:document.querySelector('.sessions-page__workspace-select').getBoundingClientRect().height>0,bodyHidden:body.inert && body.getClientRects().length===0}
      })()`)).toEqual({ width: 60, links: 3, focus: "Show workspace sidebar", picker: true, bodyHidden: true })
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.workspace__rail .remote-nav a')].every(link => { const box=link.getBoundingClientRect();return box.width>=44&&box.height>=44 })`)).toBe(true)
      await page.evaluate(`document.querySelector('.workspace__rail .remote-nav a[href="/remote/settings"]').click()`)
      await until(page, `document.querySelector('.app--settings') !== null`)
      expect(await page.evaluate<boolean>(`['.workspace-resume','.workspace-new-session button'].every(selector => {const element=document.querySelector('.workspace__rail '+selector),box=element.getBoundingClientRect();return box.width>=44&&box.height>=44&&box.right<=60})`)).toBe(true)
      await page.evaluate(`document.querySelector('.workspace__rail button[aria-label="Show workspace sidebar"]').click()`)
      await until(page, `document.querySelector('.workspace__rail').getBoundingClientRect().width === 288`)
      expect(await page.evaluate<string>(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Hide workspace sidebar")
    } finally { await page.close() }
  }, 30_000)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser unavailable")
  return browser
}

async function until(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  await page.evaluate(`new Promise((resolve,reject) => { const deadline=performance.now()+8000;const check=()=>{ if(${expression}) {resolve(true);return;} if(performance.now()>deadline) {reject(new Error('Workspace condition did not settle'));return;} requestAnimationFrame(check); };check(); })`)
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(response => response.ok, () => false)
}
