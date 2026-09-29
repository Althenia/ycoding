import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { launchBrowser } from "./cdp"

const port = 4328
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
const phase = process.env.LIGHT_OFFICE_PHASE ?? "after"
const captures = join(import.meta.dir, "../../../.cache/tmp/light-office", phase)
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  await mkdir(captures, { recursive: true })
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok).catch(() => false)) break
    await Bun.sleep(100)
  }
  if (server.exitCode !== null) throw new Error("Vite failed to start")
  browser = await launchBrowser(chrome, 1440, 900)
}, 30_000)

afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("light landing keeps its hero neutral while dark retains the ambient glow", async () => {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser!.openPage()
    try {
      await page.setColorScheme(theme)
      await page.navigate(`http://127.0.0.1:${port}/`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`!!document.querySelector('.hero')`); attempt++) await Bun.sleep(100)
      await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      const glow = await page.evaluate<string>(`getComputedStyle(document.querySelector('.hero'),'::before').backgroundImage`)
      if (theme === "light") expect(glow).toBe("none")
      else expect(glow).toContain("radial-gradient")
      const command = await page.evaluate<{ background: string; ink: string }>(`(() => ({background:getComputedStyle(document.querySelector('.hero .code-block')).backgroundColor,ink:getComputedStyle(document.querySelector('.hero .code-block pre')).color}))()`)
      expect(command.background).toBe("rgb(12, 20, 19)")
      expect(ratio(command.ink, command.background)).toBeGreaterThanOrEqual(4.5)
    } finally { await page.close() }
  }
}, 30_000)

test("tall landing keeps the feature cards next to the footer", async () => {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(1440, 1200)
      await page.setColorScheme(theme)
      await page.navigate(`http://127.0.0.1:${port}/`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`!!document.querySelector('.features')`); attempt++) await Bun.sleep(100)
      await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      await Bun.sleep(650)
      const layout = await page.evaluate<{ gap: number; heroCenter: number; pageHeight: number }>(`(() => { const hero=document.querySelector('.hero').getBoundingClientRect(), content=document.querySelector('.hero__content').getBoundingClientRect();return {gap:document.querySelector('.site-footer').getBoundingClientRect().top-document.querySelector('.features').getBoundingClientRect().bottom,heroCenter:Math.abs((hero.top+hero.bottom-content.top-content.bottom)/2),pageHeight:document.documentElement.scrollHeight} })()`)
      console.log(`Tall landing ${phase} ${theme}: ${JSON.stringify(layout)}`)
      await Bun.write(join(captures, `landing-tall-1440-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
      if (phase !== "before") {
        expect(layout.gap).toBeLessThanOrEqual(1)
        expect(layout.heroCenter).toBeLessThanOrEqual(12)
        expect(layout.pageHeight).toBeLessThanOrEqual(1200)
      }
    } finally { await page.close() }
  }
}, 30_000)

test("light new-session icon actions have perceivable boundaries", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=light&noSelection=1`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`!!document.querySelector('.new-session-composer__refresh')`); attempt++) await Bun.sleep(100)
      for (const selector of [".new-session-composer__refresh", ".new-session-composer .composer__attach"]) {
        const pair = await page.evaluate<{ border: string; width: number }>(`(() => { const style=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return {border:style.borderColor,width:parseFloat(style.borderWidth)} })()`)
        expect(pair.width, `${selector} border width`).toBeGreaterThanOrEqual(1)
        expect(ratio(pair.border, "rgb(255, 255, 255)"), `${selector} boundary contrast`).toBeGreaterThanOrEqual(3)
      }
    } finally { await page.close() }
  }
}, 30_000)

test("light composer and picker boundaries separate from white surfaces", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=light&noSelection=1`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`!!document.querySelector('.new-session-composer .model-control__trigger')`); attempt++) await Bun.sleep(100)
    for (const selector of [".new-session-composer .composer__row", ".new-session-composer__repository .mini-picker__trigger", ".new-session-composer .mini-picker__trigger", ".new-session-composer .model-control__trigger"]) {
      const border = await page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderColor`)
      expect(ratio(border, "rgb(255, 255, 255)"), `${selector} boundary contrast`).toBeGreaterThanOrEqual(3)
    }
  } finally { await page.close() }
}, 30_000)

function ratio(foreground: string, background: string) {
  const luminance = (value: string) => {
    const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
    if (!channels || channels.length !== 3) throw new Error(`Expected RGB: ${value}`)
    return channels.map((channel) => channel / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0)
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0]! + .05) / (values[1]! + .05)
}

test("light and dark presentation retains contained public and workspace surfaces", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) for (const theme of ["light", "dark"] as const) {
    for (const [name, route, selector] of [
      ["landing", "/", ".hero__headline"],
      ["docs", "/docs/quickstart", ".docs-article > h1"],
      ["changelog", "/changelog", ".release"],
      ["new-session", `/verify/remote.html?view=chat&theme=${theme}&noSelection=1`, ".new-session-composer textarea"],
      ["conversation", `/verify/remote.html?view=chat&theme=${theme}`, ".remote-conversation-view"],
      ["settings", `/verify/remote.html?view=settings&theme=${theme}`, width < 768 ? ".settings" : ".office-settings"],
    ] as const) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, height)
        await page.setColorScheme(theme)
        await page.setReducedMotion(false)
        await page.navigate(`http://127.0.0.1:${port}${route}`)
        for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`); attempt++) await Bun.sleep(100)
        expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`), `${name} rendered`).toBe(true)
        if (name === "settings" && width < 768) expect(await page.evaluate<boolean>(`document.querySelector('.office-settings') === null`)).toBe(true)
        await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        await page.evaluate(`document.querySelectorAll('.fixture__banner,.fixture__controls').forEach((element) => element.remove())`)
        await Bun.sleep(850)
        const measures = await page.evaluate<{ scrollWidth: number }>(`(() => {
          const rect = (selector) => { const node=document.querySelector(selector); if(!node) return null; const r=node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,width:r.width} };
          const style = (selector) => { const node=document.querySelector(selector); if(!node) return null; const s=getComputedStyle(node); return {font:s.fontFamily,border:s.borderColor,background:s.backgroundColor,color:s.color} };
          return {theme:document.documentElement.dataset.theme,viewport:innerHeight,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth,
            app:rect('.app'),workspace:rect('.workspace'),main:rect('.workspace__main'),scroll:rect('.workspace__scroll'),footer:rect('.site-footer'),features:rect('.features'),header:rect('.app-header'),strip:rect('.status-strip'),
            composer:style('.composer__row'),refresh:style('.new-session-composer__refresh'),attach:style('.composer__attach'),picker:style('.composer__controls .mini-picker__trigger'),input:style('.composer__input'),heroGlow:getComputedStyle(document.querySelector('.hero') ?? document.body,'::before').backgroundImage};
        })()`)
        console.log(JSON.stringify({ phase, name, width, theme, measures }))
        await Bun.write(join(captures, `${name}-${width}-${theme}.png`), Buffer.from(await page.screenshot(), "base64"))
        if (phase !== "before") {
          expect(measures.scrollWidth, `${name} ${width} ${theme} horizontal overflow`).toBeLessThanOrEqual(width + 1)
        }
      } finally { await page.close() }
    }
  }
}, 180_000)
