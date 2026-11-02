import { expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { startRelayDouble } from "../test/relay-double"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to the pinned Chrome executable.")

const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: "/work" }, state: "idle", lastActivity: 5, pending: [] })
const summary = { id: "cgrp_1", name: "Atlas", revision: 1, active: true, masterSessionID: "ses_a", memberCount: 1, settings: { concurrency: 2 }, time: { created: 1, updated: 9 } }
const detail = { ...summary, master: participant("ses_a"), members: [participant("ses_b")] }
const catalog = { agents: [{ id: "god", name: "God", mode: "primary", hidden: false }, { id: "builder", name: "Builder", mode: "primary", hidden: false }, { id: "fail-helper", name: "Fail helper", mode: "subagent", hidden: false }], models: [{ providerID: "openai", id: "gpt-5", name: "GPT-5", variants: ["low", "high"] }], defaultModel: { providerID: "openai", id: "gpt-5" }, commands: [], skills: [], references: [], resources: [] }

async function harness(width: number, height: number, project = false) {
  let searches = 0
  let release: (() => void) | undefined
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a", "ses_b"],
    handler: async (request) => {
      if (request.operation === "session.catalog") return { ok: true, value: catalog }
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
      if (width < 768) await h.page.evaluate(`document.querySelector('[aria-label="Open sessions"]').click()`)
      const newSession = width < 768 ? '.overlay--sessions-sheet button[aria-label^="New session"]' : ".workspace-new-session button"
      await h.wait(`document.querySelector(${JSON.stringify(newSession)})?.getBoundingClientRect().width > 0`)
      await h.page.evaluate(`document.querySelector(${JSON.stringify(newSession)}).click()`)
      await h.wait(`location.pathname === '/remote' && document.querySelector('.new-session-composer__repository button')?.getBoundingClientRect().width > 0`)
      await h.page.evaluate(`document.querySelector('${nav} a[href="/remote/sessions"]').click()`)
      await h.wait(`location.pathname === '/remote/sessions'`)
      await h.wait(`document.querySelector('.sessions-table__row[data-session-id="ses_a"]')?.textContent.includes('Master · Atlas')`)
      await h.wait(`document.querySelector('.sessions-table__row[data-session-id="ses_b"]')?.textContent.includes('Member · Atlas')`)
      expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.session-filters button')].filter(item => item.getBoundingClientRect().width > 0).map(item => item.textContent.trim())`)).toEqual(["All", "Waiting", "Running", "Idle"])
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
}
