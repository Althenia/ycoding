export * as BrowserTool from "./browser"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Browser } from "../browser"
import { IsolatedBrowser } from "../isolated-browser"
import { PermissionV2 } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"

export const name = "browser"

const Mode = Schema.Literals(["selected", "isolated"]).pipe(Schema.optional)
const StatusOperation = Schema.Struct({ operation: Schema.Literal("status"), mode: Mode })
const TabsOperation = Schema.Struct({ operation: Schema.Literal("tabs"), mode: Mode })
const { sessionID: _observeSessionID, callID: _observeCallID, ...ObserveFields } = Browser.Schema.ObserveInput.fields
const { sessionID: _actionSessionID, callID: _actionCallID, ...ActionFields } = Browser.Schema.ActionInput.fields
const ObserveOperation = Schema.Struct({
  operation: Schema.Literal("observe"),
  mode: Schema.Literal("selected").pipe(Schema.optional),
  ...ObserveFields,
})
const {
  sessionID: _isolatedObserveSessionID,
  callID: _isolatedObserveCallID,
  ...IsolatedObserveFields
} = IsolatedBrowser.Schema.ObserveInput.fields
const IsolatedObserveOperation = Schema.Struct({
  operation: Schema.Literal("observe"),
  mode: Schema.Literal("isolated"),
  ...IsolatedObserveFields,
})
const ActionOperation = Schema.Struct({
  operation: Schema.Literal("action"),
  mode: Schema.Literal("selected").pipe(Schema.optional),
  ...ActionFields,
})
const {
  sessionID: _isolatedActionSessionID,
  callID: _isolatedActionCallID,
  ...IsolatedActionFields
} = IsolatedBrowser.Schema.ActionInput.fields
const IsolatedActionOperation = Schema.Struct({
  operation: Schema.Literal("action"),
  mode: Schema.Literal("isolated"),
  ...IsolatedActionFields,
})
const ControlOperation = Schema.Struct({
  operation: Schema.Literal("control"),
  mode: Mode,
  ...Browser.Schema.ControlInput.fields,
})
const StopOperation = Schema.Struct({ operation: Schema.Literal("stop"), mode: Mode })

export const Input = Schema.Union([
  StatusOperation,
  TabsOperation,
  ObserveOperation,
  IsolatedObserveOperation,
  ActionOperation,
  IsolatedActionOperation,
  ControlOperation,
  StopOperation,
])

const Output = Schema.Union([
  Schema.Struct({ type: Schema.Literal("status"), status: IsolatedBrowser.Schema.Status }),
  Schema.Struct({ type: Schema.Literal("status"), status: Browser.Schema.Status }),
  Schema.Struct({
    type: Schema.Literal("tabs"),
    mode: Schema.Literal("isolated"),
    tabs: Schema.Array(Browser.Schema.Tab),
  }),
  Schema.Struct({ type: Schema.Literal("tabs"), tabs: Schema.Array(Browser.Schema.Tab) }),
  Schema.Struct({ type: Schema.Literal("observation"), observation: IsolatedBrowser.Schema.Observation }),
  Schema.Struct({ type: Schema.Literal("observation"), observation: Browser.Schema.Observation }),
  Schema.Struct({ type: Schema.Literal("action"), result: IsolatedBrowser.Schema.ActionResult }),
  Schema.Struct({ type: Schema.Literal("action"), result: Browser.Schema.ActionResult }),
  Schema.Struct({ type: Schema.Literal("stopped"), mode: Schema.Literal("isolated") }),
  Schema.Struct({ type: Schema.Literal("stopped") }),
])

