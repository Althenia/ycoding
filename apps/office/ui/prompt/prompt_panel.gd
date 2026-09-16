## Prompt composer.
##
## One rounded card floated over the office, shaped like the reference: the input
## on its own top line, and a control row beneath it carrying attach, the approval
## affordance, the model/effort pill, and a circular send button.
##
## Ordinary task text, exactly like the TUI. In DEMO the composer is a preview:
## submitting never sends a mutation. It does not script employee movement, inject
## roleplay, or select an agent on the user's behalf.
##
## Every row has an explicit height and the card's total matches what the shell
## layout reserves, because an earlier version stacked more content than its box
## allowed and silently clipped the send button.
class_name PromptPanel
extends PanelContainer

signal prompt_submitted(text: String)
signal model_selected(ref: String)
signal effort_selected(variant: String)

## Row metrics. The card is INPUT_H + CONTROL_H + padding.
const INPUT_H := 44.0
const CONTROL_H := 34.0
const CARD_H := 116.0
const PILL_W := 208.0
## A wrapping label needs a known minimum width, or at zero width it reports one
## glyph per line and inflates the card's minimum height.
const WRAP_MIN_WIDTH := 200.0

var _input: TextEdit
var _send: Button
var _attach: Button
var _approval: Button
var _pill: Button
var _pill_menu: PopupMenu
var _notice: Label
var _effort: EffortSlider
var _mode: String = OfficeStore.MODE_DEMO
var _models: Array = []
var _model_ref: String = ""


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.card_style())
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)

	# --- input ---------------------------------------------------------------
	_input = TextEdit.new()
	_input.custom_minimum_size = Vector2(0, INPUT_H)
	_input.placeholder_text = "Do anything"
	_input.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_input.add_theme_font_size_override("font_size", 15)
	_input.add_theme_stylebox_override("normal", OfficeTheme.input_style())
	_input.add_theme_stylebox_override("focus", OfficeTheme.input_focus_style())
	_input.add_theme_color_override("font_color", OfficeTheme.TEXT)
	_input.add_theme_color_override("caret_color", OfficeTheme.ACCENT)
	_input.add_theme_color_override("font_placeholder_color", OfficeTheme.TEXT_MUTED)
	_input.focus_mode = Control.FOCUS_ALL
	_input.gui_input.connect(_on_input_event)
	box.add_child(_input)

	# --- control row ---------------------------------------------------------
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	row.custom_minimum_size = Vector2(0, CONTROL_H)

	_attach = OfficeTheme.icon_button("+")
	_attach.tooltip_text = "Attach a file or connect an app"
	_attach.pressed.connect(_on_attach)
	row.add_child(_attach)

	# Approval mode is not implemented. A control that looks live but does nothing
	# is worse than an absent one, so it is present as a disabled affordance that
	# states its own status rather than silently swallowing a click.
	_approval = OfficeTheme.icon_button("Ask for approval")
	_approval.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_approval.add_theme_font_size_override("font_size", 13)
	_approval.add_theme_color_override("font_color", OfficeTheme.TEXT_DIM)
	_approval.disabled = true
	_approval.tooltip_text = "Approval mode is not implemented"
	row.add_child(_approval)

	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(spacer)

	_pill = OfficeTheme.pill_button("Default")
	_pill.custom_minimum_size = Vector2(PILL_W, CONTROL_H)
	_pill.pressed.connect(_on_pill_pressed)
	row.add_child(_pill)

	_send = OfficeTheme.send_button()
	_send.pressed.connect(_on_send)
	row.add_child(_send)

	box.add_child(row)

	# --- notice line ---------------------------------------------------------
	_notice = Label.new()
	_notice.add_theme_font_size_override("font_size", 11)
	_notice.add_theme_color_override("font_color", OfficeTheme.ACCENT_WARM)
	_notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_notice.custom_minimum_size = Vector2(WRAP_MIN_WIDTH, 0.0)
	box.add_child(_notice)

	add_child(box)

	_pill_menu = PopupMenu.new()
	_pill_menu.index_pressed.connect(_on_model_index)
	add_child(_pill_menu)

	# The effort card is a popover anchored to the pill. It is added to the
	# composer's PARENT and given a high z_index, because as a child of this
	# panel it would be painted inside the card's rounded surface and clipped.
	_effort = EffortSlider.new()
	_effort.visible = false
	_effort.z_index = 10
	_effort.variant_chosen.connect(_on_effort_chosen)
	call_deferred("_attach_effort")


## Attach the popover above the composer once both are in the tree.
func _attach_effort() -> void:
	if _effort == null or _effort.get_parent() != null:
		return
	var host := get_parent()
	if host == null:
		add_child(_effort)
		return
	host.add_child(_effort)


## Reposition the popover whenever the composer is laid out, because it is
## anchored to the pill rather than owned by the layout.
func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED and _effort != null and _effort.visible:
		_place_effort()


func set_mode(mode: String) -> void:
	_mode = mode
	if _send == null:
		return
	_send.tooltip_text = (
		"DEMO: submitting records the text locally only"
		if mode == OfficeStore.MODE_DEMO
		else "Send the prompt"
	)


## Offer the models the popover lists and set the current selection.
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
		_pill_menu.add_item(ModelCatalog.provider_label(str(group["provider"])), index)
		_pill_menu.set_item_disabled(index, true)
		index += 1
		for entry in group["models"]:
			_pill_menu.add_item("   %s" % ModelCatalog.model_label(entry), index)
			_pill_menu.set_item_metadata(index, ModelCatalog.format_ref(entry))
			index += 1
	if _pill_menu.item_count == 0:
		_pill.text = "No models"
		_pill.disabled = true
		return
	_pill.disabled = false
	_refresh_pill()


