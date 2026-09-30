import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4683
const origin = `http://127.0.0.1:${port}`
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: Bun.Subprocess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && server.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`${origin}/verify/remote.html`)).ok) {
        browser = await launchBrowser(browserPath, 390, 844)
        return
      }
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("Modal fixture server did not start; check that port 4683 is free")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function openTeam(width: 390 | 768, theme: "light" | "dark", focusTrigger = true) {
  const page = await browser!.openPage()
  await page.setViewport(width, width === 390 ? 844 : 560)
  await page.setCoarsePointer(true)
  await page.navigate(`${origin}/verify/remote.html?view=chat&team=two&theme=${theme}`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Open Team"]')?.getBoundingClientRect().width > 0`); attempt += 1) await Bun.sleep(50)
  await page.evaluate(`(() => { const trigger = document.querySelector('[aria-label="Open Team"]'); if (${focusTrigger}) trigger.focus(); trigger.click() })()`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') !== null`); attempt += 1) await Bun.sleep(25)
  expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') !== null`)).toBe(true)
  return page
}

async function closeReport(page: Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>, selector: string) {
  return page.evaluate<{ count: number; names: readonly string[]; sizes: readonly { width: number; height: number }[]; inHeader: boolean; extraTeamClose: boolean; focused: boolean; minimum: number }>(`(() => {
    const dialog = document.querySelector(${JSON.stringify(selector)});
    const buttons = [...dialog.querySelectorAll('button[aria-label^="Close "]')].filter(button => button.getClientRects().length > 0);
    return { count: buttons.length, names: buttons.map(button => button.getAttribute('aria-label')),
      sizes: buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      inHeader: buttons.every(button => button.parentElement?.classList.contains('overlay__head')),
      extraTeamClose: dialog.querySelector('.team-view__header [aria-label="Close Team"]') !== null,
      focused: dialog.contains(document.activeElement), minimum: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-hit-min')) };
  })()`)
}

describe("one close control per modal", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`icon controls use neutral borders and keyboard focus in ${theme}`, async () => {
      const page = await browser!.openPage()
      try {
        await page.setMobileViewport(390, 844)
        await page.navigate(`${origin}/verify/modal-focus-fixture.html?theme=${theme}`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Icon focus variants"]') !== null`); attempt += 1) await Bun.sleep(25)
        await page.pressKey("Tab", "Tab", 9)
        const report = await page.evaluate<readonly { name: string; visible: boolean; neutral: boolean; greenBorder: boolean }[]>(`(() => {
          const neutral = getComputedStyle(document.querySelector('[data-neutral-focus]')).color;
          const green = getComputedStyle(document.querySelector('[data-green-focus]')).color;
          const greenBorder = getComputedStyle(document.querySelector('[data-green-border]')).color;
          return [...document.querySelectorAll('[aria-label="Icon focus variants"] button')].map(button => {
            button.focus(); const style = getComputedStyle(button);
            const outlined = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
            return { name: button.getAttribute('aria-label'), visible: outlined || style.boxShadow !== 'none',
              neutral: outlined ? style.outlineColor === neutral : style.boxShadow.includes(neutral),
              greenBorder: style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0 && [green, greenBorder].includes(style.borderTopColor) };
          });
        })()`)
        expect(report.map((item) => item.name)).toEqual(["Close fixture", "Open Team", "Zoom in", "Main session", "Jump to latest", "Open task", "Answer task", "Pending model", "Pending agent"])
        expect(report.filter((item) => !item.visible || !item.neutral || item.greenBorder)).toEqual([])
      } finally { await page.close() }
    }, 30_000)
  }
  for (const theme of ["light", "dark"] as const) {
    test(`workspace close keeps touch autofocus borderless and keyboard focus visible in ${theme}`, async () => {
      const page = await browser!.openPage()
      try {
        await page.setMobileViewport(390, 844)
        await page.navigate(`${origin}/verify/modal-focus-fixture.html?theme=${theme}`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Workspace"]') !== null`); attempt += 1) await Bun.sleep(25)
        await page.evaluate(`document.querySelector('[aria-label="Workspace"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('dialog[open] .overlay__close') !== null`); attempt += 1) await Bun.sleep(25)
        expect(await page.evaluate<{ focused: boolean; outline: string; shadow: string }>(`(() => {
          const button = document.querySelector('dialog[open] .overlay__close'); const style = getComputedStyle(button);
          return { focused: document.activeElement === button, outline: style.outlineStyle, shadow: style.boxShadow };
        })()`)).toEqual({ focused: true, outline: "none", shadow: "none" })
        if (theme === "dark") await Bun.write(new URL("../../../.cache/tmp/modal-close-focus-dark.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.pressKey("Tab", "Tab", 9)
        await page.evaluate(`document.querySelector('dialog[open] .overlay__close').focus()`)
        expect(await page.evaluate<boolean>(`(() => {
          const button = document.querySelector('dialog[open] .overlay__close'); const style = getComputedStyle(button);
          return button.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
        })()`)).toBe(true)
        await page.pressEscape()
        expect(await page.evaluate<boolean>(`document.querySelector('dialog[open]') === null && document.activeElement?.getAttribute('aria-label') === 'Workspace'`)).toBe(true)
        for (let attempt = 0; attempt < 80 && await page.evaluate<boolean>(`document.querySelector('dialog') !== null`); attempt += 1) await Bun.sleep(25)
        await page.pressKey(" ", "Space", 32)
        expect(await page.evaluate<boolean>(`(() => {
          const button = document.querySelector('dialog[open] .overlay__close');
          return document.activeElement === button && getComputedStyle(button).outlineStyle !== 'none';
        })()`)).toBe(true)
      } finally { await page.close() }
    }, 30_000)
  }
  test("unknown activation and forced colors keep visible modal focus", async () => {
    for (const forced of [false, true]) {
      const page = await browser!.openPage()
      try {
        await page.setMobileViewport(390, 844)
        await page.setForcedColors(forced)
        await page.navigate(`${origin}/verify/modal-focus-fixture.html?theme=dark`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Workspace"]') !== null`); attempt += 1) await Bun.sleep(25)
        await page.evaluate(`document.querySelector('[aria-label="Workspace"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: ${forced ? 1 : 0} }))`)
        expect(await page.evaluate<boolean>(`(() => {
          const button = document.querySelector('dialog[open] .overlay__close');
          return document.activeElement === button && getComputedStyle(button).outlineStyle !== 'none';
        })()`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)
  for (const width of [390, 768] as const) for (const theme of ["light", "dark"] as const) for (const method of ["button", "escape"] as const) {
    test(`Team ${method} at ${width} in ${theme}`, async () => {
      const page = await openTeam(width, theme)
      try {
        const report = await closeReport(page, "dialog.team-view__sheet[open]")
        expect(report.count).toBe(1)
        expect(report.names).toEqual(["Close Team"])
        expect(report.inHeader).toBe(true)
        expect(report.extraTeamClose).toBe(false)
        expect(report.focused).toBe(true)
        expect(report.sizes.every((size) => size.width >= report.minimum && size.height >= report.minimum)).toBe(true)
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]')?.contains(document.activeElement) === true`)).toBe(true)
        if (method === "button") await page.evaluate(`document.querySelector('dialog.team-view__sheet .overlay__close').click()`)
        else await page.pressEscape()
        expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Open Team' && document.querySelector('dialog.team-view__sheet[open]') === null`)).toBe(true)
        expect(await page.evaluate<boolean>(`getComputedStyle(document.activeElement).getPropertyValue('--yc-focus').trim() === getComputedStyle(document.documentElement).getPropertyValue('--yc-border-strong').trim()`)).toBe(true)
      } finally { await page.close() }
    }, 30_000)
  }

  test("Team confirmation has its own single close and returns focus into Team", async () => {
    const page = await openTeam(390, "light")
    try {
      await page.evaluate(`(() => { const trigger = document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]'); trigger.focus(); trigger.click() })()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"][open]') !== null`); attempt += 1) await Bun.sleep(25)
      const report = await closeReport(page, `dialog[aria-label="Cancel subagent"][open]`)
      expect(report.count).toBe(1)
      expect(report.names).toEqual(["Close Cancel subagent"])
      expect(report.inHeader).toBe(true)
      expect(report.sizes.every((size) => size.width >= report.minimum && size.height >= report.minimum)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('data-action') === 'cancel' && document.querySelector('dialog[aria-label="Cancel subagent"][open]') === null`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Open Team'`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("Escape closes only the top dialog and restores each unfocused opener", async () => {
    const page = await openTeam(390, "light", false)
    try {
      await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"][open]') !== null`); attempt += 1) await Bun.sleep(25)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') !== null && document.querySelector('dialog[aria-label="Cancel subagent"][open]') === null && document.activeElement?.getAttribute('data-action') === 'cancel'`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') === null && document.activeElement?.getAttribute('aria-label') === 'Open Team'`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("a full-height 768px tablet keeps the standalone Team panel's single header close", async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(768, 1024)
      await page.navigate(`${origin}/verify/remote.html?view=chat&team=two&theme=dark`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Open Team"]')?.getBoundingClientRect().width > 0`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`(() => { const trigger = document.querySelector('[aria-label="Open Team"]'); trigger.focus(); trigger.click() })()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-control__panel .team-view__header [aria-label="Close Team"]') !== null`); attempt += 1) await Bun.sleep(25)
      expect(await page.evaluate<number>(`document.querySelectorAll('.team-control__panel .team-view__header [aria-label="Close Team"]').length`)).toBe(1)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet') === null`)).toBe(true)
      await page.evaluate(`document.querySelector('.team-control__panel .team-view__header [aria-label="Close Team"]').click()`)
      expect(await page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Open Team'`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)
})
