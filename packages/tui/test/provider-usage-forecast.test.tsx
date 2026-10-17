/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderUsageForecastOutput, ProviderUsageListOutput } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const now = Date.UTC(2026, 8, 22, 12)
const updatedAt = now - 5 * 60_000
const snapshots: ProviderUsageListOutput["data"] = [
  {
    providerID: "anthropic",
    label: "Claude Max",
    status: "available",
    source: "response_headers",
    stability: "observed",
    updatedAt,
    windows: [
      { id: "five-hour", label: "Session", unit: "percent", used: 68, resetAt: now + 3_600_000 },
      { id: "extra-usage", label: "Extra usage", unit: "usd", used: 12, limit: 50, remaining: 38 },
    ],
  },
]
const empty = { asOf: now, localScope: "backend" as const }
const base = {
  providerID: "anthropic",
  windowID: "five-hour",
  unit: "percent" as const,
  source: "response_headers" as const,
  stability: "observed" as const,
  updatedAt,
}
const estimated = {
  ...base,
  state: "estimated" as const,
  method: "quota-delta-ema" as const,
  evidence: "medium" as const,
  ratePerHour: 12.5,
  exhaustionAt: now + 2 * 3_600_000,
  projectedUsedAtReset: 80,
  observedFrom: now - 3_600_000,
  observedTo: updatedAt,
}

async function renderForecast(input: {
  forecast?: ProviderUsageForecastOutput["data"]
  forecastFailed?: boolean
  width?: number
}) {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <Keymap.Provider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent
                    snapshots={() => snapshots}
                    initialTab="usage"
                    now={() => now}
                    forecast={() => input.forecast}
                    forecastFailed={() => input.forecastFailed ?? false}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 189, height: 60 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Claude Max"))
  return app
}

const flat = (frame: string) => frame.replace(/\s+/g, " ")

test("each quota window keeps its own native-unit forecast with method, evidence, observation and freshness", async () => {
  const app = await renderForecast({
    forecast: {
      ...empty,
      quotas: [
        estimated,
        { ...base, windowID: "extra-usage", unit: "usd", state: "estimated", ratePerHour: 1.5, method: "window-mean", evidence: "low" },
      ],
    },
  })
  try {
    const frame = flat(await app.waitForFrame((value) => value.includes("Quota burn 12.5 percentage points/hour")))
    expect(frame).toContain("Estimated forecast")
    expect(frame).toContain(`Estimated exhaustion ${new Date(now + 2 * 3_600_000).toISOString()}`)
    expect(frame).toContain("Projected at reset 80 percentage points")
    expect(frame).toContain("Recent quota deltas · 15m half-life · 1h horizon · medium evidence")
    expect(frame).toContain(`Observed ${new Date(now - 3_600_000).toISOString()} – ${new Date(updatedAt).toISOString()}`)
    expect(frame).toContain("Updated 5m ago")
    expect(frame).toContain("Quota burn 1.5 USD/hour")
    expect(frame).toContain("Window mean · low evidence")
    expect(frame.indexOf("Session")).toBeLessThan(frame.indexOf("Quota burn 12.5"))
    expect(frame.indexOf("Quota burn 12.5")).toBeLessThan(frame.indexOf("Extra usage"))
    expect(frame.indexOf("Extra usage")).toBeLessThan(frame.indexOf("Quota burn 1.5 USD"))
  } finally {
    app.renderer.destroy()
  }
})

