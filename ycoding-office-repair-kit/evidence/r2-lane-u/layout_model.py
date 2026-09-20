#!/usr/bin/env python3
"""Lane U layout model.

Checks the two-region tile shell against the measured engine minima and the world
anchors BEFORE any GDScript is written.

Measured (real Godot probes, 100% text scale):
  sidebar combined minimum width  200 / 250 / 300 / 350 / 400  at 1.0 .. 2.0
  composer combined minimum       295 / 295 / 300 / 350 / 400  at 1.0 .. 2.0
  composer combined minimum height109 / 118 / 126 / 135 / 143  at 1.0 .. 2.0
  cluster declared width          429 / 503 / 578 / 650 / 726
World: 41 x 23 tiles. Lowest work anchor row 15, lowest visitor anchor row 16.
"""

MAP_W, MAP_H = 41, 23
ASPECT = MAP_W / MAP_H

ANCHORS = {
    "desk_prod_0": ((14, 4), (14, 5)),
    "desk_prod_1": ((17, 4), (17, 5)),
    "desk_prod_2": ((20, 4), (20, 5)),
    "desk_prod_3": ((23, 4), (23, 5)),
    "desk_ops_0": ((28, 4), (28, 5)),
    "desk_ops_1": ((31, 4), (31, 5)),
    "desk_ops_2": ((34, 4), (34, 5)),
    "desk_ops_3": ((37, 4), (37, 5)),
    "desk_eng_0": ((14, 15), (14, 16)),
    "desk_eng_1": ((17, 15), (17, 16)),
    "desk_eng_2": ((20, 15), (20, 16)),
    "desk_eng_3": ((23, 15), (23, 16)),
    "desk_ceo": ((34, 15), (34, 16)),
    "play_pingpong": ((14, 8), (14, 9)),
    "play_sofa_a": ((19, 8), (19, 9)),
    "play_sofa_b": ((23, 8), (23, 9)),
    "play_tv": ((19, 11), (20, 11)),
    "hud_table": ((34, 9), (35, 9)),
    "hud_whiteboard": ((29, 10), (30, 10)),
    "focus_side": ((24, 10), (25, 10)),
}

SCALES = [1.0, 1.25, 1.5, 1.75, 2.0]
SIZES = [(1280, 720), (1600, 900), (1920, 1080), (1366, 768), (1024, 768),
         (2560, 1440), (1440, 700), (960, 600)]

SIDEBAR_W = 264.0
SIDEBAR_FLOOR = 200.0
BREAKPOINT = 1000.0
RAIL_W = 56.0
RAIL_FLOOR = 56.0
GUTTER = 24.0
GUTTER_COMPACT = 16.0
COMPOSER_MAX_W = 840.0
COMPOSER_FLOOR_W = 295.0
COMPOSER_GROWTH_W = 105.0
COMPOSER_H = 116.0
COMPOSER_GROWTH_H = 34.0
TOGGLES_MARGIN = 16.0


def cluster_width(scale):
    return {1.0: 429.0, 1.25: 503.0, 1.5: 578.0, 1.75: 650.0, 2.0: 726.0}[scale]


def rail(compact):
    return lambda scale: max(RAIL_W, RAIL_FLOOR * scale) if compact else None


def sidebar_w(size, scale, hidden):
    if "sidebar" in hidden:
        return 0.0
    if size[0] < BREAKPOINT:
        return max(RAIL_W, RAIL_FLOOR * scale)
    return max(SIDEBAR_W, SIDEBAR_FLOOR * scale)


def content(size, scale, hidden):
    sw = sidebar_w(size, scale, hidden)
    return (sw, 0.0, max(size[0] - sw, 1.0), max(size[1], 1.0))


def office(size, scale, hidden):
    cx, cy, cw, ch = content(size, scale, hidden)
    w, h = cw, cw / ASPECT
    if h > ch:
        h, w = ch, ch * ASPECT
    return (cx + (cw - w) / 2.0, cy + (ch - h) / 2.0, w, h)


def overlays(size, scale, hidden=()):
    hidden = set(hidden)
    compact = size[0] < BREAKPOINT
    sw = sidebar_w(size, scale, hidden)
    ox, oy, ow, oh = office(size, scale, hidden)
    gutter = GUTTER_COMPACT if compact else GUTTER
    bottom = GUTTER_COMPACT if compact else GUTTER
    ch = COMPOSER_H + COMPOSER_GROWTH_H * (scale - 1.0)
    floor_w = COMPOSER_FLOOR_W + COMPOSER_GROWTH_W * (scale - 1.0)
    available = max(ow - gutter * 2.0, 1.0)
    cw = min(COMPOSER_MAX_W, available)
    if cw < floor_w:
        cw = min(floor_w, max(ow - 2.0, 1.0))
    composer = (ox + (ow - cw) / 2.0, size[1] - bottom - ch, cw, ch)
    tw, th = max(76.0, cluster_width(scale)), max(28.0, 31.0 + 4.0 * (S_SCALES.index(scale)))
    tx = ox + ow - gutter - tw
    tx = min(tx, size[0] - TOGGLES_MARGIN - tw)
    tx = max(tx, TOGGLES_MARGIN)
    toggles = (tx, oy + gutter, tw, th)
    dw = min(max(ow * 0.42, 320.0 * scale), 560.0 * scale)
    dh = min(max(oh * 0.55, 220.0 * scale), 560.0 * scale)
    dh = min(dh, max(composer[1] - gutter - oy, 1.0))
    drawer = (ox + ow - gutter - dw, oy + gutter, dw, dh)
    return {
        "sidebar": (0.0, 0.0, sw, size[1]),
        "composer": composer,
        "toggles": toggles,
        "drawer": drawer,
    }


