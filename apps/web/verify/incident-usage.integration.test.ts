import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4721
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
const guidanceText = "<model-guidance>\nPast guardrail reviews stopped some of this model's actions:\n- Destructive Git (standard.review.git-destructive): Prefer reversible Git commands and retain required approval checks.\n</model-guidance>"

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function open(mode: string, width = 1440, theme: "light" | "dark" = "light") {
  const page = await browser!.openPage()
  await page.setViewport(width, 900)
  await page.navigate(`http://127.0.0.1:${port}/verify/incident-usage-fixture.html?mode=${mode}`)
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  return page
}
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
const click = (page: Page, selector: string, text?: string) => page.evaluate(`(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
  const node = ${text === undefined ? "nodes[0]" : `nodes.find((item) => item.textContent.trim() === ${JSON.stringify(text)})`}
  if (!node) throw new Error('Missing ${selector} ${text ?? ""}')
  node.click()
})()`)
const requests = (page: Page, operation: string) => page.evaluate<Record<string, unknown>[]>(`window.incidentRequests().filter((item) => item.operation === ${JSON.stringify(operation)}).map((item) => item.input)`)
const rows = (page: Page) => page.evaluate<number>(`document.querySelectorAll('.incidents [data-incident-row]').length`)
const text = (page: Page, selector: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`)
const ready = () => fetch(`http://127.0.0.1:${port}/verify/incident-usage-fixture.html`).then((response) => response.ok, () => false)

test("incidents section reports exact counts, totals, and the last UTC time per model without overflow", async () => {
  for (const [width, theme] of [[1440, "light"], [820, "dark"], [390, "light"], [320, "dark"]] as const) {
    const page = await open("default", width, theme)
    try {
      await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
      expect(await text(page, '.incidents h2')).toBe("Model incidents")
      expect(await requests(page, "incident.report")).toEqual([{ group: "model", offset: 0, limit: 25 }])
      const first = await page.evaluate<{ readonly text: string; readonly time: string; readonly datetime: string; readonly overflow: boolean }>(`(() => {
        const row = document.querySelector('.incidents [data-incident-row]'), time = row.querySelector('time')
        return { text: row.textContent.replace(/\\s+/g, ' '), time: time.textContent, datetime: time.dateTime, overflow: document.documentElement.scrollWidth > innerWidth }
      })()`)
      expect(first.text).toContain("openai/gpt-6-sol")
      for (const count of ["1,234", "1,241"]) expect(first.text).toContain(count)
      expect(first.time).toBe(new Date(first.datetime).toISOString().slice(0, 19).replace("T", " ") + " UTC")
      expect(first.overflow).toBe(false)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.incidents [data-incident-row] [data-label="Model"]')].map((item) => item.textContent.trim())`)).toEqual(["openai/gpt-6-sol", "anthropic/claude-opus", "openrouter/deepseek-v4"])
      expect(await text(page, ".incidents__summary")).toBe("Showing 1–3 of 3 groups")
    } finally { await page.close() }
  }
}, 60_000)

test("agent grouping adds the agent to each group and requests the agent report", async () => {
  const page = await open("default")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.incidents [aria-label="Incident grouping"] button')].map((item) => item.textContent + ':' + item.getAttribute('aria-pressed'))`)).toEqual(["Model:true", "Agent:false"])
    await click(page, '.incidents [aria-label="Incident grouping"] button', "Agent")
    await wait(page, `document.querySelector('.incidents [data-incident-row] [data-label="Agent"]')?.textContent.trim() === 'build'`)
    expect((await requests(page, "incident.report")).at(-1)).toEqual({ group: "agent", offset: 0, limit: 25 })
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.incidents [data-incident-row]')].map((row) => row.querySelector('[data-label="Model"]').textContent.trim() + '|' + row.querySelector('[data-label="Agent"]').textContent.trim())`))
      .toEqual(["openai/gpt-6-sol|build", "openai/gpt-6-sol|plan", "anthropic/claude-opus|build"])
    expect(await page.evaluate<string>(`document.querySelector('.incidents [aria-label="Incident grouping"] [aria-pressed="true"]').textContent`)).toBe("Agent")
  } finally { await page.close() }
}, 30_000)

