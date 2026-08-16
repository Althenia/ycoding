/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { expect, test } from "bun:test"
import { ConfigProvider, resolve } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { InlineToolRow } from "../src/routes/session"

const sessionRoute = await Bun.file(new URL("../src/routes/session/index.tsx", import.meta.url)).text()

test("renders user and agent-invoked completed Skill titles with the same treatment", async () => {
  const bright = RGBA.fromHex("#ffffff")
  const app = await testRender(() => (
    <ConfigProvider config={resolve({}, { terminalSuspend: true })} service={{ get: async () => ({}), update: async () => ({}) }}>
      <ThemeProvider mode="dark">
        <InlineToolRow icon="✦" complete={true} pending="Loading skill..." color={bright}>
          Completed Skill
        </InlineToolRow>
      </ThemeProvider>
    </ConfigProvider>
  ), { width: 80, height: 10 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toBeDefined()
    expect(sessionRoute).toContain(
      'completeColor={props.part.state.status === "completed" ? themeV2.text.default : undefined}',
    )
    expect(sessionRoute).toContain('color={themeV2.text.default}')
    expect(sessionRoute).toContain('status={<StatusBadge color={accent()}>Loaded</StatusBadge>}')
  } finally {
    app.renderer.destroy()
  }
})
