import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4461
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/transcript.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Compaction checkpoint fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

describe("compaction checkpoint in the conversation", () => {
  test("ends scrolling at the latest card without loading history above it at phone and desktop sizes in both themes", async () => {
    const page = await browser!.openPage()
    try {
      for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [1440, 900]]) {
        await page.setViewport(width!, height!)
        await page.setReducedMotion(true)
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?theme=${theme}`)
        await page.evaluate(`(async () => {
          const [{ createComponent, render }, { createSessionView, readSnapshot }, { RemoteProvider }, { TranscriptNavigation }] = await Promise.all([
            import('/node_modules/solid-js/web/dist/web.js'), import('/src/remote/projection.ts'),
            import('/src/remote/context.tsx'), import('/src/remote/ui/transcript-nav.tsx'),
          ])
          document.querySelector('#app').remove()
          const root = document.createElement('div')
          document.body.append(root)
          const host = document.createElement('main')
          host.className = 'transcript-fixture workspace__main'
          const scroll = document.createElement('div')
          scroll.className = 'workspace__scroll'
          scroll.style.cssText = 'height: 600px; overflow-y: auto'
          host.append(scroll)
          const slot = document.createElement('div')
          slot.className = 'conversation-jump-slot'
          host.append(slot)
          root.append(host)
          const metrics = { excludedMessages: 11, excludedParts: 1, inputTokens: 1000, retainedTokens: 400 }
          const messages = [
            { id: 'msg_covered_old', type: 'user', text: 'covered old', time: { created: 1 } },
            { id: 'msg_old_compaction', type: 'compaction', jobID: 'cmp_old', status: 'completed', boundary: { messageID: 'msg_covered_old', seq: 1 }, metrics, time: { created: 2 } },
            { id: 'msg_covered_new', type: 'user', text: 'covered new', time: { created: 3 } },
            { id: 'msg_checkpoint', type: 'compaction', jobID: 'cmp_latest', status: 'completed', boundary: { messageID: 'msg_covered_new', seq: 3 }, metrics, time: { created: 4 } },
            ...Array.from({ length: 20 }, (_, i) => ({ id: 'msg_after_' + i, type: 'user', text: 'Retained message ' + i + ' '.repeat(70), time: { created: i + 5 } })),
          ]
          const view = { ...createSessionView('ses_a'), messages: readSnapshot({ session: {}, messages, before: 'covered' }).messages,
            compactionHistory: { data: [
              { jobID: 'cmp_old', trigger: 'auto', status: 'completed', created: 2, metrics },
              { jobID: 'cmp_latest', trigger: 'manual', status: 'completed', created: 4, metrics },
            ], truncated: false, completedBefore: 0, completedCount: 2, totalSavedTokens: 1200 } }
          window.olderRequests = 0
          const store = { state: () => ({ activeSessionID: 'ses_a', view, history: { status: 'idle', before: 'covered' } }),
            subscribe: () => () => {}, load: async () => {}, dispose: () => {},
            loadOlderMessages: async () => { window.olderRequests++ } }
          render(() => createComponent(RemoteProvider, { createStore: () => store,
            get children() { return createComponent(TranscriptNavigation, { messages: () => view.messages }) } }), scroll)
          await new Promise((resolve) => setTimeout(resolve, 50))
          scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }))
          scroll.scrollTop = 0
          scroll.dispatchEvent(new Event('scroll'))
          await new Promise((resolve) => setTimeout(resolve, 50))
        })()`)
        const result = await page.evaluate<{ readonly cards: number; readonly first: string; readonly olderRequests: number; readonly marker: boolean; readonly scrollTop: number; readonly overflow: boolean; readonly time: string }>(`(() => {
          const scroll = document.querySelector('.workspace__scroll')
          return { cards: document.querySelectorAll('.transcript-compaction').length,
            first: document.querySelector('.transcript [data-message-id]')?.getAttribute('data-message-id') ?? '',
            olderRequests: window.olderRequests, marker: !!document.querySelector('.transcript-navigation__beginning, .transcript-navigation__history-error'),
            scrollTop: scroll.scrollTop, overflow: document.documentElement.scrollWidth > innerWidth,
            time: document.querySelector('.transcript-compaction__items')?.textContent ?? '' }
        })()`)
        expect(result.cards).toBe(1)
        expect(result.first).toBe("cmp_latest")
        expect(result.olderRequests).toBe(0)
        expect(result.marker).toBe(false)
        expect(result.scrollTop).toBe(0)
        expect(result.overflow).toBe(false)
        expect(result.time).toMatch(/messages compressed · \d{1,2}:\d{2}/)
        expect(result.time).toContain(new Date(4).toLocaleDateString())
      }
    } finally { await page.close() }
  }, 20_000)
})
