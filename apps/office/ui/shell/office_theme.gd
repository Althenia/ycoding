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
## The elevated surface floating chrome sits on, a shade above the panels.
const BG_PANEL_ELEVATED := Color("2a2e39")
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


## The composer card: generously rounded, elevated, and opaque so the pixel art
## behind it never reduces the legibility of the text on it.
static func card_style(bg: Color = BG_PANEL_ELEVATED) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.border_color = Color(1, 1, 1, 0.06)
	style.set_border_width_all(1)
	style.set_corner_radius_all(18)
	style.content_margin_left = 14.0
	style.content_margin_right = 14.0
	style.content_margin_top = 12.0
	style.content_margin_bottom = 12.0
	style.shadow_color = Color(0, 0, 0, 0.35)
	style.shadow_size = 10
	style.shadow_offset = Vector2(0, 3)
	return style


## The input's resting surface: transparent, because the card already supplies the
## background and a second fill would read as a box inside a box.
static func input_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0, 0, 0, 0)
	style.content_margin_left = 4.0
	style.content_margin_right = 4.0
	style.content_margin_top = 4.0
	style.content_margin_bottom = 4.0
	return style


## Focus keeps the card's surface and gains a soft accent underline, so focus is
## visible without the input changing size.
static func input_focus_style() -> StyleBoxFlat:
	var style := input_style()
	style.border_color = Color(ACCENT.r, ACCENT.g, ACCENT.b, 0.55)
	style.border_width_bottom = 2
	return style


## A compact control for the composer's control row.
static func icon_button(text: String) -> Button:
	var control := Button.new()
	control.text = text
	control.flat = true
	control.add_theme_font_size_override("font_size", 16)
	control.add_theme_color_override("font_color", OfficeTheme.TEXT_DIM)
	control.add_theme_color_override("font_hover_color", OfficeTheme.TEXT)
	control.add_theme_stylebox_override("hover", button_style(BG_PANEL_ALT))
	control.add_theme_stylebox_override("pressed", button_style(BG_INPUT))
	apply_focus_style(control)
	return control


## The model and effort pill. Wider than a plain button, and quieter, because it
## sits beside the send action rather than competing with it.
static func pill_button(text: String) -> Button:
	var control := Button.new()
	control.text = text
	control.add_theme_font_size_override("font_size", 14)
	control.add_theme_color_override("font_color", TEXT)
	control.add_theme_stylebox_override("normal", button_style(BG_PANEL_ALT))
	control.add_theme_stylebox_override("hover", button_style(BORDER))
	control.add_theme_stylebox_override("pressed", button_style(BG_INPUT))
	apply_focus_style(control)
	return control


## The circular send action, matching the reference's filled round button.
static func send_button() -> Button:
	var control := Button.new()
	control.text = "↑"
	control.custom_minimum_size = Vector2(34, 34)
	control.add_theme_font_size_override("font_size", 17)
	control.add_theme_color_override("font_color", Color("11141a"))
	var filled := button_style(TEXT)
	filled.set_corner_radius_all(17)
	filled.content_margin_left = 0.0
	filled.content_margin_right = 0.0
	control.add_theme_stylebox_override("normal", filled)
	var hover := button_style(ACCENT)
	hover.set_corner_radius_all(17)
	hover.content_margin_left = 0.0
	hover.content_margin_right = 0.0
	control.add_theme_stylebox_override("hover", hover)
	var pressed := button_style(TEXT_DIM)
	pressed.set_corner_radius_all(17)
	pressed.content_margin_left = 0.0
	pressed.content_margin_right = 0.0
	control.add_theme_stylebox_override("pressed", pressed)
	apply_focus_style(control)
	return control


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


## A small uppercase section heading, like the reference's "Projects"/"Recents".
static func section_label(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 11)
	label.add_theme_color_override("font_color", TEXT_MUTED)
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
