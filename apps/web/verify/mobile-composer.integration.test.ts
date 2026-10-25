import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4829
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
const composer = ".mini-composer__mount"
const viewports = [[320, 700], [390, 844], [820, 1180], [1440, 900]] as const

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 80 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("the conversation composer keeps its summary, policy words, draft and primary actions inside the page at phone, tablet and desktop widths", async () => {
  for (const [width, height] of viewports) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      if (width < 768) await page.setCoarsePointer(true)
      await openComposer(page, theme)
      await page.evaluate(`window.composerSetGoalStatus('active')`)
      await wait(page, `document.querySelector('${composer} .session-status__active-goal') !== null`)
      await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Toggle running').click()`)
      await wait(page, `document.querySelector('${composer} .mini-composer__interrupt') !== null`)
      const layout = await page.evaluate<{ overflow: boolean; escaped: string[]; undersized: string[]; words: string; trigger: string; name: string | null; title: string | null; chips: string[]; codes: boolean; summaryHeight: number; names: string[]; draftHeight: number; draftLabel: string | null }>(`(() => {
        const mount = document.querySelector('${composer}'), row = mount.querySelector('.composer__row').getBoundingClientRect()
        const named = { attach: '.composer__attach', delivery: '.composer__delivery-toggle', interrupt: '.mini-composer__interrupt', send: '.mini-composer__send', autonomy: '.session-status__autonomous-trigger', goal: '.session-status__goal-trigger' }
        const boxes = Object.entries(named).map(([name, selector]) => [name, mount.querySelector(selector).getBoundingClientRect()])
        const auto = mount.querySelector('.session-status__autonomous-trigger')
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          escaped: [...mount.querySelectorAll('.composer__row button, .composer__row textarea, .session-status__mode')].filter(item => item.getClientRects().length > 0).filter(item => { const rect = item.getBoundingClientRect(); return rect.left < row.left - 1 || rect.right > row.right + 1 || rect.left < 0 || rect.right > innerWidth }).map(item => item.getAttribute('aria-label') ?? item.className),
          undersized: ${width < 768 ? "boxes.filter(([, rect]) => rect.width < 44 || rect.height < 44).map(([name]) => name)" : "[]"},
          words: mount.querySelector('.session-status__active-goal').textContent.trim(),
          trigger: auto.innerText.trim(),
          name: auto.getAttribute('aria-label'),
          title: auto.getAttribute('title'),
          chips: [...mount.querySelectorAll('.session-status__mode')].filter(item => item.getClientRects().length > 0).map(item => item.innerText.trim()),
          codes: /(^|\\s)(Au·|P·|G·|Q·|Zz|R\\d)/.test(mount.innerText),
          summaryHeight: mount.querySelector('.composer__row').getBoundingClientRect().height,
          names: Object.values(named).map(selector => mount.querySelector(selector).getAttribute('aria-label')),
          draftHeight: mount.querySelector('textarea').getBoundingClientRect().height,
          draftLabel: mount.querySelector('textarea').getAttribute('aria-label'),
        }
      })()`)
      expect(layout.overflow).toBe(false)
      expect(layout.escaped).toEqual([])
      expect(layout.undersized).toEqual([])
      expect(layout.words).toBe("Goal active · Finish task")
      expect(layout.name).toBe("Autonomous: Permissions Auto, Guardrails Auto, Answers Manual")
      expect(layout.title).toBe(layout.name)
      expect(layout.chips).toEqual(["Permissions Auto", "Guardrails Auto"])
      expect(layout.codes).toBe(false)
      expect(layout.trigger).toBe(width < 768 ? "Mixed" : "Autonomous")
      expect(layout.names).toEqual(["Attach files", "Steer mode; switch to Queue", "Interrupt the running step", "Send prompt", "Autonomous: Permissions Auto, Guardrails Auto, Answers Manual", "Goal active"])
      expect(layout.draftLabel).toBe("Message your agent")
      expect(layout.draftHeight).toBeGreaterThanOrEqual(44)
      if (width < 768) expect(layout.summaryHeight).toBeLessThanOrEqual(320)
      await capture(page, `mobile-composer-${width}-${theme}`)
    } finally { await page.close() }
  }
}, 120_000)

