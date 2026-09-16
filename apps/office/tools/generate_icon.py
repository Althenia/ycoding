"""Generate the app icon.

An exported client with no icon shows a generic blank app, so the icon is a
release artifact rather than decoration. It is produced here, deterministically
and with no third-party module, in the same style as `generate_art.py`: the
rasterizer writes PNG bytes directly with `struct` + `zlib`.

The palette is imported from `generate_art`, so the icon cannot drift from the
office it represents.

    python3 apps/office/tools/generate_icon.py
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Reusing the office palette is the point: the icon is the office at a glance.
from generate_art import (  # noqa: E402
    CARPET_A,
    METAL_D,
    P,
    SCREEN,
    SCREEN_D,
    WALL_BASE,
    WALL_FACE,
    WALL_TOP,
    WHITE_FURN,
    WHITE_FURN_D,
    WHITE_FURN_L,
    WOOD_D,
    WOOD_FLOOR,
    WOOD_L,
    WOOD_SEAM,
    shade,
)

SIDE = 512


class Canvas:
    """Minimal RGBA raster with hard-edged primitives; no external dependency."""

    def __init__(self, width: int, height: int) -> None:
        self.width = width
        self.height = height
        self.pixels = bytearray(width * height * 4)

    def set(self, x: int, y: int, color) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            offset = (y * self.width + x) * 4
            self.pixels[offset : offset + 4] = bytes(color)

    def rect(self, x: int, y: int, w: int, h: int, color) -> None:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.set(xx, yy, color)

    def to_png(self, path: Path) -> None:
        raw = bytearray()
        stride = self.width * 4
        for y in range(self.height):
            raw.append(0)
            raw.extend(self.pixels[y * stride : (y + 1) * stride])
        path.write_bytes(
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b"")
        )


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def build() -> Canvas:
    """A small office interior: a far wall with a window, a wood floor, a desk with
    two lit monitors, and a chair.

    Deliberately hard-edged and flat-shaded like the product's own art, but shaded
    rather than filled: each surface carries a gradient and a lit edge, because a
    handful of flat plates reads as a blank tile once the icon is scaled down.
    Every element keeps a margin, since an icon is read far smaller than drawn.
    """
    canvas = Canvas(SIDE, SIDE)

    canvas.rect(0, 0, SIDE, SIDE, WALL_TOP)

    wall_top = 64
    horizon = 252

    # The far wall, with a soft vertical gradient so it is not one flat field.
    for y in range(wall_top, horizon):
        t = (y - wall_top) / max(1, horizon - wall_top)
        canvas.rect(0, y, SIDE, 1, shade(WALL_FACE, int(round(-14 * t))))
    canvas.rect(0, wall_top, SIDE, 10, WALL_TOP)
    canvas.rect(0, wall_top + 10, SIDE, 4, shade(WALL_FACE, 8))
    canvas.rect(0, horizon - 16, SIDE, 16, WALL_BASE)
    canvas.rect(0, horizon - 16, SIDE, 4, shade(WALL_BASE, 10))

    # Floor: plank bands, each with a lit top edge and a darker seam, alternating
    # between the two approved tones so the grain reads at icon size.
    band = 36
    index = 0
    y = horizon
    while y < SIDE:
        tone = WOOD_FLOOR[index % len(WOOD_FLOOR)]
        canvas.rect(0, y, SIDE, band - 3, tone)
        canvas.rect(0, y, SIDE, 2, shade(tone, 12))
        canvas.rect(0, y + band - 3, SIDE, 3, WOOD_SEAM)
        # Plank ends, so the floor is boards rather than stripes.
        offset = (index * 137) % SIDE
        for joint in (offset, (offset + 256) % SIDE):
            canvas.rect(joint, y, 3, band - 3, shade(WOOD_SEAM, -18))
        y += band
        index += 1

    # The window: a bright sky with a frame, a mullion, and a lit sill.
    canvas.rect(164, 100, 184, 116, shade(WALL_BASE, -26))
    canvas.rect(170, 106, 172, 104, SCREEN)
    for y in range(106, 210):
        t = (y - 106) / 104.0
        canvas.rect(170, y, 172, 1, shade(SCREEN, int(round(26 * (1.0 - t)) - 10)))
    canvas.rect(170, 106, 172, 3, shade(SCREEN, 42))
    canvas.rect(252, 106, 8, 104, shade(SCREEN_D, 26))
    canvas.rect(170, 210, 172, 5, WALL_TOP)
    canvas.rect(158, 215, 196, 6, shade(WALL_BASE, 16))

    # The desk: top, lit front edge, and a shadowed apron.
    desk_top = 336
    canvas.rect(112, desk_top, 288, 26, WHITE_FURN)
    canvas.rect(112, desk_top, 288, 3, WHITE_FURN_L)
    canvas.rect(112, desk_top + 26, 288, 4, shade(WHITE_FURN, -18))
    canvas.rect(112, desk_top + 30, 288, 14, WHITE_FURN_D)
    canvas.rect(112, desk_top + 40, 288, 4, shade(WHITE_FURN_D, -24))

    # Two monitors standing on the desk, each a lit panel in a dark bezel with its
    # own stand, so they read as switched on rather than as blank rectangles.
    monitor_h = 84
    for x in (146, 280):
        canvas.rect(x, desk_top - monitor_h, 86, monitor_h, SCREEN_D)
        canvas.rect(x + 6, desk_top - monitor_h + 6, 74, monitor_h - 18, shade(SCREEN, -22))
        for y in range(desk_top - monitor_h + 6, desk_top - 12):
            t = (y - (desk_top - monitor_h)) / float(monitor_h)
            canvas.rect(x + 6, y, 74, 1, shade(SCREEN, int(round(-30 + 40 * t))))
        canvas.rect(x + 6, desk_top - monitor_h + 6, 74, 2, shade(SCREEN, 30))
        canvas.rect(x + 37, desk_top - 12, 12, 12, METAL_D)
        canvas.rect(x + 31, desk_top - 2, 24, 3, shade(METAL_D, 20))

    # A chair in front of the desk, with a back, a seat and a shadow line, giving
    # the composition a near plane instead of a flat elevation.
    seat = desk_top + 86
    canvas.rect(202, seat - 44, 108, 44, WOOD_D)
    canvas.rect(202, seat - 44, 108, 4, WOOD_L)
    canvas.rect(198, seat, 116, 18, shade(WOOD_D, 18))
    canvas.rect(198, seat, 116, 3, WOOD_L)
    canvas.rect(198, seat + 18, 116, 5, shade(WOOD_D, -22))
    canvas.rect(210, seat + 23, 10, 22, shade(WOOD_D, -30))
    canvas.rect(292, seat + 23, 10, 22, shade(WOOD_D, -30))

    return canvas


ART = HERE.parent / "office" / "art"


def main() -> None:
    out = ART
    build().to_png(out / "icon_512.png")
    print("wrote office/art/icon_512.png (%dx%d)" % (SIDE, SIDE))


if __name__ == "__main__":
    main()
