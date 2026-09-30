import { afterAll, beforeAll, expect, test } from "bun:test"
import { startRelayDouble } from "../test/relay-double"
import { launchBrowser } from "./cdp"

const port = 4491
const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>
beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${port}/verify/guardrail-family-fixture.html`).then((response) => response.ok).catch(() => false)) break; await Bun.sleep(100) }
  browser = await launchBrowser(chrome, 390, 844)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })
async function wait(page: Awaited<ReturnType<typeof browser.openPage>>, expression: string) {
  for (let i = 0; i < 100; i++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(20) }
  throw new Error(`Guardrail fixture did not settle: ${expression}; ${JSON.stringify(await page.evaluate(`({text:document.body.innerText.slice(0,1000),errors:window.fixtureErrors,state:window.activityStore?{connection:window.activityStore.state().connection,rows:window.activityStore.state().sessions.length,carousel:window.activityStore.state().carouselSessions?.length}:undefined})`))}; ${page.networkFailures().join('; ')}`)
}
const review = { id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_a", action: "shell", resources: ["rm -rf fixture/trash/<img src=x onerror=alert(1)>"], reason: "Deletion requires review", hardReview: true, metadata: { workdir: "/fixture/project" } }

test("missing concrete context disables approval, explains why, and leaves human rejection usable", async () => {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [{ ...review, resources: [], metadata: {} }] })
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/guardrail-family-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}&http=${encodeURIComponent(relay.httpURL)}`)
    await wait(page, `document.querySelector('.request--hard') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('.request__actions button').disabled`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.request').textContent.includes('targets')`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.request__actions button:last-child').disabled`)).toBe(false)
    await page.evaluate(`document.querySelector('.request__actions button:last-child').click()`)
    await wait(page, `document.querySelector('.request') === null`)
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toMatchObject([{ input: { reply: "reject" } }])
  } finally { await page.close(); await relay.stop() }
})

for (const reply of ["once", "reject"] as const) test(`family hard review renders inspectable escaped targets and accepts explicit human ${reply}`, async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [review], handler: async (request) => { if (request.operation === "session.guardrail.reply") await held; return "default" as const } })
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/guardrail-family-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}&http=${encodeURIComponent(relay.httpURL)}`)
    await wait(page, `document.querySelector('.request--hard') !== null`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.request__actions button')].map((button)=>button.textContent.trim())`)).toEqual(["Approve once", "Reject"])
    expect(await page.evaluate<boolean>(`document.querySelector('.request').textContent.includes('ses_child') && document.querySelector('.request').textContent.includes(${JSON.stringify(review.resources[0])}) && document.querySelector('.request').textContent.includes('/fixture/project') && document.querySelector('.request img') === null`)).toBe(true)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.request__actions button')].every((button)=>!button.disabled)`)).toBe(true)
    await page.evaluate(`document.querySelector('.request details').open = true`)
    expect(await page.evaluate<boolean>(`document.querySelector('.request pre').getBoundingClientRect().height > 0 && document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
    expect(await page.evaluate<number>(`(() => { const pre=document.querySelector('.request pre'); const text=pre.querySelector('code') ?? pre; const color=(value)=>value.match(/[0-9.]+/g).slice(0,3).map(Number).map((channel)=>{ const c=channel/255; return c<=.04045?c/12.92:((c+.055)/1.055)**2.4; }); const luminance=(value)=>{const c=color(value); return .2126*c[0]+.7152*c[1]+.0722*c[2]; }; const foreground=luminance(getComputedStyle(text).color); const background=luminance(getComputedStyle(text).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(pre).backgroundColor : getComputedStyle(text).backgroundColor); return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05); })()`)).toBeGreaterThanOrEqual(4.5)
    if (reply === "once") await Bun.write(new URL("../../../.cache/tmp/web-guardrail-family-390.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelectorAll('.request__actions button')[${reply === "once" ? 0 : 1}].click()`)
    await wait(page, `document.querySelector('.request__actions button').disabled`)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.request__actions button')].every((button)=>button.disabled)`)).toBe(true)
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toMatchObject([{ sessionID: "ses_a", input: { requestID: review.id, reply } }])
    release?.()
    await wait(page, `document.querySelector('.request') === null`)
  } finally { release?.(); await page.close(); await relay.stop() }
})

test("floating jump controls do not cover phone review buttons at the collision boundary", async () => {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [review], messages: { ses_a: Array.from({ length: 30 }, (_, index) => ({ id: `msg_${index}`, type: "user", text: `Earlier prompt ${index}`, time: { created: index } })) } })
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/guardrail-family-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}&http=${encodeURIComponent(relay.httpURL)}`)
    await wait(page, `document.querySelector('.request__actions') !== null && document.querySelector('.transcript-navigation__controls') !== null`)
    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel')); const button=document.querySelector('.request__actions button:last-child'); root.scrollTop += button.getBoundingClientRect().bottom - (root.getBoundingClientRect().bottom - 12); root.dispatchEvent(new Event('scroll')); })()`)
    await Bun.sleep(300)
    expect(await page.evaluate<boolean>(`(() => { const controls=document.querySelector('.transcript-navigation__controls'); if (getComputedStyle(controls).visibility === 'hidden') return true; const c=controls.getBoundingClientRect(); return [...document.querySelectorAll('.request__actions button')].every((button)=>{const b=button.getBoundingClientRect(); return c.bottom <= b.top || c.top >= b.bottom || c.right <= b.left || c.left >= b.right; }); })()`)).toBe(true)
    expect(await page.evaluate<boolean>(`(() => { const button=document.querySelector('.request__actions button:last-child'); const b=button.getBoundingClientRect(); return document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2) === button; })()`)).toBe(true)
  } finally { await page.close(); await relay.stop() }
})

