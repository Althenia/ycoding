/**
 * Vector geometry of the YCoding "Y" mark, extracted from the Penpot design file, page
 * "09 YCoding", board "Brand / marks", group "YCoding / Canonical Mark". The four shapes and their
 * fills are identical to `assets/brand/ycoding-mark.svg`, so that file and this module stay in
 * sync with one design source.
 *
 * Coordinates are the 256x256 Penpot artboard. The artwork itself occupies the 176x176 square
 * between (40,40) and (216,216); `rasterizeBrandMark` normalises against that square so a mark
 * never carries the artboard's empty margin into the terminal.
 */

export const BRAND_INK = {
  /** Left stroke. Penpot fill #67D7A4. */
  stroke: "#67D7A4",
  /** Right stroke and stem. Penpot fill #F2F3F5. */
  stem: "#F2F3F5",
  /** The diamond where the strokes meet. Penpot fill #F0BE62. */
  joint: "#F0BE62",
} as const

export type BrandInk = keyof typeof BRAND_INK

const ART_ORIGIN = 40
const ART_SIZE = 176

// Painted back to front, matching the child order of the Penpot group: the stem covers the right
// stroke, and the joint diamond sits on top of both strokes.
const LAYERS: ReadonlyArray<{ ink: BrandInk; covers: (x: number, y: number) => boolean }> = [
  { ink: "stroke", covers: polygon([40, 40], [80, 40], [128, 104], [104, 136]) },
  { ink: "stem", covers: polygon([176, 40], [216, 40], [152, 136], [128, 104]) },
  { ink: "stem", covers: polygon([104, 112], [152, 112], [152, 216], [104, 216]) },
  // Penpot stores the diamond as a 24x24 rect rotated 45 degrees about (128,116); that is exactly
  // the set of points within an L1 distance of 12*sqrt(2) from the centre.
  { ink: "joint", covers: (x, y) => Math.abs(x - 128) + Math.abs(y - 116) <= 12 * Math.SQRT2 },
]

/** Samples per axis inside one half-cell. Nine samples resolve the diagonals without visible aliasing. */
const SUPERSAMPLE = 3

export type BrandCell = { char: string; ink: BrandInk }

/**
 * Rasterises the mark into terminal cells using half-block glyphs and foreground colour only, so
 * the terminal background shows through every cell the artwork does not paint.
 *
 * Each row samples two half-cells. A terminal cell is about twice as tall as it is wide, so half
 * cells are square and `columns === rows * 2` reproduces the artwork's square aspect.
 */
export function rasterizeBrandMark(columns: number, rows: number) {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column): BrandCell | undefined => {
      const top = sample(column, row * 2, columns, rows * 2)
      const bottom = sample(column, row * 2 + 1, columns, rows * 2)
      if (!top && !bottom) return undefined
      if (top && !bottom) return { char: "▀", ink: top.ink }
      if (bottom && !top) return { char: "▄", ink: bottom.ink }
      // Both halves are painted. A background colour would fill the cell, so the two inks cannot
      // both survive; keeping the solid block preserves the silhouette, which is what reads at
      // header size, and the wider coverage decides the colour.
      return { char: "█", ink: bottom!.coverage > top!.coverage ? bottom!.ink : top!.ink }
    }),
  )
}

/** Majority ink over one half-cell, or undefined when the artwork covers less than half of it. */
function sample(column: number, half: number, columns: number, halves: number) {
  const hits = new Map<BrandInk, number>()
  for (let sx = 0; sx < SUPERSAMPLE; sx++) {
    for (let sy = 0; sy < SUPERSAMPLE; sy++) {
      const x = ART_ORIGIN + ((column + (sx + 0.5) / SUPERSAMPLE) / columns) * ART_SIZE
      const y = ART_ORIGIN + ((half + (sy + 0.5) / SUPERSAMPLE) / halves) * ART_SIZE
      const ink = LAYERS.findLast((layer) => layer.covers(x, y))?.ink
      if (ink) hits.set(ink, (hits.get(ink) ?? 0) + 1)
    }
  }
  const total = Array.from(hits.values()).reduce((sum, count) => sum + count, 0)
  if (total * 2 < SUPERSAMPLE * SUPERSAMPLE) return undefined
  const best = Array.from(hits.entries()).reduce((a, b) => (b[1] > a[1] ? b : a))
  return { ink: best[0], coverage: total }
}

function polygon(...points: ReadonlyArray<readonly [number, number]>) {
  return (x: number, y: number) =>
    points.reduce((inside, point, index) => {
      const previous = points[(index + points.length - 1) % points.length]!
      const crosses = point[1] > y !== previous[1] > y
      if (!crosses) return inside
      const boundary = ((previous[0] - point[0]) * (y - point[1])) / (previous[1] - point[1]) + point[0]
      return x < boundary ? !inside : inside
    }, false)
}