test("time filters bound the report with exact millisecond edges and an empty range says so", async () => {
  const page = await open("default")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(page, '.incidents [aria-label="Incident range"] button', "7 days")
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 2`)
    const week = (await requests(page, "incident.report")).at(-1)!
    expect(Math.abs(Date.now() - 7 * 86_400_000 - (week.from as number))).toBeLessThan(60_000)
    expect(week).toMatchObject({ group: "model", offset: 0, limit: 25 })
    expect(week).not.toHaveProperty("to")
    expect(await text(page, ".incidents__summary")).toBe("Showing 1–2 of 2 groups")
    const today = new Date()
    const to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 60 * 86_400_000
    const from = to - 7 * 86_400_000
    const [fromDay, toDay] = [from, to].map((time) => new Date(time).toISOString().slice(0, 10))
    await click(page, '.incidents [aria-label="Incident range"] button', "Custom UTC")
    await page.evaluate(`(() => { const set = (label, value) => { const input = document.querySelector('[aria-label="' + label + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }; set('Incident from UTC', '${toDay}'); set('Incident to UTC', '${fromDay}'); document.querySelector('.incidents__range-form button[type="submit"]').click() })()`)
    await wait(page, `!!document.querySelector('.incidents__range-form [role="alert"]')`)
    await page.evaluate(`(() => { const set = (label, value) => { const input = document.querySelector('[aria-label="' + label + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }; set('Incident from UTC', '${fromDay}'); set('Incident to UTC', '${toDay}'); document.querySelector('.incidents__range-form button[type="submit"]').click() })()`)
    await wait(page, `document.querySelector('.incidents')?.textContent.includes('No model incidents in this period.')`)
    expect((await requests(page, "incident.report")).at(-1)).toEqual({ group: "model", from, to, offset: 0, limit: 25 })
  } finally { await page.close() }
}, 40_000)

test("paging walks the exact group count 25 at a time and disables the ends", async () => {
  const page = await open("paged")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 25`)
    expect(await text(page, ".incidents__summary")).toBe("Showing 1–25 of 60 groups")
    const buttons = `[...document.querySelectorAll('.incidents__pagination button')].map((item) => item.textContent + ':' + item.disabled)`
    expect(await page.evaluate<string[]>(buttons)).toEqual(["Previous:true", "Next:false"])
    await click(page, ".incidents__pagination button", "Next")
    await wait(page, `document.querySelector('.incidents__summary')?.textContent === 'Showing 26–50 of 60 groups'`)
    await click(page, ".incidents__pagination button", "Next")
    await wait(page, `document.querySelector('.incidents__summary')?.textContent === 'Showing 51–60 of 60 groups'`)
    expect(await rows(page)).toBe(10)
    expect(await page.evaluate<string[]>(buttons)).toEqual(["Previous:false", "Next:true"])
    expect((await requests(page, "incident.report")).map((item) => item.offset)).toEqual([0, 25, 50])
    await click(page, ".incidents__pagination button", "Previous")
    await wait(page, `document.querySelector('.incidents__summary')?.textContent === 'Showing 26–50 of 60 groups'`)
  } finally { await page.close() }
}, 40_000)

