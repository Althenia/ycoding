import { afterAll, beforeAll, describe, expect, test } from "bun:test"
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
    await page.evaluate(`document.querySelectorAll('.session-row')[2]?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`)).toContain("Child: fix flaky suite")
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
      const page = await fixture("stitch=r01&specimen=768", width, "Studio Mac")
      const state = await page.evaluate<{
        readonly controlName: string
        readonly glyph: boolean
        readonly path: boolean
        readonly hidden: string | null
        readonly icon: { readonly top: number; readonly bottom: number; readonly triggerTop: number; readonly triggerBottom: number }
        readonly label: { readonly right: number; readonly iconLeft: number; readonly scrollWidth: number; readonly width: number }
      }>(`(() => {
        const trigger=document.querySelector('[aria-label="Device"]');
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
      expect(state.controlName).toBe("Device")
      expect(state.glyph).toBe(false)
      expect(state.path).toBe(true)
      expect(state.hidden).toBe("true")
      expect(state.icon.top).toBeGreaterThanOrEqual(state.icon.triggerTop)
      expect(state.icon.bottom).toBeLessThanOrEqual(state.icon.triggerBottom)
      expect(state.label.right).toBeLessThanOrEqual(state.label.iconLeft)
      expect(state.label.scrollWidth).toBeGreaterThanOrEqual(state.label.width)
      await page.evaluate(`document.querySelector('[aria-label="Device"]')?.focus()`)
      await page.pressKey("Enter", "Enter", 13)
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Device"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[role="listbox"]') !== null`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Device'`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("centers unavailable and empty-state stacks in the usable main column without overflow", async () => {
    for (const width of [2048, 1440, 768, 390] as const) {
      const page = await fixture("view=conversation&account=unavailable&sessions=empty", width, "Remote access is not available")
      const state = await page.evaluate<{
        readonly panelCenter: number
        readonly stackCenter: number
        readonly mainCenter: number
        readonly order: boolean
        readonly overflow: boolean
      }>(`(() => {
        const main=document.querySelector('.workspace__main')?.getBoundingClientRect();
        const panel=[...document.querySelectorAll('.empty')].find(element=>element.textContent?.includes('Remote access is not available'))?.getBoundingClientRect();
        const stack=document.querySelector('.app--empty .workspace__scroll > *')?.getBoundingClientRect();
        const empty=[...document.querySelectorAll('.empty')].map(element=>element.getBoundingClientRect());
        return {
          panelCenter:(panel?.left ?? 0)+(panel?.width ?? 0)/2,
          stackCenter:(stack?.left ?? 0)+(stack?.width ?? 0)/2,
          mainCenter:(main?.left ?? 0)+(main?.width ?? 0)/2,
          order:empty.length < 2 || empty[0].bottom <= empty[1].top,
          overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      })()`)
      expect(Math.abs(state.panelCenter - state.mainCenter)).toBeLessThanOrEqual(1)
      expect(Math.abs(state.stackCenter - state.mainCenter)).toBeLessThanOrEqual(1)
      expect(state.order).toBe(true)
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

  test("keeps the R01 mobile device sheet usable over the branded four-tab workspace", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("stitch=r01&specimen=390", 390, "Select Active Device", theme, 620)
      const state = await page.evaluate<{
        readonly brandVisible: boolean
        readonly tabs: readonly string[]
        readonly sheet: { readonly top: number; readonly bottom: number }
        readonly options: readonly { readonly label: string; readonly height: number }[]
        readonly overflow: boolean
      }>(`(() => {
        const box=document.querySelector('.custom-select__surface')?.getBoundingClientRect();
        return {
          brandVisible:document.querySelector('.app-header .brand img') instanceof HTMLImageElement && document.querySelector('.app-header .brand img').getBoundingClientRect().width > 0,
          tabs:[...document.querySelectorAll('.bottom-nav__item')].filter(link=>link.getBoundingClientRect().width>0).map(link=>link.textContent.trim()),
          sheet:{top:box?.top ?? 0,bottom:box?.bottom ?? 0},
          options:[...document.querySelectorAll('.custom-select__option')].map(option=>({label:option.querySelector('.custom-select__option-body')?.textContent.trim() ?? '',height:option.getBoundingClientRect().height})),
          overflow:document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(state.brandVisible).toBe(true)
      expect(state.tabs).toEqual(["Chat", "Activity", "Sessions", "More"])
      expect(state.sheet.bottom).toBeCloseTo(620, 0)
      expect(state.sheet.top).toBeLessThan(state.sheet.bottom)
      expect(state.options.map((option) => option.label)).toEqual(["Studio Mac", "Dev Linux"])
      expect(state.options.every((option) => option.height >= 44)).toBe(true)
      expect(state.overflow).toBe(false)
      await page.evaluate(`document.querySelector('.custom-select__option[aria-selected="false"]')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Device"] .custom-select__value')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      expect(await page.evaluate<boolean>(`document.querySelector('.custom-select__surface') === null`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("keeps the R03 mobile composer compact without shrinking delivery or send controls", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("stitch=r03&specimen=390", 390, "Run sanity checks on worker threads.", theme, 620)
      const state = await page.evaluate<{
        readonly height: number
        readonly input: number
        readonly actions: readonly { readonly label: string; readonly height: number }[]
        readonly messages: number
        readonly overflow: boolean
      }>(`(() => {
        const composer=document.querySelector('.composer');
        return {
          height:composer?.getBoundingClientRect().height ?? 0,
          input:composer?.querySelector('.composer__input')?.getBoundingClientRect().height ?? 0,
          actions:[...composer?.querySelectorAll('button') ?? []].map(button=>({label:button.getAttribute('aria-label') ?? button.textContent.trim(),height:button.getBoundingClientRect().height})),
          messages:document.querySelectorAll('.transcript > .message').length,
          overflow:document.documentElement.scrollWidth > innerWidth,
        };
      })()`)
      expect(state.height).toBeLessThanOrEqual(160)
      expect(state.input).toBeGreaterThanOrEqual(44)
      expect(state.actions.map((action) => action.label)).toContain("Send prompt")
      expect(state.actions.every((action) => action.height >= 44), JSON.stringify(state.actions)).toBe(true)
      expect(state.messages).toBe(2)
      expect(state.overflow).toBe(false)
      await page.evaluate(`document.querySelector('.composer__delivery-option:nth-child(2)')?.click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.composer__delivery-option:nth-child(2)')?.getAttribute('aria-pressed') === 'true'`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("densifies R04 mobile Activity while keeping decisions and event actions visible", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await fixture("stitch=r04&specimen=390", 390, "Authorize branch push for feat/ast-cache", theme, 901)
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

  test("keeps the approved remote families responsive at 320, 390, 768, and 1440px in both themes", async () => {
    for (const width of [320, 390, 768, 1440] as const) {
      for (const theme of ["dark", "light"] as const) {
        const workspace = await fixture("stitch=r01&specimen=390", width, "Token expiry refactor", theme, 901)
        const workspaceState = await workspace.evaluate<{ readonly overflow: boolean; readonly trigger: number; readonly tabs: number }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          trigger:document.querySelector('[aria-label="Device"]')?.getBoundingClientRect().height ?? 0,
          tabs:[...document.querySelectorAll('.bottom-nav__item')].filter(item=>item.getBoundingClientRect().width>0).length,
        }))()`)
        expect(workspaceState.overflow).toBe(false)
        expect(workspaceState.trigger).toBeGreaterThanOrEqual(44)
        expect(workspaceState.tabs).toBe(width < 768 ? 4 : 0)
        expect(await workspace.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await workspace.close()

        const conversation = await fixture("stitch=r03&specimen=390", width, "Run sanity checks on worker threads.", theme, 901)
        const conversationState = await conversation.evaluate<{ readonly overflow: boolean; readonly messages: number; readonly input: number; readonly inputWidth: number; readonly send: number }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          messages:document.querySelectorAll('.transcript > .message').length,
          input:document.querySelector('.composer__input')?.getBoundingClientRect().height ?? 0,
          inputWidth:document.querySelector('.composer__input')?.getBoundingClientRect().width ?? 0,
          send:document.querySelector('[aria-label="Send prompt"]')?.getBoundingClientRect().height ?? 0,
        }))()`)
        expect(conversationState.overflow).toBe(false)
        expect(conversationState.messages).toBe(2)
        expect(conversationState.input).toBeGreaterThanOrEqual(44)
        expect(conversationState.send).toBeGreaterThanOrEqual(44)
        if (width < 480) expect(conversationState.inputWidth, `${width}px composer input`).toBeGreaterThanOrEqual(96)
        expect(await conversation.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(theme)
        await conversation.close()

        const activity = await fixture("stitch=r04&specimen=390", width, "Authorize branch push for feat/ast-cache", theme, 901)
        const activityState = await activity.evaluate<{ readonly overflow: boolean; readonly rows: number; readonly decisions: number; readonly actions: readonly number[] }>(`(() => ({
          overflow:document.documentElement.scrollWidth > innerWidth,
          rows:document.querySelectorAll('.activity-page__events .activity-row').length,
          decisions:document.querySelectorAll('.activity-page__decisions .request').length,
          actions:[...document.querySelectorAll('.activity-page__decisions .request__actions button')].map(button=>button.getBoundingClientRect().height),
        }))()`)
        expect(activityState.overflow).toBe(false)
        expect(activityState.rows).toBeGreaterThan(0)
        expect(activityState.decisions).toBe(2)
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
