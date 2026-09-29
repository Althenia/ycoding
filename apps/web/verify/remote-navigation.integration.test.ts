import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { launchBrowser } from "./cdp"

const port = 4231
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

const captures = new URL("../../../.cache/tmp/remote-navigation/", import.meta.url).pathname
const viewports = [[390, 844], [820, 1180], [1024, 768], [1440, 900]] as const
const themes = ["light", "dark"] as const

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  mkdirSync(captures, { recursive: true })
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the remote fixture server")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote navigation", () => {
  test("lists workspaces by name in a sidebar, root Sessions only, and no native select", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&workspaces=many&theme=${theme}`)
          await until(page, `document.querySelectorAll(".sessions-table__name").length > 0`)
          const report = await page.evaluate<{
            readonly navVisible: boolean
            readonly compactVisible: boolean
            readonly labels: readonly string[]
            readonly active: string | null
            readonly title: string | undefined
            readonly hashes: boolean
            readonly nativeSelects: number
            readonly overflow: boolean
            readonly rows: readonly string[]
          }>(`(() => {
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
            return {
              navVisible: visible(document.querySelector(".workspace-nav")),
              compactVisible: visible(document.querySelector(".sessions-page__workspace-select")),
              labels: [...document.querySelectorAll(".workspace-nav__label")].map((label) => label.textContent.trim()),
              active: document.querySelector('.workspace-nav__item[aria-current="true"] .workspace-nav__label')?.textContent.trim() ?? null,
              title: document.querySelector(".sessions-page__title")?.textContent.trim(),
              hashes: /[0-9a-f]{40}/.test(document.body.innerText),
              nativeSelects: document.querySelectorAll("select").length,
              overflow: document.documentElement.scrollWidth > innerWidth,
              rows: [...document.querySelectorAll(".sessions-table__name")].map((name) => name.textContent.trim()),
            }
          })()`)
          expect(report.navVisible).toBe(width >= 768)
          expect(report.compactVisible).toBe(width < 768)
          expect(report.labels).toEqual(["ycoding (workspace)", ".agents", "office", "ycoding (Archive)", "llama-cpp-proxy-with-a-long-repository-name"])
          expect(report.active).toBe("ycoding (workspace)")
          expect(report.title).toBe("ycoding (workspace)")
          expect(report.hashes).toBe(false)
          expect(report.nativeSelects).toBe(0)
          expect(report.overflow).toBe(false)
          expect(report.rows).toContain("Stream remote output safely")
          expect(report.rows).not.toContain("Child: fix flaky suite")
          await capture(page, `sessions-${width}-${theme}`)
        }
      }

      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&workspaces=many&theme=dark`)
      await until(page, `document.querySelectorAll(".workspace-nav__item").length === 5 && document.querySelectorAll(".sessions-table__name").length > 0`)
      await page.evaluate(`[...document.querySelectorAll(".workspace-nav__item")].find((item) => item.textContent.trim() === ".agents").click()`)
      await until(page, `document.querySelector(".sessions-page__title")?.textContent.trim() === ".agents"`)
      expect(await page.evaluate<string | null>(`document.querySelector('.workspace-nav__item[aria-current="true"]')?.textContent.trim() ?? null`)).toBe(".agents")
    } finally {
      await page.close()
    }
  }, 180_000)

  test("offers Sessions, Conversation, Usage and Settings without Activity and shows the connection strip only when it has something to say", async () => {
    const page = await requireBrowser().openPage()
    const links = `(() => ({
      header: [...document.querySelectorAll('.remote-nav a')].map((link) => link.getAttribute('href')),
      bottom: [...document.querySelectorAll('.bottom-nav a')].map((link) => link.getAttribute('href')),
      activityButton: document.querySelector('[aria-label="Open activity"]') !== null,
      pill: document.querySelector('.remote-connection-label')?.textContent?.trim() ?? null,
      strip: document.querySelector('.status-strip') !== null,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))()`
    const destinations = ["/remote/sessions", "/remote", "/remote/usage", "/remote/settings"]
    try {
      for (const theme of themes) {
        for (const [width, height] of [[390, 844], [1440, 900]] as const) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
          await until(page, `document.querySelector('.remote-connection-label')?.textContent.trim() === 'Connected' && document.querySelector('.composer') !== null`)
          const healthy = await page.evaluate<{ header: readonly string[]; bottom: readonly string[]; activityButton: boolean; pill: string | null; strip: boolean; overflow: boolean }>(links)
          expect(healthy.header).toEqual(destinations)
          expect(healthy.bottom).toEqual(destinations)
          expect(healthy.activityButton).toBe(false)
          expect(healthy.pill).toBe("Connected")
          expect(healthy.strip).toBe(false)
          expect(healthy.overflow).toBe(false)
        }
      }
      await page.setViewport(768, 1024)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=selected-machine-offline-768`)
      await until(page, `document.querySelector('.status-strip')?.innerText.includes('Studio Mac is not reachable')`)
      expect(await page.evaluate<string>(`document.querySelector('.status-strip__body')?.textContent ?? ''`)).toContain("Reconnect after it is back online.")
    } finally {
      await page.close()
    }
  }, 120_000)

  test("marks the Conversation tab, navigation, and Session row while a decision is waiting", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=${theme}`)
          await until(page, `document.getElementById("pending-requests") !== null && document.querySelector(".presentation-switch") ${width < 768 ? "===" : "!=="} null`)
          const report = await page.evaluate<{
            readonly tab: string | null
            readonly tabDot: boolean
            readonly bar: boolean
            readonly navDot: boolean
            readonly bottomDot: boolean
            readonly rowDot: boolean
            readonly rows: readonly string[]
            readonly overflow: boolean
          }>(`(() => {
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
            return {
              tab: document.querySelector(".presentation-switch .filters__option--attention")?.getAttribute("aria-label") ?? null,
              tabDot: visible(document.querySelector(".presentation-switch .filters__option--attention .attention-dot")),
              bar: (() => { const bar = document.querySelector('.workspace__topbar'); return bar?.parentElement === document.querySelector('.workspace__main') && Boolean(bar?.querySelector('[aria-label="Open Team"]')) && (innerWidth < 768 ? bar.querySelector('.presentation-switch') === null : bar.querySelector('.presentation-switch') !== null) })(),
              navDot: visible(document.querySelector('.remote-nav a[href="/remote"] .attention-dot')),
              bottomDot: visible(document.querySelector('.bottom-nav a[href="/remote"] .attention-dot')),
              rowDot: document.querySelector(".session-row--active .session-row__attention") !== null,
              rows: [...document.querySelectorAll(".session-row__name")].map((name) => name.textContent.trim()),
              overflow: document.documentElement.scrollWidth > innerWidth,
            }
          })()`)
          expect(report.tab).toBe(width < 768 ? null : "Conversation, waiting for your decision")
          expect(report.tabDot).toBe(width >= 768)
          expect(report.bar).toBe(true)
          expect(report.navDot || report.bottomDot).toBe(true)
          expect(report.rowDot).toBe(true)
          expect(report.rows).not.toContain("Child: fix flaky suite")
          expect(report.overflow).toBe(false)
          await capture(page, `conversation-${width}-${theme}`)
        }
      }

      await page.setViewport(1440, 900)
      await page.evaluate(`[...document.querySelectorAll(".presentation-switch .filters__option")].find((option) => option.textContent.trim().startsWith("Office")).click()`)
      await until(page, `document.querySelector(".presentation-switch .filters__option--active")?.textContent.trim().startsWith("Office")`)
      expect(await page.evaluate<boolean>(`(() => { const conversation=document.querySelector('.remote-conversation-view'); const composer=document.querySelector('.composer-resident'); return conversation?.inert === true && conversation?.getAttribute('aria-hidden') === 'true' && conversation.classList.contains('route-panel--exiting') && composer !== null && getComputedStyle(composer).display === 'none' })()`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll(".presentation-switch .filters__option")].find((option) => option.textContent.trim().startsWith("Conversation")).click()`)
      await until(page, `document.querySelector(".composer") !== null`)
    } finally {
      await page.close()
    }
  }, 180_000)

  test("shows a failure-only Session as Failed and keeps the waiting dot for a pending decision", async () => {
    const page = await requireBrowser().openPage()
    const findRow = `[...document.querySelectorAll('.sessions-table__row')].find((candidate) => candidate.querySelector('.sessions-table__name')?.textContent.trim() === 'Stream remote output safely')`
    const report = `(() => {
      const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
      const row = ${findRow}
      return {
        chips: [...row.querySelectorAll('.sessions-table__status .chip')].map((chip) => chip.textContent.trim()),
        rowDot: row.querySelector('.attention-dot') !== null,
        navDot: visible(document.querySelector('.remote-nav a[href="/remote/sessions"] .attention-dot')),
        navLabel: document.querySelector('.remote-nav a[href="/remote/sessions"]')?.getAttribute('aria-label') ?? null,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })()`
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&noSelection=1&theme=${theme}`)
          await until(page, `window.remoteStatus && document.querySelectorAll(".sessions-table__name").length > 0`)
          await page.evaluate(`window.remoteStatus([], ["ses_fixture"], ["ses_fixture"])`)
          await until(page, `(${findRow})?.querySelector('.sessions-table__status .chip')?.textContent.trim() === 'Failed'`)
          const failed = await page.evaluate<{ chips: readonly string[]; rowDot: boolean; navDot: boolean; navLabel: string | null; overflow: boolean }>(report)
          expect(failed.chips).toEqual(["Failed"])
          expect(failed.rowDot).toBe(false)
          expect(failed.navDot).toBe(false)
          expect(failed.navLabel).toBeNull()
          expect(failed.overflow).toBe(false)
          await capture(page, `failed-session-${width}-${theme}`)
          await page.evaluate(`window.remoteStatus([], ["ses_fixture"])`)
          await until(page, `(${findRow})?.querySelector('.sessions-table__status .chip')?.textContent.trim() === 'Waiting for you'`)
          const waiting = await page.evaluate<{ chips: readonly string[]; rowDot: boolean; navDot: boolean; navLabel: string | null }>(report)
          expect(waiting.chips).toEqual(["Waiting for you"])
          expect(waiting.rowDot).toBe(true)
          expect(waiting.navDot).toBe(width >= 768)
          expect(waiting.navLabel).toBe("Sessions, a session is waiting for your decision")
        }
      }
    } finally {
      await page.close()
    }
  }, 180_000)

  test("collects live Session alerts in the notification center and opens their Session", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?theme=dark`)
        await until(page, `document.querySelector(".session-row--active .live-dot") !== null || document.querySelector(".live-dot") !== null`)
        expect(await page.evaluate<boolean>(`document.querySelector(".yc-notification-center__badge") === null`)).toBe(true)
        await page.evaluate(`window.remoteStatus([], ["ses_archived"])`)
        await until(page, `document.querySelector(".yc-notification-center__badge") !== null`)
        await page.evaluate(`document.querySelector(".yc-notification-center__trigger").click()`)
        await until(page, `document.querySelector(".yc-notification-panel") !== null`)
        const report = await page.evaluate<{
          readonly titles: readonly string[]
          readonly details: readonly string[]
          readonly badge: boolean
          readonly expanded: string | null
          readonly inViewport: boolean
        }>(`(() => {
          const panel = document.querySelector(".yc-notification-panel").getBoundingClientRect()
          return {
            titles: [...document.querySelectorAll(".yc-notification__open strong")].map((title) => title.textContent.trim()),
            details: [...document.querySelectorAll(".yc-notification__open span")].map((detail) => detail.textContent.trim()),
            badge: document.querySelector(".yc-notification-center__badge") !== null,
            expanded: document.querySelector(".yc-notification-center__trigger").getAttribute("aria-expanded"),
            inViewport: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0,
          }
        })()`)
        expect(report.titles).toEqual(["Work finished", "Needs your attention"])
        expect(report.details).toContain("Stream remote output safely")
        expect(report.details).toContain("Archived: release notes")
        expect(report.badge).toBe(false)
        expect(report.expanded).toBe("true")
        expect(report.inViewport).toBe(true)
        await capture(page, `notifications-${width}-dark`)

        await page.pressEscape()
        await until(page, `document.querySelector(".yc-notification-panel") === null`)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector(".yc-notification-center__trigger")`)).toBe(true)

        await page.evaluate(`document.querySelector(".yc-notification-center__trigger").click()`)
        await until(page, `document.querySelector(".yc-notification-panel") !== null`)
        await page.evaluate(`[...document.querySelectorAll(".yc-notification__open")].find((item) => item.textContent.includes("Archived: release notes")).click()`)
        await until(page, `document.querySelector(".yc-notification-panel") === null && document.querySelector(".conversation-breadcrumb strong")?.textContent.trim() === "Archived: release notes"`)
      }
    } finally {
      await page.close()
    }
  }, 180_000)

  test("opens Usage with the connected machine's quotas, balance, and spend through the real store", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const theme of themes) {
        for (const [width, height] of viewports) {
          await page.setViewport(width, height)
          await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=usage&theme=${theme}`)
          await until(page, `document.querySelectorAll(".usage-provider").length === 3 && document.querySelectorAll(".usage-tile").length > 0 && document.querySelector(".usage-breakdown table") !== null && document.querySelectorAll(".usage-distribution__legend li").length > 0`)
          const report = await page.evaluate<{
            readonly heading: string
            readonly providers: readonly string[]
            readonly openRouter: string
            readonly copilot: string
            readonly activeNav: readonly string[]
            readonly placeholders: readonly string[]
            readonly overflow: boolean
            readonly operations: Readonly<Record<string, number>>
            readonly distribution: readonly string[]
            readonly provenanceText: boolean
          }>(`(() => {
            const visible = (element) => element instanceof HTMLElement && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0
            const card = (label) => [...document.querySelectorAll(".usage-provider")].find((item) => item.querySelector("h3")?.textContent.trim() === label)?.textContent ?? ""
            return {
              heading: document.querySelector(".usage-page h1")?.textContent.trim() ?? "",
              providers: [...document.querySelectorAll(".usage-provider h3")].map((item) => item.textContent.trim()),
              openRouter: card("OpenRouter"),
              copilot: card("GitHub Copilot"),
              activeNav: [...document.querySelectorAll('.remote-nav a[aria-current="page"], .bottom-nav a[aria-current="page"]')].filter(visible).map((link) => link.textContent.trim()),
              placeholders: [...document.querySelectorAll(".usage-page *")].filter((element) => element.children.length === 0 && ["-", "_", "—", "–"].includes(element.textContent.trim())).map((element) => element.outerHTML),
              overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              operations: window.remoteOperationReport().operations,
              distribution: [...document.querySelectorAll(".usage-distribution__legend .usage-distribution__name")].map((item) => item.textContent.trim()),
              provenanceText: [...document.querySelectorAll(".usage-provider")].some((card) => /source:|stability:/i.test(card.innerText)),
            }
          })()`)
          expect(report.heading).toBe("Usage")
          expect(report.providers).toEqual(["Codex", "OpenRouter", "GitHub Copilot"])
          expect(report.openRouter).toContain("Balance")
          expect(report.openRouter).toContain("$38.42")
          expect(report.copilot).toContain("AI credits")
          expect(report.copilot.toLowerCase()).not.toContain("premium")
          expect(report.activeNav).toEqual(["Usage"])
          expect(report.placeholders).toEqual([])
          expect(report.overflow).toBe(false)
          expect({ providers: report.operations["usage.providers"], summary: report.operations["usage.summary"] }).toEqual({ providers: 1, summary: 1 })
          expect(report.operations["usage.report"]).toBe(3)
          expect(report.distribution).toEqual(["Codex", "OpenRouter", "GitHub Copilot"])
          expect(report.provenanceText).toBe(false)
          if ((width === 390 && theme === "light") || (width === 1440 && theme === "dark")) await capture(page, `usage-${width}-${theme}`)
        }
      }
    } finally {
      await page.close()
    }
  }, 180_000)

  test("remote routes retain the shell and resident Conversation through navigation", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of themes) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
        await until(page, `document.querySelector('.conversation-pane .transcript-message') !== null && document.querySelector('.composer') !== null`)
        await page.evaluate(`window.routeProbe = { app: document.querySelector('.app'), header: document.querySelector('.app-header'), main: document.querySelector('.workspace__main'), scroll: document.querySelector('.workspace__scroll'), message: document.querySelector('.conversation-pane .transcript-message'), composer: document.querySelector('.composer'), entrance: document.querySelector('.conversation-pane .transcript-message').getAnimations({subtree:true})[0] }`)
        for (const route of ["/remote/usage", "/remote/settings", "/remote"]) {
          await page.evaluate(`[...document.querySelectorAll('a[href="${route}"]')].find(link => link.getBoundingClientRect().width > 0)?.click()`)
          await until(page, `location.pathname === '${route}'`)
          expect(await page.evaluate<boolean>(`(() => { const p=window.routeProbe; return p.app===document.querySelector('.app') && p.header===document.querySelector('.app-header') && p.main===document.querySelector('.workspace__main') && p.scroll===document.querySelector('.workspace__scroll') && p.message===document.querySelector('.conversation-pane .transcript-message') && p.composer===document.querySelector('.composer') })()`)).toBe(true)
        }
        expect(await page.evaluate<boolean>(`window.routeProbe.entrance === window.routeProbe.message.getAnimations({subtree:true})[0]`)).toBe(true)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      } finally { await page.close() }
    }
  }, 60_000)

  test("route swaps make the outgoing view inert and animate only when motion is allowed", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of themes) for (const reduced of [false, true]) {
        await page.setViewport(width, height)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
        await until(page, `document.querySelector('.conversation-pane .transcript-message') !== null`)
        const transition = await page.evaluate<{ readonly exiting: boolean; readonly entering: boolean; readonly duration: string; readonly hidden: boolean; readonly oldVisibility: string; readonly frames: readonly number[] }>(`new Promise(resolve => { [...document.querySelectorAll('a[href="/remote/usage"]')].find(link => link.getBoundingClientRect().width > 0)?.click(); queueMicrotask(() => { const old=document.querySelector('.route-panel--exiting'); const next=document.querySelector('.route-panel--active, .route-panel--entering'); const report={exiting:old?.inert === true && old?.getAttribute('aria-hidden') === 'true', entering:next !== null, duration:next ? getComputedStyle(next).transitionDuration : '', hidden:old?.contains(document.activeElement) ?? false, oldVisibility:old ? getComputedStyle(old).contentVisibility : ''}; const frames=[]; const sample=() => { frames.push(Number(getComputedStyle(document.querySelector('.route-panel--active, .route-panel--entering')).opacity)); if(frames.length === 5) resolve({...report,frames}); else requestAnimationFrame(sample) }; requestAnimationFrame(sample) }) })`)
        expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/usage")
        expect(transition.exiting).toBe(true)
        expect(transition.entering).toBe(true)
        expect(transition.hidden).toBe(false)
        expect(transition.duration.split(",").every((duration) => duration.trim() === (reduced ? "0s" : "0.22s"))).toBe(true)
        expect(transition.oldVisibility).toBe(reduced ? "hidden" : "visible")
        if (reduced) expect(transition.frames.every((opacity) => opacity === 1)).toBe(true)
        else expect(new Set(transition.frames).size).toBeGreaterThan(1)
        await until(page, `document.querySelector('.route-panel--exiting') === null`)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      }
    } finally { await page.close() }
  }, 90_000)

  test("Team closes semantically at once, returns focus, then settles its exit", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900]] as const) for (const theme of themes) for (const reduced of [false, true]) {
        await page.setViewport(width, height)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}&team=two`)
        await until(page, `document.querySelector('[aria-label="Open Team"]') !== null && document.querySelector('.conversation-pane') !== null`)
        const entrance = await page.evaluate<{ readonly duration: string; readonly frames: readonly number[] }>(`new Promise(resolve => { document.querySelector('[aria-label="Open Team"]').click(); queueMicrotask(() => { const panel=document.querySelector('.team-control__panel'); const duration=panel ? getComputedStyle(panel).transitionDuration : ''; const frames=[]; const sample=() => { frames.push(Number(getComputedStyle(panel).opacity)); if(frames.length===5) resolve({duration,frames}); else requestAnimationFrame(sample) }; requestAnimationFrame(sample) }) })`)
        expect(entrance.duration.split(",").every((duration) => duration.trim() === (reduced ? "0s" : "0.22s"))).toBe(true)
        if (reduced) expect(entrance.frames.every((opacity) => opacity === 1)).toBe(true)
        else expect(new Set(entrance.frames).size).toBeGreaterThan(1)
        await until(page, `document.querySelector('.team-view__header [aria-label="Close Team"]') !== null`)
        await page.evaluate(`document.querySelector('.team-view__header [aria-label="Close Team"]').click()`)
        const exit = await page.evaluate<{ readonly inert: boolean; readonly hidden: boolean; readonly focused: boolean; readonly duration: string; readonly contentVisibility: string }>(`(() => { const layer=document.querySelector('.team-control--exiting'); return {inert:layer?.inert === true, hidden:layer?.getAttribute('aria-hidden') === 'true', focused:document.activeElement === document.querySelector('[aria-label="Open Team"]'), duration:layer ? getComputedStyle(layer).transitionDuration : '', contentVisibility:layer ? getComputedStyle(layer).contentVisibility : ''} })()`)
        expect(exit.inert && exit.hidden && exit.focused).toBe(true)
        expect(exit.duration.split(",").every((duration) => duration.trim() === (reduced ? "0s" : "0.22s"))).toBe(true)
        expect(exit.contentVisibility).toBe(reduced ? "hidden" : "visible")
        await until(page, `document.querySelector('.team-control--exiting') === null`)
      }
    } finally { await page.close() }
  }, 90_000)

  test("new-session swap keeps the selected draft through route navigation", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of themes) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
        await until(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
        await page.evaluate(`(() => { const draft=document.querySelector('.mini-composer__mount textarea'); draft.value='Keep this draft'; draft.dispatchEvent(new Event('input',{bubbles:true})); window.draftProbe=draft })()`)
        if (width < 768) {
          await page.evaluate(`document.querySelector('[aria-label="Open sessions"]')?.click()`)
          await until(page, `document.querySelector('.overlay--sessions-sheet .new-session__trigger') !== null`)
        }
        await page.evaluate(`([...document.querySelectorAll('.new-session__trigger')].find(button => button.getBoundingClientRect().width > 0))?.click()`)
        await until(page, `document.querySelector('.new-session-composer') !== null`)
        expect(await page.evaluate<boolean>(`(() => { const old=document.querySelector('.remote-conversation-view'); const composer=document.querySelector('.composer-resident'); return old?.inert===true && old?.getAttribute('aria-hidden')==='true' && getComputedStyle(composer).display==='none' && window.draftProbe===document.querySelector('.mini-composer__mount textarea') && window.draftProbe.value==='Keep this draft' })()`)).toBe(true)
        await page.evaluate(`document.querySelector('${width >= 768 ? ".remote-nav__link" : ".bottom-nav__item"}[href="/remote/sessions"]')?.click()`)
        await until(page, `location.pathname === '/remote/sessions'`)
        expect(await page.evaluate<boolean>(`(() => { const old=[...document.querySelectorAll('.route-panel--exiting')].find(panel=>panel.querySelector('.new-session-composer')); return old?.inert===true && old?.getAttribute('aria-hidden')==='true' && window.draftProbe===document.querySelector('.mini-composer__mount textarea') && window.draftProbe.value==='Keep this draft' })()`)).toBe(true)
        await page.evaluate(`document.querySelector('${width >= 768 ? ".remote-nav__link" : ".bottom-nav__item"}[href="/remote"]')?.click()`)
        await until(page, `location.pathname === '/remote' && document.querySelector('.remote-conversation-view:not([inert])') !== null && document.querySelector('.mini-composer__mount textarea')?.value === 'Keep this draft'`)
      }
    } finally { await page.close() }
  }, 90_000)

  test("known selected Sessions keep shell tracks while the first transcript settles", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of themes) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(width, height)
        await page.injectOnNewDocument(`window.shellHandoff=[]; document.addEventListener('DOMContentLoaded', () => { const seen=new Set(); new MutationObserver(() => { const app=document.querySelector('.app--selected'); if(!app) return; const stage=document.querySelector('.transcript-message') ? 'ready' : document.querySelector('.workspace__scroll .loading-placeholder--screen') ? 'loading' : 'unready'; if(seen.has(stage)) return; seen.add(stage); const main=document.querySelector('.workspace__main')?.getBoundingClientRect(); const rail=document.querySelector('.workspace__rail')?.getBoundingClientRect(); const controls=[...document.querySelectorAll('.workspace__topbar button:not([disabled]), .mini-composer__mount button:not([disabled])')].some(button=>button.getBoundingClientRect().width>0 && !button.closest('[inert]') && getComputedStyle(button).display!=='none'); window.shellHandoff.push({stage,mainLeft:main?.left,mainWidth:main?.width,railWidth:rail?.width ?? 0,placeholderHeight:document.querySelector('.workspace__scroll .loading-placeholder--screen')?.getBoundingClientRect().height ?? 0,controls}) }).observe(document.body,{subtree:true,childList:true,attributes:true}) })`)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}&inventoryCount=80&sessionListDelay=1800`)
        await until(page, `window.shellHandoff?.some(item => item.stage === 'ready')`)
        const stages = await page.evaluate<readonly { readonly stage: string; readonly mainLeft: number; readonly mainWidth: number; readonly railWidth: number; readonly placeholderHeight: number; readonly controls: boolean }[]>(`window.shellHandoff`)
        const loading = stages.find((item) => item.stage === "loading")
        const ready = stages.find((item) => item.stage === "ready")
        expect(loading?.placeholderHeight).toBeGreaterThan(0)
        expect(loading?.controls).toBe(false)
        expect(Math.abs((loading?.mainLeft ?? 0) - (ready?.mainLeft ?? 0))).toBeLessThanOrEqual(1)
        expect(Math.abs((loading?.mainWidth ?? 0) - (ready?.mainWidth ?? 0))).toBeLessThanOrEqual(1)
        if (width >= 768) expect(Math.abs((loading?.railWidth ?? 0) - (ready?.railWidth ?? 0))).toBeLessThanOrEqual(1)
      } finally { await page.close() }
    }
  }, 90_000)

  test("managed child view keeps the parent draft resident and restores it on return", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of themes) for (const reduced of [false, true]) {
        await page.setViewport(width, height)
        await page.setReducedMotion(reduced)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&theme=${theme}`)
        await until(page, `document.querySelector('.mini-composer__mount textarea') !== null && document.querySelector('[aria-label="Open Team"]') !== null`)
        await page.evaluate(`(() => { const draft=document.querySelector('.mini-composer__mount textarea'); draft.value='Parent draft remains'; draft.dispatchEvent(new Event('input',{bubbles:true})); window.parentDraft=draft; document.querySelector('[aria-label="Open Team"]').click() })()`)
        await until(page, `document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]') !== null`)
        await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]').click()`)
        await until(page, `document.querySelector('.subagent-bar [aria-label="Main session"]') !== null`)
        expect(await page.evaluate<boolean>(`(() => { const parent=document.querySelector('.composer-resident'); return window.parentDraft===parent?.querySelector('textarea') && window.parentDraft.value==='Parent draft remains' && parent?.inert===true && parent?.getAttribute('aria-hidden')==='true' })()`)).toBe(true)
        await page.evaluate(`document.querySelector('.subagent-bar [aria-label="Main session"]').click()`)
        await until(page, `document.querySelector('.mini-composer__mount textarea') !== null && document.querySelector('.subagent-bar') === null`)
        expect(await page.evaluate<boolean>(`window.parentDraft===document.querySelector('.mini-composer__mount textarea') && window.parentDraft.value==='Parent draft remains'`)).toBe(true)
      }
    } finally { await page.close() }
  }, 90_000)

  test("Conversation returns to its resident transcript scroll anchor after another view", async () => {
    const page = await requireBrowser().openPage()
    try {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of themes) {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
        await until(page, `document.querySelector('.conversation-pane .transcript-message') !== null`)
        const before = await page.evaluate<number>(`(() => { const scroll=document.querySelector('.workspace__scroll'); scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-300})); scroll.scrollTop=300; scroll.dispatchEvent(new Event('scroll')); window.anchorMessage=document.querySelector('.conversation-pane .transcript-message'); return scroll.scrollTop })()`)
        expect(before).toBeGreaterThanOrEqual(250)
        await page.evaluate(`[...document.querySelectorAll('a[href="/remote/usage"]')].find(link=>link.getBoundingClientRect().width>0)?.click()`)
        await until(page, `location.pathname === '/remote/usage' && document.querySelector('.route-panel--exiting') === null`)
        await page.evaluate(`[...document.querySelectorAll('a[href="/remote"]')].find(link=>link.getBoundingClientRect().width>0)?.click()`)
        await until(page, `location.pathname === '/remote' && document.querySelector('.route-panel--exiting') === null`)
        const after = await page.evaluate<{ readonly scrollTop: number; readonly sameMessage: boolean }>(`({ scrollTop:document.querySelector('.workspace__scroll').scrollTop, sameMessage:window.anchorMessage===document.querySelector('.conversation-pane .transcript-message') })`)
        expect(Math.abs(after.scrollTop - before) <= 1 && after.sameMessage).toBe(true)
      }
    } finally { await page.close() }
  }, 60_000)
})

async function capture(page: { screenshot(): Promise<string> }, name: string) {
  await Bun.write(`${captures}${name}.png`, Buffer.from(await page.screenshot(), "base64"))
}

async function until(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)
}

function requireBrowser() {
  if (!browser) throw new Error("Browser did not start")
  return browser
}
