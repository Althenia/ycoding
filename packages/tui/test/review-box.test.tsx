/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import type { SessionReviewDecision, SessionReviewItem } from "@ycoding-ai/client"
import { ClipboardProvider } from "../src/context/clipboard"
import { ClientProvider } from "../src/context/client"
import { ThemeProvider } from "../src/context/theme"
import { Keymap } from "../src/context/keymap"
import { ConfigProvider } from "../src/config"
import { ToastProvider } from "../src/ui/toast"
import { DialogProvider } from "../src/ui/dialog"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createApi, createFetch } from "./fixture/tui-client"

const { ReviewBox, ReviewItemEditor, reviewReasonLabel } = await import("../src/routes/session/review-box")

test("review reasons label decision failures with their recorded diagnostic, never as a model escalation", () => {
  expect(reviewReasonLabel("unsupported-output")).toContain("Decision unavailable")
  expect(reviewReasonLabel("unsupported-output")).toContain("does not support strict structured")
  expect(reviewReasonLabel("conflicting_grades")).toContain("conflicting")
  for (const reason of [
    "unavailable",
    "invalid-request",
    "provider-failed",
    "input-too-large",
    "invalid-output",
    "truncated-output",
  ] as const) {
    expect(reviewReasonLabel(reason)).toContain("Decision unavailable")
    expect(reviewReasonLabel(reason)).not.toContain("model escalated")
  }
  expect(reviewReasonLabel("escalated")).toBe("decision model escalated")
  expect(reviewReasonLabel("disabled")).toBe("automatic decisions are disabled")
})

const fingerprint = "a".repeat(64)
const guardrailItem: SessionReviewItem = {
  itemID: "rvw_guardrail" as SessionReviewItem["itemID"],
  kind: "guardrail",
  reason: "escalated",
  choice: "escalate",
  confidence: 0.42,
  origin: { requestID: "grq_1" },
  payload: {
    type: "guardrail",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    hardReview: true,
    directories: [],
    fingerprint,
    requestID: "grq_1" as never,
  },
  sessionID: "ses_root",
  rootSessionID: "ses_root",
  sessionTitle: "Root work",
  created: 1,
}
const ordinaryItem: SessionReviewItem = {
  ...guardrailItem,
  itemID: "rvw_ordinary" as SessionReviewItem["itemID"],
  payload: {
    type: "guardrail",
    action: "write",
    resources: ["/etc/hosts"],
    ruleIDs: ["standard.review.outside-repository"],
    reason: "Write outside the repository",
    hardReview: false,
    directories: ["/etc"],
    fingerprint,
    requestID: "grq_2" as never,
  },
  created: 2,
}
const childItem: SessionReviewItem = {
  itemID: "rvw_child" as SessionReviewItem["itemID"],
  kind: "subagent_question",
  reason: "low_confidence",
  confidence: 0.5,
  origin: { questionID: "qst_1" as never },
  payload: { type: "subagent_question", text: "Which database should the child use?" as never },
  sessionID: "ses_child",
  rootSessionID: "ses_root",
  sessionTitle: "Child work",
  created: 3,
  child: { agent: "build" as never, description: "Wire storage" as never },
}
const questionItem: SessionReviewItem = {
  itemID: "rvw_question" as SessionReviewItem["itemID"],
  kind: "question",
  reason: "free_text",
  origin: { messageID: "msg_1" as never, callID: "call_1" },
  payload: {
    type: "form",
    title: "Pick a target",
    questionTool: true,
    fields: [
      {
        key: "target",
        type: "string",
        title: "Target",
        required: true,
        options: [
          { value: "staging", label: "Staging" },
          { value: "prod", label: "Production" },
        ],
      },
    ] as never,
  },
  sessionID: "ses_root",
  rootSessionID: "ses_root",
  sessionTitle: "Root work",
  created: 4,
}
const permissionItem = {
  itemID: "rvw_permission" as SessionReviewItem["itemID"],
  kind: "permission",
  reason: "sleep_entry",
  origin: { requestID: "per_1" },
  payload: {
    type: "permission",
    action: "edit",
    resources: ["/repo/src/index.ts"],
    fingerprint,
    fingerprintVersion: 2,
    requestID: "per_1" as never,
  },
  sessionID: "ses_root",
  rootSessionID: "ses_root",
  sessionTitle: "Root work",
  created: 5,
} satisfies SessionReviewItem

