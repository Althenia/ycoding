import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { launchBrowser } from "./cdp"

const port = 4387
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
  await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("keyboard and mouse autocomplete, pending identity, and creation work across four sizes and themes", async () => {
  for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width!, height!)
        await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
        await wait(page, `document.querySelectorAll('.composer textarea').length === 2`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        const input = ".mini-composer__mount textarea"
        for (const [trigger, choice, expected] of [["/pla", "/plan", "/plan "], ["@rev", "@reviewer", "@reviewer "], ["$aud", "$audit", "$audit "], ["#rev", "Reviewer", "@reviewer "]] as const) {
          await type(page, input, trigger)
          await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.textContent?.includes(${JSON.stringify(choice)}) === true`)
          if (trigger === "/pla" || trigger === "$aud") await page.pressKey("Enter", "Enter", 13)
          else await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.click()`)
          expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toBe(expected)
        }
        await type(page, input, "@apps/web")
        await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
        await page.evaluate(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete button')?.click()`)
        expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)})?.value`)).toContain("composer.tsx")
        if (width === 390 && theme === "light") {
          await type(page, input, "@slow")
          await Bun.sleep(250)
          await type(page, input, "@apps")
          await wait(page, `document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
          await Bun.sleep(420)
          expect(await page.evaluate<boolean>(`document.querySelector('.mini-composer__mount .mini-composer__autocomplete')?.textContent?.includes('slow.txt') ?? false`)).toBe(false)
        }
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Agent"]')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["GSD", "architect"])
        expect(await page.evaluate<boolean>(`document.querySelector('.mini-picker__surface')?.classList.contains('mini-picker__surface--sheet')`)).toBe(width! < 768)
        await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('architect'))?.click()`)
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__search') !== null`)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__group')].map(item => item.textContent.trim())`)).toEqual(["Anthropic", "OpenAI"])
        await page.evaluate(`(() => { const field = document.querySelector('.mini-picker__search'); field.value = 'Claude'; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
        await page.evaluate(`document.querySelector('.mini-picker__surface [role="option"]')?.click()`)
        expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .mini-composer__identity')?.textContent`)).toContain("→ architect · → anthropic/Claude Opus 5.5 · high")
        if (width! < 768) {
          await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Model"]')?.click()`)
          await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
          await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('Claude Opus 5.5 · max'))?.click()`)
        } else {
          await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Variant"]')?.click()`)
          await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
          await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.trim() === 'max')?.click()`)
        }
        expect(await page.evaluate<string>(`document.querySelector('.mini-composer__mount .mini-composer__identity')?.textContent`)).toContain("max")
        await type(page, input, "Review $audit")
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]')?.click()`)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ text: "Review $audit", skills: ["audit"], agent: "architect", model: { id: "claude-opus-5-5", variant: "max" } })
        await type(page, input, "/plan now")
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-pressed="false"]')?.click()`)
        await page.pressKey("Enter", "Enter", 13)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)`)).toMatchObject({ operation: "session.command", input: { command: "plan", arguments: "now", delivery: "queue", agent: "architect", model: { variant: "max" } } })
        await page.evaluate(`document.querySelector('main > button')?.click()`)
        await wait(page, `document.querySelector('.mini-composer__mount button[aria-label="Interrupt the running step"]') !== null`)
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Interrupt the running step"]')?.click()`)
        expect(await page.evaluate<string>(`window.composerRequests().at(-1)?.operation`)).toBe("session.interrupt")
        await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
        await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
        await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.includes('Other repository'))?.click()`)
        await type(page, ".new-session-composer textarea", "Use @apps/web")
        await wait(page, `document.querySelector('.new-session-composer .mini-composer__autocomplete')?.textContent?.includes('composer.tsx') === true`)
        await page.evaluate(`document.querySelector('.new-session-composer .mini-composer__autocomplete button')?.click()`)
        await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
        await wait(page, `document.querySelector('output')?.textContent?.includes('ses_created') === true`)
        expect(await page.evaluate<unknown>(`window.composerRequests().at(-1)?.input`)).toMatchObject({ workspaceID: "work_two", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "max" }, prompt: { text: "Use @apps/web/src/remote/ui/composer.tsx", files: [{ uri: "file:///workspace/ycoding/apps/web/src/remote/ui/composer.tsx", mention: { start: 4, text: "@apps/web/src/remote/ui/composer.tsx" } }] } })
        const layout = await page.evaluate<{ overflow: boolean; controlsInside: boolean; touchTargets: boolean }>(`(() => { const rows = [...document.querySelectorAll('.composer__row')]; const controls = [...document.querySelectorAll('.composer__controls button')]; return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, controlsInside: rows.every(row => [...row.querySelectorAll('.composer__controls button')].every(button => button.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1)), touchTargets: controls.every(button => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44) }; })()`)
        expect(layout.overflow).toBe(false)
        expect(layout.controlsInside).toBe(true)
        if (width! < 768) expect(layout.touchTargets).toBe(true)
        await Bun.write(new URL(`../../../.cache/tmp/composer-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }
}, 180_000)

async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.setSelectionRange(field.value.length, field.value.length); field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`).then((response) => response.ok, () => false) }
