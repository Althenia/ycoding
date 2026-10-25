import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4533
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const box = ".workspace__main .review-box"
const item = (id: string) => `${box} [data-review-item="${id}"]`
const buttons = (page: Page, id: string) => page.evaluate<string[]>(`[...document.querySelectorAll('${item(id)} .request__actions button')].map(button => button.textContent.trim())`)
const decisions = (page: Page) => page.evaluate<unknown[]>(`window.remoteMutationReport().filter(entry => entry.operation === 'session.review.decide').map(entry => entry.input)`)
const click = (page: Page, selector: string, label: string) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`)

test("the review box lists every deferred kind below live requests and sends one human decision per control", async () => {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await wait(page, `document.querySelectorAll('${box} [data-review-item]').length === 5`)
      expect(await page.evaluate<string>(`document.querySelector('${box} .review-box__title')?.textContent`)).toBe("Review · 5 waiting")
      expect(await page.evaluate<boolean>(`(() => { const live = [...document.querySelectorAll('.workspace__main #pending-requests .request')].at(-1), review = document.querySelector('${box}'); return !live || live.getBoundingClientRect().bottom <= review.getBoundingClientRect().top + 1 })()`)).toBe(true)
      expect(await page.evaluate<string | null>(`document.querySelector('.workspace__main .session-status__mode[data-mode="review"]')?.title ?? null`)).toBe("review 5")
      if (width >= 768) expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.session-row--active .chip')].map(chip => chip.textContent)`)).toContain("review 5")
      expect(await buttons(page, "rvw_hard")).toEqual(["Approve once", "Reject"])
      expect(await page.evaluate<boolean>(`document.querySelector('${item("rvw_hard")}').classList.contains('request--hard')`)).toBe(true)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('${item("rvw_hard")}')).borderTopColor`)).not.toBe(await page.evaluate<string>(`getComputedStyle(document.querySelector('${item("rvw_permission")}')).borderTopColor`))
      expect(await buttons(page, "rvw_outside")).toEqual(["Approve once", "Always", "Reject"])
      expect(await buttons(page, "rvw_permission")).toEqual(["Approve once", "Always this session", "Reject"])
      expect(await buttons(page, "rvw_question")).toEqual(["Submit", "Dismiss"])
      expect(await buttons(page, "rvw_child")).toEqual(["Submit", "Dismiss"])
      const child = await page.evaluate<string>(`document.querySelector('${item("rvw_child")}').textContent`)
      expect(child).toContain("child · general · Prepare the release")
      expect(child).toContain("The decision model was not confident · model choice main · confidence 0.4237")
      expect(await page.evaluate<string>(`document.querySelector('${item("rvw_hard")}').textContent`)).toContain("rm -rf <build>")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('${box} button')].every(button => button.getBoundingClientRect().right <= innerWidth)`)).toBe(true)
      if (width === 390) expect(await page.evaluate<boolean>(`[...document.querySelectorAll('${box} .request__actions button')].every(button => button.getBoundingClientRect().height >= 43.5)`)).toBe(true)
      await page.screenshot().then((image) => Bun.write(new URL(`../../../.cache/tmp/review-box-${width}-${theme}.png`, import.meta.url), Buffer.from(image, "base64")))

      await click(page, `${item("rvw_hard")} button`, "Reject")
      await wait(page, `document.querySelector('${item("rvw_hard")}') === null`)
      await page.evaluate(`document.querySelector('${item("rvw_question")} input[type="radio"]')?.click()`)
      await click(page, `${item("rvw_question")} button`, "Submit")
      await wait(page, `document.querySelector('${item("rvw_question")}') === null`)
      await page.evaluate(`(() => { const field = document.querySelector('${item("rvw_child")} textarea'); field.value = 'Use Fixed'; field.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
      await click(page, `${item("rvw_child")} button`, "Submit")
      await wait(page, `document.querySelector('${item("rvw_child")}') === null`)
      await click(page, `${item("rvw_outside")} button`, "Always")
      await wait(page, `document.querySelector('${item("rvw_outside")}') === null`)
      expect(await page.evaluate<string>(`document.querySelector('${box} .review-box__title')?.textContent`)).toBe("Review · 1 waiting")
      await click(page, `${item("rvw_permission")} button`, "Approve once")
      await wait(page, `document.querySelector('${box}') === null`)
      expect(await decisions(page)).toEqual([
        { itemID: "rvw_hard", decision: { kind: "guardrail", reply: "reject" } },
        { itemID: "rvw_question", decision: { kind: "question", answers: { q0: "main" } } },
        { itemID: "rvw_child", decision: { kind: "subagent_question", text: "Use Fixed" } },
        { itemID: "rvw_outside", decision: { kind: "guardrail", reply: "always" } },
        { itemID: "rvw_permission", decision: { kind: "permission", reply: "once" } },
      ])
      expect(await page.evaluate<boolean>(`window.remoteMutationReport().every(entry => entry.operation !== 'session.prompt' && entry.operation !== 'session.autonomy.set')`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__main .session-status__mode[data-mode="review"]') === null`)).toBe(true)
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.session-row--active .chip')].map(chip => chip.textContent)`)).not.toContain("review 1")
    } finally { await page.close() }
  }
}, 120_000)

