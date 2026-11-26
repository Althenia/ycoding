import { mock } from "bun:test"
import assert from "node:assert/strict"
import path from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { TextareaRenderable } from "@opentui/core"
import { Effect, FileSystem } from "effect"
import { createComponent } from "solid-js"
import { make } from "@ycoding-ai/client/v5"
import { FrontendPaths } from "../src/frontend-paths"
import { materializeClipboardImage } from "../src/clipboard"

const [url, directory, sessionID, pngPath] = process.argv.slice(2)
assert.ok(url && directory && sessionID && pngPath)
process.chdir(directory)
mock.module("../src/theme/discovery", () => ({
  themeDirectories: () => [],
  discoverThemes: async () => ({}),
}))
mock.module("../src/component/dialog-telemetry-consent", () => ({ DialogTelemetryConsent: () => null }))
const dataModule = await import("../src/context/data")
const originalData = { ...dataModule }
let data: ReturnType<typeof dataModule.useData> | undefined
function SessionProbe() {
  data = originalData.useData()
  return null
}
mock.module("../src/context/data", () => ({
  ...originalData,
  DataProvider: (props: Parameters<typeof dataModule.DataProvider>[0]) => {
    let content: Array<typeof props.children> | undefined
    return createComponent(originalData.DataProvider, {
      get recordTelemetry() { return props.recordTelemetry },
      get selectedSessionID() { return props.selectedSessionID },
      get children() { return (content ??= [createComponent(SessionProbe, {}), props.children]) },
    })
  },
}))
const { run } = await import("../src/app")
const endpoint = { url }
const client = make({ endpoint, location: { directory } })
const screen = await createTestRenderer({ width: 120, height: 40, useThread: false, kittyKeyboard: true })
const original = Buffer.from(await Bun.file(pngPath).arrayBuffer())
const chunk = Buffer.alloc(70_012)
chunk.writeUInt32BE(70_000, 0)
chunk.write("tEXt", 4)
chunk.write("description\0", 8)
chunk.fill(0x61, 20, 70_008)
chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, 70_008)), 70_008)
const png = Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)])
let clipboard = await materializeClipboardImage(directory, async (file) => { await Bun.write(file, png) })
const task = Effect.runPromise(run({
  server: { endpoint },
  args: { sessionID },
  config: { get: async () => ({ animations: false, session: { sidebar: "hide" } }), update: async () => ({}) },
  packages: { resolve: async () => undefined },
  clipboard: { read: async () => clipboard },
  terminalHandoff: async () => ({ renderer: screen.renderer, mode: "dark", complete: () => {} }),
  log: () => {},
}).pipe(
  Effect.provide(FrontendPaths.layerWith({ state: path.join(directory, "tui-state") })),
  Effect.provide(FileSystem.layerNoop({})),
))
async function wait(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await screen.renderOnce()
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`TUI did not reach expected state:\n${screen.captureCharFrame()}`)
}
try {
  await wait(() => {
    const session = data?.session.get(sessionID)
    const history = data?.session.message.history(sessionID)
    if (!session || !history?.sourceEpoch || history.status !== "ready") return false
    const location = data?.location
    return !!location?.info(session.location) && !!location.model.default(session.location) &&
      !!location.agent.list(session.location) && !!location.model.list(session.location) &&
      screen.renderer.currentFocusedEditor instanceof TextareaRenderable && screen.captureCharFrame().includes("ready")
  })
  await screen.mockInput.pasteBracketedText("")
  await wait(() => screen.captureCharFrame().includes("[Image 1]"))
  await screen.mockInput.typeText("inspect synthetic image")
  screen.mockInput.pressEnter()
  let pending = await client.session.pending.list({ sessionID })
  await wait(async () => {
    pending = await client.session.pending.list({ sessionID })
    const frame = screen.captureCharFrame()
    assert.ok(!frame.includes("Retry send") && !frame.includes("draft retained"), frame)
    return pending.length === 1
  })
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.type, "user")
  if (pending[0]?.type !== "user") throw new Error("expected user input")
  assert.ok(pending[0].data.text.includes("inspect synthetic image"))
  const attachment = pending[0].data.files?.[0]
  assert.equal(attachment?.mime, "image/png")
  if (attachment?.content.type !== "managed") throw new Error("expected managed PNG")
  const read = await client.session.attachment.read({ sessionID, digest: attachment.content.digest })
  assert.deepEqual(Buffer.from(read.data, "base64"), png)
  await wait(() => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await screen.mockInput.typeText("plain text only")
  screen.mockInput.pressEnter()
  await wait(async () => {
    pending = await client.session.pending.list({ sessionID })
    return pending.length === 2
  })
  const plain = pending.find((entry) => entry.type === "user" && entry.data.text.includes("plain text only"))
  assert.ok(plain && plain.type === "user")
  assert.equal(plain.data.files?.length ?? 0, 0)
  assert.equal(pending.filter((entry) => entry.type === "user" && entry.data.text.includes("inspect synthetic image")).length, 1)
  clipboard = await materializeClipboardImage(directory, async (file) => {
    await Bun.write(file, Buffer.concat([original.subarray(0, 8), Buffer.from("invalid PNG")]))
  })
  await wait(() => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await screen.mockInput.pasteBracketedText("")
  await wait(() => screen.captureCharFrame().includes("[Image 1]"))
  await screen.mockInput.typeText("retain rejected draft")
  screen.mockInput.pressEnter()
  await wait(() => screen.captureCharFrame().includes("Image could not be decoded"))
  assert.ok(screen.captureCharFrame().includes("retain rejected draft"))
  assert.equal((await client.session.pending.list({ sessionID })).length, 2)
} finally {
  screen.renderer.destroy()
  await task
  client.transport.close()
  await clipboard.temporary.cleanup()
}
