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
## Emitted when a momentary control is pressed. The setting itself is owned by the
## composition root, which is what can actually change it.
signal action_requested(name: String)

## Buttons, in display order. The key is the overlay name in the shell layout.
const ENTRIES := [
	{"name": "sidebar", "label": "Panel"},
	{"name": "composer", "label": "Prompt"},
	{"name": "motion", "label": "Motion"},
]

## Momentary controls, in display order. These are ACTIONS, not hideable panels, so
## they carry no hidden state: pressing one changes a setting and returns.
const ACTIONS := [
	{"name": "theme", "label": "Light", "tooltip": "Switch between light and dark panels"},
	{"name": "scale", "label": "Text", "tooltip": "Enlarge the interface text"},
]

var _hidden: Dictionary = {}
var _buttons: Dictionary = {}


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.bg_panel_alt()))
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 4)
	for entry in ENTRIES:
		var name := str(entry["name"])
		var button := Button.new()
		button.flat = true
		button.toggle_mode = true
		OfficeTheme.apply_font(button, 12)
		button.tooltip_text = "Hide or show the %s" % str(entry["label"]).to_lower()
		button.pressed.connect(_on_pressed.bind(name))
		_buttons[name] = button
		row.add_child(button)
	# The momentary controls live in the same cluster but are not toggles, so they
	# are built separately rather than pretending to have a hidden state.
	for entry in ACTIONS:
		var action := str(entry["name"])
		var control := Button.new()
		control.flat = true
		OfficeTheme.apply_font(control, 12)
		control.tooltip_text = str(entry["tooltip"])
		control.pressed.connect(_on_action.bind(action))
		_buttons[action] = control
		row.add_child(control)
	add_child(row)
	_refresh_labels()




## Re-apply what `_ready` baked into styleboxes and colours.
##
## A palette change alters the palette, not the nodes: colours read at paint time
## follow on their own, but a StyleBox and an override capture their value once, so
## the surfaces carrying one are restyled explicitly.
func restyle() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.bg_panel_alt()))
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


## Report a momentary control's press. The label names the current setting, so the
## button reads as a state rather than as an unlabelled button.
func _on_action(name: String) -> void:
	action_requested.emit(name)


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
			"font_color", OfficeTheme.text_muted() if hidden else OfficeTheme.text_dim()
		)
	# An action's label names its current SETTING, so the button reads as a state
	# rather than as an unlabelled control.
	_set_action_text("theme", "Dark" if OfficeTheme.mode() == OfficePalette.MODE_DARK else "Light")
	_set_action_text("scale", "%d%%" % int(round(ui_scale * 100.0)))


func _set_action_text(name: String, value: String) -> void:
	var button := _buttons.get(name) as Button
	if button != null:
		button.text = value


## The text scale shown on the cluster's action button. Owned by the composition
## root, which applies it; this only displays it.
var ui_scale: float = UiScale.MIN


func set_ui_scale(value: float) -> void:
	ui_scale = value
	_refresh_labels()
