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
## The tile the sidebar occupies. It touches the left edge and spans the full content
## height, so it is a region rather than a floating panel: nothing is drawn beneath it.
const SIDEBAR_W := 264.0
## The narrowest the sidebar's own CONTENT can render at 100%: its widest child
## plus the panel padding. It grows with the text scale, and the column grows with it.
const SIDEBAR_CONTENT_FLOOR := 297.0
## Below this window width the sidebar collapses toward its rail. The rail is the
## narrowest the panel can actually PAINT: Godot clamps `size` up to the control's own
## combined minimum, so a rail narrower than its contents would simply be overridden.
## A true icon-only rail needs a compact CONTENT mode inside `SidebarPanel`; until that
## exists this floor is the honest width, and the panel may be hidden entirely instead.
const COMPACT_BELOW := 1000.0
## Kept as the outer gutter for callers that still place a panel inset from the frame.
const SIDEBAR_MARGIN := 16.0
## Kept for callers that inset a panel vertically; the sidebar tile itself is full height.
const SIDEBAR_MARGIN_Y := 16.0
## Space kept between two floating surfaces, never between the sidebar and the office:
## the sidebar is a tile and the office must start exactly at its right edge.
const GAP := 12.0

## Composer: centred in the VISIBLE office rect, clamped, floated above the bottom.
##
## It centres in the office region rather than in the window, so a pinned inspector or
## a wide sidebar cannot push it under chrome. The gutter is the space kept between the
## composer and the office region's edges at each layout mode.
const COMPOSER_GUTTER := 24.0
const COMPOSER_GUTTER_COMPACT := 16.0
## Retained for callers that size the composer as a share of its region.
const COMPOSER_SHARE := 0.50
const COMPOSER_MIN_W := 460.0
## The narrowest the composer's OWN CONTENT can render: its control row plus the
## padding around it. Below this the composer takes the full content width rather
## than clipping a control.
const COMPOSER_CONTENT_FLOOR := 477.0
## The height the composer's own rows need at 100%. It grows with the text scale.
##
## Measured from the built panel, not estimated: the composer's rows are the header,
## the control row, the notice line and the target line, and a constant smaller than
## the smallest of those lets the engine clamp the placed control past its rect.
const COMPOSER_CONTENT_HEIGHT := 136.0
const COMPOSER_MAX_W := 840.0
const COMPOSER_H := 112.0
const COMPOSER_BOTTOM := 24.0

## The chrome-toggle cluster: hide and show the panels without leaving the office.
##
## It sits in the top-right corner, which is the north wall band, so it never
## covers a work or visitor anchor.
## The chrome-toggle cluster's FLOOR size. The cluster measures its own labels and
## reports what it needs through `ChromeToggles.cluster_width/height`; these constants
## only keep the region from collapsing, so the reserved space is never smaller than
## the controls it holds. A literal here was the clipping defect: 76 reserved against
## a cluster that measured 244.
const TOGGLES_W := 76.0
const TOGGLES_H := 28.0
const TOGGLES_MARGIN := 16.0
## Separation between wrapped toggle rows, matching the cluster's own row separation
## so the reserved height covers what the cluster actually stacks.
const ROW_GAP := 4.0

## Overlay names, in draw order (later draws on top).
## The contextual drawer: a bounded right-hand panel, not a full-surface inspector.
##
## Its width is a fraction of the visible office and is CAPPED, and its height
## leaves the composer and the top chrome clear. The acceptance forbids a
## "permanently opaque giant inspector", so both dimensions are bounded here rather
## than at the placement site, and the panel can never swallow the frame.
const DRAWER_W := 536.0
const DRAWER_MAX_SHARE := 0.46
const DRAWER_GAP := 16.0
const DRAWER_MARGIN_Y := 16.0

## The Settings surface. A large page with its own grouped navigation. It is a
## bounded SURFACE rather than a floating overlay: it takes a capped share of the
## content region and keeps a margin on every side, so it never becomes the full-bleed
## opaque sheet the shell foreswears. Its floor stops the navigation column and the
## page body from clipping at a small content width; the ceiling stops it growing into
## a full-width list on an ultrawide window.
const SETTINGS_W := 900.0
const SETTINGS_MAX_SHARE := 0.72
const SETTINGS_MIN_W := 520.0
const SETTINGS_MARGIN := 16.0

const OVERLAYS := ["sidebar", "composer", "toggles", "drawer"]

