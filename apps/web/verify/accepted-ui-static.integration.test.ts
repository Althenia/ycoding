import { expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { startRelayDouble } from "../test/relay-double"
import { accountedTask } from "../test/usage-fixture"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome executable.")

const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: "/work" }, state: "idle", lastActivity: 5, pending: [] })
const summary = { id: "cgrp_1", name: "Atlas", revision: 1, active: true, masterSessionID: "ses_a", memberCount: 1, settings: { concurrency: 2 }, time: { created: 1, updated: 9 } }
const detail = { ...summary, master: participant("ses_a"), members: [participant("ses_b")] }
const catalog = { agents: [{ id: "god", name: "God", mode: "primary", hidden: false }, { id: "builder", name: "Builder", mode: "primary", hidden: false }, { id: "fail-helper", name: "Fail helper", mode: "subagent", hidden: false }], models: [{ providerID: "openai", id: "gpt-5", name: "GPT-5", variants: ["low", "high"] }], defaultModel: { providerID: "openai", id: "gpt-5" }, commands: [], skills: [], references: [], resources: [] }

async function harness(width: number, height: number, project = false, surfaces = false) {
  let searches = 0
  let release: (() => void) | undefined
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a", "ses_b"],
    handler: async (request) => {
      if (request.operation === "session.catalog") return { ok: true, value: catalog }
      if (surfaces && request.operation === "session.snapshot" && request.sessionID === "ses_a") {
        const model = { providerID: "openai", id: "gpt-5" }
        return { ok: true, value: { sourceEpoch: "epoch_1", session: { id: "ses_a", title: "Session A", model, time: { created: 1, updated: 4 } }, messages: [
          { id: "msg_user", type: "user", text: "Update the file", time: { created: 1, consumed: 2 } },
          { id: "msg_assistant", type: "assistant", agent: "god", model, content: [{ type: "text", text: "Updated the file." }], tokens: { input: 24_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, diagnostics: { contextLimit: 128_000 }, time: { created: 3, completed: 4 } },
        ], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 } } }
      }
      if (surfaces && request.operation === "session.capturedChanges.list") return { ok: true, value: { data: [{ placementMessageID: "msg_assistant", path: "src/app.ts", additions: 2, deletions: 1, status: "modified", files: [{ path: "src/app.ts", additions: 2, deletions: 1, status: "modified", diff: "@@ -1 +1,2 @@\n-const old = 1\n+const next = 2\n+export { next }" }] }] } }
      if (surfaces && request.operation === "session.subagent.list") return { ok: true, value: { data: [{ sessionID: "ses_child", parentID: "ses_a", description: "Inspect file", agent: "builder", state: "running", revision: 1, time: { created: 1, updated: 2 } }], summary: { total: 1, active: 1 }, cursor: {} } }
      if (surfaces && request.operation === "session.taskCosts") return { ok: true, value: { data: { tasks: [accountedTask("ses_child")], total: accountedTask("ses_child").total, history: "retained" } } }
      if (surfaces && request.operation === "session.team.economics") return { ok: true, value: { data: [{ sessionID: "ses_child", cost: 0.25, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } }, cacheHitRatio: 0.75, contextTotal: 800, contextLimit: 2_000, cacheRead: 3, cacheWrite: 0 }] } }
      if (surfaces && request.operation === "session.team.shell.list") return { ok: true, value: { data: [] } }
      if (surfaces && request.operation === "session.side-chat.list") return { ok: true, value: { data: [], cursor: {} } }
      if (surfaces && request.operation === "incident.report") return { ok: true, value: { data: { rows: [], groups: 0 } } }
      if (surfaces && request.operation === "incident.recent") return { ok: true, value: { data: { items: [] } } }
      if (surfaces && request.operation === "usage.dashboard") {
        const total = { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
        const report = (slot: unknown) => ({ group: typeof slot === "object" && slot !== null ? Reflect.get(slot, "group") : "day", rows: [], total, rowCount: 0 })
        return { ok: true, value: { data: { status: "ready", asOf: Date.now(), revision: "fixture", summary: total, live: { asOf: Date.now(), active: 0, streaming: 0, models: [], history: [] }, quota: { status: "ready", providers: [{ providerID: "openai", label: "Codex", status: "available", source: "provider_api", stability: "stable", updatedAt: Date.now(), windows: [{ id: "week", label: "Weekly", unit: "percent", used: 40, limit: 100 }] }], forecast: { asOf: Date.now(), localScope: "backend", localRates: [], quotas: [] } }, daily: report(request.input?.daily), monthly: report(request.input?.monthly), breakdown: report(request.input?.breakdown) } } }
      }
      if (request.operation === "session.review.list") return { ok: true, value: { data: [] } }
      if (request.operation === "coordination.list") return { ok: true, value: { data: project ? [summary] : [] } }
      if (request.operation === "coordination.get") return { ok: true, value: { data: detail } }
      if (request.operation === "coordination.settings") return { ok: true, value: { data: { enabled: true, categories: ["question", "permission", "review"] } } }
      if (request.operation === "session.attachment.upload" && typeof request.input?.uploadID === "string") return { ok: true, value: { uri: `ycoding-upload://${request.input.uploadID}` } }
      if (request.operation === "session.file.find") {
        searches++
        if (request.input?.query === "empty") {
          await new Promise<void>((resolve) => { release = resolve })
          return { ok: true, value: { files: [] } }
        }
        if (request.input?.query === "fail" && searches === 2) return { ok: false, code: "internal_error", message: "Search failed" }
        const path = request.input?.query === "fail" ? "src/fail.ts" : "src/file.ts"
        return { ok: true, value: { files: [{ path, uri: `file:///work/${path}`, kind: "file" }] } }
      }
      return "default"
    },
    fallback: async (request) => {
      const pathname = new URL(request.url).pathname
      const path = pathname.startsWith("/remote") || pathname === "/" ? "/index.html" : pathname
      const file = Bun.file(new URL(`../dist${path}`, import.meta.url))
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  const browser = await launchBrowser(executable!, width, height)
  const page = await browser.openPage()
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
      await Bun.sleep(30)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  await page.navigate(`${relay.httpURL}/remote/session?session_id=ses_a&device_id=dev_1`)
  await wait(`document.querySelector('.composer-resident:not([inert]) .composer__input')`)
  const input = async (value: string) => page.evaluate(`(() => { const field=document.querySelector('.composer-resident:not([inert]) .composer__input'); field.value=${JSON.stringify(value)}; field.setSelectionRange(field.value.length,field.value.length); field.dispatchEvent(new InputEvent('input',{bubbles:true})); })()`)
  const waitRequest = async (operation: string) => {
    for (let i = 0; i < 200; i++) { if (relay.requests.some((request) => request.operation === operation)) return; await Bun.sleep(30) }
    throw new Error(`Timed out waiting for ${operation}`)
  }
  return { relay, browser, page, wait, waitRequest, input, release: () => release?.(), close: async () => { await page.close(); await browser.close(); await relay.stop() } }
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`workspace search reports loading, empty, failure and retry at ${width}`, async () => {
    const h = await harness(width, height)
    try {
      await h.input("@empty")
      await h.wait(`document.body.textContent.includes('Searching project files…')`)
      await h.waitRequest("session.file.find")
      h.release()
      await h.wait(`document.body.textContent.includes('No matching files in this workspace.')`)
      await h.input("@fail")
      await h.wait(`document.querySelector('[aria-label="Retry file search"]')`)
      expect(await h.page.evaluate<number>(`document.querySelectorAll('.mini-composer__autocomplete [role=option]').length`)).toBe(0)
      await h.page.evaluate(`document.querySelector('[aria-label="Retry file search"]').click()`)
      await h.wait(`[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes('src/fail.ts'))`)
    } finally { h.release(); await h.close() }
  }, 30000)

  test(`session drafts retain files and mentions across switches and clear after send at ${width}`, async () => {
    const h = await harness(width, height)
    try {
      await h.wait(`document.querySelector('.composer-resident:not([inert]) button[aria-label="Agent"]:not([disabled])')`)
      await h.page.evaluate(`document.querySelector('.composer-resident:not([inert]) button[aria-label="Agent"]').click()`)
      await h.wait(`[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes('Builder'))`)
      await h.page.evaluate(`[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('Builder')).click()`)
      await h.input("@file")
      await h.wait(`[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes('src/file.ts'))`)
      await h.page.evaluate(`[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('src/file.ts')).click()`)
      await h.page.evaluate(`(() => { const input=document.querySelector('.composer-resident:not([inert]) input[type=file]'); const dt=new DataTransfer(); dt.items.add(new File(['hello'],'test.txt',{type:'text/plain'})); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await h.wait(`document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary')`)
      expect(await h.page.evaluate<string>(`document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary').textContent`)).toBe("1/64 files · 5 B / 40 MiB · 20 MiB per-file limit")
      if (width < 768) await h.page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
      await h.wait(`document.querySelector('.session-row[data-session-id="ses_b"]')`)
      await h.page.evaluate(`document.querySelector('.session-row[data-session-id="ses_b"]').click()`)
      await h.wait(`document.querySelector('.composer-resident:not([inert]) .composer__input')?.value === ''`)
      expect(await h.page.evaluate<boolean>(`!document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary')`)).toBe(true)
      if (width < 768) await h.page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
      await h.wait(`document.querySelector('.session-row[data-session-id="ses_a"]')`)
      await h.page.evaluate(`document.querySelector('.session-row[data-session-id="ses_a"]').click()`)
      await h.wait(`document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary')`)
      expect(await h.page.evaluate<string>(`document.querySelector('.composer-resident:not([inert]) button[aria-label="Agent"]').textContent`)).toContain("Builder")
      await h.page.evaluate(`document.querySelector('.composer-resident:not([inert]) [aria-label="Send prompt"]').click()`)
      await h.wait(`!document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary')`)
      await h.waitRequest("session.prompt")
      const prompt = h.relay.requests.find((request) => request.operation === "session.prompt")
      expect(h.relay.requests.find((request) => request.operation === "session.switchAgent")?.input?.agent).toBe("builder")
      expect(prompt?.input?.files).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "file:///work/src/file.ts" }), expect.objectContaining({ name: "test.txt" })]))
      await h.wait(`document.querySelector('.composer-resident:not([inert]) button[aria-label="Agent"]').textContent.includes('God')`)
      await h.input("@src/file.ts ")
      await h.page.evaluate(`document.querySelector('.composer-resident:not([inert]) [aria-label="Send prompt"]').click()`)
      for (let i = 0; i < 200 && h.relay.requests.filter((request) => request.operation === "session.prompt").length < 2; i++) await Bun.sleep(30)
      const prompts = h.relay.requests.filter((request) => request.operation === "session.prompt")
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.input?.files).toBeUndefined()
    } finally { await h.close() }
  }, 30000)

  test(`verified membership and explicit motion off render at ${width}`, async () => {
    const h = await harness(width, height, true)
    try {
      await h.wait(`document.body.textContent.includes('Atlas')`)
      const nav = width < 768 ? ".bottom-nav" : ".remote-nav"
      expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('${nav} a[href]')].filter(item => item.getBoundingClientRect().width > 0).map(item => item.getAttribute('href'))`)).toEqual(expect.arrayContaining(["/remote/sessions", "/remote/usage", "/remote/settings"]))
      await h.wait(`document.querySelector('[aria-label="Open Team"]:not([inert])')?.getBoundingClientRect().width > 0`)
      await h.waitRequest("session.review.list")
      expect(await h.page.evaluate<boolean>(`document.body.textContent.includes('Review items could not be loaded')`)).toBe(false)
      if (width < 768) {
        await h.page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
        await h.wait(`document.querySelector('.overlay--sessions-sheet') !== null`)
        await h.page.pressEscape()
        await h.wait(`document.querySelector('.overlay--sessions-sheet') === null`)
      }
      const newSession = width < 768 ? '.conversation-header__actions .new-session__trigger[aria-label^="New chat"]' : ".workspace-new-session button"
      await h.wait(`document.querySelector(${JSON.stringify(newSession)})?.getBoundingClientRect().width > 0`)
      if (width < 768) {
        const hit = await h.page.evaluate<{ x: number; y: number; reachable: boolean }>(`(() => { const button=document.querySelector(${JSON.stringify(newSession)}), rect=button.getBoundingClientRect(), x=rect.left+rect.width/2, y=rect.top+rect.height/2; return { x, y, reachable: rect.width > 0 && rect.height > 0 && !button.disabled && !button.closest('[inert], [aria-hidden="true"]') && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && button.contains(document.elementFromPoint(x,y)) } })()`)
        expect(hit.reachable).toBe(true)
        await h.page.mouse("mousePressed", hit.x, hit.y)
        await h.page.mouse("mouseReleased", hit.x, hit.y)
      } else await h.page.evaluate(`document.querySelector(${JSON.stringify(newSession)}).click()`)
      await h.wait(`location.pathname === '/remote' && document.querySelector('.new-session-composer__repository button')?.getBoundingClientRect().width > 0`)
      await h.page.evaluate(`document.querySelector('${nav} a[href="/remote/sessions"]').click()`)
      await h.wait(`location.pathname === '/remote/sessions'`)
      await h.wait(`document.querySelector('.sessions-table__row[data-session-id="ses_a"]')?.textContent.includes('Master · Atlas')`)
      await h.wait(`document.querySelector('.sessions-table__row[data-session-id="ses_b"]')?.textContent.includes('Member · Atlas')`)
      expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.session-filters button')].filter(item => item.getBoundingClientRect().width > 0).map(item => item.textContent.trim())`)).toEqual(["All (2)", "Waiting (0)", "Running (0)", "Idle (2)"])
      await h.page.evaluate(`document.querySelector('.sessions-table__row[data-session-id="ses_a"] .sessions-table__select').click()`)
      await h.wait(`location.pathname === '/remote/session' && document.querySelector('.composer-resident:not([inert]) .composer__input')`)
      await h.wait(`document.querySelector('[aria-label="Open Team"]:not([inert])')?.getBoundingClientRect().width > 0`)
      const directory = process.env.YCODING_WEB_CAPTURE_DIR
      if (directory) {
        await mkdir(directory, { recursive: true })
        await Bun.write(join(directory, `accepted-ui-${width}-${crypto.randomUUID()}.png`), Buffer.from(await h.page.screenshot(), "base64"))
      }
      if (width < 768) await h.page.evaluate(`document.querySelector('.composer-resident:not([inert]) .composer__mobile-trigger').click()`)
      await h.wait(`document.querySelector('.composer-resident:not([inert]) .model-control__trigger:not([disabled])')`)
      await h.page.evaluate(`document.querySelector('.composer-resident:not([inert]) .model-control__trigger').click(); document.documentElement.dataset.motion='off'`)
      await h.wait(`document.querySelector('.model-control__surface .model-control__sparkles i')`)
      const animations = await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__surface .model-control__sparkles,.model-control__surface .model-control__sparkles i')].map(item=>getComputedStyle(item).animationName)`)
      expect(animations.length).toBeGreaterThan(1)
      expect(animations.every((animation) => animation === "none")).toBe(true)
    } finally { await h.close() }
  }, 30000)

  test(`a transient relay reconnect preserves target attachments while connection replacement invalidates them at ${width}`, async () => {
    const h = await harness(width, height)
    try {
      await h.page.evaluate(`(() => { const input=document.querySelector('.composer-resident:not([inert]) input[type=file]'); const dt=new DataTransfer(); dt.items.add(new File(['hello'],'test.txt')); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await h.wait(`document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary')`)
      h.relay.dropConnections(1012, "restart")
      for (let i = 0; i < 400 && h.relay.connections < 2; i++) await Bun.sleep(30)
      expect(h.relay.connections).toBeGreaterThanOrEqual(2)
      await h.wait(`document.querySelector('.composer-resident:not([inert]) .composer__input:not([disabled])')`)
      expect(await h.page.evaluate<boolean>(`document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary') !== null`)).toBe(true)
      h.relay.dropConnections(4403, "revoked")
      for (let i = 0; i < 400 && h.relay.connections < 3; i++) await Bun.sleep(30)
      expect(h.relay.connections).toBeGreaterThanOrEqual(3)
      await h.wait(`location.search.includes('ses_a') && document.querySelector('.composer-resident:not([inert]) .composer__input:not([disabled])')`)
      expect(await h.page.evaluate<boolean>(`document.querySelector('.composer-resident:not([inert]) .composer__attachments-summary') === null`)).toBe(true)
    } finally { await h.close() }
  }, 30000)

  test(`team helper, context window, diff review, usage and settings render at ${width}`, async () => {
    const h = await harness(width, height, false, true)
    try {
      if (width < 768) {
        await h.wait(`document.querySelector('.composer__mobile-context-ring')`)
        await h.page.evaluate(`document.querySelector('.composer-resident:not([inert]) .composer__mobile-trigger').click()`)
        await h.wait(`document.querySelector('.composer__selection-sheet .composer__context-summary')`)
      } else {
        await h.wait(`document.querySelector('.composer__context-trigger')`)
        await h.page.evaluate(`document.querySelector('.composer__context-trigger').click()`)
        await h.wait(`document.querySelector('.composer__context-popover')`)
      }
      const context = width < 768 ? ".composer__selection-sheet .composer__context-summary" : ".composer__context-popover"
      expect(await h.page.evaluate<string>(`document.querySelector('${context}').textContent`)).toContain("19% used · 81% left")
      await h.page.pressEscape()
      await h.wait(`document.querySelector('.file-change-card__summary')?.textContent.includes('1 file changed')`)
      await h.page.evaluate(`document.querySelector('.file-change-card__summary').click()`)
      await h.wait(`document.querySelector('.file-change-card__file-toggle')?.textContent.includes('app.ts')`)
      await h.page.evaluate(`document.querySelector('.file-change-card__file-toggle').click()`)
      expect(await h.page.evaluate<boolean>(`(() => { const node = document.querySelector(${JSON.stringify(width < 768 ? '.file-change-card__unified' : '.file-change-card__split')}); return node && getComputedStyle(node).display !== 'none' && node.textContent.includes('const old = 1') && node.textContent.includes('const next = 2') ${width < 768 ? '' : "&& node.textContent.includes('Old') && node.textContent.includes('New')"}; })()`)).toBe(true)
      await h.wait(`document.querySelector('[aria-label="Open Team"]:not([inert])')`)
      await h.page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      await h.wait(`document.querySelector('.team-view__usage .team-view__meter')`)
      expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.team-view__tabs [role=tab] .team-view__tab-label')].map(item => item.textContent)`)).toEqual(["Subagents", "Shell", "Side chats"])
      expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.team-view__usage dt')].map(item => item.textContent)`)).toEqual(["Tokens (inclusive)", "Cost (inclusive)", "Context", "Cache"])
      if (width < 768) await h.page.pressEscape()
      else await h.page.evaluate(`document.querySelector('[aria-label="Close Team"]').click()`)
      const nav = width < 768 ? ".bottom-nav" : ".remote-nav"
      await h.page.evaluate(`document.querySelector('${nav} a[href="/remote/usage"]').click()`)
      await h.wait(`location.pathname === '/remote/usage' && document.body.textContent.includes('Model incidents')`)
      for (const label of ["Today", "Yesterday", "Last 30 days", "Codex", "Model incidents"]) await h.wait(`document.querySelector('.usage-page')?.textContent.includes(${JSON.stringify(label)})`)
      await h.page.evaluate(`document.querySelector('${nav} a[href="/remote/settings"]').click()`)
      await h.wait(`location.pathname === '/remote/settings' && document.body.textContent.includes('Keep machine awake')`)
      for (const label of ["Machine", "Studio Mac", "Keep machine awake", "Appearance", "Notifications"]) await h.wait(`document.querySelector('.settings')?.textContent.includes(${JSON.stringify(label)})`)
    } finally { await h.close() }
  }, 30000)
}