## The pill's text: the model name, then the variant in a dimmer weight.
##
## Composed from fields. The config form is never rendered here.
func _refresh_pill() -> void:
	var ref := ModelCatalog.parse_ref(_model_ref)
	if ref.is_empty():
		_pill.text = "Default"
		return
	var label := ModelCatalog.display_label(_entry_for(ref), str(ref["variant"]))
	# A fabricated catalogue must say so wherever it is shown, or the office claims
	# a model the runtime never offered.
	if ModelCatalog.is_demo_catalog(_models):
		label += "  ·  demo list"
	_pill.text = label


func _entry_for(ref: Dictionary) -> Dictionary:
	for entry in _models:
		if not (entry is Dictionary):
			continue
		var candidate: Dictionary = entry
		if (
			str(candidate.get("id", "")) == str(ref["id"])
			and str(candidate.get("providerID", "")) == str(ref["providerID"])
		):
			return candidate
	return {}


## The model entry currently selected, or {} when the catalogue cannot resolve it.
func current_entry() -> Dictionary:
	if _models.is_empty():
		return {}
	return _entry_for(ModelCatalog.parse_ref(_model_ref))


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
	if key.pressed and key.keycode == KEY_ENTER and (key.ctrl_pressed or key.meta_pressed):
		_on_send()
		accept_event()


func _on_send() -> void:
	var text := _input.text.strip_edges()
	if text.is_empty():
		return
	prompt_submitted.emit(text)


## The attach affordance opens the same style of menu the reference shows: the
## things a prompt can carry, and nothing it cannot.
func _on_attach() -> void:
	var menu := PopupMenu.new()
	menu.add_item("Outputs", 0)
	menu.set_item_disabled(0, true)
	menu.add_item("Create a file or site", 1)
	menu.set_item_disabled(1, true)
	menu.add_separator()
	menu.add_item("Sources", 2)
	menu.set_item_disabled(2, true)
	menu.add_item("Attach files or connect apps", 3)
	menu.set_item_disabled(3, true)
	menu.position = Vector2i(Vector2(_attach.global_position.x, _attach.global_position.y - 8.0))
	add_child(menu)
	menu.popup()
	# In DEMO nothing can be attached, so every entry states that rather than
	# offering an action that would silently do nothing.
	menu.id_pressed.connect(func(_id: int):
		menu.queue_free()
		show_notice("DEMO — attachments are not sent"))


func _on_pill_pressed() -> void:
	if _pill_menu.item_count == 0:
		return
	_pill_menu.position = Vector2i(Vector2(_pill.global_position.x, _pill.global_position.y - 8.0))
	_pill_menu.popup()


func _on_model_index(index: int) -> void:
	var metadata: Variant = _pill_menu.get_item_metadata(index)
	if metadata == null:
		return
	_model_ref = str(metadata)
	_refresh_pill()
	model_selected.emit(_model_ref)
	_open_effort()


## Show the effort card for the current model.
##
## Offered only when the model declares variants: a slider with no real stops
## would be a control that cannot do anything.
func _open_effort() -> void:
	var entry := current_entry()
	var stops := ModelCatalog.variant_stops(entry)
	if stops.is_empty():
		show_notice("This model has no effort settings")
		return
	var ref := ModelCatalog.parse_ref(_model_ref)
	_effort.open(entry, str(ref.get("variant", "")), stops)
	_place_effort()


## Place the card above the pill, kept inside the window.
##
## The popover lives in the SHELL's coordinate space, not the composer's, so the
## anchor must be converted to global. Reading local coordinates placed it at the
## shell origin, which looked like the card had vanished.
##
## It prefers to sit above the pill; when there is no room it drops below, so it
## is never pushed off the top of the window on a short display.
func _place_effort() -> void:
	if _effort == null or _pill == null:
		return
	var parent := _effort.get_parent() as Control
	if parent == null:
		return
	var card := _effort.custom_minimum_size
	var anchor := _pill.global_position
	var origin := parent.get_global_transform().origin
	var x := anchor.x + _pill.size.x * 0.5 - card.x * 0.5
	# Prefer above the pill; use the room below only when above will not fit, and
	# clamp so the card can never leave the window on a short display.
	var above := anchor.y - card.y - 8.0
	var below := anchor.y + _pill.size.y + 8.0
	var limit := parent.size.y - card.y - 8.0
	var y := above if above >= 8.0 else below
	_effort.position = Vector2(
		clampf(x - origin.x, 8.0, maxf(parent.size.x - card.x - 8.0, 8.0)),
		clampf(y - origin.y, 8.0, maxf(limit, 8.0))
	)
	_effort.visible = true


func _on_effort_chosen(variant: String) -> void:
	var ref := ModelCatalog.parse_ref(_model_ref)
	if ref.is_empty():
		return
	ref["variant"] = variant
	_model_ref = ModelCatalog.format_ref(ref)
	_refresh_pill()
	effort_selected.emit(variant)
	model_selected.emit(_model_ref)


## State a boundary or an outcome next to the composer. Used for the DEMO
## preview boundary and for a refusal returned by the service, so the user learns
## why a submission did not become work.
func show_notice(text: String) -> void:
	var preview := text if text.length() <= 48 else text.substr(0, 48) + "…"
	_notice.text = preview