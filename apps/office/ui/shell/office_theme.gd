## Shared UI theme.
##
## One place defines the panel, button and label styling so every surface looks
## like the same product. Kept in code rather than a .tres so it stays readable
## in review and cannot drift from the theme constants used at runtime.
class_name OfficeTheme
extends RefCounted

const BG_WINDOW := Color("22252e")
const BG_PANEL := Color("2b2f3a")
const BG_PANEL_ALT := Color("333846")
const BG_INPUT := Color("1d2029")
const BORDER := Color("4a5163")
const BORDER_SOFT := Color("3a4050")
const TEXT := Color("e8eaf0")
const TEXT_DIM := Color("a8aec0")
const TEXT_MUTED := Color("7b8296")
const ACCENT := Color("6fb2e8")
const ACCENT_WARM := Color("f0c060")
const DANGER := Color("e07a7a")
const OK := Color("86c98a")


static func panel_style(bg: Color = BG_PANEL) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.border_color = BORDER_SOFT
	style.set_border_width_all(1)
	style.set_corner_radius_all(6)
	style.content_margin_left = 12.0
	style.content_margin_right = 12.0
	style.content_margin_top = 10.0
	style.content_margin_bottom = 10.0
	return style


static func button_style(bg: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.border_color = BORDER_SOFT
	style.set_border_width_all(1)
	style.set_corner_radius_all(5)
	style.content_margin_left = 10.0
	style.content_margin_right = 10.0
	style.content_margin_top = 6.0
	style.content_margin_bottom = 6.0
	return style


## The visible keyboard-focus ring.
##
## Focus must be distinguishable from the unfocused state by more than a shade,
## so the ring is wider, uses the accent hue, and carries an outer margin that
## pushes it clear of the control's own border.
static func focus_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.draw_center = false
	style.bg_color = Color(0, 0, 0, 0)
	style.border_color = ACCENT
	style.set_border_width_all(2)
	style.set_corner_radius_all(7)
	style.set_expand_margin_all(2.0)
	return style


## Focus ring for a control that also carries a background, so the focused state
## keeps the filled surface and gains the accent border.
static func focus_fill_style(bg: Color) -> StyleBoxFlat:
	var style := panel_style(bg)
	style.border_color = ACCENT
	style.set_border_width_all(2)
	return style


## Apply the focus ring to any control that can take keyboard focus.
static func apply_focus_style(control: Control, filled_bg: Variant = null) -> void:
	if control == null:
		return
	control.focus_mode = Control.FOCUS_ALL
	control.add_theme_stylebox_override(
		"focus",
		focus_style() if filled_bg == null else focus_fill_style(filled_bg)
	)


## Apply the base font sizes and colors to a Control tree.
static func apply(root: Control) -> void:
	root.add_theme_font_size_override("font_size", 13)
	root.add_theme_color_override("font_color", TEXT)


static func heading(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 13)
	label.add_theme_color_override("font_color", TEXT_DIM)
	return label


static func body(text: String, dim: bool = false) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 14)
	label.add_theme_color_override("font_color", TEXT_DIM if dim else TEXT)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return label


static func button(text: String, primary: bool = false) -> Button:
	var control := Button.new()
	control.text = text
	control.add_theme_font_size_override("font_size", 13)
	control.add_theme_stylebox_override(
		"normal", button_style(ACCENT if primary else BG_PANEL_ALT)
	)
	control.add_theme_stylebox_override("hover", button_style(BORDER))
	control.add_theme_stylebox_override("pressed", button_style(BG_INPUT))
	control.add_theme_stylebox_override("disabled", button_style(BG_PANEL))
	control.add_theme_color_override(
		"font_color", Color("1b1d23") if primary else TEXT
	)
	apply_focus_style(control)
	return control
