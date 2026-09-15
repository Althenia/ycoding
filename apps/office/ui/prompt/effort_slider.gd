## Effort picker.
##
## The card from the reference: a lightning glyph and a reset on the top line, the
## current variant in accent and the model beneath it, then a slider whose track
## fills to the knob and whose dots sit at the REAL stops.
##
## The stops come from the model's own `variants`. A model with three variants
## gets three dots; the catalogue is never padded to a fixed count, because the
## service would reject a variant the model does not declare.
class_name EffortSlider
extends PanelContainer

signal variant_chosen(variant: String)

const CARD_W := 300.0
## The card's height is declared rather than left to its content, because the
## composer clamps the popover into the window and a zero minimum would make that
## clamp place it off-screen. Must match what the rows actually need.
const CARD_H := 142.0
const TRACK_H := 30.0
## Radius of a stop dot, and of the knob.
const DOT_R := 4.0
const KNOB_R := 13.0
const PAD := 14.0

var _title: Label
var _model: Label
var _reset: Button
var _track: EffortTrack
var _stops: Array[String] = []
var _variants: Array[String] = []
var _index := 0


func _ready() -> void:
	_build()


var _built := false


## Construct the card. Safe to call more than once; only the first call builds.
func _build() -> void:
	if _built:
		return
	_built = true
	custom_minimum_size = Vector2(CARD_W, CARD_H)
	add_theme_stylebox_override("panel", OfficeTheme.card_style(OfficeTheme.BG_PANEL_ALT))
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 4)

	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	var bolt := Label.new()
	bolt.text = "⚡"
	bolt.add_theme_font_size_override("font_size", 15)
	bolt.add_theme_color_override("font_color", OfficeTheme.TEXT_DIM)
	head.add_child(bolt)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(spacer)
	_reset = OfficeTheme.icon_button("")
	_reset.tooltip_text = "Reset to the model's default effort"
	_reset.pressed.connect(_on_reset)
	head.add_child(_reset)
	box.add_child(head)

	var names := HBoxContainer.new()
	names.add_theme_constant_override("separation", 6)
	var name_spacer := Control.new()
	name_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	names.add_child(name_spacer)
	_title = Label.new()
	_title.add_theme_font_size_override("font_size", 16)
	_title.add_theme_color_override("font_color", OfficeTheme.ACCENT)
	names.add_child(_title)
	var arrow := Label.new()
	arrow.text = ">"
	arrow.add_theme_font_size_override("font_size", 14)
	arrow.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	names.add_child(arrow)
	var tail := Control.new()
	tail.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	names.add_child(tail)
	box.add_child(names)

	_model = Label.new()
	_model.add_theme_font_size_override("font_size", 15)
	_model.add_theme_color_override("font_color", OfficeTheme.TEXT)
	_model.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(_model)

	_track = EffortTrack.new()
	_track.custom_minimum_size = Vector2(0, TRACK_H)
	_track.clicked.connect(_on_track_clicked)
	box.add_child(_track)

	add_child(box)


## Load a model and the variant it is currently on.
##
## Builds the card if it has not been built yet, so the caller never has to know
## whether the node has entered the tree. An earlier version assumed `_ready` had
## run and raised when a caller opened it first.
func open(entry: Dictionary, variant: String, stops: Array[String]) -> void:
	if not _built:
		_build()
	_stops = stops
	_variants = stops
	_index = maxi(ModelCatalog.variant_index(entry, variant), 0)
	_model.text = ModelCatalog.model_label(entry)
	_sync()


func variants() -> Array[String]:
	return _variants.duplicate()


func selected_variant() -> String:
	return _variants[_index] if _index >= 0 and _index < _variants.size() else ""


func current_index() -> int:
	return _index


## The fraction along the track the knob sits at, 0 when there is one stop.
func knob_fraction() -> float:
	if _variants.size() <= 1:
		return 0.0
	return float(_index) / float(_variants.size() - 1)


func _sync() -> void:
	_title.text = ModelCatalog.variant_label(selected_variant())
	_track.set_state(_variants.size(), _index)
	_track.queue_redraw()


## Pick the stop nearest a click along the track.
func _on_track_clicked(fraction: float) -> void:
	if _variants.size() <= 1:
		return
	_index = clampi(roundi(fraction * float(_variants.size() - 1)), 0, _variants.size() - 1)
	_sync()


func _on_reset() -> void:
	# The reset returns to the first stop, which is the mildest the model offers.
	_index = 0
	_sync()
	variant_chosen.emit(selected_variant())


## The track is a separate Control so it can report clicks in its own space and
## draw the fill, dots and knob without the container's padding interfering.
class EffortTrack:
	extends Control

	signal clicked(fraction: float)

	var _count := 0
	var _index := 0

	func set_state(count: int, index: int) -> void:
		_count = count
		_index = index

	func _gui_input(event: InputEvent) -> void:
		if not (event is InputEventMouseButton):
			return
		var button := event as InputEventMouseButton
		if not button.pressed or button.button_index != MOUSE_BUTTON_LEFT:
			return
		var span := maxf(size.x - EffortSlider.KNOB_R * 2.0, 1.0)
		clicked.emit(clampf((button.position.x - EffortSlider.KNOB_R) / span, 0.0, 1.0))

	func _draw() -> void:
		if _count <= 0:
			return
		var left := EffortSlider.KNOB_R
		var span := maxf(size.x - EffortSlider.KNOB_R * 2.0, 1.0)
		var cy := size.y * 0.5
		var fraction := 0.0 if _count <= 1 else float(_index) / float(_count - 1)
		# Track.
		draw_rect(
			Rect2(Vector2(0.0, cy - EffortSlider.TRACK_H * 0.5), Vector2(size.x, EffortSlider.TRACK_H)),
			EffortSlider.TRACK_BG,
			true
		)
		# Fill up to the knob.
		var knob_x := left + span * fraction
		draw_rect(
			Rect2(Vector2(0.0, cy - EffortSlider.TRACK_H * 0.5), Vector2(maxf(knob_x, EffortSlider.KNOB_R), EffortSlider.TRACK_H)),
			EffortSlider.TRACK_FILL,
			true
		)
		# Dots at the REAL stops, so the user sees how many choices exist.
		for i in _count:
			var x := left + span * (0.0 if _count <= 1 else float(i) / float(_count - 1))
			draw_circle(
				Vector2(x, cy),
				EffortSlider.DOT_R,
				EffortSlider.KNOB if i == _index else EffortSlider.DOT
			)
		# Knob.
		if _count > 1:
			draw_circle(Vector2(knob_x, cy), EffortSlider.KNOB_R, EffortSlider.KNOB)
			draw_arc(
				Vector2(knob_x, cy), EffortSlider.KNOB_R, 0.0, TAU, 32,
				EffortSlider.KNOB_EDGE, 1.0
			)


const TRACK_BG := Color("3a3f4d")
const TRACK_FILL := Color("4a8ff0")
const DOT := Color(1, 1, 1, 0.35)
const KNOB := Color("f2f4f8")
const KNOB_EDGE := Color(0, 0, 0, 0.20)