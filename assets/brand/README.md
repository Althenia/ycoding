# YCoding brand assets

Canonical design source: Penpot page **09 YCoding Brand**.

## Files

| File | Purpose |
| --- | --- |
| `ycoding-mark.svg` | Transparent canonical color mark. |
| `ycoding-mark-mono.svg` | One-color terminal and monochrome mark. |
| `ycoding-icon.svg` | Dark rounded-square release and repository icon with a centered Y spanning about 62% of the tile. |
| `ycoding-wordmark.svg` | Mark, `YCoding` wordmark, and terminal-product descriptor. |
| `ycoding-mark-256.png`, `ycoding-mark-512.png` | Transparent raster derivatives. |
| `ycoding-icon-192.png`, `ycoding-icon-256.png`, `ycoding-icon-512.png` | Dark app-icon raster derivatives; the generator also writes the 192px web manifest copy to `apps/web/public/icons`. |
| `ycoding-icon-maskable.svg`, `ycoding-icon-maskable-512.png` | Full-bleed dark icon with the branch Y scaled into the central 80% maskable safe zone, for installed web apps and home-screen icons that the platform masks. |

## Visual contract

- Trace: `#67D7A4`
- Frost: `#F2F3F5`
- Attention: `#F0BE62`
- Surface: `#24282F`
- Rule: `#3A404A`
- Canvas: `#1B1E23`

The color mark is a pixel Y in Trace. The app icons draw an original Y-shaped branch with an amber execution junction, and the monochrome mark is its one-color silhouette. Both must remain recognizable as the three-line terminal fallback:

```text
█   █
▀█ █▀
  █
```

Do not replace the mark with inherited upstream geometry or the previous calibration-W design.

## Regeneration

Run from the repository root:

```bash
bun run brand:generate
```

The generator reads the canonical SVG files and writes the committed PNG derivatives. Do not edit generated PNG files directly.
