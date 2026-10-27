import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { Dots } from "@ycoding-ai/schema/dots"
import { Schema } from "effect"
import type { useData } from "../../src/context/data"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { assertTestPaths } from "../preload"

const sessionID = "ses_dots_notice_display"
const directory = "/tmp/ycoding/dots-notice-display"
const location = { directory, project: { id: "proj_dots_notice_display", directory } }
const session = {
  id: sessionID,
  title: "Display regression",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

const readableFrame = (frame: string) => frame.replace(/[│╭╮╯╰]/g, " ").replace(/\s+/g, " ")
const wireContext = (context: Dots.CoordinationContext) =>
  JSON.parse(JSON.stringify(Schema.encodeUnknownSync(Dots.CoordinationContext)(context)))

async function withMessages(messages: SessionMessageInfo[], width: number, run: (frame: string) => void) {
  const { renderScreen } = await import("./harness")
  const { Global } = await import("@ycoding-ai/core/global")
  assertTestPaths(Global.Path)
  const state: { data?: ReturnType<typeof useData> } = {}
  const screen = await renderScreen({
    width,
    height: 60,
    args: { sessionID },
    sessionReady: true,
    settle: (screen) => {
      const frame = readableFrame(screen.captureCharFrame())
      return (
        frame.includes("Boundary marker") &&
        messages.every((message) =>
          message.type === "system" && message.metadata?.contextSource === "dots"
            ? frame.includes("Dots coordination")
            : frame.includes(
                message.type === "synthetic"
                  ? (message.description ?? message.text)
                  : message.type === "user" || message.type === "system"
                    ? message.text
                    : "",
              ),
        )
      )
    },
    config: { animations: false, session: { sidebar: "hide" } },
    data: (data) => {
      state.data = data
    },
    route: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname.endsWith("/snapshot"))
        return sessionSnapshot(
          sessionID,
          [...messages, { id: "msg_boundary", type: "user", text: "Boundary marker", time: { created: 100 } }],
          { session },
        )
      if (url.pathname.endsWith("/subagent"))
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (url.pathname.endsWith("/guardrail"))
        return json({
          data: {
            rootSessionID: sessionID,
            profile: "standard",
            customRules: 0,
            approvals: 0,
            blocked: 0,
            counters: [],
            invalidFiles: [],
          },
        })
      if (["pending", "permission", "todo", "skills"].some((part) => url.pathname.endsWith(`/${part}`)))
        return json({ data: [] })
      return undefined
    },
  })
  try {
    run(readableFrame(screen.frame()))
    for (const message of messages)
      expect(state.data?.session.message.get(sessionID, message.id)).toMatchObject(message)
  } finally {
    await screen.dispose()
  }
}

const remoteMcp = {
  requestID: "request_fixture",
  epoch: "epoch_fixture",
  principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" },
}
const native = {
  origin: "dots-peer",
  profile: "fixture",
  dotID: "dot_native",
  threadID: "thread_native",
  itemID: "room_message",
}

for (const type of ["user", "synthetic"] as const) {
  test(`${type} hides only unnamed Remote MCP attribution while preserving bodies and native Dots attribution`, async () => {
    await withMessages(
      [
        {
          id: "msg_remote",
          type,
          text: "Remote body remains visible",
          ...(type === "synthetic" ? { description: "Remote body remains visible" } : {}),
          metadata: { inputOrigin: "plugin", remoteMcp },
          time: { created: 1 },
        },
        {
          id: "msg_unnamed",
          type,
          text: "Unnamed exchange body remains visible",
          ...(type === "synthetic" ? { description: "Unnamed exchange body remains visible" } : {}),
          metadata: { inputOrigin: "plugin", remoteMcp, dotsExchange: { sessionID, exchangeID: "exchange_unnamed" } },
          time: { created: 1 },
        },
        {
          id: "msg_native",
          type,
          text: "Native body remains visible",
          ...(type === "synthetic" ? { description: "Native body remains visible" } : {}),
          metadata: { dots: native },
          time: { created: 2 },
        },
        {
          id: "msg_named",
          type,
          text: "Named body remains visible",
          ...(type === "synthetic" ? { description: "Named body remains visible" } : {}),
          metadata: {
            inputOrigin: "plugin",
            remoteMcp,
            dotsExchange: {
              sessionID,
              targetSessionID: sessionID,
              exchangeID: "exchange_named",
              attachment: {
                profile: "fixture",
                dotID: "dot_named",
                threadID: "thread_named",
                generation: "generation_named",
                label: "Named Dot",
              },
            },
          },
          time: { created: 3 },
        },
      ],
      120,
      (frame) => {
        expect(frame).not.toContain("Remote MCP · external peer · client_fixture")
        for (const text of [
          "Remote body remains visible",
          "Unnamed exchange body remains visible",
          "Native body remains visible",
          "Named body remains visible",
          "Dot dot_native · external peer · thread_native",
          "Named Dot · external peer · Remote MCP · user-chosen name",
        ])
          expect(frame).toContain(text)
      },
    )
  }, 30_000)
}

