## Conversation drawer.
##
## Shows source-backed items for one scoped assignment. Items are grouped by
## kind, and anything without a verifiable source is labelled as an unattributed
## status, never presented as a quote.
class_name ConversationPanel
extends PanelContainer

signal close_requested
## A human decision for a pending request. The panel never answers on its own: it
## only reports which reply the user chose, and the composition root performs it.
signal attention_replied(request_id: String, body: Dictionary)

const KIND_LABELS := {
	"delegation": "Delegation",
	"question": "Question",
	"answer": "Answer",
	"report": "Report",
	"review": "Review",
	"file_change": "File change",
}

## A kind's accent, resolved against the active palette. A function rather than a
## constant because the palette can change mode at runtime.
func _kind_color(kind: String) -> Color:
	match kind:
		"file_change":
			return OfficeTheme.text_dim()
		"delegation":
			return OfficeTheme.accent()
		"question":
			return OfficeTheme.accent_warm()
		"answer":
			return OfficeTheme.ok()
		"report":
			return OfficeTheme.text()
		"review":
			return OfficeTheme.text_dim()
	return OfficeTheme.text_dim()

const KIND_ORDER := [
	"delegation", "question", "answer", "report", "review", "file_change",
]

## The drawer's own text when a filter matches nothing. Stale rows would present
## another assignment's history as this one's, so the empty state replaces them.
const FILTER_EMPTY := "No items match this filter."

## Shown when the wire did not report a change kind: the drawer states that rather
## than guessing one from the counts.
const CHANGE_KIND_UNREPORTED := "change kind not reported"

## The replies the runtime accepts for a permission or guardrail review. These are
## the schema's literals, not a UI invention.
const REVIEW_REPLIES := ["once", "always", "reject"]

var _attention_box: VBoxContainer
var _thread_filter: OptionButton
var _kind_filter: OptionButton
## The whole family's items, before the filters narrow them.
var _thread_items: Array[Dictionary] = []
## The session the drawer is showing, and the family it belongs to.
var _session_id: String = ""
var _store: OfficeStore
var _family: Array[String] = []

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
	OfficeTheme.apply_font(_title, 15)
	_title.add_theme_color_override("font_color", OfficeTheme.text())
	_subtitle = Label.new()
	OfficeTheme.apply_font(_subtitle, 11)
	_subtitle.add_theme_color_override("font_color", OfficeTheme.text_muted())
	titles.add_child(_title)
	titles.add_child(_subtitle)
	header.add_child(titles)
	header.add_child(OfficeTheme.button("Close"))
	(header.get_child(1) as Button).pressed.connect(func(): close_requested.emit())

	# Filters over the real family and the real kinds. A kind with no items is not
	# offered, so the control cannot select an empty set.
	var filters := HBoxContainer.new()
	filters.add_theme_constant_override("separation", 6)
	_thread_filter = OptionButton.new()
	_thread_filter.name = "ThreadFilter"
	OfficeTheme.apply_font(_thread_filter, 11)
	_thread_filter.item_selected.connect(func(_index: int): _render())
	_kind_filter = OptionButton.new()
	_kind_filter.name = "KindFilter"
	OfficeTheme.apply_font(_kind_filter, 11)
	_kind_filter.item_selected.connect(func(_index: int): _render())
	filters.add_child(_thread_filter)
	filters.add_child(_kind_filter)

	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(0, 200)
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 8)
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)

	_source = Label.new()
	OfficeTheme.apply_font(_source, 10)
	_source.add_theme_color_override("font_color", OfficeTheme.text_muted())
	_source.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART

	# Pending human attention sits above the history, because a blocked session is
	# the one thing that needs the user. An empty box takes no space.
	_attention_box = VBoxContainer.new()
	_attention_box.add_theme_constant_override("separation", 6)

	box.add_child(header)
	box.add_child(filters)
	box.add_child(_attention_box)
	box.add_child(scroll)
	box.add_child(_source)
	add_child(box)




## Re-apply what `_ready` baked into styleboxes and colours.
##
## A palette change alters the palette, not the nodes: colours read at paint time
## follow on their own, but a StyleBox and an override capture their value once, so
## the surfaces carrying one are restyled explicitly.
func restyle() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())

