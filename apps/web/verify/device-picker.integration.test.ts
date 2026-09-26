import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4323
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelectorAll('[role="option"]').length === 2 && document.querySelector('[aria-label="Machine"]')?.textContent?.trim() === ${JSON.stringify(machineName)}`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error("Machine picker did not finish loading")
}

describe("machine picker", () => {
  test("shows long machine names in a compact picker without viewport overflow", async () => {
    const longName = "build-agent-west-coast-production-07.example.internal"
    for (const width of [1440, 390, 320]) {
      const page = await openPicker(width, longName)
      try {
        await page.evaluate(`Promise.all([...document.querySelector('.custom-select__dialog .overlay__surface')?.getAnimations() ?? []].map(animation => animation.finished))`)
        const result = await page.evaluate<{ readonly text: string; readonly lines: number; readonly fullyVisible: boolean; readonly whiteSpace: string; readonly fontSize: string; readonly triggerFontSize: string; readonly optionText: string; readonly optionLines: number; readonly optionVisible: boolean; readonly surfaceLeft: number; readonly surfaceRight: number; readonly documentOverflow: boolean }>(`(() => {
          const value = document.querySelector('.custom-select__value');
          const option = document.querySelector('[role="option"] .custom-select__option-body > span');
          const surface = document.querySelector('.custom-select__surface, .custom-select__dialog .overlay__surface');
          const bounds = surface?.getBoundingClientRect();
          if (!(value instanceof HTMLElement) || !(option instanceof HTMLElement) || bounds === undefined) throw new Error('Machine picker did not render');
          const textRects = element => { const range = document.createRange(); range.selectNodeContents(element); return [...range.getClientRects()]; };
          const lineCount = element => new Set(textRects(element).map(rect => rect.top + ':' + rect.bottom)).size;
          const fullyVisible = element => { const bounds = element.getBoundingClientRect(); return textRects(element).every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1); };
          const selectedStyle = getComputedStyle(value);
          const optionStyle = getComputedStyle(option);
          return { text: value.textContent, lines: lineCount(value), fullyVisible: fullyVisible(value), whiteSpace: selectedStyle.whiteSpace, fontSize: optionStyle.fontSize, triggerFontSize: selectedStyle.fontSize, optionText: option.textContent, optionLines: lineCount(option), optionVisible: fullyVisible(option), surfaceLeft: bounds.left, surfaceRight: bounds.right, documentOverflow: document.documentElement.scrollWidth > innerWidth };
        })()`)
        expect(result.text).toBe(longName)
        expect(result.lines).toBeGreaterThan(1)
        expect(result.fullyVisible).toBe(true)
        expect(result.whiteSpace).toBe("normal")
        expect(result.fontSize).toBe(result.triggerFontSize)
        expect(result.optionText).toBe(longName)
        expect(result.optionLines).toBeGreaterThan(1)
        expect(result.optionVisible).toBe(true)
        expect(result.surfaceLeft).toBeGreaterThanOrEqual(0)
        expect(result.surfaceRight).toBeLessThanOrEqual(width)
        expect(result.documentOverflow).toBe(false)
      } finally {
        await page.close()
      }
    }
  })

  test("keeps mobile selection pending until confirmation and discards it on Escape", async () => {
    const page = await openPicker(390)
    try {
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      expect(await page.evaluate<string>(`document.querySelector('[role="option"][aria-selected="true"]')?.textContent?.replace('✓', '').trim() ?? ''`)).toContain("Dev Linux")
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.querySelector('[role="listbox"]') === null && document.activeElement?.getAttribute('aria-label') === 'Machine'`)).toBe(true)
      await page.pressKey("Enter", "Enter", 13)
      expect(await page.evaluate<string>(`document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ''`)).toContain("Studio Mac")
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      await page.evaluate(`document.querySelector('[aria-label="Close Select Active Machine"]')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      await page.pressKey("Enter", "Enter", 13)
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Confirm Selection')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Dev Linux")
      expect(await page.evaluate<boolean>(`document.querySelector('[role="listbox"]') === null`)).toBe(true)
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
        const layout = await page.evaluate<{ readonly left: number; readonly right: number; readonly bottom: number; readonly radius: string; readonly expectedRadius: string; readonly paddingBottom: number; readonly minPadding: number; readonly controls: readonly { readonly label: string; readonly height: number }[]; readonly overflow: boolean }>(`(() => {
          const surface = document.querySelector('dialog .overlay__surface');
          if (!(surface instanceof HTMLElement)) throw new Error('Machine sheet missing');
          const rect = surface.getBoundingClientRect();
          const style = getComputedStyle(surface);
          const controls = [...surface.querySelectorAll('button')].filter(button => button.getBoundingClientRect().height > 0);
          return { left: rect.left, right: rect.right, bottom: rect.bottom, radius: style.borderTopLeftRadius, expectedRadius: style.getPropertyValue('--yc-radius-lg').trim(), paddingBottom: parseFloat(style.paddingBottom), minPadding: parseFloat(style.getPropertyValue('--yc-space-4')), controls: controls.map(button => ({ label: button.getAttribute('aria-label') ?? button.textContent.trim(), height: button.getBoundingClientRect().height })), overflow: document.documentElement.scrollWidth > innerWidth };
        })()`)
        expect(layout.left, JSON.stringify({ width, layout })).toBeGreaterThanOrEqual(0)
        expect(layout.right, JSON.stringify({ width, layout })).toBeLessThanOrEqual(width)
        expect(layout.bottom, JSON.stringify({ width, layout })).toBeLessThanOrEqual(844)
        expect(layout.radius).toBe(layout.expectedRadius)
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
      expect(await page.evaluate<boolean>(`document.querySelector('[role="listbox"]') === null`)).toBe(true)
    } finally {
      await page.close()
    }
  })

  test("dismisses a mobile draft from the backdrop without changing machines", async () => {
    const page = await openPicker(390)
    try {
      await page.evaluate(`document.querySelectorAll('[role="option"]')[1]?.click()`)
      await page.evaluate(`document.querySelector('dialog')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog') === null`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="Machine"]')?.textContent?.trim() ?? ''`)).toBe("Studio Mac")
      expect(await page.evaluate<string>(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Machine")
    } finally {
      await page.close()
    }
  })
})
