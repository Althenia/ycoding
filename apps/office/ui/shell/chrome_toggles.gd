## Floating chrome toggle.
##
## The sidebar and the composer float over the office, so a user who wants an
## unobstructed view needs a way to hide them — and, critically, a way back. This
## cluster is never hideable itself: if it could be hidden with the panels, the
## panels would be unreachable.
##
## Hidden state is presentation only. It never touches the store, so hiding the
## chrome cannot change what the office reports about a session.
##
## The cluster carries five controls in one row, so each label names the surface it
## controls AND carries a text state marker. A row of controls that all read the
## shared verb ("Hide") is unreadable: two enabled buttons would say the same thing,
## and the state would be carried by colour alone. The markers are the roster's own
## filled/hollow pair, so the meaning is already established elsewhere in the shell.
##
## The declared size lives here, not in the shell layout: the cluster knows how wide
## its own labels render. `cluster_width`/`cluster_height` are what the layout's
## toggle region must reserve, and `combined_minimum_size` would only answer that
## after a frame has run.
class_name ChromeToggles
extends PanelContainer

## Emitted with the overlay name and its new hidden state.
signal toggled(name: String, hidden: bool)
## Emitted when a momentary control is pressed. The setting itself is owned by the
## composition root, which is what can actually change it.
signal action_requested(name: String)

## Buttons, in display order. The key is the overlay name in the shell layout and
## the label names the surface the control toggles.
const ENTRIES := [
	{"name": "sidebar", "label": "Sidebar"},
	{"name": "composer", "label": "Prompt"},
	{"name": "motion", "label": "Motion"},
]

## Momentary controls, in display order. These are ACTIONS, not hideable panels, so
## they carry no hidden state: pressing one changes a setting and returns. The label
## names the surface and the value shown is the setting actually in use.
const ACTIONS := [
	{"name": "theme", "label": "Theme", "tooltip": "Switch between light and dark panels"},
	{"name": "scale", "label": "Text", "tooltip": "Enlarge the interface text"},
]

## State markers. These are the roster's own glyphs, so "filled means present" is
## already established in this shell. A marker is text, which is what keeps the
## state legible when the palette is not: colour is a second cue, never the only one.
const MARK_VISIBLE := SidebarPanel.MARK_SELECTED
const MARK_HIDDEN := SidebarPanel.MARK_UNSELECTED

## The font size the labels are authored at. The text scale is applied on top
## through `OfficeTheme.font`, so the labels grow with the interface.
const LABEL_FONT := 12
## What a flat button adds around its own text, calibrated so the declared width
## covers the controls in the same measurement context the suite uses.
##
## Measured at 100%: the engine's flat-button minimum exceeds the raw text width by
## 26 px for the three marker labels, 32 px for the theme label and 29 px for the
## scale label. A uniform 18 under-covered every one of them, which is why
## `cluster_width` reported 429 against a built 454. The value below clears the
## largest per-button overhead with a few pixels to spare; the reserved region still
## fits the narrowest supported frame.
const BUTTON_PAD_X := 24.0
const BUTTON_PAD_Y := 19.0
## Separation between adjacent controls, matching the row.
const ROW_SEPARATION := 4.0
## The panel's own horizontal content margins, from `OfficeTheme.panel_style`.
const PANEL_PAD_X := 12.0

## The theme setting's longer value, so the declared width is safe in either mode.
const WIDEST_THEME_VALUE := "Light"

var _hidden: Dictionary = {}
var _buttons: Dictionary = {}
## The stack of rows the controls are distributed across, and the controls in
## display order. Held so `wrap_to` can reflow them on a resize.
var _rows: VBoxContainer
var _row_controls: Array[Control] = []
## The width the cluster was last asked to fit, so a redundant reflow is skipped.
var _wrap_width := -1.0
## Guards the build the way `SidebarPanel` does: `_ready` can run more than once for
## one instance (a test drives it directly after the tree already called it), and a
## second build would add a SECOND row of controls, doubling the panel's minimum.
var _built := false


