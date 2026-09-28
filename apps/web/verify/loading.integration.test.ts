import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const port = 4449
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/loading-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Loading fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("Team loading reserves a card-shaped region with one polite announcement", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.team-view') !== null`); attempt += 1) await Bun.sleep(50)
    const pending = await page.evaluate<{ readonly skeleton: boolean; readonly status: number; readonly busy: boolean }>(`({ skeleton: document.querySelector('#team-panel-subagents .loading-placeholder') !== null, status: document.querySelectorAll('#team-panel-subagents [role="status"]').length, busy: document.querySelector('#team-panel-subagents')?.getAttribute('aria-busy') === 'true' })`)
    expect(pending).toEqual({ skeleton: true, status: 1, busy: true })
    await page.evaluate(`window.finishLoading()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task') !== null && document.querySelector('#team-panel-subagents .loading-placeholder') === null`)).toBe(true)
  } finally { await page.close() }
})

test("Team pages and shell output keep visual loading affordances inside their panel", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.team-view') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`window.finishLoading()`)
    await page.evaluate(`document.querySelector('.team-view__more').click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('#team-panel-subagents .loading-placeholder--team') !== null`)).toBe(true)
    await page.evaluate(`window.finishPage()`)
    expect(await page.evaluate<boolean>(`document.querySelector('[data-session-id="ses_old"]') !== null`)).toBe(true)
    await page.evaluate(`document.querySelector('[data-tab="shell"]').click(); document.querySelector('[data-action="output"]').click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__output .loading-placeholder--output') !== null`)).toBe(true)
    await page.evaluate(`window.finishOutput()`)
    expect(await page.evaluate<string>(`document.querySelector('.team-view__output pre')?.textContent ?? ''`)).toContain("Tests passed")
  } finally { await page.close() }
})

test("Office loading holds the canvas and roster geometry while subagents arrive", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.office-roster') !== null`); attempt += 1) await Bun.sleep(50)
    const pending = await page.evaluate<{ readonly placeholder: boolean; readonly height: number }>(`({ placeholder: document.querySelector('.office-roster .loading-placeholder--team') !== null, height: document.querySelector('.office-workspace__canvas').getBoundingClientRect().height })`)
    expect(pending.placeholder).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.office-roster__empty') === null`)).toBe(true)
    await page.evaluate(`window.finishOfficeTeam()`)
    const settled = await page.evaluate<{ readonly placeholder: boolean; readonly height: number }>(`({ placeholder: document.querySelector('.office-roster .loading-placeholder--team') !== null, height: document.querySelector('.office-workspace__canvas').getBoundingClientRect().height })`)
    expect(settled.placeholder).toBe(false)
    expect(Math.abs(settled.height - pending.height)).toBeLessThanOrEqual(1)
  } finally { await page.close() }
})

test("image loading reserves the exact thumbnail frame until the source arrives", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.transcript-attachment') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.transcript-attachment').scrollIntoView()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.transcript-attachment .loading-placeholder--image') !== null`)).toBe(true)
    const before = await page.evaluate<{ readonly width: number; readonly height: number }>(`(() => { const box = document.querySelector('.transcript-attachment').getBoundingClientRect(); return { width: box.width, height: box.height } })()`)
    await page.evaluate(`window.finishImage()`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.transcript-attachment img')?.naturalWidth > 0`); attempt += 1) await Bun.sleep(20)
    const after = await page.evaluate<{ readonly width: number; readonly height: number }>(`(() => { const box = document.querySelector('.transcript-attachment').getBoundingClientRect(); return { width: box.width, height: box.height } })()`)
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1)
  } finally { await page.close() }
})

test("older history loading appears without moving the resident message", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="prompt_1"]') !== null`); attempt += 1) await Bun.sleep(50)
    const before = await page.evaluate<number>(`document.querySelector('[data-message-id="prompt_1"]').getBoundingClientRect().top`)
    await page.evaluate(`window.startHistory()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.transcript-navigation .loading-placeholder--history') !== null`)).toBe(true)
    const after = await page.evaluate<number>(`document.querySelector('[data-message-id="prompt_1"]').getBoundingClientRect().top`)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
  } finally { await page.close() }
})

