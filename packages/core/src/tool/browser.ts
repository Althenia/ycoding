export * as BrowserTool from "./browser"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Browser } from "../browser"
import { BrowserOperation } from "../browser/operation"
import { IsolatedBrowser } from "../isolated-browser"
import { Permission } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"
import { Hash } from "../util/hash"

export const name = "browser"

const LEASE_HELD = "Chrome tab is controlled by another Session; wait for it to release control"

type ModeName = "isolated" | "owned" | "profile"

const DEPARTURE_REASONS: Record<Browser.DepartureReason, string> = {
  closed: "the tab was closed",
  navigated: "the tab navigated outside the approved sites and control was revoked",
  detached: "Chrome detached the debugger",
  access_revoked: "paired-profile access was turned off in the extension",
  replaced: "Chrome replaced the tab",
}

function wrongMode(tabID: string, actual: ModeName, current: ModeName) {
  return `Chrome tab ${tabID} is ${actual === "owned" ? "an owned" : actual === "isolated" ? "an isolated" : "a profile"} tab, not available with mode:"${current}"; pass mode:"${actual}" instead`
}

function departure(tabID: string, state: Extract<Browser.TabState, { state: "departed" }>) {
  const reason = state.reason
    ? `${DEPARTURE_REASONS[state.reason]}${state.detachReason ? ` (${state.detachReason})` : ""}`
    : "the Chrome extension revoked it"
  return `Chrome tab ${tabID} is no longer listed: ${reason}.${state.successorID ? ` The same Chrome tab is now listed as ${state.successorID}; observe it before acting.` : " List tabs again to find it."}`
}

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
  Browser.Schema.Fill,
  Schema.Struct({
    ...Browser.Schema.Select.fields,
    indexes: Schema.Array(integer(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))))
      .check(Schema.isMinLength(1), Schema.isMaxLength(Browser.Schema.MAX_SELECT_OPTIONS))
      .pipe(Schema.optional),
  }).check(Browser.Schema.selectCriterion),
  Browser.Schema.Check,
  Browser.Schema.Hover,
  Schema.Struct({ ...Browser.Schema.Scroll.fields, deltaY: integer(Browser.Schema.Scroll.fields.deltaY) }),
  Browser.Schema.Capture,
  Browser.Schema.Group,
  Schema.Struct({ ...Browser.Schema.Ungroup.fields, groupID: integer(Browser.Schema.Ungroup.fields.groupID) }),
  Browser.Schema.Back,
  Browser.Schema.Forward,
  Browser.Schema.Reload,
  Browser.Schema.Key,
  Schema.Struct({
    ...Browser.Schema.Wait.fields,
    timeoutMs: integer(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Browser.Schema.MAX_WAIT_MS)),
    ).pipe(Schema.optional),
  }).check(Browser.Schema.waitCondition),
  Browser.Schema.ClipboardRead,
  Browser.Schema.ClipboardWrite,
  Browser.Schema.Upload,
  Schema.Struct({
    type: Schema.Literal("download"),
    timeoutMs: integer(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Browser.Schema.MAX_WAIT_MS)),
    ).pipe(Schema.optional),
  }),
  Schema.Struct({
    type: Schema.Literal("logs"),
    limit: integer(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Browser.Schema.MAX_LOG_ENTRIES)),
    ).pipe(Schema.optional),
  }),
  Browser.Schema.Export,
  Browser.Schema.WebMcpList,
  Browser.Schema.WebMcpInvoke,
  Browser.Schema.Dialog,
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
const DeliverOperation = Schema.Struct({ operation: Schema.Literal("deliver"), mode: Schema.Literal("owned"), tabID: Browser.TabID,
  generation: integer(Browser.Schema.Generation) })

const ReleaseOperation = Schema.Struct({ operation: Schema.Literal("release"), mode: Schema.Literal("profile"), tabID: Browser.TabID,
  generation: integer(Browser.Schema.Generation) })

