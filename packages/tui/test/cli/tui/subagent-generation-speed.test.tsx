/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Keymap } from "../../../src/context/keymap"
import { SubagentEconomicsSurface } from "../../../src/routes/session/subagent-economics"
import { SubagentFooterContent, subagentEconomics } from "../../../src/routes/session/subagent-footer"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const member = {
  sessionID: "ses_child",
  cost: 0.13,
  tokens: { input: 80, output: 20, reasoning: 0, cache: { read: 900, write: 1_200 } },
  contextTotal: 54_000,
  contextLimit: 1_000_000,
  cacheHitRatio: 0.74,
  cacheRead: 900,
  cacheWrite: 1_200,
}
const labels = ["Context", "Speed", "Cache hit", "Reads", "Writes", "Spent", "Rolls up to"] as const
const values = { Context: "54.0K/1.0M", Speed: "≈ 100 tok/s", "Cache hit": "74%", Reads: "900", Writes: "1,200", Spent: "$0.13", "Rolls up to": "Parent session" }

test("child economics carry the supplied speed first in the strip and invent none", () => {
  const value = subagentEconomics(member, "Parent", "≈ 100 tok/s")
  expect(value?.speed).toBe("≈ 100 tok/s")
  expect(value?.strip[0]).toBe("≈ 100 tok/s")
  const absent = subagentEconomics(member, "Parent")
  expect(absent?.speed).toBeUndefined()
  expect(absent?.strip.join(" ")).not.toContain("tok/s")
})

for (const width of [48, 80, 189]) test(`child economics and footer display speed within ${width} columns`, async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([import("../../../src/config"), import("../../../src/context/theme")])
  const config = createTuiResolvedConfig()
  const economics = {
    ...subagentEconomics(member, "Parent", "≈ 100 tok/s")!,
    context: values.Context, cacheHit: values["Cache hit"], reads: values.Reads, writes: values.Writes, spent: values.Spent, rollsUpTo: values["Rolls up to"],
  }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}>
    <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><Keymap.Provider config={config}>
      <box flexDirection="column">
        <SubagentEconomicsSurface economics={economics} />
        <SubagentFooterContent title="Child" usage={() => undefined} economics={economics} />
      </box>
    </Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 60 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("SUBAGENT ECONOMICS") && frame.includes("Rolls up to"))
    const lines = app.captureCharFrame().split("\n")
    expect(lines.every((line) => line.length <= width)).toBe(true)
    expect(lines.join("\n").match(/≈ 100 tok\/s/g)?.length).toBeGreaterThanOrEqual(2)

    const perRow = Math.min(7, Math.floor((width - 6) / 22))
    const positions = labels.map((label) => {
      const row = lines.findIndex((line) => line.includes(label) && !line.includes("SUBAGENT"))
      return { label, row, column: lines[row]!.indexOf(label) }
    })
    for (const { label, row, column } of positions) {
      expect(row).toBeGreaterThan(-1)
      // A value sits under its own label: label row, one blank line, value row.
      expect(lines[row + 2]!.slice(column, column + values[label].length)).toBe(values[label])
      expect(lines[row + 1]!.trim()).toBe("")
    }
    // Columns follow the documented order, flow left to right then wrap, and never exceed the per-row capacity.
    const order = positions.map((position) => position.row * 1_000 + position.column)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const byRow = Map.groupBy(positions, (position) => position.row)
    for (const row of byRow.values()) {
      expect(row.length).toBeLessThanOrEqual(perRow)
      const gaps = row.slice(1).map((position, index) => position.column - row[index]!.column)
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(22)
      expect(new Set(gaps).size).toBeLessThanOrEqual(1)
    }
    expect(positions[0]!.column).toBe(3)
    expect(Math.max(...[...byRow.values()].map((row) => row.length))).toBe(perRow)
  } finally { app.renderer.destroy() }
})
