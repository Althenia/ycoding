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
  { providerID: "anthropic", providerName: "Anthropic", id: "claude-1", name: "Claude 1", variants: ["low", "high"] },
  { providerID: "anthropic", providerName: "Anthropic", id: "claude-2", name: "Claude 2", variants: ["low", "high"] },
  { providerID: "openai", providerName: "OpenAI", id: "model-a", name: "Model A", variants: ["low", "high", "max"], profiles: [{ name: "profileA", active: true, variants: ["high"] }, { name: "profileB", active: false, variants: ["low"] }] },
  { providerID: "openai", providerName: "OpenAI", id: "model-a-fast", name: "Model A Fast", variants: ["medium", "high"] },
  { providerID: "openai", providerName: "OpenAI", id: "model-b", name: "Model B", variants: ["low", "high"] },
  { providerID: "openai", providerName: "OpenAI", id: "model-c", name: "Model C", variants: ["medium", "high"] },
  { providerID: "openai", providerName: "OpenAI", id: "model-d", name: "Model D", variants: ["default", "none"] },
  { providerID: "openai", providerName: "OpenAI", id: "model-plain", name: "Model Plain", variants: [] },
]
type Page = Awaited<ReturnType<NonNullable<typeof browser>["openPage"]>>
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function harness(initial: ModelRefView | null = { providerID: "openai", id: "model-a", variant: "max" }, preferred?: ModelRefView, defaultModel: ModelRefView = { providerID: "openai", id: "model-a" }, viewport: readonly [number, number] = [1440, 900]) {
  let current: ModelRefView | undefined = initial ?? undefined
  let catalogModels = models
  let refused = false
  let promptUnknown = false
  let sessionRevision = 2
  const session = () => ({ id: "ses_a", title: "Model replay", agent: "god", model: current === undefined ? undefined : { ...current }, time: { created: 1, updated: sessionRevision++ } })
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a"],
    snapshot: () => ({ session: session(), messages: [], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 } }),
    handler: (request) => {
      if (request.operation === "session.catalog" || request.operation === "workspace.catalog") return { ok: true, value: { defaultModel, agents: [{ id: "god", name: "God", mode: "primary" }], models: catalogModels, commands: [{ name: "plan", description: "Plan" }], skills: [], references: [], resources: [] } }
      if (request.operation === "session.list") return { ok: true, value: { data: [session()], cursor: {} } }
      if (request.operation === "session.get") return { ok: true, value: { data: session() } }
      if (request.operation === "session.prompt" && promptUnknown) {
        promptUnknown = false
        return { ok: false, code: "outcome_unknown", message: "Admission answer was lost" }
      }
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
  await page.setViewport(viewport[0], viewport[1])
  if (viewport[0] === 390) await page.setCoarsePointer(true)
  const storageSession = crypto.randomUUID()
  await page.injectOnNewDocument(`if(localStorage.getItem('__modelReplayStorageSession')!==${JSON.stringify(storageSession)}){localStorage.removeItem('ycoding.remote.recent-models');localStorage.removeItem('ycoding.remote.preferred-model');localStorage.setItem('__modelReplayStorageSession',${JSON.stringify(storageSession)})}${preferred ? `localStorage.setItem('ycoding.remote.preferred-model',${JSON.stringify(JSON.stringify(preferred))})` : ""}`)
  await page.navigate(`http://127.0.0.1:${port}/verify/model-replay-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}`)
  await wait(page, `window.modelReplayStore?.state().transport.kind === 'open' && window.modelReplayStore.state().sessions.length > 0`)
  await page.evaluate(`window.modelReplayStore.selectSession('ses_a')`)
  await wait(page, `document.querySelector('.model-control__trigger')?.disabled === false`)
  return { page, relay, current: () => current, refuse: () => { refused = true }, failNextPrompt: () => { promptUnknown = true }, refreshSessionInfo: () => relay.pushSessions(["ses_a"]), setCatalogModels: (next: typeof models) => { catalogModels = next }, external: (model: ModelRefView) => { current = model; relay.pushEvent("ses_a", { type: "session.model.selected", data: { sessionID: "ses_a", model } }) }, close: async () => { await page.close(); await relay.stop() } }
}
async function choose(page: Page, name: string) {
  await page.evaluate(`document.querySelector('.model-control__trigger').click()`)
  await page.evaluate(`document.querySelector('.model-control__switch').click()`)
  await page.evaluate(`[...document.querySelectorAll('.model-control__model')].find(option=>option.textContent.startsWith(${JSON.stringify(name)})).click()`)
  await page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
}
async function openModelList(page: Page) {
  await page.evaluate(`document.querySelector('.model-control__trigger').click()`)
  await page.evaluate(`document.querySelector('.model-control__switch').click()`)
}
async function send(page: Page, text: string) {
  await page.evaluate(`(() => { const field=document.querySelector('.mini-composer__mount textarea'); field.value=${JSON.stringify(text)}; field.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[aria-label="Send prompt"]').click(); })()`)
}
async function waitForOperation(relay: Awaited<ReturnType<typeof startRelayDouble>>, operation: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (relay.requests.some((request) => request.operation === operation)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out waiting for ${operation}`)
}
async function effort(page: Page, value: string) {
  await page.evaluate(`document.querySelector('.model-control__trigger').click()`)
  await page.evaluate(`document.querySelector('[aria-label="Clear reasoning effort override"]').click()`)
  if (value !== "Model settings") {
    await page.evaluate(`document.querySelector('[role="slider"]').focus()`)
    await page.pressKey("End", "End", 35)
  }
  await page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
}

test("omitted effort is not an offered slider stop and clearing stays separate from variant selection", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" })
  try {
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Model settings")
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__labels span')].map(node=>node.textContent)`)).toEqual(["low", "high", "max"])
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("No effort override")
    await h.page.evaluate(`document.querySelector('[role="slider"]').focus()`)
    await h.page.pressKey("Home", "Home", 36)
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("low")
    await h.page.evaluate(`document.querySelector('[aria-label="Clear reasoning effort override"]').click()`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__switch strong').textContent`)).toBe("Model settings")
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("No effort override")
    expect(await h.page.evaluate<unknown>(`window.modelReplayStore.state().selectedSessionInfo.model`)).toEqual({ providerID: "openai", id: "model-a" })
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
  } finally { await h.close() }
})

