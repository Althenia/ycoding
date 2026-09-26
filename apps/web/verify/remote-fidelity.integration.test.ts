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

describe("remote responsive state behavior", () => {
  test("exposes one remote main landmark and the active narrow navigation destination", async () => {
    const page = await scenario("conversation-workspace", 390, "Token expiry refactor")
    try {
      expect(await page.evaluate<{ readonly main: number; readonly skip: string | null; readonly current: string | null }>(`({
        main: document.querySelectorAll('main').length,
        skip: document.querySelector('.skip-link')?.getAttribute('href') ?? null,
        current: document.querySelector('.bottom-nav__item--active')?.getAttribute('aria-current') ?? null,
      })`)).toEqual({ main: 1, skip: "#remote-main", current: "page" })
      await page.pressEscape()
      expect(await page.evaluate<boolean>(`document.querySelector('.custom-select__dialog')?.hasAttribute('open') ?? false`)).toBe(false)
      await page.evaluate(`document.querySelector('.skip-link')?.focus()`)
      await page.pressKey("Enter", "Enter", 13)
      expect(await page.evaluate<string>(`document.activeElement?.id ?? ''`)).toBe("remote-main")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("moves through theme and autonomy radios with one Tab stop per group", async () => {
    const page = await scenario("autonomy-goal-notification-settings", 390, "Mobile refactor")
    try {
      await page.evaluate(`document.querySelector('.appearance-segments [role="radio"]')?.click()`)
      const group = (selector: string) => `(() => {
        const radios = [...document.querySelectorAll(${JSON.stringify(selector)})];
        return { checked: radios.findIndex(radio => radio.getAttribute('aria-checked') === 'true'),
          tabs: radios.map(radio => radio.tabIndex), focus: radios.indexOf(document.activeElement) };
      })()`
      const radioState = (selector: string) => page.evaluate<{ readonly checked: number; readonly tabs: readonly number[]; readonly focus: number }>(group(selector))
      expect(await radioState('.appearance-segments [role="radio"]')).toMatchObject({ checked: 0, tabs: [0, -1, -1] })
      await page.evaluate(`document.querySelector('.appearance-segments [role="radio"]')?.focus()`)
      await page.pressKey("ArrowRight", "ArrowRight", 39)
      expect(await radioState('.appearance-segments [role="radio"]')).toEqual({ checked: 1, tabs: [-1, 0, -1], focus: 1 })
      await page.pressKey("End", "End", 35)
      expect(await radioState('.appearance-segments [role="radio"]')).toEqual({ checked: 2, tabs: [-1, -1, 0], focus: 2 })

      await page.evaluate(`document.querySelector('.autonomy-choices [role="radio"]')?.focus()`)
      await page.pressKey("ArrowRight", "ArrowRight", 39)
      expect(await radioState('.autonomy-choices [role="radio"]')).toEqual({ checked: 1, tabs: [-1, 0, -1, -1], focus: 1 })
    } finally {
      await page.close()
    }
  }, 30_000)

  test("matches conversation workspace behavior across desktop, tablet, and mobile while keeping Activity accessible", async () => {
    for (const width of [1440, 768, 390] as const) {
      for (const theme of ["dark", "light"] as const) {
        const page = await scenario("conversation-workspace", width, "Studio Mac", theme)
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
    const page = await scenario("conversation-workspace", 1440, "auth_guard.go")
    const rows = await page.evaluate<readonly { readonly height: number; readonly text: string }[]>(`[...document.querySelectorAll('.session-row')].map(row=>({height:row.getBoundingClientRect().height,text:row.textContent.replace(/\\s+/g,' ').trim()}))`)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.height <= 96)).toBe(true)
    expect(rows[0]?.text).toContain("auth")
    expect(rows[0]?.text).not.toContain("openai/gpt-6")
    await page.close()
  }, 30_000)

  test("uses the compact Sessions composition without a redundant page heading", async () => {
    const page = await scenario("session-list", 768, "Postgres Partition Pruning Worker")
    const state = await page.evaluate<{ readonly headingVisible: boolean; readonly columns: number }>(`(() => { const heading=document.querySelector('.sessions-page .page-head'); const grid=document.querySelector('.sessions-table'); return {headingVisible:heading instanceof HTMLElement&&getComputedStyle(heading).display!=='none',columns:grid instanceof HTMLElement?getComputedStyle(grid).gridTemplateColumns.split(' ').length:0} })()`)
    expect(state.headingVisible).toBe(false)
    expect(state.columns).toBe(2)
    await page.close()
  }, 30_000)

  test("uses available desktop width for the session list without losing rows or targets", async () => {
    const page = await scenario("session-list", 1440, "Postgres Partition Pruning Worker")
    for (const width of [1280, 1440, 2048] as const) {
      await page.setViewport(width, 900)
      const state = await page.evaluate<{
        readonly width: number
        readonly center: number
        readonly viewport: number
        readonly rows: number
        readonly columns: number
        readonly minTargetHeight: number
        readonly overflowing: boolean
      }>(`(() => {
        const table = document.querySelector('.sessions-results')
        const rows = [...document.querySelectorAll('.sessions-table__row')]
        const targets = [...document.querySelectorAll('.sessions-table__select')]
        if (!(table instanceof HTMLElement) || !(rows[0] instanceof HTMLElement) || targets.length === 0) throw new Error('session list Sessions table missing')
        const rect = table.getBoundingClientRect()
        return {
          width: rect.width,
          center: rect.left + rect.width / 2,
          viewport: innerWidth,
          rows: rows.length,
          columns: getComputedStyle(rows[0]).gridTemplateColumns.split(' ').length,
          minTargetHeight: Math.min(...targets.map(target => target.getBoundingClientRect().height)),
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(state.width).toBeGreaterThanOrEqual(width - 128)
      expect(Math.abs(state.center - state.viewport / 2)).toBeLessThanOrEqual(2)
      expect(state.rows).toBe(4)
      expect(state.columns).toBe(4)
      expect(state.minTargetHeight).toBeGreaterThanOrEqual(44)
      expect(state.overflowing).toBe(false)
    }
    await page.close()
  }, 30_000)

  test("keeps every Sessions selection target touch-sized on compact layouts", async () => {
    for (const width of [390, 768] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("session-list", width, "Async Auth Token Revocation Migration", theme)
        const targets = await page.evaluate<readonly { readonly height: number; readonly width: number }[]>(`[...document.querySelectorAll('.sessions-table__select')].map(button => ({ height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width }))`)
        expect(targets).toHaveLength(4)
        expect(targets.every((target) => target.height >= 44 && target.width >= 44)).toBe(true)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
        await page.close()
      }
    }
  }, 30_000)

  test("keeps session list compact Session status beside its title without losing metadata", async () => {
    for (const width of [390, 768] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("session-list", width, "Async Auth Token Revocation Migration", theme)
        const state = await page.evaluate<{
          readonly rowHeight: number
          readonly statusOffset: number
          readonly title: string
          readonly project: string
          readonly updated: string
          readonly targets: readonly number[]
          readonly rowCount: number
          readonly overflowing: boolean
        }>(`(() => {
          const row = document.querySelector('.sessions-table__row')
          const title = row?.querySelector('.sessions-table__title')
          const status = row?.querySelector('.sessions-table__status')
          if (!(row instanceof HTMLElement) || !(title instanceof HTMLElement) || !(status instanceof HTMLElement)) throw new Error('session list Session row missing')
          return {
            rowHeight: row.getBoundingClientRect().height,
            statusOffset: status.getBoundingClientRect().top - title.getBoundingClientRect().top,
            title: title.textContent?.trim() ?? '',
            project: row.querySelector('.sessions-table__project')?.textContent?.trim() ?? '',
            updated: row.querySelector('.sessions-table__updated')?.textContent?.trim() ?? '',
            targets: [...document.querySelectorAll('.sessions-table__select')].map(button => button.getBoundingClientRect().height),
            rowCount: document.querySelectorAll('.sessions-table__row').length,
            overflowing: document.documentElement.scrollWidth > innerWidth,
          }
        })()`)
        expect(state.statusOffset).toBeGreaterThanOrEqual(-2)
        expect(state.statusOffset).toBeLessThanOrEqual(8)
        expect(state.rowHeight).toBeLessThanOrEqual(width === 390 ? 164 : 150)
        expect(state.title).toBe("Async Auth Token Revocation Migration")
        expect(state.project).toBe("auth-gate")
        expect(state.updated).not.toBe("")
        expect(state.targets).toHaveLength(4)
        expect(state.targets.every((height) => height >= 44)).toBe(true)
        expect(state.rowCount).toBe(4)
        expect(state.overflowing).toBe(false)
        await page.close()
      }
    }
  }, 30_000)

  test("shows the selected Session's real state in the mobile conversation context", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await scenario("conversation-workspace", 390, "Token expiry refactor", theme)
      const status = await page.evaluate<{ readonly label: string; readonly visible: boolean }>(`(() => {
        const chip = document.querySelector('.conversation-breadcrumb .chip');
        return { label: chip?.textContent?.trim() ?? '', visible: chip instanceof HTMLElement && chip.getBoundingClientRect().height > 0 && getComputedStyle(chip.parentElement).display !== 'none' };
      })()`)
      expect(status).toEqual({ label: "Running", visible: true })
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await page.close()
    }
  }, 30_000)

  test("aligns Activity events and pending decisions within the desktop columns", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await scenario("activity-pending-decisions", 1440, "Pending decisions", theme)
      const state = await page.evaluate<{
        readonly eventLeft: number
        readonly decisionLeft: number
        readonly decisionRightInset: number
        readonly events: number
        readonly decisions: number
        readonly actions: number
        readonly overflowing: boolean
      }>(`(() => {
        const event = document.querySelector('.activity-page__events .activity-row')
        const decision = document.querySelector('.activity-page__decisions .request')
        if (!(event instanceof HTMLElement) || !(decision instanceof HTMLElement)) throw new Error('activity pending decisions Activity cards missing')
        return {
          eventLeft: event.getBoundingClientRect().left,
          decisionLeft: decision.getBoundingClientRect().left,
          decisionRightInset: innerWidth - decision.getBoundingClientRect().right,
          events: document.querySelectorAll('.activity-page__events .activity-row').length,
          decisions: document.querySelectorAll('.activity-page__decisions .request').length,
          actions: document.querySelectorAll('.activity-page__decisions .request button').length,
          overflowing: document.documentElement.scrollWidth > innerWidth,
        }
      })()`)
      expect(state.eventLeft).toBeGreaterThanOrEqual(10)
      expect(state.eventLeft).toBeLessThanOrEqual(15)
      expect(state.decisionLeft).toBeGreaterThanOrEqual(973)
      expect(state.decisionLeft).toBeLessThanOrEqual(981)
      expect(state.decisionRightInset).toBeGreaterThanOrEqual(10)
      expect(state.decisionRightInset).toBeLessThanOrEqual(15)
      expect(state.events).toBe(3)
      expect(state.decisions).toBe(2)
      expect(state.actions).toBeGreaterThanOrEqual(6)
      expect(state.overflowing).toBe(false)
      await page.close()
    }
  }, 30_000)

  test("aligns conversation decision cards with the transcript in one centered column", async () => {
    const page = await scenario("permission-guardrail-hard-review-form-requests", 1440, "Clarify Disambiguation Query")
    const layout = await page.evaluate<{ readonly transcript: { readonly left: number; readonly right: number }; readonly cards: readonly { readonly left: number; readonly right: number }[]; readonly requestsFollowTranscript: boolean }>(`(() => {
      const transcript = document.querySelector('.transcript')
      const requests = document.querySelector('.requests')
      if (!(transcript instanceof HTMLElement) || !(requests instanceof HTMLElement)) throw new Error('Conversation transcript or pending decisions missing')
      const bounds = transcript.getBoundingClientRect()
      return {
        transcript: { left: bounds.left, right: bounds.right },
        cards: [...requests.querySelectorAll(':scope > .request')].map(card => { const rect = card.getBoundingClientRect(); return { left: rect.left, right: rect.right } }),
        requestsFollowTranscript: Boolean(transcript.compareDocumentPosition(requests) & Node.DOCUMENT_POSITION_FOLLOWING),
      }
    })()`)
    expect(layout.cards).toHaveLength(6)
    expect(layout.cards.every((card) => Math.abs(card.left - layout.transcript.left) <= 1 && Math.abs(card.right - layout.transcript.right) <= 1)).toBe(true)
    expect(layout.requestsFollowTranscript).toBe(true)
    await page.close()
  }, 30_000)

  test("frames permission and guardrail reviews choice rows without changing native answers or touch targets", async () => {
    for (const [width, marker, optionCount, actionCount] of [
      [390, "Select Target Cluster", 2, 6],
      [768, "syslog daemon bridge", 3, 4],
      [1440, "Clarify Disambiguation Query", 4, 6],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        const page = await scenario("permission-guardrail-hard-review-form-requests", width, marker, theme)
        const state = await page.evaluate<{
          readonly options: number
          readonly minHeight: number
          readonly selectedBorder: string
          readonly otherBorder: string
          readonly selectedFill: string
          readonly otherFill: string
          readonly checked: number
          readonly actions: number
          readonly overflowing: boolean
        }>(`(() => {
          const options = [...document.querySelectorAll('.request .question__option')]
          const selected = options.find(option => option.querySelector('input:checked'))
          const other = options.find(option => option.querySelector('input:not(:checked)'))
          if (!(selected instanceof HTMLElement) || !(other instanceof HTMLElement)) throw new Error('permission and guardrail reviews choice states missing')
          return {
            options: options.length,
            minHeight: Math.min(...options.map(option => option.getBoundingClientRect().height)),
            selectedBorder: getComputedStyle(selected).borderColor,
            otherBorder: getComputedStyle(other).borderColor,
            selectedFill: getComputedStyle(selected).backgroundColor,
            otherFill: getComputedStyle(other).backgroundColor,
            checked: document.querySelectorAll('.request .question__option input:checked').length,
            actions: document.querySelectorAll('.request button').length,
            overflowing: document.documentElement.scrollWidth > innerWidth,
          }
        })()`)
        expect(state.options).toBe(optionCount)
        expect(state.minHeight).toBeGreaterThanOrEqual(44)
        expect(state.selectedBorder).not.toBe(state.otherBorder)
        expect(state.selectedFill).not.toBe(state.otherFill)
        expect(state.checked).toBeGreaterThan(0)
        expect(state.actions).toBeGreaterThanOrEqual(actionCount)
        expect(state.overflowing).toBe(false)
        await page.close()
      }
    }
  }, 30_000)

  test("keeps compact decision and account actions at least 44px", async () => {
    const tablet = await scenario("permission-guardrail-hard-review-form-requests", 768, "syslog daemon bridge")
    const tabletHeights = await tablet.evaluate<readonly number[]>(`[...document.querySelectorAll('.requests button')].map(button=>button.getBoundingClientRect().height)`)
    expect(tabletHeights.length).toBeGreaterThan(0)
    expect(tabletHeights.every((height) => height >= 44)).toBe(true)
    await tablet.close()

    const mobile = await scenario("signed-out", 390, "Continue with Google")
    expect(await mobile.evaluate<number>(`document.querySelector('.sign-in__provider')?.getBoundingClientRect().height ?? 0`)).toBeGreaterThanOrEqual(44)
    await mobile.close()
  }, 30_000)

  test("replaces every remote route with one centered OAuth sign-in panel for a signed-out browser", async () => {
    for (const view of ["chat", "sessions", "activity", "settings"] as const) {
      const page = await fixture(`view=${view}&account=signedout`, 390, "Continue with Google")
      for (const width of [320, 390, 768, 1440] as const) {
        await page.setViewport(width, 844)
        const state = await page.evaluate<{
          readonly workspace: boolean
          readonly heading: string
          readonly providers: readonly { readonly label: string; readonly height: number; readonly width: number }[]
          readonly panelWidth: number
          readonly centered: boolean
          readonly overflowing: boolean
        }>(`(() => {
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
        })()`)
        expect(state.workspace).toBe(false)
        expect(state.heading).toBe("Sign in to your workspace")
        expect(state.providers.map((provider) => provider.label)).toEqual(["Continue with Google"])
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
      const rows = await page.evaluate<readonly {
        readonly height: number
        readonly name: string
        readonly registration: string
        readonly connection: string
        readonly lastSeen: string
        readonly actionHeight: number
        readonly aligned: boolean
        readonly contained: boolean
      }[]>(`[...document.querySelectorAll('.device-table .device')].map(row => {
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
      })`)
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.name)).toEqual(["Studio Mac", "Workstation-Box", "Legacy-MacBook"])
      expect(rows.map((row) => row.registration)).toEqual(["Enrolled", "Enrolled", "Revoked"])
      expect(rows.map((row) => row.connection)).toEqual(["Online", "Offline", "Disconnected"])
      expect(rows.every((row) => row.lastSeen.length > 0 && row.aligned && row.contained)).toBe(true)
      expect(rows[0]!.height).toBeLessThanOrEqual(140)
      expect(rows[1]!.height).toBeLessThanOrEqual(140)
      expect(rows[2]!.height).toBeLessThanOrEqual(90)
      expect(rows[0]!.actionHeight).toBeGreaterThanOrEqual(44)
      expect(rows[1]!.actionHeight).toBeGreaterThanOrEqual(44)
      expect(rows[2]!.actionHeight).toBe(0)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth > innerWidth`)).toBe(false)
    }
    await page.close()
  }, 30_000)

  test("keeps loading, signed-out, offline, pending-decision, revoked-device, and selected-session states truthful", async () => {
    const pending = await fixture("view=settings&account=pending", 768, "Checking account")
    const pendingText = await pending.evaluate<string>(`document.body.innerText`)
    expect(pendingText).not.toContain("Signed out")
    expect(pendingText).not.toContain("Continue with Google")
    await pending.close()

    const signedOut = await scenario("signed-out", 390, "Continue with Google")
    expect(await signedOut.evaluate<boolean>(`document.querySelector('.app') === null && document.querySelector('main.sign-in') !== null`)).toBe(true)
    await signedOut.close()

    const offline = await scenario("selected-machine-offline", 768, "Reconnect")
    expect(await offline.evaluate<string>(`document.querySelector('.status-strip')?.innerText ?? ''`)).toContain("Studio Mac is not reachable")
    await offline.close()

    const decisions = await scenario("activity-pending-decisions", 1440, "Authorize branch push for feat/ast-cache")
    expect(await decisions.evaluate<number>(`document.querySelectorAll('.activity-page__decisions .request').length`)).toBe(2)
    await decisions.close()

    const devices = await scenario("devices-enrollment", 1440, "Enrollment code (shown once)")
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
      const read = () => page.evaluate<{ readonly status: string; readonly account: string; readonly signIn: boolean; readonly overflow: boolean }>(`({
        status: document.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
        account: document.querySelector('#account-settings')?.closest('section')?.textContent?.trim() ?? '',
        signIn: document.querySelector('main.sign-in') !== null,
        overflow: document.documentElement.scrollWidth > innerWidth,
      })`)
      const pending = await read()
      expect(pending.status).toContain("Checking account")
      expect(pending.account).toContain("Checking account")
      expect(pending.signIn).toBe(false)
      await Bun.sleep(300)
      expect((await read()).status).toContain("Checking account")
      for (let attempt = 0; attempt < 40 && !(await read()).account.includes("user_fixture"); attempt++) await Bun.sleep(50)
      const settled = await read()
      expect(settled.status).toContain("Connected")
      expect(settled.account).toContain("user_fixture")
      expect(settled.signIn).toBe(false)
      expect(settled.overflow).toBe(false)
      const samples = await page.evaluate<readonly { readonly status: string; readonly account: string; readonly signIn: boolean }[]>(`window.accountSamples`)
      expect(samples.some((sample) => sample.status.includes("Checking account"))).toBe(true)
      expect(samples.some((sample) => sample.status.includes("Connected") && sample.account.includes("user_fixture"))).toBe(true)
      expect(samples.every((sample) => !sample.status.includes("Signed out") && !sample.account.includes("not signed in") && !sample.signIn)).toBe(true)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
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
        const read = () => page.evaluate<{ readonly status: string; readonly account: string; readonly signIn: boolean; readonly overflow: boolean }>(`({
          status: document.querySelector('.status-strip__body')?.textContent?.trim() ?? '',
          account: document.querySelector('#account-settings')?.closest('section')?.textContent?.trim() ?? '',
          signIn: document.querySelector('main.sign-in') !== null,
          overflow: document.documentElement.scrollWidth > innerWidth,
        })`)
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
        const samples = await page.evaluate<readonly { readonly status: string; readonly account: string; readonly signIn: boolean }[]>(`window.accountSamples`)
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

  test("sends each rendered hard-review decision once and removes its pending card", async () => {
    for (const [label, reply] of [["Reject", "reject"], ["Approve once", "once"]] as const) {
      const page = await scenario("permission-guardrail-hard-review-form-requests", 1440, "Clarify Disambiguation Query")
      try {
        expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('.request--hard .request__actions button')].map(button => button.textContent.trim())`)).toEqual(["Approve once", "Reject"])
        await page.evaluate(`[...document.querySelectorAll('.request--hard .request__actions button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`)
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('.request--hard') === null`)) break
          await Bun.sleep(50)
        }
        expect(await page.evaluate<{ readonly requests: readonly unknown[]; readonly pending: number }>(`({
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

  test("supports keyboard and coarse-pointer operation for device, delivery, autonomy, and overlays", async () => {
    const workspace = await scenario("conversation-workspace", 768, "Run test suite against auth services.")
    await workspace.evaluate(`document.querySelector('[aria-label="Machine"]')?.focus()`)
    await workspace.pressKey("Enter", "Enter", 13)
    expect(await workspace.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.getAttribute('aria-expanded') === 'true' && document.querySelector('[role="listbox"]') !== null`)).toBe(true)
    await workspace.pressEscape()
    expect(await workspace.evaluate<boolean>(`document.querySelector('[aria-label="Machine"]')?.getAttribute('aria-expanded') === 'false' && document.activeElement?.getAttribute('aria-label') === 'Machine'`)).toBe(true)

    await workspace.evaluate(`document.querySelector('.composer__delivery-option:nth-child(2)')?.focus()`)
    expect(await workspace.evaluate<boolean>(`document.activeElement?.textContent?.trim() === 'Queue'`)).toBe(true)
    await workspace.pressKey(" ", "Space", 32)
    expect(await workspace.evaluate<boolean>(`document.querySelector('.composer__delivery-option:nth-child(2)')?.getAttribute('aria-pressed') === 'true'`)).toBe(true)

    await workspace.evaluate(`document.querySelector('button[aria-label="Open activity"]')?.focus()`)
    await workspace.pressKey(" ", "Space", 32)
    expect(await workspace.evaluate<boolean>(`document.querySelector('dialog[aria-label="Activity"]')?.hasAttribute('open') === true`)).toBe(true)
    await workspace.pressEscape()
    await workspace.close()

    const settings = await scenario("autonomy-goal-notification-settings", 390, "Mobile refactor")
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

  test("keeps Settings controls in product order and density", async () => {
    const mobile = await scenario("autonomy-goal-notification-settings", 390, "Device disconnected")
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

async function scenario(scenarioName: string, width: number, expected: string, theme?: "dark" | "light") {
  return fixture(`scenario=${scenarioName}-${width}`, width, expected, theme)
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
