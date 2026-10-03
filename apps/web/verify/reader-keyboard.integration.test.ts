import { afterAll, beforeAll, expect, test } from "bun:test"
import { Server } from "node:http"
import type { ViteDevServer } from "vite"
import { launchBrowser } from "./cdp"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable.")
let server: ViteDevServer
let listener: Server
let browser: Awaited<ReturnType<typeof launchBrowser>>
let origin: string

beforeAll(async () => {
  const { createServer } = await import("vite")
  server = await createServer({ root: import.meta.dir.replace(/\/verify$/, ""), cacheDir: new URL("../../../.cache/tmp/web-reading/vite-keyboard", import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false } })
  listener = new Server(server.middlewares)
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve) })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing ephemeral Vite address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); await server?.close(); if (listener) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())) })

test("ArrowUp in the transcript pauses following without remounting the focused code control", async () => {
  const page = await browser.openPage()
  try {
    await page.setReducedMotion(true)
    await page.navigate(`${origin}/verify/remote.html?view=chat&team=two&transcriptProbe=1`)
    for (let attempt = 0; attempt < 120 && !await page.evaluate<boolean>(`!!document.querySelector('[data-message-id="probe_tail"] .transcript-md__code button')`); attempt++) await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
    await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden'; window.readerButton=document.querySelector('[data-message-id="probe_tail"] .transcript-md__code button'); window.readerButton.focus({preventScroll:true}); })()`)
    await page.evaluate(`(() => {const root=document.querySelector('.workspace__scroll'); window.keyboardLanding=new Promise(resolve=>{const ended=()=>{if(root.scrollHeight-root.clientHeight-root.scrollTop<=1)return;root.removeEventListener('scrollend',ended);resolve(true)};root.addEventListener('scrollend',ended)});})()`)
    await page.pressKey("ArrowUp", "ArrowUp", 38)
    await page.evaluate(`window.keyboardLanding`)
    const before = await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)
    await page.evaluate(`window.transcriptDelta('\\n'+'keyboard reading grows live '.repeat(100))`)
    await page.evaluate(`new Promise(resolve=>{let frames=8;const tick=()=>--frames?requestAnimationFrame(tick):resolve(true);requestAnimationFrame(tick)})`)
    expect(await page.evaluate<number>(`document.querySelector('.workspace__scroll').scrollTop`)).toBe(before)
    expect(await page.evaluate<boolean>(`document.activeElement===window.readerButton && window.readerButton.isConnected`)).toBe(true)
    expect(await page.evaluate<boolean>(`!!document.querySelector('[aria-label="Jump to latest"]')`)).toBe(true)
  } finally { await page.close() }
}, 60_000)
