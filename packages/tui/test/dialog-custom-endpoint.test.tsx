/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
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