test("an uncertain decision stays visible with its item and is never sent again on its own", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&reviewDecide=unknown`)
    await wait(page, `document.querySelector('${item("rvw_permission")}') !== null`)
    await click(page, `${item("rvw_permission")} button`, "Reject")
    await wait(page, `document.querySelector('${item("rvw_permission")} [role="alert"]')?.textContent?.includes('Outcome unknown') === true`)
    await Bun.sleep(300)
    expect(await decisions(page)).toEqual([{ itemID: "rvw_permission", decision: { kind: "permission", reply: "reject" } }])
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('${item("rvw_permission")} .request__actions button')].every(button => !button.disabled)`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("deferred requests with automatic decisions disabled show their reason without implying a model decided", async () => {
  for (const width of [1440, 390]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=disabled`)
      await wait(page, `document.querySelectorAll('${box} [data-review-item]').length === 3`)
      for (const id of ["rvw_off_question", "rvw_off_child", "rvw_off_guardrail"]) {
        const note = await page.evaluate<string>(`document.querySelector('${item(id)}').textContent.replace(/\\s+/g, ' ')`)
        expect(note, id).toContain("Automatic decisions are disabled")
        expect(note, id).not.toMatch(/decision model|model choice|confidence|escalated/i)
      }
      expect(await buttons(page, "rvw_off_guardrail")).toEqual(["Approve once", "Always", "Reject"])
      expect(await page.evaluate<boolean>(`document.querySelector('${item("rvw_off_question")} .field, ${item("rvw_off_question")} input, ${item("rvw_off_question")} textarea') !== null && document.querySelector('${item("rvw_off_child")} textarea') !== null`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    } finally { await page.close() }
  }
}, 60_000)

test("the attribution jumps to the Session that owns the item", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1`)
    await wait(page, `document.querySelector('${item("rvw_child")}') !== null`)
    await click(page, `${item("rvw_child")} .request__note button`, "child · general · Prepare the release")
    await wait(page, `location.search.includes('ses_child')`)
  } finally { await page.close() }
}, 30_000)

test("a failed review list is visible and Retry loads the open items", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&reviewList=error`)
    await wait(page, `document.querySelector('${box} [role="alert"]')?.textContent?.includes('could not be loaded') === true`)
    expect(await decisions(page)).toEqual([])
    await click(page, `${box} button`, "Retry")
    await wait(page, `document.querySelectorAll('${box} [data-review-item]').length === 5`)
    expect(await page.evaluate<boolean>(`document.querySelector('${box} > [role="alert"]') === null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("a failed decision keeps the form input and the item visible without automatic replay", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&reviewDecide=failed`)
    await wait(page, `document.querySelector('${item("rvw_child")} textarea') !== null`)
    await page.evaluate(`(() => { const field = document.querySelector('${item("rvw_child")} textarea'); field.value = 'Keep this answer'; field.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
    await click(page, `${item("rvw_child")} button`, "Submit")
    await wait(page, `document.querySelector('${item("rvw_child")} [role="alert"]')?.textContent?.includes('Decision was not accepted') === true`)
    expect(await page.evaluate<string>(`document.querySelector('${item("rvw_child")} textarea').value`)).toBe("Keep this answer")
    expect(await decisions(page)).toHaveLength(1)
  } finally { await page.close() }
}, 30_000)

test("keep-awake chrome renders on, off, sleep-held, lid-held, error, and unsupported on phone and desktop", async () => {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      for (const [params, label, tone] of [
        ["", undefined, undefined],
        ["&keepAwake=on", "keep-awake on · lid held", "success"],
        ["&asleep=1&lid=held", "keep-awake on · lid held · sleep held", "success"],
        ["&keepAwake=error", "keep-awake error", "danger"],
        ["&keepAwake=unsupported", "keep-awake unsupported", "attention"],
      ] as const) {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none${params}`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        await wait(page, `(window.remoteOperationReport?.().operations['machine.keepAwake.get'] ?? 0) >= 1`)
        const selector = ".workspace__topbar .keep-awake-indicator"
        if (!label) { expect(await page.evaluate<boolean>(`document.querySelector('${selector}') === null`)).toBe(true); continue }
        await wait(page, `document.querySelector('${selector}')?.textContent === ${JSON.stringify(label)}`)
        expect(await page.evaluate<string>(`document.querySelector('${selector}').dataset.tone`)).toBe(tone)
        expect(await page.evaluate<boolean>(`(() => { const element = document.querySelector('${selector}'); const box = element.getBoundingClientRect(); return box.width > 0 && box.right <= innerWidth && box.left >= 0 && document.documentElement.scrollWidth <= innerWidth })()`)).toBe(true)
        if (params.includes("asleep")) await Bun.write(new URL(`../../../.cache/tmp/keep-awake-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      }
    } finally { await page.close() }
  }
}, 120_000)

