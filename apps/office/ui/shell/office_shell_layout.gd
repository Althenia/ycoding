## Shell overlay design.
##
## There is no header. The office viewport is full-bleed and reaches every window
## edge; everything else floats above it. That means this module no longer tiles
## regions into a frame. It places overlays in the office's coordinate space:
##
##   +--------------------------------------------------------------+
##   |  +----------------+                                          |
##   |  | sidebar        |        OFFICE VIEWPORT (full bleed)      |
##   |  | 320 wide       |                                          |
##   |  |                |                                          |
##   |  +----------------+                                          |
##   |                                                              |
##   |                    +---------------------------+             |
##   |                    | composer (centred)         |             |
##   |                    +---------------------------+             |
##   +--------------------------------------------------------------+
##
## The office region is the largest world-aspect rectangle that fits the window,
## centred. Because it is world-aspect, the viewport never letterboxes inside it
## and the world always fills its container exactly.
##
## Overlays deliberately cover part of the office. `occludes` below answers the
## question that matters for the world design: which tiles an overlay hides.
## test_shell_layout.gd uses it to prove the composer never covers a work anchor.
class_name OfficeShellLayout
extends RefCounted

## Overlay metrics.
##
## The rail takes about a fifth of the frame at 1600x900. At 320 it read as a
## dominant column rather than a floating panel; 264 leaves the office legible.
const SIDEBAR_W := 272.0
## The narrowest the sidebar's own CONTENT can render at 100%: its widest child
## plus the panel padding. It grows with the text scale.
const SIDEBAR_CONTENT_FLOOR := 297.0
const SIDEBAR_MARGIN := 16.0
## The sidebar spans the window height minus its margins.
const SIDEBAR_MARGIN_Y := 16.0
## Space kept between the sidebar and the content area's left edge.
const GAP := 12.0

## Composer: about half of the content area, clamped, centred in that area, and
## floated above the bottom.
##
## It centres in the space EAST of the sidebar, not in the window. Centring in
## the window would push it under the sidebar on a narrow display, and the
## reference this design follows centres it in the content area too.
const COMPOSER_SHARE := 0.50
const COMPOSER_MIN_W := 460.0
## The narrowest the composer's OWN CONTENT can render: its control row plus the
## padding around it. Below this the composer takes the full content width rather
## than clipping a control.
const COMPOSER_CONTENT_FLOOR := 477.0
## The height the composer's rows need at 100%. It grows with the text scale.
const COMPOSER_CONTENT_HEIGHT := 116.0
const COMPOSER_MAX_W := 720.0
const COMPOSER_H := 116.0
const COMPOSER_BOTTOM := 40.0

## The chrome-toggle cluster: hide and show the panels without leaving the office.
##
## It sits in the top-right corner, which is the north wall band, so it never
## covers a work or visitor anchor.
const TOGGLES_W := 76.0
const TOGGLES_H := 28.0
const TOGGLES_MARGIN := 16.0

## Overlay names, in draw order (later draws on top).
const OVERLAYS := ["sidebar", "composer", "toggles"]

## Overlays the user can hide. `toggles` itself is never hidden, or the panels
## could be dismissed with no way back.
const HIDEABLE := ["sidebar", "composer"]

## Every overlay for a window of `size`, in the shell's coordinate space.
##
## `scale` is the interface TEXT scale. It grows the metrics that come from text —
## the width a panel's contents need, and the height a row of controls occupies —
## while the gutters between overlays stay fixed, because a gutter is spacing rather
## than content. A panel narrower than its own text would clip the state it exists
## to show, so a content floor always wins over a designed width.
static func overlays(size: Vector2, scale: float = 1.0) -> Dictionary:
	var safe := UiScale.clamp_scale(scale)
	var sidebar_w := maxf(SIDEBAR_W, SIDEBAR_CONTENT_FLOOR * safe)
	var sidebar_h := maxf(size.y - SIDEBAR_MARGIN_Y * 2.0, 1.0)
	var content_x := SIDEBAR_MARGIN + sidebar_w + GAP
	var content_w := maxf(size.x - content_x - SIDEBAR_MARGIN, 1.0)
	var composer_h := maxf(COMPOSER_H, COMPOSER_CONTENT_HEIGHT * safe)
	var desired := clampf(content_w * COMPOSER_SHARE, COMPOSER_MIN_W, COMPOSER_MAX_W)
	# The composer's controls cannot render below their own content floor. When the
	# preferred share is narrower, the composer takes the room it needs rather than
	# clipping a control the user would then not see.
	var composer_w := minf(maxf(desired, COMPOSER_CONTENT_FLOOR * safe), content_w)
	return {
		"sidebar": Rect2(
			Vector2(SIDEBAR_MARGIN, SIDEBAR_MARGIN_Y),
			Vector2(sidebar_w, sidebar_h)
		),
		"composer": Rect2(
			Vector2(content_x + (content_w - composer_w) * 0.5, size.y - COMPOSER_BOTTOM - composer_h),
			Vector2(composer_w, composer_h)
		),
		"toggles": Rect2(
			Vector2(size.x - TOGGLES_MARGIN - TOGGLES_W, TOGGLES_MARGIN),
			Vector2(TOGGLES_W, TOGGLES_H)
		),
	}


