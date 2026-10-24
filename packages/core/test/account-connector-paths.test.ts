import { describe, expect } from "bun:test"
import { Agent } from "@ycoding-ai/core/agent"
import { AccountConnectorTools } from "@ycoding-ai/core/account-connectors/tools"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Image } from "@ycoding-ai/core/image"
import { Permission } from "@ycoding-ai/core/permission"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { Hash } from "@ycoding-ai/core/util/hash"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(ToolRegistry.node, [
    [
      ToolOutputStore.node,
      Layer.mock(ToolOutputStore.Service, {
        bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
      }),
    ],
    [Image.node, Layer.mock(Image.Service, { normalize: (_, content) => Effect.succeed(content) })],
  ]),
)

const sessionID = Session.ID.make("ses_connector_paths")
const messageID = SessionMessage.ID.make("msg_connector_paths")
const agent = Agent.ID.make("build")
const object = { type: "object" as const }
const sorted = (values: ReadonlyArray<string | undefined>) =>
  values.toSorted((left, right) => (String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0))
const suffix = (value: string) => Hash.sha256(value).slice(0, 6)
const securityName = (provider: string, id: string, tool: string) =>
  `${provider}_${id.replace(/[^A-Za-z0-9_]/g, "_")}_${tool.replace(/[^A-Za-z0-9_]/g, "_")}_${Hash.sha256(`${id}\0${tool}`).slice(0, 12)}`

type Entry = { readonly id: string; readonly label: string; readonly tool: string }

const connectors = (provider: "chatgpt" | "claude", entries: ReadonlyArray<Entry>) => {
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  const permissions: Permission.AssertInput[] = []
  const guardrails: Array<{ action: string; resources: readonly string[]; metadata?: unknown }> = []
  const make = AccountConnectorTools.make({
    provider,
    catalog: entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      tool: { name: entry.tool, description: `${entry.tool} operation`, inputSchema: object, outputSchema: undefined },
    })),
    permission: { assert: (input) => Effect.sync(() => void permissions.push(input)) },
    guardrail: {
      assert: (input) =>
        Effect.sync(() => {
          guardrails.push(input)
          return { release: Effect.void }
        }),
    },
    current: () => Effect.void,
    call: (id, name, args) =>
      Effect.sync(() => {
        calls.push({ id, name, args })
        return { isError: false, content: [{ type: "text" as const, text: `${id}/${name}` }], structured: { id, name } }
      }),
  })
  return { make, calls, permissions, guardrails }
}

const paths = (
  registrations: ReadonlyArray<{ tools: Readonly<Record<string, Tool.AnyTool>>; options?: Tool.RegisterOptions }>,
) =>
  Object.fromEntries(
    registrations.flatMap((registration) =>
      Object.keys(registration.tools).map((name) => [name, registration.options?.paths?.[name]] as const),
    ),
  )

const run = (settle: ToolRegistry.Materialization["settle"], code: string) =>
  settle({
    sessionID,
    agent,
    messageID,
    call: { type: "tool-call", id: "call_execute", name: "execute", input: { code } },
  }).pipe(Effect.map((settlement) => settlement.result))

const personalWork: ReadonlyArray<Entry> = [
  { id: "asdk_app_personal", label: "YCoding", tool: "ycoding_session_catalog" },
  { id: "asdk_app_work", label: "YCoding Work", tool: "ycoding_work_session_catalog" },
]

