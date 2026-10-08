import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4391
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)
    if (ready) {
      browser = await launchBrowser(browserPath, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Vite did not start the machine picker fixture")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function openPicker(width: number, machineName = "Studio Mac") {
  if (!browser) throw new Error("Chrome was not initialized")
  const page = await browser.openPage()
  await page.setViewport(width, 844)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-${width === 1440 ? 1440 : 390}${machineName === "Studio Mac" ? "" : `&machineName=${encodeURIComponent(machineName)}`}`)
  for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.remote-nav a[href="/remote/settings"]') !== null`); attempt += 1) await Bun.sleep(50)
  await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/settings"]')?.click()`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.trim() === ${JSON.stringify(machineName)}`)) break
    await Bun.sleep(50)
  }
  await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelectorAll('[role="option"]').length === 2`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error("Machine picker did not finish loading")
}

async function waitUntilGone(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string) {
  for (let attempt = 0; attempt < 30 && await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`); attempt++) await Bun.sleep(20)
  expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) === null`)).toBe(true)
}

describe("machine picker", () => {
  test("keeps offline and unenrolled machine states nonselectable without hiding recovery actions", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const [mode, placeholder] of [["offline", "No machines online"], ["none", "No machine enrolled"]] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(390, 844)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=settings&devices=${mode}`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<{ readonly disabled: boolean; readonly label: string }>(`(() => { const trigger = document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]'); return { disabled: trigger?.disabled ?? false, label: trigger?.textContent?.trim() ?? '' }; })()`)).toEqual({ disabled: true, label: placeholder })
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&devices=${mode}`)
        const expectedAlert = mode === "offline"
          ? "The machine for this Session is offline. Reconnect that machine to open its Session."
          : "The machine for this Session is unavailable to this account."
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[role="alert"]')?.textContent?.trim() === ${JSON.stringify(expectedAlert)}`); attempt += 1) await Bun.sleep(50)
        const state = await page.evaluate<{ readonly pathname: string; readonly search: string; readonly activeView: string; readonly alert: string; readonly requests: readonly { readonly deviceID: string; readonly operation: string }[]; readonly text: string }>(`({ pathname: location.pathname, search: location.search, activeView: document.querySelector('.remote-nav__link--active')?.textContent?.trim() ?? '', alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? '', requests: window.remoteDeviceRequests, text: document.body.innerText })`)
        expect(state.pathname).toBe("/remote/session")
        expect(state.search).toContain("session_id=ses_fixture")
        expect(state.search).toContain("device_id=dev_studio")
        expect(state.activeView).toBe("Session")
        expect(state.alert).toBe(expectedAlert)
        expect(state.requests).toEqual([])
        expect(state.text).not.toContain("ycoding remote connect")
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps offline and revoked machine notes beside the Settings picker", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const width of [1440, 390] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, width === 390 ? 844 : 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=devices-enrollment-${width}`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.custom-select__footer') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('.custom-select__footer')?.textContent?.trim() ?? ''`)).toBe("2 offline or revoked machines are managed in Settings → Devices.")
        expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('[role="option"] .custom-select__option-body')].map(option => option.textContent.trim())`)).toEqual(["Studio Mac"])
      } finally { await page.close() }
    }
  }, 30_000)

  test("shows connection in the header and switches machines from Settings at each breakpoint", async () => {
    if (!browser) throw new Error("Chrome was not initialized")
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]] as const) {
      const page = await browser.openPage()
      try {
        await page.setViewport(width, height)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=conversation-workspace-${width === 1440 ? 1440 : 390}`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.remote-connection') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<boolean>(`document.querySelector('.app-header [aria-label="Machine"]') === null && document.querySelector('.app-header .remote-connection') !== null`)).toBe(true)
        await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('#device-settings') !== null`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
        await page.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.click()`)
        await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
        if (width < 768) await page.evaluate(`document.querySelector('.custom-select__confirm')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.includes('Dev Linux') ?? false`); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate<string>(`document.querySelector('[aria-labelledby="machine-settings"] [aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps confirmation pinned while phone options scroll independently", async () => {
    const page = await openPicker(390)
    try {
      await page.setViewport(390, 300)
      if (!(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog[open]') !== null`)))
        await page.evaluate(`document.querySelector('button[aria-label="Machine"]')?.click()`)
      for (let index = 0; index < 40 && !(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog[open]') !== null`)); index++) await Bun.sleep(25)
      await page.evaluate(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
      await page.evaluate(`(() => { const list=document.querySelector('.custom-select__list'), option=list?.querySelector('[role="option"]'); if (!list || !option) throw new Error('Machine options are missing'); list.append(...Array.from({ length: 24 }, () => option.cloneNode(true))); })()`)
      const initial = await page.evaluate<{ listScrollable: boolean; bodyScrollable: boolean; footerVisible: boolean; listTop: number; footerTop: number }>(`(() => { const body=document.querySelector('.custom-select__dialog .overlay__body'), list=body.querySelector('.custom-select__list'), footer=body.querySelector('.custom-select__confirm'), surface=document.querySelector('.custom-select__dialog .overlay__surface'); return { listScrollable:list.scrollHeight > list.clientHeight, bodyScrollable:body.scrollHeight > body.clientHeight, footerVisible:footer.getBoundingClientRect().bottom <= surface.getBoundingClientRect().bottom, listTop:list.getBoundingClientRect().top, footerTop:footer.getBoundingClientRect().top }; })()`)
      expect(initial.listScrollable).toBe(true)
      expect(initial.bodyScrollable).toBe(false)
      expect(initial.footerVisible).toBe(true)
      await page.evaluate(`document.querySelector('.custom-select__list').scrollTop = document.querySelector('.custom-select__list').scrollHeight`)
      expect(await page.evaluate<number>(`document.querySelector('.custom-select__confirm').getBoundingClientRect().top`)).toBe(initial.footerTop)
      await Bun.write(new URL(`../../../.cache/tmp/custom-select-sticky-390-light.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }, 30_000)

  test("keeps the picker and confirmation visible across phone, tablet and desktop themes", async () => {
    for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]]) for (const theme of ["light", "dark"]) {
      const page = await openPicker(width!)
      try {
        await page.setViewport(width!, height!)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        await Bun.sleep(600)
        const bounds = await page.evaluate<{ overflow: boolean; visible: boolean; footerVisible: boolean }>(`(() => { const surface=document.querySelector('.custom-select__dialog .overlay__surface, .custom-select__surface'), footer=document.querySelector('.custom-select__confirm'), rect=surface.getBoundingClientRect(); return { overflow:document.documentElement.scrollWidth > innerWidth, visible:rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, footerVisible:!footer || footer.getBoundingClientRect().bottom <= rect.bottom }; })()`)
        expect(bounds.overflow).toBe(false)
        expect(bounds.visible).toBe(true)
        expect(bounds.footerVisible).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/custom-select-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 60_000)
  test("keeps long machine names on one line with ellipsis without viewport overflow", async () => {
    const longName = "build-agent-west-coast-production-07.example.internal"
    for (const width of [1440, 1280, 1024, 768, 390, 320]) {
      const page = await openPicker(width, longName)
      try {
        await page.evaluate(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
        const result = await page.evaluate<{ readonly text: string; readonly lines: number; readonly truncated: boolean; readonly whiteSpace: string; readonly textOverflow: string; readonly fontSize: string; readonly triggerFontSize: string; readonly optionText: string; readonly optionLines: number; readonly optionTextOverflow: string; readonly optionWhiteSpace: string; readonly optionTruncated: boolean; readonly surfaceLeft: number; readonly surfaceRight: number; readonly documentOverflow: boolean }>(`(() => {
          const value = document.querySelector('.custom-select__value');
          const option = document.querySelector('[role="option"] .custom-select__option-body > span');
          const surface = document.querySelector('.custom-select__surface, .custom-select__dialog .overlay__surface');
          const bounds = surface?.getBoundingClientRect();
          if (!(value instanceof HTMLElement) || !(option instanceof HTMLElement) || bounds === undefined) throw new Error('Machine picker did not render');
          const textRects = element => { const range = document.createRange(); range.selectNodeContents(element); return [...range.getClientRects()]; };
          const lineCount = element => new Set(textRects(element).map(rect => rect.top + ':' + rect.bottom)).size;
          const selectedStyle = getComputedStyle(value);
          const optionStyle = getComputedStyle(option);
          return { text: value.textContent, lines: lineCount(value), truncated: value.scrollWidth > value.clientWidth && selectedStyle.overflowX === 'hidden', whiteSpace: selectedStyle.whiteSpace, textOverflow: selectedStyle.textOverflow, fontSize: optionStyle.fontSize, triggerFontSize: selectedStyle.fontSize, optionText: option.textContent, optionLines: lineCount(option), optionTextOverflow: optionStyle.textOverflow, optionWhiteSpace: optionStyle.whiteSpace, optionTruncated: option.scrollWidth > option.clientWidth && optionStyle.overflowX === 'hidden', surfaceLeft: bounds.left, surfaceRight: bounds.right, documentOverflow: document.documentElement.scrollWidth > innerWidth };
        })()`)
        expect(result.text).toBe(longName)
        expect(result.whiteSpace).toBe("nowrap")
        expect(result.textOverflow).toBe("ellipsis")
        expect(result.lines).toBe(1)
        expect(result.truncated).toBe(true)
        expect(result.fontSize).toBe(result.triggerFontSize)
        expect(result.optionText).toBe(longName)
        expect(result.optionWhiteSpace).toBe("nowrap")
        expect(result.optionTextOverflow).toBe("ellipsis")
        expect(result.optionLines).toBe(1)
        expect(result.optionTruncated).toBe(true)
        expect(result.surfaceLeft).toBeGreaterThanOrEqual(0)
        expect(result.surfaceRight).toBeLessThanOrEqual(width)
        expect(result.documentOverflow).toBe(false)
      } finally {
        await page.close()
      }
    }
  })

  test("widens the Settings selector and dropdown to fit a typical machine hostname", async () => {
    for (const width of [1280, 1440]) {
      const page = await openPicker(width, "Developer-MacBook-Pro.local")
      try {
        const result = await page.evaluate<{ readonly valueFits: boolean; readonly optionFits: boolean; readonly surfaceWidth: number; readonly triggerWidth: number; readonly headerHeight: number; readonly expectedHeaderHeight: number }>(`(() => {
          const value = document.querySelector('.custom-select__value');
          const option = document.querySelector('[role="option"] .custom-select__option-body > span');
          const trigger = document.querySelector('[aria-label="Machine"]');
          const surface = document.querySelector('.custom-select__surface');
          const header = document.querySelector('.app-header__inner');
          if (!value || !option || !trigger || !surface || !header) throw new Error('Machine picker did not render');
          return { valueFits: value.scrollWidth <= value.clientWidth, optionFits: option.scrollWidth <= option.clientWidth, surfaceWidth: surface.getBoundingClientRect().width, triggerWidth: trigger.getBoundingClientRect().width, headerHeight: header.getBoundingClientRect().height, expectedHeaderHeight: parseFloat(getComputedStyle(header).getPropertyValue('--yc-header-h')) };
        })()`)
        expect(result.valueFits).toBe(true)
        expect(result.optionFits).toBe(true)
        expect(result.triggerWidth).toBeGreaterThan(260)
        expect(result.surfaceWidth).toBeGreaterThanOrEqual(result.triggerWidth)
        expect(result.headerHeight).toBe(result.expectedHeaderHeight)
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("keeps mobile selection pending until confirmation and discards it on Escape", async () => {
    const page = await openPicker(390)
    try {
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      expect(await page.evaluate<string>(`document.querySelector('[role="option"][aria-selected="true"]')?.textContent?.replace('✓', '').trim() ?? ''`)).toContain("Dev Linux")
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog')?.open === false && document.querySelector('.custom-select__dialog')?.inert === true && document.activeElement?.getAttribute('aria-label') === 'Machine'`)).toBe(true)
      await waitUntilGone(page, ".custom-select__dialog")
      await page.pressKey("Enter", "Enter", 13)
      expect(await page.evaluate<string>(`document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ''`)).toContain("Studio Mac")
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      await page.evaluate(`document.querySelector('[aria-label="Close Select Active Machine"]')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      await waitUntilGone(page, ".custom-select__dialog")
      await page.pressKey("Enter", "Enter", 13)
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Confirm Selection')?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.textContent?.includes('Dev Linux') ?? false`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      await waitUntilGone(page, ".custom-select__dialog")
    } finally {
      await page.close()
    }
  })

  test("contains mobile keyboard focus and the complete selection sheet at narrow widths", async () => {
    for (const width of [320, 390, 479]) {
      const page = await openPicker(width)
      try {
        expect(await page.evaluate<boolean>(`(() => {
          const dialog = document.querySelector('dialog[aria-label="Select Active Machine"]');
          return dialog instanceof HTMLDialogElement && dialog.open && dialog.contains(document.activeElement);
        })()`)).toBe(true)
        await page.evaluate(`document.querySelector('[role="listbox"]')?.focus()`)
        await page.pressKey("End", "End", 35)
        await page.pressKey("Enter", "Enter", 13)
        expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
        expect(await page.evaluate<string>(`document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ''`)).toContain("Dev Linux")
        await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Confirm Selection')?.focus()`)
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog')?.contains(document.activeElement) === true`)).toBe(true)
        await page.evaluate(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
        const layout = await page.evaluate<{ readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly height: number; readonly visualHeight: number; readonly visualTop: number; readonly radius: string; readonly paddingBottom: number; readonly minPadding: number; readonly controls: readonly { readonly label: string; readonly height: number }[]; readonly overflow: boolean }>(`(() => {
          const surface = document.querySelector('dialog .overlay__surface');
          if (!(surface instanceof HTMLElement)) throw new Error('Machine sheet missing');
          const rect = surface.getBoundingClientRect();
          const style = getComputedStyle(surface);
          const controls = [...surface.querySelectorAll('button')].filter(button => button.getBoundingClientRect().height > 0);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, visualHeight: visualViewport.height, visualTop: visualViewport.offsetTop, radius: style.borderTopLeftRadius, paddingBottom: parseFloat(style.paddingBottom), minPadding: parseFloat(style.getPropertyValue('--yc-space-4')), controls: controls.map(button => ({ label: button.getAttribute('aria-label') ?? button.textContent.trim(), height: button.getBoundingClientRect().height })), overflow: document.documentElement.scrollWidth > innerWidth };
        })()`)
        expect(layout.left, JSON.stringify({ width, layout })).toBeGreaterThanOrEqual(0)
        expect(layout.right, JSON.stringify({ width, layout })).toBeLessThanOrEqual(width)
        expect(layout.bottom, JSON.stringify({ width, layout })).toBeLessThanOrEqual(844)
        expect(layout.top).toBe(layout.visualTop)
        expect(layout.height).toBe(layout.visualHeight)
        expect(layout.radius).toBe("0px")
        expect(layout.paddingBottom).toBeGreaterThanOrEqual(layout.minPadding)
        expect(layout.controls.every((control) => control.height >= 44), JSON.stringify({ width, layout })).toBe(true)
        expect(layout.overflow).toBe(false)
      } finally {
        await page.close()
      }
    }
  })

  test("keeps desktop selection immediate and shows the active machine", async () => {
    const page = await openPicker(1440)
    try {
      expect(await page.evaluate<boolean>(`document.querySelector('dialog') === null`)).toBe(true)
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('.custom-select__surface')?.inert === true`)).toBe(true)
      await waitUntilGone(page, ".custom-select__surface")
    } finally {
      await page.close()
    }
  })

  test("dismisses a mobile draft from the backdrop without changing machines", async () => {
    const page = await openPicker(390)
    try {
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      await page.evaluate(`document.querySelector('dialog')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog')?.open === false && document.querySelector('dialog')?.inert === true`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      expect(await page.evaluate<string>(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Machine")
      await waitUntilGone(page, "dialog")
    } finally {
      await page.close()
    }
  })
})