test("a window without a matching observation states why its forecast is unavailable and invents no numbers", async () => {
  const app = await renderForecast({
    forecast: { ...empty, quotas: [{ ...estimated, updatedAt: updatedAt - 1 }] },
  })
  try {
    const frame = flat(await app.waitForFrame((value) => value.includes("Forecast unavailable · No matching quota observation")))
    expect(frame).not.toContain("Quota burn")
    expect(frame).not.toContain("Unlimited")
    expect(frame.match(/Forecast unavailable · No matching quota observation/g)).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})

test("a failed or unloaded forecast read never shows a retained estimate", async () => {
  const failed = await renderForecast({ forecast: { ...empty, quotas: [estimated] }, forecastFailed: true })
  try {
    const frame = flat(await failed.waitForFrame((value) => value.includes("Forecast unavailable · lookup failed")))
    expect(frame).not.toContain("Quota burn")
  } finally {
    failed.renderer.destroy()
  }
  const unloaded = await renderForecast({})
  try {
    const frame = flat(await unloaded.waitForFrame((value) => value.includes("Forecast unavailable · Not loaded")))
    expect(frame).toContain("Quota forecasts unavailable")
    expect(frame).toContain("Recorded consumption unavailable")
  } finally {
    unloaded.renderer.destroy()
  }
})

test("cold, sparse and flat series stay insufficient with their reason; only an explicit unlimited state says Unlimited", async () => {
  const insufficient = { ...base, state: "insufficient" as const, evidence: "insufficient" as const }
  const app = await renderForecast({
    forecast: {
      ...empty,
      quotas: [
        { ...insufficient, reason: "No increase observed" },
        { ...insufficient, windowID: "extra-usage", unit: "usd", state: "unlimited" },
      ],
    },
  })
  try {
    const frame = flat(await app.waitForFrame((value) => value.includes("No increase observed")))
    expect(frame).toContain("Forecast unavailable")
    expect(frame).toContain("No supported method · insufficient evidence")
    expect(frame.match(/Unlimited/g)).toHaveLength(1)
    expect(frame.indexOf("Extra usage")).toBeLessThan(frame.indexOf("Unlimited"))
  } finally {
    app.renderer.destroy()
  }
})

test("an exhaustion ETA at or before the forecast observation renders now", async () => {
  const app = await renderForecast({
    forecast: { ...empty, asOf: now, quotas: [{ ...estimated, exhaustionAt: now - 1 }, { ...estimated, windowID: "extra-usage", unit: "usd", exhaustionAt: now }] },
  })
  try {
    const frame = flat(await app.waitForFrame((value) => value.includes("Estimated exhaustion now")))
    expect(frame.match(/Estimated exhaustion now/g)).toHaveLength(2)
    expect(frame).not.toContain(new Date(now - 1).toISOString())
  } finally {
    app.renderer.destroy()
  }
})

test("local recorded consumption stays separate from quota burn and distinguishes provider-default profiles", async () => {
  const observedFrom = now - 600_000
  const app = await renderForecast({
    forecast: {
      ...empty,
      quotas: [],
      localRates: [
        { providerID: "openai", modelID: "gpt-5.6", observedFrom, observedTo: now, tokensPerMinute: 120, tokensPerMinute5: 100, tokensPerMinute60: 80, estimatedUSDPerHour: 1.25, coverage: { pricedRequests: 3, unpricedRequests: 1 } },
        { providerID: "openai", profile: "work", observedFrom, observedTo: now, tokensPerMinute: 30, coverage: { pricedRequests: 0, unpricedRequests: 2 } },
      ],
    },
  })
  try {
    const frame = flat(await app.waitForFrame((value) => value.includes("Recorded consumption · Backend") && value.includes("tokens/min")))
    expect(frame).toContain("openai · provider default at request time · gpt-5.6: 120.0 tokens/min · 5m 100.0 · 60m 80.0 · $1.25 estimated/hour · 3 priced / 1 unpriced")
    expect(frame).toContain(`observed ${new Date(observedFrom).toISOString()} – ${new Date(now).toISOString()}`)
    expect(frame).toContain("openai · profile work: 30.0 tokens/min · 5m unreported · 60m unreported · 0 priced / 2 unpriced")
    expect(frame).not.toContain("estimated/hour · 0 priced / 2")
    expect(frame.indexOf("Recorded consumption · Backend")).toBeGreaterThan(frame.indexOf("Extra usage"))
  } finally {
    app.renderer.destroy()
  }
})

test("only a successful empty local population says no recorded consumption", async () => {
  const empties = await renderForecast({ forecast: { ...empty, quotas: [], localRates: [] } })
  try {
    const frame = flat(await empties.waitForFrame((value) => value.includes("No recorded consumption")))
    expect(frame).not.toContain("Recorded consumption unavailable")
  } finally {
    empties.renderer.destroy()
  }
  const absent = await renderForecast({ forecast: { ...empty, quotas: [] } })
  try {
    const frame = flat(await absent.waitForFrame((value) => value.includes("Recorded consumption unavailable")))
    expect(frame).not.toContain("No recorded consumption")
  } finally {
    absent.renderer.destroy()
  }
})
