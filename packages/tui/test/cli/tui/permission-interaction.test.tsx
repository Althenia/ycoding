/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, MouseEvent, ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { PermissionPrompt, Prompt } from "../../../src/routes/session/permission"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { LocationProvider } from "../../../src/context/location"
import { createApi, createFetch } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test.each(["profile", "owned"])(
  "shows the %s Chrome site download warning through confirmation and cancel",
  async (mode) => {
    const replies: unknown[] = []
    const transport = createFetch(async (url, request) => {
      if (url.pathname === "/api/session/ses_browser/permission/per_browser/reply") {
        replies.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(transport.fetch)}>
                <DataProvider>
                  <LocationProvider>
                    <Keymap.Provider>
                      <PermissionPrompt
                        request={{
                          id: "per_browser",
                          sessionID: "ses_browser",
                          action: "browser_interact",
                          resources: ["https://example.test/page"],
                          save: ["https://example.test"],
                          metadata: { mode, incidentalDownloads: true, site: "https://example.test" },
                        }}
                      />
                    </Keymap.Provider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 24, kittyKeyboard: true },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("Permission required"))
      const output = app.captureCharFrame().replace(/\s+/g, " ")
      expect(output).toContain("Control Chrome site https://example.test")
      expect(output).toContain("may trigger downloads without another prompt.")
      app.mockInput.pressArrow("down")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("Always allow"))
      expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("may trigger downloads without another prompt.")
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("Permission required"))
      expect(replies).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  },
)

test("updates permission selection from vertical arrows and hover", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider>
              <Prompt
                title="Permission required"
                instance="permission_hover"
                body={<box />}
                options={{ once: "Allow once", reject: "Deny" }}
                onSelect={() => {}}
              />
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("Allow once") && frame.includes("Deny"))
    app.mockInput.pressArrow("down")
    await app.waitForFrame((frame) => frame.includes("Deny"))
    expect(descendants(app.renderer.root).some((item) => item.id === "session.permission.action.reject.band")).toBe(
      true,
    )

    app.mockInput.pressArrow("up")
    await app.waitForFrame((frame) => frame.includes("Allow once"))
    expect(descendants(app.renderer.root).some((item) => item.id === "session.permission.action.once.band")).toBe(true)

    const deny = descendants(app.renderer.root).find(
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.id === "session.permission.action.reject",
    )
    if (!deny) throw new Error("permission rejection option did not render")
    const denyLabel = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable && item.id === "session.permission.action.reject.label",
    )
    if (!denyLabel) throw new Error("permission rejection label did not render")
    const denyLabelY = denyLabel.y

    deny.processMouseEvent(
      new MouseEvent(deny, {
        type: "over",
        button: 0,
        x: deny.x,
        y: deny.y,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    )
    await app.renderOnce()

    const denyBand = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable && item.id === "session.permission.action.reject.band",
    )
    if (!denyBand) throw new Error("permission rejection band did not render")
    expect(denyBand.y).toBe(denyLabelY)
  } finally {
    app.renderer.destroy()
  }
})

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)]
}