## Which tiles an overlay hides, or an empty rect when it is hidden or entirely
## outside the office.
##
## This is the question callers actually ask, so the hidden state is part of it
## rather than something each caller has to remember to check.
static func occluded_tiles(name: String, size: Vector2, hidden: Array = []) -> Rect2i:
	if hidden.has(name):
		return Rect2i()
	var rects := overlays(size)
	if not rects.has(name):
		return Rect2i()
	return occludes(rects[name], size)


## The full-bleed office region: the largest world-aspect rect that fits.
##
## Anchored to the window centre. The leftover space is not dead: the sidebar and
## composer float over the edges of it.
static func office_region(size: Vector2) -> Rect2:
	var aspect := office_aspect_target()
	var width := size.x
	var height := width / aspect
	if height > size.y:
		height = size.y
		width = height * aspect
	return Rect2(Vector2((size.x - width) * 0.5, (size.y - height) * 0.5), Vector2(width, height))


## The aspect the office region is shaped to: the world's own.
static func office_aspect_target() -> float:
	return float(OfficeWorld.MAP_WIDTH) / float(OfficeWorld.MAP_HEIGHT)


## The office region's aspect at a window size. Equals the world's by
## construction, which is why the viewport never letterboxes.
static func office_aspect(size: Vector2) -> float:
	var rect := office_region(size)
	if rect.size.y <= 0.0:
		return 0.0
	return rect.size.x / rect.size.y


## Which world tiles an overlay hides, as a Rect2i, or an empty rect when it is
## entirely outside the office region.
##
## Screen -> world conversion: the office region maps 1:1 onto the world rect,
## so a point inside it maps by proportion. Used to prove that floating chrome
## does not hide the things a user must see.
static func occludes(overlay: Rect2, size: Vector2) -> Rect2i:
	var office := office_region(size)
	var overlap := office.intersection(overlay)
	if overlap.size.x <= 0.0 or overlap.size.y <= 0.0:
		return Rect2i()
	var scale_x := float(OfficeWorld.MAP_WIDTH) / office.size.x
	var scale_y := float(OfficeWorld.MAP_HEIGHT) / office.size.y
	var x0 := int(floor((overlap.position.x - office.position.x) * scale_x))
	var y0 := int(floor((overlap.position.y - office.position.y) * scale_y))
	var x1 := int(ceil((overlap.position.x + overlap.size.x - office.position.x) * scale_x))
	var y1 := int(ceil((overlap.position.y + overlap.size.y - office.position.y) * scale_y))
	return Rect2i(
		x0,
		y0,
		maxi(x1 - x0, 1),
		maxi(y1 - y0, 1)
	)


## Place an overlay on a control. Anchors are cleared so the design above is the
## only thing that decides where a surface sits.
static func place(control: Control, rect: Rect2) -> void:
	if control == null:
		return
	control.set_anchor(SIDE_LEFT, 0.0)
	control.set_anchor(SIDE_TOP, 0.0)
	control.set_anchor(SIDE_RIGHT, 0.0)
	control.set_anchor(SIDE_BOTTOM, 0.0)
	control.position = rect.position
	control.size = rect.size


## Window sizes the design is expected to hold up at. The odd ones are not 16:9
## on purpose: the arrangement must survive unusual windows.
static func supported_sizes() -> Array[Vector2]:
	return [
		Vector2(1280, 720), Vector2(1600, 900), Vector2(1920, 1080),
		Vector2(1366, 768), Vector2(1024, 768), Vector2(2560, 1440), Vector2(1440, 700),
	]