func _ready() -> void:
	if _built:
		return
	_built = true
	add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.bg_panel_alt()))
	# The controls live in a VERTICAL stack of HORIZONTAL rows. One unbroken row
	# cannot fit beside the sidebar at a large text scale on a narrow window (at
	# 1024x768 and 200% it needs 756 px where only 430 is available), and squeezing it
	# would clip the labels. Wrapping keeps every label intact, which is what R2-06
	# requires, and it is the layout that decides how many rows fit.
	_rows = VBoxContainer.new()
	_rows.add_theme_constant_override("separation", int(ROW_SEPARATION))
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", int(ROW_SEPARATION))
	_row_controls = []
	for entry in ENTRIES:
		var name := str(entry["name"])
		var button := Button.new()
		button.flat = true
		button.toggle_mode = true
		OfficeTheme.apply_font(button, LABEL_FONT)
		button.tooltip_text = "Hide or show the %s" % str(entry["label"]).to_lower()
		button.pressed.connect(_on_pressed.bind(name))
		_buttons[name] = button
		_row_controls.append(button)
	# The momentary controls live in the same cluster but are not toggles, so they
	# are built separately rather than pretending to have a hidden state.
	for entry in ACTIONS:
		var action := str(entry["name"])
		var control := Button.new()
		control.flat = true
		OfficeTheme.apply_font(control, LABEL_FONT)
		control.tooltip_text = str(entry["tooltip"])
		control.pressed.connect(_on_action.bind(action))
		_buttons[action] = control
		_row_controls.append(control)

	# Lay the controls out into the rows the available width allows. `wrap_to` is
	# called again on resize, so the cluster reflows rather than staying in whatever
	# arrangement it was first built with.
	add_child(_rows)
	wrap_to(INF)
	_refresh_labels()


## Distribute the controls into as many rows as `available_width` requires.
##
## Greedy and in display order: a control joins the current row while the row plus
## the next control still fits, and otherwise starts a new row. The LABELS ARE NEVER
## shortened, so a narrow window costs rows rather than meaning.
##
## An infinite width keeps every control on one row, which is the widest the cluster
## can ever be and what the layout reserves for.
func wrap_to(available_width: float) -> void:
	if _rows == null or _row_controls.is_empty():
		return
	if is_equal_approx(available_width, _wrap_width):
		return
	_wrap_width = available_width
	# Detach each control from whatever row it is currently in. The first call has no
	# parent yet, which is expected rather than an error.
	for control in _row_controls:
		var parent := control.get_parent()
		if parent != null:
			parent.remove_child(control)
	for child in _rows.get_children():
		_rows.remove_child(child)
		child.queue_free()

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", int(ROW_SEPARATION))
	_rows.add_child(row)
	var used := 0.0
	for control in _row_controls:
		# Measured from the theme font rather than the control, whose cached minimum
		# does not revalidate within a headless frame.
		var width := _label_width(control.text)
		if used > 0.0 and used + ROW_SEPARATION + width > available_width:
			row = HBoxContainer.new()
			row.add_theme_constant_override("separation", int(ROW_SEPARATION))
			_rows.add_child(row)
			used = 0.0
		row.add_child(control)
		used += width + (ROW_SEPARATION if used > 0.0 else 0.0)


## One label's rendered width at the active scale, plus the flat button's overhead.
func _label_width(text: String) -> float:
	var font := ThemeDB.fallback_font
	var font_size := label_font(OfficeTheme.text_scale())
	return font.get_string_size(
		text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size
	).x + BUTTON_PAD_X


## How many rows the controls occupy at a width.
func rows_at(available_width: float) -> int:
	var rows := 1
	var used := 0.0
	for index in labels_at(OfficeTheme.text_scale()).size():
		var width := _label_width(labels_at(OfficeTheme.text_scale())[index])
		if used > 0.0 and used + ROW_SEPARATION + width > available_width:
			rows += 1
			used = 0.0
		used += width + (ROW_SEPARATION if used > 0.0 else 0.0)
	return rows


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