for (const width of [390, 1280]) test(`Session activity order and background-shell Team state render honestly at ${width}px`, async () => {
  const workspace = { id: "wsp_fixture", projectID: "prj_fixture", directory: "/fixture/project", name: "Fixture" }
  const rows = [
    { id: "ses_pinned", title: "Pinned old", time: { created: 1, updated: 900, active: 1, pinned: 1 } },
    { id: "ses_edited", title: "Metadata edit", time: { created: 1, updated: 1000, active: 2 } },
    { id: "ses_recent", title: "Recently active", time: { created: 1, updated: 500, active: 500 } },
    { id: "ses_running", title: "Background shell", time: { created: 1, updated: 1, active: 0 } },
    { id: "ses_missing", title: "Activity unreported", time: { created: 1, updated: 200 } },
  ].map((row) => ({ ...row, projectID: workspace.projectID, location: { directory: workspace.directory } }))
  let exited = false
  let truncated = false
  let holdShells = true
  const shellPage = Promise.withResolvers<{ readonly ok: true; readonly value: { readonly data: readonly { readonly id: string; readonly ownerID: string; readonly command: string; readonly status: "running"; readonly startedAt: number }[] } }>()
  const relay = await startRelayDouble({ advertisedSessions: rows.map((row) => row.id), handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention: [] } }
    if (request.operation === "session.list") return { ok: true, value: { data: request.input?.status === "running" ? rows.filter((row) => row.id === "ses_running") : request.input?.status === "idle" ? rows.filter((row) => row.id !== "ses_running") : rows } }
    if (request.operation === "session.get") return { ok: true, value: { data: rows.find((row) => row.id === request.sessionID) } }
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: [], summary: { total: 0, active: 0 }, cursor: {} } }
    if (request.operation === "session.team.shell.list") return holdShells ? shellPage.promise : { ok: true, value: { truncated, data: [{ id: "sh_fixture", ownerID: "ses_running", command: "fixture", status: exited ? "exited" : "running", startedAt: 1 }] } }
    return "default"
  } })
  const page = await browser.openPage()
  try {
    await page.setViewport(width, 844); await page.setCoarsePointer(width === 390)
    await page.injectOnNewDocument(`window.fixtureErrors=[]; window.addEventListener('error',(event)=>window.fixtureErrors.push(event.message)); window.addEventListener('unhandledrejection',(event)=>window.fixtureErrors.push(String(event.reason?.stack ?? event.reason)))`)
    await page.navigate(`http://127.0.0.1:${port}/verify/activity-order-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}`)
    await wait(page, `document.querySelectorAll('.sessions-results .sessions-table__row').length === 5 && document.querySelectorAll('.running-sessions__item').length === 5`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.sessions-results .sessions-table__row')].map((row)=>row.querySelector('button').textContent.trim())`)).toEqual(["Background shell", "Recently active", "Activity unreported", "Metadata edit", "Pinned old"])
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.running-sessions__title')].map((row)=>row.textContent)`)).toEqual(["Background shell", "Recently active", "Activity unreported", "Metadata edit", "Pinned old"])
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.running-sessions__item')].find((row)=>row.textContent.includes('Activity unreported')).textContent.includes('Last active not reported')`)).toBe(true)
    await page.evaluate(`window.activityOpen('ses_running')`)
    await wait(page, `document.querySelector('[aria-label="Open Team"]')?.getAttribute('aria-description') === 'Activity unreported'`)
    expect(await page.evaluate<string>(`document.querySelector('.app-header__team-count').textContent`)).toBe("—")
    holdShells = false; shellPage.resolve({ ok: true, value: { data: [{ id: "sh_fixture", ownerID: "ses_running", command: "fixture", status: "running", startedAt: 1 }] } })
    await wait(page, `document.querySelector('[aria-label="Open Team"]')?.getAttribute('aria-description') === '1 active'`)
    expect(await page.evaluate<unknown>(`({status:window.activityStore.state().view.status,started:window.activityStore.state().view.executionStarted ?? null})`)).toEqual({ status: "running", started: null })
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    await wait(page, `document.querySelector('.team-view__heading')?.textContent.includes('1 active')`)
    expect(await page.evaluate<string>(`document.querySelector('[data-tab="subagents"] .team-view__count').textContent`)).toBe("0")
    expect(await page.evaluate<string>(`document.querySelector('[data-tab="shell"] .team-view__count').textContent`)).toBe("1")
    truncated = true
    relay.pushEvent("ses_running", { type: "session.execution.succeeded", created: 700, data: {} })
    await wait(page, `document.querySelector('[aria-label="Open Team"]')?.getAttribute('aria-description') === 'At least 1 active'`)
    expect(await page.evaluate<string>(`document.querySelector('.app-header__team-count').textContent`)).toBe("≥1")
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__heading').textContent.includes('At least 1 active')`)).toBe(true)
    if (width === 390) await Bun.write(new URL("../../../.cache/tmp/web-background-shell-team-390.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    truncated = false
    exited = true; relay.pushStatus([], [])
    await wait(page, `document.querySelector('[aria-label="Open Team"]')?.getAttribute('aria-description') === '0 active'`)
    expect(await page.evaluate<string>(`window.activityStore.state().view.status`)).toBe("idle")
    expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  } finally { shellPage.resolve({ ok: true, value: { data: [] } }); await page.close(); await relay.stop() }
})
