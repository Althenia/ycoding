## Mode / connection badge with the product name.
##
## DEMO and LIVE must be unmistakable, and a demo playback must never become LIVE
## silently. Composite controls are built in code so the layout stays legible.
class_name ModeBadge
extends PanelContainer

var _title: Label
var _mode: Label
var _detail: Label


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 3)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	_title = Label.new()
	_title.text = "YCoding Office"
	_title.add_theme_font_size_override("font_size", 15)
	_title.add_theme_color_override("font_color", OfficeTheme.TEXT)
	_mode = Label.new()
	_mode.add_theme_font_size_override("font_size", 13)
	header.add_child(_title)
	header.add_child(_mode)

	_detail = Label.new()
	_detail.add_theme_font_size_override("font_size", 11)
	_detail.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	box.add_child(header)
	box.add_child(_detail)
	add_child(box)


func refresh(store: OfficeStore, playing: bool) -> void:
	if _mode == null:
		return
	_mode.text = "· %s · %s" % [store.mode, _connection_text(store.connection_state)]
	# DEMO is a hard visual boundary, never a quiet label.
	_mode.add_theme_color_override(
		"font_color", OfficeTheme.ACCENT_WARM if store.mode == OfficeStore.MODE_DEMO else OfficeTheme.OK
	)
	_detail.text = _detail_text(store, playing)


func _connection_text(state: String) -> String:
	match state:
		OfficeStore.CONNECTION_SYNCING:
			return "SYNCING"
		OfficeStore.CONNECTION_RECONNECTING:
			return "RECONNECTING"
		OfficeStore.CONNECTION_DISCONNECTED:
			return "DISCONNECTED"
	return "READY"


func _detail_text(store: OfficeStore, playing: bool) -> String:
	if not store.last_error.is_empty():
		return store.last_error
	if store.mode == OfficeStore.MODE_DEMO:
		return "Synthetic playback — no runtime work is executed"
	return "Live playback" if playing else "Idle"
