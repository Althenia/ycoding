import { describe, expect } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { BrowserAdmission } from "@ycoding-ai/core/browser/admission"
import { IsolatedBrowserExecutor } from "@ycoding-ai/core/browser/isolated-executor"
import { Database } from "@ycoding-ai/core/database/database"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Image } from "@ycoding-ai/core/image"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { Location } from "@ycoding-ai/core/location"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { BrowserTool } from "@ycoding-ai/core/tool/browser"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { tempLocationLayer } from "../test/fixture/location"
import { testEffect } from "../test/lib/effect"
import { imagePassthrough } from "../test/lib/image"
import { registerToolPlugin, settleTool, toolIdentity } from "../test/lib/tool"

const sessionID = SessionV2.ID.make("ses_browser_integration")
const privateMarkers = [
  "private-query-marker-7b31",
  "private-fragment-marker-2a46",
  "private-input-marker-3d92",
  "private-dom-marker-8f14",
] as const
const permissionChecks: Array<{ readonly action: string; readonly resource: string }> = []
const guardrailChecks: Array<{ readonly action: string; readonly resource: string }> = []

const selectedBrowserFixture = Layer.mock(Browser.Service, {
  status: () => Effect.succeed({ state: "unavailable" }),
  list: () => Effect.succeed([]),
})
const recordingPermissionFixture = Layer.mock(PermissionV2.Service, {
  assert: (input) =>
    Effect.sync(() => {
      permissionChecks.push({ action: input.action, resource: input.resources[0] ?? "" })
    }),
})
const recordingGuardrailFixture = Layer.mock(SessionGuardrail.Service, {
  assert: (input) =>
    Effect.sync(() => {
      guardrailChecks.push({ action: input.action, resource: input.resources[0] ?? "" })
      return { release: Effect.void }
    }),
})
const browserToolNode = makeLocationNode({
  name: "test/browser-tool-real-isolated-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(BrowserTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Browser.node, IsolatedBrowser.node, PermissionV2.node, SessionGuardrail.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      SessionStore.node,
      Location.node,
      BrowserAdmission.node,
      IsolatedBrowserExecutor.node,
      IsolatedBrowser.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      browserToolNode,
    ]),
    [
      [Location.node, tempLocationLayer],
      [Browser.node, selectedBrowserFixture],
      [PermissionV2.node, recordingPermissionFixture],
      [SessionGuardrail.node, recordingGuardrailFixture],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)

const StatusOutput = Schema.Struct({ type: Schema.Literal("status"), status: IsolatedBrowser.Schema.Status })
const ObservationOutput = Schema.Struct({
  type: Schema.Literal("observation"),
  observation: IsolatedBrowser.Schema.Observation,
})
const ActionOutput = Schema.Struct({ type: Schema.Literal("action"), result: IsolatedBrowser.Schema.ActionResult })
const decodeStatus = Schema.decodeUnknownSync(StatusOutput)
const decodeObservation = Schema.decodeUnknownSync(ObservationOutput)
const decodeAction = Schema.decodeUnknownSync(ActionOutput)

