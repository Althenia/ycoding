import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4492
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>
beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${port}/verify/typography-fixture.html`).then((response) => response.ok).catch(() => false)) break; await Bun.sleep(100) }
  browser = await launchBrowser(chrome, 390, 844)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })
async function wait(page: Awaited<ReturnType<typeof browser.openPage>>, expression: string) {
  for (let i = 0; i < 100; i++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(30) }
  throw new Error(`Typography fixture did not settle: ${expression}`)
}

test("Latin variable normal and italic faces load from same-origin canonical assets and own the rendered roles", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/typography-fixture.html`)
    await wait(page, `document.querySelector('[data-sans]') !== null`)
    const faces = await page.evaluate<readonly { readonly family: string; readonly weight: string; readonly style: string; readonly status: string }[]>(`(async () => { await Promise.all(['400 16px "Geist"','italic 400 16px "Geist"','700 16px "Geist Mono"','italic 700 16px "Geist Mono"'].map((font)=>document.fonts.load(font,'YCoding abc XYZ 0123456789'))); return [...document.fonts].filter((face)=>face.family.includes('Geist')).map((face)=>({family:face.family,weight:face.weight,style:face.style,status:face.status})); })()`)
    expect(faces).toHaveLength(4)
    expect(faces.every((face) => face.status === "loaded" && face.weight === "100 900")).toBe(true)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-sans]')).fontFamily`)).toStartWith("Geist,")
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-mono]')).fontFamily`)).toStartWith('"Geist Mono",')
    expect(await page.evaluate<boolean>(`performance.getEntriesByType('resource').filter((entry)=>entry.name.includes('.woff2')).every((entry)=>new URL(entry.name).origin===location.origin)`)).toBe(true)
    for (const selector of ["[data-sans]", "[data-sans-italic]", "[data-mono]", "[data-mono-italic]", ".brand__name"]) {
      const fonts = await page.platformFonts(selector)
      expect(fonts.some((font) => font.isCustomFont && font.glyphCount > 0 && font.familyName.includes(selector.includes("mono") ? "Geist Mono" : "Geist"))).toBe(true)
    }
    await Bun.write(new URL("../../../.cache/tmp/typography-geist-specimen.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    expect(await page.evaluate<unknown>(`(async()=>{ const element=document.querySelector('[data-sans]'); element.style.fontWeight='100'; const thin=await document.fonts.load('100 16px "Geist"','YCoding'); element.style.fontWeight='900'; const heavy=await document.fonts.load('900 16px "Geist"','YCoding'); return {thin:thin.length,heavy:heavy.length,weight:getComputedStyle(element).fontWeight}; })()`)).toEqual({ thin: 1, heavy: 1, weight: "900" })
  } finally { await page.close() }
})

