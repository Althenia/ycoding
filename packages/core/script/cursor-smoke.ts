import { mkdtemp } from "fs/promises"
import os from "os"
import path from "path"
import { createCursor } from "cursor-opencode-provider"
import { resolveBearerToken } from "cursor-opencode-provider/auth"
import { discoverModels } from "cursor-opencode-provider/models"
import { CursorModels } from "../src/cursor/models"

const apiKey = process.env.CURSOR_API_KEY
if (!apiKey) {
  console.error("Set CURSOR_API_KEY to run the live Cursor smoke check.")
  process.exit(1)
}

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "ycoding-cursor-smoke-"))
const catalog = CursorModels.fromCursor(await discoverModels(await resolveBearerToken({ apiKey }), cacheDir))
console.log(`catalog entries: ${catalog.length}`)
catalog.forEach((model) =>
  console.log(`${model.id} -> ${model.modelID} context=${model.limit.context} variants=${model.variants.length}`),
)

const selected =
  catalog.find((model) => model.id === (process.env.CURSOR_SMOKE_MODEL ?? "composer-2.5") && model.id === model.modelID) ??
  catalog.find((model) => model.id === model.modelID)
if (!selected) {
  console.error("Cursor returned no models.")
  process.exit(1)
}

const result = await createCursor({ name: "cursor", apiKey, cacheDir, workspaceRoot: process.cwd() })
  .languageModel(selected.modelID)
  .doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: pong" }] }],
    headers: { "X-Session-Id": `ycoding-cursor-smoke-${Date.now()}` },
  })
const reader = result.stream.getReader()
const parts: string[] = []
for (let next = await reader.read(); !next.done; next = await reader.read()) {
  if (next.value.type === "text-delta") parts.push(next.value.delta)
  if (next.value.type === "error") throw next.value.error
  if (next.value.type === "finish") console.log(`finish: ${JSON.stringify(next.value.finishReason)}`)
}
console.log(`${selected.id}: ${parts.join("")}`)
process.exit(0)
