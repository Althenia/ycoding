import { expect, test } from "bun:test"
import { ExecuteTool } from "@ycoding-ai/core/tool/execute"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { Agent } from "@ycoding-ai/schema/agent"
import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Effect, Schema } from "effect"

test("execute preserves successful results with visible unhandled rejections", async () => {
  const child = Tool.make({
    description: "Always fail",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.fail(new Tool.Failure({ message: "Lookup refused" })),
  })
  const execute = ExecuteTool.create(new Map([["fail", { tool: child, name: "fail" }]]))
  const result = await Effect.runPromise(
    Tool.settle(
      execute,
      {
        type: "tool-call",
        id: "call_execute",
        name: "execute",
        input: { code: `tools.fail({}); return "done"` },
      },
      {
        sessionID: Session.ID.make("ses_execute"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_execute"),
        callID: "call_execute",
        progress: () => Effect.void,
      },
    ),
  )

  expect(result.structured).toEqual({ toolCalls: [{ tool: "fail", status: "error" }] })
  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "done",
        "",
        "Warnings:",
        "- [ToolFailure] Unhandled rejection from an un-awaited promise: Lookup refused",
      ].join("\n"),
    },
  ])
})

test("execute provider definition stays stable while runtime search follows the current catalog", async () => {
  const github = Tool.make({
    description: "Find a GitHub issue",
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.String,
    execute: ({ query }) => Effect.succeed(query),
  })
  const slack = Tool.make({
    description: "Find a Slack channel",
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.String,
    execute: ({ query }) => Effect.succeed(query),
  })
  const githubExecute = ExecuteTool.create(
    new Map([["github_issue", { tool: github, name: "issue", namespace: "github" }]]),
  )
  const slackExecute = ExecuteTool.create(
    new Map([["slack_channel", { tool: slack, name: "channel", namespace: "slack" }]]),
  )

  expect(Tool.definition("execute", githubExecute)).toEqual(Tool.definition("execute", slackExecute))

  const context = {
    sessionID: Session.ID.make("ses_execute_catalog"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_execute_catalog"),
    callID: "call_execute_catalog",
    progress: () => Effect.void,
  }
  const search = async (tool: Tool.AnyTool) => {
    const settled = await Effect.runPromise(
      Tool.settle(
        tool,
        {
          type: "tool-call",
          id: "call_execute_catalog",
          name: "execute",
          input: { code: 'return search({ query: "" })' },
        },
        context,
      ),
    )
    const text = settled.content.find((part) => part.type === "text")?.text
    return text === undefined ? undefined : JSON.parse(text)
  }

  expect((await search(githubExecute))?.items[0]?.path).toBe("tools.github.issue")
  expect((await search(slackExecute))?.items[0]?.path).toBe("tools.slack.channel")
})

test("execute supports callable namespace tools", async () => {
  const callable = Tool.make({
    description: "Administer Slack",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed("admin"),
  })
  const child = Tool.make({
    description: "Create a Slack resource",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed("created"),
  })
  const execute = ExecuteTool.create(
    new Map([
      ["slack_admin", { tool: callable, name: "admin", namespace: "slack" }],
      ["slack_admin_create", { tool: child, name: "create", namespace: "slack.admin" }],
    ]),
  )
  const result = await Effect.runPromise(
    Tool.settle(
      execute,
      {
        type: "tool-call",
        id: "call_execute",
        name: "execute",
        input: { code: "return [await tools.slack.admin({}), await tools.slack.admin.create({})]" },
      },
      {
        sessionID: Session.ID.make("ses_execute"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_execute"),
        callID: "call_execute",
        progress: () => Effect.void,
      },
    ),
  )

  expect(result.structured).toEqual({
    toolCalls: [
      { tool: "slack.admin", status: "completed" },
      { tool: "slack.admin.create", status: "completed" },
    ],
  })
  expect(result.content).toEqual([{ type: "text", text: '[\n  "admin",\n  "created"\n]' }])
})