test("details load the newest 20 incidents and the exact guidance preview with an enabled indicator", async () => {
  const page = await open("default")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(page, "[data-incident-details]")
    await wait(page, `document.querySelectorAll('.incidents__recent li').length === 20 && !!document.querySelector('.incidents__preview')`)
    expect(await page.evaluate<string>(`document.querySelector('[data-incident-details]').getAttribute('aria-expanded')`)).toBe("true")
    expect(await requests(page, "incident.recent")).toEqual([{ provider: "openai", model: "gpt-6-sol", limit: 20 }])
    expect(await requests(page, "incident.guidance")).toEqual([{ provider: "openai", model: "gpt-6-sol" }])
    expect(await page.evaluate<string>(`document.querySelector('.incidents__preview').textContent`)).toBe(guidanceText)
    expect(await text(page, ".incidents__indicator")).toBe("Guidance enabled")
    const items = await page.evaluate<string[]>(`[...document.querySelectorAll('.incidents__recent li')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim())`)
    expect(items[0]).toContain("Fallback")
    expect(items[0]).toContain("anthropic/claude-opus")
    expect(items[1]).toContain("Guardrail escalated")
    expect(items[1]).toContain("standard.review.git-destructive")
    expect(items[1]).toContain("custom")
    expect(items.some((item) => item.includes("Guardrail rejected") && item.includes("decided by Client"))).toBe(true)
    expect(items.some((item) => item.includes("Decision model"))).toBe(true)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.incidents__recent time')].every((item) => /^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC$/.test(item.textContent))`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("agent detail narrows recent incidents to its agent while guidance stays on the model", async () => {
  const page = await open("default")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(page, '.incidents [aria-label="Incident grouping"] button', "Agent")
    await wait(page, `!!document.querySelector('.incidents [data-label="Agent"]')`)
    await click(page, "[data-incident-details]")
    await wait(page, `document.querySelectorAll('.incidents__recent li').length === 20`)
    expect(await requests(page, "incident.recent")).toEqual([{ provider: "openai", model: "gpt-6-sol", agent: "build", limit: 20 }])
    expect(await requests(page, "incident.guidance")).toEqual([{ provider: "openai", model: "gpt-6-sol" }])
  } finally { await page.close() }
}, 30_000)

test("a disabled capability reads Guidance disabled in words", async () => {
  const page = await open("disabled")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(page, "[data-incident-details]")
    await wait(page, `!!document.querySelector('.incidents__indicator')`)
    expect(await text(page, ".incidents__indicator")).toBe("Guidance disabled")
    expect(await page.evaluate<string>(`document.querySelector('.incidents__indicator').dataset.enabled`)).toBe("false")
  } finally { await page.close() }
}, 30_000)

