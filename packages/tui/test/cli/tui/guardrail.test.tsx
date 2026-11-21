/** @jsxImportSource @opentui/solid */
import { expect, test, vi } from "bun:test"
import { BoxRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { GuardrailRequest } from "../../../src/routes/session/guardrail"
import type { GuardrailStatusOutput } from "@ycoding-ai/client"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { ClientProvider } from "../../../src/context/client"
import { ThemeProvider } from "../../../src/context/theme"
import { Keymap } from "../../../src/context/keymap"
import { ConfigProvider } from "../../../src/config"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createFetch, json } from "../../fixture/tui-client"

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

test("the guardrail hint names who decides and never claims a model check", () => {
  for (const mode of ["manual", "auto", "yolo", undefined] as const)
    expect(permission.guardrailHint(true, mode)).toBe("hard review · only you can approve")
  expect(permission.guardrailHint(false, "manual")).toBe("you decide this review")
  expect(permission.guardrailHint(false, undefined)).toBe("you decide this review")
  expect(permission.guardrailHint(false, "auto")).toBe("Auto didn't cover this · you decide")
  expect(permission.guardrailHint(false, "yolo")).toBe("YOLO escalated this · you decide")
})

test("formats guardrail profile and family counters", () => {
  expect(module.guardrailSummary(status)).toEqual({
    profile: "Standard + 2 custom",
    header: "Standard · 1 blocked",
    decisions: "3 approvals · 1 blocked",
    shells: "Shells 2 / 8",
    subagents: "Subagents 4 / 8",
    reviews: "Reviews 1 / 16",
    invalid: "1 invalid guardrail file",
  })
})

test("escalation text distinguishes decision failures from an actual model escalation", async () => {
  const { GuardrailEscalation } = await import("../../../src/guardrail-escalation")
  const failure = GuardrailEscalation.text({ reason: "timeout" })
  expect(failure).toContain("Decision unavailable")
  expect(failure).toContain("timed out")
  expect(failure).not.toContain("model escalated")
  expect(failure).not.toContain("unreported")
  expect(GuardrailEscalation.text({ reason: "low_confidence" })).toContain("requires human review")
  const escalated = GuardrailEscalation.text({ reason: "escalated", choice: "escalate", confidence: 0.2 })
  expect(escalated).toContain("Decision model escalated")
  expect(escalated).toContain("choice escalate")
  expect(escalated).toContain("confidence 0.2")
  const historical = GuardrailEscalation.text({})
  expect(historical).toContain("diagnostic reason was not recorded")
  expect(historical).not.toContain("unreported")
})

test("renders a decision-failed human review without claiming the model escalated", async () => {
  const transport = createFetch(async () => undefined)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <prompt.GuardrailPrompt
                    request={{
                      id: "grq_failed",
                      rootSessionID: "ses_root",
                      sessionID: "ses_root",
                      action: "shell",
                      resources: ["git reset --hard"],
                      ruleIDs: ["standard.review.git-destructive"],
                      reason: "Destructive Git operation",
                      standard: true, created: 1_000,
                      escalation: { reason: "unsupported-output" as const },
                    }}
                  />
                </ToastProvider>
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Guardrail blocked"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Decision unavailable")
    expect(frame).toContain("does not support strict structured")
    expect(frame).not.toContain("Decision model escalated")
    expect(frame).not.toContain("unreported")
    expect(frame.replace(/\s+/g, " ")).toContain("your decision is required")
    expect(frame.replace(/\s+/g, " ")).toContain("Review this request manually, or configure a decision helper")
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Deny")
  } finally {
    app.renderer.destroy()
  }
})

test("attributes child reviews to their root family", () => {
  const request = {
    id: "grq_review",
    rootSessionID: "ses_root",
    sessionID: "ses_child",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    standard: true, created: 1_000,
  }
  expect(prompt.guardrailPresentation(request)).toEqual({
    title: "Guardrail blocked",
    actor: "Subagent ses_child in ses_root",
    action: "shell",
    reason: "Destructive Git operation",
    resources: ["git reset --hard"],
  })
})