test("from tablet width identity pickers and primary actions share the first line and status metadata spans a full-width second line without growing the card", async () => {
  for (const [width, height] of [[768, 1024], [820, 1180], [1024, 768], [1440, 900]] as const) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      await openComposer(page, theme)
      const idle = await page.evaluate<number>(`document.querySelector('${composer} .composer__row').getBoundingClientRect().height`)
      await page.evaluate(`window.composerSetGoalStatus('active')`)
      await wait(page, `document.querySelector('${composer} .session-status__active-goal') !== null && document.querySelectorAll('${composer} .session-status__mode').length === 2`)
      await settle(page)
      const geometry = await page.evaluate<{ row: number; sameLine: boolean; below: boolean; spans: boolean; metadataLine: boolean; goalText: boolean; rowBox: { left: number; right: number } }>(`(() => {
        const mount = document.querySelector('${composer}'), row = mount.querySelector('.composer__row'), box = row.getBoundingClientRect()
        const rect = selector => mount.querySelector(selector).getBoundingClientRect()
        const agent = rect('.composer__controls button[aria-label="Agent"]'), model = rect('.composer__controls button[aria-label="Model"]'), send = rect('.mini-composer__send'), status = rect('.session-status')
        const meta = ['.session-status__autonomous-trigger', '.session-status__goal-trigger', '.session-status__mode', '.session-status__active-goal'].map(selector => rect(selector))
        const overlap = (a, b) => a.top < b.bottom && b.top < a.bottom
        const goal = mount.querySelector('.session-status__active-goal')
        return {
          row: box.height,
          sameLine: overlap(agent, send) && overlap(model, send),
          below: status.top >= Math.max(agent.bottom, model.bottom, send.bottom) - 1,
          spans: status.left <= box.left + 16 && status.right >= box.right - 16,
          metadataLine: meta.every(item => Math.abs((item.top + item.bottom) / 2 - (meta[0].top + meta[0].bottom) / 2) <= 4),
          goalText: goal.scrollWidth <= goal.clientWidth + 1,
          rowBox: { left: box.left, right: box.right },
        }
      })()`)
      expect(geometry.sameLine).toBe(true)
      expect(geometry.below).toBe(true)
      expect(geometry.spans).toBe(true)
      expect(geometry.metadataLine).toBe(true)
      expect(geometry.goalText).toBe(true)
      expect(geometry.row).toBeLessThanOrEqual(idle + 1)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await capture(page, `mobile-composer-wide-${width}-${theme}`)
    } finally { await page.close() }
  }
}, 120_000)

