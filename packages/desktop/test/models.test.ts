import { expect, test } from "bun:test"
import type { YCodingClient } from "@ycoding-ai/client"
import {
  currentModel, modelSelection, modelSource, openedModelLocation, projectDefault, projectModels, running, sameModelLocation, sessionModelLocation, switchRequest,
} from "../src/models"

type Info = Awaited<ReturnType<YCodingClient["model"]["list"]>>["data"][number]
type Session = Awaited<ReturnType<YCodingClient["session"]["get"]>>
type Inventory = Awaited<ReturnType<YCodingClient["project"]["inventory"]>>["data"]

const hidden = "synthetic-hidden-value"
const invalid = "This model is not in the current list. Refresh models and choose again."
const repository = "Choose a previously opened repository."
const optionKeys = ["id", "providerID", "name", "enabled", "status", "limit", "variants", "profiles"]

test("standalone model sources accept omitted and empty directories", () => {
  for (const input of [undefined, {}, { directory: "" }]) expect(modelSource(input)).toEqual({})
  for (const input of [null, { directory: 1 }, { extra: true }, { directory: "relative" }]) expect(() => modelSource(input)).toThrow()
})

function info(overrides: Partial<Info>): Info {
  return {
    id: "synthetic-model",
    modelID: "synthetic-upstream-model",
    providerID: "synthetic-provider",
    family: "synthetic-family",
    name: "Synthetic Model",
    package: "synthetic-package",
    settings: { token: hidden },
    headers: { authorization: hidden },
    body: { key: hidden },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "fast", settings: { token: hidden }, headers: { authorization: hidden }, body: { key: hidden } }, { id: "deep" }],
    profiles: [{ name: "work", active: true, variants: ["deep"], daybreak: ["daybreak_blue"] }],
    time: { released: 1 },
    cost: [{ tier: { type: "context", size: 1 }, input: 1, output: 2, cache: { read: 3, write: 4 } }],
    status: "active",
    enabled: true,
    daybreak: ["daybreak_red"],
    api: "responses",
    limit: { context: 200_000, input: 150_000, output: 32_000 },
    ...overrides,
  }
}

function sessionInfo(overrides: Partial<Session>): Session {
  return {
    id: "ses_synthetic",
    projectID: "prj_synthetic",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: "Synthetic",
    location: { directory: "/synthetic/repo" },
    ...overrides,
  }
}

const catalog = projectModels([
  info({}),
  info({ id: "profile-only", name: "Profile Only", enabled: false, variants: [], profiles: [{ name: "team", active: false }] }),
  info({ id: "closed", name: "Closed", enabled: false, profiles: undefined }),
])

test("model projection keeps only the closed display fields and drops provider configuration", () => {
  expect(catalog[0]).toEqual({
    id: "synthetic-model",
    providerID: "synthetic-provider",
    name: "Synthetic Model",
    enabled: true,
    status: "active",
    limit: { context: 200_000, output: 32_000 },
    variants: ["fast", "deep"],
    profiles: [{ name: "work", active: true, variants: ["deep"] }],
  })
  expect(catalog[1]?.profiles).toEqual([{ name: "team", active: false, variants: [] }])
  expect(catalog[2]?.profiles).toEqual([])
  const serialized = JSON.stringify(catalog)
  for (const field of [hidden, "modelID", "settings", "headers", "body", "package", "family", "capabilities", "tools", "released", "cost", "cache", "tier", "daybreak", '"api"', "responses", "input"])
    expect(serialized).not.toContain(field)
})

test("projected catalog entries have exactly the whitelisted own keys", () => {
  for (const entry of [catalog[1], catalog[2]]) {
    expect(Object.keys(entry ?? {})).toEqual(optionKeys)
    expect(Object.keys(entry?.limit ?? {})).toEqual(["context", "output"])
    for (const profile of entry?.profiles ?? []) expect(Object.keys(profile)).toEqual(["name", "active", "variants"])
  }
})

test("keys the backend sends with undefined values never appear in the output", () => {
  const [model] = projectModels([{ ...info({}), extra: undefined, limit: { context: 1, output: 1, extra: undefined }, profiles: [{ name: "work", active: true, variants: undefined, extra: undefined }] }])
  expect(Object.keys(model ?? {})).toEqual(optionKeys)
  expect(Object.keys(model?.limit ?? {})).toEqual(["context", "output"])
  expect(Object.keys(model?.profiles[0] ?? {})).toEqual(["name", "active", "variants"])
  expect(model?.profiles[0]?.variants).toEqual([])
  const selection = projectDefault({ selection: { id: "synthetic-model", providerID: "synthetic-provider", variant: undefined, profile: undefined, extra: undefined } })
  expect(Object.keys(selection ?? {})).toEqual(["id", "providerID"])
  const current = currentModel({ model: { id: "synthetic-model", providerID: "synthetic-provider", variant: undefined, extra: undefined } })
  expect(Object.keys(current ?? {})).toEqual(["id", "providerID"])
})