test("keep-awake chrome updates after palette, Settings, and another client's toggle without reloading", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none`)
    await wait(page, `document.querySelector('.workspace__topbar') !== null`)
    await page.evaluate(`window.keepAwakePageIdentity = document.querySelector('.app')`)
    await page.evaluate(`document.querySelector('button[aria-label="Open command palette"]')?.click()`)
    await wait(page, `document.querySelector('dialog[aria-label="Command palette"][open]') !== null`)
    await page.evaluate(`(() => { const input = document.querySelector('dialog[aria-label="Command palette"] input'); input.value = 'keep'; input.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
    await wait(page, `document.getElementById('command-palette-option-machine.keepAwake') !== null`)
    await page.evaluate(`document.getElementById('command-palette-option-machine.keepAwake').click()`)
    await wait(page, `document.querySelector('.keep-awake-indicator')?.textContent === 'keep-awake on · lid held'`)
    await page.evaluate(`document.querySelector('a[href*="/remote/settings"]')?.click()`)
    await wait(page, `document.querySelector('input[aria-labelledby="machine-awake-label"]') !== null`)
    await page.evaluate(`document.querySelector('input[aria-labelledby="machine-awake-label"]').click()`)
    await wait(page, `window.remoteMutationReport().filter(entry => entry.operation === 'machine.keepAwake.set').length === 2`)
    await page.evaluate(`history.back()`)
    await wait(page, `document.querySelector('.workspace__topbar') !== null && document.querySelector('.keep-awake-indicator') === null`)
    await page.evaluate(`window.remoteSetKeepAwake({ state: 'on', manual: true, lid: 'held' })`)
    await wait(page, `document.querySelector('.keep-awake-indicator')?.textContent === 'keep-awake on · lid held'`)
    expect(await page.evaluate<boolean>(`window.keepAwakePageIdentity === document.querySelector('.app')`)).toBe(true)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(entry => entry.operation === 'machine.keepAwake.set').length`)).toBe(2)
  } finally { await page.close() }
}, 30_000)

test("review controls disable throughout a pending decision and ignore a duplicate click", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&latency=500`)
    await wait(page, `document.querySelector('${item("rvw_permission")}') !== null`)
    await click(page, `${item("rvw_permission")} button`, "Approve once")
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('${item("rvw_permission")} .request__actions button')].every(button => button.disabled)`)).toBe(true)
    await click(page, `${item("rvw_permission")} button`, "Approve once")
    await wait(page, `document.querySelector('${item("rvw_permission")}') === null`)
    expect(await decisions(page)).toEqual([{ itemID: "rvw_permission", decision: { kind: "permission", reply: "once" } }])
  } finally { await page.close() }
}, 30_000)

test("an idle Session with family review items displays waiting for your review", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1`)
    await wait(page, `document.querySelectorAll('${box} [data-review-item]').length === 5`)
    await page.evaluate(`window.responseSnapshot([], [], false)`)
    await wait(page, `document.querySelector('.workspace__main .session-status__label')?.textContent === 'waiting for your review'`)
    expect(await page.evaluate<boolean>(`document.querySelector('.workspace__main .session-status__slot').classList.contains('session-status__slot--empty')`)).toBe(false)
  } finally { await page.close() }
}, 30_000)

