import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startRelayDouble } from "../test/relay-double"
import { launchBrowser } from "./cdp"

const port = 4196
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
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the remote fixture server")
  browser = await launchBrowser(browserPath, 2048, 1366)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote shell layout", () => {
  test("places running Sessions before the workspace heading on the Sessions page", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`Boolean(document.querySelector('.running-sessions') && document.querySelector('.sessions-page__title'))`); attempt += 1) await Bun.sleep(50)
      const positions = await page.evaluate<{ readonly running: number; readonly heading: number; readonly toolbar: number }>(`(() => ({ running: document.querySelector('.running-sessions')?.getBoundingClientRect().top ?? Infinity, heading: document.querySelector('.sessions-page__title')?.getBoundingClientRect().top ?? -1, toolbar: document.querySelector('.sessions-page__toolbar')?.getBoundingClientRect().top ?? -1 }))()`)
      expect(positions.running).toBeLessThan(positions.heading)
      expect(positions.running).toBeLessThan(positions.toolbar)
    } finally { await page.close() }
  }, 30_000)

  test("keeps the no-selection Sessions overlay full width and the main empty content centered", async () => {
    for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [820, 1180]]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&theme=${theme}`)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.app--empty .app-header__menu') !== null && document.querySelector('.new-session-composer') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('.app-header__menu').click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.overlay--sessions-sheet[open] .session-row') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`Promise.all([...document.querySelector('.overlay--sessions-sheet .overlay__surface').getAnimations()].map(animation => animation.finished))`)
        const geometry = await page.evaluate<{ readonly labelLeft: number; readonly buttonRight: number; readonly headerTop: number; readonly buttonTop: number; readonly innerLeft: number; readonly innerRight: number; readonly workspaceLeft: number; readonly headingLeft: number; readonly selectorAbsent: boolean; readonly filterLeft: number; readonly filterRight: number; readonly rowTextLeft: number; readonly bodyOverflow: boolean; readonly listOverflow: boolean; readonly centered: boolean; readonly pageOverflow: boolean }>(`(() => { const overlay = document.querySelector('.overlay--sessions-sheet'); const pane = overlay.querySelector('.pane'); const content = pane.getBoundingClientRect(); const pad = parseFloat(getComputedStyle(pane).paddingLeft); const label = pane.querySelector('.pane__title').getBoundingClientRect(); const button = pane.querySelector('.pane__head button').getBoundingClientRect(); const workspace = pane.querySelector('.session-panel__workspace .workspace-select__label').getBoundingClientRect(); const heading = pane.querySelector('.session-panel__workspace h3').getBoundingClientRect(); const filter = pane.querySelector('input[placeholder="Filter sessions"]').getBoundingClientRect(); const list = pane.querySelector('.session-list'); const row = pane.querySelector('.session-row__title').getBoundingClientRect(); const body = overlay.querySelector('.overlay__body'); const main = document.querySelector('.workspace__main').getBoundingClientRect(); const empty = document.querySelector('.new-session-composer').getBoundingClientRect(); return { labelLeft: label.left, buttonRight: button.right, headerTop: label.top, buttonTop: button.top, innerLeft: content.left + pad, innerRight: content.right - pad, workspaceLeft: workspace.left, headingLeft: heading.left, selectorAbsent: !pane.querySelector('.workspace-select .custom-select__trigger'), filterLeft: filter.left, filterRight: filter.right, rowTextLeft: row.left, bodyOverflow: body.scrollWidth > body.clientWidth + 1, listOverflow: list.scrollWidth > list.clientWidth + 1, centered: Math.abs((empty.left + empty.right - main.left - main.right)/2) <= 1, pageOverflow: document.documentElement.scrollWidth > innerWidth } })()`)
        expect(Math.abs(geometry.labelLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.buttonRight - geometry.innerRight)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.headerTop - geometry.buttonTop)).toBeLessThanOrEqual(14)
        expect(Math.abs(geometry.workspaceLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.headingLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(geometry.selectorAbsent).toBe(true)
        expect(Math.abs(geometry.filterLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.filterRight - geometry.innerRight)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.rowTextLeft - geometry.innerLeft)).toBeLessThanOrEqual(1)
        expect(geometry.bodyOverflow).toBe(false)
        expect(geometry.listOverflow).toBe(false)
        expect(geometry.centered).toBe(true)
        expect(geometry.pageOverflow).toBe(false)
        await Bun.write(new URL(`../../../.cache/tmp/sessions-no-selection-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 30_000)

  test("shows Office only above phone sizes and keeps the selected Session and draft through rotation", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=office&theme=light`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.app--selected') !== null`); attempt += 1) await Bun.sleep(50)
      const layouts = [[390, 844, false, false], [1366, 650, false, true], [820, 1180, false, true], [1180, 820, false, true], [1440, 900, false, true], [1133, 744, true, true], [844, 390, true, false]] as const
      for (const [width, height, coarse, office] of layouts) {
        if (coarse) await page.setCoarsePointer(true)
        expect(await page.evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`)).toBe(coarse)
        await page.setViewport(width, height)
        for (let attempt = 0; attempt < 40 && await page.evaluate<boolean>(`document.querySelector('.office-workspace') !== null`) !== office; attempt += 1) await Bun.sleep(50)
        const state = await page.evaluate<{ readonly switchVisible: boolean; readonly officeVisible: boolean; readonly conversationVisible: boolean; readonly session: string }>(`(() => ({ switchVisible: Boolean(document.querySelector('.presentation-switch')?.getBoundingClientRect().width), officeVisible: Boolean(document.querySelector('.office-workspace')?.getBoundingClientRect().width), conversationVisible: Boolean(document.querySelector('.conversation-pane')?.getBoundingClientRect().width), session: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '' }))()`)
        expect(state.switchVisible).toBe(office)
        expect(state.officeVisible).toBe(office)
        expect(state.conversationVisible).toBe(!office)
        if (!office) expect(state.session).toBe("Stream remote output safely")
        else expect(await page.evaluate<boolean>(`document.querySelector('.app--selected') !== null`)).toBe(true)
      }
      await page.setViewport(390, 844)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.composer__input') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`(() => { const input = document.querySelector('.composer__input'); input.value = 'Keep my rotation draft'; input.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Keep my rotation draft")
      await page.setViewport(820, 1180)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.office-workspace') !== null`); attempt += 1) await Bun.sleep(50)
      await page.setViewport(390, 844)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.conversation-pane') !== null && document.querySelector('.composer__input') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Keep my rotation draft")
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? ''`)).toBe("Stream remote output safely")
      const settings = await browser!.openPage()
      try {
        for (const [width, height, coarse, visible] of layouts) {
          if (coarse) await settings.setCoarsePointer(true)
          expect(await settings.evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`)).toBe(coarse)
          await settings.setViewport(width, height)
          await settings.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&presentation=office`)
          for (let attempt = 0; attempt < 40 && !await settings.evaluate<boolean>(`document.querySelector('#office-settings') !== null`); attempt += 1) await Bun.sleep(50)
          expect(await settings.evaluate<boolean>(`getComputedStyle(document.querySelector('#office-settings')).display !== 'none'`)).toBe(visible)
        }
      } finally { await settings.close() }
    } finally { await page.close() }
  }, 45_000)

  test("follows another workspace's running Session from the carousel in desktop rail and phone sheet", async () => {
    for (const width of [1440, 390]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=session-list-${width === 390 ? 390 : 1440}`)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`window.remoteStatus && document.querySelector('.sessions-page__title')`); attempt += 1) await Bun.sleep(50)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.running-sessions__item') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`window.remoteStatus(['ses_fixture', 'ses_telemetry'], [])`)
        for (let attempt = 0; attempt < 160 && await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`) !== 2; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`)).toBe(2)
        await page.evaluate(`[...document.querySelectorAll('.running-sessions__item')].find(button => button.textContent.includes('Telemetry Event'))?.click()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.app--conversation.app--selected') !== null`); attempt += 1) await Bun.sleep(50)
        if (width === 390) {
          await page.evaluate(`document.querySelector('.app-header__menu').click()`)
          for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.overlay--sessions-sheet[open] .session-panel__workspace') !== null`); attempt += 1) await Bun.sleep(50)
        }
        const result = await page.evaluate<{ readonly heading: string; readonly selector: boolean; readonly rows: readonly string[]; readonly active: string; readonly firstRunning: boolean }>(`(() => { const panel = document.querySelector(${width === 390 ? "'.overlay--sessions-sheet .pane'" : "'.workspace__rail .pane'"}); const rows = [...panel.querySelectorAll('.session-row')]; return { heading: panel.querySelector('.session-panel__workspace h3')?.textContent.trim() ?? '', selector: Boolean(panel.querySelector('.workspace-select .custom-select__trigger')), rows: rows.map(row => row.querySelector('.session-row__name')?.textContent.trim() ?? ''), active: panel.querySelector('.session-row--active .session-row__name')?.textContent.trim() ?? '', firstRunning: Boolean(rows[0]?.querySelector('.live-dot')) } })()`)
        expect(result.heading).toBe("telemetry-daemon")
        expect(result.selector).toBe(false)
        expect(result.rows).toContain("Telemetry Event Buffer Flush Daemon")
        expect(result.active).toBe("Telemetry Event Buffer Flush Daemon")
        expect(result.firstRunning).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("follows a deep-linked Session's workspace instead of the previously browsed workspace", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-1440`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`location.hash = '#session=ses_indexer'`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Query batch indexer') ?? false`); attempt += 1) await Bun.sleep(50)
      const state = await page.evaluate<{ readonly heading: string; readonly active: string; readonly selector: boolean }>(`(() => ({ heading: document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() ?? '', active: document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() ?? '', selector: Boolean(document.querySelector('.workspace__rail .workspace-select .custom-select__trigger')) }))()`)
      expect(state).toEqual({ heading: "indexer", active: "Query batch indexer", selector: false })
    } finally { await page.close() }
  }, 30_000)

  test("highlights the root when a child Session is opened from a deep link", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`location.hash = '#session=ses_child'`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Child: fix flaky suite') ?? false`); attempt += 1) await Bun.sleep(50)
      const result = await page.evaluate<{ readonly heading: string; readonly active: string; readonly dropdown: boolean }>(`(() => ({ heading: document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() ?? '', active: document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() ?? '', dropdown: Boolean(document.querySelector('.workspace__rail .workspace-select .custom-select__trigger')) }))()`)
      expect(result).toEqual({ heading: "ycoding", active: "Stream remote output safely", dropdown: false })
    } finally { await page.close() }
  }, 30_000)

  test("opens a newly created Session in another repository and follows its sidebar workspace", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .pane__head--sessions button') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.workspace__rail .pane__head--sessions button').click()`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.new-session-composer .mini-picker__trigger[aria-label="Repository"]') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.new-session-composer .mini-picker__trigger[aria-label="Repository"]').click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`[...document.querySelectorAll('.mini-picker__option')].some(option => option.textContent.includes('Other repository'))`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`[...document.querySelectorAll('.mini-picker__option')].find(option => option.textContent.includes('Other repository'))?.click()`)
      await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]').click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('New session') ?? false`); attempt += 1) await Bun.sleep(50)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .session-row--active') !== null`); attempt += 1) await Bun.sleep(50)
      const result = await page.evaluate<{ readonly breadcrumb: string; readonly heading: string; readonly active: string }>(`(() => ({ breadcrumb: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '', heading: document.querySelector('.workspace__rail .session-panel__workspace h3')?.textContent?.trim() ?? '', active: document.querySelector('.workspace__rail .session-row--active .session-row__name')?.textContent?.trim() ?? '' }))()`)
      expect(result).toEqual({ breadcrumb: "New session", heading: "other", active: "New session" })
    } finally { await page.close() }
  }, 30_000)

  test("keeps workspace switching on the Sessions page at desktop and phone widths", async () => {
    for (const width of [1440, 390]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=session-list-${width === 390 ? 390 : 1440}`)
        for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('.sessions-page__title') !== null`); attempt += 1) await Bun.sleep(50)
        if (width === 1440) await page.evaluate(`document.querySelector('.workspace-nav__item[title="/workspace/telemetry-daemon"]').click()`)
        else {
          await page.evaluate(`document.querySelector('.sessions-page__workspace-select .custom-select__trigger').click()`)
          for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog .custom-select__option') !== null`); attempt += 1) await Bun.sleep(50)
          await page.evaluate(`[...document.querySelectorAll('.custom-select__dialog .custom-select__option')].find(option => option.textContent.includes('telemetry-daemon'))?.click()`)
          await page.evaluate(`document.querySelector('.custom-select__confirm').click()`)
        }
        for (let attempt = 0; attempt < 60 && await page.evaluate<string>(`document.querySelector('.sessions-page__title')?.textContent?.trim() ?? ''`) !== "telemetry-daemon"; attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('.sessions-page__title')?.textContent?.trim() ?? ''`)).toBe("telemetry-daemon")
      } finally { await page.close() }
    }
  }, 30_000)
  test("keeps the selected Session and draft stable through a rendered reconnect", async () => {
    const page = await fixture("view=chat", 390, "Stream remote output safely")
    try {
      const initial = await page.evaluate<{ readonly status: string; readonly title: string; readonly draft: string; readonly disabled: boolean }>(`(() => {
        const input = document.querySelector('.composer__input');
        input.value = 'Keep this unsent draft';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        const read = () => {
          const strip = document.querySelector('.status-strip');
          return {
            status: strip?.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
            title: document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? '',
            draft: document.querySelector('.composer__input')?.value ?? '',
            disabled: document.querySelector('button[aria-label="Send prompt"]')?.disabled ?? true,
            top: strip?.getBoundingClientRect().top ?? -1,
            height: strip?.getBoundingClientRect().height ?? -1,
          };
        };
        window.reconnectSamples = [read()];
        window.reconnectObserver = new MutationObserver(() => {
          const next = read();
          if (JSON.stringify(window.reconnectSamples.at(-1)) !== JSON.stringify(next)) window.reconnectSamples.push(next);
        });
        window.reconnectObserver.observe(document.querySelector('.app'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled'] });
        return read();
      })()`)
      expect(initial).toMatchObject({ status: "Connected — Relay session active for Studio Mac.", title: "Stream remote output safely", draft: "Keep this unsent draft", disabled: false })

      await page.evaluate(`document.querySelector('.fixture__controls button:nth-child(2)')?.click()`)
      expect(await page.evaluate<{ readonly status: string; readonly disabled: boolean }>(`window.reconnectSamples.at(-1)`)).toMatchObject({ status: "Connecting — Opening the relay connection.", disabled: true })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.notice-strip')?.textContent?.includes('Reconnected.') ?? false`)) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<string>(`document.querySelector('.notice-strip')?.textContent ?? ''`)).toContain("Reconnected.")
      const samples = await page.evaluate<readonly { readonly status: string; readonly title: string; readonly draft: string; readonly disabled: boolean; readonly top: number; readonly height: number }[]>(`(() => {
        window.reconnectObserver.disconnect();
        return window.reconnectSamples;
      })()`)
      expect(samples.at(-1)).toMatchObject({ status: initial.status, title: initial.title, draft: initial.draft, disabled: false })
      expect(samples.some((sample) => sample.status.startsWith("Connecting"))).toBe(true)
      expect(samples.every((sample) => sample.title === initial.title && sample.draft === initial.draft && !sample.status.startsWith("Signed out"))).toBe(true)
      expect(samples.every((sample) => Math.abs(sample.top - samples[0]!.top) <= 1 && Math.abs(sample.height - samples[0]!.height) <= 1)).toBe(true)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("keeps unsent prompts with the Session where they were drafted", async () => {
    const page = await fixture("view=chat", 390, "Stream remote output safely")
    try {
      await page.evaluate(`(() => {
        const input = document.querySelector('.composer__input');
        input.value = 'Work only in Session A';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        document.querySelectorAll('.session-row')[1]?.click();
      })()`)
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Archived: release notes")
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("")
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Send prompt"]')?.disabled === true`)).toBe(true)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
      await page.evaluate(`document.querySelectorAll('.session-row')[0]?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('.composer__input')?.value ?? ''`)).toBe("Work only in Session A")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("loads Unicode shell output through the rendered page controls", async () => {
    const page = await fixture("view=chat", 390, "bun test --verbose")
    const output = () => page.evaluate<readonly { readonly command: string; readonly output?: string; readonly buttons: readonly string[] }[]>(`window.remoteShellOutputReport()`)
    const paged = async () => (await output()).find((row) => row.command === "bun test --verbose")
    const click = (label: string) => page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.shell')].find(shell => shell.querySelector('.shell__header code')?.textContent === 'bun test --verbose');
      [...(row?.querySelectorAll('.transcript-shell-output button') ?? [])].find(button => button.textContent?.trim() === ${JSON.stringify(label)})?.click();
    })()`)
    try {
      expect((await paged())?.buttons).toContain("Show more")
      await click("Show more")
      expect((await paged())?.output).toContain("line 30: compiled module 29.ts")
      expect((await paged())?.output).not.toContain("λ unicode")
      expect((await paged())?.buttons).toContain("Load more output")

      await click("Load more output")
      for (let attempt = 0; attempt < 30 && !(await paged())?.output?.includes("λ unicode"); attempt++) await Bun.sleep(50)
      expect((await paged())?.output).toContain("λ unicode · page two arrived from the device")
      expect((await paged())?.buttons).toContain("Load more output")

      await click("Load more output")
      for (let attempt = 0; attempt < 30 && !(await paged())?.output?.includes("final line"); attempt++) await Bun.sleep(50)
      expect((await paged())?.output).toContain("final line")
      expect((await paged())?.buttons).not.toContain("Load more output")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("pages rendered Unicode shell output over the browser relay wire", async () => {
    const second = "λ unicode · page two arrived from the device\n"
    const third = "final line\n"
    const secondBytes = new TextEncoder().encode(second).length
    let firstBytes = 0
    const size = () => firstBytes + secondBytes + new TextEncoder().encode(third).length
    const relay = await startRelayDouble({
      handler: (request) => {
        if (request.operation !== "session.shell.output") return "default"
        if (request.input?.cursor === firstBytes) return { ok: true, value: { data: { output: second, cursor: firstBytes + secondBytes, size: size(), truncated: false } } }
        if (request.input?.cursor === firstBytes + secondBytes) return { ok: true, value: { data: { output: third, cursor: size(), size: size(), truncated: false } } }
        return "default"
      },
    })
    try {
      const page = await fixture(`view=chat&relay=${encodeURIComponent(relay.wsURL("dev_studio"))}`, 390, "bun test --verbose")
      const output = () => page.evaluate<readonly { readonly command: string; readonly output?: string; readonly buttons: readonly string[] }[]>(`window.remoteShellOutputReport()`)
      const paged = async () => (await output()).find((row) => row.command === "bun test --verbose")
      const click = (label: string) => page.evaluate(`(() => {
        const row = [...document.querySelectorAll('.shell')].find(shell => shell.querySelector('.shell__header code')?.textContent === 'bun test --verbose');
        [...(row?.querySelectorAll('.transcript-shell-output button') ?? [])].find(button => button.textContent?.trim() === ${JSON.stringify(label)})?.click();
      })()`)
      try {
        await click("Show more")
        const first = (await paged())?.output ?? ""
        expect(first).toContain("line 30: compiled module 29.ts")
        firstBytes = new TextEncoder().encode(first).length
        expect(secondBytes).toBeGreaterThan(second.length)

        await click("Load more output")
        for (let attempt = 0; attempt < 30 && (await paged())?.output !== first + second; attempt++) await Bun.sleep(50)
        expect((await paged())?.output).toBe(first + second)
        await click("Load more output")
        for (let attempt = 0; attempt < 30 && (await paged())?.output !== first + second + third; attempt++) await Bun.sleep(50)
        expect((await paged())?.output).toBe(first + second + third)
        expect((await paged())?.buttons).not.toContain("Load more output")
        expect(relay.rejectedFrames).toEqual([])
        expect(relay.requests.map((request) => ({ operation: request.operation, sessionID: request.sessionID, input: request.input }))).toEqual([
          { operation: "session.shell.output", sessionID: "ses_fixture", input: { shellID: "sh_paged", cursor: firstBytes, limit: 65_536 } },
          { operation: "session.shell.output", sessionID: "ses_fixture", input: { shellID: "sh_paged", cursor: firstBytes + secondBytes, limit: 65_536 } },
        ])
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      } finally {
        await page.close()
      }
    } finally {
      await relay.stop()
    }
  }, 30_000)

  test("opens a recorded file patch in Activity without escaping the mobile viewport", async () => {
    const page = await fixture("view=activity&files=recorded", 320, "src/remote/store.ts")
    const button = await page.evaluate<boolean>(`[...document.querySelectorAll('.activity-row--file button')].some(button => button.textContent?.includes('View diff'))`)
    expect(button).toBe(true)
    expect(await page.evaluate<string>(`document.querySelector('.activity-row--file button')?.getAttribute('aria-label') ?? ''`)).toBe("View diff for src/remote/store.ts")
    await page.evaluate(`document.querySelector('.activity-row--file button')?.click()`)
    const expanded = await page.evaluate<{ readonly text: string; readonly injected: boolean; readonly pageOverflow: boolean; readonly localScroll: boolean }>(`(() => {
      const row = document.querySelector('.activity-row--file')
      const output = row?.querySelector('pre')
      return {
        text: output?.textContent ?? '',
        injected: row?.querySelector('img') !== null,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        localScroll: output instanceof HTMLElement && output.scrollWidth > output.clientWidth,
      }
    })()`)
    expect(expanded.text).toContain('@@ -1 +1 @@')
    expect(expanded.text).toContain('<img src=x onerror=alert(1)>')
    expect(expanded.injected).toBe(false)
    expect(expanded.pageOverflow).toBe(false)
    expect(expanded.localScroll).toBe(true)
    await page.evaluate(`document.querySelector('.fixture__controls button')?.click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.activity-row--file button')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.activity-row--file pre') !== null`)).toBe(true)
    await page.close()
  }, 30_000)

  test("keeps an unknown prompt retry and notice with its owning Session", async () => {
    const page = await fixture("view=chat&promptOutcome=unknown", 390, "Stream remote output safely")
    await page.evaluate(`(() => {
      const input=document.querySelector('.composer__input');
      input.value='Work on A';
      input.dispatchEvent(new InputEvent('input',{bubbles:true}));
      document.querySelector('button[aria-label="Send prompt"]')?.click();
    })()`)
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await page.evaluate<boolean>(`document.querySelector('.mutation--unknown') !== null`)) break
      await Bun.sleep(50)
    }
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown .button').length`)).toBe(2)
    await page.evaluate(`document.querySelectorAll('.session-row')[1]?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Archived: release notes")
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown').length`)).toBe(0)
    expect(await page.evaluate<string>(`document.querySelector('.notice-strip--warning')?.textContent ?? ''`)).toBe("")
    await page.evaluate(`document.querySelectorAll('.session-row')[0]?.click()`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown').length`)).toBe(1)
    expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown .button').length`)).toBe(2)
    expect(await page.evaluate<string>(`document.querySelector('.notice-strip--warning')?.textContent ?? ''`)).toContain("Nothing was resent automatically")
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request=>request.operation==='session.prompt').length`)).toBe(1)
    await page.close()
  }, 30_000)

  test("uses the SVG chevron primitive without polluting the Device control name at compact and desktop widths", async () => {
    for (const width of [390, 1440] as const) {
      const page = await fixture("scenario=conversation-workspace-768", width, "Studio Mac")
      const state = await page.evaluate<{
        readonly controlName: string
        readonly glyph: boolean
        readonly path: boolean
        readonly hidden: string | null
        readonly icon: { readonly top: number; readonly bottom: number; readonly triggerTop: number; readonly triggerBottom: number }
        readonly label: { readonly right: number; readonly iconLeft: number; readonly scrollWidth: number; readonly width: number }
      }>(`(() => {
        const trigger=document.querySelector('[aria-label="Machine"]');
        const icon=trigger?.querySelector('.custom-select__chevron');
        const label=trigger?.querySelector('.custom-select__value');
        const iconBox=icon?.getBoundingClientRect();
        const triggerBox=trigger?.getBoundingClientRect();
        const labelBox=label?.getBoundingClientRect();
        return {
          controlName:trigger?.getAttribute('aria-label') ?? '',
          glyph:icon?.textContent?.trim() === '⌄',
          path:icon?.querySelector('svg path') !== null,
          hidden:icon?.getAttribute('aria-hidden') ?? null,
          icon:{top:iconBox?.top ?? 0,bottom:iconBox?.bottom ?? 0,triggerTop:triggerBox?.top ?? 0,triggerBottom:triggerBox?.bottom ?? 0},
          label:{right:labelBox?.right ?? 0,iconLeft:iconBox?.left ?? 0,scrollWidth:label?.scrollWidth ?? 0,width:label?.clientWidth ?? 0},
        };
      })()`)
      expect(state.controlName).toBe("Machine")
      expect(state.glyph).toBe(false)
      expect(state.path).toBe(true)
      expect(state.hidden).toBe("true")
      expect(state.icon.top).toBeGreaterThanOrEqual(state.icon.triggerTop)
      expect(state.icon.bottom).toBeLessThanOrEqual(state.icon.triggerBottom)
      expect(state.label.right).toBeLessThanOrEqual(state.label.iconLeft)
      expect(state.label.scrollWidth).toBeGreaterThanOrEqual(state.label.width)
      await page.evaluate(`document.querySelector('[aria-label="Machine"]')?.focus()`)
      await page.pressKey("Enter", "Enter", 13)
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[role="listbox"]') !== null`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Machine'`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("centers unavailable and empty-state stacks in the usable main column without overflow", async () => {
    for (const width of [2048, 1440, 768, 390] as const) {
      const page = await fixture("view=chat&account=unavailable&sessions=empty", width, "Remote access is not available")
      const state = await page.evaluate<{
        readonly headingCenter: number
        readonly actionsCenter: number
        readonly mainCenter: number
        readonly order: boolean
        readonly emptyCards: number
        readonly overflow: boolean
      }>(`(() => {
        const main=document.querySelector('.workspace__main')?.getBoundingClientRect();
        const heading=document.querySelector('.page-head')?.getBoundingClientRect();
        const actions=document.querySelector('.workspace__main .pane')?.getBoundingClientRect();
        return {
          headingCenter:(heading?.left ?? 0)+(heading?.width ?? 0)/2,
          actionsCenter:(actions?.left ?? 0)+(actions?.width ?? 0)/2,
          mainCenter:(main?.left ?? 0)+(main?.width ?? 0)/2,
          order:(heading?.bottom ?? Infinity) <= (actions?.top ?? -Infinity),
          emptyCards:document.querySelectorAll('.workspace__main .empty').length,
          overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      })()`)
      expect(Math.abs(state.headingCenter - state.mainCenter)).toBeLessThanOrEqual(1)
      expect(Math.abs(state.actionsCenter - state.mainCenter)).toBeLessThanOrEqual(1)
      expect(state.order).toBe(true)
      expect(state.emptyCards).toBe(0)
      expect(state.overflow).toBe(false)
      await page.close()
    }
  }, 30_000)

  test("marks the active route in desktop and mobile navigation and follows keyboard activation", async () => {
    for (const [width, path, label] of [[1440, "/remote/sessions", "Sessions"], [390, "/remote/settings", "Settings"]] as const) {
      const page = await fixture(`view=${path.slice("/remote/".length)}&sessions=empty`, width, label)
      const active = await page.evaluate<string | null>(`document.querySelector('.remote-nav a[aria-current="page"]')?.textContent?.trim() ?? null`)
      expect(active).toBe(label)
      await page.evaluate(`(() => { const link=document.querySelector('.remote-nav a[href="/remote/activity"]'); link?.focus(); link?.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'})); })()`)
      expect(await page.evaluate<boolean>(`location.pathname === '/remote/activity'`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps one vertical scroll owner and one aligned responsive content column", async () => {
    for (const width of [1440, 768, 390] as const) {
      const page = await fixture("view=settings", width, "Notifications")
      const state = await page.evaluate<{
        readonly scrollOwners: number
        readonly documentScrollable: boolean
        readonly documentHeights: readonly number[]
        readonly edges: readonly { readonly left: number; readonly right: number }[]
        readonly overflow: boolean
        readonly finalControlReachable: boolean
      }>(`(() => {
        document.querySelector('.fixture__banner')?.remove();
        document.querySelector('.fixture__controls')?.remove();
        const fixture=document.querySelector('.fixture');
        if (fixture instanceof HTMLElement) { fixture.style.minHeight='0'; fixture.style.height='100dvh'; fixture.style.overflow='hidden'; }
        const elements=[document.scrollingElement,...document.querySelectorAll('.app,.workspace,.workspace__main,.workspace__scroll')].filter(element=>element instanceof HTMLElement);
        const scrollOwners=elements.filter(element=>element.scrollHeight > element.clientHeight + 1 && ['auto','scroll'].includes(getComputedStyle(element).overflowY)).length;
        const surfaces=[...document.querySelectorAll('.settings > *, .settings__section, .settings__guardrail-note')].filter(element=>element instanceof HTMLElement&&element.getBoundingClientRect().width>0).slice(0,5).map(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right}});
        const scroll=document.querySelector('.workspace__scroll');
        if (scroll instanceof HTMLElement) scroll.scrollTop=scroll.scrollHeight;
        const final=[...document.querySelectorAll('.workspace__scroll button')].at(-1)?.getBoundingClientRect();
        const scrollBox=scroll?.getBoundingClientRect();
        return {
          scrollOwners,
          documentScrollable:document.documentElement.scrollHeight > document.documentElement.clientHeight + 1 && ['auto','scroll'].includes(getComputedStyle(document.documentElement).overflowY),
          documentHeights:[document.documentElement.scrollHeight,document.documentElement.clientHeight],
          edges:surfaces,
          overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
          finalControlReachable:(final?.bottom ?? Infinity) <= (scrollBox?.bottom ?? -Infinity),
        };
      })()`)
      expect(state.scrollOwners).toBe(1)
      expect(state.documentScrollable, JSON.stringify(state)).toBe(false)
      expect(state.edges.length).toBeGreaterThan(1)
      expect(state.edges.every((edge) => Math.abs(edge.left - state.edges[0]!.left) <= 1 && Math.abs(edge.right - state.edges[0]!.right) <= 1)).toBe(true)
      expect(state.overflow).toBe(false)
      expect(state.finalControlReachable).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps the mobile machine picker usable over the five-tab conversation workspace", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("scenario=conversation-workspace-390", 390, "Select Active Machine", theme, 620)
      await page.evaluate(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
      const state = await page.evaluate<{
        readonly brandVisible: boolean
        readonly tabs: readonly string[]
        readonly sheet: { readonly top: number; readonly bottom: number }
        readonly options: readonly { readonly label: string; readonly height: number }[]
        readonly overflow: boolean
      }>(`(() => {
        const box=document.querySelector('.custom-select__dialog .overlay__surface')?.getBoundingClientRect();
        return {
          brandVisible:document.querySelector('.app-header .brand img') instanceof HTMLImageElement && document.querySelector('.app-header .brand img').getBoundingClientRect().width > 0,
          tabs:[...document.querySelectorAll('.bottom-nav__item')].filter(link=>link.getBoundingClientRect().width>0).map(link=>link.textContent.trim()),
          sheet:{top:box?.top ?? 0,bottom:box?.bottom ?? 0},
          options:[...document.querySelectorAll('.custom-select__option')].map(option=>({label:option.querySelector('.custom-select__option-body')?.textContent.trim() ?? '',height:option.getBoundingClientRect().height})),
          overflow:document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(state.brandVisible).toBe(true)
      expect(state.tabs).toEqual(["Sessions", "Conversation", "Activity", "Usage", "Settings"])
      expect(state.sheet.bottom).toBeCloseTo(620, 0)
      expect(state.sheet.top).toBeLessThan(state.sheet.bottom)
      expect(state.options.map((option) => option.label)).toEqual(["Studio Mac", "Dev Linux"])
      expect(state.options.every((option) => option.height >= 44)).toBe(true)
      expect(state.overflow).toBe(false)
      await page.evaluate(`document.querySelector('.custom-select__option[aria-selected="false"]')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      await page.evaluate(`document.querySelector('.custom-select__confirm')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      expect(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog') === null`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps the mobile composer compact and sizes dense controls for the active pointer", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("scenario=conversation-tool-terminal-output-390", 390, "Run sanity checks on worker threads.", theme, 620)
      const state = await page.evaluate<{
        readonly height: number
        readonly input: number
        readonly mobileTrigger: number
        readonly actions: readonly { readonly label: string; readonly height: number }[]
        readonly messages: number
        readonly overflow: boolean
      }>(`(() => {
        const composer=document.querySelector('.composer');
        return {
          height:composer?.getBoundingClientRect().height ?? 0,
          input:composer?.querySelector('.composer__input')?.getBoundingClientRect().height ?? 0,
          mobileTrigger:document.querySelector('.composer__mobile-trigger')?.getBoundingClientRect().height ?? 0,
          actions:[...composer?.querySelectorAll('button') ?? []].filter(button=>button.getBoundingClientRect().width>0).map(button=>({label:button.getAttribute('aria-label') ?? button.textContent.trim(),height:button.getBoundingClientRect().height})),
          messages:document.querySelectorAll('.transcript > .transcript-navigation__item > .transcript-message').length,
          overflow:document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(state.height).toBeLessThanOrEqual(160)
      expect(state.input).toBeGreaterThanOrEqual(44)
      expect(state.mobileTrigger).toBeGreaterThanOrEqual(44)
      expect(state.actions.map((action) => action.label)).toContain("Send prompt")
      expect(state.actions.every((action) => action.height >= 36), JSON.stringify(state.actions)).toBe(true)
      expect(state.messages).toBe(2)
      expect(state.overflow).toBe(false)
      await page.setCoarsePointer(true)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.composer button,.composer__mobile-trigger')].filter(button => button.getBoundingClientRect().width > 0).every(button => button.getBoundingClientRect().height >= 44)`)).toBe(true)
      await page.evaluate(`document.querySelector('.composer__delivery-toggle')?.click()`)
      expect(await page.evaluate<string | null>(`document.querySelector('.composer__delivery-toggle')?.getAttribute('aria-pressed') ?? null`)).toBe("true")
      await page.close()
    }
  }, 30_000)

  test("keeps mobile Activity decisions and event actions visible in a compact layout", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("scenario=activity-pending-decisions-390", 390, "Authorize branch push for feat/ast-cache", theme, 901)
      const state = await page.evaluate<{
        readonly sectionPadding: readonly number[]
        readonly eventRows: number
        readonly decisions: number
        readonly actions: readonly { readonly label: string; readonly height: number }[]
        readonly overflow: boolean
      }>(`(() => ({
        sectionPadding:[...document.querySelectorAll('.activity-page__events,.activity-page__decisions')].map(element=>parseFloat(getComputedStyle(element).paddingTop)),
        eventRows:document.querySelectorAll('.activity-page__events .activity-row').length,
        decisions:document.querySelectorAll('.activity-page__decisions .request').length,
        actions:[...document.querySelectorAll('.activity-page__decisions .request__actions button')].map(button=>({label:button.textContent.trim(),height:button.getBoundingClientRect().height})),
        overflow:document.documentElement.scrollWidth > innerWidth,
      }))()`)
      expect(state.sectionPadding.every((padding) => padding <= 16)).toBe(true)
      expect(state.eventRows).toBeGreaterThan(0)
      expect(state.decisions).toBe(2)
      expect(state.actions.map((action) => action.label)).toContain("Approve once")
      expect(state.actions.every((action) => action.height >= 44), JSON.stringify(state.actions)).toBe(true)
      expect(state.overflow).toBe(false)
      await page.close()
    }
  }, 30_000)

  test("keeps remote scenarios usable at 320, 390, 768, and 1440px in both themes", async () => {
    for (const width of [320, 390, 768, 1440] as const) {
      for (const theme of ["dark", "light"] as const) {
        const workspace = await fixture("scenario=conversation-workspace-390", width, "Token expiry refactor", theme, 901)
        const workspaceState = await workspace.evaluate<{ readonly overflow: boolean; readonly trigger: number; readonly tabs: number }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          trigger:document.querySelector('[aria-label="Machine"]')?.getBoundingClientRect().height ?? 0,
          tabs:[...document.querySelectorAll('.bottom-nav__item')].filter(item=>item.getBoundingClientRect().width>0).length,
        }))()`)
        expect(workspaceState.overflow).toBe(false)
        expect(workspaceState.trigger).toBeGreaterThanOrEqual(44)
        expect(workspaceState.tabs).toBe(width < 768 ? 5 : 0)
        expect(await workspace.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await workspace.close()

        const conversation = await fixture("scenario=conversation-tool-terminal-output-390", width, "Run sanity checks on worker threads.", theme, 901)
        const conversationState = await conversation.evaluate<{ readonly overflow: boolean; readonly messages: number; readonly input: number; readonly inputWidth: number; readonly send: number }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          messages:document.querySelectorAll('.transcript > .transcript-navigation__item > .transcript-message').length,
          input:document.querySelector('.composer__input')?.getBoundingClientRect().height ?? 0,
          inputWidth:document.querySelector('.composer__input')?.getBoundingClientRect().width ?? 0,
          send:document.querySelector('[aria-label="Send prompt"]')?.getBoundingClientRect().height ?? 0,
        }))()`)
        expect(conversationState.overflow).toBe(false)
        expect(conversationState.messages).toBe(2)
        expect(conversationState.input).toBeGreaterThanOrEqual(44)
        expect(conversationState.send).toBeGreaterThanOrEqual(36)
        if (width < 480) expect(conversationState.inputWidth, `${width}px composer input`).toBeGreaterThanOrEqual(96)
        expect(await conversation.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await conversation.close()

        const activity = await fixture("scenario=activity-pending-decisions-390", width, "Authorize branch push for feat/ast-cache", theme, 901)
        const activityState = await activity.evaluate<{ readonly overflow: boolean; readonly rows: number; readonly decisions: number; readonly actions: readonly number[] }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          rows:document.querySelectorAll('.activity-page__events .activity-row').length,
          decisions:document.querySelectorAll('.activity-page__decisions .request').length,
          actions:[...document.querySelectorAll('.activity-page__decisions .request__actions button')].map(button=>button.getBoundingClientRect().height),
        }))()`)
        const activityOrder = await activity.evaluate<{ readonly columns: number; readonly decisionsTop: number; readonly eventsTop: number }>(`(() => {
          const page=document.querySelector('.activity-page')
          if (!(page instanceof HTMLElement)) throw new Error('Activity page missing')
          return {
            columns:getComputedStyle(page).gridTemplateColumns.split(' ').filter(Boolean).length,
            decisionsTop:document.querySelector('.activity-page__decisions')?.getBoundingClientRect().top ?? Infinity,
            eventsTop:document.querySelector('.activity-page__events')?.getBoundingClientRect().top ?? -Infinity,
          }
        })()`)
        expect(activityState.overflow).toBe(false)
        expect(activityState.rows).toBeGreaterThan(0)
        expect(activityState.decisions).toBe(2)
        expect(activityOrder.columns).toBe(width < 1280 ? 1 : 2)
        if (width < 1280) expect(activityOrder.decisionsTop).toBeLessThan(activityOrder.eventsTop)
        if (width < 1024) expect(activityState.actions.every((height) => height >= 44)).toBe(true)
        expect(await activity.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await activity.close()
      }
    }
  }, 60_000)
})

async function fixture(query: string, width: number, expected: string, theme?: "dark" | "light", height = 1366) {
  const page = await requireBrowser().openPage()
  await page.setViewport(width, height)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(expected)})`)) {
      if (theme !== undefined) await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      return page
    }
    await Bun.sleep(100)
  }
  await page.close()
  throw new Error(`${query} at ${width}px did not settle`)
}

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/verify/remote.html`)).ok
  } catch {
    return false
  }
}