func show_actor(store: OfficeStore, session_id: String, room: String = "") -> void:
	visible = true
	_store = store
	_session_id = session_id
	_family = store.family_session_ids(session_id) if store.has_method("family_session_ids") else [session_id]
	if _family.is_empty():
		_family = [session_id]
	var actor := store.actor_for(session_id)
	_title.text = actor.identity.display_name if actor != null else session_id
	var status := actor.status_label if actor != null else ""
	var parts: Array[String] = []
	for part in [room, status, session_id]:
		if not str(part).is_empty():
			parts.append(str(part))
	_subtitle.text = " · ".join(parts)

	# One thread is a real session family, so a root's items and its children's
	# items read as one conversation rather than the drawer going blank when a
	# child is selected.
	_thread_items = []
	for member in _family:
		_thread_items.append_array(store.conversation_items(member))

	_clear(_list)
	_clear(_attention_box)
	_build_attention(store, session_id)
	_refresh_filters(store)
	_render()


## Detach every child now and free it.
##
## `queue_free` defers to the end of the frame, so a caller reading the list in
## the same call would still see the previous rows and could present another
## assignment's history as this one's.
func _clear(box: Node) -> void:
	for child in box.get_children():
		box.remove_child(child)
		child.queue_free()


## Offer the real family and the real kinds present, nothing else.
func _refresh_filters(store: OfficeStore) -> void:
	_thread_filter.clear()
	_thread_filter.add_item("Whole thread")
	_thread_filter.set_item_metadata(0, "")
	for member in _family:
		var member_actor := store.actor_for(member)
		var label := member_actor.identity.display_name if member_actor != null else member
		_thread_filter.add_item(label)
		_thread_filter.set_item_metadata(_thread_filter.item_count - 1, member)
	_kind_filter.clear()
	_kind_filter.add_item("All kinds")
	_kind_filter.set_item_metadata(0, "")
	var present: Array[String] = []
	for item in _thread_items:
		var kind := str(item.get("kind", ""))
		if not present.has(kind):
			present.append(kind)
	for kind in KIND_ORDER:
		if present.has(kind):
			_kind_filter.add_item(str(KIND_LABELS.get(kind, kind)))
			_kind_filter.set_item_metadata(_kind_filter.item_count - 1, kind)
	for kind in present:
		if not KIND_ORDER.has(kind):
			_kind_filter.add_item(str(kind.capitalize()))
			_kind_filter.set_item_metadata(_kind_filter.item_count - 1, kind)


## Draw the rows the filters currently select.
##
## A filter matching nothing shows an empty state and no earlier rows: leaving the
## previous selection visible would present another assignment's history as this
## one's.
func _render() -> void:
	_clear(_list)
	var thread := str(_thread_filter.get_item_metadata(_thread_filter.selected)) \
		if _thread_filter.selected >= 0 and _thread_filter.item_count > 0 else ""
	var kind := str(_kind_filter.get_item_metadata(_kind_filter.selected)) \
		if _kind_filter.selected >= 0 and _kind_filter.item_count > 0 else ""
	var shown: Array[Dictionary] = []
	for item in _thread_items:
		if not thread.is_empty() and str(item.get("session_id", "")) != thread:
			continue
		if not kind.is_empty() and str(item.get("kind", "")) != kind:
			continue
		shown.append(item)
	if shown.is_empty():
		_list.add_child(OfficeTheme.body(FILTER_EMPTY, true))
		_source.text = ""
		return
	for item in shown:
		_list.add_child(_build_item(item))
	_source.text = "Source: %s" % str(shown[-1].get("source", "unknown"))


