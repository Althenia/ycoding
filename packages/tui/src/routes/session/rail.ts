export type RailSectionKey =
  | "session"
  | "context"
  | "todo"
  | "goal"
  | "autonomy"
  | "subagents"
  | "shells"
  | "skills"
  | "mcp"
  | "plugins"
  // Existing rail content the design's section list does not enumerate. Both summarise themselves,
  // so they follow the collapsed-by-default rule.
  | "guardrails"
  | "lsp"

// Penpot's 32px section bands occupy 2.76 terminal rows at the measured 11.594px row height.
export const RAIL_SECTION_BAND_HEIGHT = Math.ceil(32 / 11.594)

/**
 * Ordinary defaults keep Session, context and todo open. Active surfaces add their operational
 * sections; auxiliary sections still require attention or an explicit user toggle.
 */
export function defaultExpanded(input: {
  goal?: boolean
  autonomy?: boolean
  shellSurface?: boolean
  allExpanded?: boolean
}): RailSectionKey[] {
  if (input.allExpanded) return ["session", "goal", "autonomy", "context", "todo", "subagents", "shells"]
  if (input.shellSurface)
    return [
      "shells",
      "session",
      ...(input.goal ? (["goal"] as const) : []),
      ...(input.autonomy ? (["autonomy"] as const) : []),
      "todo",
    ]
  return [
    "session",
    "context",
    ...(input.goal ? (["goal"] as const) : []),
    ...(input.autonomy ? (["autonomy"] as const) : []),
    "todo",
  ]
}

/**
 * `order` is a recency list with the least recently expanded section first.
 */
export function expandSection(order: RailSectionKey[], key: RailSectionKey): RailSectionKey[] {
  return [...order.filter((item) => item !== key), key]
}

export function collapseSection(order: RailSectionKey[], key: RailSectionKey): RailSectionKey[] {
  return order.filter((item) => item !== key)
}

/**
 * Attention events force a section open and release it once cleared, but a section the user expanded
 * themselves stays open after the event clears.
 */
export function resolveExpanded(input: {
  order: RailSectionKey[]
  attention: RailSectionKey[]
}): RailSectionKey[] {
  return input.attention.reduce(expandSection, input.order)
}

/**
 * Rail placement follows the terminal width: hidden below 100 columns, an overlay until the main pane
 * can hold its own beside it, then a docked rail.
 */
export function railPlacement(width: number) {
  if (width < 100) return "hidden" as const
  if (width < 120) return "overlay" as const
  return "docked" as const
}

// Penpot measures the 360px rail against 7.2px terminal columns.
const DESIGN_RAIL_WIDTH = 360 / 7.2
const MIN_DOCKED_RAIL_WIDTH = 32
const DOCKED_RAIL_BREAKPOINT = 120
const FULL_RAIL_BREAKPOINT = 160

export function railWidth(width: number) {
  return Math.min(
    DESIGN_RAIL_WIDTH,
    Math.max(
      MIN_DOCKED_RAIL_WIDTH,
      MIN_DOCKED_RAIL_WIDTH +
        ((width - DOCKED_RAIL_BREAKPOINT) * (DESIGN_RAIL_WIDTH - MIN_DOCKED_RAIL_WIDTH)) /
          (FULL_RAIL_BREAKPOINT - DOCKED_RAIL_BREAKPOINT),
    ),
  )
}

export function railMetrics(width: number) {
  const fullWidth = railWidth(width) >= DESIGN_RAIL_WIDTH
  return {
    // The left rule plus two inner columns retain the design's marker column at rail offset 3.
    paddingLeft: 3,
    paddingRight: 3,
    sectionLabelPadding: fullWidth ? 1 : 0,
    sessionGap: fullWidth ? 1 : 0,
    sessionPaddingBottom: fullWidth ? 1 : 0,
  }
}
