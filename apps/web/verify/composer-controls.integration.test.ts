import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { launchBrowser } from "./cdp"

const port = 4387
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
  await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("selected Session speed and context share one stable composer row and accessible details", async () => {
  const captures = join(process.env.TMPDIR ?? new URL("../../../.cache/tmp", import.meta.url).pathname, "web-status-captures")
  await mkdir(captures, { recursive: true })
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      if (width === 390) await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__row') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      const baseline = await page.evaluate<{ row: number; controls: number; mobile: number }>(`(() => { const mount=document.querySelector('.mini-composer__mount'); return { row:mount.querySelector('.composer__row').getBoundingClientRect().height, controls:mount.querySelector('.composer__controls').getBoundingClientRect().height, mobile:mount.querySelector('.composer__mobile-identity').getBoundingClientRect().height }; })()`)
      await page.evaluate(`window.composerSetDiagnostics('known')`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__speed')?.textContent?.includes('6,000 tok/s') === true`)
      const layout = await page.evaluate<{ row: number; controls: number; mobile: number; speed: string; ring: boolean; ringBeforeModel: boolean; inFooter: boolean; mobileRing: boolean; tapHeight: number; overflow: boolean }>(`(() => { const mount=document.querySelector('.mini-composer__mount'), ring=mount.querySelector('.composer__context-trigger'), mobile=mount.querySelector('.composer__mobile-trigger'), model=mount.querySelector('.model-control__trigger'), speed=mount.querySelector('.composer__speed'), controls=mount.querySelector('.composer__controls'); return { row:mount.querySelector('.composer__row').getBoundingClientRect().height, controls:controls.getBoundingClientRect().height, mobile:mount.querySelector('.composer__mobile-identity').getBoundingClientRect().height, speed:speed?.textContent ?? '', ring:!!ring, ringBeforeModel:!!ring && !!model && ring.getBoundingClientRect().right<=model.getBoundingClientRect().left+1, inFooter:!!speed && controls.contains(speed) && speed.getBoundingClientRect().right<=controls.getBoundingClientRect().right+1, mobileRing:!!mobile?.querySelector('.composer__mobile-context-ring'), tapHeight:mobile?.getBoundingClientRect().height ?? 0, overflow:document.documentElement.scrollWidth>innerWidth }; })()`)
      expect(layout.speed).toContain("6,000 tok/s")
      expect(layout.row).toBe(baseline.row)
      expect(layout.controls).toBe(baseline.controls)
      expect(layout.overflow).toBe(false)
      const arc = await page.evaluate<number>(`Number(document.querySelector('.mini-composer__mount .composer__context-ring-progress')?.getAttribute('stroke-dasharray')?.split(' ')[0])`)
      expect(arc).toBeGreaterThan(28)
      expect(arc).toBeLessThan(30)
      if (width === 390) {
        expect(layout.mobile).toBe(baseline.mobile)
        expect(layout.mobileRing).toBe(true)
        expect(layout.tapHeight).toBeGreaterThanOrEqual(44)
        await page.evaluate(`document.querySelector('.composer__mobile-trigger')?.click()`)
        await wait(page, `document.querySelector('.composer__selection-sheet .composer__context-summary') !== null`)
        const sheet = await page.evaluate<{ text: string; fraction: number; nestedButton: boolean }>(`(() => { const summary=document.querySelector('.composer__selection-sheet .composer__context-summary'), bar=summary?.querySelector('.composer__context-bar'), fill=summary?.querySelector('.composer__context-bar-fill'); return { text:summary?.textContent ?? '', fraction:bar && fill ? fill.getBoundingClientRect().width/bar.getBoundingClientRect().width : 0, nestedButton:!!document.querySelector('.composer__mobile-trigger button') }; })()`)
        expect(sheet.text).toContain("Context window")
        expect(sheet.text).toContain("29% used · 71% left")
        expect(sheet.text).toContain("74K / 258K tokens")
        expect(sheet.fraction).toBeGreaterThan(0.28)
        expect(sheet.fraction).toBeLessThan(0.30)
        expect(sheet.nestedButton).toBe(false)
      } else {
        expect(layout.ring).toBe(true)
        expect(layout.ringBeforeModel).toBe(true)
        expect(layout.inFooter).toBe(true)
        expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__speed-trend')?.textContent ?? ''`)).toContain("▄█")
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`)
        await wait(page, `document.querySelector('.composer__context-popover')?.textContent?.includes('29% used') === true`)
        const hover = await page.evaluate<{ text: string; name: string; row: number }>(`(() => ({ text:document.querySelector('.composer__context-popover')?.textContent ?? '', name:document.querySelector('.composer__context-trigger')?.getAttribute('aria-label') ?? '', row:document.querySelector('.composer__row').getBoundingClientRect().height }))()`)
        expect(hover.text).toContain("Context window")
        expect(hover.text).toContain("29% used · 71% left")
        expect(hover.text).toContain("74K / 258K tokens")
        expect(hover.name).toContain("29% used")
        expect(hover.row).toBe(baseline.row)
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))`)
        await wait(page, `document.querySelector('.composer__context-popover') === null`)
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.focus()`)
        await wait(page, `document.querySelector('.composer__context-popover') !== null`)
        await page.pressEscape()
        await wait(page, `document.querySelector('.composer__context-popover') === null`)
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.click()`)
        await wait(page, `document.querySelector('.composer__context-popover') !== null`)
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.composer__context-popover')).animationDuration`)).toBe("0.14s")
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.click()`)
        await wait(page, `document.querySelector('.composer__context-popover') === null`)
        await page.setReducedMotion(true)
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.click()`)
        await wait(page, `document.querySelector('.composer__context-popover') !== null`)
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.composer__context-popover')).animationDuration`)).toBe("0s")
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.click()`)
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__context-popover') === null`)).toBe(true)
        await page.setReducedMotion(false)
        await page.evaluate(`document.querySelector('.composer__context-trigger')?.click()`)
        await wait(page, `document.querySelector('.composer__context-popover') !== null`)
        await page.evaluate(`Promise.all([...document.querySelector('.composer__context-popover').getAnimations()].map(animation => animation.finished.catch(() => {})))`)
      }
      await Bun.write(join(captures, `composer-status-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      if (width === 390) await page.pressEscape()
      await page.evaluate(`window.composerSetDiagnostics('mismatch')`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__speed') === null`)
      expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .composer__context-trigger,.mini-composer__mount .composer__mobile-context-ring') !== null`)).toBe(false)
      await page.evaluate(`window.composerSetDiagnostics('unknown')`)
      expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .composer__speed') !== null`)).toBe(false)
    } finally { await page.close() }
  }
}, 60_000)

