/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { FormAssessment } from "../src/routes/session/form"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function render(source: unknown) {
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
          <FormAssessment value={undefined} source={source} settled="human" />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 120, height: 10 },
  )
  app.renderer.start()
  return app
}

test("a Dots delegated reply renders as an external client, never as the human or a native coordinator", async () => {
  const app = await render({
    kind: "dots-delegation",
    anchorSessionID: "ses_anchor",
    delegationID: "delegation_one",
    revision: 3,
    exchangeID: "exchange_one",
  })
  try {
    await app.waitForFrame((frame) => frame.includes("answered by external client"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("answered by external client via Dots delegation delegation_one · anchor ses_anchor")
    expect(frame).not.toContain("answered by you")
    expect(frame).not.toContain("answered by coordinator")
  } finally {
    app.renderer.destroy()
  }
})

test("a native coordinator reply keeps its coordinator attribution", async () => {
  const app = await render({ kind: "coordinator", coordinatorSessionID: "ses_coord" })
  try {
    await app.waitForFrame((frame) => frame.includes("answered by coordinator ses_coord"))
    expect(app.captureCharFrame()).not.toContain("external client")
    expect(app.captureCharFrame()).not.toContain("answered by you")
  } finally {
    app.renderer.destroy()
  }
})

test("a malformed reply source is unreported rather than attributed to the human", async () => {
  const app = await render({ kind: "dots-delegation", anchorSessionID: "ses_anchor", delegationID: 4, revision: 0 })
  try {
    await app.waitForFrame((frame) => frame.includes("answer source unreported"))
    expect(app.captureCharFrame()).not.toContain("answered by you")
    expect(app.captureCharFrame()).not.toContain("external client")
  } finally {
    app.renderer.destroy()
  }
})