const enabled = Schema.decodeUnknownSync(Dots.CoordinationContext)({
  state: "enabled",
  generation: 1,
  tool: "dots_report",
  envelope: {
    coordinator: remoteMcp.principal,
    scope: { epoch: remoteMcp.epoch, grantID: "grant_fixture" },
    exchangeID: "exchange_fixture",
    messageID: "msg_task_fixture",
    targetSessionID: sessionID,
    kind: "task",
    origin: "plugin",
  },
})
const states: { context: Dots.CoordinationContext; summary: string }[] = [
  { context: enabled, summary: "Dots coordination · enabled" },
  {
    context: { state: "disabled", generation: 2, reason: "no_task" },
    summary: "Dots coordination · disabled · no active Dots task",
  },
  {
    context: { state: "disabled", generation: 3, reason: "capability_disabled" },
    summary: "Dots coordination · disabled · Dots capability disabled",
  },
  {
    context: { state: "disabled", generation: 4, reason: "task_settled" },
    summary: "Dots coordination · disabled · Dots task settled",
  },
  {
    context: { state: "disabled", generation: 5, reason: "unavailable" },
    summary: "Dots coordination · disabled · coordination unavailable",
  },
  {
    context: { state: "disabled", generation: 6, reason: "tool_unavailable" },
    summary: "Dots coordination · disabled · dots_report unavailable",
  },
]

for (const width of [60, 120]) {
  for (const { context, summary } of states) {
    test(`structured ${context.state === "enabled" ? "enabled" : context.reason} notice is readable at ${width} columns`, async () => {
      const { DotsContext } = await import("@ycoding-ai/core/dots/context")
      await withMessages(
        [
          {
            id: "msg_state",
            type: "system",
            text: context.state === "disabled" ? DotsContext.render(context) : "Dots coordination enabled.",
            metadata: { contextSource: "dots", dotsCoordination: wireContext(context) },
            time: { created: 1 },
          },
        ],
        width,
        (frame) => {
          expect(frame).toContain(summary)
          for (const absent of [
            "generation",
            "{",
            "}",
            "Earlier enabled",
            "Use dots_report",
            "unbound",
            "disconnected",
            "no_task",
          ])
            expect(frame).not.toContain(absent)
        },
      )
    }, 30_000)
  }
}

test("prose and plugin metadata cannot impersonate a trusted Dots state notice; unrelated notices retain their text", async () => {
  const prose = "Dots coordination disabled. Ordinary diagnostic remains visible."
  const plugin = "Plugin diagnostic remains visible."
  await withMessages(
    [
      { id: "msg_prose", type: "system", text: prose, time: { created: 1 } },
      {
        id: "msg_plugin",
        type: "synthetic",
        text: "Plugin body",
        description: plugin,
        metadata: { contextSource: "dots", dotsCoordination: wireContext(states[1].context) },
        time: { created: 2 },
      },
      {
        id: "msg_unrelated",
        type: "system",
        text: "Unrelated service notice remains visible.",
        metadata: { contextSource: "service", dotsCoordination: wireContext(states[1].context) },
        time: { created: 3 },
      },
    ],
    120,
    (frame) => {
      for (const text of [prose, plugin, "Unrelated service notice remains visible."]) expect(frame).toContain(text)
      expect(frame).not.toContain("no active Dots task")
    },
  )
}, 30_000)

test("malformed trusted Dots state reports unavailable without inferring state from prose", async () => {
  await withMessages(
    [
      {
        id: "msg_invalid",
        type: "system",
        text: 'Dots coordination enabled.\n{"state":"enabled","generation":2}',
        metadata: { contextSource: "dots", dotsCoordination: { state: "enabled", generation: 2 } },
        time: { created: 1 },
      },
    ],
    120,
    (frame) => {
      expect(frame).toContain("Dots coordination · state unavailable")
      expect(frame).not.toContain("generation")
      expect(frame).not.toContain("Dots coordination · enabled")
    },
  )
}, 30_000)