test("malformed backend model entries are dropped whole and never reach the output", () => {
  const malformed = [
    { ...info({}), id: { value: hidden } },
    { ...info({}), name: { value: hidden } },
    { ...info({}), providerID: 1 },
    { ...info({}), enabled: "true" },
    { ...info({}), status: "retired" },
    { ...info({}), limit: { context: -1, output: 1 } },
    { ...info({}), limit: { context: Number.POSITIVE_INFINITY, output: 1 } },
    { ...info({}), limit: { context: "200000", output: 1 } },
    { ...info({}), variants: [{ id: { value: hidden } }] },
    { ...info({}), variants: "fast" },
    { ...info({}), profiles: [{ name: { value: hidden }, active: true }] },
    { ...info({}), profiles: [{ name: "x".repeat(257), active: true }] },
    { ...info({}), profiles: [{ name: "work", active: "yes" }] },
    { ...info({}), profiles: [{ name: "work", active: true, variants: [{ value: hidden }] }] },
    { ...info({}), profiles: null },
    null,
    "synthetic-model",
  ]
  const projected = projectModels([...malformed, info({ id: "kept" })])
  expect(projected.map((model) => model.id)).toEqual(["kept"])
  expect(JSON.stringify(projected)).not.toContain(hidden)
  expect(projectModels([info({ profiles: [{ name: "x".repeat(256), active: true }] })])[0]?.profiles.map((profile) => profile.name.length)).toEqual([256])
  for (const value of [undefined, null, {}, "models", { data: [] }]) expect(() => projectModels(value)).toThrow("The backend returned an invalid model list. Refresh to retry.")
})

test("model limits are safe integers and profile names are nonempty", () => {
  for (const limit of [{ context: 1.5, output: 1 }, { context: 1, output: 0.5 }, { context: Number.MAX_SAFE_INTEGER + 1, output: 1 }])
    expect(projectModels([info({ limit })])).toEqual([])
  expect(projectModels([info({ profiles: [{ name: "", active: true }] })])).toEqual([])
  const model = { id: "synthetic-model", providerID: "synthetic-provider", profile: "" }
  expect(() => projectDefault({ selection: model })).toThrow()
  expect(() => currentModel({ model })).toThrow()
  expect(projectModels([info({ limit: { context: 0, output: Number.MAX_SAFE_INTEGER } })])).toHaveLength(1)
})

test("backend IDs, names and variant IDs longer than 1024 bytes are refused, never truncated", () => {
  const longest = "x".repeat(1024)
  const kept = projectModels([info({ id: longest, providerID: longest, name: longest, variants: [{ id: longest }], profiles: [{ name: "work", active: true, variants: [longest] }] })])
  expect(kept.map((model) => [model.id.length, model.providerID.length, model.name.length, model.variants[0]?.length, model.profiles[0]?.variants[0]?.length])).toEqual([[1024, 1024, 1024, 1024, 1024]])
  const over = `${longest}x`
  for (const overrides of [{ id: over }, { providerID: over }, { name: over }, { variants: [{ id: over }] }, { profiles: [{ name: "work", active: true, variants: [over] }] }])
    expect(projectModels([info(overrides)])).toEqual([])
  for (const selection of [{ id: over, providerID: "synthetic-provider" }, { id: "synthetic-model", providerID: over }, { id: "synthetic-model", providerID: "synthetic-provider", variant: over }])
    expect(() => projectDefault({ selection })).toThrow("The backend returned an invalid default model. Refresh to retry.")
  expect(() => currentModel({ model: { id: over, providerID: "synthetic-provider" } })).toThrow("The backend returned an invalid Session model. Refresh to retry.")
})

test("model and directory limits count UTF-8 bytes: multibyte text at the limit is kept and one character more is refused", () => {
  const id = "é".repeat(512)
  const profile = "é".repeat(128)
  const directory = `/${"é".repeat(2047)}x`
  expect([id, profile, directory].map((value) => new TextEncoder().encode(value).length)).toEqual([1024, 256, 4096])
  const kept = projectModels([info({ id, providerID: id, name: id, variants: [{ id }], profiles: [{ name: profile, active: true, variants: [id] }] })])
  expect(kept.map((model) => [model.id, model.providerID, model.name, model.variants, model.profiles])).toEqual([[id, id, id, [id], [{ name: profile, active: true, variants: [id] }]]])
  for (const overrides of [{ id: `${id}é` }, { providerID: `${id}é` }, { name: `${id}é` }, { variants: [{ id: `${id}é` }] },
    { profiles: [{ name: `${profile}é`, active: true }] }, { profiles: [{ name: profile, active: true, variants: [`${id}é`] }] }])
    expect(projectModels([info(overrides)])).toEqual([])
  expect(projectDefault({ selection: { id, providerID: id, variant: id, profile } })).toEqual({ id, providerID: id, variant: id, profile })
  for (const selection of [{ id: `${id}é`, providerID: id }, { id, providerID: id, profile: `${profile}é` }])
    expect(() => projectDefault({ selection })).toThrow("The backend returned an invalid default model. Refresh to retry.")
  expect(modelSource({ directory })).toEqual({ directory })
  expect(() => modelSource({ directory: `${directory}é` })).toThrow(repository)
})

