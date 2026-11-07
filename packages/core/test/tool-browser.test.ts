import { describe, expect } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { Image } from "@ycoding-ai/core/image"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { Permission } from "@ycoding-ai/core/permission"
import { Session } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { BrowserTool } from "@ycoding-ai/core/tool/browser"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Effect, Layer } from "effect"
import { host } from "./plugin/host"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_browser_tool")
const tabID = Browser.TabID.make("btab_browser_tool")
const sequence: string[] = []
const requests: Permission.AssertInput[] = []
const guardrailRequests: SessionGuardrail.EvaluateInput[] = []

const tab: Browser.Tab = {
  id: tabID,
  sessionID,
  title: "Fixture",
  page: { origin: "https://example.test", path: "/form" },
  status: "shared",
  generation: 1,
  documentGeneration: 1,
  observationRevision: 1,
}
const ownedTab: Browser.Tab = { ...tab, id: Browser.TabID.make("btab_owned_tool"), mode: "owned" }
const profileTab: Browser.Tab = { ...tab, id: Browser.TabID.make("btab_profile_tool"), mode: "profile" }
const anotherProfileTab: Browser.Tab = { ...tab, id: Browser.TabID.make("btab_profile_second"),
  mode: "profile", page: { origin: "https://other.test", path: "/page" } }
const isolatedInstanceID = IsolatedBrowser.InstanceID.make("ibrowser_tool")

const browser = Layer.mock(Browser.Service, {
  actionIdentity: () => Effect.succeed({ digest: "a".repeat(64), reusable: true }),
  status: () => Effect.succeed({ state: "unavailable" }),
  list: () => Effect.succeed([tab, ownedTab, profileTab, anotherProfileTab]),
  tabState: (_session, id) => Effect.succeed([tab, ownedTab, profileTab, anotherProfileTab].find((item) => item.id === id)
    ? { state: "present" as const, mode: id === ownedTab.id ? "owned" as const : "profile" as const }
    : { state: "unknown" as const }),
  observe: (input) => Effect.succeed({
    tabID, generation: 1, documentGeneration: 1, revision: 2, title: "Fixture",
    page: input.callID === "unexpected-observation"
      ? { origin: "https://unapproved.test", path: "/private" }
      : input.callID === "changed-path-observation"
        ? { origin: "https://example.test", path: "/changed" }
      : tab.page,
    elements: [], truncated: false,
  }),
  clickDestination: () => Effect.succeed({ origin: "https://other.test", path: "/arrive" }),
  elementFrame: (input) =>
    Effect.succeed(input.ref === "b7" ? { origin: "https://child.example.test", path: "/tempo" } : undefined),
  history: (input) => Effect.sync(() => {
    sequence.push(`history:${input.callID}`)
    return { entries: [{ url: "https://example.test/visited", title: "Visited", lastVisitTime: 10, visitCount: 2 }] }
  }),
  open: (input) => Effect.sync(() => {
    sequence.push(`open:${input.callID}`)
    return { ...ownedTab, page: { origin: "https://example.test", path: "/new" } }
  }),
  close: (input) => Effect.sync(() => { sequence.push(`close:${input.callID}:${input.tabID}`) }),
  action: (input) =>
    Effect.sync(() => {
      sequence.push(`action:${input.callID}`)
      return { callID: input.callID,
        tab: input.callID === "unexpected-result"
          ? { ...tab, page: { origin: "https://unapproved.test", path: "/private" } }
          : input.tabID === profileTab.id ? profileTab : tab,
        status: "completed" as const }
    }),
})
const isolatedBrowser = Layer.mock(IsolatedBrowser.Service, {
  actionIdentity: () => Effect.succeed({ digest: "b".repeat(64), reusable: true }),
  status: () => Effect.succeed({ mode: "isolated", state: "ready", instanceID: isolatedInstanceID, tab }),
  control: () => Effect.succeed({ mode: "isolated", state: "paused", instanceID: isolatedInstanceID, tab }),
  list: () => Effect.succeed([tab]),
  action: (input) =>
    Effect.sync(() => {
      sequence.push(`isolated-action:${input.callID}:${input.instanceID}`)
      return {
        mode: "isolated" as const,
        instanceID: input.instanceID,
        callID: input.callID,
        tab,
        status: "completed" as const,
      }
    }),
})
const permission = Layer.mock(Permission.Service, {
  assert: (input) => Effect.sync(() => {
    requests.push(input)
    sequence.push(`permission:${input.action}:${input.resources[0]}`)
  }),
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
  reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
  assert: (input) =>
    Effect.sync(() => {
      guardrailRequests.push(input)
      sequence.push(`guardrail:${input.action}:${input.resources[0]}`)
      return { release: Effect.sync(() => sequence.push("release")) }
    }),
})
const browserToolNode = makeLocationNode({
  name: "test/browser-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(BrowserTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Browser.node, IsolatedBrowser.node, Permission.node, SessionGuardrail.node],
})
const browserTests = (permissionLayer: typeof permission, guardrailLayer: typeof guardrail = guardrail,
  browserLayer: typeof browser = browser) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, browserToolNode]), [
      [Browser.node, browserLayer],
      [IsolatedBrowser.node, isolatedBrowser],
      [Permission.node, permissionLayer],
      [SessionGuardrail.node, guardrailLayer],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ]),
  )
const it = browserTests(permission)
const denied = browserTests(
  Layer.mock(Permission.Service, {
    assert: (input) =>
      input.action === "browser_read"
        ? Effect.fail(new Permission.CorrectedError({ feedback: "Browser metadata access denied" }))
        : Effect.void,
  }),
)

