import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ViteDevServer } from "vite"
import { Server } from "node:http"
import { launchBrowser } from "./cdp"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chrome executable.")
let server: ViteDevServer
let listener: Server
let browser: Awaited<ReturnType<typeof launchBrowser>>
let origin: string
beforeAll(async () => {
  process.env.YCODING_WEB_VERIFY = "1"
  const { createServer } = await import("vite")
  server = await createServer({ root: import.meta.dir.replace(/\/verify$/, ""), cacheDir: new URL("../../../.cache/tmp/web-reading/vite-questions", import.meta.url).pathname, server: { middlewareMode: true, hmr: false, ws: false } })
  listener = new Server(server.middlewares)
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve) })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing ephemeral Vite address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); await server?.close(); if (listener) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())) })
type Page = Awaited<ReturnType<typeof launchBrowser>> extends { openPage(): Promise<infer P> } ? P : never
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await page.evaluate<boolean>(expression)) return
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`)
  }
  throw new Error(`Rendered condition did not settle: ${expression}`)
}
const history = [
  { id: "msg_history", type: "assistant", content: [
    { type: "tool", id: "call_question", name: "question", state: { status: "completed", input: { questions: [
      { header: "Scope", question: "Which tests should I run?", options: [{ label: "Focused tests", description: "Only affected behavior" }] },
      { header: "Notes", question: "What should I preserve?", options: [] },
    ] }, structured: { answers: [["Focused tests"], ["Keep existing behavior"]] }, content: [] } },
    { type: "tool", id: "call_parent_question", name: "subagent_report", state: { status: "completed", input: { action: "question", text: "May I update the scoped tests?" }, structured: { action: "question", question: { id: "qst_history", text: "May I update the scoped tests?", time: 1 } }, content: [] } },
  ], time: { created: 1, completed: 2 } },
  { id: "msg_parent_answer", type: "synthetic", text: 'Parent answer:\n{"questionID":"qst_history","text":"Yes, keep the scope narrow.","data":{"checks":"focused"}}', description: "Parent subagent answer", metadata: { source: "subagent_parent", parentID: "ses_parent", childID: "ses_fixture", kind: "answer", questionID: "qst_history" }, time: { created: 3 } },
]

test("completed question tools and durable parent answers stay readable without opening raw output", async () => {
  const page = await browser.openPage()
  try {
    for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
      await page.setViewport(width, 900)
      await page.navigate(`${origin}/verify/remote.html?view=chat&team=two&responseProbe=1&theme=${theme}`)
      await wait(page, `!!window.responseSnapshot && !!document.querySelector('.conversation-breadcrumb')`)
      await page.evaluate(`window.responseSnapshot(${JSON.stringify(history)}, [], false)`)
      await wait(page, `!!document.querySelector('[data-message-id="msg_history"]')`)
      await wait(page, `!document.querySelector('.workspace__scroll > .route-panel--exiting')`)
      expect(await page.evaluate<boolean>(`(() => {const panel=document.querySelector('.new-session-composer')?.closest('.route-panel'); return !panel || panel.getClientRects().length===0})()`)).toBe(true)
      await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden'; document.querySelector('[aria-label="Jump to top"]')?.click(); })()`)
      await wait(page, `(() => {const root=document.querySelector('.workspace__scroll'); return root.scrollTop<=1})()`)
      const text = await page.evaluate<string>(`document.querySelector('.conversation-pane').innerText`)
      expect(text).toContain("Which tests should I run?")
      expect(text).toContain("Focused tests")
      expect(text).toContain("What should I preserve?")
      expect(text).toContain("Keep existing behavior")
      expect(text).toContain("May I update the scoped tests?")
      expect(text).toContain("Yes, keep the scope narrow.")
      expect(text).toContain('"checks": "focused"')
      expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-tool__toggle[aria-expanded="true"]').length`)).toBe(0)
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`)).toBe(false)
      await Bun.write(new URL(`../../../.cache/tmp/web-reading/questions-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    }
  } finally { await page.close() }
}, 60_000)

