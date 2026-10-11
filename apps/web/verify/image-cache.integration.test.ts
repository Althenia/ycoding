import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4437
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/transcript.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Image cache fixture did not start")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function wait(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(30)
  }
  throw new Error(`Image cache consumer did not settle: ${expression}`)
}

test("eviction refetches an old source without replacing its mounted preview or open lightbox", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?images=1&imageCache=1`)
      await wait(page, `document.querySelector('[data-message-id="msg_image"] .transcript-image img')?.naturalWidth>0`)
      await page.evaluate(`(() => {
        window.preview=document.querySelector('[data-message-id="msg_image"] .transcript-image img');
        window.previewSource=window.preview.src;
        document.querySelector('[data-message-id="msg_image"] .transcript-image').click();
      })()`)
      await wait(page, `document.querySelector('.transcript-lightbox[open] img')?.naturalWidth>0`)
      await page.evaluate(`window.lightbox=document.querySelector('.transcript-lightbox img')`)
      const before = await page.evaluate<number>(`window.imageFetchCount()`)
      await page.evaluate(`window.imageUpdate('evict')`)
      expect(await page.evaluate<number>(`window.imageFetchCount()`)).toBe(before + 1)
      expect(await page.evaluate<{ preview: boolean; lightbox: boolean; source: boolean; decoded: boolean; unavailable: boolean }>(`({
        preview:window.preview===document.querySelector('[data-message-id="msg_image"] .transcript-image img'),
        lightbox:window.lightbox===document.querySelector('.transcript-lightbox[open] img'),
        source:window.preview.src===window.previewSource&&window.lightbox.src===window.previewSource,
        decoded:window.preview.naturalWidth>0&&window.lightbox.naturalWidth>0,
        unavailable:document.querySelector('[data-message-id="msg_image"] .transcript-image__unavailable')?.textContent.includes('screen.png')??false,
      })`)).toEqual({ preview: true, lightbox: true, source: true, decoded: true, unavailable: false })
      await page.pressEscape()
      await wait(page, `document.querySelector('.transcript-lightbox[open]')===null`)
      expect(await page.evaluate<boolean>(`window.preview===document.querySelector('[data-message-id="msg_image"] .transcript-image img')&&window.preview.naturalWidth>0`)).toBe(true)
    } finally { await page.close() }
  }
}, 30_000)
