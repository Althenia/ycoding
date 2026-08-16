import { describe, expect, test } from "bun:test"
import Notifications, { createNotifications } from "../../../../src/feature-plugins/system/notifications"
import { createBuiltinPlugins } from "../../../../src/feature-plugins/builtins"
import { builtins } from "../../../../src/plugin/builtins"
import type { YCodingEvent, SessionAutonomyState } from "@ycoding-ai/client"
import type { TuiAttentionNotifyInput } from "../../../../src/plugin/host-api"
import type { Context } from "@ycoding-ai/plugin/tui/context"
import { createTuiPluginContext } from "../../../fixture/tui-plugin"

type Session = NonNullable<ReturnType<Context["data"]["session"]["get"]>>

async function setup(options: { rejectFirstNotification?: boolean } = {}) {
  const notifications: TuiAttentionNotifyInput[] = []
  const handlers = new Map<YCodingEvent["type"], ((event: YCodingEvent) => void)[]>()
  const scheduled: Array<{ cancelled: boolean; delay: number; run: () => Promise<void> }> = []
  const forms = new Map<string, ReturnType<typeof form>>()
  const questions = new Map<string, ReturnType<typeof question>>()
  const permissions = new Map<string, ReturnType<typeof permission>>()
  const guardrails = new Map<string, ReturnType<typeof guardrail>>()
  const autonomy = new Map<string, SessionAutonomyState>()
  const waits = new Map<string, PromiseWithResolvers<void>>()
  let notificationAttempts = 0
  const session = (id: string, title: string, parentID?: string): Session => ({
    id,
    title,
    projectID: "project",
    location: { directory: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(parentID && { parentID }),
    time: { created: 0, updated: 0 },
  })
  const sessions: Record<string, Session> = {
    session: session("session", "Demo session"),
    subagent: session("subagent", "Subagent session", "session"),
    abort: session("abort", "Abort session"),
    timeout: session("timeout", "Timeout session"),
  }

  const plugin = createNotifications((delay, run) => {
    const item = { cancelled: false, delay, run }
    scheduled.push(item)
    return () => {
      item.cancelled = true
    }
  })
  const cleanup = await plugin.setup(
    createTuiPluginContext({
      attention: {
        async notify(input) {
          notificationAttempts += 1
          notifications.push(input)
          if (options.rejectFirstNotification && notificationAttempts === 1) throw new Error("notification failed")
          return { ok: true, notification: true, sound: true }
        },
      },
      // The harness supplies only client methods exercised by this plugin.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      client: {
        form: {
          list: async ({ sessionID }: { sessionID: string }) =>
            Array.from(forms.values()).filter((item) => item.sessionID === sessionID),
          request: {
            list: async () => ({
              location: { directory: "/workspace", project: { id: "project", directory: "/workspace" } },
              data: Array.from(forms.values()).filter((item) => item.sessionID === "global"),
            }),
          },
        },
        question: {
          list: async ({ sessionID }: { sessionID: string }) =>
            Array.from(questions.values()).filter((item) => item.sessionID === sessionID),
        },
        permission: {
          list: async ({ sessionID }: { sessionID: string }) =>
            Array.from(permissions.values()).filter((item) => item.sessionID === sessionID),
        },
        guardrail: {
          request: {
            list: async ({ sessionID }: { sessionID: string }) =>
              Array.from(guardrails.values()).filter((item) => item.rootSessionID === sessionID),
          },
        },
        session: {
          get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
          wait: async ({ sessionID }: { sessionID: string }) => waits.get(sessionID)?.promise,
          autonomy: {
            get: async ({ sessionID }: { sessionID: string }) => autonomy.get(sessionID) ?? { mode: "normal", yolo: false },
          },
        },
      } as unknown as Context["client"],
      data: {
        on: <Type extends YCodingEvent["type"]>(
          type: Type,
          handler: (event: Extract<YCodingEvent, { type: Type }>) => void,
        ) => {
          const list = handlers.get(type) ?? []
          // The event type and handler are paired by Context.data.on.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          const wrapped = handler as (event: YCodingEvent) => void
          list.push(wrapped)
          handlers.set(type, list)
          return () => {
            handlers.set(
              type,
              (handlers.get(type) ?? []).filter((item) => item !== wrapped),
            )
          }
        },
        session: {
          get: (sessionID: string) => sessions[sessionID],
        },
      },
    }),
  )

  return {
    notifications,
    autonomy,
    waits,
    scheduled,
    async flush() {
      await Promise.all(
        scheduled
          .splice(0)
          .filter((item) => !item.cancelled)
          .map((item) => item.run()),
      )
    },
    cleanup: cleanup ?? (() => {}),
    listenerCount() {
      return Array.from(handlers.values()).reduce((total, items) => total + items.length, 0)
    },
    emit(event: YCodingEvent) {
      if (event.type === "form.created") forms.set(event.data.form.id, event.data.form)
      if (event.type === "form.replied" || event.type === "form.cancelled") forms.delete(event.data.id)
      if (event.type === "question.v2.asked") questions.set(event.data.id, event.data)
      if (event.type === "question.v2.replied" || event.type === "question.v2.rejected")
        questions.delete(event.data.requestID)
      if (event.type === "permission.v2.asked") permissions.set(event.data.id, event.data)
      if (event.type === "permission.v2.replied") permissions.delete(event.data.requestID)
      if (event.type === "guardrail.asked") guardrails.set(event.data.id, event.data)
      if (event.type === "guardrail.replied") guardrails.delete(event.data.requestID)
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
  }
}

function question(id: string, sessionID = "session"): Extract<YCodingEvent, { type: "question.v2.asked" }>["data"] {
  return {
    id,
    sessionID,
    questions: [],
  }
}

function form(id: string, sessionID = "session"): Extract<YCodingEvent, { type: "form.created" }>["data"]["form"] {
  return {
    id,
    sessionID,
    title: "Input requested",
    fields: [{ key: "authorization", type: "external", url: "https://example.com" }],
  }
}

function permission(
  id: string,
  sessionID = "session",
): Extract<YCodingEvent, { type: "permission.v2.asked" }>["data"] {
  return {
    id,
    sessionID,
    action: "edit",
    resources: [],
    metadata: {},
  }
}

function guardrail(
  id: string,
  sessionID = "session",
  rootSessionID = sessionID,
): Extract<YCodingEvent, { type: "guardrail.asked" }>["data"] {
  return {
    id,
    sessionID,
    rootSessionID,
    action: "shell",
    resources: [],
    ruleIDs: [],
    reason: "Guardrail review",
    standard: true,
  }
}

function durable(sessionID: string): { aggregateID: string; seq: number; version: 1 } {
  return { aggregateID: sessionID, seq: 0, version: 1 }
}

function executionStarted(id: string, sessionID = "session"): YCodingEvent {
  return {
    id,
    created: 0,
    type: "session.execution.started",
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function executionSucceeded(id: string, sessionID = "session"): YCodingEvent {
  return {
    id,
    created: 0,
    type: "session.execution.succeeded",
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function executionFailed(id: string, sessionID = "session"): YCodingEvent {
  return {
    id,
    created: 0,
    type: "session.execution.failed",
    durable: durable(sessionID),
    data: {
      sessionID,
      error: { type: "unknown", message: "boom" },
    },
  }
}

function executionInterrupted(
  id: string,
  reason: "user" | "shutdown" | "superseded",
  sessionID = "session",
): YCodingEvent {
  return {
    id,
    created: 0,
    type: "session.execution.interrupted",
    durable: durable(sessionID),
    data: { sessionID, reason },
  }
}

async function settle() {
  for (const _ of Array.from({ length: 12 })) await Promise.resolve()
}

const questionNotification: TuiAttentionNotifyInput = {
  title: "Demo session",
  message: "Question needs input",
  notification: { when: "blurred" },
  sound: { name: "question", when: "always" },
}

const formNotification: TuiAttentionNotifyInput = {
  title: "Input requested",
  message: "Input needs response",
  notification: { when: "blurred" },
  sound: { name: "question", when: "always" },
}

const titledFormNotification: TuiAttentionNotifyInput = {
  ...formNotification,
  title: "Confirm deployment",
}

const globalFormNotification: TuiAttentionNotifyInput = {
  ...formNotification,
  title: "demo-mcp is requesting input",
}

const permissionNotification: TuiAttentionNotifyInput = {
  title: "Demo session",
  message: "Permission needs input",
  notification: { when: "blurred" },
  sound: { name: "permission", when: "always" },
}

const guardrailNotification: TuiAttentionNotifyInput = {
  title: "Demo session",
  message: "Guardrail approval needed",
  notification: { when: "blurred" },
  sound: { name: "permission", when: "always" },
}

describe("internal notifications TUI plugin", () => {
  test("uses only the V2 plugin runtime", () => {
    expect("setup" in Notifications).toBe(true)
    expect(createBuiltinPlugins().some((plugin) => plugin.id === "internal:notifications")).toBe(false)
  })

  test("registers notifications in the active V2 builtin list", () => {
    expect(builtins.filter((plugin) => plugin.id === "internal:notifications")).toHaveLength(1)
  })

  test("provides a deterministic notification factory", async () => {
    const module = await import("../../../../src/feature-plugins/system/notifications")
    expect(module.createNotifications).toBeFunction()
  })

  test("alerts only after a request remains pending for 500ms", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", created: 0, type: "permission.v2.asked", data: permission("permission-1") })

    expect(harness.notifications).toEqual([])
    expect(harness.scheduled.map((item) => item.delay)).toEqual([500])

    await harness.flush()

    expect(harness.notifications).toEqual([permissionNotification])
  })

  test("suppresses requests resolved automatically before the checkpoint", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", created: 0, type: "permission.v2.asked", data: permission("permission-1") })
    harness.emit({
      id: "event-2",
      created: 0,
      type: "permission.v2.replied",
      data: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    await harness.flush()

    expect(harness.notifications).toEqual([])
  })

  test("alerts the root family after a guardrail request remains pending", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "guardrail.asked",
      data: guardrail("guardrail-1", "subagent", "session"),
    })

    expect(harness.scheduled.map((item) => item.delay)).toEqual([500])
    await harness.flush()

    expect(harness.notifications).toEqual([guardrailNotification])
  })

  test("suppresses a guardrail reply received before the checkpoint", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", created: 0, type: "guardrail.asked", data: guardrail("guardrail-1") })
    harness.emit({
      id: "event-2",
      created: 0,
      type: "guardrail.replied",
      data: { rootSessionID: "session", sessionID: "session", requestID: "guardrail-1", reply: "once" },
    })
    await harness.flush()

    expect(harness.notifications).toEqual([])
  })

  test("notifies once only after the top-level session reaches stable idle", async () => {
    const harness = await setup()
    const idle = Promise.withResolvers<void>()
    harness.waits.set("session", idle)

    harness.emit(executionStarted("event-1"))
    harness.emit(executionSucceeded("event-2"))

    expect(harness.notifications).toEqual([])

    idle.resolve()
    await idle.promise
    for (const _ of Array.from({ length: 8 })) await Promise.resolve()

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("uses sound-only attention when a child session reaches stable idle", async () => {
    const harness = await setup()
    const idle = Promise.withResolvers<void>()
    harness.waits.set("subagent", idle)

    harness.emit(executionStarted("event-1", "subagent"))
    harness.emit(executionSucceeded("event-2", "subagent"))
    harness.emit(executionSucceeded("event-3", "subagent"))
    await settle()

    expect(harness.notifications).toEqual([])

    idle.resolve()
    await idle.promise
    await settle()

    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])
  })

  test("notifies once when a goal completes after successor executions", async () => {
    const harness = await setup()
    const idle = Promise.withResolvers<void>()
    harness.waits.set("session", idle)
    harness.autonomy.set("session", { mode: "normal", yolo: false, goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 1,
        noProgress: 0,
        maxNoProgress: 2,
      },
    })

    harness.emit(executionStarted("event-1"))
    harness.emit(executionSucceeded("event-2"))
    harness.emit(executionStarted("event-3"))
    harness.emit(executionSucceeded("event-4"))
    expect(harness.notifications).toEqual([])

    harness.autonomy.set("session", { mode: "normal", yolo: false, goal: {
        text: "Finish the migration",
        status: "completed",
        iteration: 2,
        noProgress: 0,
        maxNoProgress: 2,
      },
    })
    idle.resolve()
    await settle()

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("uses an error alert when goal mode exhausts without progress", async () => {
    const harness = await setup()
    const idle = Promise.withResolvers<void>()
    harness.waits.set("session", idle)
    harness.autonomy.set("session", { mode: "normal", yolo: false, goal: {
        text: "Finish the migration",
        status: "active",
        iteration: 1,
        noProgress: 0,
        maxNoProgress: 2,
      },
    })
    harness.emit(executionStarted("event-1"))
    harness.emit(executionSucceeded("event-2"))
    harness.autonomy.set("session", { mode: "normal", yolo: false, goal: {
        text: "Finish the migration",
        status: "exhausted",
        iteration: 2,
        noProgress: 1,
        maxNoProgress: 2,
      },
    })

    idle.resolve()
    await settle()

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Goal exhausted",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("distinguishes silent and attention-requiring interruptions", async () => {
    const harness = await setup()

    harness.emit(executionStarted("event-1"))
    harness.emit(executionInterrupted("event-2", "user"))
    harness.emit(executionSucceeded("event-3"))
    harness.emit(executionStarted("event-4", "timeout"))
    harness.emit(executionInterrupted("event-5", "shutdown", "timeout"))
    await settle()

    expect(harness.notifications).toEqual([
      {
        title: "Timeout session",
        message: "Session interrupted",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("cancels pending attention work and listeners on cleanup", async () => {
    const harness = await setup()
    harness.emit({ id: "event-1", created: 0, type: "permission.v2.asked", data: permission("permission-1") })

    expect(harness.listenerCount()).toBeGreaterThan(0)
    await harness.cleanup()

    expect(harness.listenerCount()).toBe(0)
    expect(harness.scheduled[0]?.cancelled).toBe(true)
    await harness.flush()
    expect(harness.notifications).toEqual([])
  })

  test("contains notification failures and continues handling later attention", async () => {
    const harness = await setup({ rejectFirstNotification: true })

    harness.emit({ id: "event-1", created: 0, type: "permission.v2.asked", data: permission("permission-1") })
    await harness.flush()
    harness.emit({
      id: "event-2",
      created: 0,
      type: "permission.v2.replied",
      data: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-3", created: 0, type: "permission.v2.asked", data: permission("permission-2") })
    await harness.flush()

    expect(harness.notifications).toEqual([permissionNotification, permissionNotification])
  })

  test("notifies for form, question, and permission requests with blurred notifications and always-on sounds", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1"), title: "Confirm deployment" } },
    })
    harness.emit({ id: "event-2", created: 0, type: "question.v2.asked", data: question("question-1") })
    harness.emit({ id: "event-3", created: 0, type: "permission.v2.asked", data: permission("permission-1") })
    await harness.flush()

    expect(harness.notifications).toEqual([titledFormNotification, questionNotification, permissionNotification])
  })

  test("notifies for global forms once the TUI can render them", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      location: { directory: "/workspace" },
      data: { form: { ...form("form-1", "global"), title: "demo-mcp is requesting input" } },
    })
    await harness.flush()

    expect(harness.notifications).toEqual([globalFormNotification])
  })

  test("dedupes pending forms, questions, and permissions until they are resolved", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", created: 0, type: "form.created", data: { form: form("form-1") } })
    harness.emit({ id: "event-2", created: 0, type: "form.created", data: { form: form("form-1") } })
    harness.emit({
      id: "event-3",
      created: 0,
      type: "form.cancelled",
      data: { sessionID: "session", id: "form-1" },
    })
    harness.emit({ id: "event-4", created: 0, type: "form.created", data: { form: form("form-1") } })

    harness.emit({ id: "event-5", created: 0, type: "question.v2.asked", data: question("question-1") })
    harness.emit({ id: "event-6", created: 0, type: "question.v2.asked", data: question("question-1") })
    harness.emit({
      id: "event-7",
      created: 0,
      type: "question.v2.replied",
      data: { sessionID: "session", requestID: "question-1", answers: [] },
    })
    harness.emit({ id: "event-8", created: 0, type: "question.v2.asked", data: question("question-1") })

    harness.emit({ id: "event-9", created: 0, type: "permission.v2.asked", data: permission("permission-1") })
    harness.emit({ id: "event-10", created: 0, type: "permission.v2.asked", data: permission("permission-1") })
    harness.emit({
      id: "event-11",
      created: 0,
      type: "permission.v2.replied",
      data: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-12", created: 0, type: "permission.v2.asked", data: permission("permission-1") })
    await harness.flush()

    expect(harness.notifications).toEqual([formNotification, questionNotification, permissionNotification])
  })

  test("coalesces successor executions into one terminal notification", async () => {
    const harness = await setup()

    harness.emit(executionSucceeded("event-1"))
    harness.emit(executionStarted("event-2"))
    harness.emit(executionSucceeded("event-3"))
    for (const _ of Array.from({ length: 12 })) await Promise.resolve()

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("uses sound-only attention for actionable child requests", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1", "subagent"), title: "Questions" } },
    })
    harness.emit(executionStarted("event-2", "subagent"))
    harness.emit(executionSucceeded("event-3", "subagent"))
    await harness.flush()

    expect(harness.notifications).toEqual([
      {
        title: "Questions",
        message: "Input needs response",
        notification: false,
        sound: { name: "question", when: "always" },
      },
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])
  })

  test("notifies execution failures once and suppresses following done events", async () => {
    const harness = await setup()

    harness.emit(executionStarted("event-1"))
    harness.emit(executionFailed("event-2"))
    harness.emit(executionSucceeded("event-3"))
    for (const _ of Array.from({ length: 6 })) await Promise.resolve()

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "boom",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("dedupes repeated terminal failures", async () => {
    const harness = await setup()

    harness.emit(executionStarted("event-1"))
    harness.emit(executionFailed("event-2"))
    harness.emit(executionFailed("event-3"))
    harness.emit(executionSucceeded("event-4"))
    await settle()

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "boom",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })
})