test("parent Conversation answers its pending child question through the same owned operation as Team exactly once", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`${origin}/verify/remote.html?view=chat&team=two&childQuestion=1&childAnswerGate=1`)
    await wait(page, `!!document.querySelector('.conversation-breadcrumb')`)
    expect(await page.evaluate<boolean>(`!!document.querySelector('.conversation-pane [data-child-question="qst_fixture"]')`)).toBe(true)
    await page.evaluate(`(() => {const form=document.querySelector('[data-child-question="qst_fixture"] form'), field=form.querySelector('textarea'); field.value='Yes, run focused tests'; field.dispatchEvent(new Event('input',{bubbles:true})); form.requestSubmit(); form.requestSubmit(); })()`)
    await wait(page, `window.requestLog.filter(row=>row.operation==='session.subagent.answer').length===1`)
    await Bun.write(new URL("../../../.cache/tmp/web-reading/child-question-sending.png", import.meta.url), Buffer.from(await page.screenshot(), "base64"))
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    await wait(page, `!!document.querySelector('.team-view [data-action="answer"]')`)
    await page.evaluate(`document.querySelector('.team-view [data-action="answer"]').click()`)
    await wait(page, `!!document.querySelector('.team-view .team-answer textarea')`)
    await page.evaluate(`(() => {const form=document.querySelector('.team-view .team-answer'), field=form.querySelector('textarea'); field.value='A duplicate answer'; field.dispatchEvent(new Event('input',{bubbles:true})); form.requestSubmit(); })()`)
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    expect(await page.evaluate<number>(`window.requestLog.filter(row=>row.operation==='session.subagent.answer').length`)).toBe(1)
    await page.evaluate(`window.remoteReleaseChildAnswer()`)
    await wait(page, `!document.querySelector('[data-child-question="qst_fixture"]')`)
    expect(await page.evaluate<unknown>(`window.requestLog.find(row=>row.operation==='session.subagent.answer').input`)).toEqual({ childID: "ses_child", questionID: "qst_fixture", text: "Yes, run focused tests" })
  } finally { await page.close() }
}, 60_000)

test("a native question answer reaches the owned Form reply once and remains readable after tool settlement", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`${origin}/verify/remote.html?view=chat&questionFlow=1`)
    await wait(page, `!!document.querySelector('#pending-requests .question__option input')`)
    await page.evaluate(`(() => {window.recordedQuestion=document.querySelector('[aria-label="Recorded question"]'); const form=document.querySelector('#pending-requests form'); form.querySelector('.question__option input').click(); form.requestSubmit(); form.requestSubmit();})()`)
    await wait(page, `!document.querySelector('#pending-requests form') && document.querySelector('[aria-label="Recorded question"]')?.innerText.includes('Active only')`)
    expect(await page.evaluate<boolean>(`window.recordedQuestion===document.querySelector('[aria-label="Recorded question"]')`)).toBe(true)
    expect(await page.evaluate<unknown[]>(`window.requestLog.filter(row=>row.operation==='session.form.reply').map(row=>row.input)`)).toEqual([{ formID: "frm_fixture", answer: { q0: "Active only" } }])
    expect(await page.evaluate<string>(`document.querySelector('[aria-label="Recorded question"]').innerText`)).toContain("Which sessions should the workspace reload after reconnect?")
  } finally { await page.close() }
}, 60_000)