test("pending prompts, mutation toasts, and the active goal remain accessible on phone and desktop", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      if (width === 390) await page.setCoarsePointer(true)
      await page.setReducedMotion(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerSetPending('steer'); window.composerSetGoalStatus('active')`)
      await wait(page, `document.querySelector('.transcript-message__receipt')?.textContent?.includes('Processing') === true`)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-message__receipt')?.getAttribute('aria-label')`)).toBe("Processing prompt")
      expect(await page.evaluate<string>(`document.querySelector('.session-status__active-goal')?.textContent?.trim()`)).toBe("Goal active · Finish task")
      await page.evaluate(`window.composerSetGoalStatus(null); window.composerSetGoalPending(true)`)
      expect(await page.evaluate<string>(`document.querySelector('.session-status__goal-setting[role="status"]')?.textContent?.trim()`)).toBe("Setting goal…")
      await page.evaluate(`window.composerSetGoalPending(false)`)
      expect(await page.evaluate<boolean>(`document.querySelector('.session-status__goal-setting') === null`)).toBe(true)
      await page.evaluate(`window.composerSetPending('queue'); window.composerSetMutation('sending')`)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-message__receipt')?.textContent?.trim()`)).toContain("Queued")
      expect(await page.evaluate<number>(`document.querySelectorAll('.mutation-toast').length`)).toBe(0)
      for (const status of ["sent", "failed", "unknown"] as const) {
        await page.evaluate(`window.composerSetMutation(${JSON.stringify(status)})`)
        await wait(page, `document.querySelector('.mutation-toast')?.classList.contains('mutation-toast--${status}') === true`)
        expect(await page.evaluate<string>(`document.querySelector('.mutation-toast')?.getAttribute('role')`)).toBe(status === "sent" ? "status" : "alert")
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.mutation-toast')).animationDuration`)).toBe("0s")
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        if (status !== "sent") {
          await page.evaluate(`document.querySelector('.transcript-message__send-error button')?.click()`)
          expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("retry")
        }
        await page.evaluate(`document.querySelector('.mutation-toast button')?.click()`)
        expect(await page.evaluate<number>(`document.querySelectorAll('.mutation-toast').length`)).toBe(0)
      }
    } finally { await page.close() }
  }
}, 30_000)

test("retry status yields to progress and terminal state at phone and desktop widths", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerSetRetryPhase('countdown')`)
      expect(await page.evaluate<string>(`document.querySelector('.session-status__label')?.textContent?.trim()`)).toMatch(/1 failed · retry 2 · in [1-5]s/)
      await page.evaluate(`window.composerSetRetryPhase('retrying')`)
      await wait(page, `document.querySelector('.session-status__label')?.textContent?.trim() === 'retrying · attempt 2'`)
      expect(await page.evaluate<string>(`document.querySelector('.session-status__label')?.textContent?.trim()`)).toBe("retrying · attempt 2")
      for (const [phase, expected] of [["progress", "Running"], ["next", "Running"], ["idle", ""], ["failed", "provider error"]] as const) {
        await page.evaluate(`window.composerSetRetryPhase(${JSON.stringify(phase)})`)
        await wait(page, phase === "idle" ? `document.querySelector('.session-status__slot')?.classList.contains('session-status__slot--empty') === true`
          : `document.querySelector('.session-status__label')?.textContent?.includes(${JSON.stringify(expected)}) === true`)
        expect(await page.evaluate<string>(`document.querySelector('.session-status__label')?.textContent?.trim() ?? ''`)).toContain(expected)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      }
    } finally { await page.close() }
  }
}, 30_000)

test("phone tool-running status text stays inside its pill and footer", async () => {
  for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .session-status__slot') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerSetStatus('tool')`)
      const bounds = await page.evaluate<{ text: string; clipped: boolean; inside: boolean; footerInside: boolean }>(`(() => { const slot=document.querySelector('.mini-composer__mount .session-status__slot'), text=slot.querySelector('.session-status__mobile'), row=document.querySelector('.mini-composer__mount .composer__row'), sr=slot.getBoundingClientRect(), tr=text.getBoundingClientRect(), rr=row.getBoundingClientRect(), style=getComputedStyle(text); return { text:text.textContent, clipped:getComputedStyle(slot).overflowX === 'hidden' && style.overflowX === 'hidden' && style.textOverflow === 'ellipsis', inside:tr.right <= sr.right + 1, footerInside:sr.right <= rr.right + 1 }; })()`)
      expect(bounds.text).toBe("tool running")
      expect(bounds.clipped).toBe(true)
      expect(bounds.inside).toBe(true)
      expect(bounds.footerInside).toBe(true)
      await Bun.write(new URL(`../../../.cache/tmp/composer-tool-390-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 30_000)

test("phone status shows the Session state, never the autonomy level shown beside it", async () => {
  for (const [status, expected] of [["tool-yolo", "tool running"], ["family-yolo", "Running"]] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .session-status__yolo-trigger') !== null`)
      await page.evaluate(`window.composerSetStatus(${JSON.stringify(status)})`)
      await wait(page, `document.querySelector('.mini-composer__mount .session-status__mobile') !== null`)
      const shown = await page.evaluate<{ mobile: string; trigger: string }>(`(() => ({ mobile: document.querySelector('.mini-composer__mount .session-status__mobile')?.textContent ?? '', trigger: document.querySelector('.mini-composer__mount .session-status__yolo-trigger .session-status__yolo-full')?.textContent ?? '' }))()`)
      expect(shown.trigger).toBe("YOLO 3")
      expect(shown.mobile).toBe(expected)
    } finally { await page.close() }
  }
}, 30_000)

