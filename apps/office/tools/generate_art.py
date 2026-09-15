#!/usr/bin/env python3
"""Generate the original YCoding Office pixel-art family.

Original in-house artwork: no third-party pack, so there is no licensing or
redistribution restriction. One coherent style sheet drives every asset.

Depth model (the key fidelity rule)
  This is a 3/4 top-down view, not a flat plan. Every solid object is drawn as a
  BOX: a lit top face plus a darker front face, with a shadow cast onto the floor
  behind/below it. Walls are tall boxes whose front face casts a shadow band onto
  the floor beneath them. Nothing is a single flat rectangle.

Silhouette rule
  Props are drawn as faces and interior seams only; a single `outline_silhouette`
  pass after the art gives every prop the same 2px dark rim, so no primitive can
  invent its own border weight. Tiled architecture (walls, doorway) opts out and
  draws its own edges, because a rim would repeat at every seam.

Ground rule
  The bottom edge of a prop canvas IS the ground contact line: office_world.gd
  places each sprite by its bottom edge. Props therefore grow upward only, and the
  bottom `FLOOR_ROWS` raster rows are reserved for the cast shadow.

Grid contract
  - Tile: 32x32
  - Character frame: 32x56, origin at the feet (bottom-centre)
  - Character directions: down, up, left, right (in that order)
  - Character rows: idle(2), walk(6), sit(2), type(2), read(2), talk(2)

Outputs (relative to --out, default apps/office/office/art):
  tiles_floor.png      floor materials atlas (wood x2, carpet x2, tile x2, concrete x2)
  wall_top.png         horizontal wall run: cap + face + skirting + floor shadow
  wall_side.png        vertical wall strip (left and right variants)
  door_frame.png       doorway with a visible frame, reveal and threshold
  prop_*.png           desks, chairs, plants, sofa, table, shelf, coffee, board, ...
  char_*.png           four role character sheets
"""
from __future__ import annotations
import argparse
import random
import struct
import zlib
from pathlib import Path

TILE = 32
CHAR_W, CHAR_H = 32, 56
DIRECTIONS = ("down", "up", "left", "right")
ROWS = (
    ("idle", 2),
    ("walk", 6),
    ("sit", 2),
    ("type", 2),
    ("read", 2),
    ("talk", 2),
)

# ── Bright, warm daylight palette (matching the approved reference board) ─────
P = {
    "outline": (58, 44, 38, 255),
    "shadow": (92, 74, 58, 68),
    "shadow_soft": (92, 74, 58, 40),
    "white": (250, 248, 242, 255),
    "white_d": (216, 212, 202, 255),
}

WOOD_FLOOR = [
    (232, 206, 166, 255),  # light warm plank
    (224, 196, 154, 255),
]
WOOD_SEAM = (198, 168, 124, 255)
CARPET_A = [(196, 198, 208, 255), (188, 190, 202, 255)]
CARPET_B = [(178, 186, 202, 255), (170, 179, 196, 255)]
CARPET_SEAM = (162, 165, 178, 255)
TILE_A = [(242, 238, 228, 255), (234, 229, 218, 255)]
TILE_SEAM = (214, 208, 196, 255)
CONCRETE = [(212, 209, 200, 255), (204, 201, 192, 255)]
CONCRETE_SEAM = (184, 181, 172, 255)

WALL_TOP = (244, 240, 234, 255)
WALL_FACE = (222, 214, 204, 255)
WALL_BASE = (196, 186, 174, 255)
WALL_TRIM = (186, 176, 164, 255)

WOOD_D = (150, 106, 66, 255)
WOOD = (192, 142, 92, 255)
WOOD_L = (226, 178, 124, 255)
WHITE_FURN_D = (206, 204, 200, 255)
WHITE_FURN = (236, 234, 230, 255)
WHITE_FURN_L = (250, 249, 246, 255)
METAL_D = (128, 134, 146, 255)
METAL = (162, 168, 182, 255)
METAL_L = (196, 202, 214, 255)
SCREEN_D = (54, 62, 82, 255)
SCREEN = (86, 152, 214, 255)
SCREEN_L = (150, 208, 246, 255)
LEAF_D = (58, 118, 72, 255)
LEAF = (86, 158, 96, 255)
LEAF_L = (120, 194, 122, 255)
POT_D = (176, 116, 88, 255)
POT = (208, 148, 110, 255)
FABRIC_BLUE_D = (96, 128, 190, 255)
FABRIC_BLUE = (134, 168, 222, 255)
FABRIC_PINK = (232, 168, 190, 255)
FABRIC_YELLOW = (240, 210, 130, 255)

# Material micro-tones derived from the palette, so props share one light model.
CABLE = (52, 50, 56, 255)
VOID = (126, 120, 115, 255)

ROLE_PALETTE = {
    "lead": {
        "shirt_d": (168, 68, 84, 255), "shirt": (206, 98, 114, 255), "shirt_l": (232, 138, 150, 255),
        "trouser_d": (72, 78, 100, 255), "trouser": (96, 104, 132, 255),
        "hair_d": (68, 46, 38, 255), "hair": (104, 72, 54, 255), "hair_l": (138, 100, 74, 255),
        "accent": (244, 206, 118, 255), "style": "short",
    },
    "backend": {
        "shirt_d": (54, 108, 168, 255), "shirt": (84, 146, 208, 255), "shirt_l": (126, 184, 232, 255),
        "trouser_d": (66, 72, 92, 255), "trouser": (90, 98, 122, 255),
        "hair_d": (52, 34, 26, 255), "hair": (88, 60, 44, 255), "hair_l": (124, 90, 66, 255),
        "accent": (140, 214, 246, 255), "style": "bun",
    },
    "frontend": {
        "shirt_d": (74, 132, 88, 255), "shirt": (108, 176, 122, 255), "shirt_l": (146, 210, 156, 255),
        "trouser_d": (84, 80, 70, 255), "trouser": (110, 106, 94, 255),
        "hair_d": (74, 48, 36, 255), "hair": (112, 76, 54, 255), "hair_l": (150, 108, 78, 255),
        "accent": (246, 190, 108, 255), "style": "wavy",
    },
    "qa": {
        "shirt_d": (118, 92, 162, 255), "shirt": (158, 128, 202, 255), "shirt_l": (192, 168, 226, 255),
        "trouser_d": (70, 72, 88, 255), "trouser": (96, 98, 116, 255),
        "hair_d": (44, 32, 30, 255), "hair": (74, 56, 50, 255), "hair_l": (108, 86, 76, 255),
        "accent": (240, 240, 140, 255), "style": "bob",
    },
}
SKIN = (238, 196, 158, 255)
SKIN_L = (250, 218, 184, 255)
SKIN_D = (198, 152, 116, 255)


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

    def outline_rect(self, x: int, y: int, w: int, h: int, color) -> None:
        for xx in range(x, x + w):
            self.set(xx, y, color)
            self.set(xx, y + h - 1, color)
        for yy in range(y, y + h):
            self.set(x, yy, color)
            self.set(x + w - 1, yy, color)

    def hline(self, x: int, y: int, w: int, color) -> None:
        for xx in range(x, x + w):
            self.set(xx, y, color)

    def vline(self, x: int, y: int, h: int, color) -> None:
        for yy in range(y, y + h):
            self.set(x, yy, color)

    def ellipse(self, cx: int, cy: int, rx: int, ry: int, color) -> None:
        for yy in range(cy - ry, cy + ry + 1):
            for xx in range(cx - rx, cx + rx + 1):
                dx = (xx - cx) / max(rx, 1)
                dy = (yy - cy) / max(ry, 1)
                if dx * dx + dy * dy <= 1.0:
                    self.set(xx, yy, color)

    def blend(self, x: int, y: int, color) -> None:
        """Composite one source-over pixel; used for glow and cast shadow overlap."""
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        src_a = color[3] / 255
        if src_a <= 0:
            return
        offset = (y * self.width + x) * 4
        dst_a = self.pixels[offset + 3] / 255
        out_a = src_a + dst_a * (1 - src_a)
        if out_a <= 0:
            return
        for index in range(3):
            self.pixels[offset + index] = round(
                (color[index] * src_a + self.pixels[offset + index] * dst_a * (1 - src_a)) / out_a
            )
        self.pixels[offset + 3] = round(out_a * 255)

    def blend_rect(self, x: int, y: int, w: int, h: int, color) -> None:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.blend(xx, yy, color)

    def blit(self, other: "Canvas", ox: int, oy: int) -> None:
        for y in range(other.height):
            for x in range(other.width):
                offset = (y * other.width + x) * 4
                if other.pixels[offset + 3] == 0:
                    continue
                self.set(ox + x, oy + y, other.pixels[offset : offset + 4])

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


