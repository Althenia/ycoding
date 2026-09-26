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

const Mode = Schema.Literals(["isolated", "owned", "profile"]).pipe(Schema.optional)
const integer = <S extends Schema.Constraint>(schema: S) =>
  Schema.Union([schema, Schema.NumberFromString.pipe(Schema.decodeTo(schema))])
const StatusOperation = Schema.Struct({ operation: Schema.Literal("status"), mode: Mode })
const TabsOperation = Schema.Struct({ operation: Schema.Literal("tabs"), mode: Mode })
const { sessionID: _observeSessionID, callID: _observeCallID, ...ObserveFields } = Browser.Schema.ObserveInput.fields
const { sessionID: _actionSessionID, callID: _actionCallID, ...ActionFields } = Browser.Schema.ActionInput.fields
const ActionObject = Schema.Union([
  Browser.Schema.Navigate,
  Browser.Schema.Click,
  Browser.Schema.Type,
  Schema.Struct({ ...Browser.Schema.Scroll.fields, deltaY: integer(Browser.Schema.Scroll.fields.deltaY) }),
  Browser.Schema.Capture,
  Browser.Schema.Group,
  Schema.Struct({ ...Browser.Schema.Ungroup.fields, groupID: integer(Browser.Schema.Ungroup.fields.groupID) }),
])
const ActionPayload = Schema.Union([
  ActionObject,
  Schema.String.pipe(Schema.decodeTo(Schema.UnknownFromJsonString), Schema.decodeTo(ActionObject)),
])
const ObserveOperation = Schema.Struct({
  operation: Schema.Literal("observe"),
  mode: Schema.Literals(["owned", "profile"]).pipe(Schema.optional),
  ...ObserveFields,
  generation: integer(Browser.Schema.Generation),
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
  generation: integer(Browser.Schema.Generation),
})
const ActionOperation = Schema.Struct({
  operation: Schema.Literal("action"),
  mode: Schema.Literals(["owned", "profile"]).pipe(Schema.optional),
  ...ActionFields,
  generation: integer(Browser.Schema.Generation),
  documentGeneration: integer(Browser.Schema.DocumentGeneration),
  observationRevision: integer(Browser.Schema.ObservationRevision),
  action: ActionPayload,
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
  generation: integer(Browser.Schema.Generation),
  documentGeneration: integer(Browser.Schema.DocumentGeneration),
  observationRevision: integer(Browser.Schema.ObservationRevision),
  action: ActionPayload,
})
const ControlOperation = Schema.Struct({
  operation: Schema.Literal("control"),
  mode: Schema.Literal("isolated").pipe(Schema.optional),
  ...Browser.Schema.ControlInput.fields,
})
const StopOperation = Schema.Struct({ operation: Schema.Literal("stop"), mode: Schema.Literal("isolated").pipe(Schema.optional) })
const OpenOperation = Schema.Struct({ operation: Schema.Literal("open"), mode: Schema.Literal("owned"),
  generation: integer(Browser.Schema.Generation), url: Browser.Schema.OpenInput.fields.url })
const CloseOperation = Schema.Struct({ operation: Schema.Literal("close"), mode: Schema.Literal("owned"), tabID: Browser.TabID,
  generation: integer(Browser.Schema.Generation) })

