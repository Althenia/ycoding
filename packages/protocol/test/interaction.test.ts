import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { ClientApi } from "../src/client.js"

test("Session Interaction publishes only pending request, status, preview, revocation and fenced resume", () => {
  const entries = Object.entries(ClientApi.groups).find(([name]) => name === "server.interaction")
  expect(entries && Object.keys(entries[1].endpoints)).toEqual([
    "session.interaction.status", "session.interaction.request", "session.interaction.preview", "session.interaction.stop",
    "session.interaction.resume",
  ])
  const resume = OpenApi.fromApi(ClientApi).paths["/api/session/{sessionID}/interaction/resume"]?.post
  expect(resume?.operationId).toBe("session.interaction.resume")
  expect(Object.keys(resume?.responses ?? {})).toContain("409")
})

test("no Interaction HTTP operation accepts script source or returns script results", () => {
  const api = OpenApi.fromApi(ClientApi)
  const operations = Object.entries(api.paths).filter(([path]) => path.includes("/interaction")).flatMap(([, item]) => Object.values(item ?? {}))
  expect(operations.length).toBeGreaterThanOrEqual(5)
  const referenced = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && !referenced.has(child)) {
        referenced.add(child)
        visit(api.components.schemas[child.split("/").at(-1)!])
      }
      visit(child)
    }
  }
  visit(operations)
  const reachable = JSON.stringify([operations, ...[...referenced].map((ref) => api.components.schemas[ref.split("/").at(-1)!])])
  for (const name of ["Interaction.ScriptRequest", "Interaction.ScriptResult", "Interaction.ConsoleEntry", "Interaction.ScriptMode"])
    expect(reachable).not.toContain(name)
  for (const field of ['"source"', '"logs"', '"script"']) expect(reachable).not.toContain(field)
})

test("published status names the paused reason", () => {
  const schemas = OpenApi.fromApi(ClientApi).components.schemas
  expect(JSON.stringify(schemas["Interaction.Status"])).toContain("paused")
  expect(schemas["Interaction.PauseReason"]).toMatchObject({ enum: [
    "foreground_required", "file_chooser", "dialog", "captcha", "sensitive", "user_takeover",
  ] })
})

test("published preview limits match the native connection budget", () => {
  const frameSchema = OpenApi.fromApi(ClientApi).components.schemas["Interaction.Frame"]
  expect(frameSchema).toMatchObject({ properties: {
    base64: { allOf: expect.arrayContaining([{ maxLength: 218_456 }, { pattern: expect.any(String) }]) },
    width: { allOf: expect.arrayContaining([{ maximum: 960 }]) },
    height: { allOf: expect.arrayContaining([{ maximum: 720 }]) },
  } })

  const base64 = Buffer.alloc(163_840).toString("base64")
  expect(Buffer.byteLength(JSON.stringify({ type: "result", id: crypto.randomUUID(), result: {
    status: "ready", frame: { mimeType: "image/jpeg", width: 960, height: 720, base64 },
  } }))).toBeLessThanOrEqual(262_144)
})