test("the selected Conversation shell keeps title, status, todos, transcript, dock and composer usable at phone and tablet widths", async () => {
  for (const [width, height] of [[320, 700], [390, 844], [820, 1180]] as const) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      if (width < 768) await page.setCoarsePointer(true)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      await wait(page, `document.querySelector('.workspace__main .composer__row') !== null && document.querySelector('.workspace__main .session-status__goal-trigger') !== null`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove()`)
      await settle(page)
      const shell = await page.evaluate<{ overflow: boolean; composerInside: boolean; draft: number; transcript: number; targets: string[]; identityVisible: boolean | null; identityLine: boolean | null; slotText: string; slotFits: boolean; slotOffIdentityLine: boolean | null; goalPreview: number }>(`(() => {
        const composer = document.querySelector('.workspace__main .composer').getBoundingClientRect(), draft = document.querySelector('.workspace__main textarea').getBoundingClientRect(), transcript = document.querySelector('.workspace__scroll').getBoundingClientRect()
        const small = [...document.querySelectorAll('.workspace__main .composer button')].filter(item => item.getClientRects().length > 0).filter(item => ${width < 768 ? "item.getBoundingClientRect().height < 44" : "false"}).map(item => item.getAttribute('aria-label') ?? item.className)
        const main = document.querySelector('.workspace__main'), label = main.querySelector('.composer__mobile-label'), slot = main.querySelector('.session-status__slot'), slotLabel = slot.querySelector('.session-status__label'), preview = main.querySelector('.session-status__active-goal')
        const prefixVisible = () => { if (!label) return null; const text = label.firstChild, parts = label.textContent.split(' · '), range = document.createRange(); range.setStart(text, 0); range.setEnd(text, parts[0].length + 3 + parts[1].length); return range.getBoundingClientRect().right <= label.getBoundingClientRect().right + 0.5 }
        const identity = main.querySelector('.composer__mobile-trigger')
        const slotRange = document.createRange(); slotRange.selectNodeContents(slotLabel)
        return { overflow: document.documentElement.scrollWidth > innerWidth, composerInside: composer.left >= 0 && composer.right <= innerWidth && composer.bottom <= innerHeight + 1, draft: draft.height, transcript: transcript.height, targets: small, identityVisible: prefixVisible(), identityLine: identity ? Math.abs(identity.getBoundingClientRect().top - main.querySelector('.session-status__autonomous-trigger').getBoundingClientRect().top) <= 1 : null, slotText: slotLabel.textContent.trim(), slotFits: getComputedStyle(slotLabel).position !== 'absolute' && slotLabel.scrollWidth <= slotLabel.clientWidth + 1 && slot.scrollWidth <= slot.clientWidth + 1 && slotRange.getBoundingClientRect().right <= slot.getBoundingClientRect().right, slotOffIdentityLine: identity ? slot.getBoundingClientRect().top >= identity.getBoundingClientRect().bottom - 1 : null, goalPreview: preview ? preview.getBoundingClientRect().width : 0 }
      })()`)
      expect(shell.overflow).toBe(false)
      expect(shell.composerInside).toBe(true)
      expect(shell.draft).toBeGreaterThanOrEqual(44)
      expect(shell.transcript).toBeGreaterThanOrEqual(height * 0.3)
      expect(shell.targets).toEqual([])
      expect(shell.slotText).toBe("Waiting for your decision")
      expect(shell.slotFits).toBe(true)
      if (width < 768) {
        expect(shell.identityVisible).toBe(true)
        expect(shell.identityLine).toBe(true)
        expect(shell.slotOffIdentityLine).toBe(true)
      }
      expect(shell.goalPreview).toBeGreaterThanOrEqual(120)
      await capture(page, `mobile-shell-${width}-${theme}`)
    } finally { await page.close() }
  }
}, 120_000)

test("send follows the draft, a missing connection disables editing without hiding policy, and catalog failure keeps a 44px retry", async () => {
  for (const [width, height] of viewports) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      if (width < 768) await page.setCoarsePointer(true)
      await openComposer(page, "light")
      const send = `document.querySelector('${composer} button[aria-label="Send prompt"]')`
      expect(await page.evaluate<boolean>(`${send}.disabled`)).toBe(true)
      await type(page, `${composer} textarea`, "Check the mobile layout")
      expect(await page.evaluate<boolean>(`${send}.disabled`)).toBe(false)
      await page.evaluate(`window.composerPredictionEnabled(false)`)
      expect(await page.evaluate<unknown>(`({ field: document.querySelector('${composer} textarea').disabled, send: ${send}.disabled, attach: document.querySelector('${composer} .composer__attach').disabled, autonomy: document.querySelector('${composer} .session-status__autonomous-trigger').disabled, label: document.querySelector('${composer} .session-status__autonomous-trigger').getAttribute('aria-label') })`)).toEqual({ field: true, send: true, attach: true, autonomy: false, label: "Autonomous: Autonomous Manual" })
      await page.evaluate(`window.composerPredictionEnabled(true); window.composerFailCatalogs()`)
      await wait(page, `document.querySelector('${composer} button[aria-label="Retry agent and model catalog"]') !== null`)
      expect(await page.evaluate<{ height: number; inside: boolean; trigger: boolean }>(`(() => { const retry = document.querySelector('${composer} button[aria-label="Retry agent and model catalog"]').getBoundingClientRect(), row = document.querySelector('${composer} .composer__row').getBoundingClientRect(), trigger = document.querySelector('${composer} .composer__mobile-trigger'); return { height: retry.height, inside: retry.left >= row.left - 1 && retry.right <= row.right + 1, trigger: trigger === null || trigger.disabled } })()`)).toMatchObject({ inside: true, trigger: true })
      if (width < 768) expect(await page.evaluate<number>(`document.querySelector('${composer} button[aria-label="Retry agent and model catalog"]').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
      await page.evaluate(`window.composerSetUpload(40)`)
      await wait(page, `document.querySelector('${composer} .composer__upload') !== null`)
      expect(await page.evaluate<{ text: string; cancel: number; overflow: boolean }>(`({ text: document.querySelector('${composer} .composer__upload').innerText, cancel: document.querySelector('${composer} .composer__upload button').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth })`)).toMatchObject({ overflow: false })
      if (width < 768) expect(await page.evaluate<number>(`document.querySelector('${composer} .composer__upload button').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
    } finally { await page.close() }
  }
}, 90_000)

test("below tablet width Autonomous and Goal open named focus-contained sheets and return focus; wider widths keep the Goal popover", async () => {
  for (const reduced of [false, true]) for (const width of [320, 390, 820]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      if (width < 768) await page.setCoarsePointer(true)
      await page.setReducedMotion(reduced)
      await openComposer(page, "dark")
      await page.evaluate(`window.composerSetGoalStatus('active')`)
      await wait(page, `document.querySelector('${composer} .session-status__goal-trigger')?.getAttribute('aria-label') === 'Goal active'`)
      const autonomy = `document.querySelector('${composer} .session-status__autonomous-trigger')`
      await page.evaluate(`${autonomy}.focus(); ${autonomy}.click()`)
      await wait(page, `document.querySelector('dialog.overlay--autonomous[open]') !== null`)
      await settle(page)
      expect(await page.evaluate<{ label: string | null; rows: string[]; inside: boolean }>(`({ label: document.querySelector('dialog.overlay--autonomous').getAttribute('aria-label'), rows: ['permissions','guardrails','answers'].map(category => document.querySelector('#autonomous-row-' + category).getAttribute('aria-label')), inside: (() => { const rect = document.querySelector('dialog.overlay--autonomous .overlay__surface').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })() })`)).toEqual({ label: "Autonomous", rows: ["Permissions: Auto", "Guardrails: Auto", "Answers: Manual"], inside: true })
      if (!reduced) await capture(page, `mobile-autonomous-sheet-${width}`)
      for (let step = 0; step < 8; step += 1) {
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--autonomous').contains(document.activeElement)`)).toBe(true)
      }
      await page.pressEscape()
      await wait(page, `document.querySelector('dialog.overlay--autonomous') === null`)
      expect(await page.evaluate<boolean>(`document.activeElement === ${autonomy}`)).toBe(true)

      const goal = `document.querySelector('${composer} .session-status__goal-trigger')`
      await page.evaluate(`${goal}.focus(); ${goal}.click()`)
      await wait(page, `${goal}.getAttribute('aria-expanded') === 'true'`)
      if (width < 768) {
        await wait(page, `document.querySelector('dialog.overlay--confirm[open]') !== null`)
        await settle(page)
        expect(await page.evaluate<{ label: string | null; text: string; inside: boolean; stop: number }>(`({ label: document.querySelector('dialog.overlay--confirm').getAttribute('aria-label'), text: document.querySelector('.session-status__goal-sheet').textContent, inside: (() => { const rect = document.querySelector('dialog.overlay--confirm .overlay__surface').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })(), stop: document.querySelector('.session-status__goal-sheet button').getBoundingClientRect().height })`)).toMatchObject({ label: "Goal", inside: true })
        expect(await page.evaluate<string>(`document.querySelector('.session-status__goal-sheet').textContent`)).toContain("Finish task")
        expect(await page.evaluate<number>(`document.querySelector('.session-status__goal-sheet button').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
        for (let step = 0; step < 4; step += 1) {
          await page.pressKey("Tab", "Tab", 9)
          expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--confirm').contains(document.activeElement)`)).toBe(true)
        }
        await capture(page, `mobile-goal-sheet-${width}-${reduced ? "reduced" : "motion"}`)
        await page.pressEscape()
        await wait(page, `document.querySelector('dialog.overlay--confirm') === null`)
      } else {
        await wait(page, `document.querySelector('.session-status__goal-popover') !== null`)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--confirm') === null`)).toBe(true)
        await page.pressEscape()
        await wait(page, `document.querySelector('.session-status__goal-popover') === null`)
      }
      expect(await page.evaluate<boolean>(`document.activeElement === ${goal}`)).toBe(true)
      await wait(page, `${goal}.getAttribute('aria-expanded') === 'false'`)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 120_000)