describe("account connector Code Mode paths", () => {
  it.effect("Personal and Work connectors route through readable nested paths to their own connector", () =>
    Effect.gen(function* () {
      const remote = connectors("chatgpt", personalWork)
      const registrations = yield* remote.make
      expect(sorted(Object.values(paths(registrations)))).toEqual([
        "chatgpt.ycoding.session_catalog",
        "chatgpt.ycoding_work.session_catalog",
      ])
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize([], {}, registrations)
      const searched = yield* run(materialized.settle, `return search({ query: "session catalog" })`)
      expect(JSON.stringify(searched)).toContain("tools.chatgpt.ycoding.session_catalog(input:")
      expect(JSON.stringify(searched)).toContain("tools.chatgpt.ycoding_work.session_catalog(input:")
      yield* run(
        materialized.settle,
        `return [await tools.chatgpt.ycoding_work.session_catalog({}), await tools.chatgpt.ycoding.session_catalog({})]`,
      )
      expect(remote.calls.map((call) => [call.id, call.name])).toEqual([
        ["asdk_app_work", "ycoding_work_session_catalog"],
        ["asdk_app_personal", "ycoding_session_catalog"],
      ])
    }),
  )

  it.effect("Claude connectors use the same nested search, signature and invocation shape", () =>
    Effect.gen(function* () {
      const remote = connectors("claude", [{ id: "srv_drive_install", label: "Google Drive", tool: "search" }])
      const registrations = yield* remote.make
      expect(Object.values(paths(registrations))).toEqual(["claude.google_drive.search"])
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize([], {}, registrations)
      expect(JSON.stringify(yield* run(materialized.settle, `return search({ query: "search" })`))).toContain(
        "tools.claude.google_drive.search(input:",
      )
      yield* run(materialized.settle, `return await tools.claude.google_drive.search({ q: "x" })`)
      expect(remote.calls).toEqual([{ id: "srv_drive_install", name: "search", args: { q: "x" } }])
    }),
  )

  it.effect("the old identity-and-hash callable paths are absent from Code Mode", () =>
    Effect.gen(function* () {
      const remote = connectors("chatgpt", personalWork)
      const registrations = yield* remote.make
      const old = securityName("chatgpt", "asdk_app_personal", "ycoding_session_catalog")
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize([], {}, registrations)
      expect(JSON.stringify(yield* run(materialized.settle, `return search({ query: "${old}" })`))).not.toContain(
        `tools.${old}`,
      )
      yield* run(materialized.settle, `return await tools.${old}({})`)
      expect(remote.calls).toEqual([])
    }),
  )

  it.effect("identical labels get identity suffixes that do not depend on catalog order", () =>
    Effect.gen(function* () {
      const entries = [
        { id: "conn_alpha", label: "Drive", tool: "search" },
        { id: "conn_beta", label: "Drive", tool: "search" },
      ]
      const forward = paths(yield* connectors("chatgpt", entries).make)
      const reverse = paths(yield* connectors("chatgpt", entries.toReversed()).make)
      expect(forward).toEqual(reverse)
      expect(sorted(Object.values(forward))).toEqual(
        sorted([`chatgpt.drive_${suffix("conn_alpha")}.search`, `chatgpt.drive_${suffix("conn_beta")}.search`]),
      )
    }),
  )

  it.effect("empty, digit-leading, reserved and non-Latin labels fall back to a letter-leading connector segment", () =>
    Effect.gen(function* () {
      const entries = ["", "123 Files", "Constructor", "prototype", "__proto__", "日本語"].map((label, index) => ({
        id: `conn_${index}`,
        label,
        tool: "search",
      }))
      const result = paths(yield* connectors("chatgpt", entries).make)
      expect(sorted(Object.values(result))).toEqual(
        entries
          .map((entry) => `chatgpt.connector_${suffix(entry.id)}.search`)
          .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      )
    }),
  )

  it.effect("operation names that collide after normalization or are invalid get distinct valid segments", () =>
    Effect.gen(function* () {
      const entries = ["send-mail", "send_mail", "123", "constructor"].map((tool) => ({
        id: "conn_mail",
        label: "Mail",
        tool,
      }))
      const forward = paths(yield* connectors("chatgpt", entries).make)
      expect(forward).toEqual(paths(yield* connectors("chatgpt", entries.toReversed()).make))
      expect(sorted(Object.values(forward))).toEqual(
        [
          `chatgpt.mail.send_mail_${suffix("conn_mail\u0000send-mail")}`,
          `chatgpt.mail.send_mail_${suffix("conn_mail\u0000send_mail")}`,
          `chatgpt.mail.operation_${suffix("conn_mail\u0000123")}`,
          `chatgpt.mail.operation_${suffix("conn_mail\u0000constructor")}`,
        ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      )
    }),
  )

  it.effect("a suffix that collides with another connector's segment is rejected explicitly", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        connectors("chatgpt", [
          { id: "conn_alpha", label: "Drive", tool: "search" },
          { id: "conn_beta", label: "Drive", tool: "search" },
          { id: "conn_gamma", label: `Drive ${suffix("conn_alpha")}`, tool: "search" },
        ]).make,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toMatchObject({ message: expect.stringContaining("collid") })
    }),
  )

  it.effect("permission, saved approval, deny, capability and guardrail identities are unchanged", () =>
    Effect.gen(function* () {
      const remote = connectors("chatgpt", personalWork)
      const registrations = yield* remote.make
      const key = securityName("chatgpt", "asdk_app_personal", "ycoding_session_catalog")
      expect(Object.keys(paths(registrations))).toContain(key)
      expect(Permission.evaluate(key, "asdk_app_personal", Agent.Info.empty(agent).permissions).effect).toBe("ask")
      expect(
        Permission.evaluate(key, "asdk_app_personal", Agent.Info.empty(agent).permissions, [
          { action: key, resource: "asdk_app_personal", effect: "allow" },
        ]).effect,
      ).toBe("allow")
      const registry = yield* ToolRegistry.Service
      expect(
        yield* registry.available([{ action: key, resource: "*", effect: "deny" }], {}, registrations),
      ).not.toContain(key)
      expect(yield* registry.available([], { tools: { deny: [key] } }, registrations)).not.toContain(key)
      expect(yield* registry.available([], {}, registrations)).toContain(key)
      const materialized = yield* registry.materialize([], {}, registrations)
      yield* run(materialized.settle, `return await tools.chatgpt.ycoding.session_catalog({ query: "q" })`)
      expect(remote.permissions).toMatchObject([
        {
          action: key,
          resources: ["asdk_app_personal"],
          metadata: {
            connector: "asdk_app_personal",
            tool: "ycoding_session_catalog",
            operationDigest: Hash.json({
              connectorID: "asdk_app_personal",
              name: "ycoding_session_catalog",
              arguments: { query: "q" },
            }),
          },
        },
      ])
      expect(remote.guardrails).toMatchObject([
        { action: "mcp_execute", resources: ["chatgpt/asdk_app_personal/ycoding_session_catalog"] },
      ])
    }),
  )

  it.effect("duplicate callable paths are rejected regardless of registration order or source", () =>
    Effect.gen(function* () {
      const echo = Tool.make({
        description: "Echo",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("echo"),
      })
      const registry = yield* ToolRegistry.Service
      const connector = {
        tools: { connector_search: echo },
        options: { paths: { connector_search: "chatgpt.drive.search" } },
      }
      const plugin = { tools: { search: echo }, options: { namespace: "chatgpt.drive" } }
      for (const registrations of [
        [connector, plugin],
        [plugin, connector],
      ]) {
        const exit = yield* Effect.exit(registry.materialize([], {}, registrations))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("chatgpt.drive.search")
      }
    }),
  )
})
