/**
 * User-measured 189x69 full-terminal grid on the target machine.
 */
export const DESIGN_VIEWPORT = { width: 189, height: 69 }

/**
 * User-measured 220x69 full-terminal grid on the target machine with the host
 * terminal's sidebar closed.
 *
 * Both values are the FULL terminal width. Neither has the YCoding rail
 * subtracted — the rail is drawn inside whichever of the two applies, so a
 * surface that splits rail from content must be correct at both.
 */
export const DESIGN_VIEWPORT_WIDE = { width: 220, height: 69 }

/**
 * Responsive compatibility band for narrow terminals.
 *
 * Section 13 of the design system defines the ladder both other constants sit in:
 *
 *   80x24     single pane   rail hidden            composer 4 rows   overlays FULL-WIDTH
 *   100x30    single pane   rail overlays          composer 4 rows   overlays centered
 *   120-159   main + rail   rail 32-36 cols        composer 5 rows   overlays centered
 *   160+      main + rail   rail 36 cols           composer 5 rows   overlays centered
 *
 * Both DESIGN_VIEWPORT and DESIGN_VIEWPORT_WIDE are in the 160+ band, so they
 * share a layout and differ only in available width — which is what makes them a
 * useful pair for catching a fixed column cap. At this band overlays are centered;
 * at 80 they are full-width, so an overlay test must not assert centering here.
 */
export const NARROW_VIEWPORT = { width: 80, height: 24 }
