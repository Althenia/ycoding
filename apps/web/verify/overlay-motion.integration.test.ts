import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4393
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the overlay fixture server")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("repository picker enters and exits with semantic closure across viewport, theme, and motion settings", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"]) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(600)
      await page.evaluate(`(() => { const button=document.querySelector('.new-session-composer button[aria-label="Repository"]'); button.focus(); button.click(); })()`)
      await wait(page, `document.querySelector('.mini-picker__surface') !== null`)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.mini-picker__surface')).animationName`)).toBe(reduced ? "none" : width! < 768 ? "mini-sheet-enter" : "mini-float")
      await Bun.sleep(350)
      await page.evaluate(`document.querySelector('.mini-picker__surface button[aria-label="Close Repository"]')?.click()`)
      const state = await page.evaluate<{ expanded: string | null; focused: boolean; present: boolean; inert: boolean; hidden: string | null; animation: string; duration: string }>(`(() => { const trigger=document.querySelector('.new-session-composer button[aria-label="Repository"]'), surface=document.querySelector('.mini-picker__surface'); return { expanded:trigger?.getAttribute('aria-expanded') ?? null, focused:document.activeElement === trigger, present:!!surface, inert:surface?.inert ?? false, hidden:surface?.getAttribute('aria-hidden') ?? null, animation:surface ? getComputedStyle(surface).animationName : 'none', duration:surface ? getComputedStyle(surface).animationDuration : '0s' } })()`)
      expect(state.expanded).toBe("false")
      expect(state.focused).toBe(true)
      if (reduced) expect(state.present).toBe(false)
      else expect(state).toMatchObject({ present: true, inert: true, hidden: "true", animation: width! < 768 ? "mini-sheet-exit" : "mini-float-out", duration: width! < 768 ? "0.22s" : "0.14s" })
      if (!reduced && theme === "light" && width === 390) await Bun.write(new URL("../../../.cache/tmp/overlay-repository-exit-phone.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      await Bun.sleep(400)
      expect(await page.evaluate<boolean>(`document.querySelector('.mini-picker__surface') === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("machine picker desktop popover and phone native sheet exit without trapping focus", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"]) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings`)
      await wait(page, `document.querySelector('[aria-labelledby="machine-settings"] button[aria-label="Machine"]:not([disabled])') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(600)
      await page.evaluate(`(() => { const button=document.querySelector('[aria-labelledby="machine-settings"] button[aria-label="Machine"]'); button.focus(); button.click(); })()`)
      const surfaceSelector = width! < 480 ? ".custom-select__dialog .overlay__surface" : ".custom-select__surface"
      await wait(page, `document.querySelector(${JSON.stringify(surfaceSelector)}) !== null`)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(surfaceSelector)})).animationName`)).toBe(reduced ? "none" : width! < 480 ? "yc-sheet-in" : "yc-picker-in")
      await Bun.sleep(350)
      if (width! < 480) await page.evaluate(`document.querySelector('.custom-select__dialog button[aria-label="Close Select Active Machine"]')?.click()`)
      else await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] button[aria-label="Machine"]')?.click()`)
      const state = await page.evaluate<{ expanded: string | null; focused: boolean; dialogOpen: boolean; present: boolean; inert: boolean; hidden: string | null; animation: string; duration: string }>(`(() => { const trigger=document.querySelector('[aria-labelledby="machine-settings"] button[aria-label="Machine"]'), surface=document.querySelector(${JSON.stringify(surfaceSelector)}), dialog=document.querySelector('.custom-select__dialog'), compact=${width! < 480}; return { expanded:trigger?.getAttribute('aria-expanded') ?? null, focused:document.activeElement === trigger, dialogOpen:dialog?.open ?? false, present:!!surface, inert:compact ? dialog?.inert ?? false : surface?.inert ?? false, hidden:(compact ? dialog : surface)?.getAttribute('aria-hidden') ?? null, animation:surface ? getComputedStyle(surface).animationName : 'none', duration:surface ? getComputedStyle(surface).animationDuration : '0s' } })()`)
      expect(state.expanded).toBe("false")
      expect(state.focused).toBe(true)
      expect(state.dialogOpen).toBe(false)
      if (reduced) expect(state.present).toBe(false)
      else expect(state).toMatchObject({ present: true, inert: true, hidden: "true", animation: width! < 480 ? "yc-sheet-out" : "yc-picker-out", duration: width! < 480 ? "0.22s" : "0.14s" })
      if (!reduced && theme === "dark" && width === 1440) await Bun.write(new URL("../../../.cache/tmp/overlay-machine-exit-desktop.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      await Bun.sleep(400)
      expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(surfaceSelector)}) === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("confirmation dialog releases its native modal focus before its visual exit", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&devices=revoked`)
      await wait(page, `document.querySelector('button[aria-label="Remove all revoked devices"]') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(600)
      await page.evaluate(`(() => { const trigger=document.querySelector('button[aria-label="Remove all revoked devices"]'); trigger.focus(); trigger.click(); })()`)
      await wait(page, `document.querySelector('dialog[aria-label="Remove all revoked devices"][open]') !== null`)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('dialog[aria-label="Remove all revoked devices"] .overlay__surface')).animationName`)).toBe(reduced ? "none" : width < 768 ? "yc-sheet-in" : "yc-dialog-in")
      await Bun.sleep(350)
      await page.evaluate(`document.querySelector('dialog[aria-label="Remove all revoked devices"] button[aria-label="Close Remove all revoked devices"]')?.click()`)
      const state = await page.evaluate<{ focused: boolean; open: boolean; present: boolean; inert: boolean; hidden: string | null; animation: string; duration: string }>(`(() => { const dialog=document.querySelector('dialog[aria-label="Remove all revoked devices"]'), surface=dialog?.querySelector('.overlay__surface'); return { focused:document.activeElement === document.querySelector('button[aria-label="Remove all revoked devices"]'), open:dialog?.open ?? false, present:!!dialog, inert:dialog?.inert ?? false, hidden:dialog?.getAttribute('aria-hidden') ?? null, animation:surface ? getComputedStyle(surface).animationName : 'none', duration:surface ? getComputedStyle(surface).animationDuration : '0s' } })()`)
      expect(state.focused).toBe(true)
      expect(state.open).toBe(false)
      if (reduced) expect(state.present).toBe(false)
      else expect(state).toMatchObject({ present: true, inert: true, hidden: "true", animation: width < 768 ? "yc-sheet-out" : "yc-dialog-out", duration: "0.22s" })
      await Bun.sleep(400)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Remove all revoked devices"]') === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("remove-devices dialog Cancel plays the dialog exit and returns focus to its trigger", async () => {
  for (const width of [390, 1440]) for (const reduced of [false, true]) {
    const page = await removalPage(width, reduced)
    try {
      await openRemoval(page)
      await page.evaluate(`[...document.querySelectorAll('${removal.dialog} button')].find((button) => button.textContent.trim() === "Cancel")?.click()`)
      const state = await removalState(page)
      expect(state).toMatchObject({ triggerFocused: true, open: false })
      if (reduced) expect(state.present).toBe(false)
      else expect(state).toMatchObject({ present: true, inert: true, hidden: "true", animation: width < 768 ? "yc-sheet-out" : "yc-dialog-out" })
      await Bun.sleep(400)
      expect(await page.evaluate<boolean>(`document.querySelector('${removal.dialog}') === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("reopening the remove-devices dialog during its exit opens a fresh interactive dialog", async () => {
  for (const width of [390, 1440]) for (const reduced of [false, true]) {
    const page = await removalPage(width, reduced)
    try {
      await openRemoval(page)
      await page.evaluate(`document.querySelector('${removal.dialog} button[aria-label="Close Remove all revoked devices"]')?.click()`)
      await openRemoval(page)
      await Bun.sleep(400)
      expect(await page.evaluate<boolean>(`document.querySelector('${removal.dialog}')?.open === true && !document.querySelector('${removal.dialog}').inert`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("a completed removal closes the remove-devices dialog through its exit", async () => {
  for (const width of [390, 1440]) for (const reduced of [false, true]) {
    const page = await removalPage(width, reduced)
    try {
      await openRemoval(page)
      await page.evaluate(`document.querySelector('${removal.dialog} button[data-confirm-remove]')?.click()`)
      await wait(page, `document.querySelector('${removal.dialog}[open]') === null`)
      const state = await removalState(page)
      expect(state.focusInside).toBe(false)
      if (reduced) expect(state.present).toBe(false)
      else expect(state).toMatchObject({ present: true, inert: true, hidden: "true", animation: width < 768 ? "yc-sheet-out" : "yc-dialog-out" })
      await Bun.sleep(400)
      expect(await page.evaluate<boolean>(`document.querySelector('${removal.dialog}') === null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

const removal = { dialog: `dialog[aria-label="Remove all revoked devices"]`, trigger: `button[aria-label="Remove all revoked devices"]` }

async function removalPage(width: number, reduced: boolean) {
  const page = await browser!.openPage()
  await page.setViewport(width, width === 390 ? 844 : 900)
  await page.setReducedMotion(reduced)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&devices=revoked`)
  await wait(page, `document.querySelector('${removal.trigger}') !== null`)
  return page
}

async function openRemoval(page: Page) {
  await page.evaluate(`(() => { const trigger=document.querySelector('${removal.trigger}'); trigger.focus(); trigger.click(); })()`)
  await wait(page, `document.querySelector('${removal.dialog}')?.open === true && !document.querySelector('${removal.dialog}').inert`)
}

function removalState(page: Page) {
  return page.evaluate<{ triggerFocused: boolean; focusInside: boolean; open: boolean; present: boolean; inert: boolean; hidden: string | null; animation: string }>(`(() => { const dialog=document.querySelector('${removal.dialog}'), surface=dialog?.querySelector('.overlay__surface'); return { triggerFocused:document.activeElement === document.querySelector('${removal.trigger}'), focusInside:!!dialog?.contains(document.activeElement), open:dialog?.open ?? false, present:!!dialog, inert:dialog?.inert ?? false, hidden:dialog?.getAttribute('aria-hidden') ?? null, animation:surface ? getComputedStyle(surface).animationName : 'none' } })()`)
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false) }
