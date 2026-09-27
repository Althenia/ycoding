import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4397
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
  throw new Error("Transcript fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

describe("transcript rendering", () => {
  test("large synthetic completed boundary bounds mounted transcript nodes", async () => {
    if (!browser) throw new Error("Browser not started")
    const counts: { readonly messages: number; readonly nodes: number; readonly reasoningBodies: number }[] = []
    for (const synthetic of ["full", "compacted"]) {
      const page = await browser.openPage()
      try {
        await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?synthetic=${synthetic}`)
        for (let i = 0; i < 80 && await page.evaluate<number>(`document.querySelectorAll('.transcript-message').length`) < (synthetic === "full" ? 1_200 : 121); i++) await Bun.sleep(50)
        counts.push(await page.evaluate(`({ messages: document.querySelectorAll('.transcript-message').length, nodes: document.querySelectorAll('*').length, reasoningBodies: document.querySelectorAll('.transcript-reasoning__body').length })`))
      } finally { await page.close() }
    }
    expect(counts[0]?.messages).toBe(1_200)
    expect(counts[1]?.messages).toBe(121)
    expect(counts[1]!.nodes).toBeLessThan(counts[0]!.nodes / 2)
    console.log(`Synthetic transcript DOM: full ${counts[0]!.nodes} nodes, compacted ${counts[1]!.nodes} nodes`)
    expect(counts.map((count) => count.reasoningBodies)).toEqual([0, 0])
  })
  test("groups safe reasoning and preserves keyboard disclosure and streamed identity", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-reasoning') !== null`); i++) await Bun.sleep(50)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-reasoning').length`)).toBe(1)
      expect(await page.evaluate<string>(`document.querySelector('.transcript-reasoning summary').textContent`)).toContain("Thought · 2s")
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-reasoning__body').length`)).toBe(0)
      await page.evaluate(`document.querySelector('.transcript-reasoning summary').focus()`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.transcript-reasoning summary')`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning').open`)).toBe(true)
      for (let i = 0; i < 20 && !await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning strong') !== null`); i++) await Bun.sleep(20)
      const result = await page.evaluate<{ bold: string; code: string; literal: boolean; unsafe: number; answer: string }>(`({ bold: document.querySelector('.transcript-reasoning strong')?.textContent ?? '', code: document.querySelector('.transcript-reasoning code')?.textContent ?? '', literal: document.querySelector('.transcript-reasoning').textContent.includes('**'), unsafe: document.querySelectorAll('.transcript-reasoning img').length, answer: document.querySelector('.transcript-message--assistant .transcript-message__text')?.textContent ?? '' })`)
      expect(result).toMatchObject({ bold: "Important", code: "code", literal: false, unsafe: 0 })
      expect(result.answer).toContain("Final answer")
      await page.evaluate(`document.querySelector('.transcript-reasoning').dataset.identity = 'retained'; document.querySelector('#stream').click()`)
      expect(await page.evaluate<{ open: boolean; retained: boolean; streamed: boolean }>(`({ open: document.querySelector('.transcript-reasoning').open, retained: document.querySelector('.transcript-reasoning').dataset.identity === 'retained', streamed: document.querySelector('.transcript-reasoning__body')?.textContent.includes('Streamed detail') ?? false })`)).toEqual({ open: true, retained: true, streamed: true })
      await page.pressKey(" ", "Space", 32)
      for (let i = 0; i < 20 && await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning__body') !== null`); i++) await Bun.sleep(20)
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-reasoning__body').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("places user on the right, YCoding on the left with bounded mobile bubbles and actual read state", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.transcript-message--user') !== null`); i++) await Bun.sleep(50)
      const inspect = () => page.evaluate<{ user: number; assistant: number; parentLeft: number; parentRight: number; width: number; overflow: boolean; receipt: string; identity: string; bubble: string; outside: boolean }>(`(() => { const user = document.querySelector('.transcript-message--user'); const assistant = document.querySelector('.transcript-message--assistant'); const u = user.getBoundingClientRect(); const a = assistant.getBoundingClientRect(); const p = document.querySelector('.transcript').getBoundingClientRect(); return { user: u.right, assistant: a.left, parentLeft: p.left, parentRight: p.right, width: u.width, overflow: document.documentElement.scrollWidth > innerWidth, receipt: user.querySelector('.transcript-message__receipt')?.textContent?.trim() ?? '', identity: assistant.querySelector('.transcript-message__agent')?.textContent?.trim() ?? '', bubble: user.querySelector('.transcript-message__bubble')?.textContent ?? '', outside: user.querySelector('.transcript-message__receipt').getBoundingClientRect().top >= user.querySelector('.transcript-message__bubble').getBoundingClientRect().bottom } })()`)
      const pending = await inspect()
      expect(pending.user).toBeGreaterThan(pending.assistant)
      expect(pending.user).toBeCloseTo(pending.parentRight, 0)
      expect(pending.assistant).toBeCloseTo(pending.parentLeft, 0)
      expect(pending.width).toBeLessThan(350)
      expect(pending.overflow).toBe(false)
      expect(pending.receipt).toContain("Pending")
      expect(pending.identity).toContain("God")
      expect(pending.bubble).not.toContain("You")
      expect(pending.outside).toBe(true)
      await page.evaluate(`document.querySelector('#admit').click()`)
      expect((await inspect()).receipt).toContain("Sent")
      await page.evaluate(`document.querySelector('#consume').click()`)
      expect((await inspect()).receipt).toContain("Read")
      await page.setViewport(320, 740)
      expect((await inspect()).overflow).toBe(false)
    } finally { await page.close() }
  })

  test("renders safe Markdown, observation summary, error line, and live goal state", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.session-status')`); i++) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('.transcript-tool--error .transcript-tool__toggle').click()`)
      const result = await page.evaluate<{ readonly unsafe: number; readonly table: number; readonly code: number; readonly imageLinks: number; readonly rawHTML: boolean; readonly structures: boolean; readonly taskLabel: string; readonly observation: string; readonly error: string; readonly status: string; readonly footer: string }>(`(() => ({ unsafe: document.querySelectorAll('.transcript-md script, .transcript-md img, .transcript-md a[href^="javascript:"], .transcript-md a[href^="data:"]').length, table: document.querySelectorAll('.transcript-md table').length, code: document.querySelectorAll('.transcript-md__code').length, imageLinks: [...document.querySelectorAll('.transcript-md a')].filter(a => a.textContent === 'No image').length, rawHTML: document.querySelector('.transcript-md').textContent.includes('<script>alert(1)</script>'), structures: ['ol','ul ul','input[type=checkbox]','blockquote','hr','del'].every(selector => document.querySelector('.transcript-md ' + selector)), taskLabel: document.querySelector('.transcript-md li:has(input[type=checkbox])')?.textContent ?? '', observation: document.querySelector('.transcript-message__observation summary')?.textContent ?? '', error: document.querySelector('.transcript-tool__error')?.textContent ?? '', status: document.querySelector('.session-status')?.textContent ?? '', footer: document.querySelector('.transcript-message__footer')?.textContent ?? '' }))()`)
      expect(result.unsafe).toBe(0)
      expect(result.table).toBe(1)
      expect(result.code).toBe(1)
      expect(result.imageLinks).toBe(1)
      expect(result.rawHTML).toBe(true)
      expect(result.structures).toBe(true)
      expect(result.taskLabel.trim()).toBe("Verified task")
      expect(result.observation).toContain("Session state · goal")
      expect(result.observation).not.toContain("autonomy")
      expect(result.error).toContain("↳ A very long JSON error")
      expect(result.status).toContain("Goal")
      expect(result.status).toContain("Stop goal")
      expect(result.footer).toContain("anthropic/Claude Opus 5 5 · high")
    } finally { await page.close() }
  })

  test("keeps the transcript within each viewport in both themes and captures every state", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.session-status')`); i++) await Bun.sleep(50)
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
        for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) {
          await page.setViewport(width!, height!)
          await Bun.sleep(600)
          const metrics = await page.evaluate<{ readonly overflow: boolean; readonly minTarget: number }>(`({ overflow: document.documentElement.scrollWidth > innerWidth, minTarget: Math.min(...[...document.querySelectorAll('.transcript-message button, .transcript-message summary, .session-status button, .session-status summary')].map(element => element.getBoundingClientRect().height)) })`)
          expect(metrics.overflow).toBe(false)
          if (width! < 768) expect(metrics.minTarget).toBeGreaterThanOrEqual(44)
          await Bun.write(new URL(`../../../.cache/tmp/transcript-${theme}-${width}x${height}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
          await page.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`)
          await Bun.sleep(100)
          await Bun.write(new URL(`../../../.cache/tmp/transcript-${theme}-${width}x${height}-bottom.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
        }
      }
    } finally { await page.close() }
  }, 60_000)
})
