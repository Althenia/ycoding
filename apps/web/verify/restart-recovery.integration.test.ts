import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4733
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const ready = () => fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)
const card = '.workspace__main .review-box [data-review-item="rvw_recovery"]'
const decisions = (page: Page) => page.evaluate<unknown[]>(`window.remoteMutationReport().filter((entry) => entry.operation === 'session.review.decide').map((entry) => entry.input)`)
const click = (page: Page, selector: string, label: string) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
async function openReview(extra = "", width = 1440, theme: "light" | "dark" = "light") {
  const page = await browser!.openPage()
  await page.setViewport(width, 900)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=recovery${extra}`)
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  await wait(page, `document.querySelector('${card}') !== null`)
  return page
}

test("a pending restart recovery explains its uncertain tools with escaped identifiers and offers only a human Continue or Stop", async () => {
  for (const [width, theme] of [[1440, "light"], [390, "dark"], [320, "light"]] as const) {
    const page = await openReview("", width, theme)
    try {
      expect(await page.evaluate<string>(`document.querySelector('${card} .request__header').textContent.trim()`)).toBe("Restart recovery")
      const text = await page.evaluate<string>(`document.querySelector('${card}').textContent.replace(/\\s+/g, ' ')`)
      expect(text).toContain("The service restarted while this subagent was working")
      expect(text).toContain("may or may not have finished, so their results are unknown")
      expect(text).toContain("The subagent waits for your choice")
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('${card} [data-recovery-tool]')].map((row) => row.textContent)`)).toEqual([
        "shell<b> · call call_<img src=x onerror=window.recoveryEscape=1> · message msg_restart", "edit · call call_2 · message msg_restart",
      ])
      expect(await page.evaluate<boolean>(`document.querySelector('${card} img, ${card} b') === null && window.recoveryEscape === undefined`)).toBe(true)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('${card} .request__actions button')].map((button) => button.textContent.trim())`)).toEqual(["Continue", "Stop"])
      expect(await page.evaluate<boolean>(`document.querySelector('${card} textarea, ${card} input') === null`)).toBe(true)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('${card} button')].some((button) => button.textContent.trim() === 'child · general · Prepare the release')`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('${card} .request__actions button')].every((button) => button.getBoundingClientRect().height >= 28)`)).toBe(true)
      expect(await decisions(page)).toEqual([])
    } finally { await page.close() }
  }
}, 60_000)

for (const choice of ["continue", "stop"] as const) {
  test(`${choice} sends exactly one recovery decision and the item leaves the Review panel`, async () => {
    const page = await openReview()
    try {
      await click(page, `${card} .request__actions button`, choice === "continue" ? "Continue" : "Stop")
      await wait(page, `document.querySelector('${card}') === null`)
      await Bun.sleep(200)
      expect(await decisions(page)).toEqual([{ itemID: "rvw_recovery", decision: { kind: "recovery", choice } }])
    } finally { await page.close() }
  }, 30_000)
}

test("an unconfirmed or refused decision stays visible with its item and is never sent again on its own", async () => {
  for (const [mode, message] of [["unknown", "Outcome unknown"], ["failed", "Decision was not accepted"]] as const) {
    const page = await openReview(`&reviewDecide=${mode}`)
    try {
      await click(page, `${card} .request__actions button`, "Continue")
      await wait(page, `document.querySelector('${card} [role="alert"]')?.textContent?.includes(${JSON.stringify(message)}) === true`)
      await Bun.sleep(300)
      expect(await decisions(page)).toEqual([{ itemID: "rvw_recovery", decision: { kind: "recovery", choice: "continue" } }])
      expect(await page.evaluate<boolean>(`document.querySelector('${card}') !== null`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

const row = (id: string) => `.team-view__task[data-session-id="${id}"]`
const events = (page: Page) => page.evaluate<string[]>(`window.teamEvents()`)
async function openTeam(extra = "") {
  const page = await browser!.openPage()
  await page.setViewport(1440, 900)
  await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&recovery${extra}`)
  await wait(page, `document.querySelector('${row("ses_stopped")}') !== null`)
  return page
}

test("Team shows a stopped recovery as stopped with a human Continue and keeps a deferred question out of the answer form", async () => {
  const page = await openTeam()
  try {
    expect(await page.evaluate<string>(`document.querySelector('${row("ses_stopped")} .team-view__state').textContent.trim()`)).toBe("stopped")
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('${row("ses_stopped")} .team-view__actions button')].map((button) => button.dataset.action)`)).toContain("continue-recovery")
    expect(await page.evaluate<boolean>(`document.querySelector('${row("ses_deferred")} [data-action="answer"]') === null`)).toBe(true)
    expect(await page.evaluate<string>(`document.querySelector('${row("ses_deferred")} [data-deferred-question]').textContent.trim()`)).toBe("This question is waiting in Review.")
    expect(await page.evaluate<boolean>(`document.querySelector('${row("ses_waiting")} [data-action="answer"]') !== null && document.querySelector('${row("ses_waiting")} [data-deferred-question]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]').click()`)
    await wait(page, `document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]') === null`)
    expect(await events(page)).toEqual(["continue:ses_stopped"])
    expect(await page.evaluate<string>(`document.querySelector('${row("ses_stopped")} .team-view__state').textContent.trim()`)).toBe("running")
  } finally { await page.close() }
}, 30_000)

test("Team disables a Continue that is in flight, and reports a refused or unconfirmed one without replaying it", async () => {
  const pending = await openTeam("&continueOutcome=deferred")
  try {
    await pending.evaluate(`document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]').click()`)
    await wait(pending, `document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]')?.disabled === true && document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]').textContent.trim() === 'Continuing…'`)
    await pending.evaluate(`document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]').click()`)
    expect(await events(pending)).toEqual(["continue:ses_stopped"])
    await pending.evaluate(`window.teamReleaseContinue()`)
    await wait(pending, `document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]')?.disabled === false`)
  } finally { await pending.close() }
  for (const [outcome, message] of [["failed", "refused a conflicting request"], ["unknown", "Outcome unknown"]] as const) {
    const page = await openTeam(`&continueOutcome=${outcome}`)
    try {
      await page.evaluate(`document.querySelector('${row("ses_stopped")} [data-action="continue-recovery"]').click()`)
      await wait(page, `document.querySelector('.team-view [role="alert"]')?.textContent.includes(${JSON.stringify(message)}) === true`)
      await Bun.sleep(300)
      expect(await events(page)).toEqual(["continue:ses_stopped"])
      expect(await page.evaluate<string>(`document.querySelector('${row("ses_stopped")} .team-view__state').textContent.trim()`)).toBe("stopped")
    } finally { await page.close() }
  }
}, 60_000)