test("a deprecated model is listed with its status and can still be chosen", () => {
  const listed = projectModels([info({ id: "old", status: "deprecated" })])
  expect(listed.map((model) => [model.id, model.status])).toEqual([["old", "deprecated"]])
  expect(modelSelection({ id: "old", providerID: "synthetic-provider" }, listed)).toEqual({ id: "old", providerID: "synthetic-provider" })
})

test("default and current model references keep only the selected reference and refuse malformed values", () => {
  const value = { ...info({}), selection: { id: "synthetic-model", providerID: "synthetic-provider", variant: "deep", profile: "work" } }
  expect(projectDefault(value)).toEqual({ id: "synthetic-model", providerID: "synthetic-provider", variant: "deep", profile: "work" })
  expect(projectDefault(null)).toBeNull()
  for (const value of [undefined, {}, { selection: { id: { value: hidden }, providerID: "synthetic-provider" } }, { selection: { id: "synthetic-model", providerID: "synthetic-provider", profile: "x".repeat(257) } }])
    expect(() => projectDefault(value)).toThrow("The backend returned an invalid default model. Refresh to retry.")
  expect(currentModel(sessionInfo({ model: { id: "synthetic-model", providerID: "synthetic-provider", profile: "work" } }))).toEqual({ id: "synthetic-model", providerID: "synthetic-provider", profile: "work" })
  expect(currentModel(sessionInfo({}))).toBeNull()
  expect(() => currentModel({ model: { id: "synthetic-model", providerID: { value: hidden } } })).toThrow("The backend returned an invalid Session model. Refresh to retry.")
})

test("model selection returns the exact listed reference", () => {
  expect(modelSelection({ id: "synthetic-model", providerID: "synthetic-provider" }, catalog)).toEqual({ id: "synthetic-model", providerID: "synthetic-provider" })
  expect(modelSelection({ id: "synthetic-model", providerID: "synthetic-provider", variant: "fast" }, catalog)).toEqual({ id: "synthetic-model", providerID: "synthetic-provider", variant: "fast" })
  expect(modelSelection({ id: "synthetic-model", providerID: "synthetic-provider", profile: "work", variant: "deep" }, catalog)).toEqual({ id: "synthetic-model", providerID: "synthetic-provider", variant: "deep", profile: "work" })
  expect(modelSelection({ id: "profile-only", providerID: "synthetic-provider", profile: "team" }, catalog)).toEqual({ id: "profile-only", providerID: "synthetic-provider", profile: "team" })
})

test("model selection refuses unlisted, unavailable, mismatched and extra-field references", () => {
  for (const value of [
    null,
    "synthetic-model",
    [{ id: "synthetic-model", providerID: "synthetic-provider" }],
    { id: "synthetic-model" },
    { id: "synthetic-model", providerID: "other-provider" },
    { id: "missing", providerID: "synthetic-provider" },
    { id: "synthetic-model", providerID: "synthetic-provider", headers: { authorization: hidden } },
    JSON.parse('{"id":"synthetic-model","providerID":"synthetic-provider","__proto__":{"variant":"fast"}}'),
    { id: "synthetic-model", providerID: "synthetic-provider", variant: "missing" },
    { id: "synthetic-model", providerID: "synthetic-provider", variant: 1 },
    { id: "synthetic-model", providerID: "synthetic-provider", profile: "missing" },
    { id: "synthetic-model", providerID: "synthetic-provider", profile: "work", variant: "fast" },
    { id: "profile-only", providerID: "synthetic-provider" },
    { id: "closed", providerID: "synthetic-provider" },
  ]) expect(() => modelSelection(value, catalog)).toThrow(invalid)
})

test("a switch request carries only the Session ID, connection revision and model", () => {
  const model = { id: "synthetic-model", providerID: "synthetic-provider" }
  expect(switchRequest({ sessionID: "ses_synthetic", revision: 4, model })).toEqual({ sessionID: "ses_synthetic", revision: 4, model })
  for (const value of [null, { sessionID: "ses_synthetic", model }, { sessionID: "ses_synthetic", revision: -1, model }, { sessionID: "ses_synthetic", revision: 1.5, model },
    { sessionID: "ses_synthetic", revision: 4, model, interrupt: true }]) expect(() => switchRequest(value)).toThrow(invalid)
  expect(() => switchRequest({ sessionID: "other", revision: 4, model })).toThrow("Choose a Session.")
})

