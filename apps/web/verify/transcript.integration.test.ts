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
        for (let i = 0; i < 80 && await page.evaluate<number>(`document.querySelectorAll('.message').length`) < (synthetic === "full" ? 1_200 : 121); i++) await Bun.sleep(50)
        counts.push(await page.evaluate(`({ messages: document.querySelectorAll('.message').length, nodes: document.querySelectorAll('*').length, reasoningBodies: document.querySelectorAll('.reasoning__body').length })`))
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
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.reasoning') !== null`); i++) await Bun.sleep(50)
      expect(await page.evaluate<number>(`document.querySelectorAll('.reasoning').length`)).toBe(1)
      expect(await page.evaluate<number>(`document.querySelectorAll('.reasoning__body').length`)).toBe(0)
      await page.evaluate(`document.querySelector('.reasoning summary').focus()`)
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.reasoning summary')`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<boolean>(`document.querySelector('.reasoning').open`)).toBe(true)
      for (let i = 0; i < 20 && !await page.evaluate<boolean>(`document.querySelector('.reasoning strong') !== null`); i++) await Bun.sleep(20)
      const result = await page.evaluate<{ bold: string; code: string; literal: boolean; unsafe: number; answer: string }>(`({ bold: document.querySelector('.reasoning strong')?.textContent ?? '', code: document.querySelector('.reasoning code')?.textContent ?? '', literal: document.querySelector('.reasoning').textContent.includes('**'), unsafe: document.querySelectorAll('.reasoning img').length, answer: document.querySelector('.message--assistant .message__text')?.textContent ?? '' })`)
      expect(result).toEqual({ bold: "Important", code: "code", literal: false, unsafe: 0, answer: "Final answer" })
      await page.evaluate(`document.querySelector('.reasoning').dataset.identity = 'retained'; document.querySelector('#stream').click()`)
      expect(await page.evaluate<{ open: boolean; retained: boolean; streamed: boolean }>(`({ open: document.querySelector('.reasoning').open, retained: document.querySelector('.reasoning').dataset.identity === 'retained', streamed: document.querySelector('.reasoning__body')?.textContent.includes('Streamed detail') ?? false })`)).toEqual({ open: true, retained: true, streamed: true })
      await page.pressKey(" ", "Space", 32)
      for (let i = 0; i < 20 && await page.evaluate<boolean>(`document.querySelector('.reasoning__body') !== null`); i++) await Bun.sleep(20)
      expect(await page.evaluate<number>(`document.querySelectorAll('.reasoning__body').length`)).toBe(0)
    } finally { await page.close() }
  })

  test("places user on the right, YCoding on the left with bounded mobile bubbles and actual read state", async () => {
    if (!browser) throw new Error("Browser not started")
    const page = await browser.openPage()
    try {
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html`)
      for (let i = 0; i < 40 && !await page.evaluate(`document.querySelector('.message--user') !== null`); i++) await Bun.sleep(50)
      const inspect = () => page.evaluate<{ user: number; assistant: number; parentLeft: number; parentRight: number; width: number; overflow: boolean; receipt: string; identity: string }>(`(() => { const user = document.querySelector('.message--user'); const assistant = document.querySelector('.message--assistant'); const u = user.getBoundingClientRect(); const a = assistant.getBoundingClientRect(); const p = document.querySelector('.transcript').getBoundingClientRect(); return { user: u.right, assistant: a.left, parentLeft: p.left, parentRight: p.right, width: u.width, overflow: document.documentElement.scrollWidth > innerWidth, receipt: user.querySelector('.message__receipt')?.textContent?.trim() ?? '', identity: assistant.querySelector('.message__meta')?.textContent?.trim() ?? '' } })()`)
      const pending = await inspect()
      expect(pending.user).toBeGreaterThan(pending.assistant)
      expect(pending.user).toBeCloseTo(pending.parentRight, 0)
      expect(pending.assistant).toBeCloseTo(pending.parentLeft, 0)
      expect(pending.width).toBeLessThan(350)
      expect(pending.overflow).toBe(false)
      expect(pending.receipt).toContain("Pending")
      expect(pending.identity).toContain("YCoding")
      await page.evaluate(`document.querySelector('#admit').click()`)
      expect((await inspect()).receipt).toContain("Sent")
      await page.evaluate(`document.querySelector('#consume').click()`)
      expect((await inspect()).receipt).toContain("Read")
      await page.setViewport(320, 740)
      expect((await inspect()).overflow).toBe(false)
    } finally { await page.close() }
  })
})