test("phone selection lives above the card while its footer stays on one line", async () => {
  for (const [width, height] of [[360, 780], [390, 844], [430, 932], [820, 1180]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      if (width! <= 430) await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .composer__row') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerSetStatus('tool')`)
      await Bun.sleep(600)
      const layout = await page.evaluate<{ first: string; visible: boolean; label: string; pillVisible: boolean; oneLine: boolean; aligned: boolean; ellipsis: boolean; overflow: boolean }>(`(() => { const mount=document.querySelector('.mini-composer__mount'), selector=mount.querySelector('.composer__mobile-identity'), button=selector?.querySelector('button'), controls=mount.querySelector('.composer__controls'), rects=[...controls.querySelectorAll('button,.session-status__slot')].map(item=>item.getBoundingClientRect()).filter(rect=>rect.width>0 && rect.height>0), trigger=button?.getBoundingClientRect(), card=mount.querySelector('.composer__row').getBoundingClientRect(); return { first:mount.firstElementChild?.className ?? '', visible:!!selector && getComputedStyle(selector).display!=='none', label:button?.textContent ?? '', pillVisible:[...controls.querySelectorAll('.mini-picker,.model-control')].some(item=>getComputedStyle(item).display!=='none'), oneLine:rects.every(rect=>Math.abs(rect.top-rects[0].top)<=1), aligned:!!trigger && Math.abs(trigger.left-card.left)<=1 && Math.abs(trigger.right-card.right)<=1, ellipsis:getComputedStyle(button?.querySelector('span')).textOverflow==='ellipsis', overflow:document.documentElement.scrollWidth>innerWidth }; })()`)
      if (width! <= 430) {
        expect(layout.first).toContain("composer__mobile-identity")
        expect(layout.visible).toBe(true)
        expect(layout.label).toContain("GSD")
        expect(layout.label).toContain("GPT-6 Sol")
        expect(layout.label).toContain("high")
        expect(layout.pillVisible).toBe(false)
        expect(layout.oneLine).toBe(true)
        expect(layout.aligned).toBe(true)
        expect(layout.ellipsis).toBe(true)
      } else {
        expect(layout.visible).toBe(false)
        expect(layout.pillVisible).toBe(true)
      }
      expect(layout.overflow).toBe(false)
      await Bun.write(new URL(`../../../.cache/tmp/composer-selection-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      if (width! <= 430) {
        await page.evaluate(`document.querySelector('.composer__mobile-trigger')?.click()`)
        await wait(page, `document.querySelector('.composer__selection-sheet') !== null`)
        const sheet = await page.evaluate<{ visible: boolean; modal: string; targetHeight: number; focused: string }>(`(() => { const dialog=document.querySelector('.composer__selection-sheet'), rect=dialog.getBoundingClientRect(); return { visible:rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, modal:dialog.getAttribute('aria-modal'), targetHeight:document.querySelector('.composer__mobile-trigger').getBoundingClientRect().height, focused:document.activeElement?.getAttribute('aria-label') ?? '' }; })()`)
        expect(sheet.visible).toBe(true)
        expect(sheet.modal).toBe("true")
        expect(sheet.targetHeight).toBeGreaterThanOrEqual(44)
        expect(sheet.focused).toBe("Agent")
        await Bun.write(new URL(`../../../.cache/tmp/composer-selection-sheet-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.pressEscape()
        expect(await page.evaluate<string>(`document.activeElement?.className`)).toBe("composer__mobile-trigger")
      }
    } finally { await page.close() }
  }
}, 90_000)

test("status stays inside a fixed-height composer and pending picks survive unrelated updates", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 620)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Agent"]') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.click()`)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('architect'))?.click()`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await wait(page, `document.querySelector('[role="slider"]') !== null`)
    await page.evaluate(`document.querySelector('[role="slider"]')?.focus()`)
    await page.pressKey("Home", "Home", 36)
    await page.evaluate(`document.querySelector('button[aria-label="Close model picker"]')?.click()`)
    const idle = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)
    expect(idle).toBeLessThanOrEqual(160)
    for (const status of ["running", "waiting", "goal", "goal-yolo", "yolo", "idle"]) {
      await page.evaluate(`window.composerSetStatus(${JSON.stringify(status)})`)
      expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)).toBe(idle)
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.textContent`)).toContain("architect")
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.textContent`)).toContain("low")
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.getAttribute('aria-description')`)).toBe("applies with your next send")
      expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.getAttribute('aria-description')`)).toBe("applies with your next send")
      expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .session-status') !== null`)).toBe(true)
    }
    await page.evaluate(`window.composerSetStatus('goal')`)
    await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-trigger')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.session-status__goal-popover')?.textContent`)).toContain("Finish task")
    await page.evaluate(`document.querySelector('.session-status__goal-popover button')?.click()`)
    expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("session.goal.stop")
  } finally { await page.close() }
}, 30_000)

test("Conversation status controls change this Session's YOLO level and goal at desktop and phone widths", async () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .session-status__yolo-trigger') !== null`)
      if (width === 390) expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.mini-composer__mount .session-status__yolo-trigger,.mini-composer__mount .session-status__goal-trigger')].every(button => { const rect=button.getBoundingClientRect(); return rect.width>=44 && rect.height>=44 })`)).toBe(true)
      await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__yolo-trigger')?.click()`)
      await wait(page, `document.querySelector('.session-status__yolo-popover [role="radiogroup"]') !== null`)
      await Bun.write(new URL(`../../../.cache/tmp/composer-autonomy-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.session-status__yolo-popover [role="radio"]')].map(item => item.querySelector('strong')?.textContent)`)).toEqual(["Standard", "YOLO 1", "YOLO 2", "YOLO 3"])
      expect(await page.evaluate<string>(`document.querySelector('.session-status__yolo-popover')?.textContent`)).toContain("Hard guardrail reviews always require a human decision, even at level 3.")
      if (width === 390) expect(await page.evaluate<boolean>(`(() => { const panel=document.querySelector('.session-status__yolo-popover').getBoundingClientRect(), note=document.querySelector('.session-status__guardrail-note').getBoundingClientRect(); return note.bottom<=panel.bottom+1 })()`)).toBe(true)
      await page.evaluate(`document.querySelector('.session-status__yolo-popover [role="radio"][aria-checked="true"]')?.focus()`)
      await page.pressKey("ArrowRight", "ArrowRight", 39)
      expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toEqual({ operation: "session.autonomy.set", input: { yolo: 1 } })
      await page.evaluate(`[...document.querySelectorAll('.session-status__yolo-popover [role="radio"]')].find(item => item.textContent.includes('YOLO 3'))?.click()`)
      expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toEqual({ operation: "session.autonomy.set", input: { yolo: 3 } })
      await page.evaluate(`document.querySelector('.session-status__yolo-popover [role="radio"][aria-checked="true"]')?.focus()`)
      await page.pressKey("Home", "Home", 36)
      expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toEqual({ operation: "session.autonomy.set", input: { yolo: 0 } })
      await page.pressKey("End", "End", 35)
      expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toEqual({ operation: "session.autonomy.set", input: { yolo: 3 } })
      await page.pressEscape()
      expect(await page.evaluate<string>(`document.activeElement?.getAttribute('aria-label')`)).toBe("Autonomy level")
      await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-trigger')?.click()`)
      await wait(page, `document.querySelector('.session-status__goal-popover input[aria-label="Goal"]') !== null`)
      await Bun.write(new URL(`../../../.cache/tmp/composer-goal-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      expect(await page.evaluate<boolean>(`(() => { const rect=document.querySelector('.session-status__goal-popover').getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight })()`)).toBe(true)
      await type(page, ".session-status__goal-popover input[aria-label='Goal']", "Ship the next release")
      await page.evaluate(`document.querySelector('.session-status__goal-popover button')?.click()`)
      expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toEqual({ operation: "session.goal.set", input: { goal: "Ship the next release" } })
      await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-trigger')?.click()`)
      expect(await page.evaluate<string>(`document.querySelector('.session-status__goal-popover')?.textContent`)).toContain("Ship the next release")
      await page.evaluate(`document.querySelector('.session-status__goal-popover button')?.click()`)
      expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toEqual({ operation: "session.goal.stop", input: { goal: null } })
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 30_000)