async function mount(body: () => JSX.Element, settle: string, height = 30, mode: "dark" | "light" = "dark") {
  const transport = createFetch(() => undefined)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClipboardProvider value={{ write: () => Promise.resolve() }}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ClientProvider api={createApi(transport.fetch)}>
                <ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
                  <ToastProvider>
                    <DialogProvider>{body()}</DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    ),
    { width: 120, height, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(settle))
  return app
}

test("Project escalation preserves the whole reason chain in the human review box", async () => {
  const item = {
    ...permissionItem,
    payload: {
      ...permissionItem.payload,
      coordinationEscalation: {
        reasons: [
          { sessionID: "ses_driver", reason: "The target is outside the assignment." },
          { sessionID: "ses_master", reason: "Confirm this additional target." },
        ],
      },
    },
  }
  const app = await mount(
    () => (
      <ReviewBox
        items={[item]}
        currentSessionID="ses_root"
        asleep={false}
        failed={{}}
        onOpen={() => {}}
        onJump={() => {}}
        onDismiss={() => {}}
      />
    ),
    "Review · 1 waiting",
    40,
  )
  try {
    expect(app.captureCharFrame()).toContain("Project escalation")
    expect(app.captureCharFrame()).toContain("The target is outside the assignment.")
    expect(app.captureCharFrame()).toContain("Confirm this additional target.")
  } finally {
    app.renderer.destroy()
  }
})

