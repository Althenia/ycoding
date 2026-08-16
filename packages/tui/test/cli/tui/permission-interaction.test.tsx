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
    expect(descendants(app.renderer.root).some((item) => item.id === "session.permission.action.reject.band")).toBe(true)

    app.mockInput.pressArrow("up")
    await app.waitForFrame((frame) => frame.includes("Allow once"))
    expect(descendants(app.renderer.root).some((item) => item.id === "session.permission.action.once.band")).toBe(true)

    const deny = descendants(app.renderer.root).find(
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.id === "session.permission.action.reject",
    )
    if (!deny) throw new Error("permission rejection option did not render")
    const denyLabel = descendants(app.renderer.root).find(
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.id === "session.permission.action.reject.label",
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
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.id === "session.permission.action.reject.band",
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
