import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@ycoding-ai/client"
import { messageBoundaryIDs, reduceSessionRows } from "../../../src/routes/session/rows"

test.each(["root", "child"])(
  "places only %s review provenance chronologically and keeps family pending at the tail",
  (sessionID) => {
    const messages: SessionMessageInfo[] = [
      { type: "user", id: "first", text: "Before reviews", time: { created: 10 } },
      { type: "user", id: "last", text: "After reviews", time: { created: 50 } },
    ]
    const rows = reduceSessionRows(messages, new Set(), false, {
      sessionID,
      decisions: [{ sessionID: "root", created: 30, requestID: "decided-root", reply: "once", confidence: 0.9 }],
      dismissals: [
        {
          sessionID: "root",
          created: 20,
          eventID: "dismissed-root",
          ruleID: "standard.review.force-push",
          confidence: 0.95,
        },
        {
          sessionID: "child",
          created: 40,
          eventID: "dismissed-child",
          ruleID: "standard.review.git-destructive",
          confidence: 0.96,
        },
      ],
      pending: [
        {
          id: "pending",
          rootSessionID: "root",
          sessionID: "child",
          action: "shell",
          resources: [],
          ruleIDs: [],
          reason: "Still pending",
          standard: true,
        },
      ],
    })
    expect(
      rows.map((row) => (row.type === "guardrail" ? row.requestID : row.type === "message" ? row.messageID : row.type)),
    ).toEqual(
      sessionID === "root"
        ? ["first", "dismissed-root", "decided-root", "last", "pending"]
        : ["first", "dismissed-child", "last", "pending"],
    )
    expect(rows.at(-1)).toMatchObject({ type: "guardrail", requestID: "pending" })
  },
)

test("guardrail provenance detail reads the linked resident tool call", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "first", text: "Run it", time: { created: 10 } },
    assistant("assistant-1", [
      {
        type: "tool",
        id: "call-1",
        name: "shell",
        state: {
          status: "completed",
          input: { workdir: "/repo", command: "rm -rf /tmp/x", apiToken: "hidden" },
          content: [],
          structured: {},
        },
        time: { created: 20 },
      },
    ]),
  ]
  const rows = reduceSessionRows(messages, new Set(), false, {
    sessionID: "root",
    decisions: [
      {
        sessionID: "root",
        created: 30,
        requestID: "decided-linked",
        reply: "reject",
        confidence: 0.9,
        source: { messageID: "assistant-1", callID: "call-1" },
        ruleIDs: ["standard.review.outside-repository"],
      },
    ],
    dismissals: [],
    pending: [],
  })
  const row = rows.find((item) => item.type === "guardrail" && item.requestID === "decided-linked")
  expect(row?.type).toBe("guardrail")
  if (row?.type !== "guardrail") return
  expect(row.detail).toEqual([
    { label: "tool", value: "shell" },
    { label: "command", value: "rm -rf /tmp/x" },
    { label: "workdir", value: "/repo" },
    { label: "rule", value: "standard.review.outside-repository" },
    { label: "outcome", value: "decision model rejected · 0.9" },
  ])
})

test("guardrail provenance detail omits the tool line without a resident source", () => {
  const messages: SessionMessageInfo[] = [{ type: "user", id: "first", text: "Run it", time: { created: 10 } }]
  const rows = reduceSessionRows(messages, new Set(), false, {
    sessionID: "root",
    decisions: [
      {
        sessionID: "root",
        created: 30,
        requestID: "decided-unresident",
        reply: "once",
        confidence: 0.85,
        source: { messageID: "missing", callID: "call-9" },
        ruleIDs: ["custom.review.deploy"],
      },
    ],
    dismissals: [
      {
        sessionID: "root",
        created: 20,
        eventID: "dismissed-nosource",
        ruleID: "standard.review.database-destructive",
        confidence: 0.99,
      },
    ],
    pending: [],
  })
  const decided = rows.find((item) => item.type === "guardrail" && item.requestID === "decided-unresident")
  const dismissed = rows.find((item) => item.type === "guardrail" && item.requestID === "dismissed-nosource")
  expect(decided?.type).toBe("guardrail")
  expect(dismissed?.type).toBe("guardrail")
  if (decided?.type !== "guardrail" || dismissed?.type !== "guardrail") return
  expect(decided.detail).toEqual([
    { label: "rule", value: "custom.review.deploy" },
    { label: "outcome", value: "decision model approved once · 0.85" },
  ])
  expect(dismissed.detail).toEqual([
    { label: "rule", value: "standard.review.database-destructive" },
    { label: "outcome", value: "match verifier · not a real match · 0.99" },
  ])
})