for (const mode of ["dark", "light"] as const) {
  test(`review grades stay informational and escaped in ${mode} mode`, async () => {
    const opened: string[] = []
    const [items, setItems] = createSignal<SessionReviewItem[]>([
      {
        ...ordinaryItem,
        confidence: 0.9,
        grades: [
          { choice: "approve_all", confidence: 0.799999, evidence: "Scoped \u001b[31m operation" },
          { choice: "approve", confidence: 0.7, evidence: "The target needs confirmation" },
          { choice: "reject", confidence: 0, evidence: "No destructive effect" },
          { choice: "escalate", confidence: 0.9, evidence: "A human must verify the scope" },
        ],
      },
    ])
    const app = await mount(
      () => (
        <ReviewBox
          items={items()}
          currentSessionID="ses_root"
          asleep={false}
          failed={{}}
          onOpen={(item) => opened.push(item.itemID)}
          onJump={() => {}}
          onDismiss={() => {}}
        />
      ),
      "Review · 1 waiting",
      40,
      mode,
    )
    try {
      expect(app.captureCharFrame()).toContain("grade approve all 0.799999 · Scoped \\u001b[31m operation")
      expect(app.captureCharFrame()).toContain("grade reject 0 · No destructive effect")
      expect(app.captureCharFrame()).toContain("grade escalate (selected) 0.9 · A human must verify the scope")
      expect(app.captureCharFrame()).not.toContain("\u001b")
      expect(opened).toEqual([])
      setItems([{ ...ordinaryItem, reason: "refused", choice: undefined, confidence: undefined }])
      await app.waitForFrame((frame) => !frame.includes("grade approve all"))
      expect(app.captureCharFrame()).not.toContain("grade reject")
      expect(app.captureCharFrame()).toContain("decision model refused")
      expect(opened).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
}

test("lists items with attribution, provenance, and actions, and opens or dismisses them", async () => {
  const opened: string[] = []
  const dismissed: string[] = []
  const app = await mount(
    () => (
      <ReviewBox
        items={[guardrailItem, childItem, questionItem]}
        currentSessionID="ses_root"
        asleep={false}
        failed={{}}
        onOpen={(item) => opened.push(item.itemID)}
        onJump={() => {}}
        onDismiss={(item) => dismissed.push(item.itemID)}
      />
    ),
    "Review · 3 waiting",
    60,
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Guardrail review")
    expect(frame).toContain("Root work")
    expect(frame).toContain("child · build · Wire storage")
    expect(frame).toContain("decision model escalated · escalate · 0.42")
    expect(frame).toContain("decision model was unsure")
    expect(frame).toContain("needs a written answer")
    expect(frame).toContain("Decide")
    expect(frame).toContain("Answer")
    expect(frame).toContain("Dismiss")
    const lines = frame.split("\n")
    const decideRow = lines.findIndex((line) => line.includes("Decide"))
    await app.mockMouse.click(lines[decideRow]!.indexOf("Decide") + 1, decideRow)
    expect(opened).toEqual(["rvw_guardrail"])
    const dismissRow = lines.findIndex((line) => line.includes("Dismiss"))
    await app.mockMouse.click(lines[dismissRow]!.indexOf("Dismiss") + 1, dismissRow)
    expect(dismissed).toEqual(["rvw_child"])
  } finally {
    app.renderer.destroy()
  }
})

test("starts collapsed while asleep and expands from its header", async () => {
  const app = await mount(
    () => (
      <ReviewBox
        items={[guardrailItem]}
        currentSessionID="ses_root"
        asleep={true}
        failed={{}}
        onOpen={() => {}}
        onJump={() => {}}
        onDismiss={() => {}}
      />
    ),
    "Review · 1 waiting",
  )
  try {
    expect(app.captureCharFrame()).toContain("+")
    expect(app.captureCharFrame()).not.toContain("Guardrail review")
    const headerRow = app
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Review · 1 waiting"))
    await app.mockMouse.click(4, headerRow)
    await app.waitForFrame((frame) => frame.includes("Guardrail review"))
  } finally {
    app.renderer.destroy()
  }
})

test("pending decisions disable every item action until settlement", async () => {
  const opened: string[] = []
  const dismissed: string[] = []
  const app = await mount(
    () => (
      <ReviewBox
        items={[guardrailItem, questionItem]}
        currentSessionID="ses_root"
        asleep={false}
        pendingItemID={guardrailItem.itemID}
        failed={{}}
        onOpen={(item) => opened.push(item.itemID)}
        onJump={() => {}}
        onDismiss={(item) => dismissed.push(item.itemID)}
      />
    ),
    "Review · 2 waiting",
    60,
  )
  try {
    const lines = app.captureCharFrame().split("\n")
    const decide = lines.findIndex((line) => line.includes("Decide"))
    await app.mockMouse.click(lines[decide]!.indexOf("Decide") + 1, decide)
    const dismiss = lines.findIndex((line) => line.includes("Dismiss"))
    await app.mockMouse.click(lines[dismiss]!.indexOf("Dismiss") + 1, dismiss)
    expect(opened).toEqual([])
    expect(dismissed).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("hard guardrail editor omits Always and decides once from the keyboard", async () => {
  const decisions: SessionReviewDecision[] = []
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={guardrailItem}
        disabled={false}
        onDecide={async (_item, decision) => {
          decisions.push(decision)
        }}
        onClose={() => {}}
      />
    ),
    "Guardrail blocked",
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("git reset --hard")
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Deny")
    expect(frame).not.toContain("Allow for this session")
    app.mockInput.pressKey("l")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => decisions.length > 0)
    expect(decisions).toEqual([{ kind: "guardrail", reply: "once" }])
  } finally {
    app.renderer.destroy()
  }
})

test("ordinary guardrail editor offers Always only with outside directories", async () => {
  const app = await mount(
    () => <ReviewItemEditor item={ordinaryItem} disabled={false} onDecide={async () => {}} onClose={() => {}} />,
    "Guardrail blocked",
  )
  try {
    expect(app.captureCharFrame()).toContain("Allow for this session")
    expect(app.captureCharFrame()).toContain("/etc/hosts")
  } finally {
    app.renderer.destroy()
  }
})

test("permission editor omits Always without save patterns", async () => {
  const app = await mount(
    () => <ReviewItemEditor item={permissionItem} disabled={false} onDecide={async () => {}} onClose={() => {}} />,
    "Permission required",
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).not.toContain("Allow always")
    expect(frame).toContain("/repo/src/index.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("question form editor submits through the review decision", async () => {
  const decisions: SessionReviewDecision[] = []
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={questionItem}
        disabled={false}
        onDecide={async (_item, decision) => {
          decisions.push(decision)
        }}
        onClose={() => {}}
      />
    ),
    "Pick a target",
  )
  try {
    expect(app.captureCharFrame()).toContain("Staging")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => decisions.length > 0)
    expect(decisions).toEqual([{ kind: "question", answers: { target: "staging" } }])
  } finally {
    app.renderer.destroy()
  }
})

test("subagent question editor sends a typed answer through the review decision", async () => {
  const decisions: SessionReviewDecision[] = []
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={childItem}
        disabled={false}
        onDecide={async (_item, decision) => {
          decisions.push(decision)
        }}
        onClose={() => {}}
      />
    ),
    "Which database should the child use?",
  )
  try {
    for (const key of "Use SQLite") app.mockInput.pressKey(key)
    app.mockInput.pressEnter()
    await app.waitForFrame(() => decisions.length > 0)
    expect(decisions).toEqual([{ kind: "subagent_question", text: "Use SQLite" }])
  } finally {
    app.renderer.destroy()
  }
})