const { sessionID: _historySessionID, callID: _historyCallID, ...HistoryFields } = Browser.Schema.HistoryInput.fields
const historyLimit = integer(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Browser.Schema.MAX_HISTORY_RESULTS)),
).pipe(Schema.optional)
const historyTime = integer(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).pipe(Schema.optional)
const HistoryOperation = Schema.Struct({
  operation: Schema.Literal("history"),
  mode: Schema.Literals(["owned", "profile"]).pipe(Schema.optional),
  ...HistoryFields,
  generation: integer(Browser.Schema.Generation),
  limit: historyLimit,
  startTime: historyTime,
  endTime: historyTime,
})
const IsolatedHistoryOperation = Schema.Struct({
  operation: Schema.Literal("history"),
  mode: Schema.Literal("isolated"),
  instanceID: IsolatedBrowser.Schema.InstanceID,
  ...HistoryFields,
  generation: integer(Browser.Schema.Generation),
  limit: historyLimit,
  startTime: historyTime,
  endTime: historyTime,
})

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
  DeliverOperation,
  ReleaseOperation,
  HistoryOperation,
  IsolatedHistoryOperation,
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
  Schema.Struct({ type: Schema.Literal("delivered"), mode: Schema.Literal("owned"), tab: Browser.Schema.Tab }),
  Schema.Struct({ type: Schema.Literal("released"), mode: Schema.Literal("profile") }),
  Schema.Struct({ type: Schema.Literal("observation"), observation: IsolatedBrowser.Schema.Observation }),
  Schema.Struct({ type: Schema.Literal("observation"), observation: Browser.Schema.Observation }),
  Schema.Struct({ type: Schema.Literal("action"), result: IsolatedBrowser.Schema.ActionResult }),
  Schema.Struct({ type: Schema.Literal("action"), result: Browser.Schema.ActionResult }),
  Schema.Struct({ type: Schema.Literal("history"), result: Browser.Schema.HistoryResult }),
  Schema.Struct({ type: Schema.Literal("stopped"), mode: Schema.Literal("isolated") }),
  Schema.Struct({ type: Schema.Literal("stopped") }),
])