test("the agent and model sheet stays inside the visual viewport while the keyboard is open", async () => {
  for (const width of [320, 390]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 844)
      await page.setCoarsePointer(true)
      await openComposer(page, "light")
      await page.evaluate(`(() => {
        document.documentElement.setAttribute('data-keyboard-open', ''); document.documentElement.style.setProperty('--yc-keyboard-inset', '300px')
        const stub = Object.assign(new EventTarget(), { height: 420, width: ${width}, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 })
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: stub })
      })()`)
      const lifted = await page.evaluate<{ margin: string; actions: boolean; summary: boolean }>(`(() => { const dock = document.querySelector('${composer} .composer'), actions = document.querySelector('${composer} .mini-composer__send').getBoundingClientRect(), summary = document.querySelector('${composer} .composer__mobile-trigger').getBoundingClientRect(); return { margin: getComputedStyle(dock).marginBlockEnd, actions: actions.width >= 44 && actions.height >= 44, summary: summary.height >= 44 } })()`)
      expect(lifted).toEqual({ margin: "300px", actions: true, summary: true })
      await page.evaluate(`document.querySelector('${composer} .composer__mobile-trigger').click()`)
      await wait(page, `document.querySelector('.composer__selection-sheet') !== null`)
      await settle(page)
      await wait(page, `getComputedStyle(document.querySelector('.composer__selection-sheet')).getPropertyValue('--composer-sheet-height') === '420px'`)
      const sheet = await page.evaluate<{ top: number; bottom: number; left: number; right: number; modal: string | null }>(`(() => { const node = document.querySelector('.composer__selection-sheet'), rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, modal: node.getAttribute('aria-modal') } })()`)
      expect(sheet.modal).toBe("true")
      expect(sheet.left).toBeGreaterThanOrEqual(0)
      expect(sheet.right).toBeLessThanOrEqual(width)
      expect(sheet.top).toBeGreaterThanOrEqual(0)
      expect(sheet.bottom).toBeLessThanOrEqual(421)
      await page.pressEscape()
      await wait(page, `document.querySelector('.composer__selection-sheet') === null`)
      expect(await page.evaluate<string>(`document.activeElement?.className`)).toBe("composer__mobile-trigger")
    } finally { await page.close() }
  }
}, 60_000)

