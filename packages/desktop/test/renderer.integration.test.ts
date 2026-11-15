import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { launchBrowser } from "../../../apps/web/verify/cdp"
import { createDesktopRPC } from "../src/rpc"
import { syntheticDesktop } from "./synthetic-desktop"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to the repository-provisioned Chrome for Testing executable.")
const title = "Synthetic Session with a complete readable title ".repeat(4).trim()
const unbroken = "UnbrokenSyntheticSessionTitle".repeat(5)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const clipboard: string[] = []
const saved: { readonly filename: string; readonly content: string }[] = []
const notifications: unknown[] = []
let pinned = false
let pending = true
let replyText = "Initial synthetic response"
let running = false
let currentVariant: string | undefined
let stagedMessage: string | undefined
let archived = false
let familyEnabled = false
let failInterrupt = false
let directoryStatus = false
let telemetryConsent = false
let globalFormPending = false
let formReview = false
let processControls = false
let waitingTask = true
let stoppedTask = true
let presentationParts = false
let ideEnabled = false
let externalEdit: string | undefined
let questionPending = false
let decideGate: Promise<void> | undefined
let fileGate: { query: string; reached: () => void; wait: Promise<void> } | undefined
let server: ViteDevServer | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let owned: Awaited<ReturnType<typeof syntheticDesktop>> | undefined
let origin = ""

const selection = () => ({ id: "synthetic", providerID: "synthetic", ...(currentVariant ? { variant: currentVariant } : {}) })
const session = (id: string) => ({ id, projectID: "global", title: id === "ses_test" ? title : id.startsWith("ses_child_") ? id : unbroken, location: { directory: "/synthetic/repo" }, model: selection(), ...(id === "ses_child" || id.startsWith("ses_child_") ? { parentID: "ses_test" } : {}), ...(id === "ses_test" && stagedMessage ? { revert: { messageID: stagedMessage, files: [] } } : {}), time: { created: 1, updated: 2, ...(id === "ses_test" && pinned ? { pinned: 3 } : {}), ...(id === "ses_test" && archived ? { archived: 4 } : {}) }, tokens, cost: 0 })
const model = { id: "synthetic", modelID: "synthetic", providerID: "synthetic", name: "Synthetic Model", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "low" }, { id: "high" }], profiles: [], time: { released: 1 }, cost: [], status: "active", enabled: true, limit: { context: 200000, output: 32000 } }
const location = { directory: "/synthetic/repo", project: { id: "global", directory: "/synthetic/repo" } }
const transcript = () => [
  ...Array.from({ length: 240 }, (_, index) => ({ id: `msg_prompt_${index}`, sessionID: "ses_test", type: "user", text: `Synthetic prompt ${index}. ${"Retained history ".repeat(16)}`, files: index === 239 ? [{ content: { type: "managed", digest: "a".repeat(64), bytes: 4, path: `attachments/sha256/aa/${"a".repeat(64)}` }, mime: "text/plain", name: "restored-notes.txt" }] : [], agents: index === 239 ? [{ name: "reviewer" }] : [], time: { created: index + 1 } })),
  { id: "msg_response", sessionID: "ses_test", type: "assistant", agent: "build", model: { id: "synthetic", providerID: "synthetic" }, content: [...(presentationParts ? [{ id: "part_reasoning", type: "reasoning", text: "Synthetic reasoning summary", time: { created: 500, completed: 500 } }, { id: "part_read", type: "tool", name: "read", state: { status: "completed", input: { path: "src/a.ts" }, content: [], structured: {} }, time: { created: 500 } }, { id: "part_grep", type: "tool", name: "grep", state: { status: "completed", input: { pattern: "synthetic" }, content: [], structured: {} }, time: { created: 500 } }] : []), { id: "part_response", type: "text", text: replyText, time: { created: 500 } }], time: { created: 500, ...(!running ? { completed: 501 } : {}) } },
]
const review = {
  itemID: "rvw_synthetic", sessionID: "ses_child", rootSessionID: "ses_test", sessionTitle: "Synthetic child", kind: "question", reason: "Choose synthetic targets", created: 1,
  origin: { requestID: "question-synthetic" }, payload: { type: "question", questions: [
    { header: "Targets", question: "Choose the synthetic targets", multiple: true, custom: false, options: [{ label: "Local", description: "Local target" }, { label: "Preview", description: "Preview target" }] },
    { header: "Details", question: "Describe the synthetic result", options: [], custom: true },
  ] },
}
const processTask = () => ({ sessionID: "ses_child", parentID: "ses_test", description: "Synthetic waiting worker", agent: "build", model: selection(), background: true, state: waitingTask ? "waiting" : "running", revision: 1, time: { created: 1, updated: 2 }, ...(waitingTask ? { question: { id: "qst_synthetic", text: "Choose the synthetic process response", time: 2 } } : {}), ...(stoppedTask ? { stoppedRecovery: { itemID: "rvw_recovery" } } : {}) })

