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

/**
 * A fifth expanded section collapses the least recently expanded one, so the rail never turns into a
 * scroll wall where every section is half visible.
 */
export const MAX_EXPANDED = 4

/**
 * Sections that carry no summary on their header row, so collapsing them would hide information.
 * The remaining sections summarise themselves and stay collapsed until an attention event.
 */
export function defaultExpanded(input: { goal?: boolean; autonomy?: boolean; shellSurface?: boolean }): RailSectionKey[] {
  if (input.shellSurface)
    return [
      "shells" as const,
      "session" as const,
      ...(input.goal ? (["goal"] as const) : []),
      ...(input.autonomy ? (["autonomy"] as const) : []),
      "todo" as const,
    ].slice(0, MAX_EXPANDED)
  return [
    "session" as const,
    "context" as const,
    ...(input.goal ? (["goal"] as const) : []),
    ...(input.autonomy ? (["autonomy"] as const) : []),
    "todo" as const,
  ].slice(-MAX_EXPANDED)
}

/**
 * `order` is a recency list with the least recently expanded section first.
 */
export function expandSection(order: RailSectionKey[], key: RailSectionKey): RailSectionKey[] {
  return [...order.filter((item) => item !== key), key].slice(-MAX_EXPANDED)
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
    paddingLeft: fullWidth ? 3 : 2,
    sessionGap: fullWidth ? 1 : 0,
    sessionPaddingBottom: fullWidth ? 1 : 0,
  }
}
