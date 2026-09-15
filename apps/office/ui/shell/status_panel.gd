## Current-state panel.
##
## Reflects canonical store state immediately: it never waits for travel, a
## bubble, or an animation. Each row shows a glyph, a text label, the room, and
## the verbatim settled status, so color is never the only signal (F-08).
class_name StatusPanel
extends PanelContainer

signal actor_selected(session_id: String)

const ROW_HEIGHT := 46

var _rows: VBoxContainer
var _summary: Label
var _store: OfficeStore


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)

	var header := HBoxContainer.new()
	header.add_child(OfficeTheme.heading("Team"))
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(spacer)
	_summary = Label.new()
	_summary.add_theme_font_size_override("font_size", 12)
	_summary.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	header.add_child(_summary)

	_rows = VBoxContainer.new()
	_rows.add_theme_constant_override("separation", 6)
	box.add_child(header)
	box.add_child(_rows)
	add_child(box)


func refresh(store: OfficeStore) -> void:
	if _rows == null:
		return
	_store = store
	for child in _rows.get_children():
		child.queue_free()
	var rows := store.status_rows()
	_summary.text = "%d active" % rows.size()
	if rows.is_empty():
		_rows.add_child(OfficeTheme.body("No sessions observed yet.", true))
		return
	for row in rows:
		_rows.add_child(_build_row(row))


## A row is a clickable card: glyph, name, room, state, and any settled status.
func _build_row(row: Dictionary) -> Control:
	var session_id := str(row["session_id"])
	var card := Button.new()
	card.custom_minimum_size = Vector2(0, ROW_HEIGHT)
	card.flat = true
	card.add_theme_stylebox_override("normal", OfficeTheme.button_style(OfficeTheme.BG_PANEL_ALT))
	card.add_theme_stylebox_override("hover", OfficeTheme.button_style(OfficeTheme.BORDER))
	card.add_theme_stylebox_override("pressed", OfficeTheme.button_style(OfficeTheme.BG_INPUT))
	card.pressed.connect(func(): actor_selected.emit(session_id))

	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	box.set_anchors_preset(Control.PRESET_FULL_RECT)
	box.offset_left = 10
	box.offset_right = -10
	box.offset_top = 6
	box.offset_bottom = -6
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var glyph := Label.new()
	glyph.text = str(row["glyph"])
	glyph.add_theme_font_size_override("font_size", 17)
	glyph.custom_minimum_size = Vector2(20, 0)
	glyph.add_theme_color_override(
		"font_color", OfficeTheme.ACCENT_WARM if bool(row["attention"]) else OfficeTheme.ACCENT
	)
	box.add_child(glyph)

	var text := VBoxContainer.new()
	text.add_theme_constant_override("separation", 1)
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var name_label := Label.new()
	name_label.text = str(row["name"])
	name_label.add_theme_font_size_override("font_size", 14)
	name_label.add_theme_color_override("font_color", OfficeTheme.TEXT)
	var meta := Label.new()
	meta.add_theme_font_size_override("font_size", 11)
	meta.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	meta.text = _meta_text(row)
	text.add_child(name_label)
	text.add_child(meta)
	box.add_child(text)

	card.add_child(box)
	return card


func _meta_text(row: Dictionary) -> String:
	var parts := [str(row["state"])]
	var room := ""
	if _store != null:
		room = _store_room(str(row["session_id"]))
	if not room.is_empty():
		parts.append("· %s" % room)
	if bool(row["attention"]):
		parts.append("· needs you")
	var settled := str(row["settled"])
	if not settled.is_empty():
		# Verbatim: never restate a runtime status as success.
		parts.append("· settled: %s" % settled)
	return " ".join(parts)


func _store_room(session_id: String) -> String:
	# The room label comes from the composed scene, not from canonical state.
	var main := get_node_or_null("/root/Main")
	if main == null:
		return ""
	return str(main.zone_for(session_id))
