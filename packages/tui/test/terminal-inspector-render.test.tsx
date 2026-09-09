/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import "../src/component/terminal-inspector"
import type { TerminalViewportRenderable } from "../src/component/terminal-inspector"

test("native terminal viewport preserves cursor redraw and alternate-screen restoration", async () => {
  let terminal: TerminalViewportRenderable | undefined
  const outbound: Uint8Array[] = []
  const app = await testRender(
    () => (
      <terminal_viewport
        ref={(value: TerminalViewportRenderable) => (terminal = value)}
        width={20}
        height={4}
        cols={20}
        rows={4}
        interactive={false}
        sendData={(data) => outbound.push(data.slice())}
      />
    ),
    { width: 20, height: 4 },
  )
  try {
    app.renderer.start()
    terminal!.write("progress 10%\rprogress 90%")
    await app.waitForFrame((frame) => frame.includes("progress 90%"))
    expect(terminal!.screen().cursor).toMatchObject({ x: 12, y: 0 })

    terminal!.write("\u001b[?1049hALT\u001b[?1049l")
    await app.renderOnce()
    expect(terminal!.screen().text).toContain("progress 90%")
    expect(terminal!.screen().text).not.toContain("ALT")

    terminal!.write("\u0007\u001b]0;host title must not change\u0007\u001b]52;c;Y2xpcGJvYXJk\u0007")
    await app.renderOnce()
    terminal!.focus()
    expect(terminal!.focused).toBe(false)
    expect(outbound).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})