test("a model source is a Session ID or an absolute directory of at most 4096 bytes and nothing else", () => {
  expect(modelSource("ses_synthetic")).toEqual({ sessionID: "ses_synthetic" })
  expect(modelSource({ directory: "/synthetic/repo" })).toEqual({ directory: "/synthetic/repo" })
  const longest = `/${"x".repeat(4095)}`
  expect(longest.length).toBe(4096)
  expect(modelSource({ directory: longest })).toEqual({ directory: longest })
  expect(() => modelSource("not-a-session")).toThrow("Choose a Session.")
  for (const value of [
    null,
    [],
    { directory: 1 },
    { directory: "relative/repo" },
    { directory: `${longest}x` },
    { directory: "/synthetic/repo", sessionID: "ses_synthetic" },
    { directory: "/synthetic/repo", location: { workspace: "wrk_other" } },
    JSON.parse('{"__proto__":{},"directory":"/synthetic/repo"}'),
  ]) expect(() => modelSource(value)).toThrow(repository)
})

test("a Session's model location comes only from a well-formed backend record for that Session", () => {
  expect(sessionModelLocation("ses_synthetic", sessionInfo({ location: { directory: "/synthetic/repo", workspaceID: "wrk_synthetic" } }))).toEqual({ directory: "/synthetic/repo", workspace: "wrk_synthetic" })
  expect(sessionModelLocation("ses_synthetic", sessionInfo({}))).toEqual({ directory: "/synthetic/repo" })
  expect(() => sessionModelLocation("ses_other", sessionInfo({}))).toThrow("The backend returned a different Session. Refresh and choose again.")
  for (const location of [{ directory: { value: hidden } }, { directory: "relative/repo" }, { directory: "/synthetic/repo", workspaceID: 1 }, null])
    expect(() => sessionModelLocation("ses_synthetic", { ...sessionInfo({}), location })).toThrow("The backend returned an invalid Session location. Refresh to retry.")
})

test("a New chat model location is only an available opened directory from the backend inventory", () => {
  const inventory: Inventory = [
    { projectID: "prj_synthetic", projectWorktree: "/synthetic/repo", directory: "/synthetic/repo", sessions: 1, timeActive: 1, available: true },
    { projectID: "prj_gone", projectWorktree: "/synthetic/gone", directory: "/synthetic/gone", sessions: 1, timeActive: 1, available: false },
  ]
  expect(openedModelLocation("/synthetic/repo", inventory)).toEqual({ directory: "/synthetic/repo" })
  for (const directory of ["/synthetic/gone", "/synthetic/other", "/synthetic/repo/", "/synthetic"])
    expect(() => openedModelLocation(directory, inventory)).toThrow("Choose an available, previously opened repository for the new chat.")
  expect(() => openedModelLocation("/synthetic/repo", [{ directory: "/synthetic/repo", available: "true" }])).toThrow("Choose an available, previously opened repository for the new chat.")
  expect(() => openedModelLocation("/synthetic/repo", { data: inventory })).toThrow("The backend returned an invalid repository list. Refresh to retry.")
})

test("models served for another location are recognized", () => {
  expect(sameModelLocation({ location: { directory: "/synthetic/repo", project: {} } }, { directory: "/synthetic/repo" })).toBe(true)
  expect(sameModelLocation({ location: { directory: "/synthetic/repo", workspaceID: "wrk_synthetic" } }, { directory: "/synthetic/repo", workspace: "wrk_synthetic" })).toBe(true)
  for (const value of [{ location: { directory: "/synthetic/other" } }, { location: { directory: "/synthetic/repo", workspaceID: "wrk_other" } }, {}, null])
    expect(sameModelLocation(value, { directory: "/synthetic/repo" })).toBe(false)
  expect(sameModelLocation({ location: { directory: "/synthetic/repo" } }, { directory: "/synthetic/repo", workspace: "wrk_synthetic" })).toBe(false)
})

test("running state comes only from a well-formed backend map and fails closed", () => {
  expect(running({}, "ses_synthetic")).toBe(false)
  expect(running({ ses_other: { type: "running" } }, "ses_synthetic")).toBe(false)
  expect(running({ ses_synthetic: { type: "running" } }, "ses_synthetic")).toBe(true)
  for (const value of [null, [], "running", { ses_synthetic: { type: "queued" } }, { ses_synthetic: true }])
    expect(() => running(value, "ses_synthetic")).toThrow("The backend returned an invalid Session state. Refresh to retry.")
})
