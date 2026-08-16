/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GuardrailStatusOutput } from "@ycoding-ai/client"
import { ClientProvider } from "../../../src/context/client"
import { ThemeProvider } from "../../../src/context/theme"
import { Keymap } from "../../../src/context/keymap"
import { ConfigProvider } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createFetch } from "../../fixture/tui-client"

const module = await import("../../../src/feature-plugins/sidebar/guardrails")
const prompt = await import("../../../src/routes/session/guardrail")

const status: GuardrailStatusOutput = {
  rootSessionID: "ses_root",
  profile: "standard",
  customRules: 2,
  approvals: 3,
  blocked: 1,
  counters: [
    { id: "shell", current: 2, limit: 8, scope: "family" },
    { id: "subagent", current: 4, limit: 8, scope: "family" },
    { id: "review", current: 1, limit: 16, scope: "family" },
  ],
  invalidFiles: ["/home/user/.config/ycoding/guardrails/broken.md"],
}

test("formats guardrail profile and family counters", () => {
  expect(module.guardrailSummary(status)).toEqual({
    profile: "Standard + 2 custom",
    decisions: "3 approvals · 1 blocked",
    shells: "Shells 2 / 8",
    subagents: "Subagents 4 / 8",
    reviews: "Reviews 1 / 16",
    invalid: "1 invalid guardrail file",
  })
})

test("attributes child reviews to their root family and exposes explicit guardrail replies", async () => {
  const request = {
    id: "grq_review",
    rootSessionID: "ses_root",
    sessionID: "ses_child",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    standard: true,
  }
  expect(prompt.guardrailPresentation(request)).toEqual({
    title: "Session guardrail review",
    actor: "Subagent ses_child in ses_root",
    action: "shell",
    reason: "Destructive Git operation",
    resources: ["git reset --hard"],
    rules: ["standard.review.git-destructive"],
  })
  const source = await Bun.file(new URL("../../../src/routes/session/guardrail.tsx", import.meta.url)).text()
  expect(source).toContain('kind="guardrail"')
  expect(source).toContain('options={{ once: "Approve once", always: "Always", reject: "Reject" }}')
  expect(source).toContain('const reply = (value: "once" | "always" | "reject") => {')
  expect(source).not.toContain("Always allow")
})

test("renders the exact guardrail choices", async () => {
  const transport = createFetch()
  const request = {
    id: "grq_review",
    rootSessionID: "ses_root",
    sessionID: "ses_child",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    standard: true,
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <prompt.GuardrailPrompt request={request} />
                </ToastProvider>
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 96, height: 18, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Session guardrail review"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Approve once")
    expect(frame).toContain("Always")
    expect(frame).toContain("Reject")
  } finally {
    app.renderer.destroy()
  }
})

test("renders guardrail status without raw rules or command resources", async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <module.GuardrailContent status={() => status} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 48, height: 14 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("GUARDRAILS"))

  try {
    const frame = app.captureCharFrame()
    // Rail sections render their name in the design's uppercase section style.
    expect(frame).toContain("GUARDRAILS")
    expect(frame).toContain("Standard + 2 custom")
    expect(frame).toContain("3 approvals · 1 blocked")
    expect(frame).toContain("Shells 2 / 8")
    expect(frame).toContain("Subagents 4 / 8")
    expect(frame).toContain("1 invalid guardrail file")
    expect(frame).not.toContain("broken.md")
    expect(frame).not.toContain("git reset")
  } finally {
    app.renderer.destroy()
  }
})