test("Goal is visibly off after completion and other terminal states while its control remains reachable", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount .session-status__goal-trigger') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerSetGoalStatus('active')`)
      await Bun.sleep(600)
      const measure = () => page.evaluate<{ name: string | null; color: string; background: string; yoloBackground: string; count: boolean; asymmetry: number; height: number; left: number }>(`(() => { const button=document.querySelector('.mini-composer__mount .session-status__goal-trigger'), yolo=document.querySelector('.mini-composer__mount .session-status__yolo-trigger'), style=getComputedStyle(button), rect=button.getBoundingClientRect(), walker=document.createTreeWalker(button, NodeFilter.SHOW_TEXT), glyphs=[]; for (let node=walker.nextNode(); node; node=walker.nextNode()) { if (!node.textContent.trim() || getComputedStyle(node.parentElement).visibility === 'hidden') continue; const range=document.createRange(); range.selectNodeContents(node); glyphs.push(range.getBoundingClientRect()) } const left=Math.min(...glyphs.map(box => box.left)), right=Math.max(...glyphs.map(box => box.right)); return { name:button.getAttribute('aria-label'), color:style.color, background:style.backgroundColor, yoloBackground:getComputedStyle(yolo).backgroundColor, count:button.querySelector('.session-status__goal-count') !== null, asymmetry:Math.abs((left - rect.left) - (rect.right - right)), height:rect.height, left:rect.left } })()`)
      const active = await measure()
      expect(active.name).toBe("Goal active")
      expect(await page.evaluate<string>(`document.querySelector('.session-status__active-goal')?.textContent?.trim()`)).toBe("Goal active · Finish task")
      expect(active.count).toBe(true)
      expect(active.asymmetry).toBeLessThanOrEqual(1)
      expect(active.background).toBe(active.yoloBackground)
      await Bun.write(new URL(`../../../.cache/tmp/composer-goal-active-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      for (const status of ["completed", "stopped", "exhausted", null] as const) {
        await page.evaluate(`window.composerSetGoalStatus(${JSON.stringify(status)})`)
        const off = await measure()
        expect(off.name).toBe("Goal off")
        expect(await page.evaluate<boolean>(`document.querySelector('.session-status__active-goal') === null`)).toBe(true)
        expect(off.background).not.toBe(off.yoloBackground)
        expect(off.color).not.toBe(active.color)
        expect(off.count).toBe(false)
        expect(off.asymmetry).toBeLessThanOrEqual(1)
        expect(Math.abs(off.height - active.height)).toBeLessThanOrEqual(1)
        expect(Math.abs(off.left - active.left)).toBeLessThanOrEqual(1)
        if (status !== "completed") continue
        await Bun.write(new URL(`../../../.cache/tmp/composer-goal-off-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-trigger')?.click()`)
        expect(await page.evaluate<boolean>(`document.querySelector('.session-status__goal-popover input[aria-label="Goal"]') !== null`)).toBe(true)
        await page.pressEscape()
      }
    } finally { await page.close() }
  }
}, 30_000)

test("managed subagents keep a read-only context bar without autonomy actions", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong') !== null`)
    await page.evaluate(`location.hash='#session=ses_child'`)
    await wait(page, `document.querySelector('.subagent-bar') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('.subagent-bar .session-status__yolo-trigger,.subagent-bar .session-status__goal-trigger') === null && [...document.querySelectorAll('.workspace__main .composer')].every((element) => element.getClientRects().length === 0 || element.closest('[inert]') !== null)`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("a Session switch closes its autonomy picker without carrying a goal draft to another Session", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount .session-status__goal-trigger') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__goal-trigger')?.click()`)
    await type(page, ".session-status__goal-popover input[aria-label='Goal']", "Only for first Session")
    await page.evaluate(`window.composerSwitchSession()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.session-status__goal-popover') === null`)).toBe(true)
    expect(await page.evaluate<boolean>(`window.composerRequests().every(item => item.operation !== 'session.goal.set')`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("unreported Session autonomy does not appear as a Standard selection", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount .session-status__yolo-trigger') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount .session-status__yolo-trigger')?.click(); window.composerClearAutonomy()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .session-status__yolo-trigger,.mini-composer__mount .session-status__goal-trigger,.session-status__popover') === null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("Conversation autonomy controls issue Session-scoped relay operations", async () => {
  for (const width of [1440, 390]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      await wait(page, `document.querySelector('.workspace__main .session-status__yolo-trigger') !== null`)
      await page.evaluate(`document.querySelector('.workspace__main .session-status__yolo-trigger')?.click()`)
      await page.evaluate(`[...document.querySelectorAll('.session-status__yolo-popover [role="radio"]')].find(item => item.textContent.includes('YOLO 2'))?.click()`)
      await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.autonomy.set')`)
      expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.autonomy.set')`)).toMatchObject({ operation: "session.autonomy.set", input: { yolo: 2 } })
      await page.evaluate(`document.querySelector('.workspace__main .session-status__goal-trigger')?.click()`)
      await wait(page, `document.querySelector('.session-status__goal-popover input[aria-label="Goal"]') !== null`)
      await type(page, ".session-status__goal-popover input[aria-label='Goal']", "Ship a reliable Session")
      await page.evaluate(`document.querySelector('.session-status__goal-popover button')?.click()`)
      await wait(page, `(window.remoteOperationReport().operations['session.goal.set'] ?? 0) === 1`)
    } finally { await page.close() }

    const active = await browser!.openPage()
    try {
      await active.setViewport(width, 844)
      await active.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=autonomy-goal-notification-settings-${width === 390 ? 390 : 1440}`)
      await wait(active, `document.querySelector('a[href="/remote"]') !== null`)
      await active.evaluate(`document.querySelector('a[href="/remote"]')?.click()`)
      await wait(active, `document.querySelector('.workspace__main .session-status__goal-trigger')?.textContent?.includes('Goal') === true`)
      await active.evaluate(`document.querySelector('.workspace__main .session-status__goal-trigger')?.click()`)
      await wait(active, `document.querySelector('.session-status__goal-popover button')?.textContent === 'Stop goal'`)
      await active.evaluate(`document.querySelector('.session-status__goal-popover button')?.click()`)
      await wait(active, `(window.remoteOperationReport().operations['session.goal.stop'] ?? 0) === 1`)
    } finally { await active.close() }
  }
}, 45_000)

test("brand and repository actions replace the visible new-session heading", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.new-session-composer__brand') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session-composer__brand')?.textContent`)).toContain("YCoding")
    expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.new-session-composer h2')).position === 'absolute'`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer button[aria-label="Refresh repositories"] svg') !== null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("full skill list scrolls to the last skill without unrelated updates snapping it back", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    await type(page, ".mini-composer__mount textarea", "$")
    await wait(page, `document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button').length === 66`)
    await page.evaluate(`(() => { const list = document.querySelector('.mini-composer__mount .mini-composer__autocomplete'); list.scrollTop = list.scrollHeight; })()`)
    const before = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete').scrollTop`)
    expect(before).toBeGreaterThan(0)
    await page.evaluate(`window.composerSetStatus('running')`)
    expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete').scrollTop`)).toBe(before)
    expect(await page.evaluate<boolean>(`(() => { const list = document.querySelector('.mini-composer__mount .mini-composer__autocomplete'); const last = [...list.querySelectorAll('button')].at(-1); return last?.textContent?.includes('skill-62') && last.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom })()`)).toBe(true)
    await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button:last-of-type')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount textarea')?.value`)).toBe("$skill-62 ")
  } finally { await page.close() }
}, 30_000)

test("model effort supports keyboard and pointer changes and reset to the catalog default", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await wait(page, `document.querySelector('[role="slider"]') !== null`)
    await page.evaluate(`document.querySelector('[role="slider"]')?.focus()`)
    await page.pressKey("Home", "Home", 36)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("low")
    await page.evaluate(`(() => { const slider = document.querySelector('[role="slider"]'); const rect = slider.getBoundingClientRect(); slider.setPointerCapture=()=>{}; slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: rect.right - 1, clientY: rect.top + 4 })); slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: rect.right - 1, clientY: rect.top + 4 })); })()`)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    await page.evaluate(`document.querySelector('button[aria-label="Reset reasoning effort"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
  } finally { await page.close() }
}, 30_000)

