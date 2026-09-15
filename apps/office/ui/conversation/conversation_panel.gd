## Conversation drawer.
##
## Shows source-backed items for one scoped assignment. Items are grouped by
## kind, and anything without a verifiable source is labelled as an unattributed
## status, never presented as a quote.
class_name ConversationPanel
extends PanelContainer

signal close_requested

const KIND_LABELS := {
	"delegation": "Delegation",
	"question": "Question",
	"answer": "Answer",
	"report": "Report",
	"review": "Review",
}

const KIND_COLORS := {
	"delegation": OfficeTheme.ACCENT,
	"question": OfficeTheme.ACCENT_WARM,
	"answer": OfficeTheme.OK,
	"report": OfficeTheme.TEXT,
	"review": OfficeTheme.TEXT_DIM,
}

const KIND_ORDER := ["delegation", "question", "answer", "report", "review"]

var _title: Label
var _subtitle: Label
var _list: VBoxContainer
var _source: Label


func _ready() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)

	var header := HBoxContainer.new()
	var titles := VBoxContainer.new()
	titles.add_theme_constant_override("separation", 1)
	titles.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_title = Label.new()
	_title.add_theme_font_size_override("font_size", 15)
	_title.add_theme_color_override("font_color", OfficeTheme.TEXT)
	_subtitle = Label.new()
	_subtitle.add_theme_font_size_override("font_size", 11)
	_subtitle.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	titles.add_child(_title)
	titles.add_child(_subtitle)
	header.add_child(titles)
	header.add_child(OfficeTheme.button("Close"))
	(header.get_child(1) as Button).pressed.connect(func(): close_requested.emit())

	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(0, 200)
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 8)
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)

	_source = Label.new()
	_source.add_theme_font_size_override("font_size", 10)
	_source.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	_source.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART

	box.add_child(header)
	box.add_child(scroll)
	box.add_child(_source)
	add_child(box)


func show_actor(store: OfficeStore, session_id: String, room: String = "") -> void:
	visible = true
	var actor := store.actor_for(session_id)
	_title.text = actor.identity.display_name if actor != null else session_id
	var status := actor.status_label if actor != null else ""
	var parts: Array[String] = []
	for part in [room, status, session_id]:
		if not str(part).is_empty():
			parts.append(str(part))
	_subtitle.text = " · ".join(parts)
	for child in _list.get_children():
		child.queue_free()
	var items := store.conversation_items(session_id)
	if items.is_empty():
		_list.add_child(
			OfficeTheme.body("No source-backed items for this assignment yet.", true)
		)
		_source.text = ""
		return
	for item in items:
		_list.add_child(_build_item(item))
	_source.text = "Source: %s" % str(items[-1].get("source", "unknown"))


func _build_item(item: Dictionary) -> Control:
	var kind := str(item.get("kind", "item"))
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.BG_PANEL_ALT))
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 3)
	var tag := Label.new()
	tag.text = str(KIND_LABELS.get(kind, kind.capitalize()))
	tag.add_theme_font_size_override("font_size", 11)
	tag.add_theme_color_override("font_color", KIND_COLORS.get(kind, OfficeTheme.TEXT_DIM))
	var body := OfficeTheme.body(str(item.get("description", "")), true)
	box.add_child(tag)
	box.add_child(body)
	card.add_child(box)
	return card