## Overlays the user can hide. `toggles` itself is never hidden, or the panels
## could be dismissed with no way back.
const HIDEABLE := ["sidebar", "composer"]

## The tile layout for a window of `size`.
##
## The shell is TWO REGIONS, not a stack of overlays: a persistent sidebar column that
## touches the left edge and spans the full content height, and the office, which fills
## every remaining pixel. Only the composer still floats over the office, because the
## approved design keeps it inside the workspace it belongs to.
##
## `scale` is the interface TEXT scale. It grows the metrics that come from text — the
## width a panel's contents need, and the height a row of controls occupies — while the
## gutters between regions stay fixed, because a gutter is spacing rather than content.
## A panel narrower than its own text would clip the state it exists to show, so a
## content floor always wins over a designed width.
static func overlays(size: Vector2, scale: float = 1.0) -> Dictionary:
	var safe := UiScale.clamp_scale(scale)
	var sidebar_w := sidebar_width(size, safe)
	var sidebar_h := maxf(size.y, 1.0)
	# The office owns everything east of the sidebar. Nothing overlaps it.
	var content_x := sidebar_w
	var content_w := maxf(size.x - content_x, 1.0)
	var content_h := maxf(size.y, 1.0)
	# The composer floats over the office it belongs to, centred in the VISIBLE office
	# rect rather than in the window, so a pinned inspector or a wide sidebar cannot
	# push it under chrome.
	var gutter := COMPOSER_GUTTER_COMPACT if is_compact(size) else COMPOSER_GUTTER
	var composer_h := maxf(COMPOSER_H, COMPOSER_CONTENT_HEIGHT * safe)
	var desired := clampf(content_w - gutter * 2.0, COMPOSER_MIN_W, COMPOSER_MAX_W)
	var composer_w := minf(maxf(desired, COMPOSER_CONTENT_FLOOR * safe), maxf(content_w - gutter * 2.0, 1.0))
	var toggles_w := maxf(TOGGLES_W, ChromeToggles.cluster_width(safe))
	# The room beside the sidebar, which is what the cluster region may occupy.
	var toggles_avail_w := maxf(size.x - content_x - TOGGLES_MARGIN * 2.0, 1.0)
	# Height follows the rows the capped width forces, so a wrapped cluster is
	# reserved its real height rather than a single row's.
	var toggles_rows := maxi(
		1,
		int(ceilf(toggles_w / maxf(toggles_avail_w, 1.0)))
	)
	var toggles_h := maxf(TOGGLES_H, ChromeToggles.cluster_height(safe)) * float(toggles_rows) \
		+ ROW_GAP * float(toggles_rows - 1)
	return {
		"sidebar": Rect2(Vector2.ZERO, Vector2(sidebar_w, sidebar_h)),
		"composer": Rect2(
			Vector2(content_x + (content_w - composer_w) * 0.5, content_h - COMPOSER_BOTTOM - composer_h),
			Vector2(composer_w, composer_h)
		),
		# The cluster is pinned to the right edge, but its REGION is capped to the room
		# that actually exists beside the sidebar. The cluster itself reflows into as
		# many rows as that width needs (`ChromeToggles.wrap_to`), so a narrow window
		# at a large text scale wraps the controls instead of painting them over the
		# roster. Capping the region is only safe BECAUSE the cluster wraps: clamping a
		# single-row cluster would clip its labels, which is the defect R2-06 fixed.
		"toggles": Rect2(
			Vector2(
				size.x - TOGGLES_MARGIN - minf(toggles_w, toggles_avail_w),
				TOGGLES_MARGIN
			),
			Vector2(minf(toggles_w, toggles_avail_w), toggles_h)
		),
		"drawer": _drawer_rect(size, content_x, content_w, content_h, composer_h),
	}


## The contextual drawer's rect.
##
## Bounded on BOTH axes so it is a side panel rather than an opaque inspector: the
## width is capped as a share of the visible office, and the height stops above the
## composer so a draft and its send controls are never covered by the panel that
## describes the work.
static func _drawer_rect(
	size: Vector2, content_x: float, content_w: float, content_h: float, composer_h: float
) -> Rect2:
	var width := minf(DRAWER_W, content_w * DRAWER_MAX_SHARE)
	var top := DRAWER_MARGIN_Y
	var bottom := maxf(content_h - COMPOSER_BOTTOM - composer_h - DRAWER_GAP, top + 1.0)
	return Rect2(
		Vector2(content_x + content_w - width - DRAWER_GAP, top),
		Vector2(width, bottom - top)
	)