test("lightning toggles paired fast models, preserves available effort, and keeps unsupported models selectable", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await wait(page, `document.querySelector('button[aria-label="Fast model"]') !== null`)
    const lightningOffset = await page.evaluate<number>(`document.querySelector('button[aria-label="Fast model"]').getBoundingClientRect().left - document.querySelector('.model-control__surface').getBoundingClientRect().left`)
    expect(await page.evaluate<string>(`document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-pressed')`)).toBe("false")
    await page.evaluate(`document.querySelector('button[aria-label="Fast model"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-pressed')`)).toBe("true")
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.textContent`)).toContain("GPT-6 Sol")
    await Bun.write(new URL("../../../.cache/tmp/composer-fast-desktop.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
    await type(page, ".mini-composer__mount textarea", "Use fast model")
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
    expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ model: { id: "gpt-6-sol-fast", variant: "high" } })
    await page.evaluate(`document.querySelector('button[aria-label="Fast model"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-pressed')`)).toBe("false")
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    await page.evaluate(`document.querySelector('button[aria-label="Fast model"]')?.click()`)
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await wait(page, `document.querySelector('.model-control__model') !== null`)
    expect(await page.evaluate<string>(`[...document.querySelectorAll('.model-control__model')].find(item => item.textContent.includes('GPT-6 Sol') && !item.textContent.includes('Fast'))?.getAttribute('aria-selected')`)).toBe("true")
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].map(item => item.textContent.trim())`)).toEqual(expect.arrayContaining(["GLM Fast Latestglm-fast-latest", "Quant FP8 Fastquant-fp8-fast"]))
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.model-control__model')].some(item => item.textContent.includes('gpt-6-sol-fast') || item.textContent.includes('claude-opus-5-5-fast'))`)).toBe(false)
    await page.evaluate(`[...document.querySelectorAll('.model-control__model')].find(item => item.textContent.includes('Claude Opus 5.5'))?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-pressed')`)).toBe("true")
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    await type(page, ".mini-composer__mount textarea", "Use Claude fast")
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
    expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ model: { providerID: "anthropic", id: "claude-opus-5-5-fast", variant: "high" } })
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await page.evaluate(`[...document.querySelectorAll('.model-control__model')].find(item => item.textContent.includes('GPT-6 Lite'))?.click()`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    const unavailable = await page.evaluate<{ shown: boolean; reason: string | null; rect: number; offset: number }>(`(() => { const button=document.querySelector('button[aria-label="Fast model"]'), surface=document.querySelector('.model-control__surface'); return { shown:!!button, reason:button?.getAttribute('aria-description') ?? null, rect:button?.getBoundingClientRect().width ?? 0, offset:button.getBoundingClientRect().left - surface.getBoundingClientRect().left } })()`)
    expect(unavailable.shown).toBe(true)
    expect(unavailable.reason).toContain("No paired fast model")
    expect(unavailable.rect).toBe(44)
    expect(unavailable.offset).toBe(lightningOffset)
    await Bun.write(new URL("../../../.cache/tmp/composer-fast-unavailable.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await type(page, ".mini-composer__mount textarea", "Use Lite")
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
    expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ model: { providerID: "openai", id: "gpt-6-lite" } })
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await page.evaluate(`[...document.querySelectorAll('.model-control__model')].find(item => item.textContent.includes('Quant FP8 Fast'))?.click()`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.model-control__switch span')?.textContent`)).toBe("Quant FP8 Fast")
    expect(await page.evaluate<string>(`document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-disabled')`)).toBe("true")
  } finally { await page.close() }
}, 30_000)

test("a Session already using a paired fast model displays its base and an active lightning on phone", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 844)
    await page.setCoarsePointer(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html?model=fast`)
    await wait(page, `document.querySelector('.composer__mobile-trigger:not([disabled])') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.composer__mobile-trigger')?.textContent`)).toBe("GSD · GPT-6 Sol · high")
    await page.evaluate(`document.querySelector('.composer__mobile-trigger')?.click()`)
    await wait(page, `document.querySelector('.composer__selection-sheet button[aria-label="Model"]') !== null`)
    await page.evaluate(`document.querySelector('.composer__selection-sheet button[aria-label="Model"]')?.click()`)
    await wait(page, `document.querySelector('button[aria-label="Fast model"]') !== null`)
    const geometry = await page.evaluate<{ target: boolean; contained: boolean; overflow: boolean; label: string; pressed: string | null }>(`(() => { const button=document.querySelector('button[aria-label="Fast model"]'), surface=document.querySelector('.model-control__surface'), control=button.getBoundingClientRect(), box=surface.getBoundingClientRect(); return { target:control.width>=44 && control.height>=44, contained:control.left>=box.left && control.right<=box.right, overflow:document.documentElement.scrollWidth>innerWidth, label:document.querySelector('.model-control__switch span')?.textContent ?? '', pressed:button.getAttribute('aria-pressed') } })()`)
    expect(geometry).toEqual({ target: true, contained: true, overflow: false, label: "GPT-6 Sol", pressed: "true" })
    await Bun.write(new URL("../../../.cache/tmp/composer-fast-phone.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelector('button[aria-label="Fast model"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    expect(await page.evaluate<string>(`document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-pressed')`)).toBe("false")
  } finally { await page.close() }
}, 30_000)

test("every effort level has a distinct gradient and AA hero text in both themes", async () => {
  const variants = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "custom"]
  for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html?model=spectrum`)
      await page.setReducedMotion(true)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]:not([disabled])') !== null`)
      await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
      await wait(page, `document.querySelector('[role="slider"]') !== null`)
      await page.evaluate(`document.querySelector('[role="slider"]')?.focus()`)
      await page.pressKey("Home", "Home", 36)
      const views: { level: string; gradient: string; color: string; background: string }[] = []
      for (const [index] of variants.entries()) {
        if (index) await page.pressKey("ArrowRight", "ArrowRight", 39)
        views.push(await page.evaluate(`(() => { const surface=document.querySelector('.model-control__surface'), hero=surface.querySelector('.model-control__switch strong'), fill=surface.querySelector('.model-control__fill'); return { level:surface.dataset.level, gradient:getComputedStyle(fill).backgroundImage, color:getComputedStyle(hero).color, background:getComputedStyle(surface).backgroundColor } })()`))
      }
      expect(views.map((view) => view.level)).toEqual([...variants.slice(0, -1), "fallback"])
      expect(new Set(views.map((view) => view.gradient)).size).toBe(8)
      expect(views.every((view) => view.gradient.startsWith("linear-gradient"))).toBe(true)
      for (const [index, view] of views.entries()) expect(contrast(view.color, view.background), `${theme} ${variants[index]}`).toBeGreaterThanOrEqual(4.5)
    } finally { await page.close() }
  }
}, 30_000)

