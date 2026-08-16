import { describe, expect, test } from "bun:test"
import { getGlyph, type GlyphName } from "../../src/ui/glyph"

const cases: ReadonlyArray<readonly [GlyphName, string, string, string]> = [
  ["ok", "ok", "ok ", "accent"],
  ["inFlight", "..", ".. ", "muted"],
  ["queued", "--", "-- ", "muted"],
  ["failed", "!", "!  ", "danger"],
  ["guardrailBlocked", "!!", "!! ", "warning"],
  ["awaitingInput", "?", "?  ", "warning"],
  ["subagent", "◦", "◦  ", "info"],
  ["compaction", "~", "~  ", "muted"],
  ["connected", "✓", "✓  ", "accent"],
  ["disabled", "○", "○  ", "muted"],
  ["connecting", "⋯", "⋯  ", "info"],
  ["error", "✗", "✗  ", "danger"],
]

describe("status glyphs", () => {
  test.each(cases)("provides the %s slot", (name, glyph, rendered, color) => {
    expect(getGlyph(name)).toMatchObject({ glyph, rendered, color })
  })
})
