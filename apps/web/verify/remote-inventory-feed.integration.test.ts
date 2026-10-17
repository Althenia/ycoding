import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { listPage, parseListQuery } from "../test/session-list-double"
import { startRelayDouble } from "../test/relay-double"

const port = 4377
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(
        (response) => response.ok,
        () => false,
      )
    ) {
      browser = await launchBrowser(browserPath, 980, 760)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Inventory fixture server did not start")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function orderedRelay() {
  const sessions = Array.from({ length: 100 }, (_, index) => ({
    id: `ses_ordered_${index}`,
    title: `Ordered Session ${index}`,
    projectID: "prj_ordered",
    location: { directory: "/workspace/ordered" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1_000 - index, active: 1_000 - index },
  }))
  const state = { waiting: new Set([sessions[0]!.id]), rejectAnchor: false }
  const relay = await startRelayDouble({
    handler: (request) => {
      if (request.operation === "workspace.list")
        return {
          ok: true,
          value: {
            data: [{ id: "wsp_ordered", name: "Ordered", projectID: "prj_ordered", directory: "/workspace/ordered" }],
          },
        }
      if (request.operation === "session.status")
        return { ok: true, value: { running: [], attention: [...state.waiting] } }
      if (request.operation !== "session.list") return "default"
      if (state.rejectAnchor && request.input?.around !== undefined)
        return { ok: false, code: "invalid_message", message: 'Unknown input field "around"' }
      return {
        ok: true,
        value: listPage(sessions, parseListQuery({ ...request.input, workspace: undefined }), new Set(), state.waiting),
      }
    },
  })
  return { sessions, state, relay }
}

