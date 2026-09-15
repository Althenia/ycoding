## Prompt composer.
##
## One compact bar floated over the office: the input, the model pill and send on
## one row, with the location on a foot line. Ordinary task text, exactly like the
## TUI. In DEMO the composer is a preview: submitting never sends a mutation. It
## does not script employee movement, inject roleplay, or select an agent on the
## user's behalf.
##
## The bar is deliberately short. Its previous shape stacked a heading, a 76px
## input, a button row and a notice line, which needed about 156px of content in a
## 96px box, so the send button was clipped. Everything here is sized so the real
## content minimum fits the box the shell layout gives it.
class_name PromptPanel
extends PanelContainer

signal prompt_submitted(text: String)
signal model_selected(ref: String)

## Row heights. The entry row is one input line plus the pill and the send button;
## the foot row carries the location.
const ENTRY_H := 38.0
const FOOT_H := 14.0

var _input: TextEdit
var _button: Button
var _notice: Label
var _pill: Button
var _pill_menu: PopupMenu
var _path_label: Label
var _mode: String = OfficeStore.MODE_DEMO
var _models: Array = []
var _model_ref: String = ""


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 4)

	# --- entry row ----------------------------------------------------------
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)

	_input = TextEdit.new()
	_input.custom_minimum_size = Vector2(0, ENTRY_H)
	_input.placeholder_text = "Describe the task, as you would in the TUI…"
	_input.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_input.add_theme_font_size_override("font_size", 14)
	_input.add_theme_stylebox_override("normal", OfficeTheme.panel_style(OfficeTheme.BG_INPUT))
	# Focus keeps the filled surface and gains the accent ring, so the focused
	# composer is visibly distinct from the unfocused one.
	_input.add_theme_stylebox_override("focus", OfficeTheme.focus_fill_style(OfficeTheme.BG_INPUT))
	_input.add_theme_color_override("font_color", OfficeTheme.TEXT)
	_input.add_theme_color_override("font_color_readonly", OfficeTheme.TEXT_DIM)
	_input.add_theme_color_override("caret_color", OfficeTheme.ACCENT)
	_input.add_theme_color_override("font_placeholder_color", OfficeTheme.TEXT_MUTED)
	_input.focus_mode = Control.FOCUS_ALL
	_input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_input.gui_input.connect(_on_input_event)
	row.add_child(_input)

	_pill = OfficeTheme.button("Default", false)
	_pill.custom_minimum_size = Vector2(168, ENTRY_H)
	_pill.pressed.connect(_on_pill_pressed)
	row.add_child(_pill)

	_button = OfficeTheme.button("↑", true)
	_button.custom_minimum_size = Vector2(ENTRY_H, ENTRY_H)
	_button.pressed.connect(_on_send)
	row.add_child(_button)

	# --- foot row: the location --------------------------------------------
	var foot := HBoxContainer.new()
	foot.add_theme_constant_override("separation", 8)
	_path_label = Label.new()
	_path_label.add_theme_font_size_override("font_size", 11)
	_path_label.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	_path_label.custom_minimum_size = Vector2(0, FOOT_H)
	foot.add_child(_path_label)
	_notice = Label.new()
	_notice.add_theme_font_size_override("font_size", 11)
	_notice.add_theme_color_override("font_color", OfficeTheme.ACCENT_WARM)
	_notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_notice.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	foot.add_child(_notice)

	box.add_child(row)
	box.add_child(foot)
	add_child(box)

	_pill_menu = PopupMenu.new()
	_pill_menu.index_pressed.connect(_on_model_index)
	add_child(_pill_menu)


func set_mode(mode: String) -> void:
	_mode = mode
	if _button != null and mode == OfficeStore.MODE_DEMO:
		_button.tooltip_text = "DEMO: submitting records the text locally only"


## Offer the models the popover lists and set the current selection.
##
## `catalog` is either the server's model list or `ModelCatalog.demo_catalog()`.
## Grouping and labels come from ModelCatalog, so the pill never renders the
## config string form.
func set_models(catalog: Array, current_ref: String) -> void:
	if _pill == null:
		return
	_models = catalog
	_model_ref = current_ref
	_pill_menu.clear()
	var index := 0
	for group in ModelCatalog.group_by_provider(catalog):
		if index > 0:
			_pill_menu.add_separator()
		var provider := str(group["provider"])
		_pill_menu.add_item(ModelCatalog.provider_label(provider), index)
		_pill_menu.set_item_disabled(index, true)
		index += 1
		for entry in group["models"]:
			var name := str(entry.get("name", entry.get("id", "")))
			_pill_menu.add_item("   %s" % name, index)
			_pill_menu.set_item_metadata(index, ModelCatalog.format_ref(entry))
			index += 1
	if _pill_menu.item_count == 0:
		_pill.text = "No models"
		_pill.disabled = true
		return
	_pill.disabled = false
	_pill.text = "%s  ⌄" % _pill_label()


## The pill's text, composed from fields. Falls back to the raw reference only
## when the catalogue cannot resolve it, which is a visible failure rather than a
## silent one.
func _pill_label() -> String:
	var ref := ModelCatalog.parse_ref(_model_ref)
	if ref.is_empty():
		return "Default"
	for entry in _models:
		if not (entry is Dictionary):
			continue
		var candidate: Dictionary = entry
		if str(candidate.get("id", "")) != str(ref["id"]):
			continue
		if str(candidate.get("providerID", "")) != str(ref["providerID"]):
			continue
		return ModelCatalog.display_label(candidate, str(ref["variant"]))
	return str(ref["id"])


## Show the location every visible session shares.
##
## The office is a view over sessions and each session carries its own durable
## directory, so a single path is only claimed when they actually agree. With more
## than one directory the label says so instead of picking one.
func set_location(store: OfficeStore) -> void:
	if _path_label == null or store == null:
		return
	var locations := store.locations()
	if locations.is_empty():
		_path_label.text = "No location reported"
		return
	if locations.size() > 1:
		_path_label.text = "%d locations" % locations.size()
		return
	_path_label.text = locations[0]


func current_text() -> String:
	return _input.text


func model_ref() -> String:
	return _model_ref


func pill_text() -> String:
	return _pill.text


func _on_input_event(event: InputEvent) -> void:
	if not (event is InputEventKey):
		return
	var key := event as InputEventKey
	# Ctrl/Cmd+Enter submits; Enter alone inserts a newline for multi-line tasks.
	if key.pressed and key.keycode == KEY_ENTER and (key.ctrl_pressed or key.meta_pressed):
		_on_send()
		accept_event()


func _on_send() -> void:
	var text := _input.text.strip_edges()
	if text.is_empty():
		return
	prompt_submitted.emit(text)


func _on_pill_pressed() -> void:
	if _pill_menu.item_count == 0:
		return
	_pill_menu.position = Vector2i(
		Vector2(_pill.global_position.x, _pill.global_position.y - 8.0)
	)
	_pill_menu.popup()


func _on_model_index(index: int) -> void:
	var metadata: Variant = _pill_menu.get_item_metadata(index)
	if metadata == null:
		return
	_model_ref = str(metadata)
	_pill.text = "%s  ⌄" % _pill_label()
	model_selected.emit(_model_ref)


## States the DEMO boundary instead of pretending a prompt was delivered.
func show_demo_notice(text: String) -> void:
	var preview := text if text.length() <= 48 else text.substr(0, 48) + "…"
	_notice.text = "DEMO — not sent: “%s”" % preview