export const Plugin = {
  id: "ycoding.tool.browser",
  effect: Effect.fn("BrowserTool.Plugin")(function* (ctx: PluginContext) {
    const browser = yield* Browser.Service
    const isolated = yield* IsolatedBrowser.Service
    const permission = yield* PermissionV2.Service
    const guardrail = yield* SessionGuardrail.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "Operate either selected Chrome tabs explicitly shared through the YCoding extension (the default) or an explicit mode:'isolated' temporary headless browser already started by the user. The tool never starts or switches browser modes. Use status/tabs first, observe before semantic actions, and preserve every returned instance and generation fence. Mutating actions are never automatically replayed after an uncertain result.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => {
              if (output.type !== "action" || !output.result.capture)
                return [{ type: "text", text: JSON.stringify(output) }]
              const capture = output.result.capture
              return [
                {
                  type: "text",
                  text: JSON.stringify({
                    ...output,
                    result: {
                      ...output.result,
                      capture: { mediaType: capture.mediaType, bytes: capture.bytes },
                    },
                  }),
                },
                {
                  type: "file",
                  data: capture.data,
                  mime: capture.mediaType,
                  name:
                    "mode" in output.result && output.result.mode === "isolated"
                      ? "isolated-browser.png"
                      : "shared-tab.png",
                },
              ]
            },
            execute: (input, context) =>
              Effect.gen(function* () {
                const isolatedMode = input.mode === "isolated"
                const source = { type: "tool" as const, messageID: context.messageID, callID: context.callID }
                if (input.operation === "status") {
                  const status = yield* isolatedMode
                    ? isolated.status(context.sessionID)
                    : browser.status(context.sessionID)
                  return { type: "status" as const, status }
                }
                if (input.operation === "tabs") {
                  const tabs = yield* isolatedMode ? isolated.list(context.sessionID) : browser.list(context.sessionID)
                  if (tabs.length > 0)
                    yield* permission.assert({
                      action: "browser_read",
                      resources: tabs.map((tab) => `${tab.page.origin}${tab.page.path}`),
                      save: tabs.map((tab) => tab.page.origin),
                      metadata: { operation: "tabs" },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                  return isolatedMode
                    ? { type: "tabs" as const, mode: "isolated" as const, tabs }
                    : { type: "tabs" as const, tabs }
                }
                if (input.operation === "control") {
                  yield* permission.assert({
                    action: "browser_control",
                    resources: [input.action],
                    save: ["*"],
                    metadata: { action: input.action },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  return {
                    type: "status" as const,
                    status: yield* isolatedMode
                      ? isolated.control(context.sessionID, { action: input.action })
                      : browser.control(context.sessionID, { action: input.action }),
                  }
                }
                if (input.operation === "stop") {
                  yield* permission.assert({
                    action: "browser_control",
                    resources: ["stop"],
                    save: ["*"],
                    metadata: { action: "stop" },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  yield* isolatedMode ? isolated.stop(context.sessionID) : browser.stop(context.sessionID)
                  return isolatedMode
                    ? { type: "stopped" as const, mode: "isolated" as const }
                    : { type: "stopped" as const }
                }
                const tab = (yield* isolatedMode
                  ? isolated.list(context.sessionID)
                  : browser.list(context.sessionID)).find((item) => item.id === input.tabID)
                if (!tab) return yield* new ToolFailure({ message: "Chrome tab is not shared with this Session" })
                const page = `${tab.page.origin}${tab.page.path}`
                if (input.operation === "observe") {
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [page],
                    save: [tab.page.origin],
                    metadata: { operation: "observe" },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  return {
                    type: "observation" as const,
                    observation: yield* isolatedMode
                      ? isolated.observe({
                          sessionID: context.sessionID,
                          instanceID: input.instanceID,
                          tabID: input.tabID,
                          generation: input.generation,
                          callID: context.callID,
                        })
                      : browser.observe({
                          sessionID: context.sessionID,
                          tabID: input.tabID,
                          generation: input.generation,
                          callID: context.callID,
                        }),
                  }
                }
                const navigationURL = input.action.type === "navigate" ? input.action.url : undefined
                const resource =
                  navigationURL !== undefined
                    ? yield* Effect.try({
                        try: () => safeResource(navigationURL),
                        catch: (error) => new ToolFailure({ message: "Unsupported browser navigation target", error }),
                      })
                    : page
                const permissionAction =
                  input.action.type === "capture" || input.action.type === "scroll"
                    ? "browser_read"
                    : input.action.type === "navigate"
                      ? "browser_navigate"
                      : "browser_interact"
                yield* permission.assert({
                  action: permissionAction,
                  resources: [resource],
                  save: [new URL(resource).origin],
                  metadata: {
                    operation: input.action.type,
                    ...(input.action.type === "click" || input.action.type === "type" ? { ref: input.action.ref } : {}),
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const mutating = ["navigate", "click", "type"].includes(input.action.type)
                const reservation = mutating
                  ? yield* guardrail.assert({
                      sessionID: context.sessionID,
                      action: "browser_mutation",
                      resources: [resource],
                      metadata: { operation: input.action.type },
                    })
                  : { release: Effect.void }
                const result = isolatedMode
                  ? yield* isolated
                      .action({
                        sessionID: context.sessionID,
                        instanceID: input.instanceID,
                        tabID: input.tabID,
                        generation: input.generation,
                        documentGeneration: input.documentGeneration,
                        observationRevision: input.observationRevision,
                        callID: context.callID,
                        action: input.action,
                      })
                      .pipe(Effect.ensuring(reservation.release))
                  : yield* browser
                      .action({
                        sessionID: context.sessionID,
                        tabID: input.tabID,
                        generation: input.generation,
                        documentGeneration: input.documentGeneration,
                        observationRevision: input.observationRevision,
                        callID: context.callID,
                        action: input.action,
                      })
                      .pipe(Effect.ensuring(reservation.release))
                return { type: "action" as const, result }
              }).pipe(
                Effect.tap((output) => {
                  if (output.type !== "status" || !("tab" in output.status) || !output.status.tab) return Effect.void
                  return permission.assert({
                    action: "browser_read",
                    resources: [`${output.status.tab.page.origin}${output.status.tab.page.path}`],
                    save: [output.status.tab.page.origin],
                    metadata: { operation: input.operation },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, callID: context.callID },
                  })
                }),
                Effect.mapError((error) =>
                  error instanceof ToolFailure
                    ? error
                    : new ToolFailure({
                        message: error instanceof Error ? error.message : "Browser operation failed",
                        error,
                      }),
                ),
              ),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}

function safeResource(input: string) {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only credential-free HTTP and HTTPS navigation is supported")
  return `${url.origin}${url.pathname || "/"}`
}
