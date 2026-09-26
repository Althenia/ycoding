import { describe, expect } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { Image } from "@ycoding-ai/core/image"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { BrowserTool } from "@ycoding-ai/core/tool/browser"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Effect, Layer } from "effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_browser_tool")
const tabID = Browser.TabID.make("btab_browser_tool")
const sequence: string[] = []
const requests: PermissionV2.AssertInput[] = []
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
  status: () => Effect.succeed({ state: "unavailable" }),
  list: () => Effect.succeed([tab, ownedTab, profileTab, anotherProfileTab]),
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
const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) => Effect.sync(() => {
    requests.push(input)
    sequence.push(`permission:${input.action}:${input.resources[0]}`)
  }),
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
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
  deps: [ToolRegistry.toolsNode, Browser.node, IsolatedBrowser.node, PermissionV2.node, SessionGuardrail.node],
})
const browserTests = (permissionLayer: typeof permission, guardrailLayer: typeof guardrail = guardrail,
  browserLayer: typeof browser = browser) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, browserToolNode]), [
      [Browser.node, browserLayer],
      [IsolatedBrowser.node, isolatedBrowser],
      [PermissionV2.node, permissionLayer],
      [SessionGuardrail.node, guardrailLayer],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ]),
  )
const it = browserTests(permission)
const denied = browserTests(
  Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      input.action === "browser_read"
        ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Browser metadata access denied" }))
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
  const profileSiteDenied = browserTests(Layer.mock(PermissionV2.Service, {
    assert: (input) => input.resources.some((resource) => resource.startsWith("https://other.test"))
      ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Profile site denied" }))
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
  const returnedPageDenied = browserTests(Layer.mock(PermissionV2.Service, {
    assert: (input) => input.action === "browser_read" && input.resources[0] === "https://example.test/new"
      ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Returned page denied" }))
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
  const activeReturnedDenied = browserTests(Layer.mock(PermissionV2.Service, {
    assert: (input) => input.action === "browser_read" && input.resources[0] === "https://example.test/new"
      ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Returned page denied" }))
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

  const destinationDenied = browserTests(Layer.mock(PermissionV2.Service, {
    assert: (input) => input.resources[0]?.startsWith("https://other.test")
      ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Destination site denied" }))
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

  const changedPathDenied = browserTests(Layer.mock(PermissionV2.Service, {
    assert: (input) => input.resources[0] === "https://example.test/changed"
      ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Read denied" }))
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
})
