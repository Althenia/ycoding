import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4399
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/notifications-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Notifications fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function open(width: number, theme: "light" | "dark", initial = "seeded") {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  await page.setViewport(width, 844)
  await page.navigate(`http://127.0.0.1:${port}/verify/notifications-fixture.html?theme=${theme}&initial=${initial}`)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector('.yc-notification-center__trigger') !== null`)) return page
    await Bun.sleep(50)
  }
  await page.close()
  throw new Error("Notification center did not mount")
}

describe("notification center and live toasts", () => {
  test("an unresolved Session title updates its visible row and toast without restarting either", async () => {
    for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
      const page = await open(width, theme, "empty")
      try {
        await page.evaluate(`window.remoteNotify('agent-completed', 'ses_alpha', false)`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.yc-toast__body span') !== null`); attempt += 1) await Bun.sleep(30)
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        expect(await page.evaluate<{ row: string; toast: string }>(`({ row: document.querySelector('.yc-notification__open span')?.textContent, toast: document.querySelector('.yc-toast__body span')?.textContent })`)).toEqual({ row: "An action needs attention.", toast: "An action needs attention." })
        await page.evaluate(`window.noticeRow = document.querySelector('.yc-notification'); window.noticeToast = document.querySelector('.yc-toast'); window.remoteResolveTitle('ses_alpha', 'Alpha Session')`)
        expect(await page.evaluate<{ row: string; toast: string; sameRow: boolean; sameToast: boolean }>(`({ row: document.querySelector('.yc-notification__open span')?.textContent, toast: document.querySelector('.yc-toast__body span')?.textContent, sameRow: document.querySelector('.yc-notification') === window.noticeRow, sameToast: document.querySelector('.yc-toast') === window.noticeToast })`)).toEqual({ row: "Alpha Session", toast: "Alpha Session", sameRow: true, sameToast: true })
        await page.pressEscape()
        await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        expect(await page.evaluate<string>(`document.querySelector('.yc-notification__open span')?.textContent ?? ''`)).toBe("Alpha Session")
        await page.evaluate(`document.querySelector('.yc-notification__dismiss').click()`)
        expect(await page.evaluate<string>(`document.querySelector('.yc-toast__body span')?.textContent ?? ''`)).toBe("Alpha Session")
      } finally { await page.close() }
    }
  }, 15_000)

  test("live status, clock, read, and reconnect updates preserve an open center and its settled rows", async () => {
    for (const [width, height] of [[390, 844], [1440, 900]] as const) for (const theme of ["light", "dark"] as const) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, height)
        await page.injectOnNewDocument(`(() => {
          const now = Date.now.bind(Date); let offset = 0;
          const interval = window.setInterval.bind(window); const minutes = [];
          Date.now = () => now() + offset;
          window.setInterval = (callback, delay, ...args) => {
            if (delay === 60000 && typeof callback === 'function') minutes.push(() => callback(...args));
            return interval(callback, delay, ...args);
          };
          window.advanceNoticeMinutes = (count) => { offset += count * 60000; minutes.forEach(tick => tick()); };
        })()`)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`(window.remoteOperationReport?.().operations['session.status'] ?? 0) > 0 && document.querySelector('.yc-notification-center__trigger') !== null`); attempt += 1) await Bun.sleep(50)
        await page.evaluate(`window.remoteStatus(['ses_fixture','ses_a','ses_b','ses_c'], []); window.remoteStatus(['ses_a','ses_b','ses_c'], []); window.advanceNoticeMinutes(2); window.remoteStatus(['ses_b','ses_c'], []); window.advanceNoticeMinutes(2); window.remoteStatus(['ses_c'], []); window.advanceNoticeMinutes(1); window.remoteStatus([], []); window.advanceNoticeMinutes(3)`)
        expect(await page.evaluate<number>(`Number(document.querySelector('.yc-notification-center__badge')?.textContent)`)).toBe(4)
        await page.evaluate(`(() => {
          window.addedNoticeRows = new Set(); window.removedNoticeRows = new Set();
          new MutationObserver(records => records.forEach(record => {
            for (const node of record.addedNodes) if (node instanceof Element) {
              if (node.matches('.yc-notification')) window.addedNoticeRows.add(node);
              node.querySelectorAll('.yc-notification').forEach(row => window.addedNoticeRows.add(row));
            }
            for (const node of record.removedNodes) if (node instanceof Element) {
              if (node.matches('.yc-notification')) window.removedNoticeRows.add(node);
              node.querySelectorAll('.yc-notification').forEach(row => window.removedNoticeRows.add(row));
            }
          })).observe(document.querySelector('.yc-notification-center'), { childList: true, subtree: true });
          document.querySelector('.yc-notification-center__trigger').click();
        })()`)
        await page.evaluate(`Promise.allSettled([...document.querySelectorAll('.yc-notification-panel, .yc-notification')].flatMap(node => node.getAnimations()).map(animation => animation.finished))`)
        await Bun.sleep(300)
        const initial = await page.evaluate<{ added: number; removed: number; ages: readonly string[]; label: string; unread: number }>(`(() => {
          window.noticePanel = document.querySelector('.yc-notification-panel');
          window.noticeRows = [...document.querySelectorAll('.yc-notification')];
          return { added: window.addedNoticeRows.size, removed: window.removedNoticeRows.size, ages: [...document.querySelectorAll('.yc-notification time')].map(node => node.textContent), label: document.querySelector('.yc-notification-panel__new')?.textContent ?? '', unread: document.querySelectorAll('.yc-notification__unread:not([aria-hidden="true"])').length };
        })()`)
        const sample = `(() => {
          const panel = document.querySelector('.yc-notification-panel'), rows = [...document.querySelectorAll('.yc-notification')], rect = panel.getBoundingClientRect();
          return { retained: window.noticeRows.every(node => rows.includes(node)), panelSame: panel === window.noticePanel,
            activeRows: rows.filter(node => node.getAnimations().some(animation => animation.playState === 'running')).length,
            age: rows.map(node => node.querySelector('time')?.textContent), badge: document.querySelector('.yc-notification-center__badge')?.textContent ?? '',
            label: document.querySelector('.yc-notification-panel__new')?.textContent ?? '', rect: [rect.left, rect.top, rect.width, rect.height],
            added: window.addedNoticeRows.size, removed: window.removedNoticeRows.size };
        })()`
        const before = await page.evaluate<{ rect: readonly number[] }>(sample)
        await page.evaluate(`window.remoteStatus([], [])`)
        const status = await page.evaluate<{ retained: boolean; panelSame: boolean; activeRows: number; rect: readonly number[]; added: number; removed: number }>(sample)
        await page.evaluate(`window.advanceNoticeMinutes(1)`)
        const tick = await page.evaluate<{ retained: boolean; panelSame: boolean; activeRows: number; age: readonly string[]; rect: readonly number[]; added: number; removed: number }>(sample)
        await page.evaluate(`window.remoteStatus(['ses_new'], []); window.remoteStatus([], [])`)
        await page.evaluate(`Promise.allSettled([...document.querySelectorAll('.yc-notification')].flatMap(node => node.getAnimations()).map(animation => animation.finished))`)
        const newNotice = await page.evaluate<{ retained: boolean; panelSame: boolean; activeRows: number; rect: readonly number[]; badge: string; added: number; removed: number }>(sample)
        await page.evaluate(`document.querySelector('.yc-notification-panel__action:first-of-type').click()`)
        const read = await page.evaluate<{ retained: boolean; panelSame: boolean; activeRows: number; rect: readonly number[]; badge: string; added: number; removed: number }>(sample)
        const snapshotReads = await page.evaluate<number>(`window.remoteOperationReport().operations['session.snapshot'] ?? 0`)
        await page.evaluate(`[...document.querySelectorAll('.fixture__controls button')].find(button => button.textContent?.includes('Simulate disconnect and reconnect')).click()`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.status-strip__body')?.textContent?.startsWith('Connected —') === true`); attempt += 1) await Bun.sleep(50)
        const reconnect = await page.evaluate<{ retained: boolean; panelSame: boolean; activeRows: number; rect: readonly number[]; added: number; removed: number }>(sample)
        expect(initial).toEqual({ added: 4, removed: 0, ages: ["3m", "4m", "6m", "8m"], label: "4 new", unread: 0 })
        for (const update of [status, tick, newNotice, read, reconnect]) {
          expect(update.retained).toBe(true)
          expect(update.panelSame).toBe(true)
          expect(update.activeRows).toBe(0)
        }
        expect(status.rect).toEqual(before.rect)
        expect(tick.rect).toEqual(before.rect)
        expect(newNotice.badge).toBe("1")
        expect(read.badge).toBe("")
        expect(read.rect).toEqual(newNotice.rect)
        expect(reconnect.rect).toEqual(newNotice.rect)
        expect(reconnect.added).toBe(5)
        expect(reconnect.removed).toBe(0)
        expect(await page.evaluate<number>(`window.remoteOperationReport().operations['session.snapshot'] ?? 0`)).toBeGreaterThan(snapshotReads)
        expect(tick.age).toEqual(["4m", "5m", "7m", "9m"])
      } finally { await page.close() }
    }
  }, 60_000)

  test("attributes a browser relay reconnect in the connection strip without a machine-disconnected notice", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.status-strip__body')?.textContent?.includes('Connected') === true`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`[...document.querySelectorAll('.fixture__controls button')].find(button => button.textContent?.includes('Simulate disconnect and reconnect'))?.click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.status-strip__body')?.textContent?.startsWith('Connected —') === true && document.querySelector('.status-strip__body')?.textContent?.includes('Last browser relay drop (1006): synthetic disconnect') === true`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<string>(`document.querySelector('.status-strip__body')?.textContent?.trim() ?? ''`)).toBe("Connected — Relay session active for Studio Mac. · Last browser relay drop (1006): synthetic disconnect")
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger')?.click()`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-notification--device-disconnected').length`)).toBe(0)
    } finally { await page.close() }
  }, 15_000)

  test("renders a bounded panel in light and dark desktop and phone layouts with keyboard and item actions", async () => {
    for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) {
      const page = await open(width, theme)
      try {
        expect(await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`)).toBe(0)
        expect(await page.evaluate<string>(`document.querySelector('.yc-notification-center__trigger').getAttribute('aria-label')`)).toContain("2 unread")
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        const result = await page.evaluate<{ count: number; today: boolean; newLabel: string; unread: number; overflow: boolean; left: number; right: number; radius: string; motion: string; theme: string; bodyWidth: number; tonesMatch: boolean }>(`(() => {
          const panel = document.querySelector('.yc-notification-panel'); const rect = panel.getBoundingClientRect();
          const item = panel.querySelector('.yc-notification');
          return { count: panel.querySelectorAll('.yc-notification').length, today: panel.textContent.includes('Today'), newLabel: panel.querySelector('.yc-notification-panel__new')?.textContent ?? '', unread: panel.querySelectorAll('.yc-notification__unread:not([aria-hidden="true"])').length, overflow: document.documentElement.scrollWidth > innerWidth, left: rect.left, right: rect.right, radius: getComputedStyle(panel).borderTopLeftRadius, motion: getComputedStyle(panel).animationName, theme: document.documentElement.dataset.theme, bodyWidth: item.querySelector('.yc-notification__open').getBoundingClientRect().width, tonesMatch: [...panel.querySelectorAll('.yc-notification')].every(row => getComputedStyle(row.querySelector('strong')).color === getComputedStyle(row.querySelector('.yc-notification__icon')).color) };
        })()`)
        expect(result).toMatchObject({ count: 2, today: true, newLabel: "2 new", unread: 0, overflow: false, radius: "20px", theme, tonesMatch: true })
        expect(result.left).toBeGreaterThanOrEqual(0)
        expect(result.right).toBeLessThanOrEqual(width)
        expect(result.motion).not.toBe("none")
        expect(result.bodyWidth).toBeGreaterThan(140)
        await page.evaluate(`Promise.all([...document.querySelectorAll('.yc-notification-panel, .yc-notification')].flatMap(node => node.getAnimations()).map(animation => animation.finished))`)
        await Bun.write(new URL(`../../../.cache/tmp/notifications-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        await page.evaluate(`document.querySelector('.yc-notification__dismiss').focus(); document.querySelector('.yc-notification__dismiss').click()`)
        expect(await page.evaluate<number>(`document.querySelectorAll('.yc-notification').length`)).toBe(1)
        await page.evaluate(`document.querySelector('.yc-notification__open').click()`)
        expect(await page.evaluate<string[]>(`window.remoteOpened()`)).toEqual(["ses_alpha"])
        expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-center__trigger').getAttribute('aria-expanded') === 'false' && document.querySelector('.yc-notification-panel')?.inert === true`)).toBe(true)
        await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
        expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel') === null`)).toBe(true)
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        await page.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
        await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
        expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel') === null`)).toBe(true)
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        await page.evaluate(`document.querySelector('.yc-notification-panel__action:last-child').click()`)
        expect(await page.evaluate<string>(`document.querySelector('.yc-notification-panel__empty strong')?.textContent ?? ''`)).toBe("You're all caught up")
        await page.pressEscape()
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.yc-notification-center__trigger') && document.querySelector('.yc-notification-panel')?.inert === true`)).toBe(true)
        await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
        expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel') === null`)).toBe(true)
      } finally { await page.close() }
    }
  }, 30_000)

  test("notification center enters and exits over frames, then releases its inert closing layer", async () => {
    for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ["light", "dark"] as const) for (const reduce of [false, true]) {
      const page = await open(width!, theme)
      try {
        await page.setViewport(width!, height!)
        await page.setReducedMotion(reduce)
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        const entering = await page.evaluate<{ duration: number; opacity: number; transform: string }>(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const panel = document.querySelector('.yc-notification-panel'), style = getComputedStyle(panel); resolve({ duration: parseFloat(style.animationDuration) * 1000, opacity: Number(style.opacity), transform: style.transform }); })))`)
        if (reduce) expect(entering).toEqual({ duration: 0, opacity: 1, transform: "none" })
        else {
          expect(entering.duration).toBe(220)
          expect(entering.opacity).toBeGreaterThan(0)
          expect(entering.opacity).toBeLessThan(1)
          expect(entering.transform).not.toBe("none")
        }
        await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
        await page.evaluate(`document.querySelector('.yc-notification-panel__action:last-child').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.yc-notification-center__trigger') && document.querySelector('.yc-notification-center__trigger').getAttribute('aria-expanded') === 'false'`)).toBe(true)
        const closing = await page.evaluate<{ expanded: string; inert: boolean; focused: boolean; duration: number; opacity: number; transform: string; tabbable: boolean }>(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const panel = document.querySelector('.yc-notification-panel'), style = panel && getComputedStyle(panel); resolve({ expanded: document.querySelector('.yc-notification-center__trigger').getAttribute('aria-expanded'), inert: panel?.inert ?? false, focused: document.activeElement === document.querySelector('.yc-notification-center__trigger'), duration: style ? parseFloat(style.animationDuration) * 1000 : 0, opacity: style ? Number(style.opacity) : 0, transform: style?.transform ?? 'none', tabbable: !!panel?.querySelector('button:not([tabindex="-1"])') && !panel.inert }); })))`)
        expect(closing.expanded).toBe("false")
        expect(closing.focused).toBe(true)
        if (reduce) expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel') === null`)).toBe(true)
        else {
          expect(closing.inert).toBe(true)
          expect(closing.tabbable).toBe(false)
          expect(closing.duration).toBe(220)
          expect(closing.opacity).toBeLessThan(1)
          expect(closing.transform).not.toBe("none")
          await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
          expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel') === null`)).toBe(true)
        }
      } finally { await page.close() }
    }
  }, 30_000)

  test("a notification panel reopened during exit remains interactive", async () => {
    const page = await open(390, "light")
    try {
      await page.setReducedMotion(false)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
      await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click(); document.querySelector('.yc-notification-center__trigger').click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-center__trigger').getAttribute('aria-expanded') === 'true' && document.querySelector('.yc-notification-panel')?.inert === false`)).toBe(true)
      await Bun.sleep(260)
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel') !== null && document.querySelector('.yc-notification-panel')?.inert === false`)).toBe(true)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click(); document.querySelector('.yc-notification-center__trigger').click()`)
      await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel')?.inert === true`)).toBe(true)
      await Bun.sleep(50)
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-notification-panel')?.inert === true`)).toBe(true)
    } finally { await page.close() }
  })

  test("shows only new live notices as bounded polite toasts, pauses progress, and keeps center history on dismiss", async () => {
    const page = await open(390, "dark", "empty")
    try {
      await page.evaluate(`window.remoteNotify('approval-requested', 'ses_alpha')`)
      for (let attempt = 0; attempt < 30 && await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`) !== 1; attempt += 1) await Bun.sleep(30)
      expect(await page.evaluate<string>(`document.querySelector('.yc-toasts').getAttribute('role')`)).toBe("status")
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-toast').getBoundingClientRect().top >= document.querySelector('header').getBoundingClientRect().bottom`)).toBe(true)
      await page.evaluate(`document.querySelector('.yc-toast').dispatchEvent(new MouseEvent('mouseenter'))`)
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-toast').classList.contains('yc-toast--paused')`)).toBe(true)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.yc-toast__progress')).animationPlayState`)).toBe("paused")
      await page.evaluate(`document.querySelector('.yc-toast').dispatchEvent(new MouseEvent('mouseleave'))`)
      await page.evaluate(`document.querySelector('.yc-toast__open').focus()`)
      expect(await page.evaluate<boolean>(`document.querySelector('.yc-toast').classList.contains('yc-toast--paused')`)).toBe(true)
      await Bun.sleep(260)
      await Bun.write(new URL("../../../.cache/tmp/notifications-toast-390-dark.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`document.querySelector('.yc-toast__open').click()`)
      await Bun.sleep(260)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`)).toBe(0)
      expect(await page.evaluate<string[]>(`window.remoteOpened()`)).toEqual(["ses_alpha"])
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-notification').length`)).toBe(1)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click(); ['ses_alpha','ses_beta','ses_alpha','ses_beta'].forEach(id => window.remoteNotify('error', id))`)
      for (let attempt = 0; attempt < 30 && await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`) !== 3; attempt += 1) await Bun.sleep(30)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`)).toBe(3)
      await page.evaluate(`document.querySelector('.yc-toast__close').click()`)
      await Bun.sleep(260)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`)).toBe(2)
      expect(await page.evaluate<number>(`document.documentElement.scrollWidth - innerWidth`)).toBeLessThanOrEqual(0)
      await Bun.sleep(6_300)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-toast').length`)).toBe(0)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.yc-notification').length`)).toBe(5)
    } finally { await page.close() }
  }, 15_000)

  test("exposes a 44px dismiss target without hover on a coarse pointer", async () => {
    const page = await open(390, "light")
    try {
      await page.setCoarsePointer(true)
      await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
      await page.evaluate(`Promise.all([...document.querySelector('.yc-notification-panel').getAnimations()].map(animation => animation.finished))`)
      const result = await page.evaluate<{ size: number; visible: boolean; overflow: boolean }>(`(() => { const button = document.querySelector('.yc-notification__dismiss'); const style = getComputedStyle(button); return { size: button.getBoundingClientRect().width, visible: style.opacity === '1', overflow: document.documentElement.scrollWidth > innerWidth }; })()`)
      expect(result).toEqual({ size: 44, visible: true, overflow: false })
    } finally { await page.close() }
  })

  test("re-registers this device's push subscription with the relay when the workspace loads", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.injectOnNewDocument(`(() => {
        window.__pushCalls = [];
        Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
        const key = new Uint8Array(65); key[0] = 4;
        const subscription = { endpoint: 'https://fcm.googleapis.com/send/existing', options: { applicationServerKey: key.buffer },
          getKey: (name) => new Uint8Array(name === 'p256dh' ? 65 : 16).buffer, unsubscribe: async () => true };
        const registration = { pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription } };
        Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(registration) });
        const network = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (url.pathname === '/api/push/key') return Response.json({ publicKey: 'BA' + 'A'.repeat(85) });
          if (url.pathname === '/api/push/subscriptions') {
            window.__pushCalls.push({ method: init && init.method, body: init && init.body ? JSON.parse(init.body) : undefined });
            return Response.json({ subscribed: true });
          }
          return network(input, init);
        };
      })()`)
      await page.setViewport(1440, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/notifications-fixture.html?theme=dark`)
      for (let attempt = 0; attempt < 60 && await page.evaluate<number>(`window.__pushCalls.length`) === 0; attempt += 1) await Bun.sleep(50)
      const calls = await page.evaluate<readonly { method: string; body: { endpoint: string } }[]>(`window.__pushCalls`)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ method: "POST", body: { endpoint: "https://fcm.googleapis.com/send/existing" } })
    } finally { await page.close() }
  })

  test("aligns notification rows with the panel heading and its trailing actions", async () => {
    for (const width of [390, 1440]) {
      const page = await open(width, "dark")
      try {
        await page.evaluate(`document.querySelector('.yc-notification-center__trigger').click()`)
        await page.evaluate(`Promise.all([...document.querySelectorAll('.yc-notification-panel, .yc-notification')].flatMap(node => node.getAnimations()).map(animation => animation.finished))`)
        const measure = `(() => {
          const panel = document.querySelector('.yc-notification-panel');
          const head = panel.querySelector('.yc-notification-panel__head');
          const headStyle = getComputedStyle(head);
          const contentLeft = head.getBoundingClientRect().left + parseFloat(headStyle.paddingLeft);
          const contentRight = head.getBoundingClientRect().right - parseFloat(headStyle.paddingRight);
          const label = panel.querySelector('.yc-notification-group h3');
          const labelLeft = label.getBoundingClientRect().left + parseFloat(getComputedStyle(label).paddingLeft);
          const scroll = panel.querySelector('.yc-notification-panel__scroll').getBoundingClientRect();
          const rows = [...panel.querySelectorAll('.yc-notification')].map(row => ({
            rowLeft: row.getBoundingClientRect().left, rowRight: row.getBoundingClientRect().right,
            icon: row.querySelector('.yc-notification__icon').getBoundingClientRect().left,
            time: row.querySelector('time').getBoundingClientRect().right,
          }));
          const dismiss = panel.querySelector('.yc-notification__dismiss');
          return { contentLeft, contentRight, labelLeft, scrollLeft: scroll.left, scrollRight: scroll.right, rows,
            dismissRight: dismiss.getBoundingClientRect().right, dismissVisible: getComputedStyle(dismiss).opacity === '1',
            timeVisible: getComputedStyle(panel.querySelector('.yc-notification time')).visibility === 'visible' };
        })()`
        const resting = await page.evaluate<{ contentLeft: number; contentRight: number; labelLeft: number; scrollLeft: number; scrollRight: number;
          rows: readonly { rowLeft: number; rowRight: number; icon: number; time: number }[]; timeVisible: boolean }>(measure)
        expect(resting.rows.length, `${width}`).toBe(2)
        expect(Math.abs(resting.labelLeft - resting.contentLeft), `${width} label`).toBeLessThanOrEqual(1)
        for (const row of resting.rows) {
          expect(Math.abs(row.icon - resting.contentLeft), `${width} icon`).toBeLessThanOrEqual(1)
          expect(Math.abs(row.time - resting.contentRight), `${width} time`).toBeLessThanOrEqual(1)
          expect(Math.abs(row.rowLeft - resting.scrollLeft), `${width} divider start`).toBeLessThanOrEqual(1)
          expect(Math.abs(row.rowRight - resting.scrollRight), `${width} divider end`).toBeLessThanOrEqual(1)
        }
        expect(resting.timeVisible).toBe(true)
        await page.evaluate(`document.querySelector('.yc-notification__dismiss').focus()`)
        const focused = await page.evaluate<{ contentRight: number; dismissRight: number; dismissVisible: boolean; timeVisible: boolean }>(measure)
        expect(focused.dismissVisible, `${width} dismiss`).toBe(true)
        expect(focused.timeVisible, `${width} time hidden behind dismiss`).toBe(false)
        expect(Math.abs(focused.dismissRight - focused.contentRight), `${width} dismiss edge`).toBeLessThanOrEqual(1)
      } finally { await page.close() }
    }
  }, 30_000)
})