test("effort thumb follows drag before snapping, keeps keyboard semantics and suppresses motion when requested", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await page.evaluate(`document.querySelector('[role="slider"]')?.focus()`)
    await page.pressKey("Home", "Home", 36)
    await page.evaluate(`(() => { const slider=document.querySelector('[role="slider"]'), r=slider.getBoundingClientRect(); slider.setPointerCapture=()=>{}; slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerId:7, clientX:r.left, clientY:r.top+15 })); slider.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerId:7, clientX:r.left+r.width*.72, clientY:r.top+15 })); })()`)
    const dragging = await page.evaluate<{ position: number; committed: string; fill: number }>(`(() => { const slider=document.querySelector('[role="slider"]'), thumb=slider.querySelector('.model-control__thumb'), fill=slider.querySelector('.model-control__fill'), track=slider.querySelector('.model-control__track').getBoundingClientRect(), t=thumb.getBoundingClientRect(); return { position:(t.left+t.width/2-track.left)/track.width, committed:slider.getAttribute('aria-valuetext'), fill:fill.getBoundingClientRect().width/track.width } })()`)
    expect(dragging.position).toBeGreaterThan(.65)
    expect(dragging.position).toBeLessThan(.8)
    expect(dragging.fill).toBeGreaterThan(.65)
    expect(dragging.fill).toBeLessThan(.8)
    expect(dragging.committed).toBe("low")
    await page.evaluate(`(() => { const slider=document.querySelector('[role="slider"]'), r=slider.getBoundingClientRect(); slider.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:7, clientX:r.left+r.width*.72, clientY:r.top+15 })); })()`)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("medium")
    await Bun.sleep(300)
    const mediumColor = await page.evaluate<string>(`getComputedStyle(document.querySelector('.model-control__switch strong')).color`)
    await page.pressKey("ArrowLeft", "ArrowLeft", 37)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("low")
    await page.pressKey("End", "End", 35)
    expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("high")
    await Bun.sleep(300)
    const normal = await page.evaluate<{ color: string; transition: string; target: number }>(`(() => { const surface=document.querySelector('.model-control__surface'), fill=surface.querySelector('.model-control__fill'), slider=surface.querySelector('[role="slider"]'); return { color:getComputedStyle(surface.querySelector('.model-control__switch strong')).color, transition:getComputedStyle(fill).transitionDuration, target:slider.getBoundingClientRect().height } })()`)
    expect(normal.target).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.model-control__hero button')].every(button => { const rect=button.getBoundingClientRect(); return rect.width>=44 && rect.height>=44 })`)).toBe(true)
    expect(normal.transition).not.toBe("0s")
    expect(normal.color).not.toBe(mediumColor)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.model-control__sparkles')).animationName`)).toBe("composer-twinkle")
    await page.setReducedMotion(true)
    const reduced = await page.evaluate<{ transition: string; animation: string }>(`(() => { const surface=document.querySelector('.model-control__surface'), fill=surface.querySelector('.model-control__fill'); return { transition:getComputedStyle(fill).transitionDuration, animation:getComputedStyle(surface.querySelector('.model-control__sparkles')).animationDuration } })()`)
    expect(reduced.transition).toBe("0s")
    expect(reduced.animation).toBe("0s")
  } finally { await page.close() }
}, 30_000)

test("model providers have a stronger divider and inset model rows without changing other pickers", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click(); document.querySelector('.model-control__switch')?.click()`)
    await wait(page, `document.querySelector('.model-control__provider') !== null`)
    const style = await page.evaluate<{ weight: number; modelWeight: number; divider: string; inset: number; agentUnchanged: boolean }>(`(() => { const header=document.querySelector('.model-control__provider'), model=header.nextElementSibling, list=document.querySelector('.model-control__surface .mini-picker__list'); return { weight:Number(getComputedStyle(header).fontWeight), modelWeight:Number(getComputedStyle(model).fontWeight), divider:getComputedStyle(header).borderBottomStyle, inset:model.getBoundingClientRect().left-header.getBoundingClientRect().left, agentUnchanged:!document.querySelector('.mini-picker__group:not(.model-control__provider)') } })()`)
    expect(style.weight).toBeGreaterThanOrEqual(style.modelWeight)
    expect(style.divider).toBe("solid")
    expect(style.inset).toBeGreaterThanOrEqual(12)
    expect(style.agentUnchanged).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("model search supports Enter, Escape back, and models without effort variants", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]') !== null`)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await wait(page, `document.querySelector('input[aria-label="Search models"]') !== null`)
    await type(page, "input[aria-label='Search models']", "Claude")
    await page.pressKey("Enter", "Enter", 13)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.textContent`)).toContain("Claude Opus 5.5")
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await wait(page, `document.activeElement?.getAttribute('aria-label') === 'Search models'`)
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`document.querySelector('[role="slider"]') !== null`)).toBe(true)
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`document.querySelector('.model-control__surface') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    await type(page, "input[aria-label='Search models']", "Lite")
    await page.pressKey("Enter", "Enter", 13)
    expect(await page.evaluate<boolean>(`document.querySelector('.model-control__surface') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('[role="slider"]') === null && document.querySelector('button[aria-label="Fast model"]')?.getAttribute('aria-disabled') === 'true'`)).toBe(true)
    await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('input[aria-label="Search models"]') !== null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("paste, picker and drop add removable file chips and send exact file inputs", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 844)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    await page.evaluate(`(() => { const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFiZkAAAAASUVORK5CYII='), value => value.charCodeAt(0)); const file = new File([bytes], 'capture.png', { type: 'image/png' }); const transfer = new DataTransfer(); transfer.items.add(file); document.querySelector('.mini-composer__mount textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); })()`)
    await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 1`)
    expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .composer__attachment img') !== null`)).toBe(true)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment img')?.complete === true`)
    expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__attachment img')?.naturalWidth`)).toBe(1)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment')?.textContent`)).toContain("B")
    await page.evaluate(`(() => { const input = document.querySelector('.mini-composer__mount input[type=file]'); const click = input.click.bind(input); input.click = () => { window.pickerOpened = true }; document.querySelector('.mini-composer__mount button[aria-label="Attach files"]').click(); input.click = click; const transfer = new DataTransfer(); transfer.items.add(new File(['file content'], 'notes.txt', { type: 'text/plain' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    expect(await page.evaluate<boolean>(`window.pickerOpened === true`)).toBe(true)
    await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 2`)
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['drop content'], 'drop.txt', { type: 'text/plain' })); document.querySelector('.mini-composer__mount .composer__row').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); })()`)
    await wait(page, `document.querySelectorAll('.mini-composer__mount .composer__attachment').length === 3`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment')?.textContent`)).toContain("capture.png")
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
    await Bun.write(new URL(`../../../.cache/tmp/composer-attached-390-light.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Remove notes.txt"]')?.click()`)
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(2)
    await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
    await wait(page, `window.composerRequests().some(item => item.operation === 'session.prompt')`)
    expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ text: "", files: [{ name: "capture.png", uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFiZkAAAAASUVORK5CYII=" }, { name: "drop.txt" }] })
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("plain text paste remains native and oversized clipboard files fail visibly before submission", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    expect(await page.evaluate<boolean>(`(() => { const transfer = new DataTransfer(); transfer.setData('text/plain', 'plain words'); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }); document.querySelector('.mini-composer__mount textarea').dispatchEvent(event); return event.defaultPrevented })()`)).toBe(false)
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' })); document.querySelector('.mini-composer__mount textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); })()`)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment-error') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment-error')?.textContent`)).toContain("20 MiB")
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(0)
    expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.disabled`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("upload progress is visible and cancelling stops it without removing the attachment", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['content'], 'capture.png', { type: 'image/png' })); document.querySelector('.mini-composer__mount textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); })()`)
    await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment') !== null`)
    await page.evaluate(`window.composerSetUpload(37)`)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__upload')?.textContent`)).toContain("37%")
    await page.evaluate(`document.querySelector('.mini-composer__mount .composer__upload button')?.click()`)
    expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("upload.cancel")
    expect(await page.evaluate<number>(`document.querySelectorAll('.mini-composer__mount .composer__attachment').length`)).toBe(1)
    expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__attachment-error')?.textContent`)).toContain("cancelled")
  } finally { await page.close() }
}, 30_000)

