import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { startRelayDouble } from "../test/relay-double"
import { readModelRef, type ModelRefView } from "../src/remote/projection"

const port = 4426
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/model-replay-fixture.html`).then((response) => response.ok, () => false)) { browser = await launchBrowser(executable, 1440, 900); return }
    await Bun.sleep(100)
  }
  throw new Error("Model fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const models = [
  { providerID: "openai", id: "model-a", name: "Model A", variants: ["low", "high", "max"] },
  { providerID: "openai", id: "model-a-fast", name: "Model A Fast", variants: ["medium", "high"] },
  { providerID: "openai", id: "model-b", name: "Model B", variants: ["low", "high"] },
  { providerID: "openai", id: "model-c", name: "Model C", variants: ["medium", "high"] },
  { providerID: "openai", id: "model-plain", name: "Model Plain", variants: [] },
]
type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function harness(initial: ModelRefView | null = { providerID: "openai", id: "model-a", variant: "max" }, preferred?: ModelRefView) {
  let current: ModelRefView | undefined = initial ?? undefined
  let refused = false
  const session = () => ({ id: "ses_a", title: "Model replay", agent: "god", model: current, time: { created: 1, updated: 2 } })
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a"],
    snapshot: () => ({ session: session(), messages: [], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 } }),
    handler: (request) => {
      if (request.operation === "session.catalog" || request.operation === "workspace.catalog") return { ok: true, value: { defaultModel: { providerID: "openai", id: "model-a" }, agents: [{ id: "god", name: "God", mode: "primary" }], models, commands: [], skills: [], references: [], resources: [] } }
      if (request.operation === "session.list") return { ok: true, value: { data: [session()], cursor: {} } }
      if (request.operation === "session.get") return { ok: true, value: { data: session() } }
      if (request.operation !== "session.switchModel") return "default"
      if (refused) return { ok: false, code: "forbidden", message: "Switch refused" }
      const chosen = readModelRef(request.input?.model)
      if (!chosen) return { ok: false, code: "invalid_message", message: "Invalid model reference" }
      current = chosen
      relay.pushEvent("ses_a", { type: "session.model.selected", data: { sessionID: "ses_a", model: current } })
      return { ok: true, value: { data: session() } }
    },
  })
  const page = await browser!.openPage()
  if (preferred) await page.injectOnNewDocument(`localStorage.setItem('ycoding.remote.preferred-model',${JSON.stringify(JSON.stringify(preferred))})`)
  await page.navigate(`http://127.0.0.1:${port}/verify/model-replay-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}`)
  await wait(page, `window.modelReplayStore?.state().transport.kind === 'open' && window.modelReplayStore.state().sessions.length > 0`)
  await page.evaluate(`window.modelReplayStore.selectSession('ses_a')`)
  await wait(page, `document.querySelector('.model-control__trigger')?.disabled === false`)
  return { page, relay, current: () => current, refuse: () => { refused = true }, external: (model: ModelRefView) => { current = model; relay.pushEvent("ses_a", { type: "session.model.selected", data: { sessionID: "ses_a", model } }) }, close: async () => { await page.close(); await relay.stop() } }
}
async function choose(page: Page, name: string) {
  await page.evaluate(`document.querySelector('.model-control__trigger').click()`)
  await page.evaluate(`document.querySelector('.model-control__switch').click()`)
  await page.evaluate(`[...document.querySelectorAll('.model-control__model')].find(option=>option.textContent.startsWith(${JSON.stringify(name)})).click()`)
  await page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
}
async function send(page: Page, text: string) {
  await page.evaluate(`(() => { const field=document.querySelector('.mini-composer__mount textarea'); field.value=${JSON.stringify(text)}; field.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[aria-label="Send prompt"]').click(); })()`)
}
async function effort(page: Page, value: string) {
  await page.evaluate(`document.querySelector('.model-control__trigger').click()`)
  await page.evaluate(`document.querySelector('[aria-label="Reset reasoning effort"]').click()`)
  if (value !== "Base") {
    await page.evaluate(`document.querySelector('[role="slider"]').focus()`)
    await page.pressKey("End", "End", 35)
  }
  await page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
}