describe("BrowserTool real isolated Chrome integration", () => {
  it.live(
    "settles semantic operations through the real isolated browser service and installed Chrome",
    () =>
      Effect.gen(function* () {
        permissionChecks.length = 0
        guardrailChecks.length = 0
        const submissions: string[] = []
        const fixture = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            const url = new URL(request.url)
            if (url.pathname === "/submitted") {
              submissions.push(url.searchParams.get("value") ?? "")
              return new Response("recorded")
            }
            if (url.pathname === "/done")
              return new Response("<!doctype html><title>Done fixture</title><h1>Done</h1>", {
                headers: { "content-type": "text/html" },
              })
            return new Response(browserFixture(), { headers: { "content-type": "text/html" } })
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => fixture.stop(true)))
        const origin = `http://127.0.0.1:${fixture.port}`
        const location = yield* Location.Service
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            directory: location.directory,
            title: "Real isolated browser integration",
          })
          .run()
          .pipe(Effect.orDie)

        const isolated = yield* IsolatedBrowser.Service
        const registry = yield* ToolRegistry.Service
        const started = yield* isolated.start(sessionID, {
          url: `${origin}/fixture?private=${privateMarkers[0]}#${privateMarkers[1]}`,
        })
        expect(started).toMatchObject({ mode: "isolated", state: "ready", tab: { sessionID } })
        if (!started.instanceID || !started.tab) throw new Error("Isolated Chrome did not return its ownership fences")

        const status = decodeStatus(
          (yield* settleBrowser(registry, call("status", { operation: "status", mode: "isolated" }))).output
            ?.structured,
        )
        expect(status.status).toMatchObject({
          mode: "isolated",
          state: "ready",
          instanceID: started.instanceID,
          tab: { id: started.tab.id, page: { origin, path: "/fixture" } },
        })

        const initial = yield* observe(registry, started.instanceID, started.tab, "initial")
        const textbox = requireElement(initial, "Message")
        const typed = decodeAction(
          (yield* settleBrowser(
            registry,
            call("type", {
              operation: "action",
              mode: "isolated",
              instanceID: started.instanceID,
              tabID: initial.tabID,
              generation: initial.generation,
              documentGeneration: initial.documentGeneration,
              observationRevision: initial.revision,
              action: { type: "type", ref: textbox.ref, text: "synthetic-value" },
            }),
          )).output?.structured,
        )
        expect(typed.result.status).toBe("completed")

        const afterType = yield* observe(registry, started.instanceID, typed.result.tab, "after-type")
        const submit = requireElement(afterType, "Submit")
        const clicked = decodeAction(
          (yield* settleBrowser(
            registry,
            call("click", {
              operation: "action",
              mode: "isolated",
              instanceID: started.instanceID,
              tabID: afterType.tabID,
              generation: afterType.generation,
              documentGeneration: afterType.documentGeneration,
              observationRevision: afterType.revision,
              action: { type: "click", ref: submit.ref },
            }),
          )).output?.structured,
        )
        expect(clicked.result.status).toBe("completed")
        yield* Effect.promise(() => waitFor(() => submissions.length === 1, "synthetic form submission"))
        expect(submissions).toEqual(["synthetic-value"])

        const afterClick = yield* observe(registry, started.instanceID, clicked.result.tab, "after-click")
        const scrolled = decodeAction(
          (yield* settleBrowser(
            registry,
            call("scroll", {
              operation: "action",
              mode: "isolated",
              instanceID: started.instanceID,
              tabID: afterClick.tabID,
              generation: afterClick.generation,
              documentGeneration: afterClick.documentGeneration,
              observationRevision: afterClick.revision,
              action: { type: "scroll", deltaY: 600 },
            }),
          )).output?.structured,
        )
        expect(scrolled.result.status).toBe("completed")

        const afterScroll = yield* observe(registry, started.instanceID, scrolled.result.tab, "after-scroll")
        const captureSettlement = yield* settleBrowser(
          registry,
          call("capture", {
            operation: "action",
            mode: "isolated",
            instanceID: started.instanceID,
            tabID: afterScroll.tabID,
            generation: afterScroll.generation,
            documentGeneration: afterScroll.documentGeneration,
            observationRevision: afterScroll.revision,
            action: { type: "capture" },
          }),
        )
        const captured = decodeAction(captureSettlement.output?.structured)
        expect(captured.result).toMatchObject({ status: "completed", capture: { mediaType: "image/png" } })
        expect(captured.result.capture?.bytes).toBeGreaterThan(0)
        expect(
          captureSettlement.output?.content.some(
            (item) =>
              item.type === "file" && item.mime === "image/png" && item.uri.startsWith("data:image/png;base64,"),
          ),
        ).toBe(true)

        const afterCapture = yield* observe(registry, started.instanceID, captured.result.tab, "after-capture")
        const navigated = decodeAction(
          (yield* settleBrowser(
            registry,
            call("navigate", {
              operation: "action",
              mode: "isolated",
              instanceID: started.instanceID,
              tabID: afterCapture.tabID,
              generation: afterCapture.generation,
              documentGeneration: afterCapture.documentGeneration,
              observationRevision: afterCapture.revision,
              action: { type: "navigate", url: `${origin}/done` },
            }),
          )).output?.structured,
        )
        expect(navigated.result).toMatchObject({ status: "completed", tab: { page: { origin, path: "/done" } } })
        const done = yield* observe(registry, started.instanceID, navigated.result.tab, "done")
        expect(done).toMatchObject({ title: "Done fixture", page: { origin, path: "/done" } })

        expect(permissionChecks.map((check) => check.action)).toEqual([
          "browser_read",
          "browser_read",
          "browser_interact",
          "browser_read",
          "browser_interact",
          "browser_read",
          "browser_read",
          "browser_read",
          "browser_read",
          "browser_read",
          "browser_navigate",
          "browser_read",
        ])
        expect(permissionChecks.every((check) => check.resource.startsWith(origin))).toBe(true)
        expect(guardrailChecks).toEqual([
          { action: "browser_mutation", resource: `${origin}/fixture` },
          { action: "browser_mutation", resource: `${origin}/fixture` },
          { action: "browser_mutation", resource: `${origin}/done` },
        ])
      }),
    60_000,
  )
})

function call(id: string, input: typeof BrowserTool.Input.Type) {
  return {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id: `call-browser-integration-${id}`, name: "browser", input },
  }
}

function observe(
  registry: ToolRegistry.Interface,
  instanceID: IsolatedBrowser.ActionResult["instanceID"],
  tab: Browser.Tab,
  id: string,
) {
  return settleBrowser(
    registry,
    call(`observe-${id}`, {
      operation: "observe",
      mode: "isolated",
      instanceID,
      tabID: tab.id,
      generation: tab.generation,
    }),
  ).pipe(Effect.map((settlement) => decodeObservation(settlement.output?.structured).observation))
}

function requireElement(observation: IsolatedBrowser.Observation, name: string) {
  const element = observation.elements.find((candidate) => candidate.name === name)
  if (!element) throw new Error(`Missing synthetic element: ${name}`)
  return element
}

function settleBrowser(registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) {
  return settleTool(registry, input).pipe(
    Effect.tap((settlement) =>
      Effect.sync(() => {
        const result =
          settlement.result.type === "content" && Array.isArray(settlement.result.value)
            ? settlement.result.value.filter(
                (part: unknown) => typeof part === "object" && part !== null && "type" in part && part.type === "text",
              )
            : settlement.result
        const text = JSON.stringify({
          result,
          content: settlement.output?.content.filter((part) => part.type === "text"),
        })
        for (const marker of privateMarkers) expect(text).not.toContain(marker)
      }),
    ),
  )
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function browserFixture() {
  return `<!doctype html><title>Browser integration fixture</title>
    <label>Message <input aria-label="Message" value="${privateMarkers[2]}" onfocus="this.select()"></label>
    <button aria-label="Submit" onclick="fetch('/submitted?value='+encodeURIComponent(document.querySelector('input').value))">Submit</button>
    <div hidden>${privateMarkers[3]}</div>
    <div style="height:2000px">Synthetic scroll area</div>`
}