test("coarse pointer restores 44px composer and repository targets", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1024, 768)
    await page.setCoarsePointer(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Agent"]') !== null`)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.composer__controls button, .new-session-composer__repository button')].every(button => button.getBoundingClientRect().height >= 44)`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("composer states and effort surface retain layout at four sizes in both themes", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Model"]:not([disabled])') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await Bun.sleep(600)
      const idle = await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)
      for (const state of ["idle", "running", "waiting", "goal"]) {
      await page.evaluate(`window.composerSetStatus(${JSON.stringify(state)})`)
      if (state === "waiting") expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .session-status__slot')?.classList.contains('session-status__slot--attention')`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`)).toBe(idle)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true)
      expect(await page.evaluate<boolean>(`(() => { const row = document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect(); return [...document.querySelectorAll('.mini-composer__mount .composer__controls button, .mini-composer__mount .session-status__slot')].filter(item => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== 'hidden').every(item => { const rect = item.getBoundingClientRect(); return rect.left >= row.left - 1 && rect.right <= row.right + 1 }) })()`)).toBe(true)
      const overlaps = await page.evaluate<string[]>(`(() => { const controls = [...document.querySelectorAll('.mini-composer__mount .composer__controls button, .mini-composer__mount .session-status__slot')].filter(item => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== 'hidden'); return controls.flatMap((a, index) => controls.slice(index + 1).flatMap(b => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top ? [] : [a.className + ' / ' + b.className] })) })()`)
      expect(overlaps).toEqual([])
      await Bun.sleep(240)
      await Bun.write(new URL(`../../../.cache/tmp/composer-${state}-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
      if (width! < 480) await page.evaluate(`document.querySelector('.composer__mobile-trigger')?.click()`)
      await page.evaluate(`document.querySelector(${JSON.stringify(width! < 480 ? '.composer__selection-sheet button[aria-label="Model"]' : '.mini-composer__mount .composer__controls button[aria-label="Model"]')})?.click()`)
      await wait(page, `document.querySelector('.model-control__surface') !== null`)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.model-control__surface')).animationName`)).toBe("none")
      await Bun.write(new URL(`../../../.cache/tmp/composer-effort-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 90_000)

test("keyboard and mouse autocomplete, pending identity, and creation work across four sizes and themes", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
        await wait(page, `document.querySelectorAll('.composer textarea').length === 2`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        const input = ".mini-composer__mount textarea"
        for (const [trigger, choice, expected] of [["/pla", "/plan", "/plan "], ["@rev", "@reviewer", "@reviewer "], ["$aud", "$audit", "$audit "], ["#rev", "Reviewer", "@reviewer "]] as const) {
          await type(page, input, trigger)
          await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.textContent?.includes(${JSON.stringify(choice)}) === true`)
          if (trigger === "/pla" || trigger === "$aud") await page.pressKey("Enter", "Enter", 13)
          else await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.click()`)
          expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toBe(expected)
        }
        await type(page, input, "@apps/web")
        await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
        await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.click()`)
        expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toContain("composer.tsx")
        await type(page, input, "@")
        await wait(page, `document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button small').length >= 2`)
        const suggestionLayout = await page.evaluate<{ starts: number[]; lines: number[] }>(`(() => { const items = [...document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button small')].filter(item => item.textContent.trim()); return { starts: items.map(item => item.getBoundingClientRect().left), lines: items.map(item => Math.round(item.getBoundingClientRect().height / parseFloat(getComputedStyle(item).lineHeight))) } })()`)
        expect(new Set(suggestionLayout.starts).size).toBe(1)
        expect(suggestionLayout.lines.every((lines) => lines === 1)).toBe(true)
        if (width === 390 && theme === "light") {
          await type(page, input, "@slow")
          await Bun.sleep(250)
          await type(page, input, "@apps")
          await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
          await Bun.sleep(420)
          expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('slow.txt') ?? false`)).toBe(false)
        }
        if (width! < 480) {
          await page.evaluate(`document.querySelector('.composer__mobile-trigger')?.click()`)
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__selection-sheet[role="dialog"]') !== null`)).toBe(true)
        }
        await page.evaluate(`document.querySelector(${JSON.stringify(width! < 480 ? '.composer__selection-sheet button[aria-label="Agent"]' : '.mini-composer__mount .composer__controls button[aria-label="Agent"]')})?.click()`)
        await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
        if (width! < 480) expect(await page.evaluate<boolean>(`(() => { const item=[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(node=>node.textContent.includes('architect')), rect=item.getBoundingClientRect(); return item.contains(document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2)); })()`)).toBe(true)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["GSD", "architect"])
        expect(await page.evaluate<boolean>(`document.querySelector('.mini-picker__surface')?.classList.contains('mini-picker__surface--sheet')`)).toBe(width! < 768)
        await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('architect'))?.click()`)
        await page.evaluate(`document.querySelector(${JSON.stringify(width! < 480 ? '.composer__selection-sheet button[aria-label="Model"]' : '.mini-composer__mount .composer__controls button[aria-label="Model"]')})?.click()`)
        await wait(page, `document.querySelector('.model-control__switch') !== null`)
        if (width! < 480) expect(await page.evaluate<boolean>(`(() => { const item=document.querySelector('.model-control__switch'), rect=item.getBoundingClientRect(); return item.contains(document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2)); })()`)).toBe(true)
        await page.evaluate(`document.querySelector('.model-control__switch')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__search') !== null`)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__group')].map(item => item.textContent.trim())`)).toEqual(["Anthropic", "OpenAI"])
        await page.evaluate(`(() => { const field = document.querySelector('.mini-picker__search'); field.value = 'Claude'; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
        await page.evaluate(`document.querySelector('.model-control__surface [role="option"]')?.click()`)
        await wait(page, `document.querySelector('[role="slider"][aria-label="Reasoning effort"]') !== null`)
        await page.evaluate(`document.querySelector('[role="slider"][aria-label="Reasoning effort"]')?.focus()`)
        await page.pressKey("End", "End", 35)
        expect(await page.evaluate<string>(`document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')`)).toBe("max")
        await page.evaluate(`document.querySelector('.model-control__heading-actions button[aria-label="Close model picker"]')?.click()`)
        if (width! < 480) {
          expect(await page.evaluate<string>(`document.querySelector('.composer__mobile-trigger')?.textContent`)).toContain("architect · Claude Opus 5.5 · max")
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__mobile-trigger')?.classList.contains('composer__mobile-trigger--pending')`)).toBe(true)
          expect(await page.evaluate<string>(`document.querySelector('.composer__mobile-trigger')?.getAttribute('aria-description')`)).toBe("applies with your next send")
          await page.evaluate(`document.querySelector('button[aria-label="Close agent and model picker"]')?.click()`)
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__selection-sheet') === null`)).toBe(true)
        }
        await type(page, input, "Review $audit")
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ text: "Review $audit", skills: ["audit"], agent: "architect", model: { id: "claude-opus-5-5", variant: "max" } })
        await type(page, input, "/plan now")
        await page.evaluate(`document.querySelector('.mini-composer__mount .composer__delivery-toggle')?.click()`)
        await page.pressKey("Enter", "Enter", 13)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toMatchObject({ operation: "session.command", input: { command: "plan", arguments: "now", delivery: "queue", agent: "architect", model: { variant: "max" } } })
        await page.evaluate(`document.querySelector('main > button')?.click()`)
        await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Interrupt the running step"]') !== null`)
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Interrupt the running step"]')?.click()`)
        expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("session.interrupt")
        await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
        await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('Other repository'))?.click()`)
        await type(page, ".new-session-composer textarea", "Use @apps/web")
        await wait(page, `document.querySelector('.new-session-composer .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
        await page.evaluate(`document.querySelector('.new-session-composer .mini-composer__autocomplete button')?.click()`)
        await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
        await wait(page, `document.querySelector('output')?.textContent?.includes('ses_created') === true`)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ workspaceID: "work_two", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "max" }, prompt: { text: "Use @apps/web/src/remote/ui/composer.tsx", files: [{ uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", mention: { start: 4, text: "@apps/web/src/remote/ui/composer.tsx" } }] } })
        const layout = await page.evaluate<{ overflow: boolean; controlsInside: boolean; touchTargets: boolean }>(`(() => { const rows = [...document.querySelectorAll('.composer__row')]; const controls = [...document.querySelectorAll('.composer__controls button')].filter(button=>button.getBoundingClientRect().width>0); return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, controlsInside: rows.every(row => [...row.querySelectorAll('.composer__controls button')].every(button => button.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1)), touchTargets: controls.every(button => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44) }; })()`)
        expect(layout.overflow).toBe(false)
        expect(layout.controlsInside).toBe(true)
        if (width! < 768) expect(layout.touchTargets).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/composer-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }
}, 180_000)

