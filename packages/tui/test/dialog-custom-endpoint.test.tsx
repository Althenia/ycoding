/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogCustomEndpoint } from "../src/component/dialog-custom-endpoint"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { saveCustomEndpoint } from "../src/custom-endpoint-save"

test("supports keyboard-driven catalog/provider selection, model editing, and submit", async () => {
  let submitted: unknown
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <Keymap.Provider config={config}>
                <DialogProvider>
                  <DialogCustomEndpoint
                    providerOptions={[{ id: "existing-provider", name: "Existing Provider" }]}
                    onComplete={(result) => { submitted = result }}
                  />
                </DialogProvider>
              </Keymap.Provider>
            </ToastProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 50, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("openai-models"))
  await Bun.sleep(30)
  await app.mockInput.typeText("https://api.example.test/v1")
  app.mockInput.pressKey("n", { ctrl: true })
  await Bun.sleep(10)
  expect(app.captureCharFrame()).toContain("Model ID")
  await app.mockInput.typeText("model-one")
  app.mockInput.pressKey("TAB")
  await app.mockInput.typeText("Model One")
  app.mockInput.pressKey("TAB")
  await app.mockInput.typeText("reasoning")
  app.mockInput.pressKey("TAB")
  await app.mockInput.typeText("responses")
  app.mockInput.pressKey("d", { ctrl: true })
  app.mockInput.pressKey("n", { ctrl: true })
  await Bun.sleep(10)
  await app.mockInput.typeText("model-two")
  app.mockInput.pressKey("o", { ctrl: true })
  app.mockInput.pressKey("p", { ctrl: true })
  app.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(10)
  expect(submitted).toEqual({
    baseURL: "https://api.example.test/v1",
    api: "chat",
    provider: "existing-provider",
    apiKey: undefined,
    profile: "default",
    catalog: "openai-models",
    models: [
      { id: "model-one", name: "Model One", family: "reasoning", api: "responses", disabled: true },
      { id: "model-two" },
    ],
  })
  app.renderer.destroy()
})

test("saves a blank-provider API key through the registered default integration", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "ycoding-endpoint-ui-"))
  let submitted: Parameters<typeof saveCustomEndpoint>[1] | undefined
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <Keymap.Provider config={config}>
                <DialogProvider>
                  <DialogCustomEndpoint onComplete={(result) => { submitted = result }} />
                </DialogProvider>
              </Keymap.Provider>
            </ToastProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 50, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Endpoint URL"))
  await Bun.sleep(20)
  await app.mockInput.typeText("https://api.example.test/v1")
  app.mockInput.pressKey("TAB")
  app.mockInput.pressKey("TAB")
  app.mockInput.pressKey("TAB")
  await app.mockInput.typeText("ui-secret-value")
  app.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(10)
  expect(submitted?.provider).toBeUndefined()
  expect(submitted?.apiKey).toBe("ui-secret-value")
  const order: string[] = []
  await saveCustomEndpoint(configDir, submitted!, {
    async syncRegistration() {
      const written = parse(await readFile(path.join(configDir, "ycoding.json"), "utf8"))
      expect(written.providers["custom-openai"].package).toBe("aisdk:@ai-sdk/openai-compatible")
      expect(Object.hasOwn(written.providers["custom-openai"], "integrationID")).toBe(false)
      expect(JSON.stringify(written)).not.toContain("ui-secret-value")
      order.push("registration")
    },
    registered: (id) => id === "custom-openai",
    async connectKey(input) {
      expect(input).toEqual({ integrationID: "custom-openai", key: "ui-secret-value", label: "default" })
      order.push("credential")
    },
    async activate() { throw new Error("unexpected activation") },
    async refresh() { order.push("refresh") },
  })
  expect(order).toEqual(["registration", "credential", "refresh"])
  app.renderer.destroy()
  await rm(configDir, { recursive: true, force: true })
})

test("renders Runpod worker selection and submits a served model", async () => {
  let submitted: Parameters<typeof saveCustomEndpoint>[1] | undefined
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <Keymap.Provider config={config}>
                <DialogProvider>
                  <DialogCustomEndpoint kind="runpod" onComplete={(result) => { submitted = result }} />
                </DialogProvider>
              </Keymap.Provider>
            </ToastProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 50, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Runpod Serverless Endpoint"))
  expect(app.captureCharFrame()).toContain("vllm")
  expect(app.captureCharFrame()).toContain("ollama")
  expect(app.captureCharFrame()).not.toContain("openai-models")
  await Bun.sleep(20)
  await app.mockInput.typeText("https://api.runpod.ai/v2/endpoint123")
  app.mockInput.pressKey("w", { ctrl: true })
  app.mockInput.pressKey("n", { ctrl: true })
  await Bun.sleep(10)
  await app.mockInput.typeText("org/served-model")
  app.mockInput.pressKey("t", { ctrl: true })
  app.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(10)
  expect(submitted).toMatchObject({ baseURL: "https://api.runpod.ai/v2/endpoint123", worker: "ollama", models: [{ id: "org/served-model", tools: true }] })
  app.renderer.destroy()
})

