import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { chooseWorkspace } from "./workspace-controls"

const port = 4681
const origin = `http://127.0.0.1:${port}`
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: Bun.Subprocess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && server.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`${origin}/verify/remote.html`)).ok) {
        browser = await launchBrowser(browserPath, 1440, 900)
        return
      }
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("Workspaces fixture server did not start; check that port 4681 is free")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function open() {
  const page = await browser!.openPage()
  await page.navigate(`${origin}/verify/remote.html?view=sessions&workspaces=overflow&theme=dark`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]')`); attempt++) await Bun.sleep(25)
  return page
}

describe("route-owned repository filtering", () => {
  test("keeps every repository reachable in a viewport-bounded selector without replacing the Session rail", async () => {
    const page = await open()
    try {
      await page.evaluate(`(()=>{const trigger=document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]');trigger.focus();trigger.click()})()`)
      const options = await page.evaluate(`(()=>{const list=document.querySelector('.custom-select__list'),surface=document.querySelector('.custom-select__surface'),box=surface.getBoundingClientRect();return{count:list.children.length,scrolls:surface.scrollHeight>surface.clientHeight,contained:box.top>=0&&box.bottom<=innerHeight}})()`)
      expect(options).toEqual({count:22,scrolls:true,contained:true})
      await page.pressEscape()
      const label = await chooseWorkspace(page, 21)
      for (let attempt = 0; attempt < 80 && await page.evaluate(`document.querySelector('.sessions-page__title').textContent.trim()`) !== label; attempt++) await Bun.sleep(25)
      expect(await page.evaluate(`document.querySelector('.sessions-page__title').textContent.trim()`)).toBe(label)
      expect(await page.evaluate(`!!document.querySelector('.workspace__rail [aria-label="Search sessions"]') && document.activeElement===document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]')`)).toBe(true)
    } finally { await page.close() }
  }, 30_000)

  test("keyboard navigation reveals the last repository and Escape returns focus without changing the filter", async () => {
    const page = await open()
    try {
      const initial = await page.evaluate(`document.querySelector('.sessions-page__title').textContent.trim()`)
      await page.evaluate(`document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]').focus()`)
      await page.pressKey("End", "End", 35)
      expect(await page.evaluate(`(()=>{const trigger=document.activeElement,item=document.getElementById(trigger.getAttribute('aria-activedescendant')),list=document.querySelector('.custom-select__list'),surface=document.querySelector('.custom-select__surface'),a=item.getBoundingClientRect(),b=surface.getBoundingClientRect();return item===list.lastElementChild&&a.top>=b.top&&a.bottom<=b.bottom})()`)).toBe(true)
      await page.pressEscape()
      expect(await page.evaluate(`document.activeElement===document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]')`)).toBe(true)
      expect(await page.evaluate(`document.querySelector('.sessions-page__title').textContent.trim()`)).toBe(initial)
    } finally { await page.close() }
  }, 30_000)
})
