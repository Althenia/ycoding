## Overlay for selection highlight, status glyphs, and notice bubbles.
##
## Drawn last in the world so these marks always sit above the Y-sorted
## furniture and actors. Contains no runtime state: it reads what the world
## already computed.
class_name OfficeOverlay
extends Node2D

const TILE := 32

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


## Bubbles are clamped inside the world so they never clip off-map.
func _draw_notices() -> void:
	for session_id in world.notices:
		var node := world.actors.get(session_id) as OfficeActor
		if node == null:
			continue
		var text := str(world.notices[session_id])
		var box := Rect2(node.position + Vector2(-92, -86), Vector2(184, 34))
		box.position.x = clampf(box.position.x, 4, OfficeWorld.MAP_WIDTH * TILE - 188)
		box.position.y = maxf(box.position.y, 4)
		draw_rect(box, Color(0.97, 0.97, 0.93, 0.97), true)
		draw_rect(box, Color(0.12, 0.13, 0.16), false, 2.0)
		draw_string(
			ThemeDB.fallback_font,
			box.position + Vector2(8, 22),
			text,
			HORIZONTAL_ALIGNMENT_LEFT,
			168,
			13,
			Color("1b1d23")
		)