# ── Shading helpers ──────────────────────────────────────────────────────────

def shade(color, delta: int):
    """Offset a palette entry while keeping its alpha."""
    return (
        max(0, min(255, color[0] + delta)),
        max(0, min(255, color[1] + delta)),
        max(0, min(255, color[2] + delta)),
        color[3] if len(color) > 3 else 255,
    )


def mix(a, b, t: float):
    """Blend two palette entries; the base alpha wins."""
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
        a[3] if len(a) > 3 else 255,
    )


def seam(base, t: float = 0.32):
    """An interior construction line: darker than the material, never black."""
    return mix(base, P["outline"], t)


def lit(base, t: float = 0.4):
    """A highlight edge catching the daylight from the upper left."""
    return mix(base, P["white"], t)


def box(c: Canvas, x: int, y: int, w: int, h: int, top, front, side_l, side_d, cap: int) -> None:
    """A 3/4 box: lit top face, darker front face, shaded side edges.

    `cap` is the height of the top face; the front face fills the rest. This is
    the single primitive that gives the whole scene its depth. It deliberately
    draws no border: the shared 2px rim comes from `outline_silhouette`.
    """
    face_y = y + cap
    c.rect(x, face_y, w, h - cap, front)
    c.rect(x, y, w, cap, top)
    c.hline(x, y, w, lit(top, 0.45))
    c.hline(x, face_y - 1, w, seam(top))
    c.hline(x, face_y, w, seam(front))
    c.vline(x, y, h, side_l)
    c.vline(x + w - 1, y, h, side_d)


def outline_silhouette(c: Canvas, color=P["outline"], thickness: int = 2) -> None:
    """Trace one consistent dark rim around the opaque art already on the canvas.

    Pixels that are already partly transparent (cast shadow, glow) count as
    background, so the rim lands on top of them and the shadow stays soft.
    """
    solid = bytearray(c.width * c.height)
    for y in range(c.height):
        row = y * c.width
        for x in range(c.width):
            if c.pixels[(row + x) * 4 + 3] >= 200:
                solid[row + x] = 1
    rim: set[int] = set()
    for y in range(c.height):
        for x in range(c.width):
            if not solid[y * c.width + x]:
                continue
            for dy in range(-thickness, thickness + 1):
                for dx in range(-thickness, thickness + 1):
                    # Skip the extreme diagonal so corners do not bulge.
                    if abs(dx) == thickness and abs(dy) == thickness:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < c.width and 0 <= ny < c.height:
                        rim.add(ny * c.width + nx)
    for index in rim:
        offset = index * 4
        if c.pixels[offset + 3] >= 200:
            continue
        c.pixels[offset : offset + 4] = bytes(color)


