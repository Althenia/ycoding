/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { json } from "./fixture/tui-client"
import { materializeClipboardImage } from "../src/clipboard"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_prompt_paste"
const directory = "/tmp/ycoding/prompt-paste"
const location = { directory, project: { id: "proj_prompt_paste", directory } }
const model = {
  id: "gpt-5.6-terra",
  modelID: "gpt-5.6-terra",
  providerID: "openai",
  name: "GPT 5.6 Terra",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}
const session = {
  id: sessionID,
  title: "Prompt paste",
  projectID: "proj_prompt_paste",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

async function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({
      data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] },
    })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  if (url.pathname === "/api/skill") return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/reference",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  return undefined
}

async function image() {
  return materializeClipboardImage(await mkdtemp(path.join(tmpdir(), "ycoding-prompt-paste-")), async (file) => {
    await Bun.write(file, "png")
  })
}

async function waitForFrameText(screen: { frame(): string }, text: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
}

async function pasteInto(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  trigger: () => void | Promise<void>,
  expected: string,
) {
  const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
  expect(promptRow).toBeGreaterThan(-1)
  await screen.mouse.click(3, promptRow)
  await trigger()
  await waitForFrameText(screen, expected)
}

test("attaches a clipboard image from ctrl+v", async () => {
  const attachment = await image()
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    clipboard: { read: async () => attachment },
    settle: "Message YCoding…",
  })
  try {
    await pasteInto(screen, () => screen.input.pressKey("v", { ctrl: true }), "[Image 1]")
  } finally {
    await screen.dispose()
    await attachment.temporary.cleanup()
  }
}, 30_000)

test("attaches a clipboard image when an image-only clipboard arrives as an empty bracketed paste", async () => {
  const attachment = await image()
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    clipboard: { read: async () => attachment },
    settle: "Message YCoding…",
  })
  try {
    await pasteInto(screen, () => screen.input.pasteBracketedText(""), "[Image 1]")
  } finally {
    await screen.dispose()
    await attachment.temporary.cleanup()
  }
}, 30_000)

test("attaches a clipboard image from super+v", async () => {
  const attachment = await image()
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    clipboard: { read: async () => attachment },
    kittyKeyboard: true,
    settle: "Message YCoding…",
  })
  try {
    await pasteInto(screen, () => screen.input.pressKey("v", { super: true }), "[Image 1]")
  } finally {
    await screen.dispose()
    await attachment.temporary.cleanup()
  }
}, 30_000)

// Terminals whose paste gesture only transfers text still deliver a file path when the user copies
// an image file rather than image data (Finder copies a URL; Ghostty pastes its path). That paste
// must become a real attachment instead of literal text.
test("attaches an image from a pasted file path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-path-attachment-"))
  const file = path.join(root, "pasted-image.png")
  await Bun.write(file, await Bun.file(new URL("../../../assets/brand/ycoding-mark-256.png", import.meta.url)))
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    settle: "Message YCoding…",
  })
  try {
    await pasteInto(screen, () => screen.input.pasteBracketedText(file), "[Image 1]")
    expect(screen.frame()).not.toContain("pasted-image.png")
  } finally {
    await screen.dispose()
  }
}, 30_000)