test("guardrail grades retain every alternative, confidence and escaped evidence", () => {
  const rows = reduceSessionRows([], new Set(), true, {
    sessionID: "root",
    decisions: [
      {
        sessionID: "root",
        created: 30,
        requestID: "graded",
        reply: "always",
        choice: "approve_all",
        confidence: 1,
        grades: [
          { choice: "approve_all", confidence: 1, evidence: "Scoped \u001b[31m change" },
          { choice: "approve", confidence: 0.799999, evidence: "Below the approval threshold" },
          { choice: "reject", confidence: 0, evidence: "No destructive effect" },
          { choice: "escalate", confidence: 0.2, evidence: "No unresolved scope" },
        ],
      },
    ],
    dismissals: [],
    pending: [],
  })
  const row = rows.find((item) => item.type === "guardrail")
  expect(row?.type).toBe("guardrail")
  if (row?.type !== "guardrail") return
  expect(row.decided).toBe("decision model approved for this session · 1")
  expect(row.detail).toEqual([
    { label: "outcome", value: "decision model approved for this session · 1" },
    { label: "grade approve all (selected)", value: "1 · Scoped \\u001b[31m change" },
    { label: "grade approve", value: "0.799999 · Below the approval threshold" },
    { label: "grade reject", value: "0 · No destructive effect" },
    { label: "grade escalate", value: "0.2 · No unresolved scope" },
  ])
})

test("guardrail grades never infer a selected choice from confidence", () => {
  const rows = reduceSessionRows([], new Set(), true, {
    sessionID: "root",
    decisions: [
      {
        sessionID: "root",
        created: 1,
        requestID: "unselected",
        reply: "reject",
        grades: [{ choice: "approve_all", confidence: 1, evidence: "Reported grade without a selected choice" }],
      },
    ],
    dismissals: [],
    pending: [],
  })
  const row = rows.find((item) => item.type === "guardrail")
  expect(row?.type).toBe("guardrail")
  if (row?.type !== "guardrail") return
  expect(row.detail).toEqual([
    { label: "outcome", value: "decision model rejected · confidence unreported" },
    { label: "grade approve all", value: "1 · Reported grade without a selected choice" },
  ])
})

test("assigns assistant boundaries to the first rendered row instead of the first text row", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Question", time: { created: 0 } },
    assistant("assistant-1", [
      { type: "reasoning", text: "Thinking" },
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]),
  ]
  const rows = reduceSessionRows(messages)

  expect(messageBoundaryIDs(rows, messages)).toEqual(["user-1", "assistant-1", undefined, undefined])
})

test("groups exploration parts across assistant messages until a delimiter", () => {
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-1", text: "Explore", time: { created: 0 } },
    assistant("assistant-1", [
      { type: "text", text: "Looking" },
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
      { type: "tool", id: "glob-1", name: "glob", state: pending(), time: { created: 3 } },
    ]),
    assistant("assistant-2", [
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 5 } },
      { type: "text", text: "Done" },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    { type: "message", messageID: "user-1" },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [
        { messageID: "assistant-1", partID: "read-1" },
        { messageID: "assistant-1", partID: "glob-1" },
        { messageID: "assistant-2", partID: "grep-1" },
      ],
    },
    { type: "part", ref: { messageID: "assistant-2", partID: "text:0" } },
  ])
})

test("keeps non-exploration tools as individual part rows", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } },
      { type: "tool", id: "reasoning:0", name: "bash", state: pending(), time: { created: 2 } },
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "reasoning:0" } },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [{ messageID: "assistant-1", partID: "grep-1" }],
    },
  ])
})

test("assigns stable kind ordinals within an assistant message", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "text", text: "First" },
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Second" },
      { type: "reasoning", text: "Check" },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "reasoning:0" }],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:1" } },
    {
      type: "group",
      kind: "reasoning",
      completed: false,
      refs: [{ messageID: "assistant-1", partID: "reasoning:1" }],
    },
  ])
})

test("groups adjacent reasoning parts until a visible boundary", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "reasoning", text: "First" },
      { type: "reasoning", text: "Second" },
      { type: "text", text: "Visible" },
      { type: "reasoning", text: "Third" },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [
        { messageID: "assistant-1", partID: "reasoning:0" },
        { messageID: "assistant-1", partID: "reasoning:1" },
      ],
    },
    { type: "part", ref: { messageID: "assistant-1", partID: "text:0" } },
    {
      type: "group",
      kind: "reasoning",
      completed: false,
      refs: [{ messageID: "assistant-1", partID: "reasoning:2" }],
    },
  ])
})

test("groups across empty assistant reasoning parts", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [
      { type: "reasoning", text: "Looking" },
      { type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 2 } },
    ]),
    assistant("assistant-2", [
      { type: "reasoning", text: "" },
      { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
    ]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "reasoning",
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "reasoning:0" }],
    },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [
        { messageID: "assistant-1", partID: "read-1" },
        { messageID: "assistant-2", partID: "grep-1" },
      ],
    },
  ])
})

test("completes exploration groups when another row follows", () => {
  const finished = assistant("assistant-2", [
    { type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } },
  ])
  finished.finish = "stop"
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    { type: "user", id: "user-1", text: "Continue", time: { created: 2 } },
    finished,
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "message", messageID: "user-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    },
    { type: "assistant-footer", messageID: "assistant-2" },
  ])
})