def leaf(c: Canvas, cx: int, cy: int, size: int, tone, highlight) -> None:
    """One pointed leaf: a filled diamond with a lit spine."""
    for dy in range(-size, size + 1):
        half = size - abs(dy)
        c.hline(cx - half, cy + dy, half * 2 + 1, tone)
    c.vline(cx, cy - size + 1, size, highlight)
    c.hline(cx - size // 2, cy - size // 2, size // 2 + 1, highlight)


# ── Character ────────────────────────────────────────────────────────────────

def _hair(c: Canvas, cx: int, head_y: int, direction: str, role: dict) -> None:
    style = role["style"]
    if direction == "up":
        c.rect(cx - 7, head_y - 1, 15, 12, role["hair"])
        c.rect(cx - 7, head_y - 1, 15, 4, role["hair_l"])
        c.hline(cx - 7, head_y + 10, 15, role["hair_d"])
    elif direction == "down":
        c.rect(cx - 7, head_y - 1, 15, 5, role["hair"])
        c.hline(cx - 7, head_y - 1, 15, role["hair_l"])
        c.rect(cx - 7, head_y - 1, 3, 9, role["hair"])
        c.rect(cx + 5, head_y - 1, 3, 9, role["hair"])
    else:
        c.rect(cx - 7, head_y - 1, 15, 5, role["hair"])
        c.hline(cx - 7, head_y - 1, 15, role["hair_l"])
        c.rect(cx - 7 if direction == "left" else cx + 4, head_y - 1, 3, 10, role["hair"])
    if style == "bun":
        c.rect(cx - 3, head_y - 4, 6, 4, role["hair_d"])
        c.hline(cx - 3, head_y - 4, 6, role["hair"])
    if style == "bob":
        c.rect(cx - 7, head_y + 3, 3, 8, role["hair"])
        c.rect(cx + 5, head_y + 3, 3, 8, role["hair"])
    if style == "wavy":
        c.rect(cx - 7, head_y + 3, 3, 4, role["hair_l"])
        c.rect(cx + 5, head_y + 3, 3, 4, role["hair_l"])


def _head(c: Canvas, cx: int, head_y: int, direction: str, role: dict) -> None:
    c.rect(cx - 7, head_y, 15, 14, SKIN)
    c.outline_rect(cx - 7, head_y, 15, 14, P["outline"])
    # Light from the upper-left, shade on the right.
    c.vline(cx - 6, head_y + 1, 12, SKIN_L)
    c.hline(cx - 6, head_y + 1, 5, SKIN_L)
    c.vline(cx + 6, head_y + 1, 12, SKIN_D)
    c.rect(cx - 3, head_y + 14, 7, 3, SKIN_D)
    if direction == "down":
        c.rect(cx - 5, head_y + 7, 3, 3, P["outline"])
        c.rect(cx + 3, head_y + 7, 3, 3, P["outline"])
        c.hline(cx - 2, head_y + 11, 5, (190, 130, 116, 255))
    elif direction == "left":
        c.rect(cx - 6, head_y + 7, 3, 3, P["outline"])
        c.hline(cx - 7, head_y + 11, 5, (190, 130, 116, 255))
    elif direction == "right":
        c.rect(cx + 4, head_y + 7, 3, 3, P["outline"])
        c.hline(cx + 3, head_y + 11, 5, (190, 130, 116, 255))


def draw_character(frame: str, direction: str, variant: int, role: dict) -> Canvas:
    c = Canvas(CHAR_W, CHAR_H)
    cx = CHAR_W // 2
    ground = CHAR_H - 2
    seated = frame in ("sit", "type", "read")
    side = direction in ("left", "right")

    c.rect(cx - 9, ground - 2, 18, 3, P["shadow"])

    swing = (0, -3, -4, 0, 3, 4)[variant % 6] if frame == "walk" else 0
    bob = 1 if frame == "walk" and variant % 6 in (2, 5) else 0

    torso_h = 19 - bob
    torso_y = ground - 8 - torso_h if not seated else ground - 22
    if seated:
        torso_h = 16
    body_w = 12 if side else 17
    body_x = cx - body_w // 2

    if seated:
        c.rect(cx - 6, torso_y + torso_h, 13, 6, role["trouser"])
        c.rect(cx - 6, torso_y + torso_h + 5, 13, 3, P["outline"])
        c.rect(cx - 6, torso_y + torso_h, 13, 2, role["trouser_d"])
    else:
        leg_y = torso_y + torso_h
        c.rect(cx - 6 + swing // 2, leg_y, 5, 7, role["trouser"])
        c.rect(cx + 2 - swing // 2, leg_y, 5, 7, role["trouser"])
        c.vline(cx - 6 + swing // 2, leg_y, 7, role["trouser_d"])
        c.vline(cx + 2 - swing // 2, leg_y, 7, role["trouser_d"])
        c.rect(cx - 7 + swing // 2, ground - 3, 7, 3, P["outline"])
        c.rect(cx + 1 - swing // 2, ground - 3, 7, 3, P["outline"])

    # Torso with a lit left edge and shaded right edge.
    c.rect(body_x, torso_y, body_w, torso_h, role["shirt"])
    c.outline_rect(body_x, torso_y, body_w, torso_h, P["outline"])
    c.vline(body_x + 1, torso_y + 1, torso_h - 2, role["shirt_l"])
    c.vline(body_x + body_w - 2, torso_y + 1, torso_h - 2, role["shirt_d"])
    c.hline(body_x + 3, torso_y + 1, body_w - 6, role["shirt_d"])
    c.hline(body_x + 3, torso_y + 4, body_w - 6, role["accent"])

    arm_len = 12
    arm_y = torso_y + 3
    if frame == "type":
        for ax in (body_x - 4, body_x + body_w + 1):
            c.rect(ax, arm_y + 4, 4, 6, role["shirt"])
            c.rect(ax, arm_y + 8, 4, 3, SKIN)
    elif frame == "read":
        for ax in (body_x - 4, body_x + body_w + 1):
            c.rect(ax, arm_y + 3, 4, 8, role["shirt"])
            c.rect(ax, arm_y + 9, 4, 3, SKIN)
        c.rect(cx - 7, torso_y + 9, 15, 9, P["white"])
        c.outline_rect(cx - 7, torso_y + 9, 15, 9, P["outline"])
        c.hline(cx - 4, torso_y + 12, 9, P["white_d"])
        c.hline(cx - 4, torso_y + 15, 9, P["white_d"])
    elif frame == "talk":
        lift = 4 if variant % 2 == 0 else 0
        c.rect(body_x - 4, arm_y - lift, 4, arm_len - 2, role["shirt"])
        c.rect(body_x - 4, arm_y - lift, 4, 3, role["shirt_l"])
        c.rect(body_x - 4, arm_y - lift + arm_len - 2, 4, 3, SKIN)
        c.rect(body_x + body_w + 1, arm_y + 2, 4, arm_len - 2, role["shirt"])
        c.rect(body_x + body_w + 1, arm_y + arm_len, 4, 3, SKIN)
    else:
        for ax in (body_x - 4, body_x + body_w + 1):
            c.rect(ax, arm_y, 4, arm_len + swing // 2, role["shirt"])
            c.vline(ax, arm_y, arm_len, role["shirt_l"])
            c.rect(ax, arm_y + arm_len - 3, 4, 3, SKIN)

    head_y = torso_y - 14 + bob
    _head(c, cx, head_y, direction, role)
    _hair(c, cx, head_y, direction, role)
    return c


def build_character_sheet(role_name: str) -> Canvas:
    role = ROLE_PALETTE[role_name]
    rows = sum(count for _, count in ROWS)
    sheet = Canvas(TILE * len(DIRECTIONS), CHAR_H * rows)
    row = 0
    for frame, count in ROWS:
        for variant in range(count):
            for column, direction in enumerate(DIRECTIONS):
                sheet.blit(draw_character(frame, direction, variant, role), column * TILE, row * CHAR_H)
            row += 1
    return sheet


# ── Ground plane ─────────────────────────────────────────────────────────────

FLOOR_ROWS = 5


def art_bottom(height: int) -> int:
    """Last raster row a prop body may occupy; the rows beneath it are floor.

    The sprite's bottom edge is the ground contact line that office_world.gd
    places props by, so props only ever grow upward from here.
    """
    return height - 1 - FLOOR_ROWS


def ground_shadow(c: Canvas, x0: int, x1: int, base: int) -> None:
    """Cast shadow pooling on the floor under a prop, biased to the lower right."""
    width = x1 - x0 + 1
    c.rect(x0 - 3, base - 1, width + 7, c.height - base + 1, P["shadow_soft"])
    c.rect(x0 - 1, base + 1, width + 4, c.height - base - 2, P["shadow"])


# ── Environment ──────────────────────────────────────────────────────────────

def build_floor_tiles() -> Canvas:
    """Atlas: 0-1 wood, 2-3 carpet A, 4-5 carpet B, 6-7 tile, 8 concrete."""
    materials = [
        (WOOD_FLOOR, WOOD_SEAM, True),
        (CARPET_A, CARPET_SEAM, False),
        (CARPET_B, CARPET_SEAM, False),
        (TILE_A, TILE_SEAM, True),
        (CONCRETE, CONCRETE_SEAM, False),
    ]
    cols = 9
    sheet = Canvas(TILE * cols, TILE)
    index = 0
    for tones, seam_col, plank in materials:
        for tone in tones:
            x = index * TILE
            sheet.rect(x, 0, TILE, TILE, tone)
            if plank:
                sheet.hline(x, 15, TILE, seam_col)
                sheet.vline(x + 15, 0, 15, seam_col)
                sheet.vline(x + 7, 16, 16, seam_col)
            else:
                # Woven carpet: a fine diagonal tooth.
                for step in range(0, TILE, 8):
                    sheet.vline(x + step, 0, 3, seam_col)
                    sheet.vline(x + step + 4, 4, 3, seam_col)
            index += 1
    return sheet


def _wall_joint(c: Canvas, x: int, top: int, bottom: int) -> None:
    """A construction joint: a recessed seam with a lit bevel on its right.

    Drawn instead of a hard line so a repeated wall run reads as panelled
    construction rather than as a fence post every 32 pixels.
    """
    c.vline(x, top, bottom, seam(WALL_FACE, 0.36))
    c.vline(x + 1, top, bottom, mix(WALL_FACE, WALL_BASE, 0.55))
    c.vline(x + 2, top, bottom, lit(mix(WALL_FACE, WALL_BASE, 0.4), 0.35))


def build_wall_top() -> Canvas:
    """A horizontal wall run drawn top-down in 3/4 view.

    A wall is a thick band, not a line: a wide lit cap the viewer looks down onto,
    a tall panelled face with a skirting shadow at the floor contact, then the
    shadow it casts onto the floor below. Height 56 = 16 cap + 32 face + 8 cast
    shadow, so it reads as a solid wall rather than a fence. The run tiles
    horizontally, so no pixel touches the left/right edge except the cap bevel.
    """
    w = TILE * 4
    c = Canvas(w, 56)
    c.rect(0, 0, w, 16, WALL_TOP)
    c.hline(0, 0, w, P["white"])
    c.hline(0, 1, w, P["white"])
    c.hline(0, 2, w, lit(WALL_TOP, 0.25))
    c.hline(0, 13, w, mix(WALL_TOP, WALL_TRIM, 0.6))
    c.hline(0, 14, w, WALL_TRIM)
    c.hline(0, 15, w, seam(WALL_TRIM, 0.28))
    c.rect(0, 16, w, 32, WALL_FACE)
    c.hline(0, 16, w, P["white"])
    c.hline(0, 17, w, lit(WALL_FACE, 0.35))
    c.hline(0, 18, w, lit(WALL_FACE, 0.12))
    # Skirting: a slightly proud baseboard with its own top shadow.
    c.hline(0, 38, w, seam(WALL_FACE, 0.16))
    c.rect(0, 39, w, 8, mix(WALL_FACE, WALL_BASE, 0.72))
    c.hline(0, 39, w, lit(mix(WALL_FACE, WALL_BASE, 0.72), 0.18))
    c.hline(0, 46, w, mix(WALL_BASE, P["outline"], 0.35))
    c.hline(0, 47, w, mix(WALL_BASE, P["outline"], 0.5))
    c.rect(0, 48, w, 8, P["shadow_soft"])
    c.rect(0, 48, w, 2, P["shadow"])
    for x in range(0, w, TILE):
        _wall_joint(c, x, 16, 32)
    return c


def build_wall_side() -> Canvas:
    """Vertical wall strip, 22 wide: lit cap edge, panelled face, cast shadow.

    Stacked every two tiles, so the top and bottom rows are seams: the joint
    treatment repeats every 64 pixels and the face colour carries across.
    """
    c = Canvas(22, TILE * 2)
    c.rect(0, 0, 16, TILE * 2, WALL_FACE)
    c.rect(0, 0, 8, TILE * 2, WALL_TOP)
    c.rect(0, 0, 2, TILE * 2, P["white"])
    c.vline(2, 0, TILE * 2, lit(WALL_TOP, 0.22))
    c.vline(7, 0, TILE * 2, mix(WALL_TOP, WALL_TRIM, 0.6))
    c.vline(8, 0, TILE * 2, seam(WALL_TRIM, 0.3))
    c.vline(9, 0, TILE * 2, lit(WALL_FACE, 0.3))
    # Baseboard on the visible long side, then the contact shadow.
    c.vline(13, 0, TILE * 2, seam(WALL_FACE, 0.14))
    c.rect(14, 0, 2, TILE * 2, mix(WALL_FACE, WALL_BASE, 0.72))
    c.vline(15, 0, TILE * 2, WALL_BASE)
    c.rect(16, 0, 6, TILE * 2, P["shadow_soft"])
    c.rect(16, 0, 2, TILE * 2, P["shadow"])
    # Horizontal construction joint repeated once per strip.
    c.hline(9, 1, 7, seam(WALL_FACE, 0.36))
    c.hline(9, 2, 7, lit(mix(WALL_FACE, WALL_BASE, 0.4), 0.35))
    return c


def build_door_frame() -> Canvas:
    """Doorway: a wall run with a gap, jambs, a reveal and a threshold.

    Kept at the wall run's 56px height because the world places it by height.
    """
    c = Canvas(TILE * 2, 56)
    for x in range(0, TILE * 2, TILE):
        c.rect(x, 0, TILE, 16, WALL_TOP)
    c.hline(0, 0, TILE * 2, P["white"])
    c.hline(0, 1, TILE * 2, P["white"])
    c.hline(0, 14, TILE * 2, WALL_TRIM)
    c.hline(0, 15, TILE * 2, seam(WALL_TRIM, 0.28))
    c.rect(0, 16, TILE * 2, 32, WALL_FACE)
    c.hline(0, 16, TILE * 2, P["white"])
    c.hline(0, 17, TILE * 2, lit(WALL_FACE, 0.3))
    # Lit corridor seen through the opening, so the gap reads as depth.
    c.rect(12, 16, TILE * 2 - 24, 24, lit(WALL_FACE, 0.2))
    c.rect(12, 16, TILE * 2 - 24, 4, lit(WALL_FACE, 0.4))
    c.hline(12, 39, TILE * 2 - 24, seam(WALL_FACE, 0.2))
    # Door posts with a bevel, plus the reveal each jamb casts into the opening.
    c.rect(0, 0, 8, 48, WALL_FACE)
    c.rect(TILE * 2 - 8, 0, 8, 48, WALL_FACE)
    c.rect(0, 0, 8, 4, P["white"])
    c.vline(1, 0, 48, lit(WALL_FACE, 0.35))
    c.vline(TILE * 2 - 8, 0, 48, lit(WALL_FACE, 0.2))
    c.vline(7, 16, 32, seam(WALL_FACE, 0.3))
    c.vline(8, 16, 32, seam(WALL_FACE, 0.45))
    c.vline(9, 16, 32, P["shadow"])
    c.vline(TILE * 2 - 8, 16, 32, seam(WALL_FACE, 0.45))
    c.vline(TILE * 2 - 9, 16, 32, P["shadow"])
    # Threshold: a metal strip with a lit nose and a shadow at the floor line.
    c.rect(10, 40, TILE * 2 - 20, 8, (188, 158, 122, 255))
    c.hline(10, 40, TILE * 2 - 20, lit((188, 158, 122, 255), 0.35))
    c.hline(10, 43, TILE * 2 - 20, seam((188, 158, 122, 255), 0.3))
    c.hline(10, 47, TILE * 2 - 20, mix(WALL_BASE, P["outline"], 0.45))
    c.rect(0, 48, TILE * 2, 8, P["shadow_soft"])
    c.rect(0, 48, TILE * 2, 2, P["shadow"])
    c.hline(0, 46, 10, mix(WALL_BASE, P["outline"], 0.4))
    c.hline(TILE * 2 - 10, 46, 10, mix(WALL_BASE, P["outline"], 0.4))
    # Skirting stops against the posts, exactly as on a wall run.
    for x in (8, TILE * 2 - 10):
        c.vline(x, 38, 8, seam(WALL_FACE, 0.5))
    c.hline(8, 38, TILE * 2 - 16, seam(WALL_FACE, 0.16))
    return c


# ── Props ────────────────────────────────────────────────────────────────────

def _monitor(c: Canvas, x: int, y: int, w: int, h: int) -> None:
    """A monitor standing on the worktop: bezel, lit screen, stand, spill."""
    box(c, x, y, w, h, METAL_L, METAL_D, METAL_L, METAL_D, 4)
    sx, sy = x + 3, y + 5
    sw, sh = w - 6, h - 10
    c.rect(sx, sy, sw, sh, SCREEN_D)
    c.rect(sx + 1, sy + 1, sw - 2, sh - 2, SCREEN)
    c.hline(sx + 2, sy + 3, max(4, sw - 12), SCREEN_L)
    for index, inset in enumerate((6, 10, 14, 18)):
        c.hline(sx + 2, sy + 4 + index * 3, max(4, sw - inset), mix(SCREEN, P["white"], 0.32))
    c.vline(sx + 2, sy + 4, sh - 6, mix(SCREEN_L, P["white"], 0.4))
    # Stand: neck and base plate stand on the worktop, so they overlap its face.
    c.rect(x + w // 2 - 3, y + h, 6, 9, METAL_D)
    c.vline(x + w // 2 - 3, y + h, 9, METAL_L)
    c.rect(x + 8, y + h + 9, w - 16, 4, METAL)
    c.hline(x + 8, y + h + 9, w - 16, METAL_L)
    c.hline(x + 8, y + h + 12, w - 16, shade(METAL_D, -20))
    c.blend_rect(x + 3, y + h + 8, w - 6, 4, (120, 190, 240, 34))


def build_desk() -> Canvas:
    """Wide desk: dual monitors, grained worktop, drawer pedestal, cable run."""
    w, h = TILE * 3, 96
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 3, w - 4, base)
    # Worktop: a deep lit top face over the front face that carries the drawers.
    box(c, 3, 46, w - 6, base - 46 + 1, WHITE_FURN_L, WHITE_FURN_D, P["white"], WHITE_FURN_D, 18)
    rng = random.Random(17)
    for gy in range(49, 62, 3):
        c.hline(6 + rng.randint(0, 5), gy, w - 14 - rng.randint(0, 14), mix(WHITE_FURN_L, WOOD, 0.22))
    c.hline(6, 62, w - 12, mix(WHITE_FURN_D, WOOD, 0.3))
    c.hline(4, 47, w - 8, lit(WHITE_FURN_L, 0.5))
    # Under-desk void, so the desk reads as a table on a pedestal.
    c.rect(4, 68, 44, base - 68 + 1, VOID)
    c.hline(4, 68, 44, seam(WHITE_FURN_D, 0.5))
    c.vline(4, 68, base - 68, seam(WHITE_FURN_D, 0.35))
    c.blend_rect(5, 70, 42, 10, (40, 34, 30, 46))
    # Steel legs with floor pads.
    for lx in (5, 41):
        c.rect(lx, 66, 6, base - 66 + 1, METAL_D)
        c.vline(lx, 66, base - 66, METAL_L)
        c.rect(lx - 1, base - 3, 8, 3, shade(METAL_D, -52))
    # Cable tray and the run of leads down to the floor.
    c.rect(4, 66, 45, 5, shade(METAL_D, -40))
    c.hline(4, 66, 45, METAL)
    c.hline(4, 70, 45, shade(METAL_D, -70))
    for cable_x, drop in ((13, 15), (18, 12), (23, 16)):
        c.rect(cable_x, 71, 2, drop, CABLE)
        c.rect(cable_x, 71 + drop, 10, 2, CABLE)
    c.rect(22, base - 4, 22, 5, WHITE_FURN)
    c.hline(22, base - 4, 22, WHITE_FURN_L)
    c.hline(22, base, 22, shade(WHITE_FURN_D, -30))
    for socket_x in (26, 35):
        c.rect(socket_x, base - 1, 4, 2, (110, 108, 112, 255))
    # Pedestal with three drawers and metal handles.
    box(c, 50, 64, 43, base - 64 + 1, WHITE_FURN, WHITE_FURN_D, P["white"], WHITE_FURN_D, 6)
    for dy in (70, 77, 84):
        c.rect(54, dy, 35, 6, WHITE_FURN)
        c.outline_rect(54, dy, 35, 6, seam(WHITE_FURN_D, 0.5))
        c.hline(55, dy + 1, 33, WHITE_FURN_L)
        c.rect(83, dy + 2, 5, 3, METAL)
        c.hline(83, dy + 2, 5, METAL_L)
        c.hline(83, dy + 4, 5, shade(METAL_D, -30))
    # Desktop kit: keyboard, mug, notebook. These are the real scale cues.
    c.rect(26, 54, 30, 7, (60, 58, 62, 255))
    c.hline(26, 54, 30, (104, 102, 108, 255))
    for key_x in range(28, 53, 3):
        c.rect(key_x, 56, 2, 2, (152, 150, 156, 255))
    c.rect(28, 60, 26, 2, CABLE)
    c.rect(61, 52, 8, 10, WHITE_FURN)
    c.hline(61, 52, 8, P["white"])
    c.rect(61, 54, 8, 5, mix(WHITE_FURN, SCREEN, 0.2))
    c.rect(69, 54, 3, 4, WHITE_FURN)
    c.rect(8, 53, 16, 7, mix(WHITE_FURN_L, FABRIC_YELLOW, 0.4))
    c.hline(9, 54, 14, mix(WHITE_FURN_L, FABRIC_YELLOW, 0.15))
    c.rect(11, 61, 12, 2, FABRIC_BLUE)
    _monitor(c, 6, 2, 36, 38)
    _monitor(c, 54, 2, 36, 38)
    outline_silhouette(c)
    return c


def build_chair() -> Canvas:
    """Task chair: backrest seam, gas lift, five-star base with casters."""
    c = Canvas(TILE, 44)
    base = art_bottom(44)
    ground_shadow(c, 3, 28, base)
    seat_fabric = mix(FABRIC_BLUE, P["white"], 0.26)
    # Backrest: lit cap, canvas face, centre seam and a lumbar stitch.
    box(c, 7, 2, 18, 22, seat_fabric, FABRIC_BLUE, seat_fabric, FABRIC_BLUE_D, 6)
    c.vline(15, 4, 19, seam(FABRIC_BLUE_D, 0.4))
    c.hline(9, 12, 14, seam(FABRIC_BLUE_D, 0.28))
    c.hline(9, 9, 14, mix(FABRIC_BLUE, P["white"], 0.18))
    # Seat pan, with the front edge lip a chair always has.
    box(c, 5, 22, 22, 10, seat_fabric, FABRIC_BLUE_D, seat_fabric, FABRIC_BLUE_D, 4)
    c.hline(7, 24, 18, lit(FABRIC_BLUE, 0.4))
    c.hline(6, 31, 20, seam(FABRIC_BLUE_D, 0.5))
    # Gas lift.
    c.rect(13, 31, 6, 5, METAL_D)
    c.vline(14, 31, 5, METAL_L)
    c.rect(12, 30, 8, 2, seam(METAL_D, 0.45))
    # Five-star base: hub, two visible spokes, five casters in perspective.
    c.rect(12, 35, 8, 3, METAL)
    c.hline(12, 35, 8, METAL_L)
    c.rect(4, 35, 9, 3, METAL_D)
    c.rect(19, 35, 9, 3, METAL_D)
    c.hline(5, 35, 7, METAL)
    c.hline(20, 35, 7, METAL)
    for caster_x in (4, 9, 14, 19, 24):
        c.rect(caster_x, 37, 3, 2, (74, 78, 86, 255))
    outline_silhouette(c)
    return c


def build_plant() -> Canvas:
    """Potted plant: three leaf tones with lit edges over a cylindrical pot."""
    c = Canvas(TILE, 44)
    base = art_bottom(44)
    ground_shadow(c, 7, 25, base)
    # Stem first, so the canopy is anchored rather than floating.
    c.rect(15, 12, 3, 14, seam(LEAF_D, 0.35))
    leaves = (
        (16, 15, 8, LEAF_D), (8, 13, 6, LEAF_D), (23, 14, 6, LEAF_D),
        (10, 9, 5, LEAF), (17, 9, 6, LEAF), (23, 8, 5, LEAF), (13, 17, 4, LEAF),
        (13, 6, 4, LEAF_L), (20, 5, 3, LEAF_L), (8, 15, 3, LEAF_L), (24, 11, 3, LEAF_L),
    )
    for lx, ly, size, tone in leaves:
        leaf(c, lx, ly, size, tone, lit(tone, 0.55))
    # Pot: lit rim disc, cylinder body, shaded right wall, contact base.
    c.ellipse(16, 24, 10, 3, POT)
    c.rect(7, 24, 19, 12, POT)
    c.vline(7, 25, 11, seam(POT_D, 0.25))
    c.vline(9, 25, 11, lit(POT, 0.45))
    c.rect(21, 25, 5, 11, POT_D)
    c.vline(24, 25, 11, seam(POT_D, 0.35))
    c.ellipse(16, 36, 9, 2, POT_D)
    c.ellipse(16, 23, 10, 3, lit(POT, 0.3))
    c.hline(7, 26, 19, seam(POT, 0.2))
    c.ellipse(16, 23, 7, 2, (94, 70, 54, 255))
    c.rect(12, 22, 2, 1, mix(POT, P["white"], 0.5))
    outline_silhouette(c)
    return c


def _sofa_tones():
    seat_top = mix(FABRIC_YELLOW, P["white"], 0.3)
    seat_front = (212, 178, 104, 255)
    return seat_top, seat_front, mix(seat_front, P["outline"], 0.24)


def build_sofa() -> Canvas:
    """Three-seat sofa: backrest, cushion seams, two armrests, throw cushion."""
    w, h = TILE * 3, 72
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 4, w - 5, base)
    seat_top, seat_front, frame = _sofa_tones()
    # Backrest: lit cap over a taller front face, split into three cushions.
    box(c, 8, 4, w - 16, 31, seat_top, mix(seat_front, P["outline"], 0.07), seat_top, seat_front, 10)
    for sx in (38, 58):
        c.vline(sx, 16, 16, seam(frame, 0.5))
    c.hline(10, 22, w - 20, seam(seat_front, 0.3))
    c.hline(9, 6, w - 18, lit(seat_top, 0.5))
    # Seat: three cushions with seams and a front lip.
    box(c, 6, 34, w - 12, 21, mix(FABRIC_YELLOW, P["white"], 0.2), seat_front, seat_top, seat_front, 8)
    for sx in (34, 62):
        c.vline(sx, 36, 12, seam(frame, 0.5))
    c.hline(8, 42, w - 16, seam(seat_front, 0.45))
    c.hline(7, 43, w - 14, lit(seat_top, 0.3))
    # Base skirt and feet.
    c.rect(6, 54, w - 12, 12, mix(seat_front, P["outline"], 0.18))
    c.hline(6, 54, w - 12, seam(seat_front, 0.42))
    for foot_x in (12, 44, 76):
        c.rect(foot_x, 64, 8, 3, WOOD_D)
        c.hline(foot_x, 64, 8, WOOD)
    # Armrests drawn last: they sit in front and cap the ends of the sofa.
    for arm_x in (2, w - 16):
        box(c, arm_x, 12, 14, 54, seat_top, mix(seat_front, P["outline"], 0.1), seat_top, seat_front, 6)
        c.ellipse(arm_x + 7, 13, 6, 3, lit(seat_top, 0.45))
        c.hline(arm_x + 1, 20, 12, seam(seat_front, 0.35))
        c.vline(arm_x + 13, 14, 50, seam(seat_front, 0.4))
    # Throw cushion, so the sofa does not read as one slab.
    box(c, 62, 24, 17, 16, FABRIC_PINK, (206, 142, 166, 255), lit(FABRIC_PINK, 0.35), FABRIC_PINK, 5)
    c.vline(70, 28, 8, seam(FABRIC_PINK, 0.3))
    outline_silhouette(c)
    return c


def build_table() -> Canvas:
    """Meeting table: grained top, four legs, contact shadows at the feet."""
    w, h = TILE * 2, 68
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 4, w - 5, base)
    # Rear legs poke above the top's back edge; the top hides the rest of them.
    for leg_x in (14, 44):
        c.rect(leg_x, 2, 6, 12, WOOD_D)
        c.vline(leg_x, 2, 12, WOOD)
    # Top: a deep lit face with grain over a thin front edge band.
    box(c, 4, 8, w - 8, 33, WOOD_L, WOOD_D, WOOD_L, WOOD_D, 27)
    rng = random.Random(31)
    for gy in range(12, 33, 4):
        c.hline(7 + rng.randint(0, 5), gy, w - 16 - rng.randint(0, 12), mix(WOOD_L, WOOD, 0.34))
        c.hline(9 + rng.randint(0, 6), gy + 1, max(6, w - 30 - rng.randint(0, 10)), mix(WOOD_L, WOOD, 0.16))
    c.ellipse(22, 20, 3, 2, mix(WOOD_L, WOOD, 0.45))
    c.ellipse(45, 27, 2, 1, mix(WOOD_L, WOOD, 0.45))
    c.hline(6, 12, w - 12, lit(WOOD_L, 0.45))
    c.hline(5, 35, w - 10, seam(WOOD_D, 0.35))
    c.hline(5, 40, w - 10, seam(WOOD_D, 0.5))
    # Front legs, lit on the left, with their own contact shadow.
    for leg_x in (10, 47):
        c.rect(leg_x, 36, 7, base - 36, WOOD_D)
        c.vline(leg_x, 36, base - 36, WOOD)
        c.vline(leg_x + 1, 36, base - 36, WOOD_L)
        c.ellipse(leg_x + 3, base - 1, 5, 2, P["shadow"])
    outline_silhouette(c)
    return c


def _recess(c: Canvas, x: int, y: int, w: int, h: int) -> None:
    """One shelf bay: a dark interior, a shadowed ceiling, a lit board."""
    c.rect(x, y, w, h, (150, 104, 66, 255))
    c.rect(x, y + 1, w, 3, mix(WOOD_D, P["outline"], 0.45))
    c.rect(x, y + 4, w, h - 8, (126, 84, 54, 255))
    c.rect(x, y + h - 4, w, 4, WOOD_L)
    c.hline(x, y + h - 4, w, lit(WOOD_L, 0.4))
    c.hline(x, y + h - 1, w, seam(WOOD_D, 0.4))
    c.vline(x, y + 4, h - 8, seam(WOOD_D, 0.45))
    c.vline(x + w - 1, y + 4, h - 8, seam(WOOD_D, 0.45))


def _books(c: Canvas, x0: int, x1: int, shelf_y: int, seed: int) -> None:
    """Fill one bay with varied book spines, gaps and a leaning pair."""
    rng = random.Random(seed)
    tones = (FABRIC_BLUE, FABRIC_PINK, FABRIC_YELLOW, LEAF, (206, 120, 96, 255), (152, 130, 198, 255))
    x = x0
    while x < x1 - 3:
        if rng.random() < 0.16:
            x += rng.randint(2, 4)
            continue
        width = rng.choice((3, 4, 4, 5))
        height = rng.randint(8, 14)
        tone = tones[rng.randrange(len(tones))]
        c.rect(x, shelf_y - height, width, height, tone)
        c.hline(x, shelf_y - height, width, lit(tone, 0.4))
        c.vline(x + width - 1, shelf_y - height, height, seam(tone, 0.4))
        c.hline(x, shelf_y - 3, width, seam(tone, 0.3))
        x += width
    # A leaning pair, drawn as a two-row-per-step slant so spines still read.
    lean_x = rng.randint(x0 + 4, max(x0 + 5, x1 - 12))
    lean_h = rng.randint(10, 13)
    for step in range(lean_h // 2):
        c.rect(lean_x + step, shelf_y - 2 - step * 2, 4, 2, FABRIC_BLUE_D)
    c.hline(lean_x, shelf_y - 2, 4, mix(FABRIC_BLUE_D, P["white"], 0.35))


def build_shelf() -> Canvas:
    """Low shelf unit: three recessed bays, mixed book heights, top clutter."""
    w, h = TILE * 2, 72
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 4, w - 5, base)
    box(c, 3, 4, w - 6, base - 4 + 1, WOOD_L, WOOD_D, mix(WOOD_L, P["white"], 0.3), WOOD_D, 8)
    for index in range(3):
        bay_y = 13 + index * 17
        _recess(c, 7, bay_y, w - 14, 15)
        _books(c, 9, w - 11, bay_y + 11, 410 + index)
    c.hline(5, 6, w - 10, lit(WOOD_L, 0.5))
    # Top clutter: a stack of books and a small potted plant.
    c.rect(9, 5, 18, 4, FABRIC_BLUE)
    c.hline(9, 5, 18, lit(FABRIC_BLUE, 0.4))
    c.rect(10, 9, 16, 3, FABRIC_PINK)
    c.hline(10, 9, 16, lit(FABRIC_PINK, 0.4))
    c.rect(44, 8, 10, 4, POT)
    c.ellipse(49, 7, 7, 3, LEAF_D)
    c.ellipse(47, 6, 5, 3, LEAF)
    c.ellipse(51, 5, 4, 3, LEAF_L)
    outline_silhouette(c)
    return c


def build_bookshelf() -> Canvas:
    """Tall bookcase: four recessed bays, mixed book heights, crown and plinth."""
    w, h = TILE * 2, 88
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 4, w - 5, base)
    box(c, 3, 4, w - 6, base - 4 + 1, WOOD_L, WOOD_D, mix(WOOD_L, P["white"], 0.3), WOOD_D, 8)
    for index in range(4):
        bay_y = 14 + index * 17
        _recess(c, 7, bay_y, w - 14, 15)
        _books(c, 9, w - 11, bay_y + 11, 700 + index)
    c.hline(5, 6, w - 10, lit(WOOD_L, 0.5))
    c.hline(4, 11, w - 8, seam(WOOD_L, 0.4))
    c.rect(4, base - 6, w - 8, 7, WOOD_D)
    c.hline(4, base - 6, w - 8, WOOD)
    c.hline(4, base, w - 8, seam(WOOD_D, 0.4))
    outline_silhouette(c)
    return c


def build_coffee() -> Canvas:
    """Break station: espresso machine with hopper and tap, mugs, bean jar."""
    w, h = TILE * 2, 72
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 4, w - 5, base)
    # Counter: wood top over a cabinet with two doors.
    box(c, 4, 40, w - 8, base - 40 + 1, WOOD_L, WOOD_D, WOOD_L, WOOD_D, 11)
    c.hline(6, 42, w - 12, lit(WOOD_L, 0.45))
    c.hline(6, 45, w - 12, mix(WOOD_L, WOOD, 0.4))
    c.hline(5, 50, w - 10, seam(WOOD_D, 0.45))
    for door_x in (10, 34):
        c.rect(door_x, 54, 20, 10, WOOD)
        c.outline_rect(door_x, 54, 20, 10, seam(WOOD_D, 0.45))
        c.hline(door_x + 1, 55, 18, lit(WOOD, 0.3))
        c.rect(door_x + 8, 58, 4, 3, METAL)
        c.hline(door_x + 8, 58, 4, METAL_L)
    # Espresso machine: hopper, body, screen, group head, drip tray, cup.
    c.rect(13, 3, 12, 10, mix(SCREEN_D, P["white"], 0.12))
    c.rect(14, 4, 10, 8, (74, 62, 56, 255))
    for bean_x, bean_y in ((16, 6), (19, 8), (21, 5), (17, 9), (20, 10)):
        c.rect(bean_x, bean_y, 2, 2, (58, 42, 34, 255))
    c.hline(13, 3, 12, lit(mix(SCREEN_D, P["white"], 0.2), 0.5))
    c.outline_rect(13, 3, 12, 10, seam(SCREEN_D, 0.5))
    box(c, 8, 12, 30, 38, METAL_L, METAL_D, METAL_L, METAL_D, 8)
    c.rect(11, 22, 14, 9, SCREEN_D)
    c.rect(12, 23, 12, 7, SCREEN)
    c.hline(13, 25, 8, SCREEN_L)
    c.hline(13, 27, 10, mix(SCREEN, P["white"], 0.35))
    c.rect(27, 22, 8, 6, shade(METAL_D, -50))
    c.hline(27, 22, 8, METAL_L)
    c.rect(11, 32, 12, 6, shade(METAL_D, -60))
    c.hline(11, 32, 12, METAL)
    c.rect(24, 34, 9, 2, shade(METAL_D, -30))          # portafilter handle
    c.rect(34, 30, 3, 12, METAL_D)                      # steam wand
    c.vline(34, 30, 12, METAL_L)
    c.rect(10, 40, 26, 5, METAL)
    c.hline(10, 40, 26, METAL_L)
    for slot_x in range(12, 34, 5):
        c.rect(slot_x, 42, 3, 1, shade(METAL_D, -40))
    c.rect(16, 34, 7, 6, WHITE_FURN)                    # cup under the head
    c.hline(16, 34, 7, P["white"])
    c.hline(16, 35, 7, mix(WOOD_D, P["outline"], 0.3))
    c.hline(16, 39, 7, mix(WHITE_FURN_D, P["outline"], 0.3))
    # Mugs and a bean jar on the counter top.
    c.ellipse(45, 48, 6, 2, WHITE_FURN_D)
    c.rect(42, 41, 7, 8, WHITE_FURN)
    c.hline(42, 41, 7, P["white"])
    c.rect(42, 43, 7, 5, mix(WHITE_FURN, WOOD_D, 0.35))
    c.rect(49, 43, 3, 4, WHITE_FURN)
    c.rect(52, 36, 8, 13, (176, 202, 220, 255))
    c.rect(53, 37, 6, 11, (150, 186, 210, 255))
    for bean_x, bean_y in ((55, 40), (57, 43), (54, 45), (56, 39)):
        c.rect(bean_x, bean_y, 2, 2, (86, 58, 42, 255))
    c.rect(51, 35, 10, 2, METAL_L)
    outline_silhouette(c)
    return c


def build_whiteboard() -> Canvas:
    """Whiteboard on legs: frame, sketched surface, marker tray and clutter."""
    w, h = TILE * 3, 44
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 8, w - 9, base)
    # A-frame legs first, so the board covers their tops.
    for leg_x in (14, 76):
        c.rect(leg_x, 22, 6, base - 22 + 1, METAL)
        c.vline(leg_x, 22, base - 22, METAL_L)
        c.vline(leg_x + 5, 22, base - 22, shade(METAL_D, -20))
        c.rect(leg_x - 1, base - 2, 8, 2, shade(METAL_D, -50))
    box(c, 4, 2, w - 8, 34, METAL_L, METAL_D, METAL_L, METAL_D, 6)
    c.rect(9, 8, w - 18, 24, (250, 249, 246, 255))
    c.hline(9, 8, w - 18, seam(P["white_d"], 0.2))
    # Sketches: a flow, a bar chart, sticky notes.
    c.hline(14, 13, 22, FABRIC_BLUE)
    c.hline(14, 18, 30, FABRIC_BLUE)
    c.hline(14, 23, 18, FABRIC_BLUE)
    c.hline(46, 13, 16, FABRIC_PINK)
    c.hline(46, 18, 24, LEAF)
    for index, bar_h in enumerate((6, 10, 14, 9)):
        c.rect(48 + index * 7, 30 - bar_h, 5, bar_h, mix(FABRIC_BLUE, P["white"], 0.25))
        c.hline(48 + index * 7, 30 - bar_h, 5, FABRIC_BLUE)
    c.rect(72, 10, 12, 12, FABRIC_YELLOW)
    c.outline_rect(72, 10, 12, 12, seam(FABRIC_YELLOW, 0.45))
    c.rect(72, 24, 12, 8, FABRIC_PINK)
    c.outline_rect(72, 24, 12, 8, seam(FABRIC_PINK, 0.45))
    c.hline(14, 27, 26, seam(P["white_d"], 0.3))
    # Marker tray with markers and an eraser resting on it.
    c.rect(8, 35, w - 16, 4, mix(METAL, P["white"], 0.25))
    c.hline(8, 35, w - 16, METAL_L)
    c.hline(8, 38, w - 16, shade(METAL_D, -25))
    for index, tone in enumerate((FABRIC_BLUE, FABRIC_PINK, LEAF, (206, 120, 96, 255))):
        marker_x = 14 + index * 13
        c.rect(marker_x, 32, 9, 4, tone)
        c.hline(marker_x, 32, 9, lit(tone, 0.45))
        c.rect(marker_x + 9, 33, 2, 2, tone)
    c.rect(72, 31, 13, 5, (124, 120, 116, 255))
    c.hline(72, 31, 13, (156, 152, 148, 255))
    outline_silhouette(c)
    return c


def build_window() -> Canvas:
    """Window: mullioned frame, daylight glazing, sill and light spill."""
    w, h = TILE * 2, 48
    base = art_bottom(h)
    c = Canvas(w, h)
    # A wall-hung pane only drops a soft sill shadow, not a furniture footprint.
    c.rect(2, base, w - 4, h - base - 1, P["shadow_soft"])
    box(c, 2, 2, w - 4, 38, WALL_TOP, mix(WALL_TRIM, P["white"], 0.35), P["white"], WALL_TRIM, 6)
    # Daylight wash, cloud, distant skyline behind the glass.
    c.rect(6, 10, w - 12, 28, (162, 214, 244, 255))
    c.rect(6, 10, w - 12, 12, (198, 232, 252, 255))
    c.ellipse(20, 17, 9, 4, (242, 249, 254, 255))
    c.ellipse(34, 15, 11, 5, (232, 244, 252, 255))
    for bx, by, bw, bh in ((8, 28, 8, 10), (17, 24, 7, 14), (25, 30, 9, 8), (36, 26, 7, 12), (45, 29, 9, 9)):
        c.rect(bx, by, bw, bh, (150, 168, 190, 255))
        c.hline(bx, by, bw, (120, 140, 166, 255))
    c.rect(6, 36, w - 12, 2, (128, 146, 170, 255))
    # Mullions: a centre bar and a transom, each with a shadow on the glass.
    c.rect(w // 2 - 2, 8, 4, 32, mix(WALL_TRIM, P["white"], 0.35))
    c.vline(w // 2 - 2, 8, 32, P["white"])
    c.vline(w // 2 + 1, 8, 32, WALL_TRIM)
    c.vline(w // 2 + 2, 8, 32, P["shadow"])
    c.rect(4, 24, w - 8, 3, mix(WALL_TRIM, P["white"], 0.35))
    c.hline(4, 24, w - 8, P["white"])
    c.hline(4, 27, w - 8, P["shadow"])
    # Sill, wider than the casing, with a lit nose.
    c.rect(2, 38, w - 4, 5, WALL_TOP)
    c.hline(2, 38, w - 4, P["white"])
    c.hline(2, 40, w - 4, mix(WALL_TOP, WALL_TRIM, 0.5))
    c.hline(2, 42, w - 4, WALL_BASE)
    c.blend_rect(4, 43, w - 8, 5, (250, 244, 220, 45))
    outline_silhouette(c)
    return c


def build_pingpong() -> Canvas:
    """Table-tennis table: lined bed, net with posts, legs, ball and paddle."""
    w, h = TILE * 3, 68
    base = art_bottom(h)
    c = Canvas(w, h)
    ground_shadow(c, 6, w - 7, base)
    bed = (74, 152, 108, 255)
    # Rear legs poke above the back edge of the bed; front legs reach the floor.
    for leg_x in (16, 74):
        c.rect(leg_x, 12, 7, 12, shade(METAL_D, -40))
        c.vline(leg_x, 12, 12, METAL)
    for leg_x in (16, 74):
        c.rect(leg_x, 46, 7, base - 46 + 1, shade(METAL_D, -40))
        c.vline(leg_x, 46, base - 46, METAL)
        c.ellipse(leg_x + 3, base - 1, 6, 2, P["shadow"])
    box(c, 4, 18, w - 8, 31, mix(bed, P["white"], 0.12), bed, lit(bed, 0.35), mix(bed, P["outline"], 0.3), 25)
    c.hline(5, 20, w - 10, lit(bed, 0.5))
    # Boundary lines and the centre service line.
    c.outline_rect(9, 22, w - 18, 17, P["white"])
    c.vline(w // 2, 22, 17, P["white"])
    c.hline(9, 22, w - 18, mix(P["white"], bed, 0.35))
    # Net across the middle: mesh, posts, and the shadow it drops on the bed.
    c.blend_rect(w // 2 + 2, 22, 9, 18, (30, 62, 44, 55))
    for mesh_y in range(19, 45, 3):
        c.hline(w // 2 - 2, mesh_y, 5, mix(P["white"], bed, 0.12))
    c.rect(w // 2 - 3, 14, 7, 5, METAL_L)
    c.rect(w // 2 - 3, 44, 7, 6, METAL_L)
    c.hline(w // 2 - 3, 14, 7, P["white"])
    c.hline(w // 2 - 3, 49, 7, shade(METAL_D, -30))
    # Ball and a paddle left on the bed.
    c.ellipse(30, 32, 3, 3, (250, 246, 232, 255))
    c.ellipse(30, 33, 3, 2, (214, 208, 190, 255))
    c.rect(29, 30, 2, 1, P["white"])
    c.ellipse(68, 29, 6, 5, (206, 96, 88, 255))
    c.ellipse(68, 28, 5, 4, (226, 122, 110, 255))
    c.rect(73, 32, 7, 3, WOOD_D)
    c.hline(73, 32, 7, WOOD)
    outline_silhouette(c)
    return c


def build_lamp() -> Canvas:
    """Floor lamp: weighted base, slim pole, warm flared shade, light pool."""
    c = Canvas(TILE, 52)
    base = art_bottom(52)
    shade_warm = mix(FABRIC_YELLOW, P["white"], 0.5)
    ground_shadow(c, 9, 22, base)
    # Light pool lands on the floor, under the base shadow.
    c.blend_rect(1, base - 4, 30, 9, (252, 238, 190, 46))
    c.ellipse(16, base - 2, 9, 3, METAL_D)
    c.ellipse(16, base - 3, 7, 2, METAL)
    c.hline(12, base - 4, 8, METAL_L)
    # Pole with a joint collar.
    c.rect(14, 16, 4, base - 19, METAL)
    c.vline(14, 16, base - 19, METAL_L)
    c.vline(17, 16, base - 19, shade(METAL_D, -26))
    c.rect(13, 30, 6, 2, shade(METAL_D, -34))
    # Shade: a flared trapezoid, lit on the left, warm at the rim.
    for index in range(18):
        half = 6 + index // 3
        c.hline(16 - half, 2 + index, half * 2, shade_warm)
        c.hline(16 - half, 2 + index, 2, lit(shade_warm, 0.5))
        c.hline(16 + half - 4, 2 + index, 4, mix(shade_warm, FABRIC_YELLOW, 0.55))
    c.hline(5, 19, 22, mix(shade_warm, FABRIC_YELLOW, 0.5))
    c.hline(6, 20, 20, mix(P["outline"], shade_warm, 0.5))
    # Bulb glow spilling out of the shade.
    c.blend_rect(6, 19, 20, 8, (255, 244, 200, 96))
    c.ellipse(16, 21, 3, 3, (255, 250, 226, 255))
    outline_silhouette(c)
    return c


def build_cooler() -> Canvas:
    """Water cooler: bottle with water line, cabinet, twin taps, drip tray."""
    c = Canvas(TILE, 46)
    base = art_bottom(46)
    ground_shadow(c, 8, 24, base)
    # Bottle: translucent blue with a water line, bubbles and a cap.
    c.rect(10, 4, 12, 16, (150, 196, 224, 255))
    c.rect(11, 5, 10, 14, (186, 222, 242, 255))
    c.hline(11, 14, 10, (128, 178, 214, 255))
    c.rect(11, 15, 10, 4, (158, 202, 230, 255))
    for bubble_x, bubble_y in ((13, 9), (17, 11), (20, 16), (14, 13)):
        c.rect(bubble_x, bubble_y, 1, 1, P["white"])
    c.rect(14, 2, 4, 2, (198, 202, 210, 255))
    c.rect(13, 2, 6, 1, METAL_L)
    c.rect(10, 4, 2, 14, (198, 226, 244, 255))
    c.vline(21, 4, 14, (128, 178, 214, 255))
    # Cabinet with a control panel, twin taps and a drip tray.
    box(c, 7, 20, 18, base - 20 + 1, (176, 202, 220, 255), (146, 176, 198, 255), (206, 226, 240, 255), (126, 152, 176, 255), 5)
    c.rect(9, 27, 14, 6, (128, 156, 178, 255))
    c.rect(10, 28, 12, 4, (162, 192, 212, 255))
    c.rect(10, 33, 4, 3, (74, 142, 208, 255))
    c.rect(16, 33, 4, 3, (206, 96, 88, 255))
    c.rect(9, 37, 14, 3, shade(METAL_D, -46))
    c.hline(9, 37, 14, METAL)
    for slot_x in (11, 15, 19):
        c.rect(slot_x, 38, 3, 1, CABLE)
    outline_silhouette(c)
    return c


def _rug(w: int, h: int, field, trim, accent) -> Canvas:
    """Woven rug: weft rows, a border band and a soft fringe at both short edges."""
    c = Canvas(w, h)
    c.rect(0, 0, w, h, field)
    for row in range(0, h, 7):
        c.rect(0, row, w, 2, mix(field, P["white"], 0.2))
    for knot_x in range(6, w - 5, 13):
        for knot_y in range(6, h - 5, 11):
            c.rect(knot_x, knot_y, 2, 2, mix(field, trim, 0.28))
    c.outline_rect(1, 1, w - 2, h - 2, trim)
    c.outline_rect(3, 3, w - 6, h - 6, mix(trim, field, 0.5))
    c.outline_rect(8, 8, w - 16, h - 16, mix(trim, field, 0.3))
    for row in (10, h - 13):
        c.hline(11, row, w - 22, mix(accent, field, 0.35))
    for fringe_x in range(3, w - 3, 5):
        c.rect(fringe_x, 0, 2, 3, mix(field, P["white"], 0.5))
        c.rect(fringe_x, h - 3, 2, 3, mix(field, P["white"], 0.5))
    return c


def build_props() -> dict:
    props = {}
    props["desk"] = build_desk()
    props["chair"] = build_chair()
    props["plant"] = build_plant()
    props["sofa"] = build_sofa()
    props["table"] = build_table()
    props["shelf"] = build_shelf()
    props["coffee"] = build_coffee()
    props["whiteboard"] = build_whiteboard()
    props["window"] = build_window()
    props["bookshelf"] = build_bookshelf()
    props["pingpong"] = build_pingpong()
    props["lamp"] = build_lamp()
    props["cooler"] = build_cooler()
    # Rug variants so rooms do not all share one floor accent.
    props["rug"] = _rug(TILE * 3, TILE * 2, (206, 196, 222, 255), (168, 152, 198, 255), (236, 230, 248, 255))
    props["rug_blue"] = _rug(TILE * 3, TILE * 2, (198, 212, 236, 255), (150, 172, 212, 255), (230, 238, 250, 255))
    props["rug_warm"] = _rug(TILE * 3, TILE * 2, (240, 222, 198, 255), (208, 178, 142, 255), (252, 240, 222, 255))
    props["rug_pink"] = _rug(TILE * 3, TILE * 2, (238, 206, 216, 255), (208, 160, 178, 255), (250, 232, 238, 255))
    return props


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="apps/office/office/art", type=Path)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    build_floor_tiles().to_png(out / "tiles_floor.png")
    build_wall_top().to_png(out / "wall_top.png")
    build_wall_side().to_png(out / "wall_side.png")
    build_door_frame().to_png(out / "door_frame.png")
    props = build_props()
    for name, canvas in props.items():
        canvas.to_png(out / f"prop_{name}.png")
    for role in ROLE_PALETTE:
        build_character_sheet(role).to_png(out / f"char_{role}.png")
    print(f"wrote {len(ROLE_PALETTE)} characters, floor atlas, 3 wall pieces and {len(props)} props to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