beforeAll(async () => {
  owned = await syntheticDesktop((call) => {
    if (call.route === "/api/keep-awake") return { data: { state: "off" } }
    if (call.route === "/api/permission/saved") return { data: [] }
    if (call.route === "/api/server/telemetry/consent") return { consent: { enabled: telemetryConsent, noticeVersion: 1, decidedAt: 1 }, noticeVersion: 1 }
    if (call.method === "POST" && call.route === "/api/server/web-latency") return { accepted: Array.isArray(call.body.samples) ? call.body.samples.length : 0 }
    if (call.route === "/api/form/request") return { location, data: globalFormPending ? [{ id: "frm_synthetic", sessionID: "global", title: "Global synthetic choice", fields: [{ key: "choice", type: "string", title: "Choice" }], time: { created: 1 } }] : [] }
    if (call.method === "POST" && call.route === "/api/session/global/form/frm_synthetic/reply") { globalFormPending = false; return new Response(null, { status: 204 }) }
    if (directoryStatus && call.route === "/api/session/outstanding") return { data: [], running: ["ses_other"], failed: [], lost: [] }
    if (directoryStatus && call.route === "/api/decision") return { data: [{ kind: "permission", sessionID: "ses_child", sessionTitle: "Synthetic child", directory: "/synthetic/repo", id: "per_synthetic", summary: "Synthetic decision", decide: [] }] }
    if (call.method === "GET" && call.route === "/api/session") return { data: [session("ses_test"), session("ses_other")], cursor: {} }
    if (call.route === "/api/session/active") return { data: running ? { ses_test: { type: "running" } } : {} }
    if (call.route === "/api/model") return { location, data: [model] }
    if (call.route === "/api/model/default") return { location, data: { selection: selection() } }
    if (call.route === "/api/shell") return { location, data: [] }
    if (call.route === "/api/vcs/branch") return { location, data: { current: "synthetic", default: "main" } }
    if (call.route === "/api/vcs/status") return { location, data: [] }
    if (call.route === "/api/vcs/diff") return { location, data: ["a.ts", "b.ts"].map((file) => ({ file, patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" })) }
    if (call.method === "GET" && (call.route === "/api/fs/find" || call.route === "/api/fs/list")) {
      const query = call.query.get("query") ?? ""
      const reply = { location, data: [{ path: `src/${query}.ts`, type: "file" }] }
      if (fileGate?.query === query) { fileGate.reached(); return fileGate.wait.then(() => reply) }
      return reply
    }
    if (call.method === "GET" && /^\/api\/session\/ses_[^/]+$/.test(call.route)) return { data: session(call.route.split("/").at(-1)!) }
    if (processControls && call.route === "/api/session/ses_test/subagent") return { data: [processTask()], summary: { total: 1, active: 1 }, cursor: {} }
    if (processControls && call.route === "/api/session/ses_test/subagent/ses_child/question/qst_synthetic/answer") { waitingTask = false; return { data: processTask() } }
    if (processControls && call.method === "GET" && call.route === "/api/session/ses_child/review") return { data: stoppedTask ? [{ itemID: "rvw_recovery", sessionID: "ses_child", rootSessionID: "ses_test", sessionTitle: "Synthetic child", kind: "recovery", reason: "Synthetic stopped worker", created: 1, origin: { requestID: "recovery" }, payload: { type: "recovery", tools: [] } }] : [] }
    if (processControls && call.route === "/api/session/ses_child/review/rvw_recovery/decide") { stoppedTask = false; return new Response(null, { status: 204 }) }
    if (call.route.endsWith("/subagent")) return { data: familyEnabled && call.route === "/api/session/ses_test/subagent" ? ["ses_child_a", "ses_child_b"].map((sessionID) => ({ sessionID, parentID: "ses_test", description: sessionID, agent: "build", model: selection(), background: true, state: "running", revision: 1, time: { created: 1, updated: 2 } })) : [], summary: { total: familyEnabled && call.route === "/api/session/ses_test/subagent" ? 2 : 0, active: familyEnabled && call.route === "/api/session/ses_test/subagent" ? 2 : 0 }, cursor: {} }
    if (call.route.endsWith("/snapshot")) {
      const sessionID = call.route.split("/")[3]!
      const messages = transcript().map((message) => ({ ...message, sessionID }))
      const end = Number(call.query.get("before") ?? messages.length)
      const start = Math.max(0, end - Number(call.query.get("limit") ?? 100))
      return { sourceEpoch: "synthetic", session: session(sessionID), messages: messages.slice(start, end), watermark: { type: "log.synced", aggregateID: sessionID, seq: 1000 }, ...(start > 0 ? { before: String(start) } : {}) }
    }
    if (call.route.endsWith("/captured-inputs")) return { data: [] }
    if (call.route.endsWith("/message")) return { data: transcript() }
    if (call.method === "GET" && call.route.endsWith("/review")) return { data: pending && call.route === "/api/session/ses_test/review" ? [formReview ? { ...review, payload: { type: "form", title: "Synthetic typed review", fields: [{ key: "details", type: "boolean", default: true }, { key: "hidden", type: "string", when: [{ key: "details", op: "eq", value: false }] }, { key: "answer", title: "Reviewed answer", type: "string", required: true, minLength: 5, when: [{ key: "details", op: "eq", value: true }] }] } } : review] : [] }
    if (call.method === "GET" && call.route.endsWith("/question")) return { data: questionPending && call.route === "/api/session/ses_test/question" ? [{ id: "que_active", sessionID: "ses_test", questions: review.payload.questions }] : [] }
    if (call.method === "POST" && /\/question\/que_active\/(reply|reject)$/.test(call.route)) { questionPending = false; return new Response(null, { status: 204 }) }
    if (call.method === "GET" && ["/permission", "/form", "/guardrail/request", "/file-change", "/active", "/pending", "/todo"].some((suffix) => call.route.endsWith(suffix))) return { data: [] }
    if (call.method === "POST" && call.route.endsWith("/decide")) { const finish = () => { pending = false; return new Response(null, { status: 204 }) }; return decideGate ? decideGate.then(finish) : finish() }
    if (call.method === "POST" && call.route.endsWith("/pin")) { pinned = true; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/prompt")) return { data: { id: call.body.id, sessionID: call.route.split("/")[3], type: "user", delivery: call.body.delivery ?? "steer", admittedSeq: 1, timeCreated: 1, data: { text: call.body.text } } }
    if (call.method === "POST" && call.route.endsWith("/synthetic")) return { data: { id: call.body.id, sessionID: call.route.split("/")[3], type: "synthetic", delivery: "queue", admittedSeq: 1, timeCreated: 1, data: { text: call.body.text } } }
    if (call.method === "POST" && call.route.endsWith("/interrupt")) { if (failInterrupt) return new Response(JSON.stringify({ message: "Synthetic interrupt failed" }), { status: 500, headers: { "content-type": "application/json" } }); running = false; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/model")) { const selected = call.body.model; if (!selected || typeof selected !== "object" || !("variant" in selected) || typeof selected.variant !== "string") throw new Error("Expected a synthetic variant selection"); currentVariant = selected.variant; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/revert/stage")) { if (typeof call.body.messageID !== "string") throw new Error("Expected a synthetic revert boundary"); stagedMessage = call.body.messageID; return { data: { messageID: stagedMessage, files: [] } } }
    if (call.method === "POST" && call.route.endsWith("/revert/clear")) { stagedMessage = undefined; return new Response(null, { status: 204 }) }
    if (call.route.endsWith("/archive")) { archived = call.method === "POST"; return new Response(null, { status: 204 }) }
    if (call.method === "POST" && call.route.endsWith("/fork")) return { data: { ...session("ses_fork"), parentID: "ses_test" } }
    if (call.method === "POST" && call.route.endsWith("/compact")) return { data: { id: call.body.id, sessionID: "ses_test", trigger: "manual", status: "ended", requestedThrough: { messageID: "msg_prompt_239", seq: 240 }, timeCreated: 1 } }
    if (call.method === "POST" && call.route.endsWith("/prompt-generate")) return { data: { status: "generated", text: "Generated synthetic draft" } }
    return undefined
  }, { editor: { read: async () => ideEnabled ? { status: "connected", selection: { source: "websocket", filePath: "/synthetic/repo/src/editor.ts", ranges: [{ text: "const sample = 1", selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 17 } } }] } } : { status: "disabled" }, close: () => {} }, openEditor: async () => externalEdit === undefined ? { kind: "fallback" } : { kind: "edited", text: externalEdit } })
  const rpc = createDesktopRPC(owned.controller, { path: path.join(owned.resources, "preferences"), read: async () => ({}), save: async () => {}, validate: () => ({ mode: "shared" }) }, {
    writeClipboard: (text) => { clipboard.push(text) },
    notify: (input) => { notifications.push(input) },
    saveExport: async (exported, current) => { if (!current()) throw new Error("Synthetic export connection changed"); saved.push(exported); return { saved: true, path: `/synthetic/exports/${exported.filename}` } },
  })
  server = await createServer({ root: path.resolve(import.meta.dir, ".."), configFile: path.resolve(import.meta.dir, "../vite.config.ts"), plugins: [{ name: "desktop-synthetic-rpc", configureServer(server) {
    server.middlewares.use("/__desktop/rpc", (request, response, next) => { void (async () => {
    response.setHeader("content-type", "application/json")
    try {
      let body = ""
      for await (const chunk of request) body += String(chunk)
      const input: unknown = JSON.parse(body)
      if (!input || typeof input !== "object" || !("method" in input) || typeof input.method !== "string" || !("args" in input) || !Array.isArray(input.args)) throw new Error("Invalid synthetic RPC request")
      const handler: unknown = Reflect.get(rpc, input.method)
      if (typeof handler !== "function") throw new Error("Unknown synthetic RPC method")
      response.end(JSON.stringify({ value: await Reflect.apply(handler, rpc, input.args) ?? null }))
    } catch (error) { response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Synthetic RPC failed" })) }
    })().catch(next) })
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string") throw new Error("Desktop fixture has no listening port")
  origin = `http://127.0.0.1:${address.port}`
  browser = await launchBrowser(chrome, 1280, 900)
}, 30_000)

afterAll(async () => { await browser?.close(); await server?.close(); await owned?.close() })
beforeEach(() => { ideEnabled = false; externalEdit = undefined })
beforeEach(() => { presentationParts = false; questionPending = false; pending = true; pinned = false; replyText = "Initial synthetic response"; running = false; currentVariant = undefined; stagedMessage = undefined; archived = false; familyEnabled = false; failInterrupt = false; directoryStatus = false; telemetryConsent = false; globalFormPending = false; formReview = false; processControls = false; waitingTask = true; stoppedTask = true; decideGate = undefined; fileGate = undefined; clipboard.length = 0; saved.length = 0; notifications.length = 0; if (owned) owned.calls.length = 0 })

const inject = `(() => {
  const events = new Set(), states = new Set(), resyncs = new Set(), menus = new Set(); let sequence = 0;
  const subscriptions = { onEvent: events, onState: states, onResync: resyncs, onMenuAction: menus };
  window.__desktopFixture = { errors: [], completed: {}, sounds: [], emit: event => events.forEach(callback => callback({ id: 'evt_fixture_' + sequence++, created: 1, ...event })), resync: () => resyncs.forEach(callback => callback()) };
  window.Audio = class { constructor(src) { this.src = src; this.volume = 1; } play() { window.__desktopFixture.sounds.push({ src: this.src, volume: this.volume }); return Promise.resolve(); } pause() {} };
  window.addEventListener('error', event => window.__desktopFixture.errors.push(event.error?.stack ?? event.message));
  window.addEventListener('unhandledrejection', event => window.__desktopFixture.errors.push(String(event.reason?.stack ?? event.reason)));
  window.__ycodingDesktop = new Proxy({}, { get: (_, method) => {
    if (subscriptions[method]) return callback => { subscriptions[method].add(callback); return () => subscriptions[method].delete(callback); };
    return async (...args) => { const response = await fetch('/__desktop/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) }); const result = await response.json(); window.__desktopFixture.completed[method] = (window.__desktopFixture.completed[method] ?? 0) + 1; if (result.error) throw new Error(result.error); return result.value; };
  } });
})()`

type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
async function wait(page: Page, expression: string) {
  try {
    await page.evaluate(`new Promise((resolve, reject) => { const deadline = performance.now() + 10000; const check = () => { if (${expression}) return resolve(true); if (performance.now() >= deadline) return reject(new Error('Desktop fixture condition timed out: ' + ${JSON.stringify(expression)})); requestAnimationFrame(check); }; check(); })`)
  } catch (cause) {
    const state = await page.evaluate(`({ errors: window.__desktopFixture.errors, alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent), text: document.body.innerText.slice(-8000), completed: window.__desktopFixture.completed })`)
    throw new Error(`${String(cause)}\n${JSON.stringify(state)}\n${JSON.stringify(owned?.calls.slice(-12).map(call => [call.method, call.route]))}`, { cause })
  }
}
async function open() {
  if (!browser) throw new Error("Desktop browser fixture is not ready")
  const page = await browser.openPage()
  await page.injectOnNewDocument(inject)
  try {
    await page.navigate(`${origin}/#/sessions/ses_test`)
    await wait(page, `document.querySelector('.rl-session-row-title') && document.querySelector('#turn-msg_response')`)
    return page
  } catch (cause) {
    const state = await page.evaluate(`({ errors: window.__desktopFixture.errors, text: document.body.innerText, completed: window.__desktopFixture.completed })`)
    await page.close()
    throw new Error(`${String(cause)}\n${JSON.stringify(state)}\n${JSON.stringify(page.networkFailures())}`, { cause })
  }
}

async function command(page: Page, label: string) {
  await page.evaluate(`document.querySelector('.desktop__palette').click()`)
  await wait(page, `!![...document.querySelectorAll('.palette__option')].find(button => button.textContent.includes(${JSON.stringify(label)}))`)
  await page.evaluate(`(() => { const input = document.querySelector('.palette__input'); input.value = ${JSON.stringify(label)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.focus(); })()`)
  await wait(page, `document.querySelector('.palette__option[aria-selected="true"]')?.textContent.includes(${JSON.stringify(label)})`)
  await page.pressKey("Enter", "Enter", 13, "\r")
}

async function message(page: Page, text: string) {
  await page.evaluate(`(() => { const input = document.querySelector('.rl-capsule textarea'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}

async function confirm(page: Page, label = "Confirm") {
  await wait(page, `document.querySelector('.confirm[open]')`)
  await page.evaluate(`[...document.querySelectorAll('.confirm button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).focus()`)
  await page.pressKey("Enter", "Enter", 13, "\r")
}

test("active question controls require complete answers and send their ordered selections once", async () => {
  pending = false
  questionPending = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('#question-que_active')`)
    await page.evaluate(`document.querySelector('#question-que_active').closest('article').querySelector('button[type="submit"]').click()`)
    await wait(page, `document.querySelector('#question-que_active').closest('article').querySelector('[role="alert"]')`)
    expect(owned?.calls.filter((call) => call.method === "POST" && call.route.includes("/question/"))).toHaveLength(0)
    await page.evaluate(`(() => {
      const card = document.querySelector('#question-que_active').closest('article');
      for (const input of card.querySelectorAll('input[type="checkbox"]')) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
      const input = card.querySelector('input[type="text"]'); input.value = 'Detailed synthetic answer'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      card.querySelector('button[type="submit"]').click();
    })()`)
    await wait(page, `!document.querySelector('#question-que_active')`)
    expect(owned?.calls.filter((call) => call.method === "POST" && call.route.includes("/question/"))).toEqual([expect.objectContaining({ route: "/api/session/ses_test/question/que_active/reply", body: { answers: [["Local", "Preview"], ["Detailed synthetic answer"]] } })])
    expect(await page.evaluate<unknown[]>(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity opens composition commands without submitting their text as a prompt", async () => {
  pending = false
  const page = await open()
  try {
    for (const [input, tab, draft] of [["/btw Synthetic side chat", "Side chat", "Synthetic side chat"], ["/suggest Synthetic hint", "Prompt assistance", "Synthetic hint"], ["/prompt Synthetic intent", "Prompt assistance", "Synthetic intent"]]) {
      await message(page, input!)
      await page.evaluate(`document.querySelector('.rl-send').click()`)
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Session actions' && document.querySelector('dialog[open] [role="radio"][aria-checked="true"]')?.textContent === ${JSON.stringify(tab)}`)
      expect(await page.evaluate<string>(`document.querySelector('dialog[open] textarea').value`)).toBe(draft!)
      expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, `!document.querySelector('dialog[open]')`)
    }
    await message(page, "/btw-send Not a side chat")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.body.textContent.includes('available only in a BTW side chat')`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity edits a prompt without submitting it and preserves file and agent attachments", async () => {
  pending = false
  const page = await open()
  try {
    await command(page, "/undo")
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.')`)
    await command(page, "Edit the full prompt draft")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Edit prompt'`)
    await page.evaluate(`(() => { const input = document.querySelector('dialog[open] textarea'); input.value = 'Edited synthetic draft'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Save draft').click(); })()`)
    await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value === 'Edited synthetic draft'`)
    expect(await page.evaluate<string>(`document.querySelector('[aria-label="Attached workspace files"]').textContent`)).toContain("restored-notes.txt")
    expect(await page.evaluate<string>(`document.querySelector('[aria-label="Restored agent attachments"]').textContent`)).toContain("reviewer")
    expect(owned!.calls.filter((call) => call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("native IDE context can be excluded, included and admitted once before the message", async () => {
  pending = false
  ideEnabled = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="IDE context"]')`)
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Exclude IDE selection').click()`)
    await message(page, "without IDE context")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter((call) => call.route.endsWith("/synthetic"))).toEqual([])
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Include IDE selection').click()`)
    await message(page, "with IDE context")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    await message(page, "same IDE context")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    const admitted = owned!.calls.filter((call) => call.method === "POST" && (call.route.endsWith("/synthetic") || call.route.endsWith("/prompt")))
    expect(admitted.map((call) => call.route.split("/").at(-1))).toEqual(["prompt", "synthetic", "prompt", "prompt"])
    expect(admitted[1]!.body.text).toContain("const sample = 1")
    expect(admitted[1]!.body.resume).toBe(false)
    expect(admitted[2]!.body.text).toBe("with IDE context")
  } finally { await page.close() }
}, 30_000)

test("native external editing preserves attachments and accepts an intentionally empty draft", async () => {
  pending = false
  externalEdit = ""
  const page = await open()
  try {
    await command(page, "/undo")
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.')`)
    await command(page, "Edit the full prompt draft")
    await wait(page, `window.__desktopFixture.completed.editDraft === 1 && document.querySelector('.rl-capsule textarea').value === ''`)
    expect(await page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`)).toBe(false)
    expect(await page.evaluate<string>(`document.querySelector('[aria-label="Attached workspace files"]').textContent`)).toContain("restored-notes.txt")
    expect(await page.evaluate<string>(`document.querySelector('[aria-label="Restored agent attachments"]').textContent`)).toContain("reviewer")
    expect(owned!.calls.filter((call) => call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity preserves full stashed drafts across both composers", async () => {
  pending = false
  const page = await open()
  const draft = {
    text: "@helper @a.ts @reviewer @b.ts",
    files: [{ uri: "file:///synthetic/a.ts", name: "a.ts", mention: { start: 8, end: 13, text: "@a.ts" } }],
    agents: [{ name: "helper", mention: { start: 0, end: 7, text: "@helper" } }],
    picks: [{ kind: "agent", name: "reviewer", display: "@reviewer" }, { kind: "file", uri: "file:///synthetic/b.ts", name: "b.ts", display: "@b.ts" }],
  }
  try {
    for (const route of ["/sessions/ses_test", "/chat"]) {
      await page.navigate(`${origin}/#${route}`)
      await wait(page, `document.querySelector('.rl-capsule textarea') && document.querySelector('.desktop__palette')`)
      await page.evaluate(`localStorage.setItem('ycoding.desktop.prompt-stashes', JSON.stringify([{ ...${JSON.stringify(draft)}, id: 'synthetic-stash', createdAt: 1 }]))`)
      await command(page, "Stash or restore the prompt")
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Pop and restore').click()`)
      await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value === ${JSON.stringify(draft.text)}`)
      await command(page, "Stash or restore the prompt")
      await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Stash current draft').click()`)
      expect(await page.evaluate<unknown>(`(() => { const { text, files, agents, picks } = JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0]; return { text, files, agents, picks }; })()`)).toEqual(draft)
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, `!document.querySelector('dialog[open]')`)
    }
    expect(owned!.calls.filter((call) => call.route.endsWith("/prompt"))).toEqual([])
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.prompt-stashes')`); await page.close() }
}, 30_000)

test("rendered parity marks diff files reviewed and preserves display controls without changing files", async () => {
  pending = false
  const page = await open()
  try {
    await command(page, "Git working-tree diff")
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Mark reviewed: a.ts')`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Mark reviewed: a.ts').click()`)
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('1 reviewed')`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] nav[aria-label="Changed files"] button')].find(button => button.textContent.includes('b.ts')).click()`)
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('Mark reviewed: b.ts')`)
    await page.evaluate(`(() => { [...document.querySelectorAll('dialog[open] [role="radio"]')].find(button => button.textContent === 'Split').click(); const labels = [...document.querySelectorAll('dialog[open] label')]; labels.find(label => label.textContent === 'Wrap diff lines').querySelector('input').click(); labels.find(label => label.textContent === 'Show selected file only').querySelector('input').click(); })()`)
    await wait(page, `document.querySelector('dialog[open] .desktop-diff').dataset.view === 'split' && document.querySelectorAll('dialog[open] .desktop-diff__file').length === 1`)
    expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.desktop.diffs'))`)).toEqual({ view: "split", wrap: "none", tree: true, single: true })
    expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('dialog[open] .desktop-diff__split')).display`)).toBe("table")
    await page.evaluate(`[...document.querySelectorAll('dialog[open] [role="radio"]')].find(button => button.textContent === 'Branch').click()`)
    await wait(page, `document.querySelector('dialog[open]')?.textContent.includes('0 reviewed')`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.diffs')`); await page.close() }
}, 30_000)