test("hides synthetic messages without descriptions", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    {
      type: "synthetic",
      id: "synthetic-1",
      text: "internal context",
      time: { created: 2 },
    },
    assistant("assistant-2", [{ type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } }]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [
        { messageID: "assistant-1", partID: "read-1" },
        { messageID: "assistant-2", partID: "grep-1" },
      ],
    },
  ])
})

test("renders synthetic messages with descriptions", () => {
  const messages: SessionMessageInfo[] = [
    assistant("assistant-1", [{ type: "tool", id: "read-1", name: "read", state: pending(), time: { created: 1 } }]),
    {
      type: "synthetic",
      id: "synthetic-1",
      text: "internal context",
      description: "Explicit notice",
      time: { created: 2 },
    },
    assistant("assistant-2", [{ type: "tool", id: "grep-1", name: "grep", state: pending(), time: { created: 3 } }]),
  ]

  expect(reduceSessionRows(messages)).toEqual([
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: true,
      refs: [{ messageID: "assistant-1", partID: "read-1" }],
    },
    { type: "message", messageID: "synthetic-1" },
    {
      type: "group",
      kind: "exploration",
      pending: [],
      completed: false,
      refs: [{ messageID: "assistant-2", partID: "grep-1" }],
    },
  ])
})

test("renders a footer for a pre-output retry assistant after replay", () => {
  const message = assistant("assistant-retry", [])
  message.retry = {
    attempt: 2,
    at: 2_000,
    error: { type: "provider.transport", message: "Disconnected" },
  }

  expect(reduceSessionRows([message])).toEqual([{ type: "assistant-footer", messageID: "assistant-retry" }])
})

test("places a running compaction barrier before every queued user message", () => {
  const queued = (id: string, text: string, created: number): SessionMessageInfo => ({
    type: "user",
    id,
    text,
    time: { created },
  })
  const messages: SessionMessageInfo[] = [
    queued("user-before", "Before", 1),
    {
      type: "compaction",
      id: "compaction",
      status: "running",
      reason: "manual",
      summary: "",
      recent: "",
      time: { created: 2 },
    },
    queued("user-after", "After", 3),
  ]

  expect(reduceSessionRows(messages, new Set(["user-before", "user-after"]))).toEqual([
    { type: "message", messageID: "compaction" },
    { type: "message", messageID: "user-before" },
    { type: "message", messageID: "user-after" },
  ])
})

function assistant(id: string, content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
    time: { created: 1 },
  }
}

function pending() {
  return { status: "streaming" as const, input: "" }
}

test("baseline allow and deny choices render their outcome and graded provenance", () => {
  const grades = [
    { choice: "allow", confidence: 0.9, evidence: "Scoped to the repository" },
    { choice: "deny", confidence: 0.05, evidence: "No destructive effect" },
    { choice: "escalate", confidence: 0.05, evidence: "No ambiguity" },
  ] as const
  const rows = reduceSessionRows([], new Set(), true, {
    sessionID: "root",
    decisions: [
      { sessionID: "root", created: 1, requestID: "baseline-allow", reply: "once", choice: "allow", confidence: 0.9, grades: [...grades] },
      { sessionID: "root", created: 2, requestID: "baseline-deny", reply: "reject", choice: "deny", confidence: 0.8 },
    ],
    dismissals: [],
    pending: [],
  })
  const allow = rows.find((item) => item.type === "guardrail" && item.requestID === "baseline-allow")
  const deny = rows.find((item) => item.type === "guardrail" && item.requestID === "baseline-deny")
  if (allow?.type !== "guardrail" || deny?.type !== "guardrail") throw new Error("expected baseline guardrail rows")
  expect(allow.detail).toEqual([
    { label: "outcome", value: "decision model approved once · 0.9" },
    { label: "grade allow (selected)", value: "0.9 · Scoped to the repository" },
    { label: "grade deny", value: "0.05 · No destructive effect" },
    { label: "grade escalate", value: "0.05 · No ambiguity" },
  ])
  expect(deny.detail).toEqual([{ label: "outcome", value: "decision model rejected · 0.8" }])
})

test("guardrail decisions name their baseline or YOLO authority only when recorded", () => {
  const rows = reduceSessionRows([], new Set(), true, {
    sessionID: "root",
    decisions: [
      { sessionID: "root", created: 1, requestID: "baseline", reply: "once", authority: "baseline", choice: "allow", confidence: 0.9 },
      { sessionID: "root", created: 2, requestID: "yolo", reply: "reject", authority: "yolo", choice: "approve", confidence: 0.8 },
      { sessionID: "root", created: 3, requestID: "historical", reply: "once", confidence: 0.85 },
    ],
    dismissals: [],
    pending: [],
  })
  expect(rows.flatMap((row) => (row.type === "guardrail" ? [row.decided] : []))).toEqual([
    "baseline decision model approved once · 0.9",
    "YOLO decision model approve · 0.8 · rejected",
    "decision model approved once · 0.85",
  ])
})