export const Input = Schema.Union([
  StatusOperation,
  TabsOperation,
  ObserveOperation,
  IsolatedObserveOperation,
  ActionOperation,
  IsolatedActionOperation,
  ControlOperation,
  StopOperation,
  OpenOperation,
  CloseOperation,
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
  Schema.Struct({ type: Schema.Literal("tabs"), mode: Schema.Literal("owned"), tabs: Schema.Array(Browser.Schema.Tab) }),
  Schema.Struct({ type: Schema.Literal("tabs"), mode: Schema.Literal("profile"), tabs: Schema.Array(Browser.Schema.Tab) }),
  Schema.Struct({ type: Schema.Literal("opened"), tab: Browser.Schema.Tab }),
  Schema.Struct({ type: Schema.Literal("closed"), mode: Schema.Literal("owned") }),
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
              "Use status once, then tabs. Reuse returned tabID, generation, documentGeneration, and observationRevision fences exactly as numbers; never invent refs. Observe for semantic refs, then act only by a returned ref. Action results return updated tab fences, not a semantic observation; carry those fences forward for actions without refs, and observe again before another ref-based action because each action invalidates prior refs. Capture only when semantic observation is insufficient. On a stale-fence error, observe once and retry once; never replay an uncertain mutation—observe first. Prefer mode:'owned' background tabs for new work so user tabs stay untouched. Paired Chrome is the default; mode:'profile' selects it explicitly, and mode:'isolated' uses the user-started temporary headless browser. Profile tabs can group or ungroup granted inactive tabs. Owned mode only creates and closes its own tabs.",
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
                const ownedMode = input.mode === "owned"
                const profileMode = !isolatedMode && !ownedMode
                const source = { type: "tool" as const, messageID: context.messageID, callID: context.callID }
                if (input.operation === "open") {
                  const resource = yield* Effect.try({
                    try: () => safeResource(input.url),
                    catch: (error) => new ToolFailure({ message: "Unsupported browser navigation target", error }),
                  })
                  for (const action of ["browser_navigate", "browser_read"] as const)
                    yield* permission.assert({
                      action, resources: [resource], save: [new URL(resource).origin],
                      metadata: { operation: "open", mode: "owned", incidentalDownloads: true, site: new URL(resource).origin },
                      sessionID: context.sessionID, agent: context.agent, source,
                    })
                  const reservation = yield* guardrail.assert({
                    sessionID: context.sessionID, action: "browser_owned_open", resources: [resource],
                    metadata: { operation: "open" }, skipReview: true,
                  })
                  const tab = yield* browser.open({ sessionID: context.sessionID, generation: input.generation,
                    url: input.url, callID: context.callID })
                    .pipe(Effect.ensuring(reservation.release))
                  yield* permission.assert({
                    action: "browser_read", resources: [`${tab.page.origin}${tab.page.path}`],
                    save: [tab.page.origin], metadata: { operation: "open" },
                    sessionID: context.sessionID, agent: context.agent, source,
                  }).pipe(Effect.catchIf(
                    (error) => error instanceof PermissionV2.BlockedError || error instanceof PermissionV2.CorrectedError,
                    () => browser.close({ sessionID: context.sessionID, tabID: tab.id,
                      generation: tab.generation, callID: `cleanup-${tab.id}` }).pipe(
                      Effect.catch(() => Effect.fail(new ToolFailure({
                        message: `Page access was denied and the new Chrome tab may remain open. Switch away and close it manually in Chrome. Tab ID: ${tab.id}`,
                      }))),
                      Effect.flatMap(() => Effect.fail(new ToolFailure({
                        message: "Page access was denied; the new Chrome tab was closed",
                      }))),
                    ),
                  ))
                  return { type: "opened" as const, tab }
                }
                if (input.operation === "close") {
                  const tab = (yield* browser.list(context.sessionID)).find((item) => item.id === input.tabID && item.mode === "owned")
                  if (!tab) return yield* new ToolFailure({ message: "Chrome tab is not owned by this Session" })
                  yield* permission.assert({ action: "browser_control", resources: ["close"], save: ["*"],
                    metadata: { action: "close", mode: "owned" }, sessionID: context.sessionID, agent: context.agent, source })
                  yield* permission.assert({ action: "browser_read", resources: [`${tab.page.origin}${tab.page.path}`],
                    save: [tab.page.origin], metadata: { operation: "close" }, sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ sessionID: context.sessionID,
                    action: "browser_mutation", resources: [`${tab.page.origin}${tab.page.path}`], metadata: { operation: "close" },
                    skipReview: true })
                  yield* browser.close({ sessionID: context.sessionID, tabID: input.tabID, generation: input.generation,
                    callID: context.callID }).pipe(Effect.ensuring(reservation.release))
                  return { type: "closed" as const, mode: "owned" as const }
                }
                if (input.operation === "status") {
                  const status = yield* isolatedMode
                    ? isolated.status(context.sessionID)
                    : browser.status(context.sessionID)
                  return { type: "status" as const, status }
                }
                if (input.operation === "tabs") {
                  const tabs = (yield* isolatedMode ? isolated.list(context.sessionID) : browser.list(context.sessionID))
                    .filter((tab) => isolatedMode || (ownedMode ? tab.mode === "owned" :
                      tab.mode === "profile"))
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
                    : ownedMode ? { type: "tabs" as const, mode: "owned" as const, tabs }
                    : input.mode === "profile" ? { type: "tabs" as const, mode: "profile" as const, tabs }
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
                  : browser.list(context.sessionID)).find((item) => item.id === input.tabID &&
                    (isolatedMode || (ownedMode ? item.mode === "owned" :
                      item.mode === "profile")))
                if (!tab) return yield* new ToolFailure({ message: "Chrome tab is not available in this mode" })
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
                  const observation = yield* isolatedMode
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
                      })
                  if (!isolatedMode && observation.page.origin !== tab.page.origin)
                    return yield* new ToolFailure({ message: "The shared tab changed to an unapproved site" })
                  if (!isolatedMode && `${observation.page.origin}${observation.page.path}` !== page)
                    yield* permission.assert({
                      action: "browser_read",
                      resources: [`${observation.page.origin}${observation.page.path}`],
                      save: [observation.page.origin],
                      metadata: { operation: "observe" },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                  return { type: "observation" as const, observation }
                }
                if (input.action.type === "group" || input.action.type === "ungroup") {
                  if (!profileMode) return yield* new ToolFailure({ message: "Tab groups require profile mode" })
                  const groupAction = input.action
                  const members = (yield* browser.list(context.sessionID))
                    .filter((item) => groupAction.tabIDs.includes(item.id) && item.mode === "profile")
                  if (members.length !== groupAction.tabIDs.length || !groupAction.tabIDs.includes(tab.id))
                    return yield* new ToolFailure({ message: "Group members are not granted profile tabs" })
                  const resources = members.map((item) => `${item.page.origin}${item.page.path}`)
                  yield* permission.assert({ action: "browser_read", resources,
                    save: members.map((item) => item.page.origin), metadata: { operation: input.action.type },
                    sessionID: context.sessionID, agent: context.agent, source })
                  yield* permission.assert({ action: "browser_control", resources: [input.action.type], save: ["*"],
                    metadata: { action: input.action.type, mode: "profile" },
                    sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ sessionID: context.sessionID,
                    action: "browser_profile_mutation", resources,
                    metadata: { operation: input.action.type }, skipReview: true })
                  const result = yield* browser.action({ sessionID: context.sessionID, tabID: input.tabID,
                    generation: input.generation, documentGeneration: input.documentGeneration,
                    observationRevision: input.observationRevision, callID: context.callID,
                    action: input.action }).pipe(Effect.ensuring(reservation.release))
                  return { type: "action" as const, result }
                }
                const navigationURL = input.action.type === "navigate" ? input.action.url : undefined
                const extensionMode = !isolatedMode
                if (extensionMode)
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [page],
                    save: [tab.page.origin],
                    metadata: { operation: input.action.type },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                const clickDestination =
                  extensionMode && input.action.type === "click"
                    ? yield* browser.clickDestination({
                        sessionID: context.sessionID,
                        tabID: input.tabID,
                        generation: input.generation,
                        documentGeneration: input.documentGeneration,
                        observationRevision: input.observationRevision,
                        ref: input.action.ref,
                      })
                    : undefined
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
                    ...(extensionMode && ["navigate", "click", "type"].includes(input.action.type)
                      ? { mode: ownedMode ? "owned" : "profile", incidentalDownloads: true, site: new URL(resource).origin }
                      : {}),
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const destination =
                  clickDestination && clickDestination.origin !== tab.page.origin
                    ? `${clickDestination.origin}${clickDestination.path}`
                    : undefined
                if (destination) {
                  yield* permission.assert({
                    action: "browser_navigate",
                    resources: [destination],
                    save: [new URL(destination).origin],
                    metadata: {
                      operation: "click",
                      mode: ownedMode ? "owned" : "profile",
                      incidentalDownloads: true,
                      site: new URL(destination).origin,
                    },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                if (extensionMode && (navigationURL || destination))
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [destination ?? resource],
                    save: [new URL(destination ?? resource).origin],
                    metadata: { operation: input.action.type },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                const mutating = ["navigate", "click", "type"].includes(input.action.type)
                const reservation = mutating
                  ? yield* guardrail.assert({
                      sessionID: context.sessionID,
                      action: profileMode ? "browser_profile_mutation" : "browser_mutation",
                      resources: destination ? [resource, destination] : [resource],
                      metadata: { operation: input.action.type },
                      skipReview: true,
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
                if (extensionMode) {
                  if (![tab.page.origin, new URL(destination ?? resource).origin].includes(result.tab.page.origin))
                    return yield* new ToolFailure({ message: "The shared tab changed to an unapproved site" })
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [`${result.tab.page.origin}${result.tab.page.path}`],
                    save: [result.tab.page.origin],
                    metadata: { operation: input.action.type },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
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
