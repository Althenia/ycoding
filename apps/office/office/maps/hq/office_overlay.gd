## Overlay for selection highlight, status glyphs, and notice bubbles.
##
## Drawn last in the world so these marks always sit above the Y-sorted
## furniture and actors. Contains no runtime state: it reads what the world
## already computed.
class_name OfficeOverlay
extends Node2D

const TILE := 32

## Notice bubble metrics. Shared by the drawing and the pure geometry helper so
## the box can never be sized differently from the text it has to contain.
const FONT_SIZE := 13
const PAD := 8.0
const MAX_WIDTH := 240.0
const MAX_LINES := 2

var world: OfficeWorld


func _draw() -> void:
	if world == null:
		return
	_draw_selection()
	_draw_glyphs()
	_draw_notices()


func _draw_selection() -> void:
	for session_id in world.actors:
		if str(session_id) != world.selected_session_id():
			continue
		var node := world.actors[session_id] as OfficeActor
		if node == null:
			continue
		draw_rect(
			Rect2(node.position + Vector2(-15, 1), Vector2(30, 7)),
			Color(1.0, 0.85, 0.3, 0.5),
			true
		)


## F-08: the status glyph is a non-color signal for the work state.
func _draw_glyphs() -> void:
	for session_id in world.actors:
		var node := world.actors[session_id] as OfficeActor
		if node == null:
			continue
		var color := Color("ffd166") if node.attention_required else Color(1, 1, 1, 0.85)
		draw_string(
			ThemeDB.fallback_font,
			node.position + Vector2(-2, -44),
			WorkState.glyph(node.work_state),
			HORIZONTAL_ALIGNMENT_LEFT,
			-1,
			13,
			color
		)


## Bubbles are sized to their text and clamped inside the world.
##
## A fixed one-line box silently truncated real notices, which are user-facing
## status captions: "Waiting for your decision" rendered as "wait". The box is
## now measured from the wrapped text, so the whole caption is always visible.
func _draw_notices() -> void:
	var font := ThemeDB.fallback_font
	for session_id in world.notices:
		var node := world.actors.get(session_id) as OfficeActor
		if node == null:
			continue
		var box := notice_box(font, str(world.notices[session_id]), node.position)
		draw_rect(box, Color(0.97, 0.97, 0.93, 0.97), true)
		draw_rect(box, Color(0.12, 0.13, 0.16), false, 2.0)
		draw_multiline_string(
			font,
			box.position + Vector2(PAD, PAD + FONT_SIZE),
			str(world.notices[session_id]),
			HORIZONTAL_ALIGNMENT_LEFT,
			box.size.x - PAD * 2.0,
			FONT_SIZE,
			MAX_LINES,
			Color("1b1d23")
		)


## The bubble rectangle for `text` anchored above `anchor`, clamped to the map.
##
## Pure geometry so it can be tested without a draw context: the box must always
## contain the wrapped text, which is what stops the truncation regressing.
static func notice_box(font: Font, text: String, anchor: Vector2) -> Rect2:
	var limit := MAX_WIDTH - PAD * 2.0
	var measured := font.get_multiline_string_size(
		text, HORIZONTAL_ALIGNMENT_LEFT, limit, FONT_SIZE, MAX_LINES
	)
	var box := Rect2(
		Vector2.ZERO,
		Vector2(minf(measured.x, limit) + PAD * 2.0, measured.y + PAD * 2.0)
	)
	box.position = anchor + Vector2(-box.size.x * 0.5, -86.0)
	box.position.x = clampf(
		box.position.x,
		4.0,
		OfficeWorld.MAP_WIDTH * TILE - box.size.x - 4.0
	)
	box.position.y = maxf(box.position.y, 4.0)
	return box
