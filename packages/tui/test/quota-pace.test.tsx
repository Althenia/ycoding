import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { QuotaForecastSummary } from "../src/routes/session/usage-cost"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("quota pace shares the rendered forecast metadata without replacing the recent estimate", async () => {
  for (const mode of ["light", "dark"] as const) for (const width of [40, 100]) {
    const forecasts = (["ahead", "cutting-it-close", "will-run-out", undefined] as const).map((verdict) => ({ state: "estimated" as const, unit: "percent", evidence: "medium" as const, updatedAt: 600_000, ratePerHour: 12,
      ...(verdict === undefined ? {} : { pace: { verdict, projectedUsedAtReset: 95, ...(verdict === "will-run-out" ? { exhaustionAt: 900_000 } : {}) } }) }))
    const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
      <box flexDirection="column">{forecasts.map((forecast) => <QuotaForecastSummary now={600_000} forecast={forecast} />)}</box>
    </ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 24 })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Quota burn"))
      const frame = app.captureCharFrame().replace(/\s+/g, " ")
      expect(frame).toContain("Ahead")
      expect(frame).toContain("Cutting it close")
      expect(frame).toContain("Will run out")
      expect(frame.match(/Quota burn/g)).toHaveLength(4)
      expect(frame.match(/Ahead/g)).toHaveLength(1)
      expect(frame.match(/Cutting it close/g)).toHaveLength(1)
      expect(frame.match(/Will run out/g)).toHaveLength(1)
    } finally { app.renderer.destroy() }
  }
})
