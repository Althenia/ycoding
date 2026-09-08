/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, MouseEvent, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { Prompt } from "../../../src/routes/session/permission"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

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
