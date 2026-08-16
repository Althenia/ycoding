# YCoding brand assets

Canonical design source: Penpot page **09 YCoding Brand**.

## Files

| File | Purpose |
| --- | --- |
| `ycoding-mark.svg` | Transparent canonical color mark. |
| `ycoding-mark-mono.svg` | One-color terminal and monochrome mark. |
| `ycoding-icon.svg` | Dark rounded-square release and repository icon. |
| `ycoding-wordmark.svg` | Mark, `YCoding` wordmark, and terminal-product descriptor. |
| `ycoding-mark-256.png`, `ycoding-mark-512.png` | Transparent raster derivatives. |
| `ycoding-icon-256.png`, `ycoding-icon-512.png` | Dark app-icon raster derivatives. |

## Visual contract

- Trace: `#67D7A4`
- Frost: `#F2F3F5`
- Attention: `#F0BE62`
- Surface: `#24282F`
- Rule: `#3A404A`
- Canvas: `#1B1E23`

The geometry is an original Y-shaped branch with an amber execution junction. It must remain recognizable as a one-color silhouette and as the three-line terminal fallback:

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