test("review details visibly escape terminal and bidirectional controls", async () => {
  const item: SessionReviewItem = {
    ...guardrailItem,
    payload: {
      ...guardrailItem.payload,
      action: "shell\u001b[2J",
      resources: ["echo \u202efake"],
      ruleIDs: ["rule\u0007"],
    },
  }
  const app = await mount(
    () => <ReviewItemEditor item={item} disabled={false} onDecide={async () => {}} onClose={() => {}} />,
    "Guardrail blocked",
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("shell\\u001b[2J")
    expect(frame).toContain("echo \\u202efake")
    expect(frame).toContain("rule\\u0007")
  } finally {
    app.renderer.destroy()
  }
})

test("an in-flight review decision disables controls and cannot send twice", async () => {
  const [disabled, setDisabled] = createSignal(false)
  const decisions: SessionReviewDecision[] = []
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={guardrailItem}
        disabled={disabled()}
        onDecide={async (_item, decision) => {
          decisions.push(decision)
          setDisabled(true)
        }}
        onClose={() => {}}
      />
    ),
    "Guardrail blocked",
  )
  try {
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Decision controls unavailable"))
    app.mockInput.pressKey("l")
    app.mockInput.pressEnter()
    expect(decisions).toEqual([{ kind: "guardrail", reply: "reject" }])
    const lines = app.captureSpans().lines.flatMap((line) => line.spans)
    const deny = lines.find((span) => span.text.includes("Deny"))
    expect(deny?.fg.toInts()).toEqual((await import("@opentui/core")).RGBA.fromHex("#98A2B3").toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("Not now closes without deciding, and permission save patterns expose Always", async () => {
  const decisions: SessionReviewDecision[] = []
  let closed = 0
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={{ ...permissionItem, payload: { ...permissionItem.payload, save: ["/repo/**"] } }}
        disabled={false}
        onDecide={async (_item, decision) => {
          decisions.push(decision)
        }}
        onClose={() => closed++}
      />
    ),
    "Permission required",
  )
  try {
    expect(app.captureCharFrame()).toContain("Allow always")
    app.mockInput.pressKey("ESCAPE")
    await app.waitForFrame(() => closed === 1)
    expect(decisions).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

for (const exit of ["escape", "mouse"] as const) {
  test(`failed question review retains its ${exit} close action`, async () => {
    let closed = 0
    const decisions: SessionReviewDecision[] = []
    const app = await mount(
      () => (
        <ReviewItemEditor
          item={questionItem}
          disabled={true}
          error="Outcome unknown"
          onDecide={async (_item, decision) => {
            decisions.push(decision)
          }}
          onClose={() => closed++}
        />
      ),
      "Decision unresolved",
    )
    try {
      if (exit === "escape") app.mockInput.pressKey("ESCAPE")
      if (exit === "mouse") {
        const row = app
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes("not now"))
        expect(row).toBeGreaterThanOrEqual(0)
        await app.mockMouse.click(5, row)
      }
      await app.waitForFrame(() => closed === 1)
      expect(decisions).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
}

test("question and child editors can dismiss without fabricating an answer", async () => {
  for (const item of [questionItem, childItem]) {
    const decisions: SessionReviewDecision[] = []
    const app = await mount(
      () => (
        <ReviewItemEditor
          item={item}
          disabled={false}
          onDecide={async (_item, decision) => {
            decisions.push(decision)
          }}
          onClose={() => {}}
        />
      ),
      "ctrl+shift+d dismiss",
    )
    try {
      app.mockInput.pressKey("d", { ctrl: true, shift: true })
      await app.waitForFrame(() => decisions.length === 1)
      expect(decisions).toEqual([{ kind: item.kind, dismissed: true }])
    } finally {
      app.renderer.destroy()
    }
  }
})

const recoveryItem = {
  itemID: "rvw_recovery",
  kind: "recovery",
  reason: "restart",
  origin: { requestID: "rec_1" },
  payload: {
    type: "recovery",
    tools: [
      { messageID: "msg_tools", callID: "call_edit", name: "edit\u001b[31m" },
      { messageID: "msg_tools", callID: "call_shell", name: "shell" },
    ],
  },
  sessionID: "ses_child",
  rootSessionID: "ses_root",
  sessionTitle: "Child work",
  created: 6,
  child: { agent: "build", description: "Wire storage" },
} as unknown as SessionReviewItem

test("recovery items list as Restart recovery with child attribution, the restart reason, and no Dismiss", async () => {
  const opened: string[] = []
  const app = await mount(
    () => (
      <ReviewBox
        items={[recoveryItem]}
        currentSessionID="ses_root"
        asleep={false}
        failed={{}}
        onOpen={(item) => opened.push(item.itemID)}
        onJump={() => {}}
        onDismiss={() => {}}
      />
    ),
    "Review · 1 waiting",
    40,
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Restart recovery")
    expect(frame).toContain("child · build · Wire storage")
    expect(frame).toContain("child restarted during tool execution")
    expect(frame).toContain("Decide")
    expect(frame).not.toContain("Dismiss")
    const lines = frame.split("\n")
    const row = lines.findIndex((line) => line.includes("Decide"))
    await app.mockMouse.click(lines[row]!.indexOf("Decide") + 1, row)
    expect(opened).toEqual(["rvw_recovery"])
  } finally {
    app.renderer.destroy()
  }
})

test("recovery editor states the uncertainty, lists escaped tool identities without inputs, and offers no Dismiss", async () => {
  const app = await mount(
    () => <ReviewItemEditor item={recoveryItem} disabled={false} onDecide={async () => {}} onClose={() => {}} />,
    "Restart recovery",
    40,
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("outcome is unknown")
    expect(frame).toContain("does not replay")
    expect(frame).toContain("edit\\u001b[31m")
    expect(frame).not.toContain("\u001b")
    expect(frame).toContain("call_edit")
    expect(frame).toContain("call_shell")
    expect(frame).toContain("msg_tools")
    expect(frame).toContain("Continue")
    expect(frame).toContain("Stop")
    expect(frame).toContain("Not now")
    expect(frame).not.toContain("Dismiss")
    expect(frame).not.toContain("ctrl+shift+d")
  } finally {
    app.renderer.destroy()
  }
})

test("recovery decisions are explicit: Enter alone never decides, Continue and Stop send their choice", async () => {
  const decisions: SessionReviewDecision[] = []
  let closed = 0
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={recoveryItem}
        disabled={false}
        onDecide={async (_item, decision) => {
          decisions.push(decision)
        }}
        onClose={() => closed++}
      />
    ),
    "Restart recovery",
    40,
  )
  try {
    app.mockInput.pressEnter()
    await app.waitForFrame(() => closed === 1)
    expect(decisions).toEqual([])
    app.mockInput.pressKey("h")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => decisions.length === 1)
    expect(decisions).toEqual([{ kind: "recovery", choice: "stop" }])
    app.mockInput.pressKey("h")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => decisions.length === 2)
    expect(decisions[1]).toEqual({ kind: "recovery", choice: "continue" })
  } finally {
    app.renderer.destroy()
  }
})

test("a disabled recovery editor blocks Continue and Stop but keeps Not now usable", async () => {
  const decisions: SessionReviewDecision[] = []
  let closed = 0
  const app = await mount(
    () => (
      <ReviewItemEditor
        item={recoveryItem}
        disabled={true}
        error="Decision outcome unknown"
        onDecide={async (_item, decision) => {
          decisions.push(decision)
        }}
        onClose={() => closed++}
      />
    ),
    "Decision controls unavailable",
    40,
  )
  try {
    expect(app.captureCharFrame()).toContain("Decision unresolved · Decision outcome unknown")
    app.mockInput.pressKey("h")
    app.mockInput.pressEnter()
    app.mockInput.pressKey("h")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(decisions).toEqual([])
    app.mockInput.pressEscape()
    await app.waitForFrame(() => closed > 0)
  } finally {
    app.renderer.destroy()
  }
})

const disabledItem = {
  ...ordinaryItem,
  itemID: "rvw_disabled" as SessionReviewItem["itemID"],
  reason: "disabled",
  choice: undefined,
  confidence: undefined,
  grades: undefined,
} as unknown as SessionReviewItem

test("a disabled review reads as configuration, not as a decision model outcome, in the row and the editor", async () => {
  const app = await mount(
    () => (
      <>
        <ReviewBox
          items={[disabledItem]}
          currentSessionID="ses_root"
          asleep={true}
          failed={{}}
          onOpen={() => {}}
          onJump={() => {}}
          onDismiss={() => {}}
        />
        <ReviewItemEditor item={disabledItem} disabled={false} onDecide={async () => {}} onClose={() => {}} />
      </>
    ),
    "Guardrail blocked",
    50,
  )
  try {
    await app.mockMouse.click(
      4,
      app
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Review · 1 waiting")),
    )
    await app.waitForFrame((frame) => frame.includes("Guardrail review"))
    const frame = app.captureCharFrame()
    expect(frame.match(/automatic decisions are disabled/g)).toHaveLength(2)
    expect(frame).not.toContain("decision model")
    expect(frame).not.toContain("(selected)")
    expect(frame).not.toContain("grade ")
    expect(frame).toContain("Write outside the repository")
    expect(frame).toContain("Allow once")
  } finally {
    app.renderer.destroy()
  }
})