describe("BrowserTool", () => {
  it.effect("defaults to paired profile tabs with site permissions and no read review", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      const listing = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "default-profile-list", name: "browser", input: { operation: "tabs" } } })
      expect(JSON.stringify(listing)).toContain(profileTab.id)
      expect(JSON.stringify(listing)).not.toContain(tabID)
      expect(JSON.stringify(listing)).not.toContain(ownedTab.id)
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
      expect(requests.find((entry) => entry.action === "browser_read")?.resources)
        .toEqual(["https://example.test/form", "https://other.test/page"])
    }),
  )
  const reviewDenied = browserTests(permission, Layer.mock(SessionGuardrail.Service, {
    reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
    assert: (input) => Effect.fail(new SessionGuardrail.BlockedError({
      rootSessionID: sessionID, sessionID, action: input.action, ruleIDs: ["test"], reason: "Human review denied",
    })),
  }))
  reviewDenied.effect("lists profile tabs without invoking the mutation review", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "default-profile-denied", name: "browser", input: { operation: "tabs" } } })
      expect(JSON.stringify(result)).toContain(profileTab.id)
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
    }),
  )
  reviewDenied.effect("does not dispatch a default profile mutation when hard review is denied", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "default-mutation-denied", name: "browser",
          input: { operation: "action", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1,
            action: { type: "navigate", url: "https://other.test/arrive" } } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).not.toContain("action:default-mutation-denied")
    }),
  )
  it.effect("applies site permissions without hard review for explicit profile listing", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      const listing = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "profile-list", name: "browser",
          input: { operation: "tabs", mode: "profile" } } })
      expect(JSON.stringify(listing)).toContain(profileTab.id)
      expect(JSON.stringify(listing)).not.toContain(ownedTab.id)
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
      expect(requests.find((entry) => entry.action === "browser_read")?.resources)
        .toEqual(["https://example.test/form", "https://other.test/page"])
    }),
  )

  const profileCapture = browserTests(permission, guardrail, Layer.mock(Browser.Service, {
    actionIdentity: () => Effect.succeed({ digest: "a".repeat(64), reusable: true }),
    list: () => Effect.succeed([profileTab]),
    action: (input) => Effect.sync(() => {
      sequence.push(`action:${input.callID}`)
      return { callID: input.callID, tab: profileTab, status: "completed" as const,
        capture: { mediaType: "image/png" as const, data: "aW1hZ2U=", bytes: 5 } }
    }),
  }))
  profileCapture.effect("captures a profile tab with site permission and projects an image without read review", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const settlement = yield* settleTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "profile-capture", name: "browser",
          input: { operation: "action", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "capture" } } } })
      expect(sequence).toEqual([
        "permission:browser_read:https://example.test/form",
        "permission:browser_read:https://example.test/form",
        "action:profile-capture",
        "permission:browser_read:https://example.test/form",
      ])
      expect(settlement.output?.content).toEqual([
        { type: "text", text: JSON.stringify({ type: "action", result: { callID: "profile-capture",
          tab: profileTab, status: "completed", capture: { mediaType: "image/png", bytes: 5 } } }) },
        { type: "file", uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png", name: "shared-tab.png" },
      ])
    }),
  )
  it.effect("treats history and key actions as interact mutations and wait as a read", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const [id, action] of [
        ["act-back", { type: "back" }],
        ["act-forward", { type: "forward" }],
        ["act-reload", { type: "reload" }],
        ["act-key", { type: "key", key: "Enter" }],
      ] as const) {
        sequence.length = 0
        yield* executeTool(registry, { sessionID, ...toolIdentity,
          call: { type: "tool-call", id, name: "browser",
            input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
              documentGeneration: 1, observationRevision: 1, action } } })
        expect(sequence, id).toContain("permission:browser_interact:https://example.test/form")
        expect(sequence, id).toContain("guardrail:browser_profile_mutation:https://example.test/form")
        expect(sequence, id).toContain(`action:${id}`)
      }
      sequence.length = 0
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "act-wait", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "wait", timeoutMs: 1000 } } } })
      expect(sequence).toContain("permission:browser_read:https://example.test/form")
      expect(sequence.some((entry) => entry.startsWith("guardrail:"))).toBe(false)
      expect(sequence).toContain("action:act-wait")
    }),
  )
  it.effect("asserts interact permission for the frame site before acting on a framed element", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "act-frame-click", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "click", ref: "b7" } } } })
      expect(sequence).toContain("permission:browser_read:https://child.example.test/tempo")
      expect(sequence).toContain("permission:browser_interact:https://child.example.test/tempo")
      expect(sequence.indexOf("permission:browser_interact:https://child.example.test/tempo"))
        .toBeLessThan(sequence.indexOf("action:act-frame-click"))
    }),
  )
  const frameObserve = browserTests(permission, guardrail, Layer.mock(Browser.Service, {
    list: () => Effect.succeed([profileTab]),
    observe: (input) => Effect.succeed({
      tabID: profileTab.id, generation: 1, documentGeneration: 1, revision: input.callID.endsWith(":frames") ? 3 : 2,
      title: "Fixture", page: profileTab.page,
      elements: input.callID.endsWith(":frames")
        ? [{ ref: "b1" as const, role: "button", name: "Child button", frame: { origin: "https://child.example.test", path: "/tempo" } }]
        : [],
      frames: [{ page: { origin: "https://child.example.test", path: "/tempo" }, observed: input.callID.endsWith(":frames") }],
      truncated: false,
    }),
  }))
  frameObserve.effect("approves an unobserved child frame site and re-observes once to read its content", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "frame-observe", name: "browser",
          input: { operation: "observe", mode: "profile", tabID: profileTab.id, generation: 1 } } })
      expect(JSON.stringify(result)).toContain("Child button")
      expect(JSON.stringify(result)).toContain('\\"revision\\":3')
      expect(requests.filter((entry) => entry.action === "browser_read" &&
        entry.resources[0] === "https://child.example.test/tempo").length).toBe(2)
    }),
  )
  it.effect("searches history after read permission and rejects history in isolated mode", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "history-search", name: "browser",
          input: { operation: "history", mode: "profile", generation: 1, query: "visited", limit: 5 } } })
      expect(JSON.stringify(result)).toContain("https://example.test/visited")
      expect(sequence).toEqual(["permission:browser_read:history", "history:history-search"])
      const isolated = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "history-isolated", name: "browser",
          input: { operation: "history", mode: "isolated", instanceID: isolatedInstanceID, generation: 1, query: "x" } } })
      expect(isolated).toMatchObject({ type: "error" })
      expect(sequence).not.toContain("history:history-isolated")
    }),
  )
  it.effect("treats clipboard write and upload as interact mutations and clipboard read and logs as reads", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const [id, action, mutating] of [
        ["clip-write", { type: "clipboard_write", text: "synthetic" }, true],
        ["upload-file", { type: "upload", ref: "b1", paths: ["/tmp/fixture.txt"] }, true],
        ["webmcp-call", { type: "webmcp_invoke", name: "lookup" }, true],
        ["clip-read", { type: "clipboard_read" }, false],
        ["read-logs", { type: "logs" }, false],
        ["wait-download", { type: "download", timeoutMs: 100 }, false],
        ["export-page", { type: "export" }, false],
        ["webmcp-list", { type: "webmcp_list" }, false],
      ] as const) {
        sequence.length = 0
        yield* executeTool(registry, { sessionID, ...toolIdentity,
          call: { type: "tool-call", id, name: "browser",
            input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
              documentGeneration: 1, observationRevision: 1, action } } })
        expect(sequence, id).toContain(
          mutating
            ? "permission:browser_interact:https://example.test/form"
            : "permission:browser_read:https://example.test/form",
        )
        expect(sequence.some((entry) => entry.startsWith("guardrail:")), id).toBe(mutating)
        expect(sequence, id).toContain(`action:${id}`)
      }
    }),
  )
  it.effect("requires group control, both sites, and hard mutation review before profile grouping", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "profile-group", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1,
            action: { type: "group", tabIDs: [profileTab.id, anotherProfileTab.id], title: "Task" } } } })
      expect(requests.some((entry) => entry.action === "browser_control" && entry.resources[0] === "group")).toBe(true)
      expect(requests.find((entry) => entry.action === "browser_read" && entry.resources.length === 2)?.resources)
        .toEqual(["https://example.test/form", "https://other.test/page"])
      expect(sequence).toContain("guardrail:browser_profile_mutation:https://example.test/form")
      expect(sequence).toContain("action:profile-group")
    }),
  )
  const profileSiteDenied = browserTests(Layer.mock(Permission.Service, {
    assert: (input) => input.resources.some((resource) => resource.startsWith("https://other.test"))
      ? Effect.fail(new Permission.CorrectedError({ feedback: "Profile site denied" }))
      : Effect.sync(() => sequence.push(`permission:${input.action}:${input.resources[0]}`)),
  }))
  profileSiteDenied.effect("does not group when one granted member site is denied", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "denied-profile-group", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1,
            action: { type: "group", tabIDs: [profileTab.id, anotherProfileTab.id], title: "Task" } } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).not.toContain("action:denied-profile-group")
    }),
  )
  const heldTab: Browser.Tab = { ...profileTab, id: Browser.TabID.make("btab_profile_held"), lease: "other" }
  const leased = browserTests(permission, guardrail, Layer.mock(Browser.Service, {
    list: () => Effect.succeed([{ ...profileTab, lease: "self" as const }, heldTab]),
    observe: () => Effect.sync(() => {
      sequence.push("observe")
      return { tabID: profileTab.id, generation: 1, documentGeneration: 1, revision: 1, title: "Fixture",
        page: profileTab.page, elements: [], truncated: false }
    }),
    action: (input) => Effect.sync(() => {
      sequence.push(`action:${input.callID}`)
      return { callID: input.callID, tab: profileTab, status: "completed" as const }
    }),
    release: (input) => Effect.sync(() => { sequence.push(`release:${input.callID}:${input.tabID}:${input.generation}`) }),
  }))
  leased.effect("lists a tab held by another Session with its lease and does not fail the listing", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const listing = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "leased-list", name: "browser", input: { operation: "tabs" } } })
      expect(JSON.stringify(listing)).toContain('\\"lease\\":\\"other\\"')
      expect(JSON.stringify(listing)).toContain('\\"lease\\":\\"self\\"')
    }),
  )
  leased.effect("fails observe, action, and group on another Session's tab before permission or dispatch", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      const attempts = [
        { operation: "observe", tabID: heldTab.id, generation: 1 },
        { operation: "action", tabID: heldTab.id, generation: 1, documentGeneration: 1, observationRevision: 1,
          action: { type: "scroll", deltaY: 10 } },
        { operation: "action", tabID: profileTab.id, generation: 1, documentGeneration: 1, observationRevision: 1,
          action: { type: "group", tabIDs: [profileTab.id, heldTab.id], title: "Task" } },
      ]
      for (const [index, input] of attempts.entries()) {
        const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
          call: { type: "tool-call", id: `leased-${index}`, name: "browser", input } })
        expect(result).toMatchObject({ type: "error" })
        expect(JSON.stringify(result)).toContain("controlled by another Session")
      }
      expect(sequence).toEqual([])
      expect(requests).toEqual([])
    }),
  )
  leased.effect("releases the caller's profile control without a site permission or review", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "profile-release", name: "browser",
          input: { operation: "release", mode: "profile", tabID: profileTab.id, generation: 1 } } })
      expect(JSON.stringify(result)).toContain('\\"type\\":\\"released\\"')
      expect(sequence).toEqual([`release:profile-release:${profileTab.id}:1`])
      expect(requests).toEqual([])
    }),
  )
  it.effect("keeps personal profile tabs out of owned mode and rejects their actions", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const listing = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "owned-list", name: "browser", input: { operation: "tabs", mode: "owned" } } })
      expect(JSON.stringify(listing)).toContain(ownedTab.id)
      expect(JSON.stringify(listing)).not.toContain(profileTab.id)
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "personal-action", name: "browser",
          input: { operation: "action", mode: "owned", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "click", ref: "b1" } } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).not.toContain("action:personal-action")
    }),
  )
  it.effect("opens a background owned tab only after target-site permission and distinct hard-review action", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "new-owned", name: "browser",
          input: { operation: "open", mode: "owned", generation: 1, url: "https://example.test/new" } } })
      expect(sequence).toEqual([
        "permission:browser_navigate:https://example.test/new",
        "permission:browser_read:https://example.test/new",
        "guardrail:browser_owned_open:https://example.test/new",
        "open:new-owned", "release", "permission:browser_read:https://example.test/new",
      ])
    }),
  )
  denied.effect("does not open an owned tab when target-site read permission is denied", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "denied-owned", name: "browser",
          input: { operation: "open", mode: "owned", generation: 1, url: "https://example.test/new" } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).not.toContain("open:denied-owned")
    }),
  )
  const returnedPageDenied = browserTests(Layer.mock(Permission.Service, {
    assert: (input) => input.action === "browser_read" && input.resources[0] === "https://example.test/new"
      ? Effect.fail(new Permission.CorrectedError({ feedback: "Returned page denied" }))
      : Effect.sync(() => sequence.push(`permission:${input.action}:${input.resources[0]}`)),
  }))
  returnedPageDenied.effect("closes the inactive owned tab when returned page access is denied", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "returned-denied", name: "browser",
          input: { operation: "open", mode: "owned", generation: 1, url: "https://example.test/start" } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).toContain("open:returned-denied")
      expect(sequence.filter((entry) => entry.startsWith("close:"))).toEqual([
        `close:cleanup-${ownedTab.id}:${ownedTab.id}`,
      ])
      expect(JSON.stringify(result)).not.toContain("https://example.test/new")
    }),
  )
  const activeReturnedDenied = browserTests(Layer.mock(Permission.Service, {
    assert: (input) => input.action === "browser_read" && input.resources[0] === "https://example.test/new"
      ? Effect.fail(new Permission.CorrectedError({ feedback: "Returned page denied" }))
      : Effect.void,
  }), guardrail, Layer.mock(Browser.Service, {
    open: () => Effect.succeed({ ...ownedTab, page: { origin: "https://example.test", path: "/new" }, status: "paused" }),
    close: (input) => Effect.sync(() => sequence.push(`close:${input.callID}:${input.tabID}`)).pipe(
      Effect.flatMap(() => Effect.fail(new Browser.FenceError({ message: "Chrome tab is active under user control" }))),
    ),
  }))
  activeReturnedDenied.effect("reports manual reconciliation when an active owned tab cannot be cleaned up", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "returned-active", name: "browser",
          input: { operation: "open", mode: "owned", generation: 1, url: "https://example.test/start" } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence.filter((entry) => entry.startsWith("close:"))).toEqual([
        `close:cleanup-${ownedTab.id}:${ownedTab.id}`,
      ])
      expect(JSON.stringify(result)).toContain("close it manually")
      expect(JSON.stringify(result)).not.toContain("https://example.test/new")
    }),
  )
  const blocked = browserTests(permission, Layer.mock(SessionGuardrail.Service, {
    reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
    assert: () => Effect.fail(new SessionGuardrail.BlockedError({
      rootSessionID: sessionID, sessionID, action: "browser_owned_open", ruleIDs: ["test"], reason: "Human review required",
    })),
  }))
  blocked.effect("does not open an owned tab when a Session guardrail blocks it", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "blocked-owned", name: "browser",
          input: { operation: "open", mode: "owned", generation: 1, url: "https://example.test/new" } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).not.toContain("open:blocked-owned")
    }),
  )
  it.effect("closes only an owned tab after control, site read, and mutation guardrail", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "owned-close", name: "browser",
          input: { operation: "close", mode: "owned", tabID: ownedTab.id, generation: 1 } } })
      expect(result).toMatchObject({ type: "text" })
      expect(sequence).toEqual([
        "permission:browser_control:close", "permission:browser_read:https://example.test/form",
        "guardrail:browser_mutation:https://example.test/form", `close:owned-close:${ownedTab.id}`, "release",
      ])
    }),
  )
  it.effect("approves the source and static click destination before dispatch with an incidental-download warning", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call", id: "site-click", name: "browser",
          input: { operation: "action", tabID: profileTab.id, generation: 1, documentGeneration: 1,
            observationRevision: 1, action: { type: "click", ref: "b1" } },
        },
      })
      expect(sequence).toEqual([
        "permission:browser_read:https://example.test/form",
        "permission:browser_interact:https://example.test/form",
        "permission:browser_navigate:https://other.test/arrive",
        "permission:browser_read:https://other.test/arrive",
        "guardrail:browser_profile_mutation:https://example.test/form",
        "action:site-click", "release",
        "permission:browser_read:https://example.test/form",
      ])
      expect(requests.filter((request) => request.metadata?.incidentalDownloads)).toMatchObject([
        { action: "browser_interact", metadata: { mode: "profile", site: "https://example.test", incidentalDownloads: true } },
        { action: "browser_navigate", metadata: { mode: "profile", site: "https://other.test", incidentalDownloads: true } },
      ])
    }),
  )

  const destinationDenied = browserTests(Layer.mock(Permission.Service, {
    assert: (input) => input.resources[0]?.startsWith("https://other.test")
      ? Effect.fail(new Permission.CorrectedError({ feedback: "Destination site denied" }))
      : Effect.sync(() => sequence.push(`permission:${input.action}:${input.resources[0]}`)),
  }))
  destinationDenied.effect("does not dispatch cross-site click when destination approval is denied", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "denied-site-click", name: "browser",
          input: { operation: "action", tabID: profileTab.id, generation: 1, documentGeneration: 1,
            observationRevision: 1, action: { type: "click", ref: "b1" } } },
      })
      expect(result).toMatchObject({ type: "error" })
      expect(JSON.stringify(result)).not.toContain("other.test")
      expect(sequence).not.toContain("action:denied-site-click")
    }),
  )

  it.effect("authorizes source read and navigation target before navigating", () =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "navigate-approved", name: "browser",
          input: { operation: "action", tabID: profileTab.id, generation: 1, documentGeneration: 1,
            observationRevision: 1, action: { type: "navigate", url: "https://other.test/arrive" } } },
      })
      expect(sequence.slice(0, 4)).toEqual([
        "permission:browser_read:https://example.test/form",
        "permission:browser_navigate:https://other.test/arrive",
        "permission:browser_read:https://other.test/arrive",
        "guardrail:browser_profile_mutation:https://other.test/arrive",
      ])
      expect(requests.find((request) => request.action === "browser_navigate")?.metadata).toMatchObject({
        mode: "profile", incidentalDownloads: true, site: "https://other.test",
      })
    }),
  )

  it.effect("does not expose an unexpected action-result site to the model", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "unexpected-result", name: "browser",
          input: { operation: "action", tabID: profileTab.id, generation: 1, documentGeneration: 1,
            observationRevision: 1, action: { type: "type", ref: "b1", text: "hello" } } },
      })
      expect(result).toMatchObject({ type: "error" })
      expect(JSON.stringify(result)).not.toContain("unapproved.test")
      expect(sequence).toContain("action:unexpected-result")
    }),
  )

  it.effect("does not expose a changed observation site to the model", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "unexpected-observation", name: "browser",
          input: { operation: "observe", tabID: profileTab.id, generation: 1 } },
      })
      expect(result).toMatchObject({ type: "error" })
      expect(JSON.stringify(result)).not.toContain("unapproved.test")
      expect(sequence).toContain("permission:browser_read:https://example.test/form")
    }),
  )

  const changedPathDenied = browserTests(Layer.mock(Permission.Service, {
    assert: (input) => input.resources[0] === "https://example.test/changed"
      ? Effect.fail(new Permission.CorrectedError({ feedback: "Read denied" }))
      : Effect.sync(() => sequence.push(`permission:${input.action}:${input.resources[0]}`)),
  }))
  changedPathDenied.effect("checks changed same-site observation path before returning it", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "changed-path-observation", name: "browser",
          input: { operation: "observe", tabID: profileTab.id, generation: 1 } },
      })
      expect(result).toMatchObject({ type: "error" })
      expect(JSON.stringify(result)).not.toContain("/changed")
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
    }),
  )
  for (const input of [
    { operation: "status", mode: "isolated" },
    { operation: "control", mode: "isolated", action: "pause" },
  ]) {
    denied.effect(`does not expose isolated ${input.operation} metadata when read permission is denied`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: `call-denied-${input.operation}`, name: "browser", input },
        })
        expect(result).toMatchObject({ type: "error" })
        expect(JSON.stringify(result)).not.toContain("example.test")
        expect(JSON.stringify(result)).not.toContain(tabID)
      }),
    )
  }
  it.effect("enforces permission then guardrail at the leaf before a semantic mutation", () =>
    Effect.gen(function* () {
      sequence.length = 0
      guardrailRequests.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-browser-mutation",
          name: "browser",
          input: {
            operation: "action",
            tabID: profileTab.id,
            generation: 1,
            documentGeneration: 1,
            observationRevision: 1,
            action: { type: "click", ref: "b1" },
          },
        },
      })
      expect(result).toEqual({
        type: "text",
        value: JSON.stringify({
          type: "action",
          result: { callID: "call-browser-mutation", tab: profileTab, status: "completed" },
        }),
      })
      expect(sequence).toEqual([
        "permission:browser_read:https://example.test/form",
        "permission:browser_interact:https://example.test/form",
        "permission:browser_navigate:https://other.test/arrive",
        "permission:browser_read:https://other.test/arrive",
        "guardrail:browser_profile_mutation:https://example.test/form",
        "action:call-browser-mutation",
        "release",
        "permission:browser_read:https://example.test/form",
      ])
      expect(guardrailRequests).toHaveLength(1)
      expect(guardrailRequests[0].skipReview).toBe(true)
      expect(guardrailRequests[0].source).toEqual({ messageID: toolIdentity.messageID, callID: "call-browser-mutation" })
    }),
  )

  it.effect("accepts integer-valued numeric strings and a JSON-encoded action payload", () =>
    Effect.gen(function* () {
      sequence.length = 0
      guardrailRequests.length = 0
      const registry = yield* ToolRegistry.Service
      const observed = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "numeric-browser-observe",
          name: "browser",
          input: { operation: "observe", tabID: profileTab.id, generation: "1" },
        },
      })
      expect(observed).toMatchObject({ type: "text", value: expect.stringContaining('"type":"observation"') })
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "numeric-browser-action",
          name: "browser",
          input: {
            operation: "action",
            tabID: profileTab.id,
            generation: "1",
            documentGeneration: "1",
            observationRevision: "1",
            action: { type: "scroll", deltaY: "120" },
          },
        },
      })
      expect(result).toMatchObject({ type: "text", value: expect.stringContaining('"callID":"numeric-browser-action"') })
      expect(sequence).toContain("action:numeric-browser-action")

      const ungroup = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "numeric-browser-group-id",
          name: "browser",
          input: {
            operation: "action",
            tabID: profileTab.id,
            generation: "1",
            documentGeneration: "1",
            observationRevision: "1",
            action: { type: "ungroup", tabIDs: [profileTab.id], groupID: "7" },
          },
        },
      })
      expect(ungroup).toMatchObject({ type: "text", value: expect.stringContaining('"callID":"numeric-browser-group-id"') })

      const encoded = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "json-browser-action",
          name: "browser",
          input: {
            operation: "action",
            tabID: profileTab.id,
            generation: "1",
            documentGeneration: "1",
            observationRevision: "1",
            action: JSON.stringify({ type: "scroll", deltaY: "120" }),
          },
        },
      })
      expect(encoded).toMatchObject({ type: "text", value: expect.stringContaining('"callID":"json-browser-action"') })
      expect(sequence).toContain("action:json-browser-action")

      const opened = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "numeric-browser-open",
          name: "browser",
          input: { operation: "open", mode: "owned", generation: "1", url: "https://example.test/new" },
        },
      })
      expect(opened).toMatchObject({ type: "text", value: expect.stringContaining('"type":"opened"') })

      const closed = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "numeric-browser-close",
          name: "browser",
          input: { operation: "close", mode: "owned", tabID: ownedTab.id, generation: "1" },
        },
      })
      expect(closed).toMatchObject({ type: "text", value: expect.stringContaining('"type":"closed"') })
      expect(guardrailRequests.every((input) => input.skipReview === true)).toBe(true)
    }),
  )

  it.effect("reports unavailable bridge status without fabricating a browser action", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-browser-status", name: "browser", input: { operation: "status" } },
        }),
      ).toEqual({
        type: "text",
        value: JSON.stringify({ type: "status", status: { state: "unavailable" } }),
      })
      expect(sequence).toEqual([])
    }),
  )

  it.effect("authorizes profile-tab metadata before exposing it to the model", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-browser-tabs", name: "browser", input: { operation: "tabs" } },
        }),
      ).toEqual({ type: "text", value: JSON.stringify({ type: "tabs", tabs: [profileTab, anotherProfileTab] }) })
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
    }),
  )

  it.effect("authorizes isolated status page metadata before exposing it to the model", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-isolated-status",
            name: "browser",
            input: { operation: "status", mode: "isolated" },
          },
        }),
      ).toEqual({
        type: "text",
        value: JSON.stringify({
          type: "status",
          status: { mode: "isolated", state: "ready", instanceID: isolatedInstanceID, tab },
        }),
      })
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
    }),
  )

  it.effect("authorizes page metadata returned by isolated control independently of control permission", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-isolated-control",
          name: "browser",
          input: { operation: "control", mode: "isolated", action: "pause" },
        },
      })
      expect(result).toEqual({
        type: "text",
        value: JSON.stringify({
          type: "status",
          status: { mode: "isolated", state: "paused", instanceID: isolatedInstanceID, tab },
        }),
      })
      expect(sequence).toEqual([
        "permission:browser_control:pause",
        "permission:browser_read:https://example.test/form",
      ])
    }),
  )

  it.effect(
    "routes explicit isolated mode with its mandatory instance fence through the same permission and guardrail order",
    () =>
      Effect.gen(function* () {
        sequence.length = 0
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-isolated-mutation",
            name: "browser",
            input: {
              operation: "action",
              mode: "isolated",
              instanceID: isolatedInstanceID,
              tabID,
              generation: 1,
              documentGeneration: 1,
              observationRevision: 1,
              action: { type: "click", ref: "b1" },
            },
          },
        })
        expect(result).toEqual({
          type: "text",
          value: JSON.stringify({
            type: "action",
            result: {
              mode: "isolated",
              instanceID: isolatedInstanceID,
              callID: "call-isolated-mutation",
              tab,
              status: "completed",
            },
          }),
        })
        expect(sequence).toEqual([
          "permission:browser_interact:https://example.test/form",
          "guardrail:browser_mutation:https://example.test/form",
          `isolated-action:call-isolated-mutation:${isolatedInstanceID}`,
          "release",
        ])
      }),
  )

  const departedID = Browser.TabID.make("btab_departed_tool")
  const successorID = Browser.TabID.make("btab_successor_tool")
  const unknownID = Browser.TabID.make("btab_unknown_tool")
  const noSuccessorID = Browser.TabID.make("btab_departed_plain")
  const leasedID = Browser.TabID.make("btab_leased_state")
  const heldProfileTab: Browser.Tab = { ...profileTab, id: leasedID, lease: "other" }
  const states = browserTests(permission, guardrail, Layer.mock(Browser.Service, {
    actionIdentity: () => Effect.succeed({ digest: "a".repeat(64), reusable: true }),
    list: () => Effect.succeed([ownedTab, profileTab, heldProfileTab]),
    tabState: (_session, id) => Effect.succeed(
      id === ownedTab.id ? { state: "present" as const, mode: "owned" as const }
      : id === profileTab.id || id === leasedID ? { state: "present" as const, mode: "profile" as const }
      : id === departedID ? { state: "departed" as const, mode: "profile" as const, reason: "navigated" as const, successorID }
      : id === noSuccessorID ? { state: "departed" as const, mode: "profile" as const, reason: "detached" as const, detachReason: "canceled_by_user" }
      : { state: "unknown" as const }),
    release: (input) => Effect.sync(() => { sequence.push(`release:${input.callID}`) }),
    observe: () => Effect.succeed({ tabID: profileTab.id, generation: 1, documentGeneration: 1, revision: 1,
      title: "Fixture", page: profileTab.page, elements: [], truncated: false }),
  }))
  const failureMessage = (id: string, input: object) =>
    Effect.gen(function* () {
      sequence.length = 0
      requests.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id, name: "browser", input } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).toEqual([])
      expect(requests).toEqual([])
      return JSON.stringify(result)
    })
  const act = (tabID: string, mode?: string) => ({ operation: "action", tabID, generation: 1, documentGeneration: 1,
    observationRevision: 1, action: { type: "click", ref: "b1" }, ...(mode ? { mode } : {}) })
  states.effect("names the owned mode when an owned tab is addressed without a mode", () =>
    Effect.gen(function* () {
      for (const [id, input] of [
        ["state-owned-observe", { operation: "observe", tabID: ownedTab.id, generation: 1 }],
        ["state-owned-action", act(ownedTab.id)],
      ] as const) {
        const message = yield* failureMessage(id, input)
        expect(message, id).toContain(`${ownedTab.id} is an owned tab`)
        expect(message, id).toContain('mode:\\"owned\\"')
        expect(message, id).not.toContain("not available in this mode")
      }
    }),
  )
  states.effect("names the profile mode when a paired profile tab is addressed with owned mode", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("state-profile-owned", act(profileTab.id, "owned"))
      expect(message).toContain(`${profileTab.id} is a profile tab`)
      expect(message).toContain('mode:\\"profile\\"')
    }),
  )
  states.effect("reports a departed tab's reason and the listed successor without exposing page data", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("state-departed", { operation: "observe", tabID: departedID, generation: 1 })
      expect(message).toContain("navigated outside the approved sites")
      expect(message).toContain(`The same Chrome tab is now listed as ${successorID}; observe it before acting`)
      expect(message).not.toContain("example.test")
    }),
  )
  states.effect("reports a detached tab with Chrome's detach reason and no successor", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("state-detached", act(noSuccessorID))
      expect(message).toContain("Chrome detached the debugger (canceled_by_user)")
      expect(message).not.toContain("now listed as")
    }),
  )
  states.effect("tells the model to list tabs again for an ID the connection does not list", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("state-unknown", { operation: "observe", tabID: unknownID, generation: 1 })
      expect(message).toContain(`${unknownID} is not listed by the current browser connection; list tabs again`)
    }),
  )
  states.effect("applies the same diagnosis to release", () =>
    Effect.gen(function* () {
      expect(yield* failureMessage("state-release-owned",
        { operation: "release", mode: "profile", tabID: ownedTab.id, generation: 1 })).toContain("is an owned tab")
      expect(yield* failureMessage("state-release-departed",
        { operation: "release", mode: "profile", tabID: departedID, generation: 1 })).toContain(`now listed as ${successorID}`)
      expect(yield* failureMessage("state-release-unknown",
        { operation: "release", mode: "profile", tabID: unknownID, generation: 1 })).toContain("list tabs again")
    }),
  )
  states.effect("keeps the lease failure ahead of any permission for a tab another Session holds", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("state-leased", { operation: "observe", tabID: leasedID, generation: 1 })
      expect(message).toContain("controlled by another Session")
    }),
  )
  states.effect("still asserts read permission before observing a listed profile tab", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "state-listed", name: "browser",
          input: { operation: "observe", tabID: profileTab.id, generation: 1 } } })
      expect(result).not.toMatchObject({ type: "error" })
      expect(sequence[0]).toBe("permission:browser_read:https://example.test/form")
    }),
  )
  const crossMode = browserTests(permission, guardrail, Layer.mock(Browser.Service, {
    list: () => Effect.succeed([]),
    tabState: (_session, id) => Effect.succeed(id === profileTab.id
      ? { state: "present" as const, mode: "profile" as const } : { state: "unknown" as const }),
  }))
  crossMode.effect("names the paired mode for a paired tab addressed in isolated mode", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("cross-isolated-paired",
        { operation: "observe", mode: "isolated", instanceID: isolatedInstanceID, tabID: profileTab.id, generation: 1 })
      expect(message).toContain(`${profileTab.id} is a profile tab`)
      expect(message).toContain('mode:\\"profile\\"')
    }),
  )
  crossMode.effect("names the isolated mode for an isolated tab addressed in a paired mode", () =>
    Effect.gen(function* () {
      for (const mode of [undefined, "owned"]) {
        const message = yield* failureMessage(`cross-paired-isolated-${mode ?? "default"}`,
          act(tab.id, mode))
        expect(message).toContain(`${tab.id} is an isolated tab`)
        expect(message).toContain('mode:\\"isolated\\"')
      }
    }),
  )

  const description = Effect.gen(function* () {
    const captured: string[] = []
    yield* BrowserTool.Plugin.effect(host({
      tool: {
        transform: (callback) => Effect.sync(() => {
          callback({ add: (_name, tool) => { captured.push(tool.description) } })
          return { dispose: Effect.void }
        }),
        hook: () => Effect.die("unused tool.hook"),
      },
    })).pipe(Effect.provide(Layer.mergeAll(browser, isolatedBrowser, permission, guardrail)))
    return captured[0] ?? ""
  })
  it.effect("scopes the computer-versus-browser routing to those two tools and keeps its safety sentences", () =>
    Effect.gen(function* () {
      const text = yield* description
      expect(text).toContain("Prefer this tool over computer for anything inside a web page.")
      expect(text).toContain("This choice is between the computer and browser tools only; it does not forbid another browser route the user explicitly authorizes, such as Playwright connectOverCDP to an existing Chrome DevTools endpoint, which stays subject to the same permission, guardrail, credential and confirmation rules.")
      expect(text).not.toMatch(/\d{4,5}/)
      for (const sentence of [
        "Ask the user before irreversible submissions, purchases, payments, deletions, sending messages, or accepting legal terms; proceed without asking for reading, navigation, and reversible input that does not submit anything.",
        "Never solve CAPTCHAs, enter passwords, one-time codes, or payment secrets: stop and hand the page to the user.",
        "never replay an uncertain mutation\u2014observe first.",
      ]) expect(text).toContain(sentence)
    }),
  )
  it.effect("describes the new actions, sensitive fields, and wait conditions and keeps the hand-off and confirmation sentences", () =>
    Effect.gen(function* () {
      const text = yield* description
      for (const sentence of [
        "click, type, fill forms, select options, check boxes, hover, navigate",
        "wait for elements, URLs, load states, or text",
        "click, type, fill, select, check, hover, upload, and wait accept that locator instead of a ref when the same element must be found again after re-observing; wait also accepts a locator for an element that has not appeared yet.",
        "Fill replaces a field's text (text:'' clears it); select picks options of a native select by values, labels, or indexes, or one option of an open listbox by label or index; check sets a checkbox, radio, or switch to checked:true or checked:false and does nothing when it already matches; hover moves the pointer over an element without clicking. These return the control's resulting state.",
        "Elements report checked, pressed, expanded, selected, and the value of ordinary fields; sensitive:true marks a password, one-time-code, or payment field whose value is withheld and which no action may fill.",
        "Wait takes one condition: a ref or locator with state attached, visible, hidden, or detached (default visible for a locator, attached for a ref); url, a pattern over the page origin and path where * matches any characters; load: domcontentloaded, load, or networkidle (no network request pending for 500 ms; on a paired tab attached while requests were already running, only requests started after attach are seen); or text that must appear on the page.",
        "timeoutMs is at most 30,000; wait without a condition waits for load.",
        "key checks the active focus in profile, owned, and isolated modes.",
        "Only Tab, Shift+Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, and PageDown bypass active-focus inspection, with no Ctrl, Meta, or Alt and Shift allowed only for Tab.",
        "Every other supported key requires verified focus, including printable characters with Shift or Alt, Space, Enter, Backspace, Delete, Insert, Shift+Insert, and all Ctrl or Meta chords, including V and X.",
        "Focus inspection refuses sensitive password, one-time-code, payment, or secret-named fields, file inputs, and unverified focus (including closed shadow roots and unreachable cross-origin frames) before any key event with dispatched:false.",
        "Do not use key to bypass a sensitive-field refusal in any mode.",
        "Never solve CAPTCHAs, enter passwords, one-time codes, or payment secrets: stop and hand the page to the user.",
        "Ask the user before irreversible submissions, purchases, payments, deletions, sending messages, or accepting legal terms; proceed without asking for reading, navigation, and reversible input that does not submit anything.",
      ]) expect(text).toContain(sentence)
      expect(text.indexOf("Capture only when semantic observation is insufficient")).toBeLessThan(text.indexOf("Fill replaces a field's text"))
      expect(text).not.toContain("click, type, and upload accept that locator")
      expect(text).not.toContain("Keyboard safety coverage differs by mode.")
    }),
  )

  const formActions = [
    ["fill", { type: "fill", ref: "b1", text: "synthetic" }],
    ["select", { type: "select", ref: "b1", labels: ["Small"] }],
    ["check", { type: "check", ref: "b1", checked: true }],
    ["hover", { type: "hover", ref: "b1" }],
  ] as const
  const waitActions = [
    { type: "wait", locator: 'role=heading[name="Saved"]', state: "visible" },
    { type: "wait", ref: "b1", state: "detached" },
    { type: "wait", url: "https://example.test/*" },
    { type: "wait", load: "networkidle" },
    { type: "wait", text: "Saved" },
  ] as const
  it.effect("treats fill, select, check, and hover as interact mutations with the mode guardrail and every wait condition as a read without guardrail", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const targets = [
        ["profile", profileTab.id, "browser_profile_mutation", {}],
        ["owned", ownedTab.id, "browser_mutation", {}],
        ["isolated", tab.id, "browser_mutation", { instanceID: isolatedInstanceID }],
      ] as const
      for (const [mode, target, guardrailAction, extra] of targets) {
        for (const [name, action] of formActions) {
          const id = `form-${mode}-${name}`
          sequence.length = 0
          requests.length = 0
          yield* executeTool(registry, { sessionID, ...toolIdentity,
            call: { type: "tool-call", id, name: "browser",
              input: { operation: "action", mode, tabID: target, generation: 1, documentGeneration: 1,
                observationRevision: 1, ...extra, action } } })
          expect(sequence, id).toContain("permission:browser_interact:https://example.test/form")
          expect(sequence, id).toContain(`guardrail:${guardrailAction}:https://example.test/form`)
          expect(sequence.some((entry) => entry.endsWith(id) || entry.includes(`:${id}:`)), id).toBe(true)
          const interact = requests.find((entry) => entry.action === "browser_interact")
          expect(interact?.metadata, id).toMatchObject(mode === "isolated"
            ? { operation: name }
            : { operation: name, mode, incidentalDownloads: true, site: "https://example.test" })
          if (mode === "isolated") expect(interact?.metadata, id).not.toHaveProperty("incidentalDownloads")
          expect(JSON.stringify(requests), id).not.toContain("synthetic")
          expect(JSON.stringify(guardrailRequests.at(-1)), id).not.toContain("synthetic")
        }
        for (const action of waitActions) {
          const id = `wait-${mode}-${Object.keys(action).join("-")}`
          sequence.length = 0
          requests.length = 0
          yield* executeTool(registry, { sessionID, ...toolIdentity,
            call: { type: "tool-call", id, name: "browser",
              input: { operation: "action", mode, tabID: target, generation: 1, documentGeneration: 1,
                observationRevision: 1, ...extra, action } } })
          expect(sequence, id).toContain("permission:browser_read:https://example.test/form")
          expect(sequence.some((entry) => entry.startsWith("permission:browser_interact")), id).toBe(false)
          expect(sequence.some((entry) => entry.startsWith("guardrail:")), id).toBe(false)
          expect(sequence.some((entry) => entry.endsWith(id) || entry.includes(`:${id}:`)), id).toBe(true)
        }
      }
    }),
  )
  it.effect("asserts frame-site read and interact before a framed fill, select, check, or hover", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const [name, action] of formActions) {
        const id = `framed-${name}`
        sequence.length = 0
        yield* executeTool(registry, { sessionID, ...toolIdentity,
          call: { type: "tool-call", id, name: "browser",
            input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
              documentGeneration: 1, observationRevision: 1, action: { ...action, ref: "b7" } } } })
        expect(sequence, id).toContain("permission:browser_read:https://child.example.test/tempo")
        expect(sequence, id).toContain("permission:browser_interact:https://child.example.test/tempo")
        expect(sequence.indexOf("permission:browser_interact:https://child.example.test/tempo"), id)
          .toBeLessThan(sequence.indexOf(`action:${id}`))
      }
    }),
  )

  const dispatched: Array<Browser.Schema.Action> = []
  const childFrame = { origin: "https://child.example.test", path: "/widget" }
  const frameBrowser = Layer.mock(Browser.Service, {
    actionIdentity: () => Effect.succeed({ digest: "a".repeat(64), reusable: true }),
    list: () => Effect.succeed([profileTab]),
    elementFrame: () => Effect.succeed(undefined),
    action: (input) => Effect.sync(() => {
      dispatched.push(input.action)
      sequence.push(`action:${input.callID}`)
      return { callID: input.callID, tab: profileTab, status: "completed" as const,
        ...(input.action.type === "wait" && input.action.text === "In frame" ? { frame: childFrame } : {}),
        ...(input.action.type === "wait" && input.action.text === "Same site" ? { frame: { origin: profileTab.page.origin, path: "/inner" } } : {}) }
    }),
  })
  const waitFrame = browserTests(permission, guardrail, frameBrowser)
  waitFrame.effect("asserts read permission for a wait's child-frame match before returning it", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "wait-child-frame", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "wait", text: "In frame" } } } })
      expect(JSON.stringify(result)).toContain("child.example.test")
      expect(sequence.indexOf("permission:browser_read:https://child.example.test/widget"))
        .toBeGreaterThan(sequence.indexOf("action:wait-child-frame"))
      sequence.length = 0
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "wait-same-frame", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "wait", text: "Same site" } } } })
      expect(sequence.filter((entry) => entry.startsWith("permission:browser_read:https://example.test/inner"))).toEqual([])
    }),
  )
  const frameDenied = browserTests(Layer.mock(Permission.Service, {
    assert: (input) => input.resources.some((resource) => resource.startsWith("https://child.example.test"))
      ? Effect.fail(new Permission.CorrectedError({ feedback: "Frame site denied" }))
      : Effect.sync(() => sequence.push(`permission:${input.action}:${input.resources[0]}`)),
  }), guardrail, frameBrowser)
  frameDenied.effect("fails without returning the wait result when the matched frame site is denied", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "wait-frame-denied", name: "browser",
          input: { operation: "action", mode: "profile", tabID: profileTab.id, generation: 1,
            documentGeneration: 1, observationRevision: 1, action: { type: "wait", text: "In frame" } } } })
      expect(result).toMatchObject({ type: "error" })
      expect(sequence).toContain("action:wait-frame-denied")
      expect(JSON.stringify(result)).not.toContain("completed")
      expect(JSON.stringify(result)).not.toContain("/widget")
    }),
  )
  waitFrame.effect("accepts numeric-string option indexes and wait timeouts and rejects combined wait conditions", () =>
    Effect.gen(function* () {
      dispatched.length = 0
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const base = { operation: "action", mode: "profile", tabID: profileTab.id, generation: "1",
        documentGeneration: "1", observationRevision: "1" }
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "string-indexes", name: "browser",
          input: { ...base, action: { type: "select", ref: "b1", indexes: ["2", 0] } } } })
      yield* executeTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "string-timeout", name: "browser",
          input: { ...base, action: JSON.stringify({ type: "wait", load: "load", timeoutMs: "1500" }) } } })
      expect(dispatched).toEqual([
        { type: "select", ref: "b1", indexes: [2, 0] },
        { type: "wait", load: "load", timeoutMs: 1500 },
      ])
      for (const [id, action] of [
        ["combined-wait", { type: "wait", text: "Saved", url: "https://example.test/*" }],
        ["state-only-wait", { type: "wait", state: "visible" }],
        ["combined-select", { type: "select", ref: "b1", values: ["a"], indexes: ["1"] }],
        ["oversized-timeout", { type: "wait", text: "Saved", timeoutMs: "30001" }],
      ] as const) {
        const result = yield* executeTool(registry, { sessionID, ...toolIdentity,
          call: { type: "tool-call", id, name: "browser", input: { ...base, action } } })
        expect(result, id).toMatchObject({ type: "error" })
        expect(sequence, id).not.toContain(`action:${id}`)
      }
    }),
  )
})