test("provider-offered none and default remain selectable explicit variants", async () => {
  const h = await harness()
  try {
    await choose(h.page, "Model D")
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__labels span')].map(node=>node.textContent)`)).toEqual(["none", "default"])
    await h.page.evaluate(`document.querySelector('[role="slider"]').focus()`)
    await h.page.pressKey("Home", "Home", 36)
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("none")
    await h.page.pressKey("End", "End", 35)
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("default")
    await h.page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
    await send(h.page, "Use offered default")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-d", variant: "default" })
  } finally { await h.close() }
})

test("explicit provider profiles switch before prompts, fail closed, and never activate a global integration", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" })
  try {
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__trigger').textContent`)).toContain("profileA")
    await send(h.page, "Profile A")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel").at(-1)?.input?.model).toEqual({ providerID: "openai", id: "model-a", profile: "profileA" })
    expect(h.relay.requests.some((request) => String(request.operation) === "integration.activate")).toBe(false)
    expect(await h.page.evaluate<boolean>(`document.querySelector('.composer__model-warning') === null`)).toBe(true)
  } finally { await h.close() }

  const failed = await harness({ providerID: "openai", id: "model-a" })
  try {
    failed.refuse()
    await failed.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await failed.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await failed.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileB')).click()`)
    await send(failed.page, "Do not send after failed switch")
    await wait(failed.page, `window.modelReplayStore.state().mutations.some(item=>item.state==='failed')`)
    expect(failed.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    expect(failed.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
    expect(failed.relay.requests.some((request) => String(request.operation) === "integration.activate")).toBe(false)
  } finally { await failed.close() }
})

test("profile selection precedes remote command admission with the same Model.Ref", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" })
  try {
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileB')).click()`)
    await send(h.page, "/plan review")
    await waitForOperation(h.relay, "session.command")
    expect(h.relay.requests.slice(-2).map((request) => request.operation)).toEqual(["session.switchModel", "session.command"])
    expect(h.relay.requests.at(-2)?.input?.model).toEqual({ providerID: "openai", id: "model-a", profile: "profileB" })
    expect(h.relay.requests.at(-1)?.input).toMatchObject({ command: "plan", arguments: "review" })
  } finally { await h.close() }
})