## Whether the window is narrow enough that the sidebar must collapse to a rail.
##
## Below this width a full sidebar would leave too little office to be worth showing,
## so the sidebar shrinks to its rail and the user opens the full one on request.
static func is_compact(size: Vector2) -> bool:
	return size.x < COMPACT_BELOW


## The sidebar's width for a window: its designed column, grown if its own content
## needs more room at this text scale.
##
## A narrower "rail" is deliberately NOT returned here. Godot clamps a control's size up
## to its combined minimum, so requesting a rail narrower than the panel's contents
## would be silently overridden and look like a layout bug. A real icon-only rail needs
## a compact content mode inside `SidebarPanel`; until that exists the honest narrow-window
## treatment is to hide the sidebar, which the chrome toggles already allow.
static func sidebar_width(size: Vector2, scale: float = 1.0) -> float:
	return maxf(SIDEBAR_W, SIDEBAR_CONTENT_FLOOR * UiScale.clamp_scale(scale))


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


## Split the window: the office occupies everything east of the sidebar.
##
## "Full bleed" is gone by design. The office region is the largest world-aspect rect
## that fits the CONTENT area, centred inside it, so the world is never letterboxed
## inside its own region and the sidebar never covers any of it. The leftover band from
## the aspect fit is inside the content area only, never behind the sidebar.
static func office_region(size: Vector2, scale: float = 1.0) -> Rect2:
	var safe := UiScale.clamp_scale(scale)
	var content_x := sidebar_width(size, safe)
	var content_w := maxf(size.x - content_x, 1.0)
	var content_h := maxf(size.y, 1.0)
	var aspect := office_aspect_target()
	var width := content_w
	var height := width / aspect
	if height > content_h:
		height = content_h
		width = height * aspect
	return Rect2(
		Vector2(content_x + (content_w - width) * 0.5, (content_h - height) * 0.5),
		Vector2(width, height)
	)


## The aspect the office region is shaped to: the world's own.
static func office_aspect_target() -> float:
	return float(OfficeWorld.MAP_WIDTH) / float(OfficeWorld.MAP_HEIGHT)


## The Settings page's rect: a bounded large page centred in the content region.
##
## It is a NAMED region rather than a fifth overlay, because it is a full surface
## (like the office and statistics views) rather than a floating panel over the
## world. Bounded on both axes so it never becomes a full-bleed sheet, and centred
## in the content region so the docked sidebar cannot push it off-centre or under
## the rail.
##
## `scale` grows the page's own content floor with the text, so the navigation column
## and the coverage list are not clipped at a large text scale; the ceiling grows with
## it too, or a scaled-up page would be capped below the width its contents need.
static func settings_region(size: Vector2, scale: float = 1.0) -> Rect2:
	var safe := UiScale.clamp_scale(scale)
	var content_x := sidebar_width(size, safe)
	var content_w := maxf(size.x - content_x, 1.0)
	var content_h := maxf(size.y, 1.0)
	var available := maxf(content_w - SETTINGS_MARGIN * 2.0, 1.0)
	var floor_w := SETTINGS_MIN_W * safe
	var ceiling_w := SETTINGS_W * safe
	var width := clampf(content_w * SETTINGS_MAX_SHARE, floor_w, ceiling_w)
	# A content floor always wins over the designed share, but never over the space
	# that actually exists: a page wider than its region would be clamped by the engine
	# and grow downward, off the window.
	width = minf(width, available)
	var height := maxf(content_h - SETTINGS_MARGIN * 2.0, 1.0)
	return Rect2(
		Vector2(content_x + (content_w - width) * 0.5, SETTINGS_MARGIN),
		Vector2(width, height)
	)


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
## The rect the composer is PLACED at, given the height its own content needs.
##
## The designed rect is what the layout asks for, but the engine clamps a Control's
## size UP to its content minimum. A size clamped from the top grows the panel
## DOWNWARD, which is how the composer's last line - the target it exists to name -
## ended up below the window. The composer floats on its BOTTOM edge, so content that
## needs more room grows it UPWARD and its bottom stays where the design puts it.
static func composer_placed(designed: Rect2, needed_height: float) -> Rect2:
	var height := maxf(designed.size.y, needed_height)
	return Rect2(
		Vector2(designed.position.x, designed.end.y - height),
		Vector2(designed.size.x, height),
	)


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