test("unavailable font bytes leave a readable rendered interface and a usable Office fallback", async () => {
  const page = await browser.openPage()
  try {
    await page.disableCache(); await page.blockURLs(["*.woff2*"])
    await page.navigate(`http://127.0.0.1:${port}/verify/typography-fixture.html`)
    await wait(page, `document.querySelector('[data-sans]')?.getBoundingClientRect().height > 0`)
    await page.evaluate(`document.fonts.ready`)
    expect((await page.platformFonts("[data-sans]")).some((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('button').getBoundingClientRect().height >= 44 && document.querySelector('[data-sans]').textContent.includes('Approve')`)).toBe(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/office-engine.html?state=tool&inspectEngine=1`)
    await wait(page, `window.__officeGame?.scene?.getScene('office')?.objects?.size > 0`)
    expect(await page.evaluate<boolean>(`[...window.__officeGame.scene.getScene('office').objects.values()].every((actor)=>actor.label.width > 0)`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.office-notice[role="alert"]') === null`)).toBe(true)
  } finally { await page.close() }
})

test("genuinely late Office fonts refresh existing vertical metrics and textures to fresh same-style text, then release listeners", async () => {
  const page = await browser.openPage()
  try {
    await page.disableCache()
    const requests = await page.pauseFontRequests()
    await page.injectOnNewDocument(`(() => { const fonts=document.fonts; const add=fonts.addEventListener.bind(fonts),remove=fonts.removeEventListener.bind(fonts); window.fontListeners=0; fonts.addEventListener=(type,...input)=>{if(type==='loadingdone')window.fontListeners++;add(type,...input)}; fonts.removeEventListener=(type,...input)=>{if(type==='loadingdone')window.fontListeners--;remove(type,...input)}; })()`)
    await page.navigate(`http://127.0.0.1:${port}/verify/office-engine.html?state=tool&inspectEngine=1`)
    expect(requests.pending()).toBe(2)
    expect(await page.evaluate<boolean>(`document.querySelector('.office-canvas-host canvas') === null`)).toBe(true)
    expect(await page.evaluate<boolean>(`[...document.fonts].filter((face)=>face.family.includes('Geist')&&face.style==='normal').every((face)=>face.status==='loading')`)).toBe(true)
    await wait(page, `window.__officeGame?.scene?.getScene('office')?.objects?.size > 0`)
    expect(await page.evaluate<number>(`window.fontListeners`)).toBe(1)
    await page.evaluate(`(() => { const scene=window.__officeGame.scene.getScene('office'); window.fontTexts=[scene.badge,...[...scene.objects.values()].flatMap((actor)=>[actor.label,actor.bubble,actor.marker])]; window.fallbackMetrics=window.fontTexts.map((text)=>text.style.getTextMetrics()); })()`)
    await requests.release()
    await page.evaluate(`document.fonts.ready`)
    expect(await page.evaluate<boolean>(`[...document.fonts].filter((face)=>face.family.includes('Geist')&&face.style==='normal').every((face)=>face.status==='loaded')`)).toBe(true)
    const comparisons = await page.evaluate<readonly { readonly metricsEqual: boolean; readonly textureEqual: boolean; readonly changed: boolean; readonly actual: unknown; readonly expected: unknown }[]>(`(() => { const scene=window.__officeGame.scene.getScene('office'); return window.fontTexts.map((text,index)=>{ const style=text.style.toJSON(); delete style.metrics; const fresh=scene.add.text(0,0,text.text,style).setPadding(text.padding); const actual=text.style.getTextMetrics(),expected=fresh.style.getTextMetrics(); const result={metricsEqual:JSON.stringify(actual)===JSON.stringify(expected),textureEqual:text.canvas.toDataURL()===fresh.canvas.toDataURL(),changed:JSON.stringify(window.fallbackMetrics[index])!==JSON.stringify(expected),actual,expected}; fresh.destroy(); return result; }); })()`)
    expect(comparisons.some((text) => text.changed)).toBe(true)
    expect(comparisons.every((text) => text.metricsEqual), JSON.stringify(comparisons)).toBe(true)
    expect(comparisons.every((text) => text.textureEqual)).toBe(true)
    await Bun.write(new URL("../../../.cache/tmp/typography-office-late-font.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent === 'Unmount office').click()`)
    await wait(page, `document.querySelector('.office-canvas-host canvas') === null`)
    expect(await page.evaluate<number>(`window.fontListeners`)).toBe(0)
  } finally { await page.close() }
})

test("an Office removed during its font wait cannot mount a late renderer", async () => {
  const page = await browser.openPage()
  try {
    await page.disableCache()
    const requests = await page.pauseFontRequests()
    await page.navigate(`http://127.0.0.1:${port}/verify/office-engine.html?state=tool&inspectEngine=1`)
    expect(requests.pending()).toBe(2)
    await page.evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent === 'Unmount office').click()`)
    await requests.release()
    await page.evaluate(`document.fonts.ready`)
    await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`document.querySelector('canvas') === null && window.__officeGame === undefined`)).toBe(true)
  } finally { await page.close() }
})

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) test(`Geist public and remote layouts preserve owned roles without overflow at ${width}px ${theme}`, async () => {
  const page = await browser.openPage()
  try {
    await page.setViewport(width, 844); await page.setCoarsePointer(width < 768)
    await page.navigate(`http://127.0.0.1:${port}/`)
    await wait(page, `document.querySelector('.marketing') !== null`)
    await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.fonts.ready`)
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect((await page.platformFonts(".hero h1")).some((font) => font.isCustomFont && font.familyName.includes("Geist"))).toBe(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}&responseProbe=1`)
    await wait(page, `document.querySelector('.composer__input') !== null`)
    await page.evaluate(`document.fonts.ready`)
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.composer__input')).fontFamily`)).toContain("Geist")
    expect((await page.platformFonts(".app-header__team-count")).some((font) => font.isCustomFont && font.familyName.includes("Geist Mono"))).toBe(true)
  } finally { await page.close() }
})

test("the Office engine uses settled token-selected font families rather than cached system text", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/office-engine.html?state=tool&inspectEngine=1`)
    await wait(page, `window.__officeGame?.scene?.getScene('office')?.objects?.size > 0`)
    expect(await page.evaluate<unknown>(`(() => { const scene=window.__officeGame.scene.getScene('office'); const actor=[...scene.objects.values()][0]; return {label:actor.label.style.fontFamily,bubble:actor.bubble.style.fontFamily,sansLoaded:[...document.fonts].some((face)=>face.family.includes('Geist')&&!face.family.includes('Mono')&&face.status==='loaded'),monoLoaded:[...document.fonts].some((face)=>face.family.includes('Geist Mono')&&face.status==='loaded')}; })()`)).toMatchObject({ label: expect.stringContaining("Geist Mono"), bubble: expect.stringContaining("Geist"), sansLoaded: true, monoLoaded: true })
  } finally { await page.close() }
})