test("renders a model-escalated human review with ordinary choices", async () => {
  const replyReceived = Promise.withResolvers<unknown>()
  const transport = createFetch(async (url, request) => {
    if (/^\/api\/session\/[^/]+\/guardrail\/request\/[^/]+\/reply$/.test(url.pathname)) {
      replyReceived.resolve({ path: url.pathname, body: await request.json() })
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
    standard: true, created: 1_000,
    escalation: { choice: "escalate" as const, confidence: 0.2 },
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <prompt.GuardrailPrompt request={request} guardrailsMode="yolo" />
                </ToastProvider>
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 96, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Guardrail blocked"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("!!")
    expect(frame).toContain("Destructive Git operation")
    expect(frame).toContain("Decision model escalated")
    expect(frame).toContain("0.2")
    expect(frame).toContain("YOLO escalated this · you decide")
    expect(frame).toContain("Blocked")
    expect(frame).toContain("git reset --hard")
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Deny")
    expect(frame).toContain("Allow for this session")
    expect(frame).not.toContain("standard.review.git-destructive")
    app.mockInput.pressKey("\u001b[6~")
    await app.waitForFrame((frame) => frame.includes("Action: shell"))
    app.mockInput.pressArrow("right")
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    expect(await replyReceived.promise).toEqual({
      path: "/api/session/ses_root/guardrail/request/grq_review/reply",
      body: { reply: "always" },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("renders a hard review with one-time approval or rejection only", async () => {
  const replyReceived = Promise.withResolvers<unknown>()
  const transport = createFetch(async (url, request) => {
    if (/^\/api\/session\/[^/]+\/guardrail\/request\/[^/]+\/reply$/.test(url.pathname)) {
      replyReceived.resolve({ path: url.pathname, body: await request.json() })
      return new Response(null, { status: 204 })
    }
    return undefined
  })
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <prompt.GuardrailPrompt
                    request={{
                      id: "grq_hard_review",
                      rootSessionID: "ses_root",
                      sessionID: "ses_child",
                      action: "shell",
                      resources: ["rm -rf ."],
                      ruleIDs: ["standard.review.broad-deletion"],
                      reason: "Recursive deletion includes the current project",
                      standard: true, created: 1_000,
                      hardReview: true,
                    }}
                  />
                </ToastProvider>
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 96, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Guardrail blocked"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Deny")
    expect(frame).not.toContain("Allow for this session")
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    expect(await replyReceived.promise).toEqual({
      path: "/api/session/ses_root/guardrail/request/grq_hard_review/reply",
      body: { reply: "once" },
    })
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
        (item): item is BoxRenderable =>
          item instanceof BoxRenderable && item.id === `session.${kind}.action.${defaultOption}`,
      )
      const unselected = descendants(app.renderer.root).find(
        (item): item is BoxRenderable =>
          item instanceof BoxRenderable &&
          item.id === `session.${kind}.action.${defaultOption === "once" ? "reject" : "once"}`,
      )
      expect(selected).toBeDefined()
      expect(unselected).toBeDefined()
      const selectedBox = requireBoxRenderable(selected, `session.${kind}.action.${defaultOption}`)
      const selectedBand = requireBoxRenderable(
        descendants(selectedBox).find((item) => item.id === `session.${kind}.action.${defaultOption}.band`),
        `session.${kind}.action.${defaultOption}.band`,
      )
      const unselectedBox = requireBoxRenderable(
        unselected,
        `session.${kind}.action.${defaultOption === "once" ? "reject" : "once"}`,
      )
      expect(selectedBand.backgroundColor.toInts()).not.toEqual(unselectedBox.backgroundColor.toInts())
      return {
        selected: selectedBand.backgroundColor.toInts(),
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

for (const decision of ["once", "reject"] as const) {
  test(`replacing a scrolled review resets hard-review details and sends ${decision} once`, async () => {
    const replies: { path: string; reply: unknown }[] = []
    const settled = Promise.withResolvers<void>()
    const transport = createFetch(async (url, request) => {
      if (!url.pathname.endsWith("/reply")) return undefined
      replies.push({ path: url.pathname, reply: await request.json() })
      await settled.promise
      return new Response(null, { status: 204 })
    })
    const long = [...Array.from({ length: 60 }, (_, index) => `display-only resource ${index}`), "FINAL_COMMAND_SENTINEL"].join("\n")
    let replace!: (request: GuardrailRequest) => void
    const app = await testRender(
      () => {
        const [request, setRequest] = createSignal<GuardrailRequest>({
          id: "grq_first", rootSessionID: "ses_root", sessionID: "ses_root", action: "shell",
          resources: [long], reason: "Review display-only details", ruleIDs: [], standard: true, created: 1_000,
        })
        replace = setRequest
        return (
          <TestTuiContexts>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <Keymap.Provider>
                <ClientProvider api={createApi(transport.fetch)}>
                  <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                    <ToastProvider><prompt.GuardrailPrompt request={request()} /></ToastProvider>
                  </ThemeProvider>
                </ClientProvider>
              </Keymap.Provider>
            </ConfigProvider>
          </TestTuiContexts>
        )
      },
      { width: 80, height: 24, kittyKeyboard: true },
    )
    try {
      await app.waitForFrame((frame) => frame.includes("Allow for this session"))
      const details = descendants(app.renderer.root).find((item): item is ScrollBoxRenderable => item instanceof ScrollBoxRenderable)
      if (!details) throw new Error("guardrail details did not render a scrollbox")
      for (let page = 0; page < 100 && !app.captureCharFrame().includes("FINAL_COMMAND_SENTINEL"); page++) {
        app.mockInput.pressKey("\u001b[6~")
        await app.renderOnce()
      }
      expect(app.captureCharFrame()).toContain("FINAL_COMMAND_SENTINEL")
      app.mockInput.pressArrow("right")
      app.mockInput.pressArrow("right")
      await app.renderOnce()
      expect(descendants(app.renderer.root).some((item) => item.id === "session.guardrail.action.always.band")).toBe(true)
      replace({
        id: "grq_hard_replacement", rootSessionID: "ses_root", sessionID: "ses_root", action: "shell",
        resources: [`NEW_COMMAND_START ${"display-only text ".repeat(200)} NEW_COMMAND_END`],
        reason: "Hard display-only review", ruleIDs: [], standard: true, created: 1_000, hardReview: true,
      })
      app.renderer.resize(50, 12)
      await app.renderOnce()
      expect(details.scrollTop).toBe(0)
      const frame = app.captureCharFrame()
      expect(frame).toContain("NEW_COMMAND_START")
      expect(frame).toContain("Deny")
      expect(frame).toContain("Allow once")
      expect(frame).toContain("pgup/pgdn")
      expect(frame).toContain("hard review · only you can approve")
      expect(frame).not.toContain("model checks")
      expect(frame).not.toContain("Allow for this session")
      expect(descendants(app.renderer.root).some((item) => item.id === "session.guardrail.action.reject.band")).toBe(true)
      for (let page = 0; page < 200 && !app.captureCharFrame().includes("NEW_COMMAND_END"); page++) {
        app.mockInput.pressKey("\u001b[6~")
        await app.renderOnce()
      }
      expect(app.captureCharFrame()).toContain("NEW_COMMAND_END")
      expect(replies).toEqual([])
      if (decision === "once") {
        app.mockInput.pressArrow("down")
        app.mockInput.pressEnter()
        app.mockInput.pressEnter()
      }
      if (decision === "reject") {
        app.mockInput.pressEscape()
        app.mockInput.pressEscape()
      }
      await app.waitForFrame(() => replies.length > 0)
      expect(replies).toEqual([{ path: "/api/session/ses_root/guardrail/request/grq_hard_replacement/reply", reply: { reply: decision } }])
    } finally {
      settled.resolve()
      app.renderer.destroy()
    }
  })
}

const minute = 60_000

const waiting = (overrides: Partial<GuardrailRequest> = {}): GuardrailRequest => ({
  id: "grq_waiting",
  rootSessionID: "ses_root",
  sessionID: "ses_child",
  action: "shell",
  resources: ["rm -rf ."],
  ruleIDs: ["standard.review.broad-deletion"],
  reason: "Recursive deletion includes the current project",
  standard: true,
  hardReview: true,
  created: Date.now() - Guardrail.staleAfterMs - 5 * minute,
  ...overrides,
})

async function mountWaiting(
  request: GuardrailRequest,
  handlers: { onClosed?: () => void; onRetried?: () => void } = {},
  respond: Parameters<typeof createFetch>[0] = async () => undefined,
) {
  const transport = createFetch(respond)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <prompt.GuardrailPrompt request={request} {...handlers} />
                  <Toast />
                </ToastProvider>
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 110, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Guardrail blocked"))
  return app
}

const normalized = (frame: string) => frame.replace(/\s+/g, " ")

test("formats how long a review has waited and when it turns stale", () => {
  expect(prompt.guardrailWait(0, 0)).toEqual({ waited: "0s", stale: false })
  expect(prompt.guardrailWait(0, 59_900)).toEqual({ waited: "59s", stale: false })
  expect(prompt.guardrailWait(0, 65_000)).toEqual({ waited: "1m 5s", stale: false })
  expect(prompt.guardrailWait(0, Guardrail.staleAfterMs - 1).stale).toBe(false)
  expect(prompt.guardrailWait(0, Guardrail.staleAfterMs)).toEqual({ waited: "15m 0s", stale: true })
  expect(prompt.guardrailWait(0, 25 * 60 * minute + 2 * minute)).toEqual({ waited: "25h 2m", stale: true })
  expect(prompt.guardrailWait(10_000, 5_000)).toEqual({ waited: "0s", stale: false })
})

test("a stale waiting review shows its age, Stale marker, reason, session and request IDs", async () => {
  const app = await mountWaiting(waiting())
  try {
    const frame = normalized(app.captureCharFrame())
    expect(frame).toMatch(/waited 20m \d+s/)
    expect(frame).toContain("Stale")
    expect(frame).toContain("Recursive deletion includes the current project")
    expect(frame).toContain("Session ses_child")
    expect(frame).toContain("Request grq_waiting")
    expect(frame).toContain("hard review · only you can approve")
  } finally {
    app.renderer.destroy()
  }
})

test("a fresh waiting review shows its age without a Stale marker and keeps counting", async () => {
  const app = await mountWaiting(waiting({ created: Date.now() - 1_500 }))
  try {
    expect(normalized(app.captureCharFrame())).toMatch(/waited [12]s/)
    expect(app.captureCharFrame()).not.toContain("Stale")
    for (let attempt = 0; attempt < 100 && !/waited [3-9]s/.test(app.captureCharFrame()); attempt++) {
      await Bun.sleep(50)
      await app.renderOnce()
    }
    expect(normalized(app.captureCharFrame())).toMatch(/waited [3-9]s/)
  } finally {
    app.renderer.destroy()
  }
})

test("a hard review offers Deny, Allow once, Retry and Cancel but never Always", async () => {
  const app = await mountWaiting(waiting())
  try {
    const frame = app.captureCharFrame()
    for (const label of ["Deny", "Allow once", "Retry (show again)", "Cancel"]) expect(frame).toContain(label)
    expect(frame).not.toContain("Allow for this session")
  } finally {
    app.renderer.destroy()
  }
})

test("an ordinary review offers Allow for this session beside Retry and Cancel", async () => {
  const app = await mountWaiting(waiting({ hardReview: undefined }))
  try {
    const frame = app.captureCharFrame()
    for (const label of ["Deny", "Allow once", "Allow for this session", "Retry (show again)", "Cancel"]) expect(frame).toContain(label)
  } finally {
    app.renderer.destroy()
  }
})

for (const operation of ["reply", "cancel", "retry"] as const) {
  test(`the v5 guardrail fixture preserves ${operation} routing and results`, async () => {
    const request = waiting()
    const calls: string[] = []
    const transport = createFetch(async (url, input) => {
      calls.push(`${input.method} ${url.pathname}`)
      if (operation === "reply") expect(await input.json()).toEqual({ reply: "reject" })
      return operation === "retry" ? json(request) : new Response(null, { status: 204 })
    })
    const api = createApi(transport.fetch)
    const target = { sessionID: request.rootSessionID, requestID: request.id }
    try {
      const result = operation === "reply"
        ? await api.guardrail.request.reply({ ...target, reply: "reject" })
        : await api.guardrail.request[operation](target)
      expect(calls).toEqual([`POST /api/session/ses_root/guardrail/request/grq_waiting/${operation}`])
      expect(result).toEqual(operation === "retry" ? request : undefined)
    } finally {
      api.transport.close()
    }
  })
}

test("Cancel posts the cancel operation and never a reply", async () => {
  const calls: string[] = []
  const app = await mountWaiting(waiting(), {}, async (url, request) => {
    if (request.method === "POST") calls.push(`${request.method} ${url.pathname}`)
    return new Response(null, { status: 204 })
  })
  try {
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => calls.length > 0)
    expect(calls).toEqual(["POST /api/session/ses_root/guardrail/request/grq_waiting/cancel"])
  } finally {
    app.renderer.destroy()
  }
})

test("Retry only re-presents the review: one retry call, no reply or cancel, the card stays pending with its age and no toast", async () => {
  const calls: string[] = []
  const created = Date.now() - Guardrail.staleAfterMs - 5 * minute
  const retried = Promise.withResolvers<void>()
  const closed = vi.fn()
  const app = await mountWaiting(waiting({ created }), { onRetried: () => retried.resolve(), onClosed: closed }, async (url, request) => {
    if (request.method === "POST") calls.push(`${request.method} ${url.pathname}`)
    return json(waiting({ created }))
  })
  try {
    app.mockInput.pressArrow("left")
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    await retried.promise
    await Bun.sleep(100)
    await app.renderOnce()
    expect(calls).toEqual(["POST /api/session/ses_root/guardrail/request/grq_waiting/retry"])
    expect(closed).not.toHaveBeenCalled()
    const frame = normalized(app.captureCharFrame())
    expect(frame).toContain("Guardrail blocked")
    expect(frame).toMatch(/waited 20m \d+s/)
    expect(frame).toContain("Stale")
    expect(frame).toContain("Allow once")
    for (const toast of ["Success", "Info", "Warning", "Error", "approved", "rejected", "denied"]) expect(frame).not.toContain(toast)
  } finally {
    app.renderer.destroy()
  }
})

const legacy = (overrides: Partial<GuardrailRequest> = {}): GuardrailRequest => ({
  id: "grq_legacy",
  rootSessionID: "ses_root",
  sessionID: "ses_child",
  action: "shell",
  resources: ["rm -rf ."],
  ruleIDs: ["standard.review.broad-deletion"],
  reason: "Recursive deletion includes the current project",
  standard: true,
  hardReview: true,
  ...overrides,
})

test("a review without created renders no age or Stale marker and keeps its IDs, reason and every action", async () => {
  const app = await mountWaiting(legacy())
  try {
    const frame = normalized(app.captureCharFrame())
    expect(frame).not.toContain("waited")
    expect(frame).not.toContain("Stale")
    expect(frame).not.toContain("NaN")
    expect(frame).toContain("Session ses_child")
    expect(frame).toContain("Request grq_legacy")
    expect(frame).toContain("Recursive deletion includes the current project")
    for (const label of ["Deny", "Allow once", "Retry (show again)", "Cancel"]) expect(frame).toContain(label)
    expect(frame).not.toContain("Allow for this session")
  } finally {
    app.renderer.destroy()
  }
})

test("a review without created can still be cancelled", async () => {
  const calls: string[] = []
  const closed = Promise.withResolvers<void>()
  const app = await mountWaiting(legacy({ hardReview: undefined }), { onClosed: () => closed.resolve() }, async (url, request) => {
    if (request.method === "POST") calls.push(`${request.method} ${url.pathname}`)
    return new Response(null, { status: 204 })
  })
  try {
    expect(normalized(app.captureCharFrame())).toContain("Allow for this session")
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    await closed.promise
    expect(calls).toEqual(["POST /api/session/ses_root/guardrail/request/grq_legacy/cancel"])
  } finally {
    app.renderer.destroy()
  }
})

for (const [label, presses, operation] of [
  ["Deny", 0, "reply"],
  ["Cancel", 1, "cancel"],
  ["Retry", 2, "retry"],
] as const) {
  test(`${label} on a review that was settled elsewhere removes it without approving`, async () => {
    const calls: string[] = []
    const gone = Promise.withResolvers<void>()
    const review = waiting()
    const app = await mountWaiting(review, { onClosed: () => gone.resolve() }, async (url, request) => {
      if (request.method === "POST") calls.push(`${request.method} ${url.pathname}`)
      return json({ _tag: "GuardrailRequestNotFoundError", requestID: review.id, message: "Guardrail request not found" }, { status: 404 })
    })
    try {
      for (let press = 0; press < presses; press++) app.mockInput.pressArrow("left")
      app.mockInput.pressEnter()
      await gone.promise
      expect(calls).toEqual([`POST /api/session/ses_root/guardrail/request/grq_waiting/${operation}`])
    } finally {
      app.renderer.destroy()
    }
  })
}

test("a failed cancel keeps the review open", async () => {
  let closed = false
  const attempted = Promise.withResolvers<void>()
  const app = await mountWaiting(waiting(), { onClosed: () => (closed = true) }, async (_url, request) => {
    if (request.method !== "POST") return undefined
    attempted.resolve()
    return json({ _tag: "UnknownError", message: "backend unavailable" }, { status: 500 })
  })
  try {
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    await attempted.promise
    await Bun.sleep(50)
    await app.renderOnce()
    expect(closed).toBe(false)
    expect(app.captureCharFrame()).toContain("Guardrail blocked")
  } finally {
    app.renderer.destroy()
  }
})

test("closed-review notices say the action did not run", () => {
  expect(prompt.guardrailClosedNotice("cancelled")).toBe("Guardrail review cancelled. The action did not run.")
  expect(prompt.guardrailClosedNotice("expired")).toBe("Guardrail review expired. The action did not run.")
  expect(prompt.guardrailClosedNotice(undefined)).toBeUndefined()
})
