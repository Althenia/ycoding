import { type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import type { TuiPluginStatus } from "../../src/plugin/host-api"

export async function captureRoute(input: {
  width: number
  height: number
  route: FetchHandler
  args?: { sessionID?: string }
  pluginStatus?: ReadonlyArray<TuiPluginStatus>
  settle: string
  stable?: string[]
}) {
  const screen = await renderScreen(input)
  try {
    for (let attempt = 0; input.stable && attempt < 100; attempt++) {
      if (input.stable.every((text) => screen.frame().includes(text))) break
      await Bun.sleep(20)
    }
    const frame = screen.frame()
    if (input.stable && !input.stable.every((text) => frame.includes(text)))
      throw new Error(`screen did not stabilize: ${input.stable.join(", ")}`)
    return (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
  } finally {
    await screen.dispose()
  }
}