test("rendered parity gives conditional Family Review fields stable errors and locks them during submission", async () => {
  formReview = true
  const decision = Promise.withResolvers<void>()
  decideGate = decision.promise
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="Reviewed answer"]')`)
    await page.evaluate(`[...document.querySelectorAll('.request button')].find(button => button.textContent === 'Send answer').click()`)
    expect(await page.evaluate<string>(`document.querySelector('[aria-label="Reviewed answer"]').getAttribute('aria-describedby')`)).toBe("rvw_synthetic-2-error")
    expect(await page.evaluate<string>(`document.querySelector('#rvw_synthetic-2-error').textContent`)).toBe("Required.")
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="Reviewed answer"]'); input.value = 'Reviewed synthetic answer'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('.request button')].find(button => button.textContent === 'Send answer').click(); })()`)
    await wait(page, `document.querySelector('[aria-label="Reviewed answer"]').matches(':disabled')`)
    decision.resolve()
    await wait(page, `!document.querySelector('[aria-label="Reviewed answer"]')`)
    expect(owned!.calls.filter((call) => call.route.endsWith("/decide")).map((call) => call.body)).toEqual([{ decision: { kind: "question", answers: { details: true, answer: "Reviewed synthetic answer" } } }])
  } finally { decision.resolve(); await page.close() }
}, 30_000)

