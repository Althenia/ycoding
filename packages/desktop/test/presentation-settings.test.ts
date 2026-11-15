import { expect, test } from "bun:test"
import {
  COMPANION_DOCKED_QUERY,
  DEFAULT_PRESENTATION,
  PRESENTATION_STORAGE_KEY,
  parsePresentationSettings,
  startupCompanionOpen,
  toolDisclosures,
  withCompanion,
  withThinking,
  withToolGrouping,
} from "../src/presentation-settings"

test("stored presentation settings parse each field independently and fall back to the current Desktop defaults", () => {
  expect(PRESENTATION_STORAGE_KEY).toBe("ycoding.desktop.presentation")
  expect(DEFAULT_PRESENTATION).toEqual({ thinking: "hide", grouping: "auto", companion: "hide" })
  for (const raw of [null, "", "not json", "[]", "null", "7", "x".repeat(5_000)]) expect(parsePresentationSettings(raw)).toEqual(DEFAULT_PRESENTATION)
  expect(parsePresentationSettings(JSON.stringify({ thinking: "show", grouping: "none", companion: "auto" }))).toEqual({ thinking: "show", grouping: "none", companion: "auto" })
  expect(parsePresentationSettings(JSON.stringify({ thinking: "show", grouping: "sometimes", companion: true, extra: "ignored" }))).toEqual({ thinking: "show", grouping: "auto", companion: "hide" })
  expect(parsePresentationSettings(`{"__proto__":{"thinking":"show"},"grouping":"none"}`)).toEqual({ thinking: "hide", grouping: "none", companion: "hide" })
})

test("thinking and tool grouping updates keep the other settings", () => {
  const start = { thinking: "hide", grouping: "none", companion: "auto" } as const
  expect(withThinking(start, true)).toEqual({ ...start, thinking: "show" })
  expect(withThinking(withThinking(start, true), false)).toEqual(start)
  expect(withToolGrouping(start, "auto")).toEqual({ ...start, grouping: "auto" })
})

test("opening the companion remembers auto and closing it remembers hide", () => {
  expect(withCompanion(DEFAULT_PRESENTATION, true)).toEqual({ ...DEFAULT_PRESENTATION, companion: "auto" })
  expect(withCompanion({ ...DEFAULT_PRESENTATION, companion: "auto" }, false)).toEqual(DEFAULT_PRESENTATION)
})

test("auto opens the companion at startup only where it docks beside the conversation", async () => {
  expect(startupCompanionOpen({ ...DEFAULT_PRESENTATION, companion: "auto" }, true)).toBe(true)
  expect(startupCompanionOpen({ ...DEFAULT_PRESENTATION, companion: "auto" }, false)).toBe(false)
  expect(startupCompanionOpen(DEFAULT_PRESENTATION, true)).toBe(false)
  const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text()
  const overlay = css.match(/@media \(max-width: (\d+)px\) \{[^\n]*\.conversation:has\(\.rl-companion\) > \.rl-companion \{ position: absolute;/)
  expect(overlay).not.toBeNull()
  expect(COMPANION_DOCKED_QUERY).toBe(`(min-width: ${Number(overlay![1]) + 1}px)`)
})

test("auto keeps consecutive tool calls in one disclosure and none gives each call its own", () => {
  const parts = [{ id: "a" }, { id: "b" }, { id: "c" }] as const
  expect(toolDisclosures(parts, "auto")).toEqual([parts])
  expect(toolDisclosures(parts, "none")).toEqual([[parts[0]], [parts[1]], [parts[2]]])
  expect(toolDisclosures([], "none")).toEqual([])
  expect(toolDisclosures([], "auto")).toEqual([])
})