test("selected slash, dollar, at and hash suggestions dispatch their TUI-equivalent operations", async () => {
  const page = await browser!.openPage()
  const input = ".mini-composer__mount textarea"
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
    await wait(page, `document.querySelector(${JSON.stringify(input)}) !== null`)
    const select = async (text: string, label: string) => {
      await type(page, input, text)
      await wait(page, `[...document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button')].some(item => item.textContent.includes(${JSON.stringify(label)}))`)
      await page.evaluate(`[...document.querySelectorAll('.mini-composer__mount .mini-composer__autocomplete button')].find(item => item.textContent.includes(${JSON.stringify(label)}))?.click()`)
    }
    const send = () => page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
    const operations = () => page.evaluate<readonly { operation: string; input: unknown }[]>(`window.composerRequests()`)

    await select("/go", "/goal")
    await type(page, input, "/goal keep progress. Ship safely")
    await send()
    await wait(page, `window.composerRequests().some(item => item.operation === 'session.goal.set')`)
    expect((await operations()).map((item) => item.operation)).toEqual(["session.goal.set"])
    expect((await operations())[0]?.input).toEqual({ goal: "keep progress. Ship safely" })

    await select("$gpt-", "$gpt-subgent-routing")
    await send()
    await wait(page, `window.composerRequests().length >= 3`)
    expect((await operations()).slice(1).map((item) => item.operation)).toEqual(["session.skill", "session.prompt"])
    expect((await operations())[1]?.input).toMatchObject({ skill: "gpt-subgent-routing" })

    await select("#aud", "Audit")
    expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toBe("$audit ")
    await send()
    await wait(page, `window.composerRequests().length >= 5`)
    expect((await operations()).slice(3).map((item) => item.operation)).toEqual(["session.skill", "session.prompt"])
    expect((await operations())[3]?.input).toMatchObject({ skill: "audit" })

    await select("#rev", "Reviewer")
    expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toBe("@reviewer ")
    await send()
    await wait(page, `window.composerRequests().length >= 6`)
    expect((await operations())[5]).toMatchObject({ operation: "session.prompt", input: { agents: [{ name: "reviewer", mention: { text: "@reviewer" } }] } })

    await select("@apps/web", "composer.tsx")
    await send()
    await wait(page, `window.composerRequests().length >= 7`)
    expect((await operations())[6]).toMatchObject({ operation: "session.prompt", input: { files: [{ uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", mention: { text: "@apps/web/src/remote/ui/composer.tsx" } }] } })

    await select("/front", "/frontend-workflow")
    await send()
    await wait(page, `window.composerRequests().length >= 8`)
    expect((await operations())[7]).toMatchObject({ operation: "session.skill", input: { skill: "frontend-workflow" } })
    expect((await operations()).filter((item) => item.operation === "session.prompt")).toHaveLength(4)

    await select("/pla", "/plan")
    await type(page, input, "/plan now")
    await send()
    await wait(page, `window.composerRequests().length >= 9`)
    expect((await operations())[8]).toMatchObject({ operation: "session.command", input: { command: "plan", arguments: "now" } })

    await type(page, input, "/notacommand hi")
    await send()
    await wait(page, `window.composerRequests().length >= 10`)
    expect((await operations())[9]).toMatchObject({ operation: "session.prompt", input: { text: "/notacommand hi" } })

    await type(page, input, "/Users/me/file.ts explain")
    await send()
    await wait(page, `window.composerRequests().length >= 11`)
    expect((await operations())[10]).toMatchObject({ operation: "session.prompt", input: { text: "/Users/me/file.ts explain" } })

    await type(page, input, "/yolo 3")
    await send()
    await wait(page, `window.composerRequests().length >= 12`)
    expect((await operations())[11]).toEqual({ operation: "session.autonomy.set", input: { yolo: 3 } })
    await type(page, input, "/yolo")
    await send()
    await wait(page, `window.composerRequests().length >= 13`)
    expect((await operations())[12]).toEqual({ operation: "session.autonomy.set", input: { yolo: 0 } })
    expect((await operations()).filter((item) => item.operation === "session.prompt")).toHaveLength(6)

    await type(page, ".new-session-composer textarea", "/go")
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer .mini-composer__autocomplete button') !== null`)).toBe(false)
    await type(page, ".new-session-composer textarea", "/goal new objective")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session-composer [role="alert"]')?.textContent ?? ''`)).toContain("Open a session")
    expect((await operations()).filter((item) => item.operation === "session.create")).toHaveLength(0)
  } finally { await page.close() }
}, 30_000)

async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.setSelectionRange(field.value.length, field.value.length); field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false) }

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
    if (channels.length !== 3) throw new Error(`Unsupported color: ${color}`)
    return channels.map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}
