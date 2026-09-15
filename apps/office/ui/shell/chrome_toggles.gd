## Floating chrome toggle.
##
## The sidebar and the composer float over the office, so a user who wants an
## unobstructed view needs a way to hide them — and, critically, a way back. This
## cluster is never hideable itself: if it could be hidden with the panels, the
## panels would be unreachable.
##
## Hidden state is presentation only. It never touches the store, so hiding the
## chrome cannot change what the office reports about a session.
class_name ChromeToggles
extends PanelContainer

## Emitted with the overlay name and its new hidden state.
signal toggled(name: String, hidden: bool)

## Buttons, in display order. The key is the overlay name in the shell layout.
const ENTRIES := [
	{"name": "sidebar", "label": "Panel"},
	{"name": "composer", "label": "Prompt"},
]

var _hidden: Dictionary = {}
var _buttons: Dictionary = {}


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.BG_PANEL_ALT))
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 4)
	for entry in ENTRIES:
		var name := str(entry["name"])
		var button := Button.new()
		button.flat = true
		button.toggle_mode = true
		button.add_theme_font_size_override("font_size", 12)
		button.tooltip_text = "Hide or show the %s" % str(entry["label"]).to_lower()
		button.pressed.connect(_on_pressed.bind(name))
		_buttons[name] = button
		row.add_child(button)
	add_child(row)
	_refresh_labels()


func is_hidden(name: String) -> bool:
	return bool(_hidden.get(name, false))


func hidden_names() -> Array[String]:
	var out: Array[String] = []
	for entry in ENTRIES:
		var name := str(entry["name"])
		if is_hidden(name):
			out.append(name)
	return out


## Set the hidden state from outside, used to restore a saved arrangement.
func set_hidden(name: String, hidden: bool) -> void:
	_hidden[name] = hidden
	_refresh_labels()


func _on_pressed(name: String) -> void:
	set_hidden(name, not is_hidden(name))
	toggled.emit(name, is_hidden(name))


## The label states the action, so the state is readable without colour: a hidden
## panel shows "Show", a visible one shows "Hide".
func _refresh_labels() -> void:
	for entry in ENTRIES:
		var name := str(entry["name"])
		var button := _buttons.get(name) as Button
		if button == null:
			continue
		var hidden := is_hidden(name)
		button.text = "Show" if hidden else "Hide"
		button.button_pressed = not hidden
		button.add_theme_color_override(
			"font_color", OfficeTheme.TEXT_MUTED if hidden else OfficeTheme.TEXT_DIM
		)