async function wait(page: Page, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
const scrollTranscript = (page: Page, edge: "start" | "end") => page.evaluate(`(() => { const scroller = document.querySelector('.workspace__scroll'); scroller.scrollTop = ${edge === "start" ? "0" : "scroller.scrollHeight"} })()`)

test("permission display uses readable escaped names and current-Session patterns without changing reply identity", async () => {
  for (const mode of ["saved", "no-save", "human"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setCoarsePointer(width === 390)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&permissionDisplay=${mode}`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await wait(page, `document.querySelector('${item("rvw_permission")}') !== null && document.querySelector('#pending-requests .request--permission') !== null`)
      const live = "#pending-requests .request--permission"
      const liveText = await page.evaluate<string>(`document.querySelector('${live}').textContent`)
      const deferredText = await page.evaluate<string>(`document.querySelector('${item("rvw_permission")}').textContent`)
      expect(liveText).toContain("ChatGPT · Work Calendar\\u202e\\u000a · List Events")
      expect(deferredText).toContain("ChatGPT · List Events")
      for (const text of [liveText, deferredText]) {
        expect(text).toContain("connector-42")
        expect(text).not.toContain("012345abcdef")
        expect(text).not.toContain("\u202e")
        expect(text.includes("Always this session")).toBe(mode === "saved")
        if (mode === "saved") expect(text).toContain("for these resource patterns in this Session: connector-42")
      }
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
      await click(page, `${live} button`, mode === "saved" ? "Always this session" : "Approve once")
      await wait(page, `window.remoteMutationReport().some(entry => entry.operation === 'session.permission.reply')`)
      expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(entry => entry.operation === 'session.permission.reply').input`)).toEqual({ requestID: "per_fixture", reply: mode === "saved" ? "always" : "once" })
      await click(page, `${item("rvw_permission")} button`, mode === "saved" ? "Always this session" : "Approve once")
      await wait(page, `document.querySelector('${item("rvw_permission")}') === null`)
      expect(await decisions(page)).toEqual([{ itemID: "rvw_permission", decision: { kind: "permission", reply: mode === "saved" ? "always" : "once" } }])
    } finally { await page.close() }
  }
}, 60_000)
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }

test("guardrail rows, review items, and decision tools show every grade with literal evidence in both themes and sizes", async () => {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setCoarsePointer(width === 390)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&goal=none&review=1&grades=1`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
      await scrollTranscript(page, "start")
      await wait(page, `document.querySelectorAll('.guardrail-decisions [data-guardrail-request]').length === 2`)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.guardrail-decisions details')].every(row => !row.open)`)).toBe(true)
      const row = '[data-guardrail-request="grq_graded"]'
      await page.evaluate(`document.querySelector('${row} details').open = true`)
      const labels = () => page.evaluate<string[]>(`[...document.querySelectorAll('${row} .decision-grades__choice')].map(label => label.textContent)`)
      expect(await labels()).toEqual(["Approve all", "Approve", "Reject", "Escalate"])
      expect(await page.evaluate<string>(`document.querySelector('${row} [data-selected="true"]').textContent`)).toContain("0.934567")
      expect(await page.evaluate<string>(`document.querySelector('${row} [data-selected="true"]').textContent`)).toContain("Selected")
      expect(await page.evaluate<string>(`document.querySelector('${row} .decision-grades').textContent`)).toContain("<img src=x onerror=alert(1)>")
      expect(await page.evaluate<number>(`document.querySelectorAll('.decision-grades img, .decision-grades script').length`)).toBe(0)
      await page.evaluate(`document.querySelector('[data-guardrail-request="grq_legacy"] details').open = true`)
      expect(await page.evaluate<string>(`document.querySelector('[data-guardrail-request="grq_legacy"]').textContent`)).toContain("model choice reject · confidence 0.71")
      await scrollTranscript(page, "end")
      await wait(page, `document.querySelector('${item("rvw_hard")}') !== null && [...document.querySelectorAll('.transcript-tool__name')].some(name => name.textContent.includes('decision'))`)
      expect(await page.evaluate<string>(`document.querySelector('${item("rvw_hard")} .decision-grades [data-selected="true"]').textContent`)).toContain("Escalate")
      expect(await page.evaluate<number>(`document.querySelectorAll('${item("rvw_hard")} .decision-grades li').length`)).toBe(4)
      await page.evaluate(`(() => { const block = [...document.querySelectorAll('.transcript-tool')].find(block => block.querySelector('.transcript-tool__name').textContent.includes('decision')); window.gradedTool = block; block.querySelector('button').click() })()`)
      await wait(page, `window.gradedTool.querySelectorAll('.decision-grades li').length === 4`)
      expect(await page.evaluate<number>(`window.gradedTool.querySelectorAll('[data-selected="true"]').length`)).toBe(0)
      expect(await page.evaluate<string>(`window.gradedTool.textContent`)).toContain("The helper completed its judgments.")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.decision-grades')].every(element => element.scrollWidth <= element.clientWidth)`)).toBe(true)
      expect(await decisions(page)).toEqual([])
      await page.evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
      await scrollTranscript(page, "start")
      await wait(page, `document.querySelector('${row}') !== null`)
      await page.evaluate(`document.querySelector('${row}').scrollIntoView({ block: 'start' })`)
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await Bun.write(new URL(`../../../.cache/tmp/guardrail-grades-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    } finally { await page.close() }
  }
}, 120_000)