test("clearing guidance confirms first, clears the whole model, and keeps every incident count", async () => {
  const page = await open("default")
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    const before = await text(page, ".incidents__table tbody")
    await click(page, "[data-incident-details]")
    await wait(page, `!!document.querySelector('[data-incident-clear]') && !document.querySelector('[data-incident-clear]').disabled`)
    await click(page, "[data-incident-clear]")
    await wait(page, `!!document.querySelector('dialog.overlay--confirm[open]')`)
    const dialog = await text(page, "dialog.overlay--confirm")
    expect(dialog).toContain("openai/gpt-6-sol")
    expect(dialog).toContain("every agent and Session")
    expect(dialog).toContain("Incident counts are kept")
    await click(page, "dialog.overlay--confirm button", "Cancel")
    await wait(page, `!document.querySelector('dialog.overlay--confirm')`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('[data-incident-clear]')`)).toBe(true)
    expect(await requests(page, "incident.guidance.clear")).toEqual([])
    await click(page, "[data-incident-clear]")
    await wait(page, `!!document.querySelector('dialog.overlay--confirm[open]')`)
    await click(page, "dialog.overlay--confirm button", "Clear guidance")
    await wait(page, `document.querySelector('.incidents__status')?.textContent.includes('Guidance cleared for openai/gpt-6-sol')`)
    expect(await requests(page, "incident.guidance.clear")).toEqual([{ provider: "openai", model: "gpt-6-sol" }])
    await wait(page, `!document.querySelector('.incidents__preview') && document.querySelector('.incidents__guidance')?.textContent.includes('Cleared 20')`)
    expect(await page.evaluate<boolean>(`document.querySelector('[data-incident-clear]').disabled`)).toBe(true)
    expect(await text(page, ".incidents__table tbody")).toBe(before)
  } finally { await page.close() }
}, 40_000)

test("a failed clear stays in the dialog with its error and can be retried; a pending clear blocks repeats", async () => {
  const failing = await open("clear-error")
  try {
    await wait(failing, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(failing, "[data-incident-details]")
    await wait(failing, `!!document.querySelector('[data-incident-clear]') && !document.querySelector('[data-incident-clear]').disabled`)
    await click(failing, "[data-incident-clear]")
    await wait(failing, `!!document.querySelector('dialog.overlay--confirm[open]')`)
    await click(failing, "dialog.overlay--confirm button", "Clear guidance")
    await wait(failing, `document.querySelector('dialog.overlay--confirm [role="alert"]')?.textContent.includes('Guidance could not be cleared.')`)
    expect(await page_has(failing, "dialog.overlay--confirm[open]")).toBe(true)
    expect(await failing.evaluate<string>(`document.querySelector('.incidents__preview').textContent`)).toBe(guidanceText)
    await click(failing, "dialog.overlay--confirm button", "Clear guidance")
    await wait(failing, `document.querySelector('.incidents__status')?.textContent.includes('Guidance cleared')`)
    expect((await requests(failing, "incident.guidance.clear")).length).toBe(2)
  } finally { await failing.close() }
  const pending = await open("clear-pending")
  try {
    await wait(pending, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(pending, "[data-incident-details]")
    await wait(pending, `!!document.querySelector('[data-incident-clear]') && !document.querySelector('[data-incident-clear]').disabled`)
    await click(pending, "[data-incident-clear]")
    await wait(pending, `!!document.querySelector('dialog.overlay--confirm[open]')`)
    await click(pending, "dialog.overlay--confirm button", "Clear guidance")
    await wait(pending, `[...document.querySelectorAll('dialog.overlay--confirm button')].some((item) => item.textContent.trim() === 'Clearing…' && item.disabled)`)
    expect((await requests(pending, "incident.guidance.clear")).length).toBe(1)
    await pending.evaluate(`window.incidentReleaseClear()`)
    await wait(pending, `document.querySelector('.incidents__status')?.textContent.includes('Guidance cleared')`)
  } finally { await pending.close() }
}, 60_000)

const page_has = (page: Page, selector: string) => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)

test("loading, empty, unsupported, failed, and detail-failure states each speak and recover", async () => {
  const loading = await open("loading")
  try {
    await wait(loading, `!!document.querySelector('.incidents .loading-placeholder')`)
    expect(await rows(loading)).toBe(0)
    await loading.evaluate(`window.incidentRelease()`)
    await wait(loading, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
  } finally { await loading.close() }
  const empty = await open("empty")
  try {
    await wait(empty, `document.querySelector('.incidents')?.textContent.includes('No model incidents in this period.')`)
    expect(await rows(empty)).toBe(0)
  } finally { await empty.close() }
  const old = await open("old")
  try {
    await wait(old, `document.querySelector('.incidents')?.textContent.includes('Update YCoding on this machine to see model incidents.')`)
    expect(await page_has(old, '.incidents [role="alert"]')).toBe(false)
  } finally { await old.close() }
  const failed = await open("error")
  try {
    await wait(failed, `document.querySelector('.incidents [role="alert"]')?.textContent.includes('Incident report could not be loaded.')`)
    await failed.evaluate(`window.incidentRecover()`)
    await click(failed, ".incidents [role=alert] button", "Retry")
    await wait(failed, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
  } finally { await failed.close() }
  const detail = await open("detail-error")
  try {
    await wait(detail, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await click(detail, "[data-incident-details]")
    await wait(detail, `document.querySelectorAll('.incidents__detail [role="alert"]').length === 2`)
    await detail.evaluate(`window.incidentRecover()`)
    await click(detail, ".incidents__detail [role=alert] button", "Retry")
    await wait(detail, `document.querySelectorAll('.incidents__recent li').length === 20`)
  } finally { await detail.close() }
}, 90_000)

test("details and confirmation are keyboard operable with focus returned, and phone targets stay at the hit minimum", async () => {
  const page = await open("default", 390)
  try {
    await wait(page, `document.querySelectorAll('.incidents [data-incident-row]').length === 3`)
    await page.evaluate(`document.querySelector('[data-incident-details]').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('[data-incident-details]').getAttribute('aria-expanded') === 'true' && !!document.querySelector('[data-incident-clear]') && !document.querySelector('[data-incident-clear]').disabled`)
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    await page.evaluate(`document.querySelector('[data-incident-clear]').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!!document.querySelector('dialog.overlay--confirm[open]')`)
    await page.pressEscape()
    await wait(page, `!document.querySelector('dialog.overlay--confirm')`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('[data-incident-clear]')`)).toBe(true)
    const small = await page.evaluate<number>(`[...document.querySelectorAll('.incidents button')].filter((item) => item.getBoundingClientRect().height < 36 - 0.5).length`)
    expect(small).toBe(0)
  } finally { await page.close() }
}, 30_000)