test("each model restores its own valid effort instead of another model's effort or its default", async () => {
  const h = await harness()
  try {
    await choose(h.page, "Model B")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Base")
    await choose(h.page, "Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("max")
    await choose(h.page, "Model B")
    await effort(h.page, "high")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("high")
    await choose(h.page, "Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("max")
    await effort(h.page, "Base")
    await choose(h.page, "Model B")
    await choose(h.page, "Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Base")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
  } finally { await h.close() }
})

test("invalid incoming effort blocks ordinary sends until an explicit valid Base intent without rewriting the Session on read", async () => {
  const h = await harness({ providerID: "openai", id: "model-b", variant: "max" })
  try {
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toContain("Unavailable")
    expect(await h.page.evaluate<string>(`document.querySelector('.composer__model-warning').textContent`)).toContain("max")
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    expect(await h.page.evaluate<unknown>(`({hero:document.querySelector('.model-control__switch strong').textContent,slider:document.querySelector('[role="slider"]')!==null})`)).toEqual({ hero: "Unavailable: max", slider: false })
    expect(h.current()?.variant).toBe("max")
    expect(await h.page.evaluate<string>(`window.modelReplayStore.state().selectedSessionInfo.model.variant`)).toBe("max")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
    await h.page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
    await send(h.page, "Retain invalid draft")
    expect(await h.page.evaluate<string>(`document.querySelector('textarea').value`)).toBe("Retain invalid draft")
    expect(h.relay.requests.filter((request) => request.operation === "session.prompt" || request.operation === "session.switchModel")).toHaveLength(0)
    await effort(h.page, "Base")
    await send(h.page, "Use explicit Base")
    await wait(h.page, `window.modelReplayStore.state().mutations.every(mutation=>mutation.state!=='sending') && document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-b" })
  } finally { await h.close() }
})

test("a confirmed local choice releases its override, an external model then owns ordinary sends, and a failed switch admits no prompt", async () => {
  const h = await harness()
  try {
    await choose(h.page, "Model B")
    await effort(h.page, "high")
    const beforeRead = await h.page.evaluate<number>(`window.modelReplayStore.state().view.updatedAt ?? 0`)
    h.external({ providerID: "openai", id: "model-a", variant: "max" })
    await wait(h.page, `window.modelReplayStore.state().view.updatedAt > ${beforeRead}`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model B")
    await send(h.page, "Confirm B")
    await wait(h.page, `window.modelReplayStore.state().selectedSessionInfo?.model?.id === 'model-b' && document.querySelector('textarea').value === ''`)
    h.external({ providerID: "openai", id: "model-c", variant: "medium" })
    await wait(h.page, `window.modelReplayStore.state().selectedSessionInfo?.model?.id === 'model-c'`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model C")
    await send(h.page, "Follow C")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    expect(h.current()).toEqual({ providerID: "openai", id: "model-c", variant: "medium" })
    expect(h.relay.requests.filter((request) => request.operation === "session.prompt").at(-1)?.input?.model).toBeUndefined()
    h.refuse()
    await choose(h.page, "Model A")
    await send(h.page, "Retain on refusal")
    await wait(h.page, `window.modelReplayStore.state().mutations.some(mutation=>mutation.kind==='model' && mutation.state==='failed')`)
    expect(h.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(2)
    expect(await h.page.evaluate<string>(`document.querySelector('textarea').value`)).toBe("Retain on refusal")
  } finally { await h.close() }
})

test("a no-effort model needs explicit Base intent for obsolete effort and a fast counterpart uses omission when it cannot retain effort", async () => {
  const plain = await harness({ providerID: "openai", id: "model-plain", variant: "max" })
  try {
    expect(await plain.page.evaluate<boolean>(`document.querySelector('.model-control__effort') === null`)).toBe(true)
    expect(await plain.page.evaluate<string>(`document.querySelector('.composer__model-warning').textContent`)).toContain("max")
    await effort(plain.page, "Base")
    await send(plain.page, "Use plain model")
    await wait(plain.page, `document.querySelector('textarea').value === ''`)
    expect(plain.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-plain" })
  } finally { await plain.close() }
  const fast = await harness()
  try {
    await fast.page.evaluate(`document.querySelector('.model-control__trigger').click(); document.querySelector('[aria-label="Fast model"]').click(); document.querySelector('[aria-label="Close model picker"]').click()`)
    await send(fast.page, "Use fast model")
    await wait(fast.page, `document.querySelector('textarea').value === ''`)
    expect(fast.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-a-fast" })
  } finally { await fast.close() }
})

test("an omitted effort stays Base with authoritative diagnostics and no inferred effort or extra model switch", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" })
  try {
    const sample = { model: h.current(), tokens: 12, durationNs: 2_000_000_000, tokensPerSecond: 6 }
    h.relay.pushEvent("ses_a", { type: "session.diagnostics.updated", data: { sessionID: "ses_a", diagnostics: { model: h.current(), context: { total: 800, limit: 2_000 }, generationSpeed: { latest: sample, recent: [sample] } } } })
    await wait(h.page, `window.modelReplayStore.state().view.contextWindow?.used === 800`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Base")
    expect(await h.page.evaluate<string>(`document.querySelector('.composer__speed')?.textContent ?? ''`)).toContain("6 tok/s")
    expect(await h.page.evaluate<boolean>(`document.querySelector('.composer__context-trigger') !== null`)).toBe(true)
    await send(h.page, "Keep the actual model")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
    expect(h.relay.requests.find((request) => request.operation === "session.prompt")?.input?.model).toBeUndefined()
  } finally { await h.close() }
})

test("an existing Session without a model uses the catalog base, not the stored new-session preference", async () => {
  const preferred = { providerID: "openai", id: "model-b", variant: "high" }
  const h = await harness(null, preferred)
  try {
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Base")
    expect(await h.page.evaluate<unknown>(`window.modelReplayStore.state().selectedSessionInfo.model`)).toBeUndefined()
    await send(h.page, "Use the runtime default")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
    expect(h.relay.requests.find((request) => request.operation === "session.prompt")?.input?.model).toBeUndefined()
    expect(h.current()).toBeUndefined()
    expect(await h.page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.preferred-model'))`)).toEqual(preferred)
    await h.page.evaluate(`window.modelReplayShowWorkspace()`)
    await wait(h.page, `document.querySelector('.model-control__trigger')?.disabled === false`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model B")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("high")
  } finally { await h.close() }
})