S_SCALES = list(reversed(SCALES))  # only used to index above; replaced below
S_SCALES = SCALES


def occludes(rect, size, scale, hidden=()):
    ox, oy, ow, oh = office(size, scale, hidden)
    x0 = max(rect[0], ox)
    y0 = max(rect[1], oy)
    x1 = min(rect[0] + rect[2], ox + ow)
    y1 = min(rect[1] + rect[3], oy + oh)
    if x1 <= x0 or y1 <= y0:
        return None
    sx, sy = MAP_W / ow, MAP_H / oh
    import math
    return (math.floor((x0 - ox) * sx), math.floor((y0 - oy) * sy),
            math.ceil((x1 - ox) * sx), math.ceil((y1 - oy) * sy))


def covers(rect_tiles, cell):
    if rect_tiles is None:
        return False
    return (rect_tiles[0] <= cell[0] < rect_tiles[2]) and (rect_tiles[1] <= cell[1] < rect_tiles[3])


def main():
    problems = []
    worst_anchor_slack = 1e9
    for size in SIZES:
        for scale in SCALES:
            for hidden in ([], ["sidebar"], ["composer"], ["sidebar", "composer"]):
                o = overlays(size, scale, tuple(hidden))
                sb, cp = o["sidebar"], o["composer"]
                # 1. sidebar is a tile: never intersects the office
                if sb[2] > 0:
                    ox, oy, ow, oh = office(size, scale, tuple(hidden))
                    if sb[0] + sb[2] > ox + 1e-6:
                        problems.append(f"sidebar overlaps office at {size} x{scale} {hidden}")
                # 2. office inside content, world aspect, centred
                cx, cy, cw, ch = content(size, scale, tuple(hidden))
                ox, oy, ow, oh = office(size, scale, tuple(hidden))
                if abs(ox - (cx + (cw - ow) / 2)) > 1e-6 or abs(oy - (cy + (ch - oh) / 2)) > 1e-6:
                    problems.append(f"office not centred at {size} x{scale} {hidden}")
                if abs(ow / oh - ASPECT) > 1e-6:
                    problems.append(f"office aspect wrong at {size} x{scale} {hidden}")
                if not (ow <= cw + 1e-6 and oh <= ch + 1e-6):
                    problems.append(f"office outside content at {size} x{scale} {hidden}")
                # 3. composer centred in the office with gutters
                if abs((cp[0] + cp[2] / 2) - (ox + ow / 2)) > 2.0:
                    problems.append(f"composer off centre at {size} x{scale} {hidden}")
                if cp[0] < ox + 0.99 or cp[0] + cp[2] > ox + ow - 0.99:
                    problems.append(f"composer touches the office edge at {size} x{scale} {hidden}")
                # 4. reserved rects cover the measured engine minima
                if "composer" not in hidden:
                    floor_w = COMPOSER_FLOOR_W + COMPOSER_GROWTH_W * (scale - 1.0)
                    if cp[2] + 1e-6 < floor_w:
                        problems.append(f"composer below its floor at {size} x{scale}: {cp[2]:.0f} < {floor_w:.0f}")
                # 5. every region inside the window
                for name, r in o.items():
                    if r[2] < 0 or r[3] < 0 or r[0] < -0.01 or r[1] < -0.01 \
                            or r[0] + r[2] > size[0] + 0.01 or r[1] + r[3] > size[1] + 0.01:
                        problems.append(f"{name} outside the window at {size} x{scale} {hidden}: {r}")
                # 6. no overlay covers an anchor
                for name in ("composer", "sidebar", "toggles"):
                    if name in hidden:
                        continue
                    tiles = occludes(o[name], size, scale, tuple(hidden))
                    for desk, (work, visitor) in ANCHORS.items():
                        for which, cell in (("work", work), ("visitor", visitor)):
                            if covers(tiles, cell):
                                problems.append(
                                    f"{name} covers {desk}/{which} at {size} x{scale} {hidden}")
                # slack report for the composer over the lowest anchor row
                tiles = occludes(o["composer"], size, scale, tuple(hidden))
                ox, oy, ow, oh = office(size, scale, tuple(hidden))
                top_row = (cp[1] - oy) * MAP_H / oh if cp[1] > oy else MAP_H
                slack = top_row - 17.0
                if "composer" not in hidden:
                    worst_anchor_slack = min(worst_anchor_slack, slack)
    print(f"worst composer top-row slack over row 17: {worst_anchor_slack:+.2f} tiles")
    if problems:
        print(f"{len(problems)} PROBLEMS")
        for p in problems[:40]:
            print("  " + p)
        return 1
    print("model OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