## A pending question, permission or guardrail review for this assignment.
##
## The options come from the runtime, never from the UI: a question offers the
## labels it supplied, and a review offers exactly the three schema replies.
func _build_attention(store: OfficeStore, session_id: String) -> void:
	var request := store.attention.for_session(session_id)
	if request.is_empty():
		return
	var kind := str(request.get("kind", ""))
	var data: Dictionary = request.get("data", {})
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.bg_elevated()))
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)

	var tag := Label.new()
	tag.text = "Needs you · %s" % str(KIND_LABELS.get(kind, kind)).capitalize()
	OfficeTheme.apply_font(tag, 11)
	tag.add_theme_color_override("font_color", OfficeTheme.accent_warm())

	var prompt := Label.new()
	prompt.text = str(data.get("summary", ""))
	OfficeTheme.apply_font(prompt, 12)
	prompt.add_theme_color_override("font_color", OfficeTheme.text())
	prompt.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	var request_id := str(request.get("id", ""))
	if kind == AttentionQueue.KIND_QUESTION:
		_add_question_choices(row, request_id, data)
	else:
		for reply in REVIEW_REPLIES:
			var button := OfficeTheme.button(_reply_label(reply))
			button.pressed.connect(
				func() -> void: attention_replied.emit(request_id, {"reply": reply})
			)
			row.add_child(button)

	box.add_child(tag)
	box.add_child(prompt)
	box.add_child(row)
	card.add_child(box)
	_attention_box.add_child(card)


## A question's choices are the labels the runtime supplied, positionally: the
## reply is `answers`, which is an array per question.
func _add_question_choices(row: HBoxContainer, request_id: String, data: Dictionary) -> void:
	var options: Array = data.get("options", [])
	if options.is_empty():
		row.add_child(OfficeTheme.body("No choices were supplied.", true))
		return
	var labels: Array[String] = []
	for option in options:
		labels.append(str((option as Dictionary).get("label", "")))
	for index in labels.size():
		var chosen := [labels[index]]
		var button := OfficeTheme.button(labels[index])
		button.pressed.connect(
			func() -> void: attention_replied.emit(request_id, {"answers": [chosen]})
		)
		row.add_child(button)


## A review reply, worded for a person. The value sent is the schema literal.
func _reply_label(reply: String) -> String:
	match reply:
		"once":
			return "Allow once"
		"always":
			return "Always"
		"reject":
			return "Reject"
	return reply


func _build_item(item: Dictionary) -> Control:
	var kind := str(item.get("kind", "item"))
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.bg_panel_alt()))
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 3)
	var tag := Label.new()
	# The tag names the kind AND whose it is, so a child's item in the root's
	# thread is never misread as the root's own.
	var owner := _owner_label(str(item.get("session_id", "")))
	tag.text = (
		"%s  ·  %s" % [str(KIND_LABELS.get(kind, kind.capitalize())), owner]
		if not owner.is_empty()
		else str(KIND_LABELS.get(kind, kind.capitalize()))
	)
	OfficeTheme.apply_font(tag, 11)
	tag.add_theme_color_override("font_color", _kind_color(kind))
	box.add_child(tag)
	box.add_child(OfficeTheme.body(str(item.get("description", "")), true))
	if kind == "file_change":
		_add_change_detail(box, item)
	card.add_child(box)
	return card


## The role a session belongs to, for attribution. Empty when nothing is known,
## so the tag never invents an owner.
func _owner_label(session_id: String) -> String:
	if _store == null or session_id.is_empty():
		return ""
	var actor := _store.actor_for(session_id)
	return actor.identity.display_name if actor != null else ""


## The path and counts a file change carries, and an honest note that the change
## KIND is not on the wire. The patch excerpt is shown bounded, never in full.
func _add_change_detail(box: VBoxContainer, item: Dictionary) -> void:
	var counts := Label.new()
	# The row names its own wire source, so a reader can tell which durable event
	# produced it without opening anything else.
	counts.text = "+%d  −%d  ·  %s  ·  %s" % [
		int(item.get("additions", 0)),
		int(item.get("deletions", 0)),
		CHANGE_KIND_UNREPORTED,
		str(item.get("source", "")),
	]
	OfficeTheme.apply_font(counts, 10)
	counts.add_theme_color_override("font_color", OfficeTheme.text_muted())
	box.add_child(counts)
	var patch := str(item.get("patch", ""))
	if patch.is_empty():
		return
	var detail := Label.new()
	detail.text = patch
	OfficeTheme.apply_font(detail, 10)
	detail.add_theme_color_override("font_color", OfficeTheme.text_dim())
	detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(detail)
