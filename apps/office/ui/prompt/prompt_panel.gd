## Prompt composer.
##
## Ordinary task text, exactly like the TUI. In DEMO the composer is a preview:
## submitting never sends a mutation. It does not script employee movement,
## inject roleplay, or select an agent on the user's behalf.
class_name PromptPanel
extends PanelContainer

signal prompt_submitted(text: String)

var _input: TextEdit
var _button: Button
var _notice: Label
var _mode: String = OfficeStore.MODE_DEMO


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)

	var header := HBoxContainer.new()
	header.add_child(OfficeTheme.heading("Prompt"))
	var hint := Label.new()
	hint.text = "Ctrl+Enter to send"
	hint.add_theme_font_size_override("font_size", 11)
	hint.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	header.add_child(hint)

	_input = TextEdit.new()
	_input.custom_minimum_size = Vector2(0, 76)
	_input.placeholder_text = "Describe the task, as you would in the TUI…"
	_input.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_input.add_theme_font_size_override("font_size", 14)
	_input.add_theme_stylebox_override("normal", OfficeTheme.panel_style(OfficeTheme.BG_INPUT))
	_input.add_theme_stylebox_override("focus", OfficeTheme.panel_style(OfficeTheme.BG_INPUT))
	_input.add_theme_color_override("font_color", OfficeTheme.TEXT)
	_input.add_theme_color_override("font_placeholder_color", OfficeTheme.TEXT_MUTED)
	_input.gui_input.connect(_on_input_event)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	_button = OfficeTheme.button("Send", true)
	_button.pressed.connect(_on_send)
	_notice = Label.new()
	_notice.add_theme_font_size_override("font_size", 11)
	_notice.add_theme_color_override("font_color", OfficeTheme.ACCENT_WARM)
	_notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_notice.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(_button)
	row.add_child(_notice)

	box.add_child(header)
	box.add_child(_input)
	box.add_child(row)
	add_child(box)


func set_mode(mode: String) -> void:
	_mode = mode
	if _button != null and mode == OfficeStore.MODE_DEMO:
		_button.tooltip_text = "DEMO: submitting records the text locally only"


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


## States the DEMO boundary instead of pretending a prompt was delivered.
func show_demo_notice(text: String) -> void:
	var preview := text if text.length() <= 60 else text.substr(0, 60) + "…"
	_notice.text = "DEMO preview — recorded locally, not sent: “%s”" % preview


func current_text() -> String:
	return _input.text