test("a fast model without the selected same-provider profile stays blocked until explicit provider default", async () => {
  const h = await harness({ providerID: "openai", id: "model-a", variant: "high", profile: "profileA" })
  try {
    h.setCatalogModels(models.map((item) => item.id === "model-a"
      ? { ...item, profiles: [{ name: "profileA", active: true, variants: ["high"] }] }
      : item.id === "model-a-fast" ? { ...item, profiles: [{ name: "profileB", active: false, variants: ["low"] }] } : item))
    await h.page.evaluate(`window.modelReplayStore.loadCatalog({sessionID:'ses_a'}, {refresh:true})`)
    await wait(h.page, `window.modelReplayStore.state().catalogs['session:ses_a']?.models.find(item=>item.id==='model-a-fast')?.profiles?.[0]?.name === 'profileB'`)
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click(); document.querySelector('[aria-label="Fast model"]').click()`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__trigger').textContent`)).toContain("profileA")
    expect(await h.page.evaluate<string>(`document.querySelector('.composer__model-warning').textContent`)).toContain("profileA")
    await send(h.page, "Do not fall back from Work")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel" || request.operation === "session.prompt")).toHaveLength(0)
    expect(await h.page.evaluate<string>(`document.querySelector('textarea').value`)).toBe("Do not fall back from Work")
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click(); [...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('Use provider default')).click()`)
    expect(await h.page.evaluate<boolean>(`document.querySelector('.composer__model-warning') === null`)).toBe(true)
    await send(h.page, "Use provider default explicitly")
    await waitForOperation(h.relay, "session.prompt")
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-a-fast" })
  } finally { await h.close() }
})

test("profile variants, effort choices, and remembered values stay profile-specific", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" })
  try {
    h.setCatalogModels([...models, { providerID: "cursor", providerName: "Cursor", id: "claude-profiles", name: "Profile variants", variants: ["low", "high"], profiles: [{ name: "Work", active: true, variants: ["high"] }, { name: "Personal", active: false, variants: ["low"] }] }])
    await h.page.evaluate(`window.modelReplayStore.loadCatalog({sessionID:'ses_a'}, {refresh:true})`)
    await wait(h.page, `window.modelReplayStore.state().catalogs['session:ses_a']?.models.some(item=>item.id==='claude-profiles')`)
    await choose(h.page, "Profile variants")
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('Work')).click()`)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__labels span')].map(node=>node.textContent)`)).toEqual(["high"])
    await h.page.evaluate(`document.querySelector('[role="slider"]').focus()`)
    await h.page.pressKey("End", "End", 35)
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("high")
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('Personal')).click()`)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__labels span')].map(node=>node.textContent)`)).toEqual(["low"])
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("No effort override")
    await h.page.evaluate(`document.querySelector('[role="slider"]').focus()`)
    await h.page.pressKey("Home", "Home", 35)
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("low")
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('Work')).click()`)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__labels span')].map(node=>node.textContent)`)).toEqual(["high"])
    expect(await h.page.evaluate<string>(`document.querySelector('[role="slider"]').getAttribute('aria-valuetext')`)).toBe("high")
    await send(h.page, "Use remembered Work effort")
    await waitForOperation(h.relay, "session.prompt")
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "cursor", id: "claude-profiles", variant: "high", profile: "Work" })
  } finally { await h.close() }
})