test("shell output loading keeps a terminal-sized placeholder until its page settles", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
    for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('[data-message-id="shell_1"]') !== null`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`document.querySelector('[data-message-id="shell_1"] .loading-placeholder--output') !== null`)).toBe(true)
    await page.evaluate(`window.finishShellOutput()`)
    expect(await page.evaluate<string>(`document.querySelector('[data-message-id="shell_1"] .output')?.textContent ?? ''`)).toContain("Tests passed")
  } finally { await page.close() }
})

test("loading placeholders wait 140 ms in both motion modes and never flash for fast reads", async () => {
  const page = await browser!.openPage()
  try {
    for (const reduce of [false, true]) {
      await page.setReducedMotion(reduce)
      await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html`)
      for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.team-view__header') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`window.finishLoading()`)
      const loadedHeight = await page.evaluate<number>(`document.querySelector('.team-view__task').getBoundingClientRect().height`)
      const initial = await page.evaluate<{ readonly visibility: string; readonly height: number }>(`(() => { window.startLoading(); const shape = document.querySelector('#team-panel-subagents .loading-placeholder__shape'); return { visibility: getComputedStyle(shape).visibility, height: shape.getBoundingClientRect().height } })()`)
      expect(Math.abs(initial.height - loadedHeight)).toBeLessThanOrEqual(1)
      expect(initial.visibility).toBe("hidden")
      await page.evaluate(`window.finishLoading()`)
      await Bun.sleep(180)
      expect(await page.evaluate<boolean>(`document.querySelector('#team-panel-subagents .loading-placeholder') === null`)).toBe(true)
      const delayed = await page.evaluate<{ readonly elapsed: number; readonly animation: string }>(`new Promise((resolve, reject) => {
        window.startLoading(); const start = performance.now();
        const read = () => { const shape = document.querySelector('#team-panel-subagents .loading-placeholder__shape');
          if (shape && getComputedStyle(shape).visibility === 'visible') return resolve({ elapsed: performance.now() - start, animation: getComputedStyle(shape.querySelector('.loading-placeholder__bar')).animationName });
          if (performance.now() - start > 1000) return reject(new Error('Loading placeholder stayed hidden'));
          requestAnimationFrame(read);
        }; read();
      })`)
      expect(delayed.elapsed).toBeGreaterThanOrEqual(130)
      expect(delayed.animation === "none").toBe(reduce)
    }
  } finally { await page.close() }
})

test("captures pending and settled loading surfaces at desktop and phone in both themes", async () => {
  const page = await browser!.openPage()
  const output = join(import.meta.dir, "../../../.cache/tmp/loading-check")
  await mkdir(output, { recursive: true })
  try {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of ["light", "dark"] as const) {
      await page.setViewport(width, height)
      await page.setReducedMotion(theme === "dark")
      await page.navigate(`http://127.0.0.1:${port}/verify/loading-fixture.html?theme=${theme}`)
      for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.office-roster .loading-placeholder--team') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`window.startHistory()`)
      await Bun.sleep(190)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      const canvasTop = await page.evaluate<number>(`document.querySelector('.office-workspace__canvas').getBoundingClientRect().top`)
      await Bun.write(join(output, `pending-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`document.querySelector('.transcript-attachment').scrollIntoView()`)
      await Bun.write(join(output, `pending-detail-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`window.finishLoading(); window.finishOfficeTeam(); window.finishImage(); window.finishShellOutput(); window.finishHistory()`)
      for (let attempt = 0; attempt < 50 && !await page.evaluate<boolean>(`document.querySelector('.transcript-attachment img')?.naturalWidth > 0`); attempt += 1) await Bun.sleep(20)
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await Bun.write(join(output, `settled-detail-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`window.scrollTo(0, 0)`)
      expect(Math.abs(await page.evaluate<number>(`document.querySelector('.office-workspace__canvas').getBoundingClientRect().top`) - canvasTop)).toBeLessThanOrEqual(1)
      await Bun.write(join(output, `settled-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task') !== null && document.querySelector('.office-roster .loading-placeholder') === null && document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    }
  } finally { await page.close() }
}, 30_000)
