import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeRecord, decodeString } from "./cdp"

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

describe("remote responsive state behavior", () => {
  test("Office settings follow Office availability, not heading-only CSS", async () => {
    const reports: { readonly width: number; readonly section: boolean; readonly controls: number; readonly text: string }[] = []
    for (const width of [390, 768, 1440] as const) {
      const page = await fixture(`scenario=autonomy-goal-notification-settings-${width}`, width, "Settings")
      try {
        const state = await page.evaluate(`(() => { const section = document.querySelector('.settings__section[aria-labelledby="office-settings"]'); return {
          section: section !== null, controls: [...(section?.querySelectorAll('button') ?? [])].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden').length,
          text: section?.innerText ?? '' }; })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, section: (decodeBoolean)(record["section"]), controls: (decodeNumber)(record["controls"]), text: (decodeString)(record["text"]) } })
        await Bun.write(new URL(`../../../.cache/tmp/phone-settings-${process.env.PHONE_CAPTURE_PHASE ?? "after"}-office-${width}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        reports.push({ width, ...state })
      } finally { await page.close() }
    }
    expect(reports[0]).toEqual({ width: 390, section: false, controls: 0, text: "" })
    for (const state of reports.slice(1)) {
      expect(state.section).toBe(true)
      expect(state.controls).toBeGreaterThan(0)
      expect(state.text).toContain("Workspace view")
    }
  }, 30_000)

  test("notification headers stay on one line with toggles centered below both channel labels", async () => {
    for (const width of [390, 1440] as const) {
      const page = await fixture(`scenario=autonomy-goal-notification-settings-${width}`, width, "Notifications")
      try {
        await page.evaluate(`document.querySelector('.notification-table')?.scrollIntoView({ block: 'center' })`)
        const layout = await page.evaluate(`(() => {
          const table = document.querySelector('.notification-table'), heads = [...table.querySelectorAll('thead th')], row = table.querySelector('tbody tr');
          return { names: heads.map(head => head.textContent.trim()), categories: [...table.querySelectorAll('tbody th > span:first-child')].map(cell => cell.textContent.trim()), details: [...table.querySelectorAll('tbody th .field__hint')].map(cell => cell.textContent.trim()),
            lines: heads.map(head => { const range = document.createRange(); range.selectNodeContents(head); return range.getClientRects().length }),
            offsets: [...row.querySelectorAll('td')].map((cell, index) => Math.abs((cell.querySelector('.switch').getBoundingClientRect().left + cell.querySelector('.switch').getBoundingClientRect().right) / 2 - (heads[index + 1].getBoundingClientRect().left + heads[index + 1].getBoundingClientRect().right) / 2)),
            overflow: document.documentElement.scrollWidth > innerWidth }; })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, names: (decodeArray(decodeString))(record["names"]), categories: (decodeArray(decodeString))(record["categories"]), details: (decodeArray(decodeString))(record["details"]), lines: (decodeArray(decodeNumber))(record["lines"]), offsets: (decodeArray(decodeNumber))(record["offsets"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(layout.names).toEqual(["Event", "In app", "System"])
        expect(layout.categories).toEqual(["Work finished", "Needs your attention", "Machine offline", "Quota pace"])
        expect(layout.details).toEqual([
          "Get notified when a Session and everything it started, including subagents, shells and goals, has finished. Useful for long-running work.",
          "Get notified when a Session needs your decision, a guardrail blocks an action, or a run fails.",
          "Get notified when a paired machine stops reporting.",
          "Get notified when a provider quota is almost out or on pace to run out before it resets.",
        ])
        expect(layout.lines, JSON.stringify(layout)).toEqual([1, 1, 1])
        expect(layout.offsets.every((offset) => offset <= 1), JSON.stringify(layout)).toBe(true)
        expect(layout.overflow).toBe(false)
      } finally { await page.close() }
    }
  }, 20_000)

  test("keeps Autonomous and goal controls out of Settings at desktop and phone widths", async () => {
    for (const width of [1440, 390] as const) {
      const page = await fixture(`scenario=autonomy-goal-notification-settings-${width}`, width, "Appearance")
      try {
        expect(await page.evaluate(`document.querySelector('#autonomy-settings, .autonomy-choices, input[aria-label="Goal"]') === null`)).toBe(true)
        expect(await page.evaluate(`(document.querySelector('.page-head__support')?.textContent ?? '').includes('autonomy') === false`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("offers System alert permission only while undecided and shows the settled browser state", async () => {
    for (const permission of ["default", "granted", "denied"] as const) {
      const page = await browser!.openPage()
      try {
        await page.injectOnNewDocument(`Object.defineProperty(window, 'Notification', { configurable: true, value: class {
          static permission = ${JSON.stringify(permission)};
          static async requestPermission() { this.permission = 'granted'; return this.permission; }
        } })`)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=autonomy-goal-notification-settings-390`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('#notification-settings') !== null`); attempt += 1) await Bun.sleep(50)
        const row = `(() => { const row = [...(document.querySelector('#notification-settings')?.closest('section')?.querySelectorAll('.defs__row') ?? [])].find(item => item.querySelector('.defs__key')?.textContent === 'System alerts');
          return { button: row?.querySelector('button') !== null, status: row?.querySelector('.field__hint')?.textContent?.trim() ?? '' }; })()`
        expect(await page.evaluate(row)).toEqual({
          button: permission === "default",
          status: permission === "granted" ? "System alerts are allowed in this browser." : permission === "denied"
            ? "System alerts are blocked in this browser's site settings." : "System alerts are not requested yet.",
        })
        if (permission === "default") {
          await page.evaluate(`[...(document.querySelector('#notification-settings')?.closest('section')?.querySelectorAll('.defs__row') ?? [])].find(item => item.querySelector('.defs__key')?.textContent === 'System alerts')?.querySelector('button')?.click()`)
          for (let attempt = 0; attempt < 40 && (await page.evaluate(row, (value: unknown) => { const record = decodeRecord(value); return { ...record, button: (decodeBoolean)(record["button"]), status: (decodeString)(record["status"]) } })).button; attempt += 1) await Bun.sleep(50)
          expect(await page.evaluate(row)).toEqual({ button: false, status: "System alerts are allowed in this browser." })
        }
      } finally { await page.close() }
    }
  }, 30_000)

  test("renders System, Light, and Dark Appearance icons in both themes at every viewport", async () => {
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]] as const) for (const theme of ["light", "dark"] as const) {
      const page = await fixture(`scenario=autonomy-goal-notification-settings-${width === 820 ? 768 : width}`, width, "Appearance", theme, height)
      try {
        const icons = await page.evaluate(`[...document.querySelectorAll('.appearance-segments [role="radio"]')].map(button => ({ name: button.textContent.trim(), paths: button.querySelectorAll('svg path[d]').length, width: button.querySelector('svg')?.getBoundingClientRect().width ?? 0, height: button.querySelector('svg')?.getBoundingClientRect().height ?? 0 }))`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, name: (decodeString)(record["name"]), paths: (decodeNumber)(record["paths"]), width: (decodeNumber)(record["width"]), height: (decodeNumber)(record["height"]) } }))
        expect(icons.map((icon) => icon.name)).toEqual(["System", "Light", "Dark"])
        expect(icons.every((icon) => icon.paths > 0 && icon.width >= 16 && icon.height >= 16), JSON.stringify({ width, theme, icons })).toBe(true)
        await page.evaluate(`document.querySelector('.appearance-segments')?.scrollIntoView({ block: 'center' })`)
        await Bun.write(new URL(`../../../.cache/tmp/shell-settings-appearance-${width}x${height}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 30_000)

  test("confirms one or all revoked-device removals without affecting enrolled machines", async () => {
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]] as const) {
      const page = await fixture(`scenario=devices-enrollment-${width === 820 ? 768 : width}&deviceCleanup=two`, width, "Legacy-MacBook", undefined, height)
      try {
        const removeOne = 'button[aria-label="Remove Legacy-MacBook"]'
        expect(await page.evaluate(`document.querySelector(${JSON.stringify(removeOne)}) !== null && document.querySelector('button[aria-label="Remove all revoked devices"]') !== null`)).toBe(true)
        await page.evaluate(`document.querySelector(${JSON.stringify(removeOne)})?.click()`)
        expect(await page.evaluate(`document.querySelector('dialog[aria-label="Remove revoked device"]')?.open === true`)).toBe(true)
        expect(await page.evaluate(`document.querySelector('dialog[aria-label="Remove revoked device"]')?.contains(document.activeElement) === true`)).toBe(true)
        expect(await page.evaluate(`window.remoteCleanupReport().length`)).toBe(0)
        if (width === 1440) {
          const geometry = await page.evaluate(`(() => {
            const dialog=document.querySelector('dialog[aria-label="Remove revoked device"]'),head=dialog.querySelector('.overlay__head'),body=dialog.querySelector('.overlay__body'),title=head.querySelector('.overlay__title'),text=body.querySelector('p'),actions=body.querySelector('.device-cleanup-actions');
            const headBox=head.getBoundingClientRect(),titleBox=title.getBoundingClientRect(),bodyBox=body.getBoundingClientRect(),textBox=text.getBoundingClientRect(),actionsBox=actions.getBoundingClientRect(),headStyle=getComputedStyle(head),bodyStyle=getComputedStyle(body);
            const left=parseFloat(bodyStyle.paddingLeft),right=parseFloat(bodyStyle.paddingRight),bottom=parseFloat(bodyStyle.paddingBottom);
            return {sameInset:Math.abs(titleBox.left-headBox.left-parseFloat(headStyle.paddingLeft))<1&&Math.abs(left-parseFloat(headStyle.paddingLeft))<1&&Math.abs(textBox.left-bodyBox.left-left)<1,actionsInside:actionsBox.right<=bodyBox.right-right+1&&actionsBox.bottom<=bodyBox.bottom-bottom+1};
          })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, sameInset: (decodeBoolean)(record["sameInset"]), actionsInside: (decodeBoolean)(record["actionsInside"]) } })
          expect(geometry.sameInset).toBe(true)
          expect(geometry.actionsInside).toBe(true)
        }
        await page.pressEscape()
        expect(await page.evaluate(`document.activeElement?.getAttribute('aria-label') ?? ''`)).toBe("Remove Legacy-MacBook")
        expect(await page.evaluate(`document.querySelector('.device-table .device__name')?.textContent?.includes('Studio Mac') ?? false`)).toBe(true)
        await page.evaluate(`document.querySelector(${JSON.stringify(removeOne)})?.click()`)
        await page.evaluate(`document.querySelector('dialog[aria-label="Remove revoked device"] button[data-confirm-remove]')?.click()`)
        for (let attempt = 0; attempt < 40 && await page.evaluate(`document.body.innerText.includes('Legacy-MacBook')`, decodeBoolean); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate(`[...document.querySelectorAll('.device-table .device__name')].map(row => row.textContent.trim())`)).toEqual(["Studio Mac", "Workstation-Box", "Backup Mac"])
        for (let attempt = 0; attempt < 120 && await page.evaluate(`document.querySelector('button[aria-label="Remove all revoked devices"]')?.disabled !== false`, decodeBoolean); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate(`document.querySelector('button[aria-label="Remove all revoked devices"]')?.disabled === false`)).toBe(true)
        await page.evaluate(`document.querySelector('button[aria-label="Remove all revoked devices"]')?.click()`)
        for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('dialog[aria-label="Remove all revoked devices"]')?.open === true`); attempt += 1) await Bun.sleep(25)
        expect(await page.evaluate(`document.querySelector('dialog[aria-label="Remove all revoked devices"]')?.open === true`)).toBe(true)
        await page.evaluate(`document.querySelector('dialog[aria-label="Remove all revoked devices"] button[data-confirm-remove]')?.click()`)
        for (let attempt = 0; attempt < 120 && await page.evaluate(`document.body.innerText.includes('Backup Mac')`, decodeBoolean); attempt += 1) await Bun.sleep(50)
        expect(await page.evaluate(`[...document.querySelectorAll('.device-table .device__name')].map(row => row.textContent.trim())`)).toEqual(["Studio Mac", "Workstation-Box"])
        expect(await page.evaluate(`window.remoteCleanupReport()`)).toEqual(["dev_legacy", "all"])
        expect(await page.evaluate(`document.activeElement?.textContent?.includes('Create enrollment code') ?? false`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("keeps a failed revoked-device removal visible until the user retries it", async () => {
    const page = await fixture("scenario=devices-enrollment-390&deviceCleanupFailure=once", 390, "Legacy-MacBook")
    try {
      await page.evaluate(`document.querySelector('button[aria-label="Remove Legacy-MacBook"]')?.click()`)
      await page.evaluate(`document.querySelector('dialog[aria-label="Remove revoked device"] button[data-confirm-remove]')?.click()`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('[role="alert"]')?.textContent?.includes('Device cleanup is unavailable') ?? false`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate(`document.querySelector('dialog[aria-label="Remove revoked device"] [role="alert"]')?.textContent?.includes('Device cleanup is unavailable') ?? false`)).toBe(true)
      expect(await page.evaluate(`document.body.innerText.includes('Legacy-MacBook')`)).toBe(true)
      expect(await page.evaluate(`window.remoteCleanupReport()`)).toEqual(["dev_legacy"])
      await page.evaluate(`document.querySelector('dialog[aria-label="Remove revoked device"] button[data-confirm-remove]')?.click()`)
      for (let attempt = 0; attempt < 40 && await page.evaluate(`document.body.innerText.includes('Legacy-MacBook')`, decodeBoolean); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate(`document.body.innerText.includes('Legacy-MacBook')`)).toBe(false)
      expect(await page.evaluate(`window.remoteCleanupReport()`)).toEqual(["dev_legacy", "dev_legacy"])
    } finally { await page.close() }
  }, 30_000)

  test("spaces device removal copy and actions while Cancel retains keyboard clearance", async () => {
    const observations = []
    for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of ["light", "dark"] as const) {
      const page = await fixture("view=settings&deviceCleanup=two", width, "Remove all revoked devices", theme, height)
      try {
        await page.setCoarsePointer(width === 390)
        await page.setReducedMotion(true)
        const trigger = `document.querySelector('button[aria-label="Remove all revoked devices"]')`
        await page.evaluate(`${trigger}.focus()`)
        await page.pressKey("Enter", "Enter", 13, "\r")
        await page.pressKey("Tab", "Tab", 9)
        const geometry = await page.evaluate(`(() => {
          const dialog = document.querySelector('dialog[open][aria-label="Remove all revoked devices"]');
          const body = dialog.querySelector('.overlay__body');
          const surface = dialog.querySelector('.overlay__surface');
          const actions = body.querySelector('.device-cleanup-actions');
          const copy = body.querySelector('p');
          const cancel = actions.querySelector('button');
          const rect = node => node.getBoundingClientRect();
          const focus = getComputedStyle(cancel);
          const ring = parseFloat(focus.outlineWidth) + parseFloat(focus.outlineOffset);
          return {
            gap: rect(actions).top - rect(copy).bottom,
            bottom: rect(surface).bottom - rect(actions).bottom,
            focusClearance: rect(surface).bottom - rect(cancel).bottom - ring,
            cancelFocused: document.activeElement === cancel && cancel.textContent === 'Cancel' && cancel.matches(':focus-visible'),
            controlsFit: body.scrollWidth === body.clientWidth && [...actions.children].every(button => rect(button).height >= 44 && rect(button).right <= rect(body).right),
          };
        })()`)
        await page.pressEscape()
        const dismissed = await page.evaluate(`!document.querySelector('dialog[open]') && document.activeElement === ${trigger} && window.remoteCleanupReport().length === 0`)
        observations.push({ width, theme, geometry, dismissed })
      } finally { await page.close() }
    }
    expect(observations).toEqual(([1440, 390] as const).flatMap(width => (["light", "dark"] as const).map(theme => ({
      width, theme, geometry: { gap: 16, bottom: 16, focusClearance: 12, cancelFocused: true, controlsFit: true }, dismissed: true,
    }))))
  }, 30_000)

  test("returns device-removal focus to the clicked control without a focused click", async () => {
    const page = await fixture("scenario=devices-enrollment-390&deviceCleanup=two", 390, "Legacy-MacBook")
    try {
      for (const label of ["Remove Legacy-MacBook", "Remove all revoked devices"] as const) {
        await page.evaluate(`(() => {
          const trigger = document.querySelector('button[aria-label="${label}"]');
          document.querySelector('.skip-link').focus();
          const focus = trigger.focus;
          trigger.focus = () => {};
          trigger.click();
          trigger.focus = focus;
        })()`)
        expect(await page.evaluate(`document.querySelector('dialog[open]')?.getAttribute('aria-label') === ${JSON.stringify(label === "Remove Legacy-MacBook" ? "Remove revoked device" : "Remove all revoked devices")}`)).toBe(true)
        await page.pressEscape()
        expect(await page.evaluate(`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(label)}`)).toBe(true)
      }
    } finally { await page.close() }
  }, 15_000)

  test("returns focus to the remote Sessions opener after an unfocused click", async () => {
    for (const [width, trigger, label] of [[390, ".app-header__menu", "Sessions"]] as const) {
      const page = await scenario("conversation-workspace", width, "Studio Mac")
      try {
        await page.evaluate(`document.querySelector('.skip-link')?.focus(); document.querySelector(${JSON.stringify(trigger)})?.click()`)
        expect(await page.evaluate(`document.querySelector('dialog[aria-label="${label}"][open]') !== null`)).toBe(true)
        await page.pressEscape()
        const state = await page.evaluate(`({ open: document.querySelector('dialog[aria-label="${label}"][open]') !== null, focused: document.activeElement === document.querySelector(${JSON.stringify(trigger)}), active: document.activeElement?.outerHTML.slice(0, 120) ?? '' })`)
        expect(state, `${label}: ${JSON.stringify(state)}`).toMatchObject({ open: false, focused: true })
      } finally { await page.close() }
    }
  }, 15_000)

  test("exposes one remote main landmark and the active narrow navigation destination", async () => {
    const page = await scenario("conversation-workspace", 390, "Token expiry refactor")
    try {
      expect(await page.evaluate(`({
        main: document.querySelectorAll('main').length,
        skip: document.querySelector('.skip-link')?.getAttribute('href') ?? null,
        current: document.querySelector('.bottom-nav__item--active')?.getAttribute('aria-current') ?? null,
      })`)).toEqual({ main: 1, skip: "#remote-main", current: "page" })
      await page.pressEscape()
      expect(await page.evaluate(`document.querySelector('.custom-select__dialog')?.hasAttribute('open') ?? false`)).toBe(false)
      await page.evaluate(`document.querySelector('.skip-link')?.focus()`)
      await page.pressKey("Enter", "Enter", 13)
      for (let attempt = 0; attempt < 20 && await page.evaluate(`document.activeElement?.id ?? ''`) !== "remote-main"; attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate(`document.activeElement?.id ?? ''`)).toBe("remote-main")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("moves through theme radios with one Tab stop", async () => {
    const page = await scenario("autonomy-goal-notification-settings", 390, "Appearance")
    try {
      await page.evaluate(`document.querySelector('.appearance-segments [role="radio"]')?.click()`)
      const group = (selector: string) => `(() => {
        const radios = [...document.querySelectorAll(${JSON.stringify(selector)})];
        return { checked: radios.findIndex(radio => radio.getAttribute('aria-checked') === 'true'),
          tabs: radios.map(radio => radio.tabIndex), focus: radios.indexOf(document.activeElement) };
      })()`
      const radioState = (selector: string) => page.evaluate(group(selector), (value: unknown) => { const record = decodeRecord(value); return { ...record, checked: (decodeNumber)(record["checked"]), tabs: (decodeArray(decodeNumber))(record["tabs"]), focus: (decodeNumber)(record["focus"]) } })
      expect(await radioState('.appearance-segments [role="radio"]')).toMatchObject({ checked: 0, tabs: [0, -1, -1] })
      await page.evaluate(`document.querySelector('.appearance-segments [role="radio"]')?.focus()`)
      await page.pressKey("ArrowRight", "ArrowRight", 39)
      expect(await radioState('.appearance-segments [role="radio"]')).toEqual({ checked: 1, tabs: [-1, 0, -1], focus: 1 })
      await page.pressKey("End", "End", 35)
      expect(await radioState('.appearance-segments [role="radio"]')).toEqual({ checked: 2, tabs: [-1, -1, 0], focus: 2 })

    } finally {
      await page.close()
    }
  }, 30_000)

  test("matches conversation workspace behavior across desktop, tablet, and mobile without an Activity screen or opener", async () => {
    for (const width of [1440, 768, 390] as const) {
      for (const theme of ["dark", "light"] as const) {
        const page = await scenario("conversation-workspace", width, "Studio Mac", theme)
        const state = await page.evaluate(`(() => {
          const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
          const app = document.querySelector('.app');
          return {
            columns: app instanceof HTMLElement ? getComputedStyle(app).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
            railVisible: visible(document.querySelector('.workspace__rail')),
            activityControl: document.querySelectorAll('button[aria-label="Open activity"]').length,
            activityNavigation: document.querySelectorAll('a[href="/remote/activity"]').length,
            bottomNavigationVisible: visible(document.querySelector('.bottom-nav')),
          };
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, columns: (decodeNumber)(record["columns"]), railVisible: (decodeBoolean)(record["railVisible"]), activityControl: (decodeNumber)(record["activityControl"]), activityNavigation: (decodeNumber)(record["activityNavigation"]), bottomNavigationVisible: (decodeBoolean)(record["bottomNavigationVisible"]) } })
        expect(state.columns).toBe(width >= 768 ? 2 : 1)
        expect(state.railVisible).toBe(width >= 768)
        expect(state.activityControl).toBe(0)
        expect(state.activityNavigation).toBe(0)
        expect(state.bottomNavigationVisible).toBe(width < 768)
        await page.close()
      }
    }
  }, 30_000)

  test("does not apply the centered conversation-empty composition to Sessions or Settings", async () => {
    for (const [view, expected] of [
      ["sessions", "No sessions"],
      ["settings", "Account"],
    ] as const) {
      const page = await fixture(`view=${view}&sessions=empty`, 768, expected)
      const state = await page.evaluate(`(() => {
        const app = document.querySelector('.app');
        const scroll = document.querySelector('.workspace__scroll');
        return {
          classes: app?.className ?? '',
          placeItems: scroll instanceof HTMLElement ? getComputedStyle(scroll).placeItems : '',
        };
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, classes: (decodeString)(record["classes"]), placeItems: (decodeString)(record["placeItems"]) } })
      expect(state.classes).toContain(`app--${view}`)
      expect(state.classes).not.toContain("app--empty")
      expect(state.placeItems).not.toContain("center")
      await page.close()
    }
  }, 30_000)

  test("keeps the shared desktop Session rail compact while switching repository context", async () => {
    const page = await scenario("conversation-workspace", 1440, "auth_guard.go")
    for (const [project, title] of [["auth", "Token expiry refactor"], ["indexer", "Query batch indexer"], ["mesh", "Mesh peer sync daemon"]] as const) {
      await selectSessionWorkspace(page, project, title, ".workspace__rail", ".session-row")
      const rows = await page.evaluate(`[...document.querySelectorAll('.workspace__rail .session-row')].map(row=>({height:row.getBoundingClientRect().height,text:row.textContent.replace(/\\s+/g,' ').trim()}))`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), text: (decodeString)(record["text"]) } }))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.height).toBeLessThanOrEqual(96)
      expect(rows[0]?.text).toContain(title)
      expect(rows[0]?.text).not.toContain("openai/gpt-6")
    }
    await page.close()
  }, 30_000)

  test("uses the compact Sessions composition with one page heading and a generic New session action", async () => {
    const page = await scenario("session-list", 768, "Async Auth Token Revocation Migration")
    await selectSessionWorkspace(page, "db-pruner", "Postgres Partition Pruning Worker")
    const state = await page.evaluate(`(() => { const heading=document.querySelector('.sessions-page .page-head'); const grid=document.querySelector('.sessions-table'); const action=document.querySelector('.sessions-page > .page-head .new-session__trigger'); return {headingVisible:heading instanceof HTMLElement&&getComputedStyle(heading).display!=='none',title:document.querySelectorAll('.sessions-page h1').length===1?document.querySelector('.sessions-page h1').textContent.trim():'',newSession:action instanceof HTMLElement&&action.getBoundingClientRect().height>0,columns:grid instanceof HTMLElement?getComputedStyle(grid).gridTemplateColumns.split(' ').length:0} })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, headingVisible: (decodeBoolean)(record["headingVisible"]), title: (decodeString)(record["title"]), newSession: (decodeBoolean)(record["newSession"]), columns: (decodeNumber)(record["columns"]) } })
    expect(state.headingVisible).toBe(true)
    expect(state.title).toBe("Sessions")
    expect(state.newSession).toBe(true)
    expect(state.columns).toBe(1)
    await page.close()
  }, 30_000)

  test("uses available desktop width for the session list without losing rows or targets", async () => {
    const page = await scenario("session-list", 1440, "Async Auth Token Revocation Migration")
    await selectSessionWorkspace(page, "db-pruner", "Postgres Partition Pruning Worker")
    for (const width of [1280, 1440, 1599, 1600, 2048] as const) {
      await page.setViewport(width, 900)
      const state = await page.evaluate(`(() => {
        const table = document.querySelector('.sessions-results')
        const rows = [...document.querySelectorAll('.sessions-table__row')]
        const targets = [...document.querySelectorAll('.sessions-table__select')]
        if (!(table instanceof HTMLElement) || !(rows[0] instanceof HTMLElement) || targets.length === 0) throw new Error('session list Sessions table missing')
        const layout = document.querySelector('.sessions-page__layout').getBoundingClientRect()
        return {
          available: document.querySelector('.workspace__scroll').clientWidth,
          width: layout.width,
          center: layout.left + layout.width / 2,
          contentCenter: (() => { const scroller = document.querySelector('.workspace__scroll'); return scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth / 2 })(),
          tableWidth: table.getBoundingClientRect().width,
          contentWidth: document.querySelector('.sessions-page__content').getBoundingClientRect().width,
          viewport: innerWidth,
          rows: rows.length,
          columns: getComputedStyle(rows[0]).gridTemplateColumns.split(' ').length,
          minTargetHeight: Math.min(...targets.map(target => target.getBoundingClientRect().height)),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, available: (decodeNumber)(record["available"]), width: (decodeNumber)(record["width"]), center: (decodeNumber)(record["center"]), contentCenter: (decodeNumber)(record["contentCenter"]), viewport: (decodeNumber)(record["viewport"]), rows: (decodeNumber)(record["rows"]), columns: (decodeNumber)(record["columns"]), minTargetHeight: (decodeNumber)(record["minTargetHeight"]), overflowing: (decodeBoolean)(record["overflowing"]), tableWidth: (decodeNumber)(record["tableWidth"]), contentWidth: (decodeNumber)(record["contentWidth"]) } })
      const maximum = width >= 1600 ? 1600 : 1200
      expect(state.width, JSON.stringify(state)).toBeLessThanOrEqual(maximum)
      expect(state.width, JSON.stringify(state)).toBeGreaterThanOrEqual(Math.min(maximum, state.available - (width >= 1600 ? 96 : 80)))
      expect(Math.abs(state.center - state.contentCenter)).toBeLessThanOrEqual(2)
      expect(state.tableWidth).toBeGreaterThanOrEqual(state.contentWidth - 2)
      expect(state.rows).toBe(1)
      expect(state.columns).toBe(3)
      expect(state.minTargetHeight).toBeGreaterThanOrEqual(44)
      expect(state.overflowing).toBe(false)
    }
    await page.close()
  }, 30_000)

  test("keeps every Sessions selection target touch-sized on compact layouts", async () => {
    for (const width of [390, 768] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("session-list", width, "Async Auth Token Revocation Migration", theme)
        const targets: { readonly height: number; readonly width: number }[] = []
        for (const [directory, title] of [
          ["auth-gate", "Async Auth Token Revocation Migration"],
          ["telemetry-daemon", "Telemetry Event Buffer Flush Daemon"],
          ["cache-redis", "Redis Cache Cluster Rebalancing Spec"],
          ["db-pruner", "Postgres Partition Pruning Worker"],
        ] as const) {
          await selectSessionWorkspace(page, directory, title)
          targets.push(...await page.evaluate(`[...document.querySelectorAll('.sessions-table__select')].map(button => ({ height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width }))`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), width: (decodeNumber)(record["width"]) } })))
        }
        expect(targets).toHaveLength(4)
        expect(targets.every((target) => target.height >= 44 && target.width >= 44)).toBe(true)
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        await page.close()
      }
    }
  }, 30_000)

  test("keeps session list compact Session status beside its title without losing metadata", async () => {
    for (const width of [390, 768] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("session-list", width, "Async Auth Token Revocation Migration", theme)
        const state = await page.evaluate(`(() => {
          const row = document.querySelector('.sessions-table__row')
          const title = row?.querySelector('.sessions-table__title')
          const status = row?.querySelector('.sessions-table__status')
          if (!(row instanceof HTMLElement) || !(title instanceof HTMLElement) || !(status instanceof HTMLElement)) throw new Error('session list Session row missing')
          return {
            rowHeight: row.getBoundingClientRect().height,
            statusOffset: status.getBoundingClientRect().top - title.getBoundingClientRect().top,
            title: title.textContent?.trim() ?? '',
            project: document.querySelector('.sessions-page__title')?.textContent?.trim() ?? '',
            updated: row.querySelector('.sessions-table__updated')?.textContent?.trim() ?? '',
            targets: [...document.querySelectorAll('.sessions-table__select')].map(button => button.getBoundingClientRect().height),
            rowCount: document.querySelectorAll('.sessions-table__row').length,
            overflowing: document.documentElement.scrollWidth > innerWidth,
          }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, rowHeight: (decodeNumber)(record["rowHeight"]), statusOffset: (decodeNumber)(record["statusOffset"]), title: (decodeString)(record["title"]), project: (decodeString)(record["project"]), updated: (decodeString)(record["updated"]), targets: (decodeArray(decodeNumber))(record["targets"]), rowCount: (decodeNumber)(record["rowCount"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
        expect(state.statusOffset).toBeGreaterThanOrEqual(-2)
        expect(state.statusOffset).toBeLessThanOrEqual(8)
        expect(state.rowHeight).toBeLessThanOrEqual(width === 390 ? 164 : 150)
        expect(state.title).toBe("Async Auth Token Revocation Migration")
        expect(state.project).toBe("auth-gate")
        expect(state.updated).not.toBe("")
        expect(state.targets).toHaveLength(1)
        expect(state.targets.every((height) => height >= 44)).toBe(true)
        expect(state.rowCount).toBe(1)
        expect(await page.evaluate(`[...document.querySelectorAll('.workspace-select [aria-label="Workspace"]')].some(trigger => trigger.getBoundingClientRect().width > 0)`)).toBe(true)
        expect(state.overflowing).toBe(false)
        await page.close()
      }
    }
  }, 30_000)

  test("shows the selected idle Session's real state in the mobile conversation context", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await scenario("conversation-workspace", 390, "Token expiry refactor", theme)
      const status = await page.evaluate(`(() => {
        const control = document.querySelector('.composer .session-status__autonomous-trigger');
        return { label: control?.textContent?.trim().startsWith('Autonomous Manual') ? 'Autonomous Manual' : (control?.textContent?.trim() ?? ''), visible: control instanceof HTMLElement && control.getBoundingClientRect().height > 0 && getComputedStyle(control).display !== 'none' };
      })()`)
      expect(status).toEqual({ label: "Autonomous Manual", visible: true })
      expect(await page.evaluate(`document.querySelector('.conversation-breadcrumb') !== null && document.querySelector('.conversation-breadcrumb').textContent.includes('Running') === false`)).toBe(true)
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("aligns conversation decision cards with the transcript in one start-aligned column", async () => {
    const page = await scenario("permission-guardrail-hard-review-form-requests", 1440, "Clarify Disambiguation Query")
    const layout = await page.evaluate(`(() => {
      const transcript = document.querySelector('.transcript')
      const requests = document.querySelector('.requests')
      if (!(transcript instanceof HTMLElement) || !(requests instanceof HTMLElement)) throw new Error('Conversation transcript or pending decisions missing')
      const bounds = transcript.getBoundingClientRect()
      return {
        transcript: { left: bounds.left, right: bounds.right },
        cards: [...requests.querySelectorAll('.request')].map(card => { const rect = card.getBoundingClientRect(); return { left: rect.left, right: rect.right } }),
        requestsFollowTranscript: Boolean(transcript.compareDocumentPosition(requests) & Node.DOCUMENT_POSITION_FOLLOWING),
      }
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, transcript: ((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } })(record["transcript"]), cards: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, left: (decodeNumber)(record["left"]), right: (decodeNumber)(record["right"]) } }))(record["cards"]), requestsFollowTranscript: (decodeBoolean)(record["requestsFollowTranscript"]) } })
    expect(layout.cards).toHaveLength(6)
    expect(layout.cards.every((card) => Math.abs(card.left - layout.transcript.left) <= 1 && Math.abs(card.right - layout.transcript.right) <= 1)).toBe(true)
    expect(layout.requestsFollowTranscript).toBe(true)
    await page.close()
  }, 30_000)

  test("distinguishes owned question indicators without changing native answers or touch targets", async () => {
    for (const [width, marker, optionCount, actionCount] of [
      [390, "Select Target Cluster", 2, 6],
      [768, "syslog daemon bridge", 3, 4],
      [1440, "Clarify Disambiguation Query", 4, 6],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("permission-guardrail-hard-review-form-requests", width, marker, theme)
        const state = await page.evaluate(`(() => {
          const options = [...document.querySelectorAll('.request .question__option')]
          const selected = options.find(option => option.querySelector('input:checked'))
          const other = options.find(option => option.querySelector('input:not(:checked)'))
          if (!(selected instanceof HTMLElement) || !(other instanceof HTMLElement)) throw new Error('permission and guardrail reviews choice states missing')
          return {
            options: options.length,
            minHeight: Math.min(...options.map(option => option.getBoundingClientRect().height)),
            selectedBorder: getComputedStyle(selected.querySelector('input')).borderInlineStartColor,
            otherBorder: getComputedStyle(other.querySelector('input')).borderInlineStartColor,
            selectedMarkScale: Number(getComputedStyle(selected.querySelector('input'), '::after').scale),
            otherMarkScale: Number(getComputedStyle(other.querySelector('input'), '::after').scale),
            selectedFill: getComputedStyle(selected).backgroundColor,
            otherFill: getComputedStyle(other).backgroundColor,
            selectedFrame: getComputedStyle(selected).borderTopLeftRadius + getComputedStyle(selected).borderInlineStartWidth,
            checked: document.querySelectorAll('.request .question__option input:checked').length,
            actions: document.querySelectorAll('.request button').length,
            overflowing: document.documentElement.scrollWidth > innerWidth,
          }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, options: (decodeNumber)(record["options"]), minHeight: (decodeNumber)(record["minHeight"]), selectedBorder: (decodeString)(record["selectedBorder"]), otherBorder: (decodeString)(record["otherBorder"]), selectedMarkScale: (decodeNumber)(record["selectedMarkScale"]), otherMarkScale: (decodeNumber)(record["otherMarkScale"]), selectedFill: (decodeString)(record["selectedFill"]), otherFill: (decodeString)(record["otherFill"]), selectedFrame: (decodeString)(record["selectedFrame"]), checked: (decodeNumber)(record["checked"]), actions: (decodeNumber)(record["actions"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
        expect(state.options).toBe(optionCount)
        expect(state.minHeight).toBeGreaterThanOrEqual(44)
        expect(state.selectedBorder).not.toBe(state.otherBorder)
        expect(state.selectedMarkScale).toBeGreaterThan(state.otherMarkScale)
        expect(state.selectedMarkScale).toBe(1)
        expect(state.otherMarkScale).toBe(0)
        expect(state.selectedFill).toBe("rgba(0, 0, 0, 0)")
        expect(state.otherFill).toBe("rgba(0, 0, 0, 0)")
        expect(state.selectedFrame).toBe("14px0px")
        expect(state.checked).toBeGreaterThan(0)
        expect(state.actions).toBeGreaterThanOrEqual(actionCount)
        expect(state.overflowing).toBe(false)
        await page.close()
      }
    }
  }, 30_000)

  test("keeps compact decision and account actions at least 44px", async () => {
    const tablet = await scenario("permission-guardrail-hard-review-form-requests", 768, "syslog daemon bridge")
    const tabletHeights = await tablet.evaluate(`[...document.querySelectorAll('.requests button')].map(button=>button.getBoundingClientRect().height)`, decodeArray(decodeNumber))
    expect(tabletHeights.length).toBeGreaterThan(0)
    expect(tabletHeights.every((height) => height >= 44)).toBe(true)
    await tablet.close()

    const mobile = await scenario("signed-out", 390, "Continue with Google")
    expect(await mobile.evaluate(`document.querySelector('.sign-in__provider')?.getBoundingClientRect().height ?? 0`)).toBeGreaterThanOrEqual(44)
    await mobile.close()
  }, 30_000)

  test("replaces every remote route with one centered sign-in panel for a signed-out browser", async () => {
    for (const view of ["chat", "sessions", "settings"] as const) {
      const page = await fixture(`view=${view}&account=signedout`, 390, "Continue with Google")
      for (const width of [320, 390, 768, 1440] as const) {
        await page.setViewport(width, 844)
        const state = await page.evaluate(`(() => {
          const panel = document.querySelector('.sign-in__panel')
          if (!(panel instanceof HTMLElement)) throw new Error('sign-in panel missing')
          const inner = panel.clientWidth - parseFloat(getComputedStyle(panel).paddingLeft) - parseFloat(getComputedStyle(panel).paddingRight)
          const box = panel.getBoundingClientRect()
          return {
            workspace: document.querySelector('.app') !== null,
            heading: document.querySelector('h1')?.textContent?.trim() ?? '',
            providers: [...panel.querySelectorAll('.sign-in__provider')].map(button => ({ label: button.textContent.trim(), height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })),
            panelWidth: inner,
            centered: Math.abs(box.left + box.width / 2 - innerWidth / 2) <= 2,
            overflowing: document.documentElement.scrollWidth > innerWidth,
          }
        })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, workspace: (decodeBoolean)(record["workspace"]), heading: (decodeString)(record["heading"]), providers: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, label: (decodeString)(record["label"]), height: (decodeNumber)(record["height"]), width: (decodeNumber)(record["width"]) } }))(record["providers"]), panelWidth: (decodeNumber)(record["panelWidth"]), centered: (decodeBoolean)(record["centered"]), overflowing: (decodeBoolean)(record["overflowing"]) } })
        expect(state.workspace).toBe(false)
        expect(state.heading).toBe("Sign in to your workspace")
        expect(state.providers.map((provider) => provider.label)).toEqual(["Continue with Google", "Sign in"])
        expect(state.providers.every((provider) => provider.height >= 44 && Math.abs(provider.width - state.panelWidth) <= 1)).toBe(true)
        expect(state.centered).toBe(true)
        expect(state.overflowing).toBe(false)
      }
      await page.close()
    }
  }, 60_000)

  test("keeps mobile device records compact with every reported field and action", async () => {
    const page = await scenario("devices-enrollment", 390, "Enrollment code (shown once)")
    for (const width of [320, 390, 430] as const) {
      await page.setViewport(width, 844)
      const rows = await page.evaluate(`[...document.querySelectorAll('.device-table .device')].map(row => {
        const name = row.querySelector('.device__name')
        const registration = row.querySelector('.device__registration')
        const connection = row.querySelector('.device__connection')
        const lastSeen = row.querySelector('.device__last-seen')
        const action = row.querySelector('.device__action button')
        if (!(name instanceof HTMLElement) || !(registration instanceof HTMLElement) || !(connection instanceof HTMLElement) || !(lastSeen instanceof HTMLElement)) throw new Error('device enrollment device field missing')
        const box = row.getBoundingClientRect()
        return {
          height: box.height,
          name: name.textContent.trim(),
          registration: registration.textContent.trim(),
          connection: connection.textContent.trim(),
          lastSeen: lastSeen.textContent.trim(),
          actionHeight: action?.getBoundingClientRect().height ?? 0,
          aligned: Math.abs(name.getBoundingClientRect().top - registration.getBoundingClientRect().top) <= 4 && Math.abs(connection.getBoundingClientRect().top - lastSeen.getBoundingClientRect().top) <= 4,
          contained: [name, registration, connection, lastSeen, action].filter(Boolean).every(element => element.getBoundingClientRect().left >= box.left && element.getBoundingClientRect().right <= box.right),
        }
      })`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, height: (decodeNumber)(record["height"]), name: (decodeString)(record["name"]), registration: (decodeString)(record["registration"]), connection: (decodeString)(record["connection"]), lastSeen: (decodeString)(record["lastSeen"]), actionHeight: (decodeNumber)(record["actionHeight"]), aligned: (decodeBoolean)(record["aligned"]), contained: (decodeBoolean)(record["contained"]) } }))
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.name)).toEqual(["Studio Mac", "Workstation-Box", "Legacy-MacBook"])
      expect(rows.map((row) => row.registration)).toEqual(["Enrolled", "Enrolled", "Revoked"])
      expect(rows.map((row) => row.connection)).toEqual(["Online", "Offline", "Disconnected"])
      expect(rows.every((row) => row.lastSeen.length > 0 && row.aligned && row.contained)).toBe(true)
      expect(rows[0]!.height).toBeLessThanOrEqual(140)
      expect(rows[1]!.height).toBeLessThanOrEqual(140)
      expect(rows[2]!.height).toBeLessThanOrEqual(140)
      expect(rows[0]!.actionHeight).toBeGreaterThanOrEqual(44)
      expect(rows[1]!.actionHeight).toBeGreaterThanOrEqual(44)
      expect(rows[2]!.actionHeight).toBeGreaterThanOrEqual(44)
      expect(await page.evaluate(`document.documentElement.scrollWidth > innerWidth`)).toBe(false)
    }
    await page.close()
  }, 30_000)

  test("keeps loading, signed-out, offline, pending-decision, revoked-device, and selected-session states truthful", async () => {
    const pending = await fixture("view=settings&account=pending", 768, "Checking account")
    const pendingText = await pending.evaluate(`document.body.innerText`)
    expect(pendingText).not.toContain("Signed out")
    expect(pendingText).not.toContain("Continue with Google")
    await pending.close()

    const signedOut = await scenario("signed-out", 390, "Continue with Google")
    expect(await signedOut.evaluate(`document.querySelector('.app') === null && document.querySelector('main.sign-in') !== null`)).toBe(true)
    await signedOut.close()

    const offline = await scenario("selected-machine-offline", 768, "Reconnect")
    expect(await offline.evaluate(`document.querySelector('.status-strip')?.innerText ?? ''`)).toContain("Studio Mac is not reachable")
    await offline.close()

    const devices = await scenario("devices-enrollment", 1440, "Enrollment code (shown once)")
    const deviceState = await devices.evaluate(`(() => {
      const rows=[...document.querySelectorAll('.device-table .device')];
      const revoked=rows.find(row=>row.textContent.includes('Legacy-MacBook'));
      return {
        account:document.querySelector('#account-settings')?.closest('section')?.innerText ?? '',
        revokedActions:revoked?.querySelectorAll('button').length ?? -1,
        selected:document.querySelector('.app')?.classList.contains('app--selected') ?? false,
      };
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, account: (decodeString)(record["account"]), revokedActions: (decodeNumber)(record["revokedActions"]), selected: (decodeBoolean)(record["selected"]) } })
    expect(deviceState.account).toContain("account_fixture")
    expect(deviceState.account).not.toContain("[account name]")
    expect(deviceState.revokedActions).toBe(1)
    expect(deviceState.selected).toBe(false)
    await devices.close()
  }, 30_000)

  test("keeps a delayed account check truthful through the signed-in transition", async () => {
    const page = await requireBrowser().openPage()
    try {
      await page.setViewport(390, 844)
      await page.injectOnNewDocument(`(() => {
        window.accountSamples = [];
        const read = () => ({
          status: document.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
          account: document.querySelector('#account-settings')?.closest('section')?.textContent?.trim() ?? '',
          signIn: document.querySelector('main.sign-in') !== null,
        });
        new MutationObserver(() => {
          const next = read();
          if (JSON.stringify(window.accountSamples.at(-1)) !== JSON.stringify(next)) window.accountSamples.push(next);
        }).observe(document, { subtree: true, childList: true, characterData: true });
      })()`)
      await page.navigate(url("/verify/remote.html?view=settings&accountDelay=900"))
      for (let attempt = 0; attempt < 30 && !await page.evaluate(`document.querySelector('.status-strip__body')?.textContent?.includes('Checking account') === true`); attempt += 1) await Bun.sleep(20)
      const read = () => page.evaluate(`({
        status: document.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
        account: document.querySelector('#account-settings')?.closest('section')?.textContent?.trim() ?? '',
        signIn: document.querySelector('main.sign-in') !== null,
        overflow: document.documentElement.scrollWidth > innerWidth,
        screen: document.querySelectorAll('.workspace__main .loading-placeholder--screen[role="status"]').length,
      })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, status: (decodeString)(record["status"]), account: (decodeString)(record["account"]), signIn: (decodeBoolean)(record["signIn"]), overflow: (decodeBoolean)(record["overflow"]), screen: (decodeNumber)(record["screen"]) } })
      const pending = await read()
      expect(pending.status).toContain("Checking account")
      expect(pending.account).toContain("Checking account")
      expect(pending.screen).toBe(1)
      expect(await page.evaluate(`document.querySelector('button') !== null && [...document.querySelectorAll('button')].every(button => !button.textContent?.includes('Create enrollment code'))`)).toBe(true)
      expect(pending.signIn).toBe(false)
      await Bun.sleep(300)
      expect((await read()).status).toContain("Checking account")
      for (let attempt = 0; attempt < 40 && !(await read()).account.includes("user_fixture"); attempt++) await Bun.sleep(50)
      const settled = await read()
      expect(settled.status).toBe("")
      expect(await page.evaluate(`document.querySelector('.remote-connection-label')?.textContent?.trim() ?? ''`)).toBe("Connected")
      expect(settled.account).toContain("user_fixture")
      expect(settled.screen).toBe(0)
      expect(settled.signIn).toBe(false)
      expect(settled.overflow).toBe(false)
      const samples = await page.evaluate(`window.accountSamples`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, status: (decodeString)(record["status"]), account: (decodeString)(record["account"]), signIn: (decodeBoolean)(record["signIn"]) } }))
      expect(samples.some((sample) => sample.status.includes("Checking account"))).toBe(true)
      expect(samples.some((sample) => sample.status === "" && sample.account.includes("user_fixture"))).toBe(true)
      expect(samples.every((sample) => !sample.status.includes("Signed out") && !sample.account.includes("not signed in") && !sample.signIn)).toBe(true)
      expect(await page.evaluate(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("resolves delayed account rejection and unavailable responses without an early sign-in screen", async () => {
    for (const [mode, expectedStatus, expectedAccount, expectedSignIn] of [
      ["signedout", "", "", true],
      ["unavailable", "Remote access is not available yet", "not enabled", false],
    ] as const) {
      const page = await requireBrowser().openPage()
      try {
        await page.setViewport(390, 844)
        await page.injectOnNewDocument(`(() => {
          window.accountSamples = [];
          const read = () => ({
            status: document.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
            account: document.querySelector('#account-settings')?.closest('section')?.textContent?.trim() ?? '',
            signIn: document.querySelector('main.sign-in') !== null,
          });
          new MutationObserver(() => {
            const next = read();
            if (JSON.stringify(window.accountSamples.at(-1)) !== JSON.stringify(next)) window.accountSamples.push(next);
          }).observe(document, { subtree: true, childList: true, characterData: true });
        })()`)
        await page.navigate(url(`/verify/remote.html?view=settings&account=${mode}&accountDelay=900`))
        const read = () => page.evaluate(`({
          status: document.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
          account: document.querySelector('#account-settings')?.closest('section')?.textContent?.trim() ?? '',
          signIn: document.querySelector('main.sign-in') !== null,
          overflow: document.documentElement.scrollWidth > innerWidth,
        })`, (value: unknown) => { const record = decodeRecord(value); return { ...record, status: (decodeString)(record["status"]), account: (decodeString)(record["account"]), signIn: (decodeBoolean)(record["signIn"]), overflow: (decodeBoolean)(record["overflow"]) } })
        expect(await read()).toMatchObject({ status: expect.stringContaining("Checking account"), signIn: false })
        await Bun.sleep(300)
        expect(await read()).toMatchObject({ status: expect.stringContaining("Checking account"), signIn: false })
        const settledNow = (state: { readonly status: string; readonly signIn: boolean }) => expectedSignIn ? state.signIn : state.status.includes(expectedStatus)
        for (let attempt = 0; attempt < 40 && !settledNow(await read()); attempt++) await Bun.sleep(50)
        const settled = await read()
        expect(settled.signIn).toBe(expectedSignIn)
        if (!expectedSignIn) {
          expect(settled.status).toContain(expectedStatus)
          expect(settled.account).toContain(expectedAccount)
        }
        expect(settled.overflow).toBe(false)
        const samples = await page.evaluate(`window.accountSamples`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, status: (decodeString)(record["status"]), account: (decodeString)(record["account"]), signIn: (decodeBoolean)(record["signIn"]) } }))
        const boundary = samples.findIndex(settledNow)
        expect(boundary).toBeGreaterThan(0)
        expect(samples.slice(0, boundary).every((sample) => !sample.signIn && !sample.status.includes("Signed out"))).toBe(true)
        expect(samples.at(-1)?.signIn).toBe(expectedSignIn)
        if (mode === "unavailable") expect(samples.every((sample) => !sample.signIn)).toBe(true)
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("renders truthful permission and guardrail actions without unsupported controls", async () => {
    const page = await scenario("permission-guardrail-hard-review-form-requests", 1440, "Clarify Disambiguation Query")
    const actions = await page.evaluate(`(() => {
      const text = selector => [...document.querySelectorAll(selector)].map(button=>button.textContent.trim());
      return {
        hard:text('.request--hard .request__actions button'),
        ordinary:text('.request--guardrail:not(.request--hard) .request__actions button'),
        permission:text('.request--permission .request__actions button'),
        unsupported:['New Session','Retry','Permission Guardrail'].filter(label=>document.body.innerText.includes(label)),
      };
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, hard: (decodeArray(decodeString))(record["hard"]), ordinary: (decodeArray(decodeString))(record["ordinary"]), permission: (decodeArray(decodeString))(record["permission"]), unsupported: (decodeArray(decodeString))(record["unsupported"]) } })
    expect(actions.hard).toEqual(["Approve once", "Reject"])
    expect(actions.ordinary).toEqual(["Approve once", "Always this process", "Reject"])
    expect(actions.permission).toEqual(["Approve once", "Deny"])
    expect(actions.permission).not.toContain("Always this session")
    expect(actions.unsupported).toEqual([])
    await page.close()
  }, 30_000)

  test("sends each rendered hard-review decision once and removes its pending card", async () => {
    for (const [label, reply] of [["Reject", "reject"], ["Approve once", "once"]] as const) {
      const page = await scenario("permission-guardrail-hard-review-form-requests", 1440, "Clarify Disambiguation Query")
      try {
        expect(await page.evaluate(`[...document.querySelectorAll('.request--hard .request__actions button')].map(button => button.textContent.trim())`)).toEqual(["Approve once", "Reject"])
        await page.evaluate(`[...document.querySelectorAll('.request--hard .request__actions button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`)
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (await page.evaluate(`document.querySelector('.request--hard') === null`)) break
          await Bun.sleep(50)
        }
        expect(await page.evaluate(`({
          requests: window.remoteMutationReport().filter(request => request.operation === 'session.guardrail.reply'),
          pending: document.querySelectorAll('.request--hard').length,
        })`)).toEqual({
          requests: [{ operation: "session.guardrail.reply", input: { requestID: "grq_hard", reply } }],
          pending: 0,
        })
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("supports keyboard and coarse-pointer operation for device, delivery, appearance, and overlays", async () => {
    const workspace = await scenario("conversation-workspace", 768, "Run test suite against auth services.")
    await workspace.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
    for (let attempt = 0; attempt < 40 && !await workspace.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__edit') !== null`); attempt += 1) await Bun.sleep(50)
    await workspace.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__edit')?.focus()`)
    await workspace.pressKey("Enter", "Enter", 13, "\r")
    expect(await workspace.evaluate(`document.activeElement === document.querySelector('[aria-labelledby="machine-settings"] .machine-row__input') && document.activeElement !== null`)).toBe(true)
    await workspace.pressEscape()
    expect(await workspace.evaluate(`document.querySelector('[aria-labelledby="machine-settings"] .machine-row__input') === null && document.activeElement?.classList.contains('machine-row__edit') === true`)).toBe(true)

    await workspace.evaluate(`document.querySelector('a[href^="/remote/session?"]')?.click()`)
    for (let attempt = 0; attempt < 40 && !await workspace.evaluate(`document.querySelector('.composer__delivery-toggle') !== null`); attempt += 1) await Bun.sleep(50)

    await workspace.evaluate(`document.querySelector('.composer__delivery-toggle')?.focus()`)
    expect(await workspace.evaluate(`document.activeElement?.getAttribute('aria-label') ?? null`)).toBe("Steer mode; switch to Queue")
    await workspace.pressKey(" ", "Space", 32)
    expect(await workspace.evaluate(`(() => { const toggle = document.querySelector('.composer__delivery-toggle'); return { pressed: toggle?.getAttribute('aria-pressed') ?? null, label: toggle?.getAttribute('aria-label') ?? null } })()`)).toEqual({ pressed: "true", label: "Queue mode; switch to Steer" })

    await workspace.close()

    const settings = await scenario("autonomy-goal-notification-settings", 390, "Appearance")
    await settings.setCoarsePointer(true)
    const coarse = await settings.evaluate(`(() => {
      const appearance=document.querySelector('#appearance-settings')?.closest('section');
      const controls=[...appearance.querySelectorAll('button')].filter(button=>button.getBoundingClientRect().width>0);
      return {
        minimum:Math.min(...controls.map(control=>control.getBoundingClientRect().height)),
        themes:appearance.querySelectorAll('[role="radio"]').length,
      };
    })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, minimum: (decodeNumber)(record["minimum"]), themes: (decodeNumber)(record["themes"]) } })
    expect(coarse.minimum).toBeGreaterThanOrEqual(44)
    expect(coarse.themes).toBe(3)
    await settings.close()
  }, 30_000)

  test("keeps Settings controls in product order and density", async () => {
    const mobile = await scenario("autonomy-goal-notification-settings", 390, "Machine offline")
    const state = await mobile.evaluate(`(() => ({
      categoriesHidden:[...document.querySelectorAll('#appearance-settings,#notification-settings')].every(heading=>{const section=heading.closest('section');const category=section?.querySelector('.settings__category');return category instanceof HTMLElement&&getComputedStyle(category).display==='none'}),
      themes:[...document.querySelectorAll('.appearance-segments [role="radio"]')].map(button=>button.textContent.trim()).slice(0,3),
      headingSizes:[...document.querySelectorAll('#appearance-settings,#notification-settings')].map(heading=>parseFloat(getComputedStyle(heading).fontSize))
    }))()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, categoriesHidden: (decodeBoolean)(record["categoriesHidden"]), themes: (decodeArray(decodeString))(record["themes"]), headingSizes: (decodeArray(decodeNumber))(record["headingSizes"]) } })
    expect(state.categoriesHidden).toBe(true)
    expect(state.themes).toEqual(["System", "Light", "Dark"])
    expect(state.headingSizes.every((size) => size <= 16)).toBe(true)
    await mobile.close()
  }, 30_000)
})

async function scenario(scenarioName: string, width: number, expected: string, theme?: "dark" | "light") {
  return fixture(`scenario=${scenarioName}-${width}`, width, expected, theme)
}

async function selectSessionWorkspace(page: Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>, directory: string, expected: string, scope = ".app", row = ".sessions-table__row") {
  if (scope === ".workspace__rail") {
    await page.evaluate(`document.querySelector('.remote-nav a[href="/remote/sessions"]').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.sessions-page__workspace-select [aria-label=Workspace]') !== null`); attempt += 1) await Bun.sleep(50)
    await selectSessionWorkspace(page, directory, expected)
    await page.evaluate(`[...document.querySelectorAll('.sessions-table__select')].find(button => button.textContent.includes(${JSON.stringify(expected)}))?.click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate(`document.querySelector('.workspace__rail .session-row')?.textContent?.includes(${JSON.stringify(expected)}) ?? false`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate(`(document.querySelector('.workspace__rail .session-list__group')?.textContent?.trim() ?? '')`)).toBe(directory)
    expect(await page.evaluate(`document.querySelector('.workspace__rail .workspace-select') === null`)).toBe(true)
    return
  }
  await page.evaluate(`(async () => {
    const root = document.querySelector(${JSON.stringify(scope)});
    const name = ${JSON.stringify(directory)};
    const visible = (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0;
    const trigger = [...root.querySelectorAll('.workspace-select [aria-label="Workspace"]')].find(visible);
    if (!trigger) throw new Error('Workspace control missing');
    trigger.click();
    for (let attempt = 0; attempt < 40 && document.querySelectorAll('.custom-select__option').length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const option = [...document.querySelectorAll('.custom-select__option')].find((entry) => entry.textContent.replace(/^\\s*✓/, '').trim().startsWith(name));
    if (!option) throw new Error('Workspace option missing');
    option.click();
    document.querySelector('.custom-select__confirm')?.click();
  })()`)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate(`document.querySelector(${JSON.stringify(`${scope} ${row}`)})?.textContent?.includes(${JSON.stringify(expected)}) ?? false`)) return
    await Bun.sleep(50)
  }
  throw new Error(`Session workspace ${directory} did not settle`)
}

async function fixture(query: string, width: number, expected: string, theme?: "dark" | "light", height = 1600) {
  const page = await requireBrowser().openPage()
  await page.setViewport(width, height)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`)) {
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
