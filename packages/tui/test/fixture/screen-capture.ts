import type { CapturedFrame } from "@opentui/core"

export async function saveScreenCapture(name: string, screen: { frame: () => string; spans: () => CapturedFrame }) {
  const frame = screen.spans()
  await Promise.all([
    Bun.write(new URL(`../../.aphrodite/renders/${name}.txt`, import.meta.url), screen.frame()),
    Bun.write(
      new URL(`../../.aphrodite/renders/${name}.json`, import.meta.url),
      JSON.stringify({
        cols: frame.cols,
        rows: frame.rows,
        lines: frame.lines.map((line) =>
          line.spans.map((span) => ({
            text: span.text,
            width: span.width,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
            attributes: span.attributes,
          })),
        ),
      }),
    ),
  ])
}