for (const kind of ["permission", "guardrail"] as const) {
  test(`${kind} pins decisions while complete long details scroll at short heights and after resize`, async () => {
    const decisions: string[] = []
    const command = [
      ...Array.from({ length: 80 }, (_, index) => `display-only review line ${index}: ${"detail ".repeat(12)}`),
      "FINAL_REVIEW_SENTINEL",
    ].join("\n")
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider>
                <box height="100%">
                  <box flexGrow={1}>
                    <text>Transcript remains visible</text>
                  </box>
                  <Prompt
                    kind={kind}
                    title="Approval required"
                    instance="bounded_approval"
                    body={<text>{command}</text>}
                    options={{ reject: "Deny", once: "Allow once", always: "Allow for this session" }}
                    defaultOption="reject"
                    escapeKey="reject"
                    onSelect={(option) => decisions.push(option)}
                  />
                </box>
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 24, kittyKeyboard: true },
    )
    try {
      await app.waitForFrame((frame) => frame.includes("Approval required"))
      const assertVisible = () => {
        const frame = app.captureCharFrame()
        for (const label of ["Approval required", "Deny", "Allow once", "Allow for this session", "pgup/pgdn"])
          expect(frame).toContain(label)
        for (const option of ["reject", "once", "always"]) {
          const row = descendants(app.renderer.root).find((item) => item.id === `session.${kind}.action.${option}`)!
          expect(row.y).toBeGreaterThanOrEqual(0)
          expect(row.y + row.height).toBeLessThanOrEqual(app.renderer.height)
        }
      }
      assertVisible()
      expect(app.captureCharFrame()).toContain("Transcript remains visible")
      const scroll = descendants(app.renderer.root).find(
        (item): item is ScrollBoxRenderable => item instanceof ScrollBoxRenderable,
      )
      expect(scroll).toBeDefined()
      if (!scroll) throw new Error("review details did not render a scrollbox")
      expect(scroll.viewport.height).toBeGreaterThanOrEqual(5)
      for (let page = 0; page < 160 && !app.captureCharFrame().includes("FINAL_REVIEW_SENTINEL"); page++) {
        app.mockInput.pressKey("\u001b[6~")
        await app.renderOnce()
      }
      expect(app.captureCharFrame()).toContain("FINAL_REVIEW_SENTINEL")
      expect(decisions).toEqual([])
      expect(descendants(app.renderer.root).some((item) => item.id === `session.${kind}.action.reject.band`)).toBe(true)
      app.mockInput.pressKey("\u001b[5~")
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("FINAL_REVIEW_SENTINEL")
      for (let tick = 0; tick < 20 && !app.captureCharFrame().includes("FINAL_REVIEW_SENTINEL"); tick++) {
        await app.mockMouse.scroll(scroll.x + 2, scroll.y, "down")
        await app.renderOnce()
      }
      expect(app.captureCharFrame()).toContain("FINAL_REVIEW_SENTINEL")
      expect(decisions).toEqual([])
      app.mockInput.pressArrow("down")
      await app.renderOnce()
      app.renderer.resize(50, 10)
      await app.renderOnce()
      assertVisible()
      expect(descendants(app.renderer.root).some((item) => item.id === `session.${kind}.action.once.band`)).toBe(true)
      app.mockInput.pressEnter()
      await app.renderOnce()
      expect(decisions).toEqual(["once"])
      app.mockInput.pressEscape()
      await app.waitForFrame(() => decisions.length === 2)
      expect(decisions).toEqual(["once", "reject"])
    } finally {
      app.renderer.destroy()
    }
  })
}

for (const kind of ["permission", "guardrail"] as const) {
  for (const width of [50, 100]) {
    test(`${kind} choices stay on the same terminal lines during selection at width ${width}`, async () => {
      const decisions: string[] = []
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <Keymap.Provider>
                  <Prompt
                    kind={kind}
                    title="Approval required"
                    instance="stable_approval"
                    body={<text>Operation awaiting approval</text>}
                    options={{ reject: "Deny", once: "Allow once", always: "Allow for this session" }}
                    escapeKey="reject"
                    onSelect={(option) => decisions.push(option)}
                  />
                </Keymap.Provider>
              </ThemeProvider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        { width, height: 30, kittyKeyboard: true },
      )
      try {
        await app.waitForFrame(
          (frame) => frame.includes("Operation awaiting approval") && frame.includes("Allow for this session"),
        )
        const positions = () => {
          const lines = app.captureCharFrame().split("\n")
          return [
            "Approval required",
            "Operation awaiting approval",
            "Choose",
            "Deny",
            "Allow once",
            "Allow for this session",
          ].map((label) => lines.findIndex((line) => line.includes(label)))
        }
        const before = positions()
        expect(before.every((line) => line >= 0)).toBe(true)
        for (const direction of ["down", "down", "down", "up"] as const) {
          app.mockInput.pressArrow(direction)
          await app.renderOnce()
          expect(positions()).toEqual(before)
          expect(decisions).toEqual([])
        }
        for (const option of ["once", "always"]) {
          const row = descendants(app.renderer.root).find(
            (item): item is BoxRenderable =>
              item instanceof BoxRenderable && item.id === `session.${kind}.action.${option}`,
          )
          if (!row) throw new Error("approval option did not render")
          row.processMouseEvent(
            new MouseEvent(row, {
              type: "over",
              button: 0,
              x: row.x + 6,
              y: row.y,
              modifiers: { shift: false, alt: false, ctrl: false },
            }),
          )
          await app.renderOnce()
          expect(positions()).toEqual(before)
          expect(decisions).toEqual([])
        }
        app.mockInput.pressEnter()
        await app.renderOnce()
        expect(decisions).toEqual(["always"])
        app.mockInput.pressEscape()
        await app.waitForFrame(() => decisions.length === 2)
        expect(decisions).toEqual(["always", "reject"])
      } finally {
        app.renderer.destroy()
      }
    })
  }
}