export const Plugin = {
  id: "ycoding.tool.browser",
  effect: Effect.fn("BrowserTool.Plugin")(function* (ctx: PluginContext) {
    const browser = yield* Browser.Service
    const isolated = yield* IsolatedBrowser.Service
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service

    const unavailable = Effect.fn("BrowserTool.unavailable")(function* (
      sessionID: Browser.Schema.Tab["sessionID"],
      tabID: Browser.Schema.Tab["id"],
      current: ModeName,
    ) {
      const state = yield* browser.tabState(sessionID, tabID)
      if (state.state === "present" && state.mode !== current)
        return yield* new ToolFailure({ message: wrongMode(tabID, state.mode, current) })
      if (state.state === "departed") return yield* new ToolFailure({ message: departure(tabID, state) })
      if (current !== "isolated" && (yield* isolated.list(sessionID)).some((item) => item.id === tabID))
        return yield* new ToolFailure({ message: wrongMode(tabID, "isolated", current) })
      return yield* new ToolFailure({ message: `Chrome tab ${tabID} is not listed by the current browser connection; list tabs again` })
    })

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "Work inside web pages in the paired Chrome profile with the user's existing logins: read page text and controls (including content inside cross-origin iframes, such as embedded third-party widgets), click, type, fill forms, select options, check boxes, hover, navigate, go back/forward, reload, press keys, scroll, wait for elements, URLs, load states, or text, capture screenshots, search history, use the clipboard, upload files, wait for downloads, read console logs, export pages as MHTML, and list or invoke native page WebMCP tools when present. Prefer this tool over computer for anything inside a web page. This choice is between the computer and browser tools only; it does not forbid another browser route the user explicitly authorizes, such as Playwright connectOverCDP to an existing Chrome DevTools endpoint, which stays subject to the same permission, guardrail, credential and confirmation rules. Observations return readable text plus semantic elements, and an element's optional frame field names the iframe page it came from (frames lists child frames and whether each was observed). Use status once, then tabs. Reuse returned tabID, generation, documentGeneration, and observationRevision fences exactly as numbers; never invent refs. Observe for semantic refs, then act only by a returned ref; each element also carries a stable locator (role and accessible name), and click, type, fill, select, check, hover, upload, and wait accept that locator instead of a ref when the same element must be found again after re-observing; wait also accepts a locator for an element that has not appeared yet. Observe with diff:true to receive only elements added or changed since the previous observation, with removed locators listed in delta; the first observation is always full. Action results return updated tab fences, not a semantic observation; carry those fences forward for actions without refs, and observe again before another ref-based action because each action invalidates prior refs. Capture only when semantic observation is insufficient; capture accepts a clip rectangle, fullPage:true for the whole page, or a ref to capture one element. Fill replaces a field's text (text:'' clears it); select picks options of a native select by values, labels, or indexes, or one option of an open listbox by label or index; check sets a checkbox, radio, or switch to checked:true or checked:false and does nothing when it already matches; hover moves the pointer over an element without clicking. These return the control's resulting state. Elements report checked, pressed, expanded, selected, and the value of ordinary fields; sensitive:true marks a password, one-time-code, or payment field whose value is withheld and which no action may fill. Wait takes one condition: a ref or locator with state attached, visible, hidden, or detached (default visible for a locator, attached for a ref); url, a pattern over the page origin and path where * matches any characters; load: domcontentloaded, load, or networkidle (no network request pending for 500 ms; on a paired tab attached while requests were already running, only requests started after attach are seen); or text that must appear on the page. timeoutMs is at most 30,000; wait without a condition waits for load. key checks the active focus in profile, owned, and isolated modes. Only Tab, Shift+Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, and PageDown bypass active-focus inspection, with no Ctrl, Meta, or Alt and Shift allowed only for Tab. Every other supported key requires verified focus, including printable characters with Shift or Alt, Space, Enter, Backspace, Delete, Insert, Shift+Insert, and all Ctrl or Meta chords, including V and X. Focus inspection refuses sensitive password, one-time-code, payment, or secret-named fields, file inputs, and unverified focus (including closed shadow roots and unreachable cross-origin frames) before any key event with dispatched:false. Do not use key to bypass a sensitive-field refusal in any mode. If a page opens a JavaScript dialog, other actions stall until it is answered: use action {type:'dialog'} to read it and {type:'dialog', accept:true or false, text} to respond. Mark an owned tab that holds the work product with operation:'deliver' so it stays open in Chrome for the user instead of closing when control ends. Ask the user before irreversible submissions, purchases, payments, deletions, sending messages, or accepting legal terms; proceed without asking for reading, navigation, and reversible input that does not submit anything. Never solve CAPTCHAs, enter passwords, one-time codes, or payment secrets: stop and hand the page to the user. On a stale-fence error, observe once and retry once; never replay an uncertain mutation—observe first. Prefer mode:'owned' background tabs for new work so user tabs stay untouched. Paired Chrome is the default; mode:'profile' selects it explicitly, and mode:'isolated' uses the user-started temporary headless browser. Profile tabs can group or ungroup granted inactive tabs. The first observe or action claims a profile tab for this Session; lease:'other' means another Session controls it, so choose another tab or wait. Call operation:'release' with mode:'profile' when finished with a tab; control also ends when the Session goes idle. Owned mode only creates and closes its own tabs. Focus emulation keeps controlled pages visible and unthrottled while attached; it ends when the debugger detaches.",
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
                      metadata: { operationDigest: requestDigest(input), operation: "open", mode: "owned", incidentalDownloads: true, site: new URL(resource).origin },
                      sessionID: context.sessionID, agent: context.agent, source,
                    })
                  const reservation = yield* guardrail.assert({ source: { messageID: context.messageID, callID: context.callID },
                    sessionID: context.sessionID, action: "browser_owned_open", resources: [resource],
                    metadata: { operationDigest: requestDigest(input), operation: "open" }, skipReview: true,
                  })
                  const tab = yield* browser.open({ sessionID: context.sessionID, generation: input.generation,
                    url: input.url, callID: context.callID })
                    .pipe(Effect.ensuring(reservation.release))
                  yield* permission.assert({
                    action: "browser_read", resources: [`${tab.page.origin}${tab.page.path}`],
                    save: [tab.page.origin], metadata: { operationDigest: requestDigest(input), operation: "open" },
                    sessionID: context.sessionID, agent: context.agent, source,
                  }).pipe(Effect.catchIf(
                    (error) => error instanceof Permission.BlockedError || error instanceof Permission.CorrectedError,
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
                    metadata: { operationDigest: requestDigest(input), action: "close", mode: "owned" }, sessionID: context.sessionID, agent: context.agent, source })
                  yield* permission.assert({ action: "browser_read", resources: [`${tab.page.origin}${tab.page.path}`],
                    save: [tab.page.origin], metadata: { operationDigest: requestDigest(input), operation: "close" }, sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ source: { messageID: context.messageID, callID: context.callID }, sessionID: context.sessionID,
                    action: "browser_mutation", resources: [`${tab.page.origin}${tab.page.path}`], metadata: { operationDigest: requestDigest(input), operation: "close" },
                    skipReview: true })
                  yield* browser.close({ sessionID: context.sessionID, tabID: input.tabID, generation: input.generation,
                    callID: context.callID }).pipe(Effect.ensuring(reservation.release))
                  return { type: "closed" as const, mode: "owned" as const }
                }
                if (input.operation === "deliver") {
                  const tab = (yield* browser.list(context.sessionID)).find((item) => item.id === input.tabID && item.mode === "owned")
                  if (!tab) return yield* new ToolFailure({ message: "Chrome tab is not owned by this Session" })
                  yield* permission.assert({ action: "browser_control", resources: ["deliver"], save: ["*"],
                    metadata: { operationDigest: requestDigest(input), action: "deliver", mode: "owned" }, sessionID: context.sessionID, agent: context.agent, source })
                  yield* permission.assert({ action: "browser_read", resources: [`${tab.page.origin}${tab.page.path}`],
                    save: [tab.page.origin], metadata: { operationDigest: requestDigest(input), operation: "deliver" }, sessionID: context.sessionID, agent: context.agent, source })
                  const delivered = yield* browser.deliver({ sessionID: context.sessionID, tabID: input.tabID, generation: input.generation,
                    callID: context.callID })
                  return { type: "delivered" as const, mode: "owned" as const, tab: delivered }
                }
                if (input.operation === "release") {
                  const held = (yield* browser.list(context.sessionID)).find(
                    (item) => item.id === input.tabID && item.mode === "profile",
                  )
                  if (!held) return yield* unavailable(context.sessionID, input.tabID, "profile")
                  yield* browser.release({ sessionID: context.sessionID, tabID: input.tabID, generation: input.generation,
                    callID: context.callID })
                  return { type: "released" as const, mode: "profile" as const }
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
                      metadata: { operationDigest: requestDigest(input), operation: "tabs" },
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
                if (input.operation === "history") {
                  if (isolatedMode)
                    return yield* new ToolFailure({ message: "History search is unavailable in isolated mode because it has no user profile" })
                  yield* permission.assert({
                    action: "browser_read",
                    resources: ["history"],
                    save: ["*"],
                    metadata: { operationDigest: requestDigest(input), operation: "history" },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  const result = yield* browser.history({
                    sessionID: context.sessionID,
                    generation: input.generation,
                    callID: context.callID,
                    query: input.query,
                    limit: input.limit,
                    startTime: input.startTime,
                    endTime: input.endTime,
                  })
                  return { type: "history" as const, result }
                }
                if (input.operation === "control") {
                  yield* permission.assert({
                    action: "browser_control",
                    resources: [input.action],
                    save: ["*"],
                    metadata: { operationDigest: requestDigest(input), action: input.action },
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
                    metadata: { operationDigest: requestDigest(input), action: "stop" },
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
                if (!tab)
                  return yield* unavailable(context.sessionID, input.tabID, isolatedMode ? "isolated" : ownedMode ? "owned" : "profile")
                if (tab.lease === "other") return yield* new ToolFailure({ message: LEASE_HELD })
                const page = `${tab.page.origin}${tab.page.path}`
                if (input.operation === "observe") {
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [page],
                    save: [tab.page.origin],
                    metadata: { operationDigest: requestDigest(input), operation: "observe" },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  const runObserve = (callID: string) =>
                    isolatedMode
                      ? isolated.observe({
                          sessionID: context.sessionID,
                          instanceID: input.instanceID,
                          tabID: input.tabID,
                          generation: input.generation,
                          callID,
                        })
                      : browser.observe({
                          sessionID: context.sessionID,
                          tabID: input.tabID,
                          generation: input.generation,
                          callID,
                        })
                  const assertFrameReads = (current: Browser.Schema.Observation) =>
                    Effect.gen(function* () {
                      const framePages = [
                        ...(current.frames ?? []).map((frame) => frame.page),
                        ...current.elements.flatMap((element) => element.frame ?? []),
                        ...(current.texts ?? []).flatMap((text) => text.frame ?? []),
                      ].filter((framePage) => framePage.origin !== current.page.origin)
                      const resources = [...new Set(framePages.map((framePage) => `${framePage.origin}${framePage.path}`))]
                      if (resources.length === 0) return
                      yield* permission.assert({
                        action: "browser_read",
                        resources,
                        save: [...new Set(framePages.map((framePage) => framePage.origin))],
                        metadata: { operationDigest: requestDigest(input), operation: "observe" },
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source,
                      })
                    })
                  let observation = yield* runObserve(context.callID)
                  if (!isolatedMode && observation.page.origin !== tab.page.origin)
                    return yield* new ToolFailure({ message: "The shared tab changed to an unapproved site" })
                  if (!isolatedMode && `${observation.page.origin}${observation.page.path}` !== page)
                    yield* permission.assert({
                      action: "browser_read",
                      resources: [`${observation.page.origin}${observation.page.path}`],
                      save: [observation.page.origin],
                      metadata: { operationDigest: requestDigest(input), operation: "observe" },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                  yield* assertFrameReads(observation)
                  if (observation.frames?.some((frame) => !frame.observed && frame.page.origin !== observation.page.origin)) {
                    observation = yield* runObserve(`${context.callID}:frames`)
                    if (!isolatedMode && observation.page.origin !== tab.page.origin)
                      return yield* new ToolFailure({ message: "The shared tab changed to an unapproved site" })
                    yield* assertFrameReads(observation)
                  }
                  return { type: "observation" as const, observation }
                }
                const identityInput = { sessionID: context.sessionID, tabID: input.tabID, generation: input.generation,
                  documentGeneration: input.documentGeneration, observationRevision: input.observationRevision, action: input.action }
                if (input.action.type === "group" || input.action.type === "ungroup") {
                  if (!profileMode) return yield* new ToolFailure({ message: "Tab groups require profile mode" })
                  const groupAction = input.action
                  const members = (yield* browser.list(context.sessionID))
                    .filter((item) => groupAction.tabIDs.includes(item.id) && item.mode === "profile")
                  if (members.length !== groupAction.tabIDs.length || !groupAction.tabIDs.includes(tab.id))
                    return yield* new ToolFailure({ message: "Group members are not granted profile tabs" })
                  if (members.some((item) => item.lease === "other")) return yield* new ToolFailure({ message: LEASE_HELD })
                  const actionDigest = (yield* browser.actionIdentity(identityInput)).digest
                  const resources = members.map((item) => `${item.page.origin}${item.page.path}`)
                  yield* permission.assert({ action: "browser_read", resources,
                    save: members.map((item) => item.page.origin), metadata: { operationDigest: actionDigest, operation: input.action.type },
                    sessionID: context.sessionID, agent: context.agent, source })
                  yield* permission.assert({ action: "browser_control", resources: [input.action.type], save: ["*"],
                    metadata: { operationDigest: actionDigest, action: input.action.type, mode: "profile" },
                    sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ source: { messageID: context.messageID, callID: context.callID }, sessionID: context.sessionID,
                    action: "browser_profile_mutation", resources,
                    metadata: { operationDigest: actionDigest, operation: input.action.type }, skipReview: true })
                  const result = yield* browser.action({ sessionID: context.sessionID, tabID: input.tabID,
                    generation: input.generation, documentGeneration: input.documentGeneration,
                    observationRevision: input.observationRevision, callID: context.callID,
                    action: input.action }).pipe(Effect.ensuring(reservation.release))
                  return { type: "action" as const, result }
                }
                const identity = yield* (isolatedMode ? isolated.actionIdentity({ ...identityInput, instanceID: input.instanceID }) : browser.actionIdentity(identityInput))
                const actionDigest = identity.digest
                const navigationURL = input.action.type === "navigate" ? input.action.url : undefined
                const extensionMode = !isolatedMode
                if (extensionMode)
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [page],
                    save: [tab.page.origin],
                    metadata: { operationDigest: actionDigest, operation: input.action.type },
                    consumeReview: identity.reusable,
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
                        ref: input.action.ref ?? input.action.locator ?? "",
                      })
                    : undefined
                const classification = BrowserOperation.classify(input.action)
                const elementFrame =
                  extensionMode && BrowserOperation.isElementAction(input.action)
                    ? yield* browser.elementFrame({
                        sessionID: context.sessionID,
                        tabID: input.tabID,
                        generation: input.generation,
                        documentGeneration: input.documentGeneration,
                        observationRevision: input.observationRevision,
                        ref: input.action.ref ?? input.action.locator ?? "",
                      })
                    : undefined
                const frameResource =
                  elementFrame && elementFrame.origin !== tab.page.origin
                    ? `${elementFrame.origin}${elementFrame.path}`
                    : undefined
                const resource =
                  navigationURL !== undefined
                    ? yield* Effect.try({
                        try: () => safeResource(navigationURL),
                        catch: (error) => new ToolFailure({ message: "Unsupported browser navigation target", error }),
                      })
                    : page
                yield* permission.assert({
                  action: classification.permission,
                  consumeReview: identity.reusable,
                  resources: [resource],
                  save: [new URL(resource).origin],
                  metadata: {
                    operationDigest: actionDigest,
                    operation: input.action.type,
                    ...(extensionMode && classification.mutation
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
                    consumeReview: identity.reusable,
                    save: [new URL(destination).origin],
                    metadata: {
                      operationDigest: actionDigest,
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
                if (frameResource) {
                  for (const frameAction of ["browser_read", "browser_interact"] as const)
                    yield* permission.assert({
                      action: frameAction,
                      resources: [frameResource],
                      consumeReview: identity.reusable,
                      save: [new URL(frameResource).origin],
                      metadata: {
                        operationDigest: actionDigest,
                        operation: input.action.type,
                        mode: ownedMode ? "owned" : "profile",
                        incidentalDownloads: true,
                        site: new URL(frameResource).origin,
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
                    consumeReview: identity.reusable,
                    save: [new URL(destination ?? resource).origin],
                    metadata: { operationDigest: actionDigest, operation: input.action.type },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                const reservation = classification.mutation
                  ? yield* guardrail.assert({ source: { messageID: context.messageID, callID: context.callID },
                      sessionID: context.sessionID,
                      action: profileMode ? "browser_profile_mutation" : "browser_mutation",
                      resources: [resource, ...(destination ? [destination] : []), ...(frameResource ? [frameResource] : [])],
                      metadata: { operationDigest: actionDigest, operation: input.action.type },
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
                    consumeReview: identity.reusable,
                    save: [result.tab.page.origin],
                    metadata: { operationDigest: actionDigest, operation: input.action.type },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                const matchFrame = result.frame && result.frame.origin !== result.tab.page.origin ? result.frame : undefined
                if (matchFrame)
                  yield* permission.assert({
                    action: "browser_read",
                    resources: [`${matchFrame.origin}${matchFrame.path}`],
                    consumeReview: identity.reusable,
                    save: [matchFrame.origin],
                    metadata: { operationDigest: actionDigest, operation: input.action.type },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                return { type: "action" as const, result }
              }).pipe(
                Effect.tap((output) => {
                  if (output.type !== "status" || !("tab" in output.status) || !output.status.tab) return Effect.void
                  return permission.assert({
                    action: "browser_read",
                    resources: [`${output.status.tab.page.origin}${output.status.tab.page.path}`],
                    save: [output.status.tab.page.origin],
                    metadata: { operationDigest: requestDigest(input), operation: input.operation },
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

function requestDigest(input: typeof Input.Type) {
  return Hash.json({ ...input, generation: undefined, documentGeneration: undefined, observationRevision: undefined })
}

function safeResource(input: string) {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only credential-free HTTP and HTTPS navigation is supported")
  return `${url.origin}${url.pathname || "/"}`
}