test("the todo summary starts compact on phones, names its progress and keeps the saved preference for wider widths", async () => {
  for (const [width, height] of [[320, 700], [390, 844], [1440, 900]] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      if (width < 768) await page.setCoarsePointer(true)
      await page.injectOnNewDocument(`localStorage.setItem('ycoding.remote.todo.expanded', 'true')`)
      await page.navigate(`http://127.0.0.1:${port}/verify/todo-fixture.html`)
      await wait(page, `document.querySelector('.todo-panel__toggle') !== null`)
      const toggle = `document.querySelector('.todo-panel__toggle')`
      expect(await page.evaluate<string>(`${toggle}.getAttribute('aria-label')`)).toBe("Todo list: 3/8 done, current: Current work")
      expect(await page.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)).toBe(width < 768 ? "false" : "true")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      if (width >= 768) continue
      expect(await page.evaluate<number>(`${toggle}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44)
      await page.evaluate(`${toggle}.click()`)
      expect(await page.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)).toBe("true")
      expect(await page.evaluate<boolean>(`(() => { const list = document.querySelector('.todo-panel__list'); return list.getBoundingClientRect().height <= Math.min(176, innerHeight * 0.24) + 1 })()`)).toBe(true)
      expect(await page.evaluate<string | null>(`localStorage.getItem('ycoding.remote.todo.expanded')`)).toBe("true")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

async function openComposer(page: Page, theme: string) {
  await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
  await wait(page, `document.querySelector('${composer} .composer__row') !== null && document.querySelector('${composer} .session-status__goal-trigger') !== null`)
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  await wait(page, `document.querySelector('${composer} button[aria-label="Send prompt"]') !== null`)
}

async function settle(page: Page) {
  await page.evaluate(`document.fonts.ready.then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`)
}

async function capture(page: Page, name: string) {
  await settle(page)
  await page.evaluate(`document.querySelectorAll('.composer-fixture > button').forEach(button => { button.style.display = 'none' })`)
  await Bun.write(new URL(`../../../.cache/tmp/${name}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
}

async function type(page: Page, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.setSelectionRange(field.value.length, field.value.length); field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}

async function wait(page: Page, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}

async function ready() { return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false) }