test("native question grades update without selecting, losing a focused draft, or hiding human attribution at narrow widths", async () => {
  const page = await browser.openPage()
  try {
    for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
      await page.setViewport(width, 900)
      await page.navigate(`${origin}/verify/remote.html?view=chat&questionFlow=1&questionGrades=1&theme=${theme}`)
      await wait(page, `!!document.querySelector('#pending-requests .question__option input') && document.querySelector('#pending-requests').innerText.includes('Assessing options')`)
      await page.evaluate(`(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden'; })()`)
      expect(await page.evaluate<string>(`document.querySelector('#pending-requests').innerText`)).toContain("Answers YOLO")
      await page.evaluate(`(() => {const field=document.querySelector('#pending-requests .question__custom input'); field.value='Keep my draft'; field.dispatchEvent(new Event('input',{bubbles:true})); field.focus(); window.focusedQuestionDraft=field;})()`)
      const assessment = { mode: "yolo", sourceSessionID: "ses_parent", fields: [{ key: "q0", status: "assessed", reason: "The narrower scope is supported.", recommendation: ["Active only"], grades: [
        { choice: "Active only", confidence: 0.96, evidence: "Only the active Session requires an immediate refresh. ".repeat(6) },
        { choice: "All advertised", confidence: 0.82, evidence: "Broader refresh increases request volume." },
      ] }] }
      await page.evaluate(`window.remoteQuestionAssessment(${JSON.stringify(assessment)})`)
      await wait(page, `document.querySelector('#pending-requests').innerText.includes('confidence 0.96')`)
      expect(await page.evaluate<boolean>(`document.activeElement===window.focusedQuestionDraft && window.focusedQuestionDraft.value==='Keep my draft'`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('#pending-requests .question__option input:checked').length`)).toBe(0)
      expect(await page.evaluate<number>(`window.requestLog.filter(row=>row.operation==='session.form.reply').length`)).toBe(0)
      expect(await page.evaluate<string>(`document.querySelector('#pending-requests').innerText`)).toContain("Recommended: Active only")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`)).toBe(false)
      expect(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.question__grade')).color===getComputedStyle(document.querySelector('.question__assessment')).color`)).toBe(true)
      for (const [mode, status, reason] of [["yolo", "unavailable", "The evaluator timed out; choose an answer."], ["manual", "not_assessed", "Manual answers require your decision."], ["auto", "not_assessed", "Auto uses only explicit defaults or a unique Recommended option."]] as const) {
        await page.evaluate(`window.remoteQuestionAssessment(${JSON.stringify({ mode, sourceSessionID: "ses_parent", fields: [{ key: "q0", status, reason }] })})`)
        await wait(page, `document.querySelector('#pending-requests').innerText.includes(${JSON.stringify(reason)})`)
        expect(await page.evaluate<boolean>(`document.activeElement===window.focusedQuestionDraft && window.focusedQuestionDraft.value==='Keep my draft'`)).toBe(true)
        expect(await page.evaluate<number>(`document.querySelectorAll('#pending-requests .question__grade').length`)).toBe(0)
      }
      await page.evaluate(`window.remoteQuestionAssessment(${JSON.stringify(assessment)})`)
      await wait(page, `document.querySelector('#pending-requests').innerText.includes('confidence 0.96')`)
      await page.evaluate(`document.querySelector('#pending-requests .question__assessment').scrollIntoView({block:'start'})`)
      await wait(page, `(() => {const root=document.querySelector('.workspace__scroll').getBoundingClientRect(); return ['#pending-requests .question__assessment','#pending-requests .question__grade'].every(selector=>{const box=document.querySelector(selector).getBoundingClientRect(); return box.top<root.bottom&&box.bottom>root.top&&box.top<innerHeight&&box.bottom>0})})()`)
      expect(await page.evaluate<boolean>(`document.activeElement===window.focusedQuestionDraft && window.focusedQuestionDraft.value==='Keep my draft'`)).toBe(true)
      await Bun.write(new URL(`../../../.cache/tmp/web-reading/question-grades-pending-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`(() => {const form=document.querySelector('#pending-requests form'); form.querySelectorAll('.question__option input')[1].click(); form.requestSubmit(); form.requestSubmit();})()`)
      await wait(page, `!document.querySelector('#pending-requests form') && document.querySelector('[aria-label="Recorded question"]')?.innerText.includes('answered by you')`)
      const text = await page.evaluate<string>(`document.querySelector('[aria-label="Recorded question"]').innerText`)
      expect(text).toContain("All advertised")
      expect(text).toContain("confidence 0.96")
      expect(text).not.toContain("automatically answered")
      expect(await page.evaluate<unknown[]>(`window.requestLog.filter(row=>row.operation==='session.form.reply').map(row=>row.input)`)).toEqual([{ formID: "frm_fixture", answer: { q0: "All advertised" } }])
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`)).toBe(false)
      await page.evaluate(`document.querySelector('[aria-label="Recorded question"]').scrollIntoView({block:'start'})`)
      await wait(page, `(() => {const box=document.querySelector('[aria-label="Recorded question"]').getBoundingClientRect(), root=document.querySelector('.workspace__scroll').getBoundingClientRect(); return box.top<root.bottom&&box.bottom>root.top&&box.top<innerHeight&&box.bottom>0})()`)
      await Bun.write(new URL(`../../../.cache/tmp/web-reading/question-grades-settled-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      for (const via of ["coordination", "yolo"] as const) {
        await page.evaluate(`window.responseSnapshot(${JSON.stringify([{ id: "msg_coordinator_question", type: "assistant", content: [{ type: "tool", id: "call_coordinator_question", name: "question", state: { status: "completed", input: { questions: [{ header: "Scope", question: "Which sessions should reload?", options: [] }] }, structured: { answers: [["Active only"]], ...(via === "yolo" ? { assessment } : {}), source: { kind: "coordinator", coordinatorSessionID: "ses_coordinator", via } }, content: [] } }], time: { created: 1, completed: 2 } }])}, [], false)`)
        await wait(page, `document.querySelector('[aria-label="Recorded question"]')?.innerText.includes('answered by coordinator ses_coordinator')`)
        const attributed = await page.evaluate<string>(`document.querySelector('[aria-label="Recorded question"]').innerText`)
        expect(attributed).not.toContain("answered by you")
        expect(attributed.includes("via Answers YOLO")).toBe(via === "yolo")
      }
      await page.evaluate(`window.responseSnapshot(${JSON.stringify([{ id: "msg_delegated_question", type: "assistant", content: [{ type: "tool", id: "call_delegated_question", name: "question", state: { status: "completed", input: { questions: [{ header: "Scope", question: "Which sessions should reload?", options: [] }] }, structured: { answers: [["Active only"]], source: { kind: "dots-delegation", anchorSessionID: "ses_anchor", delegationID: "delegation_one", revision: 3, exchangeID: "exchange_one" } }, content: [] } }], time: { created: 1, completed: 2 } }])}, [], false)`)
      await wait(page, `document.querySelector('[aria-label="Recorded question"]')?.innerText.includes('answered by external client via Dots delegation delegation_one · anchor ses_anchor')`)
      const delegated = await page.evaluate<string>(`document.querySelector('[aria-label="Recorded question"]').innerText`)
      expect(delegated).toContain("Active only")
      expect(delegated).not.toContain("answered by you")
      expect(delegated).not.toContain("answered by coordinator")
      expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth`)).toBe(false)
    }
  } finally { await page.close() }
}, 60_000)
