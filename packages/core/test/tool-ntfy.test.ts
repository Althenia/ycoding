import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { Config } from "@ycoding-ai/core/config"
import { ConfigNtfy } from "@ycoding-ai/core/config/ntfy"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionV2 } from "@ycoding-ai/core/session"
import { NtfyTool } from "@ycoding-ai/core/tool/ntfy"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const ntfyToolNode = makeLocationNode({
  name: "test/ntfy-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(NtfyTool.Plugin)),
  deps: [Config.node, ToolRegistry.toolsNode, PermissionV2.node, LayerNodePlatform.httpClient],
})

const sessionID = SessionV2.ID.make("ses_ntfy_test")
const configs: Config.Entry[] = []
const requests: Array<{ readonly url: string; readonly headers: Record<string, string>; readonly body: string }> = []
const assertions: PermissionV2.AssertInput[] = []
let responseStatus = 200

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed(configs),
  }),
)
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const body = yield* Effect.promise(() => web.text())
      requests.push({
        url: request.url,
        headers: request.headers,
        body,
      })
      return HttpClientResponse.fromWeb(request, new Response("server response", { status: responseStatus }))
    }),
  ),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const toolLayer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ntfyToolNode]), [
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [Image.node, imagePassthrough],
  [LayerNodePlatform.httpClient, http],
])
const it = testEffect(toolLayer)

const reset = (ntfy?: { readonly enabled?: boolean; readonly topic?: string }) => {
  configs.splice(
    0,
    configs.length,
    new Config.Document({ type: "document", info: new Config.Info(ntfy ? { ntfy: new ConfigNtfy.Info(ntfy) } : {}) }),
  )
  requests.length = 0
  assertions.length = 0
  responseStatus = 200
}

const call = (message: string, id = "call-ntfy") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "ntfy", input: { message } },
})

describe("NtfyTool", () => {
  it.effect("registers provider-visible attention guidance", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const [definition] = yield* toolDefinitions(registry)

      expect(definition?.name).toBe("ntfy")
      expect(definition?.description).toContain("user attention")
      expect(definition?.description).toContain("question")
      expect(definition?.description).toContain("confirmation/approval")
      expect(definition?.description).toContain("completed task")
      expect(definition?.description).toContain("not for routine progress")
      expect(definition?.description).toContain(
        "During active goal mode, routine autonomous decisions, background progress, retries, and auto-resolvable questions do not warrant notification.",
      )
      expect(definition?.description).toContain(
        "Genuine attention triggers are exhausted goal attempts, a user-owned blocker, confirmation/approval that autonomy cannot resolve, or verified task completion.",
      )
      expect(definition?.description).toContain(
        "Use the existing goal system and tool state visible to the agent; ntfy does not read or duplicate Session autonomy state.",
      )
      expect(Schema.decodeUnknownSync(NtfyTool.Input)({ message: "Need approval" })).toEqual({ message: "Need approval" })
      expect(() => Schema.decodeUnknownSync(NtfyTool.Input)({ message: "" })).toThrow()
    }),
  )

  it.effect("fails without permission or transport when disabled or topic is blank", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      reset()
      expect(yield* executeTool(registry, call("Need approval"))).toEqual({
        type: "error",
        value: "Ntfy notifications are disabled.",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])

      reset({ enabled: true, topic: "  " })
      expect(yield* executeTool(registry, call("Need approval", "call-ntfy-blank"))).toEqual({
        type: "error",
        value: "Ntfy topic is not configured.",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])

      reset({ enabled: true, topic: "attention" })
      expect(yield* executeTool(registry, call("Need approval", "call-ntfy-enabled"))).toEqual({
        type: "text",
        value: "Attention message delivered.",
      })
      expect(assertions).toHaveLength(1)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("permission-checks and posts only configured attention messages", () =>
    Effect.gen(function* () {
      reset({ enabled: true, topic: "project updates/urgent" })
      const registry = yield* ToolRegistry.Service
      const message = "Approval needed for release"

      expect(yield* executeTool(registry, call(message))).toEqual({ type: "text", value: "Attention message delivered." })
      expect(requests).toEqual([
        expect.objectContaining({
          url: "https://ntfy.sh/project%20updates%2Furgent",
          headers: expect.objectContaining({ "content-type": "text/plain" }),
          body: message,
        }),
      ])
      expect(assertions).toMatchObject([{ action: "ntfy", resources: ["https://ntfy.sh/*"], save: ["*"] }])
      expect(JSON.stringify(assertions)).not.toContain(message)
      expect(JSON.stringify(assertions)).not.toContain("project updates/urgent")
    }),
  )

  it.effect("rejects unsuccessful ntfy responses without exposing their body", () =>
    Effect.gen(function* () {
      reset({ enabled: true, topic: "attention" })
      responseStatus = 500
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call("Need approval"))).toEqual({
        type: "error",
        value: "Unable to deliver attention message.",
      })
    }),
  )
})
