## Shared UI theme.
##
## One place defines the panel, button and label styling so every surface looks
## like the same product. Kept in code rather than a .tres so it stays readable
## in review and cannot drift from the theme constants used at runtime.
class_name OfficeTheme
extends RefCounted

## The active mode. Every colour below resolves against it, so switching the mode
## repaints the whole interface without rebuilding a node.
static var _mode: String = OfficePalette.MODE_DARK
## The interface text scale. Applied to every font size, so text grows and the
## panels containing it grow with it. The office art is NOT scaled: enlarging the
## interface must not zoom the world it presents, which is why this is a font
## factor rather than the window's content scale.
static var _text_scale: float = 1.0


## The text scale in use.
static func text_scale() -> float:
	return _text_scale


## Set the text scale. Returns whether anything changed.
static func set_text_scale(value: float) -> bool:
	var safe := UiScale.clamp_scale(value)
	if is_equal_approx(safe, _text_scale):
		return false
	_text_scale = safe
	return true


## A font size at the active text scale.
##
## Every font override goes through this, so raising the scale enlarges all text
## together and no surface is left at the old size.
static func font(size: int) -> int:
	return int(round(size * _text_scale))


## The metadata key holding a control's authored (unscaled) font size.
const FONT_BASE_KEY := "office_font_base"


## Apply a font size that follows the text scale.
##
## The authored size is recorded on the control, so the scale can be re-applied
## later without knowing what the original was. A raw `add_theme_font_size_override`
## bakes the size once and would ignore every later change.
static func apply_font(control: Control, size: int) -> void:
	if control == null:
		return
	control.set_meta(FONT_BASE_KEY, size)
	control.add_theme_font_size_override("font_size", font(size))


## Re-apply the scaled size to a control and every control beneath it.
##
## Called when the text scale changes: a size is baked into an override when it is
## set, so an existing interface keeps the old size until it is re-applied.
static func rescale(root: Node) -> void:
	if root == null:
		return
	if root is Control and root.has_meta(FONT_BASE_KEY):
		var control := root as Control
		control.add_theme_font_size_override("font_size", font(int(control.get_meta(FONT_BASE_KEY))))
	for child in root.get_children():
		rescale(child)


## The palette mode in use.
static func mode() -> String:
	return _mode


## Switch palette mode. Returns whether anything changed, so a caller only repaints
## when the mode actually moved.
static func set_mode(next: String) -> bool:
	if not OfficePalette.is_mode(next) or next == _mode:
		return false
	_mode = next
	return true


## A tone from the active mode. These are functions rather than constants because a
## constant is captured once, while a mode can change at runtime.
static func tone(role: String) -> Color:
	return OfficePalette.color_of(role, _mode)


static func bg_window() -> Color:
	return tone("bg_window")


static func bg_panel() -> Color:
	return tone("bg_panel")


static func bg_panel_alt() -> Color:
	return tone("bg_panel_alt")


static func bg_input() -> Color:
	return tone("bg_input")


static func bg_elevated() -> Color:
	return tone("bg_elevated")


static func border() -> Color:
	return tone("border")


static func border_soft() -> Color:
	return tone("border_soft")


static func text() -> Color:
	return tone("text")


static func text_dim() -> Color:
	return tone("text_dim")


static func text_muted() -> Color:
	return tone("text_muted")


static func accent() -> Color:
	return tone("accent")


static func accent_warm() -> Color:
	return tone("accent_warm")


static func danger() -> Color:
	return tone("danger")


static func ok() -> Color:
	return tone("ok")


static func panel_style(bg: Color = Color(0, 0, 0, 0)) -> StyleBoxFlat:
	if bg.a == 0.0:
		bg = bg_panel()
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.border_color = border_soft()
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
	style.border_color = border_soft()
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
	style.border_color = accent()
	style.set_border_width_all(2)
	style.set_corner_radius_all(7)
	style.set_expand_margin_all(2.0)
	return style


## Focus ring for a control that also carries a background, so the focused state
## keeps the filled surface and gains the accent border.
static func focus_fill_style(bg: Color) -> StyleBoxFlat:
	var style := panel_style(bg)
	style.border_color = accent()
	style.set_border_width_all(2)
	return style


## The composer card: generously rounded, elevated, and opaque so the pixel art
## behind it never reduces the legibility of the text on it.
static func card_style(bg: Color = Color(0, 0, 0, 0)) -> StyleBoxFlat:
	if bg.a == 0.0:
		bg = bg_elevated()
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
	var ring := accent()
	style.border_color = Color(ring.r, ring.g, ring.b, 0.55)
	style.border_width_bottom = 2
	return style


## A compact control for the composer's control row.
static func icon_button(text: String) -> Button:
	var control := Button.new()
	control.text = text
	control.flat = true
	apply_font(control, 16)
	control.add_theme_color_override("font_color", text_dim())
	control.add_theme_color_override("font_hover_color", text())
	control.add_theme_stylebox_override("hover", button_style(bg_panel_alt()))
	control.add_theme_stylebox_override("pressed", button_style(bg_input()))
	apply_focus_style(control)
	return control


## The model and effort pill. Wider than a plain button, and quieter, because it
## sits beside the send action rather than competing with it.
static func pill_button(text: String) -> Button:
	var control := Button.new()
	control.text = text
	apply_font(control, 14)
	control.add_theme_color_override("font_color", text())
	control.add_theme_stylebox_override("normal", button_style(bg_panel_alt()))
	control.add_theme_stylebox_override("hover", button_style(border()))
	control.add_theme_stylebox_override("pressed", button_style(bg_input()))
	apply_focus_style(control)
	return control


## The circular send action, matching the reference's filled round button.
static func send_button() -> Button:
	var control := Button.new()
	control.text = "↑"
	control.custom_minimum_size = Vector2(34, 34)
	apply_font(control, 17)
	control.add_theme_color_override("font_color", Color("11141a"))
	var filled := button_style(text())
	filled.set_corner_radius_all(17)
	filled.content_margin_left = 0.0
	filled.content_margin_right = 0.0
	control.add_theme_stylebox_override("normal", filled)
	var hover := button_style(accent())
	hover.set_corner_radius_all(17)
	hover.content_margin_left = 0.0
	hover.content_margin_right = 0.0
	control.add_theme_stylebox_override("hover", hover)
	var pressed := button_style(text_dim())
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
	apply_font(root, 13)
	root.add_theme_color_override("font_color", text())


static func heading(text: String) -> Label:
	var label := Label.new()
	label.text = text
	apply_font(label, 13)
	label.add_theme_color_override("font_color", text_dim())
	return label


## A small uppercase section heading, like the reference's "Projects"/"Recents".
static func section_label(text: String) -> Label:
	var label := Label.new()
	label.text = text
	apply_font(label, 11)
	label.add_theme_color_override("font_color", text_muted())
	return label


static func body(text: String, dim: bool = false) -> Label:
	var label := Label.new()
	label.text = text
	apply_font(label, 14)
	label.add_theme_color_override("font_color", text_dim() if dim else text())
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return label


static func button(text: String, primary: bool = false) -> Button:
	var control := Button.new()
	control.text = text
	apply_font(control, 13)
	control.add_theme_stylebox_override(
		"normal", button_style(accent() if primary else bg_panel_alt())
	)
	control.add_theme_stylebox_override("hover", button_style(border()))
	control.add_theme_stylebox_override("pressed", button_style(bg_input()))
	control.add_theme_stylebox_override("disabled", button_style(bg_panel()))
	control.add_theme_color_override(
		"font_color", Color("1b1d23") if primary else text()
	)
	apply_focus_style(control)
	return control