test("reselecting the current named profile forces one confirmed rebind before prompt admission", async () => {
  const h = await harness({ providerID: "openai", id: "model-a", profile: "profileA" })
  try {
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    await send(h.page, "Rebind this profile")
    await waitForOperation(h.relay, "session.prompt")
    expect(h.relay.requests.slice(-2).map((request) => request.operation)).toEqual(["session.switchModel", "session.prompt"])
    expect(h.relay.requests.at(-2)?.input?.model).toEqual({ providerID: "openai", id: "model-a", profile: "profileA" })
  } finally { await h.close() }

  const refused = await harness({ providerID: "openai", id: "model-a", profile: "profileA" })
  try {
    refused.refuse()
    await refused.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await refused.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await refused.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    await send(refused.page, "Do not bypass a failed rebind")
    await wait(refused.page, `window.modelReplayStore.state().mutations.some(item=>item.state==='failed')`)
    expect(refused.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    expect(refused.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
  } finally { await refused.close() }
})

test("a confirmed same-profile rebind is not repeated when retrying rejected prompt admission", async () => {
  const h = await harness({ providerID: "openai", id: "model-a", profile: "profileA" })
  try {
    h.failNextPrompt()
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    await send(h.page, "Retry admission only")
    await waitForOperation(h.relay, "session.prompt")
    await wait(h.page, `window.modelReplayStore.state().mutations.some(item=>item.state==='failed')`)
    const mutationID = await h.page.evaluate<string>(`window.modelReplayStore.state().mutations.find(item=>item.state==='failed').id`)
    await h.page.evaluate(`window.modelReplayStore.retryMutation(${JSON.stringify(mutationID)})`)
    await waitForOperation(h.relay, "session.prompt")
    for (let attempt = 0; attempt < 100 && h.relay.requests.filter((request) => request.operation === "session.prompt").length < 2; attempt++) await Bun.sleep(30)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    expect(h.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(2)
  } finally { await h.close() }
})

test("a retry fails closed if another client changes the model after the confirmed rebind", async () => {
  const h = await harness({ providerID: "openai", id: "model-a", profile: "profileA" })
  try {
    h.failNextPrompt()
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    await send(h.page, "Do not retry under a different profile")
    await wait(h.page, `window.modelReplayStore.state().mutations.some(item=>item.state==='failed')`)
    const mutationID = await h.page.evaluate<string>(`window.modelReplayStore.state().mutations.find(item=>item.state==='failed').id`)
    h.external({ providerID: "openai", id: "model-a", profile: "profileB" })
    await wait(h.page, `window.modelReplayStore.state().selectedSessionInfo.model.profile === 'profileB'`)
    await h.page.evaluate(`window.modelReplayStore.retryMutation(${JSON.stringify(mutationID)})`)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    expect(h.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    expect(await h.page.evaluate<string[]>(`window.modelReplayStore.state().mutations.filter(item=>item.id===${JSON.stringify(mutationID)}).map(item=>item.state)`)).toEqual(["failed"])
  } finally { await h.close() }
})

test("a refreshed equal Session Model.Ref cannot clear an unsubmitted profile rebind", async () => {
  const h = await harness({ providerID: "openai", id: "model-a", profile: "profileA" })
  try {
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    const updatedAt = await h.page.evaluate<number>(`window.modelReplayStore.state().selectedSessionInfo.updatedAt`)
    h.refreshSessionInfo()
    await wait(h.page, `window.modelReplayStore.state().selectedSessionInfo.updatedAt > ${updatedAt}`)
    expect(await h.page.evaluate<boolean>(`document.querySelector('.model-control__trigger').classList.contains('mini-picker__trigger--pending')`)).toBe(true)
    await send(h.page, "Keep pending rebind")
    await waitForOperation(h.relay, "session.prompt")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-a", profile: "profileA" })
  } finally { await h.close() }
})

test("two Sessions retain independent profile picks and drafts across composer selection", async () => {
  const current = new Map<string, ModelRefView>([
    ["ses_a", { providerID: "openai", id: "model-a" }],
    ["ses_b", { providerID: "openai", id: "model-a" }],
  ])
  const session = (id: string) => ({ id, title: id, agent: "god", model: current.get(id), time: { created: 1, updated: 2 } })
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a", "ses_b"],
    snapshot: (id) => ({ session: session(id), messages: [], watermark: { type: "log.synced", aggregateID: id, seq: 0 } }),
    handler: (request) => {
      if (request.operation === "session.catalog") return { ok: true, value: { defaultModel: { providerID: "openai", id: "model-a" }, agents: [{ id: "god", name: "God", mode: "primary" }], models, commands: [], skills: [], references: [], resources: [] } }
      if (request.operation === "session.list") return { ok: true, value: { data: [...current.keys()].map(session), cursor: {} } }
      if (request.operation === "session.get") return { ok: true, value: { data: session(request.sessionID!) } }
      if (request.operation === "session.switchModel") {
        current.set(request.sessionID!, readModelRef(request.input?.model)!)
        relay.pushEvent(request.sessionID!, { type: "session.model.selected", data: { sessionID: request.sessionID, model: current.get(request.sessionID!) } })
        return { ok: true, value: { data: session(request.sessionID!) } }
      }
      return "default"
    },
  })
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/model-replay-fixture.html?relay=${encodeURIComponent(relay.wsURL("dev_1"))}`)
    await wait(page, `window.modelReplayStore?.state().transport.kind === 'open' && window.modelReplayStore.state().sessions.length === 2`)
    await page.evaluate(`window.modelReplayStore.selectSession('ses_a')`)
    await wait(page, `window.modelReplayStore.state().activeSessionID === 'ses_a' && document.querySelector('.model-control__trigger')?.disabled === false`)
    await page.evaluate(`document.querySelector('.model-control__trigger').click(); document.querySelector('[aria-label="Profile"]').click(); [...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    await page.evaluate(`(() => { const field=document.querySelector('textarea'); field.value='draft A'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await page.evaluate(`window.modelReplayStore.selectSession('ses_b')`)
    await wait(page, `window.modelReplayStore.state().activeSessionID === 'ses_b' && document.querySelector('textarea')?.value === '' && document.querySelector('.model-control__trigger')?.disabled === false`)
    await page.evaluate(`document.querySelector('.model-control__trigger').click(); document.querySelector('[aria-label="Profile"]').click(); [...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileB')).click()`)
    await page.evaluate(`(() => { const field=document.querySelector('textarea'); field.value='draft B'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await page.evaluate(`window.modelReplayStore.selectSession('ses_a')`)
    await wait(page, `window.modelReplayStore.state().activeSessionID === 'ses_a' && document.querySelector('textarea')?.value === 'draft A'`)
    expect(await page.evaluate<string>(`document.querySelector('.model-control__trigger').textContent`)).toContain("profileA")
    await send(page, "draft A")
    await waitForOperation(relay, "session.prompt")
    await page.evaluate(`window.modelReplayStore.selectSession('ses_b')`)
    await wait(page, `window.modelReplayStore.state().activeSessionID === 'ses_b' && document.querySelector('textarea')?.value === 'draft B'`)
    expect(await page.evaluate<string>(`document.querySelector('.model-control__trigger').textContent`)).toContain("profileB")
    await send(page, "draft B")
    for (let attempt = 0; attempt < 100 && relay.requests.filter((request) => request.operation === "session.prompt").length < 2; attempt++) await Bun.sleep(30)
    expect(relay.requests.filter((request) => request.operation === "session.switchModel").map((request) => [request.sessionID, request.input?.model])).toEqual([
      ["ses_a", { providerID: "openai", id: "model-a", profile: "profileA" }],
      ["ses_b", { providerID: "openai", id: "model-a", profile: "profileB" }],
    ])
    expect(relay.requests.filter((request) => request.operation === "session.prompt").map((request) => request.sessionID)).toEqual(["ses_a", "ses_b"])
  } finally { await page.close(); await relay.stop() }
})

test("each model restores its own valid effort instead of another model's effort or its default", async () => {
  const h = await harness()
  try {
    await choose(h.page, "Model B")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Model settings")
    await choose(h.page, "Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("max")
    await choose(h.page, "Model B")
    await effort(h.page, "high")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("high")
    await choose(h.page, "Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("max")
    await effort(h.page, "Model settings")
    await choose(h.page, "Model B")
    await choose(h.page, "Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Model settings")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
  } finally { await h.close() }
})

test("invalid incoming effort blocks ordinary sends until an explicit clear intent without rewriting the Session on read", async () => {
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
    await effort(h.page, "Model settings")
    await send(h.page, "Use model settings")
    await wait(h.page, `window.modelReplayStore.state().mutations.every(mutation=>mutation.state!=='sending') && document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual({ providerID: "openai", id: "model-b" })
  } finally { await h.close() }
})

test("a confirmed local choice releases its override, an external model owns later sends, and a failed switch retains the receipt", async () => {
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
    await wait(h.page, `window.modelReplayStore.state().mutations.some(mutation=>mutation.kind==='prompt' && mutation.state==='failed' && mutation.detail==='Switch refused')`)
    expect(h.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(2)
    expect(await h.page.evaluate<string>(`window.modelReplayStore.state().mutations.find(mutation=>mutation.state==='failed')?.input.text`)).toBe("Retain on refusal")
  } finally { await h.close() }
})

test("a no-effort model needs explicit clear intent for obsolete effort and a fast counterpart uses omission when it cannot retain effort", async () => {
  const plain = await harness({ providerID: "openai", id: "model-plain", variant: "max" })
  try {
    expect(await plain.page.evaluate<boolean>(`document.querySelector('.model-control__effort') === null`)).toBe(true)
    expect(await plain.page.evaluate<string>(`document.querySelector('.composer__model-warning').textContent`)).toContain("max")
    await effort(plain.page, "Model settings")
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

test("an omitted effort stays unselected with authoritative diagnostics and no inferred effort or extra model switch", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" })
  try {
    const sample = { model: h.current(), tokens: 12, durationNs: 2_000_000_000, tokensPerSecond: 6 }
    h.relay.pushEvent("ses_a", { type: "session.diagnostics.updated", data: { sessionID: "ses_a", diagnostics: { model: h.current(), context: { total: 800, limit: 2_000 }, generationSpeed: { latest: sample, recent: [sample] } } } })
    await wait(h.page, `window.modelReplayStore.state().view.contextWindow?.used === 800`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("Model settings")
    expect(await h.page.evaluate<string>(`document.querySelector('.composer__speed')?.textContent ?? ''`)).toContain("6 tok/s")
    expect(await h.page.evaluate<boolean>(`document.querySelector('.composer__context-trigger') !== null`)).toBe(true)
    await send(h.page, "Keep the actual model")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
    expect(h.relay.requests.find((request) => request.operation === "session.prompt")?.input?.model).toBeUndefined()
  } finally { await h.close() }
})

test("an existing Session without a model uses the catalog default identity, not the stored new-session preference", async () => {
  const preferred = { providerID: "openai", id: "model-b", variant: "high" }
  const configuredDefault = { providerID: "openai", id: "model-a", variant: "high", profile: "profileA" }
  const h = await harness(null, preferred, configuredDefault)
  try {
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("profileA")
    expect(await h.page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.preferred-model'))`)).toEqual(preferred)
    await h.page.evaluate(`document.querySelector('.model-control__trigger').click()`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__switch strong').textContent`)).toBe("high")
    await h.page.evaluate(`document.querySelector('[aria-label="Profile"]').click()`)
    await h.page.evaluate(`[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes('profileA')).click()`)
    expect(await h.page.evaluate<unknown>(`window.modelReplayStore.state().selectedSessionInfo.model`)).toBeUndefined()
    await send(h.page, "Use the configured default")
    await wait(h.page, `document.querySelector('textarea').value === ''`)
    expect(h.relay.requests.find((request) => request.operation === "session.switchModel")?.input?.model).toEqual(configuredDefault)
    expect(h.relay.requests.find((request) => request.operation === "session.prompt")?.input?.model).toBeUndefined()
    expect(h.current()).toEqual(configuredDefault)
    expect(await h.page.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.remote.preferred-model'))`)).toEqual(configuredDefault)
    await h.page.evaluate(`window.modelReplayShowWorkspace()`)
    await wait(h.page, `document.querySelector('.model-control__trigger')?.disabled === false`)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model A")
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__effort').textContent`)).toBe("profileA")
  } finally { await h.close() }
})

test("named profile choices use the existing full-screen picker on phones", async () => {
  const h = await harness({ providerID: "openai", id: "model-a" }, undefined, undefined, [390, 844])
  try {
    await wait(h.page, `document.querySelector('.composer__mobile-trigger')?.disabled === false`)
    await h.page.evaluate(`document.querySelector('.composer__mobile-trigger')?.click()`)
    await wait(h.page, `document.querySelector('.composer__mobile-trigger')?.getAttribute('aria-expanded') === 'true'`)
    await wait(h.page, `document.querySelector('.composer__selection-sheet') !== null`)
    await wait(h.page, `document.querySelector('.composer__selection-sheet .model-control__trigger')?.disabled === false`)
    await h.page.evaluate(`document.querySelector('.composer__selection-sheet .model-control__trigger')?.click()`)
    await wait(h.page, `document.querySelector('.model-control__profile [aria-label="Profile"]') !== null`)
    await h.page.evaluate(`document.querySelector('.model-control__profile [aria-label="Profile"]').click()`)
    await wait(h.page, `document.querySelector('.mini-picker__surface--sheet[role="dialog"][aria-label="Profile"]') !== null`)
    expect(await h.page.evaluate<{ width: number; height: number; modal: string | null }>(`(() => { const surface=document.querySelector('.mini-picker__surface--sheet[role="dialog"][aria-label="Profile"]'),rect=surface.getBoundingClientRect(); return { width:rect.width, height:rect.height, modal:surface.getAttribute('aria-modal') }; })()`)).toMatchObject({ modal: "true" })
    expect(await h.page.evaluate<boolean>(`(() => { const rect=document.querySelector('.mini-picker__surface--sheet[role="dialog"][aria-label="Profile"]').getBoundingClientRect(); return rect.width >= innerWidth - 16 && rect.height >= innerHeight - 24; })()`)).toBe(true)
    expect(await h.page.evaluate<boolean>(`[...document.querySelectorAll('.mini-picker__surface--sheet[aria-label="Profile"] [role="option"]')].some(option=>option.textContent.includes('profileA'))`)).toBe(true)
  } finally { await h.close() }
})

test("model choices persist as recent-first rows, keep provider groups stable, and never alter selection from display order", async () => {
  const h = await harness()
  try {
    await choose(h.page, "Model B")
    await choose(h.page, "Claude 1")
    expect(h.current()).toEqual({ providerID: "openai", id: "model-a", variant: "max" })
    await openModelList(h.page)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].map(node=>node.childNodes[0].textContent.trim())`)).toEqual([
      "Claude 1", "Model B", "Claude 2", "Model A", "Model C", "Model D", "Model Plain",
    ])
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__provider')].map(node=>node.textContent.trim())`)).toEqual([
      "Recent", "Anthropic", "OpenAI",
    ])
    await h.page.evaluate(`document.querySelector('.mini-picker__search').value='Model'; document.querySelector('.mini-picker__search').dispatchEvent(new Event('input',{bubbles:true}))`)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].map(node=>node.childNodes[0].textContent.trim())`)).toEqual([
      "Model B", "Model A", "Model C", "Model D", "Model Plain",
    ])
    await h.page.evaluate(`document.querySelector('.mini-picker__search').focus()`)
    await h.page.pressKey("ArrowDown", "ArrowDown", 35)
    expect(await h.page.evaluate<string>(`document.querySelector('.mini-picker__option--active')?.childNodes[0].textContent.trim()`)).toBe("Model A")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
    await h.page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
    await h.page.navigate(`http://127.0.0.1:${port}/verify/model-replay-fixture.html?relay=${encodeURIComponent(h.relay.wsURL("dev_1"))}`)
    await wait(h.page, `window.modelReplayStore?.state().transport.kind === 'open' && window.modelReplayStore.state().sessions.length > 0`)
    await h.page.evaluate(`window.modelReplayStore.selectSession('ses_a')`)
    await wait(h.page, `document.querySelector('.model-control__trigger')?.disabled === false`)
    await openModelList(h.page)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].map(node=>node.childNodes[0].textContent.trim())`)).toEqual([
      "Claude 1", "Model B", "Model A", "Model C", "Model D", "Model Plain", "Claude 2",
    ])
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__provider')].map(node=>node.textContent.trim())`)).toEqual([
      "Recent", "OpenAI", "Anthropic",
    ])
    expect(await h.page.evaluate<unknown>(`window.modelReplayStore.state().selectedSessionInfo.model`)).toEqual({ providerID: "openai", id: "model-a", variant: "max" })
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
    await h.page.evaluate(`document.querySelector('[aria-label="Close model picker"]').click()`)
    h.setCatalogModels(models.filter((item) => item.id !== "model-b" && item.id !== "claude-1"))
    await h.page.evaluate(`window.modelReplayStore.loadCatalog({sessionID:'ses_a'}, {refresh:true})`)
    await wait(h.page, `window.modelReplayStore.state().catalogs['session:ses_a']?.models.length === 6`)
    await openModelList(h.page)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].map(node=>node.childNodes[0].textContent.trim())`)).toEqual([
      "Model A", "Model C", "Model D", "Model Plain", "Claude 2",
    ])
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__provider')].map(node=>node.textContent.trim())`)).toEqual([
      "OpenAI", "Anthropic",
    ])
    await h.page.evaluate(`document.querySelector('.mini-picker__search').value='Model'; document.querySelector('.mini-picker__search').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.mini-picker__search').focus()`)
    await wait(h.page, `document.querySelectorAll('.model-control__model').length === 4`)
    await h.page.pressKey("ArrowDown", "ArrowDown", 35)
    expect(await h.page.evaluate<string>(`document.querySelector('.mini-picker__option--active')?.childNodes[0].textContent.trim()`)).toBe("Model C")
    await h.page.pressKey("Enter", "Enter", 35)
    expect(await h.page.evaluate<string>(`document.querySelector('.model-control__name').textContent`)).toBe("Model C")
    expect(h.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(0)
  } finally { await h.close() }
})

test("recent models with matching names identify their providers", async () => {
  const h = await harness()
  try {
    h.setCatalogModels([...models, { providerID: "cursor", providerName: "Cursor", id: "model-b", name: "Model B", variants: ["high"] }])
    await h.page.evaluate(`localStorage.setItem('ycoding.remote.recent-models', JSON.stringify([{providerID:'cursor',id:'model-b'},{providerID:'openai',id:'model-b'}]))`)
    await h.page.navigate(`http://127.0.0.1:${port}/verify/model-replay-fixture.html?relay=${encodeURIComponent(h.relay.wsURL("dev_1"))}`)
    await wait(h.page, `window.modelReplayStore?.state().transport.kind === 'open' && window.modelReplayStore.state().sessions.length > 0`)
    await h.page.evaluate(`window.modelReplayStore.selectSession('ses_a')`)
    await wait(h.page, `document.querySelector('.model-control__trigger')?.disabled === false`)
    await openModelList(h.page)
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].slice(0,2).map(row=>row.querySelector('small')?.textContent.trim())`))
      .toEqual(["Cursor · model-b", "OpenAI · model-b"])
    expect(await h.page.evaluate<string[]>(`[...document.querySelectorAll('.model-control__model')].slice(0,2).map(row=>row.getAttribute('aria-label'))`))
      .toEqual(["Model B · Cursor · model-b", "Model B · OpenAI · model-b"])
  } finally { await h.close() }
})
