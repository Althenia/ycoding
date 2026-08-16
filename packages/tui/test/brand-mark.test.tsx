/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { BrandMark } from "../src/component/logo"

const MINT = RGBA.fromHex("#67D7A4").toInts()
const BACKGROUND = RGBA.fromHex("#1B1E23")

test("mounts the transparent canonical mark at landing and header sizes", async () => {
  for (const input of [
    {
      width: 12,
      height: 6,
      rows: ["██        ██", "██        ██", "██▄▄▄   ▄▄██", "██▀▀▀   ▀▀██", "██        ██", "     ██     "],
    },
    { width: 2, height: 1, rows: ["▌▐"] },
  ]) {
    const app = await testRender(
      () => (
        <box width={input.width} height={input.height} backgroundColor={BACKGROUND}>
          <BrandMark width={input.width} height={input.height} />
        </box>
      ),
      { width: input.width + 1, height: input.height },
    )
    app.renderer.start()

    try {
      await app.waitForFrame((frame) => frame.includes(input.rows[0]!))
      expect(
        app
          .captureCharFrame()
          .split("\n")
          .slice(0, input.height)
          .map((line) => line.slice(0, input.width)),
      ).toEqual(input.rows)

      const painted = app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => /[█▀▄▌▐]/.test(span.text))
      expect(painted.length).toBeGreaterThan(0)
      for (const span of painted) {
        expect(span.fg.toInts()).toEqual(MINT)
        expect(span.bg.toInts()).toEqual(BACKGROUND.toInts())
      }
    } finally {
      app.renderer.destroy()
    }
  }
})