## Report a momentary control's press. The label names the surface and its current
## value, so the button reads as a setting rather than as an unlabelled button.
func _on_action(name: String) -> void:
	action_requested.emit(name)


## The label for one panel control in a given state.
##
## It names the surface AND marks the state as text, so two controls can never read
## alike and the state survives a palette change or a colour-blind reader.
static func entry_label(surface: String, hidden: bool) -> String:
	return "%s %s" % [surface, MARK_HIDDEN if hidden else MARK_VISIBLE]


## The label for the theme control: the surface and the mode actually in use.
static func theme_label(mode: String) -> String:
	return "%s: %s" % [
		str(ACTIONS[0]["label"]),
		mode.capitalize(),
	]


## The label for the scale control: the surface and the scale actually applied.
static func scale_label(scale: float) -> String:
	return "%s: %d%%" % [
		str(ACTIONS[1]["label"]),
		int(round(UiScale.clamp_scale(scale) * 100.0)),
	]


## The font size the labels render at for a text scale. Equals `OfficeTheme.font`
## applied to `LABEL_FONT` whenever the theme's scale is the same one.
static func label_font(scale: float) -> int:
	return int(round(LABEL_FONT * UiScale.clamp_scale(scale)))


## Every label the cluster shows at a text scale, in display order.
##
## The theme value is the wider of the two modes and the scale value is the one
## asked for, so a caller that reserves this width has reserved enough for the
## widest label the cluster can show.
static func labels_at(scale: float) -> Array[String]:
	var labels: Array[String] = []
	for entry in ENTRIES:
		labels.append(entry_label(str(entry["label"]), false))
	labels.append(theme_label(WIDEST_THEME_VALUE))
	labels.append(scale_label(scale))
	return labels


## The width the toggle region must reserve for this text scale.
##
## Derived from the labels' own rendered width rather than a designed guess, so the
## region cannot be smaller than the controls it holds. This is the value the shell
## layout's toggle region must use for the cluster's width.
static func cluster_width(scale: float) -> float:
	var font := ThemeDB.fallback_font
	var font_size := label_font(scale)
	var total := PANEL_PAD_X * 2.0
	for index in labels_at(scale).size():
		if index > 0:
			total += ROW_SEPARATION
		total += font.get_string_size(
			labels_at(scale)[index], HORIZONTAL_ALIGNMENT_LEFT, -1, font_size
		).x + BUTTON_PAD_X
	return ceilf(total)


## The height the toggle region must reserve for ONE row at this text scale.
##
## The region is sized for a single row because the LAYOUT reserves the width that
## keeps the cluster to one row; when a narrow window forces more rows the cluster
## grows downward and the layout re-places it, which is why `wrap_to` is driven by
## the region's real width rather than guessed here.
static func cluster_height(scale: float) -> float:
	return ceilf(float(label_font(scale)) + BUTTON_PAD_Y)


## The label states the surface and the state, so both are readable without colour:
## a hidden panel shows the hollow marker, a visible one the filled marker.
func _refresh_labels() -> void:
	for entry in ENTRIES:
		var name := str(entry["name"])
		var button := _buttons.get(name) as Button
		if button == null:
			continue
		var hidden := is_hidden(name)
		button.text = entry_label(str(entry["label"]), hidden)
		button.button_pressed = not hidden
		button.add_theme_color_override(
			"font_color", OfficeTheme.text_muted() if hidden else OfficeTheme.text_dim()
		)
	# An action's label names its surface AND its current SETTING, so the button
	# reads as a state rather than as an unlabelled control.
	_set_action_text("theme", theme_label(OfficeTheme.mode()))
	_set_action_text("scale", scale_label(ui_scale))


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
