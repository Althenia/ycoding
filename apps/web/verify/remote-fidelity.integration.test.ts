import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4189
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
  browser = await launchBrowser(browserPath, 1440, 1200)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("approved remote fidelity invariants", () => {
  test("matches the R01 adaptive workspace ownership and keeps Activity accessible", async () => {
    for (const width of [1440, 768, 390] as const) {
      for (const theme of ["dark", "light"] as const) {
        const page = await scenario("r01", width, "Studio Mac", theme)
        const state = await page.evaluate<{
          readonly columns: number
          readonly railVisible: boolean
          readonly persistentActivity: number
          readonly activityControlVisible: boolean
          readonly activityNavigationVisible: boolean
          readonly bottomNavigationVisible: boolean
        }>(`(() => {
          const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
          const workspace = document.querySelector('.workspace');
          return {
            columns: workspace instanceof HTMLElement ? getComputedStyle(workspace).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
            railVisible: visible(document.querySelector('.workspace__rail')),
            persistentActivity: document.querySelectorAll('.workspace__activity').length,
            activityControlVisible: visible(document.querySelector('button[aria-label="Open activity"]')),
            activityNavigationVisible: [...document.querySelectorAll('a[href="/remote/activity"]')].some(visible),
            bottomNavigationVisible: visible(document.querySelector('.bottom-nav')),
          };
        })()`)
        expect(state.columns).toBe(width >= 768 ? 2 : 1)
        expect(state.railVisible).toBe(width >= 768)
        expect(state.persistentActivity).toBe(0)
        expect(state.activityControlVisible || state.activityNavigationVisible).toBe(true)
        expect(state.bottomNavigationVisible).toBe(width < 768)

        await page.evaluate(`document.querySelector('button[aria-label="Open activity"]')?.click()`)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Activity"]')?.hasAttribute('open') === true`)).toBe(true)
        await page.close()
      }
    }
  }, 30_000)

  test("does not apply the centered conversation-empty composition to Sessions, Activity, or Settings", async () => {
    for (const [view, expected] of [
      ["sessions", "No sessions"],
      ["activity", "No session selected"],
      ["settings", "Account"],
    ] as const) {
      const page = await fixture(`view=${view}&sessions=empty`, 768, expected)
      const state = await page.evaluate<{ readonly classes: string; readonly placeItems: string }>(`(() => {
        const app = document.querySelector('.app');
        const scroll = document.querySelector('.workspace__scroll');
        return {
          classes: app?.className ?? '',
          placeItems: scroll instanceof HTMLElement ? getComputedStyle(scroll).placeItems : '',
        };
      })()`)
      expect(state.classes).toContain(`app--${view}`)
      expect(state.classes).not.toContain("app--empty")
      expect(state.placeItems).not.toContain("center")
      await page.close()
    }
  }, 30_000)

  test("keeps the desktop rail compact and project-oriented", async () => {
    const page = await scenario("r01", 1440, "auth_guard.go")
    const rows = await page.evaluate<readonly { readonly height: number; readonly text: string }[]>(`[...document.querySelectorAll('.session-row')].map(row=>({height:row.getBoundingClientRect().height,text:row.textContent.replace(/\\s+/g,' ').trim()}))`)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.height <= 96)).toBe(true)
    expect(rows[0]?.text).toContain("auth")
    expect(rows[0]?.text).not.toContain("openai/gpt-6")
    await page.close()
  }, 30_000)

  test("uses the compact Sessions composition without a redundant page heading", async () => {
    const page = await scenario("r02", 768, "Postgres Partition Pruning Worker")
    const state = await page.evaluate<{ readonly headingVisible: boolean; readonly columns: number }>(`(() => { const heading=document.querySelector('.sessions-page .page-head'); const grid=document.querySelector('.sessions-table'); return {headingVisible:heading instanceof HTMLElement&&getComputedStyle(heading).display!=='none',columns:grid instanceof HTMLElement?getComputedStyle(grid).gridTemplateColumns.split(' ').length:0} })()`)
    expect(state.headingVisible).toBe(false)
    expect(state.columns).toBe(2)
    await page.close()
  }, 30_000)

  test("keeps every Sessions selection target touch-sized on compact layouts", async () => {
    for (const width of [390, 768] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("r02", width, "Async Auth Token Revocation Migration", theme)
        const targets = await page.evaluate<readonly { readonly height: number; readonly width: number }[]>(`[...document.querySelectorAll('.sessions-table__select')].map(button => ({ height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width }))`)
        expect(targets).toHaveLength(4)
        expect(targets.every((target) => target.height >= 44 && target.width >= 44)).toBe(true)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        await page.close()
      }
    }
  }, 30_000)

  test("shows the selected Session's real state in the mobile conversation context", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await scenario("r01", 390, "Token expiry refactor", theme)
      const status = await page.evaluate<{ readonly label: string; readonly visible: boolean }>(`(() => {
        const chip = document.querySelector('.conversation-breadcrumb .chip');
        return { label: chip?.textContent?.trim() ?? '', visible: chip instanceof HTMLElement && chip.getBoundingClientRect().height > 0 && getComputedStyle(chip.parentElement).display !== 'none' };
      })()`)
      expect(status).toEqual({ label: "Running", visible: true })
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("lays out desktop decisions in two columns with hard and final prompts full width", async () => {
    const page = await scenario("r05", 1440, "Clarify Disambiguation Query")
    const cards = await page.evaluate<readonly { readonly x: number; readonly width: number; readonly hard: boolean }[]>(`[...document.querySelectorAll('.requests>.request')].map(card=>({x:card.getBoundingClientRect().x,width:card.getBoundingClientRect().width,hard:card.classList.contains('request--hard')}))`)
    expect(cards).toHaveLength(6)
    expect(cards[0]?.x).not.toBe(cards[1]?.x)
    expect(cards.find((card) => card.hard)?.width).toBeGreaterThan((cards[0]?.width ?? 0) * 1.8)
    expect(cards.at(-1)?.width).toBeGreaterThan((cards[0]?.width ?? 0) * 1.8)
    await page.close()
  }, 30_000)

  test("keeps compact decision and account actions at least 44px", async () => {
    const tablet = await scenario("r05", 768, "syslog daemon bridge")
    const tabletHeights = await tablet.evaluate<readonly number[]>(`[...document.querySelectorAll('.requests button')].map(button=>button.getBoundingClientRect().height)`)
    expect(tabletHeights.length).toBeGreaterThan(0)
    expect(tabletHeights.every((height) => height >= 44)).toBe(true)
    await tablet.close()

    const mobile = await scenario("r06", 390, "Sign in with Google")
    expect(await mobile.evaluate<number>(`document.querySelector('#account-settings')?.closest('section')?.querySelector('button')?.getBoundingClientRect().height ?? 0`)).toBeGreaterThanOrEqual(44)
    await mobile.close()
  }, 30_000)

  test("keeps loading, signed-out, offline, pending-decision, revoked-device, and selected-session states truthful", async () => {
    const pending = await fixture("view=settings&account=pending", 768, "Checking account")
    const pendingText = await pending.evaluate<string>(`document.body.innerText`)
    expect(pendingText).not.toContain("Signed out")
    expect(pendingText).not.toContain("Sign in with Google")
    await pending.close()

    const signedOut = await scenario("r06", 390, "Sign in with Google")
    const signedOutText = await signedOut.evaluate<string>(`document.querySelector('#account-settings')?.closest('section')?.innerText ?? ''`)
    expect(signedOutText).toContain("not signed in")
    expect(signedOutText).toContain("Sign in with Google")
    await signedOut.close()

    const offline = await scenario("r06", 768, "Reconnect")
    expect(await offline.evaluate<string>(`document.querySelector('.status-strip')?.innerText ?? ''`)).toContain("Studio Mac is not reachable")
    await offline.close()

    const decisions = await scenario("r04", 1440, "Authorize branch push for feat/ast-cache")
    expect(await decisions.evaluate<number>(`document.querySelectorAll('.activity-page__decisions .request').length`)).toBe(2)
    await decisions.close()

    const devices = await scenario("r07", 1440, "Enrollment code (shown once)")
    const deviceState = await devices.evaluate<{ readonly account: string; readonly revokedActions: number; readonly selected: boolean }>(`(() => {
      const rows=[...document.querySelectorAll('.device-table .device')];
      const revoked=rows.find(row=>row.textContent.includes('Legacy-MacBook'));
      return {
        account:document.querySelector('#account-settings')?.closest('section')?.innerText ?? '',
        revokedActions:revoked?.querySelectorAll('button').length ?? -1,
        selected:document.querySelector('.app')?.classList.contains('app--selected') ?? false,
      };
    })()`)
    expect(deviceState.account).toContain("account_fixture")
    expect(deviceState.account).not.toContain("[account name]")
    expect(deviceState.revokedActions).toBe(0)
    expect(deviceState.selected).toBe(true)
    await devices.close()
  }, 30_000)

  test("renders truthful permission and guardrail actions without unsupported controls", async () => {
    const page = await scenario("r05", 1440, "Clarify Disambiguation Query")
    const actions = await page.evaluate<{
      readonly hard: readonly string[]
      readonly ordinary: readonly string[]
      readonly permission: readonly string[]
      readonly unsupported: readonly string[]
    }>(`(() => {
      const text = selector => [...document.querySelectorAll(selector)].map(button=>button.textContent.trim());
      return {
        hard:text('.request--hard .request__actions button'),
        ordinary:text('.request--guardrail:not(.request--hard) .request__actions button'),
        permission:text('.request--permission .request__actions button'),
        unsupported:['New Session','Retry','Permission Guardrail'].filter(label=>document.body.innerText.includes(label)),
      };
    })()`)
    expect(actions.hard).toEqual(["Approve once", "Reject"])
    expect(actions.ordinary).toEqual(["Approve once", "Always this process", "Reject"])
    expect(actions.permission).toEqual(["Approve once", "Always this session", "Deny"])
    expect(actions.unsupported).toEqual([])
    await page.close()
  }, 30_000)

  test("supports keyboard and coarse-pointer operation for device, delivery, autonomy, and overlays", async () => {
    const workspace = await scenario("r01", 768, "Run test suite against auth services.")
    await workspace.evaluate(`document.querySelector('[aria-label="Device"]')?.focus()`)
    await workspace.pressKey("Enter", "Enter", 13)
    expect(await workspace.evaluate<boolean>(`document.querySelector('[aria-label="Device"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[role="listbox"]') !== null`)).toBe(true)
    await workspace.pressEscape()
    expect(await workspace.evaluate<boolean>(`document.querySelector('[aria-label="Device"]')?.getAttribute('aria-expanded') === 'false' && document.activeElement?.getAttribute('aria-label') === 'Device'`)).toBe(true)

    await workspace.evaluate(`document.querySelector('.composer__delivery-option:nth-child(2)')?.focus()`)
    expect(await workspace.evaluate<boolean>(`document.activeElement?.textContent?.trim() === 'Queue'`)).toBe(true)
    await workspace.pressKey(" ", "Space", 32)
    expect(await workspace.evaluate<boolean>(`document.querySelector('.composer__delivery-option:nth-child(2)')?.getAttribute('aria-pressed') === 'true'`)).toBe(true)

    await workspace.evaluate(`document.querySelector('button[aria-label="Open activity"]')?.focus()`)
    await workspace.pressKey(" ", "Space", 32)
    expect(await workspace.evaluate<boolean>(`document.querySelector('dialog[aria-label="Activity"]')?.hasAttribute('open') === true`)).toBe(true)
    await workspace.pressEscape()
    await workspace.close()

    const settings = await scenario("r08", 390, "Mobile refactor")
    await settings.setCoarsePointer(true)
    const coarse = await settings.evaluate<{ readonly minimum: number; readonly themes: number; readonly autonomy: number }>(`(() => {
      const appearance=document.querySelector('#appearance-settings')?.closest('section');
      const autonomy=document.querySelector('#autonomy-settings')?.closest('section');
      const controls=[...appearance.querySelectorAll('button'),...autonomy.querySelectorAll('button')].filter(button=>button.getBoundingClientRect().width>0);
      return {
        minimum:Math.min(...controls.map(control=>control.getBoundingClientRect().height)),
        themes:appearance.querySelectorAll('[role="radio"]').length,
        autonomy:autonomy.querySelectorAll('[role="radio"]').length,
      };
    })()`)
    expect(coarse.minimum).toBeGreaterThanOrEqual(44)
    expect(coarse.themes).toBe(3)
    expect(coarse.autonomy).toBe(4)
    await settings.evaluate(`[...document.querySelector('#autonomy-settings').closest('section').querySelectorAll('[role="radio"]')].find(button=>button.textContent.includes('YOLO 3'))?.focus()`)
    await settings.pressKey(" ", "Space", 32)
    expect(await settings.evaluate<boolean>(`[...document.querySelector('#autonomy-settings').closest('section').querySelectorAll('[role="radio"]')].find(button=>button.textContent.includes('YOLO 3'))?.getAttribute('aria-checked') === 'true'`)).toBe(true)
    await settings.close()
  }, 30_000)

  test("uses source order and density for the actual Settings controls", async () => {
    const mobile = await scenario("r08", 390, "Device disconnected")
    const state = await mobile.evaluate<{ readonly categoriesHidden: boolean; readonly themes: readonly string[]; readonly headingSizes: readonly number[] }>(`(() => ({
      categoriesHidden:[...document.querySelectorAll('#appearance-settings,#autonomy-settings,#notification-settings')].every(heading=>{const section=heading.closest('section');const category=section?.querySelector('.settings__category');return category instanceof HTMLElement&&getComputedStyle(category).display==='none'}),
      themes:[...document.querySelectorAll('.appearance-segments [role="radio"]')].map(button=>button.textContent.trim()).slice(0,3),
      headingSizes:[...document.querySelectorAll('#appearance-settings,#autonomy-settings,#notification-settings')].map(heading=>parseFloat(getComputedStyle(heading).fontSize))
    }))()`)
    expect(state.categoriesHidden).toBe(true)
    expect(state.themes).toEqual(["System", "Light", "Dark"])
    expect(state.headingSizes.every((size) => size <= 16)).toBe(true)
    await mobile.close()
  }, 30_000)
})

async function scenario(family: string, width: number, expected: string, theme?: "dark" | "light") {
  return fixture(`stitch=${family}&specimen=${width}`, width, expected, theme)
}

async function fixture(query: string, width: number, expected: string, theme?: "dark" | "light") {
  const page = await requireBrowser().openPage()
  await page.setViewport(width, 1600)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(expected)})`)) {
      if (theme !== undefined) {
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      }
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

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(url("/verify/remote.html"))).ok
  } catch {
    return false
  }
}