describe("remote inventory feed", () => {
  test("restores an unfocused interior anchor moved outside overscan behind an existing Waiting leader", async () => {
    for (const width of [390, 1440]) {
      const fixture = await orderedRelay()
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(
          `http://127.0.0.1:${port}/verify/remote.html?view=sessions&noSelection=1&relaySessions=1&relay=${encodeURIComponent(fixture.relay.wsURL("dev_studio"))}`,
        )
        for (
          let attempt = 0;
          attempt < 80 &&
          !(await page.evaluate<boolean>(
            `window.providerAuthState?.().sessions.length === 25 && window.providerAuthState().carouselStatus === 'ready'`,
          ));
          attempt++
        )
          await Bun.sleep(25)
        for (const count of [50, 75]) {
          await page.evaluate(
            `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = root.scrollHeight; root.dispatchEvent(new WheelEvent('wheel', { deltaY: 250, bubbles: true })); })()`,
          )
          for (
            let attempt = 0;
            attempt < 100 &&
            !(await page.evaluate<boolean>(
              `window.providerAuthState().sessions.length === ${count} && !window.providerAuthState().sessionPageLoading`,
            ));
            attempt++
          )
            await Bun.sleep(25)
        }
        await page.evaluate(
          `(() => { const root = document.querySelector('.workspace__scroll'); const body = document.querySelector('.sessions-table__body'); const rows = [...body.querySelectorAll('.sessions-table__row')]; const step = (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top) / (Number(rows[1].dataset.index) - Number(rows[0].dataset.index)); root.tabIndex = 0; root.focus(); root.scrollTop += body.getBoundingClientRect().top - root.getBoundingClientRect().top + 40 * step + 4; root.dispatchEvent(new Event('scroll')); })()`,
        )
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const before = await page.evaluate<{
          id: string
          offset: number
          first: string
          last: string
          index: number
          focused: boolean
        }>(
          `(() => { const root = document.querySelector('.workspace__scroll').getBoundingClientRect(); const row = [...document.querySelectorAll('.sessions-table__row')].find(row => row.getBoundingClientRect().bottom > root.top && row.getBoundingClientRect().top < root.bottom); window.anchorID = row.dataset.sessionId; const sessions = window.providerAuthState().sessions; return { id: window.anchorID, offset: row.getBoundingClientRect().top - root.top, first: sessions[0].id, last: sessions.at(-1).id, index: sessions.findIndex(item => item.id === window.anchorID), focused: Boolean(document.activeElement?.closest('.sessions-table__row')) } })()`,
        )
        expect(before.index).toBe(40)
        expect(before.focused).toBe(false)
        fixture.state.waiting.add(before.id)
        fixture.relay.pushStatus([], [...fixture.state.waiting])
        for (
          let attempt = 0;
          attempt < 100 &&
          !(await page.evaluate<boolean>(
            `window.providerAuthState().sessions[1]?.id === window.anchorID && !window.providerAuthState().sessionPageLoading`,
          ));
          attempt++
        )
          await Bun.sleep(25)
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const after = await page.evaluate<{
          rows: number
          first: string
          last: string
          index: number
          focused: boolean
          mounted: number
          offset: number | null
        }>(
          `(() => { const sessions = window.providerAuthState().sessions; const root = document.querySelector('.workspace__scroll'); const row = [...document.querySelectorAll('.sessions-table__row')].find(row => row.dataset.sessionId === window.anchorID); return { rows: sessions.length, first: sessions[0].id, last: sessions.at(-1).id, index: sessions.findIndex(item => item.id === window.anchorID), focused: document.activeElement === root, mounted: document.querySelectorAll('.sessions-table__row').length, offset: row ? row.getBoundingClientRect().top - root.getBoundingClientRect().top : null } })()`,
        )
        expect(after).toMatchObject({ rows: 75, first: before.first, last: before.last, index: 1, focused: true })
        expect(after.mounted).toBeLessThan(40)
        expect(after.offset).not.toBeNull()
        expect(Math.abs(after.offset! - before.offset)).toBeLessThanOrEqual(2)
      } finally {
        await page.close()
        await fixture.relay.stop()
      }
    }
  }, 30_000)

  test("an unsupported anchored refresh reports an update in the list region without disabling the existing list", async () => {
    const fixture = await orderedRelay()
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 900)
      await page.navigate(
        `http://127.0.0.1:${port}/verify/remote.html?view=sessions&noSelection=1&relaySessions=1&relay=${encodeURIComponent(fixture.relay.wsURL("dev_studio"))}`,
      )
      for (
        let attempt = 0;
        attempt < 100 &&
        !(await page.evaluate<boolean>(
          `window.providerAuthState?.().sessions.length === 25 && window.providerAuthState().carouselStatus === 'ready'`,
        ));
        attempt++
      )
        await Bun.sleep(25)
      await page.evaluate(
        `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = 700; root.dispatchEvent(new Event('scroll')); })()`,
      )
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      fixture.state.rejectAnchor = true
      fixture.relay.pushSessions(fixture.sessions.map((session) => session.id))
      for (
        let attempt = 0;
        attempt < 100 && !fixture.relay.requests.some((request) => request.input?.around !== undefined);
        attempt++
      )
        await Bun.sleep(25)
      for (
        let attempt = 0;
        attempt < 100 && (await page.evaluate<boolean>(`window.providerAuthState().sessionPageLoading`));
        attempt++
      )
        await Bun.sleep(25)
      expect(
        await page.evaluate<string>(
          `document.querySelector('.sessions-page [role=status][aria-label="Session list status"]')?.textContent ?? ''`,
        ),
      ).toContain("Update YCoding on this machine")
      expect(
        await page.evaluate<{ connection: string; status: string; rows: number; next: boolean; enabled: boolean }>(
          `({ connection: window.providerAuthState().connection.kind, status: window.providerAuthState().sessionListStatus, rows: window.providerAuthState().sessions.length, next: window.providerAuthState().sessionHasNext, enabled: [...document.querySelectorAll('.sessions-table__select')].every(item => !item.disabled) })`,
        ),
      ).toEqual({ connection: "connected", status: "ready", rows: 25, next: true, enabled: true })
    } finally {
      await page.close()
      await fixture.relay.stop()
    }
  })

  test("status rebasing keeps the scrolled Session anchor and the retained three-page window", async () => {
    for (const width of [390, 1440]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(
          `http://127.0.0.1:${port}/verify/remote.html?view=sessions&noSelection=1&inventoryCount=240&sessionListDelay=100`,
        )
        for (
          let attempt = 0;
          attempt < 80 &&
          !(await page.evaluate<boolean>(
            `window.remoteInventoryReport?.().rows === 25 && document.querySelectorAll('.running-sessions__item').length === 10`,
          ));
          attempt++
        )
          await Bun.sleep(25)
        await page.evaluate(
          `const root = document.querySelector('.workspace__scroll'); root.tabIndex = 0; root.focus()`,
        )
        for (let index = 0; index < 3; index++) {
          const requests = await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)
          await page.evaluate(
            `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = root.scrollHeight; root.dispatchEvent(new WheelEvent('wheel', { deltaY: 250, bubbles: true })); })()`,
          )
          for (
            let attempt = 0;
            attempt < 100 &&
            !(await page.evaluate<boolean>(
              `window.remoteInventoryReport().workspaceRequests > ${requests} && !window.providerAuthState().sessionPageLoading`,
            ));
            attempt++
          )
            await Bun.sleep(25)
        }
        expect(await page.evaluate<number>(`window.remoteInventoryReport().rows`)).toBe(75)
        await page.evaluate(
          `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - 300); root.dispatchEvent(new Event('scroll')); })()`,
        )
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const before = await page.evaluate<{ id: string; offset: number; requests: number }>(
          `(() => { const root = document.querySelector('.workspace__scroll').getBoundingClientRect(); const row = [...document.querySelectorAll('.sessions-table__row')].find(row => row.getBoundingClientRect().bottom > root.top && row.getBoundingClientRect().top < root.bottom); window.anchorID = row.dataset.sessionId; return { id: window.anchorID, offset: row.getBoundingClientRect().top - root.top, requests: window.remoteInventoryReport().workspaceRequests } })()`,
        )
        await page.evaluate(`window.remoteStatus(['ses_inventory_14000'], [window.anchorID])`)
        for (
          let attempt = 0;
          attempt < 120 &&
          !(await page.evaluate<boolean>(
            `window.remoteInventoryReport().workspaceRequests > ${before.requests} && !window.providerAuthState().sessionPageLoading`,
          ));
          attempt++
        )
          await Bun.sleep(25)
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        const after = await page.evaluate<{ rows: number; offset: number | null; anchored: boolean }>(
          `(() => { const root = document.querySelector('.workspace__scroll').getBoundingClientRect(); const row = [...document.querySelectorAll('.sessions-table__row')].find(row => row.dataset.sessionId === window.anchorID); return { rows: window.remoteInventoryReport().rows, offset: row ? row.getBoundingClientRect().top - root.top : null, anchored: window.remoteInventoryReport().inputs.some(input => input.around === window.anchorID) } })()`,
        )
        expect(after.rows).toBe(75)
        expect(after.anchored).toBe(true)
        expect(after.offset).not.toBeNull()
        expect(Math.abs(after.offset! - before.offset)).toBeLessThanOrEqual(2)
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("keeps sidebar rows enabled on a background read and disables them only for a changed filter", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const)
        for (const [width, height] of [
          [390, 844],
          [1440, 900],
        ])
          for (const reduced of [false, true]) {
            const scope = width! < 768 ? ".overlay--sessions-sheet[open]" : ".workspace__rail"
            await page.setViewport(width!, height!)
            await page.setColorScheme(theme)
            await page.setReducedMotion(reduced)
            await page.navigate(
              `http://127.0.0.1:${port}/verify/remote.html?view=chat&inventoryCount=240&sessionListDelay=900`,
            )
            if (width! < 768) await page.evaluate(`document.querySelector('.app-header__menu').click()`)
            for (
              let attempt = 0;
              attempt < 80 &&
              !(await page.evaluate<boolean>(
                `window.remoteInventoryReport().listStatus === 'ready' && Number(document.querySelector('${scope} .session-list [aria-setsize]')?.getAttribute('aria-setsize') ?? 0) === window.remoteInventoryReport().rows`,
              ));
              attempt++
            )
              await Bun.sleep(50)
            const baseline = await page.evaluate<{ requests: number; rows: number; busy: boolean; enabled: boolean }>(
              `(() => { const list = document.querySelector('${scope} .session-list'); return { requests: window.remoteInventoryReport().workspaceRequests, rows: Number(list.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0), busy: list.getAttribute('aria-busy') === 'true', enabled: [...list.querySelectorAll('.session-row')].every(row => !row.disabled) }; })()`,
            )
            expect(baseline, `${width}x${height} ${theme} reduced=${reduced}`).toMatchObject({
              requests: 1,
              rows: 26,
              busy: false,
              enabled: true,
            })
            expect(
              await page.evaluate<{ limit: number; paginated: number; first: string }>(
                `({ limit: window.remoteInventoryReport().inputs.find(input => input.workspace !== undefined).limit, paginated: window.providerAuthState().sessions.filter(session => session.id.startsWith('ses_inventory_')).length, first: window.remoteInventoryReport().first })`,
              ),
            ).toEqual({ limit: 25, paginated: 25, first: "ses_fixture" })
            await page.evaluate(`window.remoteInvalidateSessions()`)
            for (
              let attempt = 0;
              attempt < 60 &&
              (await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)) <= baseline.requests;
              attempt++
            )
              await Bun.sleep(20)
            expect(
              await page.evaluate<{ status: string; busy: boolean; enabled: boolean; rows: number }>(
                `(() => { const list = document.querySelector('${scope} .session-list'); return { status: window.remoteInventoryReport().listStatus, busy: list.getAttribute('aria-busy') === 'true', enabled: [...list.querySelectorAll('.session-row')].every(row => !row.disabled), rows: Number(list.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0) }; })()`,
              ),
            ).toEqual({ status: "ready", busy: false, enabled: true, rows: 26 })
            for (
              let attempt = 0;
              attempt < 80 && (await page.evaluate<string>(`window.remoteInventoryReport().listStatus`)) !== "ready";
              attempt++
            )
              await Bun.sleep(20)
            const residentRows = await page.evaluate<number>(
              `Number(document.querySelector('${scope} .session-list [aria-setsize]')?.getAttribute('aria-setsize') ?? 0)`,
            )
            expect(residentRows).toBeGreaterThanOrEqual(baseline.rows)
            await page.evaluate(
              `(() => { const input = document.querySelector('${scope} input[type=search]'); input.value = 'Inventory Session 0'; input.dispatchEvent(new InputEvent('input', { bubbles:true })); })()`,
            )
            const pending = await page.evaluate<{ busy: boolean; disabled: boolean; rows: number; title: string }>(
              `(() => { const list = document.querySelector('${scope} .session-list'); return { busy: list.getAttribute('aria-busy') === 'true', disabled: [...list.querySelectorAll('.session-row')].every(row => row.disabled), rows: Number(list.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? 0), title: document.querySelector('.conversation-breadcrumb strong')?.textContent ?? '' }; })()`,
            )
            expect(pending).toMatchObject({ busy: true, disabled: true, rows: residentRows })
            await page.evaluate(`document.querySelector('${scope} .session-row').click()`)
            expect(
              await page.evaluate<string>(
                `document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`,
              ),
            ).toBe(pending.title)
            await Bun.sleep(140)
            expect(
              await page.evaluate<boolean>(
                `document.querySelector('${scope} .session-list').getAttribute('aria-busy') === 'true' && [...document.querySelectorAll('${scope} .session-row')].every(row => row.disabled)`,
              ),
            ).toBe(true)
            for (
              let attempt = 0;
              attempt < 100 &&
              (await page.evaluate<number>(
                `Number(document.querySelector('${scope} .session-list [aria-setsize]')?.getAttribute('aria-setsize') ?? 0)`,
              )) !== 1;
              attempt++
            )
              await Bun.sleep(25)
            expect(
              await page.evaluate<boolean>(
                `document.querySelector('${scope} .session-list').getAttribute('aria-busy') === 'true'`,
              ),
            ).toBe(false)
            expect(await page.evaluate<boolean>(`document.querySelector('${scope} .session-row').disabled`)).toBe(false)
          }
    } finally {
      await page.close()
    }
  }, 40_000)

  test("keeps unchanged resident Sessions actionable during a delayed background reload", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const)
        for (const [width, height] of [
          [390, 844],
          [1440, 900],
        ])
          for (const reduced of [false, true]) {
            await page.setViewport(width!, height!)
            await page.setColorScheme(theme)
            await page.setReducedMotion(reduced)
            await page.navigate(
              `http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=240&sessionListDelay=900`,
            )
            for (
              let attempt = 0;
              attempt < 80 &&
              (await page.evaluate<number>(
                `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
              )) !== 25;
              attempt++
            )
              await Bun.sleep(50)
            const initial = await page.evaluate<{
              requests: number
              rows: number
              busy: string | null
              enabled: boolean
            }>(
              `(() => { window.backgroundRow = document.querySelector('.sessions-table__row'); return { requests: window.remoteInventoryReport().workspaceRequests, rows: (Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1), busy: document.querySelector('.sessions-results').getAttribute('aria-busy'), enabled: !window.backgroundRow.querySelector('button').disabled }; })()`,
            )
            expect(initial).toMatchObject({ requests: 1, rows: 25, busy: "false", enabled: true })
            await page.evaluate(`window.remoteInvalidateSessions()`)
            for (
              let attempt = 0;
              attempt < 60 &&
              (await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)) <= initial.requests;
              attempt++
            )
              await Bun.sleep(20)
            const pending = await page.evaluate<{
              status: string
              rows: number
              busy: string | null
              enabled: boolean
              connected: boolean
            }>(
              `(() => ({ status: window.remoteInventoryReport().listStatus, rows: (Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1), busy: document.querySelector('.sessions-results').getAttribute('aria-busy'), enabled: [...document.querySelectorAll('.sessions-table__select')].every(button => !button.disabled), connected: window.backgroundRow.isConnected }))()`,
            )
            expect(pending).toEqual({ status: "ready", rows: 25, busy: "false", enabled: true, connected: true })
            await Bun.sleep(140)
            expect(
              await page.evaluate<boolean>(
                `document.querySelector('.sessions-results').getAttribute('aria-busy') === 'false' && [...document.querySelectorAll('.sessions-table__select')].every(button => !button.disabled)`,
              ),
            ).toBe(true)
            for (
              let attempt = 0;
              attempt < 80 && (await page.evaluate<string>(`window.remoteInventoryReport().listStatus`)) !== "ready";
              attempt++
            )
              await Bun.sleep(20)
            expect(
              await page.evaluate<number>(
                `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
              ),
            ).toBeGreaterThanOrEqual(initial.rows)
            expect(
              await page.evaluate<boolean>(
                `document.querySelector('.sessions-results').getAttribute('aria-busy') === 'false'`,
              ),
            ).toBe(true)
          }
    } finally {
      await page.close()
    }
  }, 35_000)

  test("holds stale Sessions rows non-actionable and anchored until a delayed filter settles", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const)
        for (const [width, height] of [
          [390, 844],
          [1440, 900],
        ])
          for (const reduced of [false, true]) {
            await page.setViewport(width!, height!)
            await page.setColorScheme(theme)
            await page.setReducedMotion(reduced)
            await page.navigate(
              `http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=240&sessionListDelay=900`,
            )
            for (
              let attempt = 0;
              attempt < 80 &&
              (await page.evaluate<number>(
                `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
              )) !== 25;
              attempt++
            )
              await Bun.sleep(50)
            for (
              let attempt = 0;
              attempt < 80 &&
              (await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`)) !== 10;
              attempt++
            )
              await Bun.sleep(25)
            for (
              let attempt = 0;
              attempt < 100 &&
              !(await page.evaluate<boolean>(
                `window.remoteInventoryReport().listStatus === 'ready' && document.querySelector('.conversation-pane .transcript-message') !== null`,
              ));
              attempt++
            )
              await Bun.sleep(50)
            expect(
              await page.evaluate<boolean>(
                `window.remoteInventoryReport().listStatus === 'ready' && document.querySelector('.conversation-pane .transcript-message') !== null`,
              ),
            ).toBe(true)
            const before = await page.evaluate<{ height: number; scrollHeight: number; top: number }>(
              `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = 180; window.staleRow = [...document.querySelectorAll('.sessions-table__row')].find(row => row.textContent.includes('Inventory Session 0')); return { height: document.querySelector('.sessions-results').getBoundingClientRect().height, scrollHeight: root.scrollHeight, top: window.staleRow.getBoundingClientRect().top }; })()`,
            )
            await page.evaluate(
              `(() => { const input = document.querySelector('.sessions-page input[type=search]'); input.value = 'Inventory Session 0'; input.dispatchEvent(new InputEvent('input', { bubbles:true })); })()`,
            )
            for (const delay of [0, 140, 360]) {
              if (delay > 0) await Bun.sleep(delay)
              const pending = await page.evaluate<{
                rows: number
                connected: boolean
                busy: boolean
                disabled: boolean
                height: number
                scrollHeight: number
                top: number
              }>(
                `(() => { const root = document.querySelector('.workspace__scroll'); const results = document.querySelector('.sessions-results'); return { rows: (Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1), connected: window.staleRow.isConnected, busy: results.getAttribute('aria-busy') === 'true', disabled: [...results.querySelectorAll('.sessions-table__select')].every(button => button.disabled), height: results.getBoundingClientRect().height, scrollHeight: root.scrollHeight, top: window.staleRow.getBoundingClientRect().top }; })()`,
              )
              expect(pending.rows).toBe(25)
              expect(pending.connected).toBe(true)
              expect(pending.busy).toBe(true)
              expect(pending.disabled).toBe(true)
              expect(Math.abs(pending.height - before.height)).toBeLessThanOrEqual(2)
              expect(Math.abs(pending.scrollHeight - before.scrollHeight)).toBeLessThanOrEqual(2)
              expect(Math.abs(pending.top - before.top)).toBeLessThanOrEqual(2)
              if (theme === "light" && width === 390 && !reduced && delay === 140)
                console.info("inventory filter geometry", JSON.stringify({ before, pending }))
              await page.evaluate(`window.staleRow.querySelector('button').click()`)
              expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/sessions")
            }
            for (
              let attempt = 0;
              attempt < 100 &&
              (await page.evaluate<number>(
                `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
              )) !== 1;
              attempt++
            )
              await Bun.sleep(25)
            expect(
              await page.evaluate<number>(
                `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
              ),
            ).toBe(1)
            expect(await page.evaluate<boolean>(`window.staleRow.isConnected`)).toBe(true)
            expect(
              await page.evaluate<string>(`document.querySelector('.sessions-results').getAttribute('aria-busy')`),
            ).toBe("false")
            expect(await page.evaluate<boolean>(`document.querySelector('.sessions-table__select').disabled`)).toBe(
              false,
            )
          }
    } finally {
      await page.close()
    }
  }, 35_000)

  test("scrolls the conversation sidebar and finds a distant Session without loading intervening pages", async () => {
    if (!browser) throw new Error("Browser did not start")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&inventoryCount=14501`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await page.evaluate<number>(`window.remoteInventoryReport?.().rows ?? 0`)) === 25) break
        await Bun.sleep(100)
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (
          (await page.evaluate<number>(
            `Number(document.querySelector('.workspace__rail .session-list [aria-setsize]')?.getAttribute('aria-setsize') ?? 0)`,
          )) === 25
        )
          break
        await Bun.sleep(50)
      }
      expect(
        await page.evaluate<number>(
          `Number(document.querySelector('.workspace__rail .session-list [aria-setsize]')?.getAttribute('aria-setsize') ?? 0)`,
        ),
      ).toBe(25)
      expect(
        await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`),
      ).toContain("Stream remote output safely")
      await page.evaluate(
        `(() => { const root = document.querySelector('.workspace__rail-body'); root.tabIndex = 0; root.focus(); })()`,
      )
      await page.pressKey("End", "End", 35)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)) >= 2) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)).toBe(2)
      await page.evaluate(
        `(() => { const input = document.querySelector('.workspace__rail input[type=search]'); input.value = 'Inventory Session 14000'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`,
      )
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (
          await page.evaluate<boolean>(
            `document.querySelector('.workspace__rail .session-row')?.textContent?.includes('Inventory Session 14000') ?? false`,
          )
        )
          break
        await Bun.sleep(50)
      }
      expect(
        await page.evaluate<number>(
          `Number(document.querySelector('.workspace__rail .session-list [aria-setsize]')?.getAttribute('aria-setsize') ?? 0)`,
        ),
      ).toBe(1)
      expect(
        await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent ?? ''`),
      ).toContain("Stream remote output safely")
    } finally {
      await page.close()
    }
  }, 30_000)

  test("renders one backend workspace page, advances on scroll without growing the DOM, and switches groups", async () => {
    if (!browser) throw new Error("Browser did not start")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=14501`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await page.evaluate<number>(`window.remoteInventoryReport?.().rows ?? 0`)) === 25) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate(`window.remoteInventoryReport()`)).toMatchObject({
        workspaceRequests: 1,
        rows: 25,
        groups: 2,
        next: true,
      })
      for (
        let attempt = 0;
        attempt < 40 &&
        (await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`)) !== 10;
        attempt += 1
      )
        await Bun.sleep(50)
      expect(await page.evaluate<number>(`document.querySelectorAll('.running-sessions__item').length`)).toBe(10)
      expect(
        await page.evaluate<readonly { readonly status: string; readonly limit: number }[]>(
          `window.remoteInventoryReport().inputs.filter(input => input.workspace === undefined).map(input => ({ status: input.status, limit: input.limit }))`,
        ),
      ).toEqual([
        { status: "waiting", limit: 10 },
        { status: "running", limit: 10 },
        { status: "idle", limit: 10 },
      ])
      expect(
        await page.evaluate<number>(
          `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
        ),
      ).toBe(25)
      await page.evaluate(
        `(() => { const root = document.querySelector('.workspace__scroll'); root.tabIndex = 0; root.focus(); })()`,
      )
      await page.pressKey("End", "End", 35)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)) >= 2) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)).toBe(2)
      for (let index = 0; index < 8; index += 1) {
        await page.evaluate(
          `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = root.scrollHeight; root.dispatchEvent(new WheelEvent('wheel', { deltaY: 250, bubbles: true })); })()`,
        )
        await Bun.sleep(60)
      }
      expect(await page.evaluate<number>(`window.remoteInventoryReport().workspaceRequests`)).toBeGreaterThanOrEqual(5)
      expect(
        await page.evaluate<number>(
          `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
        ),
      ).toBeLessThanOrEqual(76)
      expect(
        await page.evaluate<number>(
          `[...document.querySelectorAll('.sessions-table__row')].filter(row => row.textContent.includes('Stream remote output safely')).length`,
        ),
      ).toBeLessThanOrEqual(1)
      expect(
        await page.evaluate<boolean>(
          `(() => { const rows = [...document.querySelectorAll('.sessions-table__row')]; return new Set(rows.map(row => row.getAttribute('aria-rowindex'))).size === rows.length && rows.length < 40 })()`,
        ),
      ).toBe(true)
      const before = await page.evaluate<string>(`window.remoteInventoryReport().firstListed`)
      await page.evaluate(
        `(() => { const root = document.querySelector('.workspace__scroll'); root.scrollTop = 0; root.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true })); })()`,
      )
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await page.evaluate<string>(`window.remoteInventoryReport().firstListed`)) !== before) break
        await Bun.sleep(50)
      }
      expect(await page.evaluate<string>(`window.remoteInventoryReport().firstListed`)).not.toBe(before)
      expect(
        await page.evaluate<number>(
          `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
        ),
      ).toBeLessThanOrEqual(76)
      expect(
        await page.evaluate<number>(
          `[...document.querySelectorAll('.sessions-table__row')].filter(row => row.textContent.includes('Stream remote output safely')).length`,
        ),
      ).toBeLessThanOrEqual(1)
      await page.evaluate(
        `[...document.querySelectorAll('.workspace-nav__item')].find((item) => item.title === '/workspace/other')?.click()`,
      )
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (
          await page.evaluate<boolean>(
            `document.querySelector('.sessions-table__row')?.textContent?.includes('Inventory Session 1') ?? false`,
          )
        )
          break
        await Bun.sleep(50)
      }
      expect(
        await page.evaluate<number>(
          `(Number(document.querySelector('.sessions-table')?.getAttribute('aria-rowcount') ?? 1) - 1)`,
        ),
      ).toBe(25)
      expect(
        await page.evaluate<string>(`document.querySelector('.sessions-table__row')?.textContent ?? ''`),
      ).toContain("Inventory Session 1")
    } finally {
      await page.close()
    }
  }, 30_000)
})