test("clicking a field focuses it instead of editing the previous field", async () => {
  let submitted: Parameters<typeof saveCustomEndpoint>[1] | undefined
  const config = createTuiResolvedConfig()
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={config}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
      <ToastProvider><Keymap.Provider config={config}><DialogProvider>
        <DialogCustomEndpoint kind="runpod" onComplete={(result) => { submitted = result }} />
      </DialogProvider></Keymap.Provider></ToastProvider>
    </ThemeProvider></ConfigProvider></TestTuiContexts>
  ), { width: 100, height: 50, kittyKeyboard: true })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Credential profile"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("https://api.runpod.ai/v2/endpoint")
    const urlInput = app.renderer.currentFocusedEditor
    app.mockInput.pressKey("n", { ctrl: true })
    await app.waitFor(() => app.renderer.currentFocusedEditor !== urlInput)
    await app.mockInput.typeText("served-model")
    await app.waitForFrame((frame) => frame.includes("served-model"))
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("default"))
    await app.mockMouse.click(lines[row]!.indexOf("default") + 2, row)
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("default")
    app.mockInput.pressKey("END")
    await app.mockInput.typeText("-work")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("default-work")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitFor(() => submitted !== undefined)
    expect(submitted?.profile).toBe("default-work")
    expect(submitted?.baseURL).toBe("https://api.runpod.ai/v2/endpoint")
  } finally {
    app.renderer.destroy()
  }
})

test("OpenAI provider field accepts a click and Tab advances to the API key", async () => {
  let submitted: Parameters<typeof saveCustomEndpoint>[1] | undefined
  const config = createTuiResolvedConfig()
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={config}><ThemeProvider mode="light" source={{ discover: () => Promise.resolve({}) }}>
      <ToastProvider><Keymap.Provider config={config}><DialogProvider>
        <DialogCustomEndpoint onComplete={(result) => { submitted = result }} />
      </DialogProvider></Keymap.Provider></ToastProvider>
    </ThemeProvider></ConfigProvider></TestTuiContexts>
  ), { width: 100, height: 50, kittyKeyboard: true })
  try {
    app.renderer.start()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("https://api.example.test/v1")
    await app.waitForFrame((frame) => frame.includes("Provider (optional)"))
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("e.g., openai"))
    await app.mockMouse.click(lines[row]!.indexOf("e.g., openai") + 2, row)
    await app.mockInput.typeText("private")
    app.mockInput.pressKey("TAB")
    await app.mockInput.typeText("test-key")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitFor(() => submitted !== undefined)
    expect(submitted).toMatchObject({ baseURL: "https://api.example.test/v1", provider: "private", apiKey: "test-key" })
  } finally {
    app.renderer.destroy()
  }
})

test("endpoint choices and actions stay readable in dark and light themes", async () => {
  const luminance = (color: number[]) => [color[0]!, color[1]!, color[2]!]
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
  for (const mode of ["dark", "light"] as const) for (const kind of ["runpod", "openai"] as const) {
    const config = createTuiResolvedConfig()
    const app = await testRender(() => (
      <TestTuiContexts><ConfigProvider config={config}><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
        <ToastProvider><Keymap.Provider config={config}><DialogProvider>
          <DialogCustomEndpoint kind={kind === "runpod" ? "runpod" : undefined} />
        </DialogProvider></Keymap.Provider></ToastProvider>
      </ThemeProvider></ConfigProvider></TestTuiContexts>
    ), { width: 100, height: 50 })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Save endpoint"))
      for (const label of [...(kind === "runpod" ? ["vllm", "ollama"] : ["none", "openai-models", "Chat", "Responses"]), "+ Add model", "Save endpoint"]) {
        const span = app.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes(label))
        expect(span, `${mode}/${kind}: ${label} must render`).toBeDefined()
        const foreground = luminance(span!.fg.toInts())
        const background = luminance(span!.bg.toInts())
        expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05), `${mode}/${kind}: ${label} contrast`).toBeGreaterThanOrEqual(4.5)
      }
    } finally {
      app.renderer.destroy()
    }
  }
})

test("OpenAI provider suggestions cannot spill a long identifier across the dialog", async () => {
  const config = createTuiResolvedConfig()
  const identifier = `provider-${"A".repeat(150)}`
  for (const width of [72, 56]) {
    const app = await testRender(() => (
      <TestTuiContexts><ConfigProvider config={config}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
        <ToastProvider><Keymap.Provider config={config}><DialogProvider>
          <DialogCustomEndpoint providerOptions={[{ id: identifier, name: identifier }]} />
        </DialogProvider></Keymap.Provider></ToastProvider>
      </ThemeProvider></ConfigProvider></TestTuiContexts>
    ), { width, height: 50 })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Provider (optional)"))
      const frame = app.captureCharFrame()
      expect(frame).not.toContain("A".repeat(45))
      expect(frame).toContain("API Key (optional)")
      expect(frame).toContain("Save endpoint")
    } finally {
      app.renderer.destroy()
    }
  }
})
