import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4753
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 100 && !(await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((result) => result.ok, () => false)); index++) await Bun.sleep(100)
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(40) }
  throw new Error(`Project escalation did not settle: ${expression}`)
}
const chainOf = (page: Page, selector: string) => page.evaluate<string[]>(`[...document.querySelectorAll('${selector} [data-project-escalation-session]')].map(line => line.textContent)`)
const expected = ["ses_driver_fixture: The driver has no authority to approve this.", "Stream remote output safely: The Master cannot grant access outside the assigned worktree."]

test("pending permission, guardrail and question requests show the whole Project chain in order, apart from any model escalation", async () => {
  for (const width of [1440, 390]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&projectEscalation=1&grades=1`)
      await wait(page, `document.querySelectorAll('#pending-requests .request [data-project-escalation]').length === document.querySelectorAll('#pending-requests .request').length && document.querySelectorAll('#pending-requests .request').length >= 3`)
      for (const kind of ["permission", "guardrail", "form"]) {
        expect(await chainOf(page, `#pending-requests .request--${kind}`)).toEqual(expected)
        expect(await page.evaluate<string>(`document.querySelector('#pending-requests .request--${kind} [data-project-escalation] [role=status]').textContent`)).toContain("Project escalation")
      }
      expect(await page.evaluate<string>(`document.querySelector('#pending-requests .request--guardrail').textContent`)).toContain("Decision model escalated")
      expect(await page.evaluate<string>(`document.querySelector('#pending-requests .request--permission [data-project-escalation]').textContent`)).not.toContain("Decision model")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("requests without a Project chain show no Project escalation", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none`)
    await wait(page, `document.querySelectorAll('#pending-requests .request').length >= 3`)
    expect(await page.evaluate<number>(`document.querySelectorAll('[data-project-escalation]').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("the review box shows the chain on permission, guardrail and form items and none on a subagent question", async () => {
  for (const width of [1440, 390]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&projectEscalation=1`)
      await wait(page, `document.querySelectorAll('.workspace__main .review-box [data-review-item]').length === 5`)
      for (const id of ["rvw_hard", "rvw_outside", "rvw_permission", "rvw_question"]) expect(await chainOf(page, `.review-box [data-review-item="${id}"]`)).toEqual(expected)
      expect(await chainOf(page, `.review-box [data-review-item="rvw_child"]`)).toEqual([])
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("an escalated Project notification in the Master chat names the member, the escalating Session and the reason", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-1440&projectEscalation=1`)
    await wait(page, `!!document.querySelector('.project-card')`)
    await page.evaluate(`[...document.querySelectorAll('button')].find(e => e.getAttribute('aria-label') === 'Open project Release train').click()`)
    await wait(page, `!!document.querySelector('.project-event[data-event="escalated"]')`)
    const text = await page.evaluate<string>(`document.querySelector('.project-event[data-event="escalated"]').textContent`)
    expect(text).toContain("Update checkout API")
    expect(text).toContain("escalated by Migration agent")
    expect(text).toContain("Needs production credentials.")
    expect(await page.evaluate<number>(`document.querySelectorAll('.project-event').length`)).toBe(3)
  } finally { await page.close() }
}, 30_000)