async function delivery(page: Page, index: number) {
  await page.evaluate(`document.querySelector('[aria-label="Send mode"]').focus()`)
  await page.pressKey("ArrowDown", "ArrowDown", 40)
  await page.pressKey("Home", "Home", 36)
  for (let i = 0; i < index; i++) await page.pressKey("ArrowDown", "ArrowDown", 40)
  await page.pressKey("Enter", "Enter", 13, "\r")
}

test("rendered directory filters use canonical running Sessions and waiting family roots", async () => {
  directoryStatus = true
  const page = await open()
  try {
    await page.navigate(`${origin}/#/sessions`)
    await wait(page, `document.body.innerText.includes('Server-reported status and current live events')`)
    await page.evaluate(`[...document.querySelectorAll('main[data-surface="sessions"] button')].find(button => /^Running(?:\\s|$)/.test(button.textContent.trim())).click()`)
    await wait(page, `document.querySelector('main').innerText.includes(${JSON.stringify(unbroken)}) && !document.querySelector('main').innerText.includes(${JSON.stringify(title)})`)
    await page.evaluate(`[...document.querySelectorAll('main[data-surface="sessions"] button')].find(button => /^Waiting(?:\\s|$)/.test(button.textContent.trim())).click()`)
    await wait(page, `document.querySelector('main').innerText.includes(${JSON.stringify(title)}) && !document.querySelector('main').innerText.includes(${JSON.stringify(unbroken)})`)
    expect(await page.evaluate<unknown[]>(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered global MCP forms submit at their bound location without sending a prompt", async () => {
  globalFormPending = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('section[aria-label="Global MCP forms"] input')`)
    await page.evaluate(`(() => { const input = document.querySelector('section[aria-label="Global MCP forms"] input'); input.value = 'Synthetic choice'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('section[aria-label="Global MCP forms"] button[type="submit"]').click(); })()`)
    await wait(page, `!document.querySelector('section[aria-label="Global MCP forms"]')`)
    const posts = owned!.calls.filter((call) => call.method === "POST")
    expect(posts.map((call) => call.route)).toEqual(["/api/session/global/form/frm_synthetic/reply"])
    expect(JSON.stringify(posts[0]!.body)).toContain("Synthetic choice")
    expect(await page.evaluate<unknown[]>(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered consented client timings batch real admission and transcript measurements without draft content", async () => {
  telemetryConsent = true
  const page = await open()
  try {
    await wait(page, `window.__desktopFixture.completed.telemetryConsent >= 1`)
    await page.evaluate(`window.__desktopFixture.resync()`)
    await message(page, "Synthetic timing draft that must not appear in diagnostics")
    await page.evaluate(`document.querySelector('.rl-capsule textarea').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `window.__desktopFixture.completed.appendTelemetry >= 1`)
    const batches = owned!.calls.filter((call) => call.method === "POST" && call.route === "/api/server/web-latency")
    expect(batches).toHaveLength(1)
    const payload = JSON.stringify(batches[0]!.body)
    expect(payload).toContain('"surface":"web"')
    expect(payload).toContain('"metric":"prompt.admit"')
    expect(payload).toContain('"metric":"transcript.load"')
    expect(payload).not.toContain("Synthetic timing draft")
    expect(payload).not.toContain("/synthetic/repo")
    expect(await page.evaluate<unknown[]>(`window.__desktopFixture.errors`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered rail titles wrap around visible status and keyboard-operated Pin controls", async () => {
  const page = await open()
  try {
    await page.evaluate(`['ses_test','ses_other'].forEach(sessionID => window.__desktopFixture.emit({ type: 'permission.asked', data: { sessionID, id: 'prm_' + sessionID } }))`)
    await wait(page, `document.querySelectorAll('.rl-session-row[data-state="waiting"]').length === 2`)
    const geometry = await page.evaluate<{ contained: boolean; separate: boolean; wrapped: boolean; overflow: boolean; fullText: boolean }>(`(() => {
      const rows = [...document.querySelectorAll('.rl-nav .workspace__row')], rail = document.querySelector('.rl-nav-scroll');
      const titles = rows.map(row => row.querySelector('.rl-session-row-title'));
      const rects = rows.map(row => { const title = row.querySelector('.rl-session-row-title'), status = row.querySelector('.workspace__status'), pin = row.querySelector('.workspace__pin'); return { row: row.getBoundingClientRect(), title: title.getBoundingClientRect(), status: status.getBoundingClientRect(), pin: pin.getBoundingClientRect(), line: parseFloat(getComputedStyle(title).lineHeight) }; });
      return { contained: rects.every(r => r.title.left >= r.row.left && r.title.right <= r.row.right && r.title.bottom <= r.row.bottom && r.status.right <= r.row.right && r.pin.right <= r.row.right), separate: rects.every(r => r.title.right <= r.status.left + 1 && r.status.right <= r.pin.left + 1), wrapped: rects.every(r => r.title.height > r.line * 2 && r.row.height >= r.title.height), overflow: rail.scrollWidth > rail.clientWidth, fullText: titles.every(title => getComputedStyle(title).textOverflow !== 'ellipsis' && title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight) };
    })()`)
    expect(geometry).toEqual({ contained: true, separate: true, wrapped: true, overflow: false, fullText: true })
    await page.evaluate(`document.querySelector('.rl-session-row[aria-current="page"]').focus()`)
    await page.pressKey("Tab", "Tab", 9)
    expect(await page.evaluate<boolean>(`document.activeElement.matches('.workspace__pin')`)).toBe(true)
    await wait(page, `Number(getComputedStyle(document.activeElement).opacity) === 1`)
    expect(await page.evaluate<boolean>(`document.activeElement.matches('.workspace__pin') && getComputedStyle(document.activeElement).visibility === 'visible' && Number(getComputedStyle(document.activeElement).opacity) === 1 && getComputedStyle(document.querySelector('.rl-session-row[aria-current="page"] .workspace__status')).visibility === 'visible'`)).toBe(true)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.workspace__pin[aria-label^="Unpin "]')`)
    expect(owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/pin")).map((call) => call.route)).toEqual(["/api/session/ses_test/pin"])
  } finally { await page.close() }
}, 30_000)

test("scrolling and streamed content do not measure every retained prompt or refresh captured files", async () => {
  const page = await open()
  try {
    await page.evaluate(`window.__promptReads = 0; const read = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function() { if (this.matches('.transcript__turn[data-speaker="user"]')) window.__promptReads++; return read.call(this); }`)
    const point = await page.evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector('.conversation__scroll').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`)
    await page.wheel(point.x, point.y, 0, -1200)
    await wait(page, `document.querySelector('.conversation__scroll').scrollTop < document.querySelector('.conversation__scroll').scrollHeight - document.querySelector('.conversation__scroll').clientHeight - 100`)
    const files = owned!.calls.filter((call) => call.route.endsWith("/file-change")).length
    replyText = "Updated synthetic streaming response"
    await page.evaluate(`Array.from({length: 50}, (_, index) => window.__desktopFixture.emit({ type: index % 2 ? 'session.text.delta' : 'session.reasoning.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 0, delta: 'synthetic' } }))`)
    await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Updated synthetic streaming response')`)
    expect(owned!.calls.filter((call) => call.route.endsWith("/file-change"))).toHaveLength(files)
    expect(await page.evaluate<number>(`window.__promptReads`)).toBeLessThan(12)
  } finally { await page.close() }
}, 30_000)

test("older history keeps its reading position and survives a newest-window stream refresh", async () => {
  const page = await open()
  try {
    expect(await page.evaluate<boolean>(`!!document.querySelector('#turn-msg_prompt_141') && !document.querySelector('#turn-msg_prompt_140')`)).toBe(true)
    await page.evaluate(`const scroll = document.querySelector('.conversation__scroll'); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll'));`)
    const anchor = await page.evaluate<number>(`document.querySelector('#turn-msg_prompt_141').getBoundingClientRect().top`)
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load older messages').click()`)
    await wait(page, `document.querySelector('#turn-msg_prompt_41') && [...document.querySelectorAll('button')].some(button => button.textContent === 'Load older messages')`)
    expect(Math.abs(await page.evaluate<number>(`document.querySelector('#turn-msg_prompt_141').getBoundingClientRect().top`) - anchor)).toBeLessThan(3)
    replyText = "Updated response after loading older history"
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.text.delta', data: { sessionID: 'ses_test', assistantMessageID: 'msg_response', ordinal: 0, delta: 'synthetic' } })`)
    await wait(page, `document.querySelector('#turn-msg_response').textContent.includes('Updated response after loading older history')`)
    expect(await page.evaluate<boolean>(`!!document.querySelector('#turn-msg_prompt_41')`)).toBe(true)
    await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load older messages').click()`)
    await wait(page, `document.querySelector('#turn-msg_prompt_0') && ![...document.querySelectorAll('button')].some(button => button.textContent === 'Load older messages')`)
    expect(owned!.calls.filter((call) => call.route.endsWith('/snapshot') && call.query.has('before')).map((call) => call.query.get('before'))).toEqual(["141", "41"])
    expect(owned!.calls.filter((call) => call.route.endsWith('/message'))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("prompt assistance confirms generation and stages a goal draft without sending it or changing the goal", async () => {
  const page = await open()
  try {
    await command(page, "Open shell, editor context, side-chat and prompt tools")
    await wait(page, `document.querySelector('.desktop-dialog textarea')`)
    await page.evaluate(`(() => { const input = document.querySelector('.desktop-dialog textarea'); input.value = 'Check the synthetic change'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('.desktop-dialog [role="radio"]')].find(button => button.textContent.trim() === 'Goal').click(); [...document.querySelectorAll('.desktop-dialog button')].find(button => button.textContent === 'Generate prompt draft').click(); })()`)
    await wait(page, `document.querySelector('.confirm[open]')`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`[...document.querySelectorAll('.confirm button')].find(button => button.textContent.trim() === 'Confirm').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('.desktop-dialog').textContent.includes('Generated synthetic draft')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/prompt-generate", { mode: "goal", intent: "Check the synthetic change", memory: [] }]])
    await page.evaluate(`[...document.querySelectorAll('.desktop-dialog button')].find(button => button.textContent === 'Use draft in composer').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('.desktop-dialog[open]') && document.querySelector('.rl-capsule textarea').value === '/goal Generated synthetic draft'`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally { await page.close() }
}, 30_000)

test("saved command shortcuts update key dispatch and accessible hints after a reload", async () => {
  pending = false
  const page = await open()
  try {
    await page.navigate(`${origin}/#/settings`)
    await wait(page, `document.querySelector('[aria-label="Keyboard shortcuts"] input')`)
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="Keyboard shortcuts"] input'); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true })); })()`)
    expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.desktop.keybindings'))`)).toEqual({ palette: { key: "J", modifier: "primary" } })
    await page.navigate(`${origin}/#/sessions/ses_test`)
    await wait(page, `document.querySelector('.desktop__palette')?.getAttribute('aria-keyshortcuts')?.endsWith('+J')`)
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }))`)
    await wait(page, `document.querySelector('.palette__input')`)
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `!document.querySelector('.palette__input')`)
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }))`)
    expect(await page.evaluate<boolean>(`!!document.querySelector('.palette__input')`)).toBe(false)
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.keybindings')`); await page.close() }
}, 30_000)

test("saved Session display choices expand reasoning, separate tool calls and remember the companion", async () => {
  presentationParts = true
  const page = await open()
  const session = `${origin}/#/sessions/ses_test`
  const choose = (group: string, option: string) => page.evaluate(`[...document.querySelector('[role="radiogroup"][aria-label="${group}"]').querySelectorAll('[role="radio"]')].find(radio => radio.textContent === '${option}').click()`)
  try {
    await page.navigate(session)
    await wait(page, `document.querySelectorAll('.transcript-tools__button').length === 1 && !!document.querySelector('.transcript-reasoning')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.transcript-reasoning').open`)).toBe(false)
    await page.navigate(`${origin}/#/settings`)
    await wait(page, `document.querySelector('[aria-label="Session display"] [role="radiogroup"][aria-label="Tool calls"]')`)
    await choose("Reasoning", "Expanded")
    await choose("Tool calls", "Show each call separately")
    expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.desktop.presentation'))`)).toEqual({ thinking: "show", grouping: "none", companion: "hide" })
    await page.navigate(session)
    await wait(page, `document.querySelectorAll('.transcript-tools__button').length === 2 && document.querySelector('.transcript-reasoning')?.open === true`)
    await page.evaluate(`document.querySelector('.rl-companion-toggle').click()`)
    await wait(page, `!!document.querySelector('.rl-companion')`)
    expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.desktop.presentation')).companion`)).toBe("auto")
    await page.evaluate(`document.querySelector('.rl-companion-toggle').click()`)
    await wait(page, `!document.querySelector('.rl-companion')`)
    expect(await page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.desktop.presentation')).companion`)).toBe("hide")
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.presentation')`); await page.close() }
}, 30_000)

test("attention settings persist independent sound and native notification choices at the selected volume", async () => {
  const page = await open()
  const settings = `${origin}/#/settings`
  try {
    await page.navigate(settings)
    await wait(page, `document.querySelector('[data-action-id="st-open-notifications"]')`)
    await page.evaluate(`document.querySelector('[data-action-id="st-open-notifications"]').click()`)
    await wait(page, `[...document.querySelectorAll('label')].some(label => label.textContent === 'Enable attention')`)
    await page.evaluate(`(() => { const labels = [...document.querySelectorAll('label')]; labels.find(label => label.textContent === 'Enable attention').querySelector('input').click(); labels.find(label => label.textContent === 'Native attention notifications').querySelector('input').click(); const volume = labels.find(label => label.textContent === 'Sound volume (%)').querySelector('input'); volume.value = '25'; volume.dispatchEvent(new Event('change', { bubbles: true })); window.__desktopFixture.emit({ type: 'permission.asked', data: { sessionID: 'ses_test', id: 'per_audio_one' } }); })()`)
    await wait(page, `window.__desktopFixture.sounds.length === 1`)
    expect(await page.evaluate<unknown>(`window.__desktopFixture.sounds.map(sound => ({ volume: sound.volume, permission: sound.src.endsWith('/staplebops-06.mp3') }))`)).toEqual([{ volume: 0.25, permission: true }])
    expect(notifications).toEqual([])
    await page.navigate(`${origin}/?reload=settings#/settings`)
    await wait(page, `document.querySelector('[data-action-id="st-open-notifications"]')`)
    await page.evaluate(`document.querySelector('[data-action-id="st-open-notifications"]').click()`)
    await wait(page, `[...document.querySelectorAll('label')].some(label => label.textContent === 'Sound volume (%)')`)
    expect(await page.evaluate<unknown>(`(() => { const labels = [...document.querySelectorAll('label')]; return { enabled: labels.find(label => label.textContent === 'Enable attention').querySelector('input').checked, notifications: labels.find(label => label.textContent === 'Native attention notifications').querySelector('input').checked, volume: labels.find(label => label.textContent === 'Sound volume (%)').querySelector('input').value }; })()`)).toEqual({ enabled: true, notifications: false, volume: "25" })
  } finally {
    await page.evaluate(`['attention', 'notifications', 'notification-sound', 'notification-volume'].forEach(name => localStorage.removeItem('ycoding.desktop.' + name))`)
    await page.close()
  }
}, 30_000)

test("process controls answer the current child question and continue only its issued recovery review", async () => {
  processControls = true
  const page = await open()
  try {
    await command(page, "Manage Session shells and subagents")
    await wait(page, `document.querySelector('.desktop-dialog textarea')`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`(() => { const dialog = document.querySelector('.desktop-dialog'); const input = dialog.querySelector('textarea'); input.value = 'Synthetic accepted response'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Answer subagent').click(); })()`)
    await confirm(page)
    await wait(page, `!document.querySelector('.desktop-dialog textarea')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/subagent/ses_child/question/qst_synthetic/answer", { text: "Synthetic accepted response" }]])
    await command(page, "Manage Session shells and subagents")
    await wait(page, `[...document.querySelectorAll('.desktop-dialog button')].some(button => button.textContent === 'Continue stopped subagent')`)
    await page.evaluate(`[...document.querySelectorAll('.desktop-dialog button')].find(button => button.textContent === 'Continue stopped subagent').click()`)
    await confirm(page)
    await wait(page, `![...document.querySelectorAll('.desktop-dialog button')].some(button => button.textContent === 'Continue stopped subagent')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/subagent/ses_child/question/qst_synthetic/answer", { text: "Synthetic accepted response" }], ["/api/session/ses_child/review/rvw_recovery/decide", { decision: { kind: "recovery", choice: "continue" } }]])
  } finally { await page.close() }
}, 30_000)

test("a Family Review answer travels from rendered controls through RPC and Client to its owning child once", async () => {
  const page = await open()
  try {
    await wait(page, `document.querySelector('.request form')`)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
    await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('.request')].find(card => card.textContent.includes('Choose synthetic targets'));
      for (const name of ['Preview','Local']) [...card.querySelectorAll('label')].find(label => label.textContent.includes(name)).querySelector('input').click();
      const details = [...card.querySelectorAll('fieldset')].find(field => field.querySelector('legend').textContent === 'Details').querySelector('input'); details.value = 'Synthetic free text'; details.dispatchEvent(new InputEvent('input', { bubbles: true }));
      card.querySelector('button[type="submit"]').focus();
    })()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('.request form')`)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([
      ["/api/session/ses_child/review/rvw_synthetic/decide", { decision: { kind: "question", answers: [["Preview", "Local"], ["Synthetic free text"]] } }],
    ])
  } finally { await page.close() }
}, 30_000)

test("a child review settled elsewhere disappears from the open parent inbox without submitting an answer", async () => {
  const page = await open()
  try {
    await wait(page, `document.querySelector('.request form')`)
    const reads = owned!.calls.filter((call) => call.method === "GET" && call.route === "/api/session/ses_test/review").length
    pending = false
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.review.decided', durable: { aggregateID: 'ses_child', seq: 1001, version: 1 }, data: { sessionID: 'ses_child', itemID: 'rvw_synthetic', decision: { kind: 'question', answers: [['Local'], ['Settled elsewhere']] } } })`)
    await wait(page, `!document.querySelector('.request form')`)
    expect(owned!.calls.filter((call) => call.method === "GET" && call.route === "/api/session/ses_test/review").length).toBeGreaterThan(reads)
    expect(owned!.calls.filter((call) => call.method === "POST")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("full transcript copy and structured export reach the canonical backend and native delivery ports", async () => {
  const page = await open()
  try {
    await command(page, "Copy the full transcript")
    await wait(page, `document.body.textContent.includes('Copied the full transcript.')`)
    expect(clipboard).toHaveLength(1)
    expect(clipboard[0]).toContain("Synthetic prompt 0.")
    expect(clipboard[0]).toContain("Synthetic prompt 239.")
    expect(clipboard[0]).toContain(replyText)
    await command(page, "Export the transcript")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Export Session'`)
    await page.evaluate(`[...document.querySelectorAll('dialog [role="radio"]')].find(button => button.textContent === 'JSON').click(); [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Copy transcript').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('dialog').textContent.includes('Transcript copied to the clipboard.')`)
    const structured = JSON.parse(clipboard.at(-1)!)
    expect(structured.info.id).toBe("ses_test")
    expect(structured.messages).toHaveLength(241)
    expect(structured.messages[0].text).toContain("Synthetic prompt 0.")
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Save transcript…').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.querySelector('dialog').textContent.includes('Saved to /synthetic/exports/')`)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.filename).toEndWith(".json")
    expect(JSON.parse(saved[0]!.content)).toEqual(structured)
    expect(owned!.calls.filter((call) => call.method === "GET" && call.route.endsWith("/message"))).toHaveLength(3)
  } finally { await page.close() }
}, 30_000)

test("rendered parity opens Appearance without changing the theme and scopes shortcut help and view toggles", async () => {
  const page = await open()
  try {
    const original = await page.evaluate<string>(`document.documentElement.dataset.theme`)
    await command(page, "Choose a theme")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Appearance'`)
    expect(await page.evaluate<string>(`document.documentElement.dataset.theme`)).toBe(original)
    expect(await page.evaluate<boolean>(`(() => { const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }); document.querySelector('dialog [role="radio"]').dispatchEvent(event); return event.defaultPrevented || location.hash !== '#/sessions/ses_test'; })()`)).toBe(false)
    await page.evaluate(`[...document.querySelectorAll('dialog [role="radio"]')].find(button => button.textContent.trim() === 'Dark').click()`)
    await wait(page, `localStorage.getItem('ycoding.desktop.theme') === 'dark' && document.querySelector('dialog [role="radio"][aria-checked="true"]').textContent.trim() === 'Dark'`)
    await page.pressKey("Escape", "Escape", 27)
    await command(page, "Show commands and shortcuts")
    await wait(page, `document.querySelector('dialog[open]').textContent.includes('Ctrl+T') && document.querySelector('dialog[open]').textContent.includes('outside text fields')`)
    await page.pressKey("Escape", "Escape", 27)
    const collapsed = await page.evaluate<string | null>(`document.querySelector('.workspace').getAttribute('data-collapsed')`)
    await command(page, "Toggle navigation rail")
    await wait(page, `document.querySelector('.workspace').getAttribute('data-collapsed') !== ${JSON.stringify(collapsed)}`)
    await command(page, "Toggle navigation rail")
    const companion = await page.evaluate<string | null>(`document.querySelector('.workspace').getAttribute('data-companion-open')`)
    await command(page, "Toggle Session companion")
    await wait(page, `document.querySelector('.workspace').getAttribute('data-companion-open') !== ${JSON.stringify(companion)}`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered large pastes show a placeholder, copy, stash and restore their text and send the full text", async () => {
  const page = await open()
  const pasted = "line one\nline two @a.ts\nline three"
  const composer = `document.querySelector('.rl-capsule textarea')`
  try {
    await message(page, "Use @a.ts after ")
    await page.evaluate(`(() => { const input = ${composer}; input.focus(); input.setSelectionRange(input.value.length, input.value.length); const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(pasted)}); input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`)
    await wait(page, `${composer}.value === 'Use @a.ts after [Pasted ~3 lines]'`)
    expect(await page.evaluate<string>(`(() => { const input = ${composer}; input.setSelectionRange(0, input.value.length); const data = new DataTransfer(); input.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('text/plain'); })()`)).toBe(`Use @a.ts after ${pasted}`)
    await command(page, "Stash or restore the prompt")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Stash current draft').click()`)
    expect(await page.evaluate<unknown>(`(() => { const { text, pasted } = JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0]; return { text, pasted }; })()`)).toEqual({ text: "Use @a.ts after [Pasted ~3 lines]", pasted: [{ label: "[Pasted ~3 lines]", text: pasted }] })
    await wait(page, `${composer}.value === ''`)
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Pop and restore').click()`)
    await wait(page, `!document.querySelector('dialog[open]') && ${composer}.value === 'Use @a.ts after [Pasted ~3 lines]'`)
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `${composer}.value === ''`)
    expect(owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/prompt")).map((call) => call.body.text)).toEqual([`Use @a.ts after ${pasted}`])
  } finally { await page.evaluate(`localStorage.removeItem('ycoding.desktop.prompt-stashes')`); await page.close() }
}, 30_000)

test("rendered parity sends Auto, Queue and step-boundary Steer with distinct captured admissions", async () => {
  const page = await open()
  try {
    for (const [index, mode] of ["auto", "queue", "steer"].entries()) {
      await delivery(page, index)
      await message(page, `Synthetic ${mode} delivery`)
      await page.evaluate(`document.querySelector('.rl-send').click()`)
      await wait(page, `document.querySelector('.rl-capsule textarea').value === '' && !document.querySelector('[aria-label="Send mode"]').disabled`)
    }
    const prompts = owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/prompt"))
    expect(prompts.map((call) => call.body.delivery ?? "auto")).toEqual(["auto", "queue", "steer"])
    expect(new Set(prompts.map((call) => call.body.id)).size).toBe(3)
    expect(prompts.every((call) => !("steerNow" in call.body) && !("resume" in call.body))).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("rendered parity sends and steers now in admission, interruption and wake order", async () => {
  running = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="Send and steer now"]')`)
    await message(page, "Synthetic immediate steering")
    await page.evaluate(`document.querySelector('[aria-label="Send and steer now"]').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    const writes = owned!.calls.filter((call) => call.method !== "GET")
    expect(writes.map((call) => call.route)).toEqual(["/api/session/ses_test/prompt", "/api/session/ses_test/interrupt", "/api/session/ses_test/prompt"])
    expect(writes[0]!.body).toMatchObject({ text: "Synthetic immediate steering", delivery: "steer", resume: false })
    expect(writes[2]!.body).toEqual({ ...writes[0]!.body, resume: true })
  } finally { await page.close() }
}, 30_000)

test("rendered parity retains and locks an unconfirmed steer without waking or resubmitting it", async () => {
  running = true
  failInterrupt = true
  const page = await open()
  try {
    await wait(page, `document.querySelector('[aria-label="Send and steer now"]')`)
    await message(page, "Synthetic retained steer")
    await page.evaluate(`document.querySelector('[aria-label="Send and steer now"]').click()`)
    await wait(page, `document.body.textContent.includes('will not interrupt or wake again')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.rl-capsule textarea').value === 'Synthetic retained steer' && document.querySelector('.rl-capsule textarea').readOnly && document.querySelector('[aria-label="Send mode"]').disabled && document.querySelector('.rl-send').disabled`)).toBe(true)
    await page.evaluate(`document.querySelector('.rl-send').click(); document.querySelector('[aria-label="Send and steer now"]').click()`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => call.route)).toEqual(["/api/session/ses_test/prompt", "/api/session/ses_test/interrupt"])
  } finally { await page.close() }
}, 30_000)

test("rendered parity previews undo of an uncaptured message, restores its draft and clears the staged revert", async () => {
  const page = await open()
  try {
    await message(page, "/undo")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await confirm(page, "Cancel")
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
    expect(await page.evaluate<string>(`document.querySelector('.rl-capsule textarea').value`)).toBe("/undo")
    await wait(page, `!document.querySelector('.confirm[open]') && !document.querySelector('.rl-send').disabled`)
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.') && !document.querySelector('#turn-msg_prompt_239')`)
    expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Attached workspace files"]').textContent.includes('restored-notes.txt') && document.querySelector('[aria-label="Restored agent attachments"]').textContent.includes('reviewer')`)).toBe(true)
    expect(owned!.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([["/api/session/ses_test/revert/stage", { messageID: "msg_prompt_239", files: true }]])
    await command(page, "Redo the undone turn")
    await confirm(page)
    await wait(page, `document.querySelector('#turn-msg_prompt_239') && !document.body.textContent.includes('Staged revert · preview and confirmation required')`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => call.route)).toEqual(["/api/session/ses_test/revert/stage", "/api/session/ses_test/revert/clear"])
  } finally { await page.close() }
}, 30_000)

test("rendered parity stashes and restores file and agent attachments without sending a prompt", async () => {
  const page = await open()
  try {
    await message(page, "/undo")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await confirm(page)
    await wait(page, `document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.')`)
    await command(page, "/stash")
    await wait(page, `document.querySelector('dialog[open] h2')?.textContent === 'Prompt stashes'`)
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Stash current draft').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === '' && !document.querySelector('[aria-label="Attached workspace files"]') && !document.querySelector('[aria-label="Restored agent attachments"]')`)
    expect(await page.evaluate<string[]>(`JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0].files.map(file => file.name)`)).toEqual(["restored-notes.txt"])
    expect(await page.evaluate<{ name: string }[]>(`JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))[0].agents`)).toEqual([{ name: "reviewer" }])
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Pop and restore').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `!document.querySelector('dialog[open]') && document.querySelector('.rl-capsule textarea').value.startsWith('Synthetic prompt 239.') && document.querySelector('[aria-label="Attached workspace files"]')?.textContent.includes('restored-notes.txt') && document.querySelector('[aria-label="Restored agent attachments"]')?.textContent.includes('reviewer')`)
    expect(await page.evaluate<unknown[]>(`JSON.parse(localStorage.getItem('ycoding.desktop.prompt-stashes'))`)).toEqual([])
    expect(owned!.calls.filter((call) => call.route.endsWith('/prompt'))).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity stages reasoning while running and applies it before admitting the next message", async () => {
  running = true
  const page = await open()
  try {
    await command(page, "Choose a reasoning variant")
    await wait(page, `document.body.textContent.includes('Effort staged locally; not applied')`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
    await page.pressKey("Escape", "Escape", 27)
    running = false
    await page.evaluate(`window.__desktopFixture.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } })`)
    await wait(page, `!document.querySelector('[aria-label="Stop"]')`)
    await message(page, "Use the staged synthetic effort")
    await page.evaluate(`document.querySelector('.rl-send').click()`)
    await wait(page, `document.querySelector('.rl-capsule textarea').value === ''`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => [call.route, call.body])).toEqual([
      ["/api/session/ses_test/model", { model: { id: "synthetic", providerID: "synthetic", variant: "low" } }],
      ["/api/session/ses_test/prompt", expect.objectContaining({ text: "Use the staged synthetic effort" })],
    ])
  } finally { await page.close() }
}, 30_000)

test("rendered parity archives and restores with confirmation and reports sharing unavailable without a write", async () => {
  const page = await open()
  try {
    await command(page, "Archive the Session")
    await confirm(page, "Cancel")
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
    await command(page, "Archive the Session")
    await confirm(page)
    await wait(page, `window.__desktopFixture.completed.manageSession === 1`)
    await command(page, "Restore the archived Session")
    await confirm(page)
    await wait(page, `window.__desktopFixture.completed.manageSession === 2`)
    await command(page, "Inspect Session sharing availability")
    await wait(page, `document.body.textContent.includes('Session sharing is unavailable')`)
    expect(owned!.calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.route])).toEqual([["POST", "/api/session/ses_test/archive"], ["DELETE", "/api/session/ses_test/archive"]])
  } finally { await page.close() }
}, 30_000)

test("rendered parity moves between parent and sibling Sessions and focuses a chosen timeline message", async () => {
  familyEnabled = true
  const page = await open()
  try {
    await command(page, "Open the next subagent")
    await wait(page, `location.hash === '#/sessions/ses_child_a' && document.querySelector('#conversation-title').textContent.includes('ses_child_a')`)
    await command(page, "Open the next subagent")
    await wait(page, `location.hash === '#/sessions/ses_child_b' && document.querySelector('#conversation-title').textContent.includes('ses_child_b')`)
    await command(page, "Open the parent Session")
    await wait(page, `location.hash === '#/sessions/ses_test' && document.querySelector('#turn-msg_prompt_141')`)
    await command(page, "Show the session timeline")
    await wait(page, `document.querySelector('dialog h2')?.textContent === 'Session timeline'`)
    await page.evaluate(`document.querySelector('dialog .desktop-dialog__entries li button').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await wait(page, `document.activeElement.id === 'turn-msg_prompt_141'`)
    expect(owned!.calls.filter((call) => call.method !== "GET")).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("rendered parity confirms compaction with a canonical job ID and forks from the selected timeline message", async () => {
  const page = await open()
  try {
    await command(page, "Compact the conversation")
    await confirm(page)
    await wait(page, `document.body.textContent.includes('Compaction requested.')`)
    const compact = owned!.calls.find((call) => call.method === "POST" && call.route.endsWith("/compact"))
    expect(compact?.body.id).toMatch(/^cmp_/)
    expect(compact?.body).not.toHaveProperty("promptID")
    await command(page, "Show the session timeline")
    await wait(page, `document.querySelector('dialog h2')?.textContent === 'Session timeline'`)
    await page.evaluate(`[...document.querySelector('dialog .desktop-dialog__entries li').querySelectorAll('button')].find(button => button.textContent === 'Fork from this message').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    await confirm(page)
    await wait(page, `location.hash === '#/sessions/ses_fork'`)
    expect(owned!.calls.filter((call) => call.method === "POST" && call.route.endsWith("/fork")).map((call) => call.body)).toEqual([{ messageID: "msg_prompt_141" }])
  } finally { await page.close() }
}, 30_000)

test("rendered parity discards a file lookup after its mention closes and never exposes it in a later completion", async () => {
  const slow = Promise.withResolvers<void>(), slowReached = Promise.withResolvers<void>()
  const fast = Promise.withResolvers<void>(), fastReached = Promise.withResolvers<void>()
  fileGate = { query: "slow", reached: () => slowReached.resolve(), wait: slow.promise }
  const page = await open()
  try {
    await message(page, "@slow")
    await slowReached.promise
    await message(page, "Ordinary synthetic text")
    slow.resolve()
    await wait(page, `window.__desktopFixture.completed.findFiles === 1`)
    fileGate = { query: "fast", reached: () => fastReached.resolve(), wait: fast.promise }
    await message(page, "@fast")
    await fastReached.promise
    expect(await page.evaluate<boolean>(`document.querySelector('.composer-suggestions')?.textContent.includes('src/slow.ts') ?? false`)).toBe(false)
    fast.resolve()
    await wait(page, `document.querySelector('.composer-suggestions')?.textContent.includes('src/fast.ts')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.composer-suggestions').textContent.includes('src/slow.ts')`)).toBe(false)
  } finally { slow.resolve(); fast.resolve(); fileGate = undefined; await page.close() }
}, 30_000)
