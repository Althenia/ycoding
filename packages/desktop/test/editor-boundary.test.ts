import { expect, test } from "bun:test"
import { syntheticDesktop } from "./synthetic-desktop"

test("editor snapshots validate their directory and connection before reading native IDE state", async () => {
  const calls: string[] = []
  const app = await syntheticDesktop(undefined, { editor: { read: async (directory) => { calls.push(directory); return { status: "disabled" } }, close: () => {} } })
  try {
    for (const input of [{ directory: "relative", revision: app.revision }, { directory: "/synthetic", revision: app.revision - 1 }, { directory: "/synthetic", revision: app.revision, token: "forbidden" }]) await expect(app.controller.editorSelection(input)).rejects.toThrow()
    expect(calls).toEqual([])
    expect(await app.controller.editorSelection({ directory: "/synthetic", revision: app.revision })).toEqual({ status: "disabled" })
    expect(calls).toEqual(["/synthetic"])
  } finally { await app.close() }
})

test("editor snapshots cannot return a selection after the backend connection is retired", async () => {
  const pending = Promise.withResolvers<{ status: "disabled" }>()
  const started = Promise.withResolvers<void>()
  let closed = 0
  const app = await syntheticDesktop(undefined, { editor: { read: async () => { started.resolve(); return pending.promise }, close: () => { closed++ } } })
  try {
    const read = app.controller.editorSelection({ directory: "/synthetic", revision: app.revision })
    const rejected = read.then(() => undefined, (error: unknown) => error)
    await started.promise
    await app.controller.disconnect()
    pending.resolve({ status: "disabled" })
    const failure = await rejected
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/changed|cancelled|retired/)
    expect(closed).toBeGreaterThan(0)
  } finally { await app.close() }
})

test("draft editing validates input and preserves a confirmed empty external edit", async () => {
  const calls: { text: string; directory: string }[] = []
  const app = await syntheticDesktop(undefined, { openEditor: async (input) => { calls.push(input); return { kind: "edited", text: "" } } })
  try {
    await expect(app.controller.editDraft({ text: "draft", directory: "relative" })).rejects.toThrow()
    await expect(app.controller.editDraft({ text: "draft", directory: "/synthetic", command: "ignored" })).rejects.toThrow()
    expect(calls).toEqual([])
    expect(await app.controller.editDraft({ text: "draft", directory: "/synthetic" })).toEqual({ kind: "edited", text: "" })
    expect(calls).toEqual([{ text: "draft", directory: "/synthetic" }])
  } finally { await app.close() }
})

test("a Desktop connected to an explicit remote endpoint cannot restart the registered local daemon", async () => {
  let serviceCalls = 0
  const app = await syntheticDesktop(undefined, { restartService: {
    discover: async () => { serviceCalls++; return undefined },
    stop: async () => { serviceCalls++ },
    ensure: async () => { serviceCalls++; return { url: "http://127.0.0.1:1234" } },
  } })
  try {
    await expect(app.controller.restartBackend({ revision: app.revision })).rejects.toThrow(/registered local service/)
    expect(serviceCalls).toBe(0)
    expect(app.controller.state().status).toBe("connected")
  } finally { await app.close() }
})
