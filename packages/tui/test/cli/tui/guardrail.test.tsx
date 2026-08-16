/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, Renderable } from "@opentui/core"
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
const permission = await import("../../../src/routes/session/permission")

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
    title: "Guardrail blocked",
    actor: "Subagent ses_child in ses_root",
    action: "shell",
    reason: "Destructive Git operation",
    resources: ["git reset --hard"],
  })
  const source = await Bun.file(new URL("../../../src/routes/session/guardrail.tsx", import.meta.url)).text()
  expect(source).toContain('kind="guardrail"')
  expect(source).toContain('options={{ once: "Allow once", always: "Allow for this session", reject: "Deny" }}')
  expect(source).toContain('const reply = (value: "once" | "always" | "reject") => {')
  expect(source).toContain("reply: value")
  expect(source).toContain('defaultOption="reject"')
})

test("renders a warning-framed guardrail approval", async () => {
  const replyReceived = Promise.withResolvers<unknown>()
  const transport = createFetch(async (url, request) => {
    if (/^\/api\/session\/[^/]+\/guardrail\/request\/[^/]+\/reply$/.test(url.pathname)) {
      replyReceived.resolve(await request.json())
      return new Response(null, { status: 204 })
    }
    return undefined
  })
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
  await app.waitForFrame((frame) => frame.includes("Guardrail blocked"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("!!")
    expect(frame).toContain("guardrail · Destructive Git operation needs approval")
    expect(frame).toContain("Guardrails apply even in YOLO mode.")
    expect(frame).toContain("Action: shell")
    expect(frame).toContain("Resource: git reset --hard")
    expect(frame).toContain("git reset --hard")
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Deny")
    expect(frame).toContain("Allow for this session")
    expect(frame).not.toContain("standard.review.git-destructive")
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    expect(await replyReceived.promise).toEqual({ reply: "always" })
  } finally {
    app.renderer.destroy()
  }
})

test("defaults guardrails to deny and ordinary permissions to allow once", async () => {
  const selectedBackground = async (kind: "guardrail" | "permission", defaultOption: "once" | "reject") => {
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <permission.Prompt
                  kind={kind}
                  title={`${kind} choice`}
                  instance={`${kind}-choice`}
                  body={<text>Choice body</text>}
                  options={{ once: "Allow once", reject: "Deny" }}
                  defaultOption={defaultOption}
                  onSelect={() => {}}
                />
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 96, height: 18, kittyKeyboard: true },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes(`${kind} choice`))

    try {
      const selected = descendants(app.renderer.root).find(
        (item): item is BoxRenderable => item instanceof BoxRenderable && item.id === `session.${kind}.action.${defaultOption}`,
      )
      const unselected = descendants(app.renderer.root).find(
        (item): item is BoxRenderable =>
          item instanceof BoxRenderable && item.id === `session.${kind}.action.${defaultOption === "once" ? "reject" : "once"}`,
      )
      expect(selected).toBeDefined()
      expect(unselected).toBeDefined()
      const selectedBox = requireBoxRenderable(selected, `session.${kind}.action.${defaultOption}`)
      const unselectedBox = requireBoxRenderable(
        unselected,
        `session.${kind}.action.${defaultOption === "once" ? "reject" : "once"}`,
      )
      expect(selectedBox.backgroundColor.toInts()).not.toEqual(unselectedBox.backgroundColor.toInts())
      return {
        selected: selectedBox.backgroundColor.toInts(),
        unselected: unselectedBox.backgroundColor.toInts(),
      }
    } finally {
      app.renderer.destroy()
    }
  }

  const guardrail = await selectedBackground("guardrail", "reject")
  const permissionSelection = await selectedBackground("permission", "once")
  expect(guardrail.selected).toEqual(permissionSelection.selected)
  expect(guardrail.unselected).toEqual(permissionSelection.unselected)
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

function descendants(root: Renderable): BoxRenderable[] {
  return root.getChildren().flatMap((child) => {
    if (!(child instanceof BoxRenderable)) return []
    return [child, ...descendants(child)]
  })
}

function requireBoxRenderable(renderable: BoxRenderable | undefined, id: string): BoxRenderable {
  if (renderable) return renderable
  throw new Error(`expected a BoxRenderable with id ${id}`)
}
