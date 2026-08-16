import type { FeedbackKind } from "../theme/v2/schema"
import { stringWidth } from "../util/string-width"

export type GlyphName =
  | "ok"
  | "inFlight"
  | "queued"
  | "failed"
  | "guardrailBlocked"
  | "awaitingInput"
  | "subagent"
  | "compaction"
  | "connected"
  | "disabled"
  | "connecting"
  | "error"

export type GlyphColorKind = "accent" | "muted" | "danger" | "warning" | "info"

export type GlyphColorToken = "feedback.success" | "text.subdued" | "feedback.error" | "feedback.warning" | "feedback.info"

export type GlyphSlot = Readonly<{
  readonly glyph: string
  readonly meaning: string
  readonly color: GlyphColorKind
  readonly token: GlyphColorToken
  readonly rendered: string
}>

const feedbackTokens: Readonly<Record<FeedbackKind, GlyphColorToken>> = {
  error: "feedback.error",
  warning: "feedback.warning",
  success: "feedback.success",
  info: "feedback.info",
}

export const GLYPHS: Readonly<Record<GlyphName, GlyphSlot>> = {
  ok: createGlyph("ok", "tool succeeded", "accent", "success"),
  inFlight: createGlyph("..", "in flight", "muted"),
  queued: createGlyph("--", "queued", "muted"),
  failed: createGlyph("!", "failed", "danger", "error"),
  guardrailBlocked: createGlyph("!!", "guardrail blocked", "warning", "warning"),
  awaitingInput: createGlyph("?", "subagent awaiting input", "warning", "warning"),
  subagent: createGlyph("◦", "subagent identity", "info", "info"),
  compaction: createGlyph("~", "compaction / archive boundary", "muted"),
  connected: createGlyph("✓", "connected / enabled", "accent", "success"),
  disabled: createGlyph("○", "disabled / inactive", "muted"),
  connecting: createGlyph("⋯", "pending / connecting", "info", "info"),
  error: createGlyph("✗", "error / failed", "danger", "error"),
}

export function getGlyph(name: GlyphName) {
  return GLYPHS[name]
}

function createGlyph(
  glyph: string,
  meaning: string,
  color: GlyphColorKind,
  feedbackKind?: FeedbackKind,
): GlyphSlot {
  const token = feedbackKind === undefined ? "text.subdued" : feedbackTokens[feedbackKind]
  const width = stringWidth(glyph)

  return {
    glyph,
    meaning,
    color,
    token,
    rendered: `${glyph}${" ".repeat(Math.max(0, 3 - width))}`,
  }
}
