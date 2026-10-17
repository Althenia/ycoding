import { expect, test } from "bun:test"
import path from "node:path"
import { readCredentials } from "../view/model.js"
import { startBackend } from "./fixture/runtime"

type Backend = Awaited<ReturnType<typeof startBackend>>

async function links(backend: Backend) {
  const page = async (action: string) => {
    const reply = await backend.control({ action })
    if (!reply || typeof reply !== "object" || !("url" in reply) || typeof reply.url !== "string")
      throw new Error("Missing Rust Meeting page URL")
    return new URL(reply.url)
  }
  const ordinary = await page("view")
  const owner = await page("owner-view")
  const view = readCredentials(ordinary.hash)
  const both = readCredentials(owner.hash)
  if (!view || !both?.owner) throw new Error("Rust Meeting links are not usable by the live page")
  return { key: view.key, owner: both.owner, ordinary, ownerURL: owner, both }
}

function request(backend: Backend, route: string, token: string, body?: unknown) {
  return fetch(`${backend.origin}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: backend.origin,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function record(backend: Backend, key: string, captureID: string) {
  const capture = async (payload: unknown) => {
    const reply = await request(backend, "/view/capture", key, payload)
    expect(reply.status).toBe(200)
  }
  await capture({ type: "start", captureID, microphone: false, consent: true })
  await capture({
    type: "audio",
    captureID,
    source: "remote",
    sequence: 0,
    startMs: 0,
    sampleRate: 16000,
    pcm: Buffer.from(new Float32Array(16000).fill(0.1).buffer).toString("base64"),
  })
  await capture({ type: "stop", captureID, reason: "fixture complete" })
}

function prompts(backend: Backend) {
  return backend.requests.map((body) => ({ body, text: JSON.stringify(body) }))
}

test("owner link reads the live catalog and registry and saves an Ask model the runtime then uses", async () => {
  const backend = await startBackend("local", true)
  try {
    const { key, owner, ordinary, ownerURL, both } = await links(backend)
    expect(ordinary.hash).not.toContain("owner=")
    expect(both.key).toBe(key)
    expect(owner).not.toBe(key)
    expect(ownerURL.origin).toBe(backend.origin)
    expect((await request(backend, "/view/owner/settings", key)).status).toBe(401)
    expect((await request(backend, "/view/state", owner)).status).toBe(401)
    expect((await request(backend, "/view/ask", owner, { question: "Hello" })).status).toBe(401)
    expect((await request(backend, "/view/control", owner, { action: "stop" })).status).toBe(401)

    const read = await request(backend, "/view/owner/settings", owner)
    expect(read.status).toBe(200)
    const settings = (await read.json()) as {
      askModel: unknown
      analysisModel: unknown
      models: { providerID: string; id: string; name: string; variants: string[] }[]
      servers: { name: string; status?: string; tools: string[] }[]
      knowledge: Record<string, unknown>
    }
    expect(settings.askModel).toBe("inherit")
    expect(settings.analysisModel).toBe("inherit")
    expect(settings.models).toContainEqual(
      expect.objectContaining({ providerID: "openai", id: "gpt-reasoning-high", variants: ["none", "low", "high"] }),
    )
    expect(settings.servers).toContainEqual({
      name: "knowledge",
      status: "connected",
      tools: ["read", "replace", "search"],
    })
    expect(settings.knowledge).toEqual({
      mcpEnabled: true,
      autoApply: false,
      requireApproval: true,
      bindings: [
        {
          server: "knowledge",
          search: "search",
          read: "read",
          write: "replace",
          enabled: true,
          writeCapability: "revision-aware",
        },
      ],
    })
    expect(JSON.stringify(settings)).not.toContain(owner)
    expect(await Bun.file(backend.knowledgeState).json()).toMatchObject({ searches: [], reads: [], writes: [] })

    const missing = await request(backend, "/view/owner/settings", owner, {
      askModel: { providerID: "openai", id: "gpt-reasoning-high", variant: "not-reported" },
    })
    expect(missing.status).toBe(422)
    expect(await missing.json()).toEqual({ error: "selection_unavailable" })
    const saved = await request(backend, "/view/owner/settings", owner, {
      askModel: { providerID: "openai", id: "gpt-reasoning-high" },
    })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { askModel: unknown }).askModel).toEqual({
      providerID: "openai",
      id: "gpt-reasoning-high",
    })
    const file = await Bun.file(path.join(backend.meetingDirectory, "settings.json")).json()
    expect(file.analysis).toMatchObject({
      model: "inherit",
      askModel: { providerID: "openai", id: "gpt-reasoning-high" },
    })
    expect(file.knowledge).toMatchObject({ autoApply: false, requireApproval: true })

    await backend.control({ action: "start", title: "Owner Ask model" })
    await record(backend, key, "owner-ask")
    await backend.control({ action: "summary" })
    const view = await backend.settled()
    expect(view.proposals).toContainEqual(
      expect.objectContaining({
        server: "knowledge",
        target: "doc-1",
        status: "pending",
        expectedRevision: "r1",
        sourceSegmentIds: [view.segments[0].id],
        references: [expect.objectContaining({ server: "knowledge", target: "doc-1", revision: "r1" })],
      }),
    )
    const asked = await request(backend, "/view/ask", key, { question: "What is pending?" })
    expect(asked.status).toBe(200)
    expect(await asked.json()).toMatchObject({ status: "answered" })
    const question = prompts(backend).filter((entry) => entry.text.includes('\\"question\\":'))
    const analysis = prompts(backend).filter((entry) => !entry.text.includes('\\"question\\":'))
    expect(question).toHaveLength(1)
    expect(analysis.length).toBeGreaterThan(0)
    expect(question[0].text).toContain('"service_tier":"priority"')
    for (const entry of analysis) expect(entry.text).not.toContain('"service_tier":"priority"')
    expect((await Bun.file(backend.knowledgeState).json()).writes).toEqual([])
  } finally {
    await backend.stop()
  }
}, 90000)

test("an unavailable admitted Ask model fails the answer without substituting another model", async () => {
  const backend = await startBackend("local", false, { askModel: { providerID: "openai", id: "missing-model" } })
  try {
    const { key, owner } = await links(backend)
    const settings = (await (await request(backend, "/view/owner/settings", owner)).json()) as { askModel: unknown }
    expect(settings.askModel).toEqual({ providerID: "openai", id: "missing-model" })
    await backend.control({ action: "start", title: "Unavailable Ask model" })
    await record(backend, key, "missing-model")
    const before = backend.requests.length
    const asked = await request(backend, "/view/ask", key, { question: "What is pending?" })
    expect(asked.status).toBe(502)
    expect(await asked.json()).toMatchObject({ status: "error", error: "answer_failed" })
    expect(backend.requests.slice(before).filter((body) => JSON.stringify(body).includes('\\"question\\":'))).toEqual(
      [],
    )
  } finally {
    await backend.stop()
  }
}, 90000)

test("a disabled connector stays saved, retrieves nothing and is revalidated when enabled", async () => {
  const backend = await startBackend("local", true)
  try {
    const { key, owner } = await links(backend)
    const binding = { server: "knowledge", search: "search", read: "read", write: "replace" }
    const disabled = await request(backend, "/view/owner/settings", owner, {
      knowledge: { mcpEnabled: true, bindings: [{ ...binding, enabled: false }] },
    })
    expect(disabled.status).toBe(200)
    const file = await Bun.file(path.join(backend.meetingDirectory, "settings.json")).json()
    expect(file.knowledge.bindings).toEqual([{ ...binding, enabled: false }])
    await backend.control({ action: "start", title: "Disabled connector" })
    await record(backend, key, "disabled-connector")
    await backend.control({ action: "summary" })
    const view = await backend.settled()
    expect(view.analysis.status).toBe("idle")
    expect(view.summary).toMatchObject({ summary: "สรุป rollout · unconfirmed", final: true })
    expect(view.proposals).toEqual([])
    expect(await Bun.file(backend.knowledgeState).json()).toMatchObject({ searches: [], reads: [], writes: [] })
    const unknownTool = await request(backend, "/view/owner/settings", owner, {
      knowledge: { mcpEnabled: true, bindings: [{ ...binding, search: "absent", enabled: true }] },
    })
    expect(unknownTool.status).toBe(422)
    const enabled = await request(backend, "/view/owner/settings", owner, {
      knowledge: { mcpEnabled: true, bindings: [{ ...binding, enabled: true }] },
    })
    expect(enabled.status).toBe(200)
    expect((await Bun.file(backend.knowledgeState).json()).writes).toEqual([])
  } finally {
    await backend.stop()
  }
}, 90000)
