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
## The user asked to stop the session this drawer is showing. The session is named
## because the drawer speaks for ONE session, and stopping is a real service mutation the
## host performs - never this panel.
signal stop_requested(session_id: String)
## The user asked to open the exact source a row came from. The session is named because the
## source of a row IS a session - a delegation names the child it was handed to - and the
## composition root opens it.
signal open_session_requested(session_id: String)

const KIND_LABELS := {
	"code": "Code",
	"tool": "Tool",
	"observation": "System",
	"prompt": "Prompt",
	"delegation": "Delegation",
	"question": "Question",
	"answer": "Answer",
	"report": "Report",
	"review": "Review",
	"file_change": "File change",
	"shell": "Shell",
	"limit": "Limit",
}

## A kind's accent, resolved against the active palette. A function rather than a
## constant because the palette can change mode at runtime.
func _kind_color(kind: String) -> Color:
	match kind:
		"file_change":
			return OfficeTheme.text_dim()
		"limit":
			return OfficeTheme.accent_warm()
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
	"delegation", "question", "answer", "code", "tool", "report", "review", "file_change",
	"shell", "limit", "observation", "prompt",
]

## The drawer's own text when a filter matches nothing. Stale rows would present
## another assignment's history as this one's, so the empty state replaces them.
const FILTER_EMPTY := "No items match this filter."

## Shown when the wire did not report a change kind: the drawer states that rather
## than guessing one from the counts.
const CHANGE_KIND_UNREPORTED := "change kind not reported"

## The replies a review offers come from `AttentionQueue.reply_shape`, which is the single
## authority for what the runtime accepts for a given request: a hard review allows only a
## one-time approval or a rejection, and a local list here would be a second rule that could
## drift from it.

## Why the drawer's stop control cannot act. The composer owns the same wording, because a
## reason the user reads should not depend on which surface offered the control.
## Why a hard review offers no session-wide approval. Stated rather than left for the user to
## guess, because a missing control with no explanation reads as a defect.
const HARD_REVIEW_NOTE := (
	"This review is a hard one: it can be approved ONCE or rejected, and never for the whole session."
)

const STOP_DISABLED_REASON := "Nothing is running to stop"
const STOP_DEMO_REASON := "DEMO preview — there is no running work to stop"

## The drawer's own stop control. Disabled with a reason whenever there is nothing it could
## stop, so a control that cannot act says why rather than swallowing a click.
var _stop: Button
## The canonical history read for the family on screen. Assigned by the composition root;
## null until then, in which case the drawer shows only what the live feed gave it.
var _history: ConversationHistory
## The durable message ids already shown for a session, so a remembered observation for the
## same message is not rendered a second time.
var _durable_message_ids: Dictionary = {}
## The line stating where this assignment sits in its family.
var _family_text: Label
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
	# The family line sits under the title block, so parent and child identity is as visible as
	# the session's own name.
	_family_text = Label.new()
	_family_text.name = "FamilyIdentity"
	OfficeTheme.apply_font(_family_text, 11)
	_family_text.add_theme_color_override("font_color", OfficeTheme.text_dim())
	titles.add_child(_family_text)
	header.add_child(titles)
	# Stopping belongs beside the session it would stop. The drawer is the contextual
	# surface for ONE session and is reachable from every route, so the action that
	# unblocks or interrupts that session lives here rather than only in the composer,
	# which belongs to the office surface alone.
	_stop = OfficeTheme.button("Stop")
	OfficeTheme.apply_font(_stop, 12)
	_stop.disabled = true
	_stop.tooltip_text = STOP_DISABLED_REASON
	_stop.pressed.connect(func(): stop_requested.emit(_session_id))
	header.add_child(_stop)
	var close_button := OfficeTheme.button("Close")
	close_button.pressed.connect(func(): close_requested.emit())
	header.add_child(close_button)

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

## Hand the drawer the canonical history reader. The composition root owns the read; the
## drawer only renders what it finds.
func bind_history(history: ConversationHistory) -> void:
	_history = history


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
	# The TASK is what the assignment is working on, so it is stated here rather than left for
	# the user to infer from the thread.
	if actor != null and not actor.task_description.strip_edges().is_empty():
		parts.append(actor.task_description.strip_edges())
	_subtitle.text = " · ".join(parts)
	_family_text.text = _family_identity(store, session_id)

	# One thread is a real session family, so a root's items and its children's
	# items read as one conversation rather than the drawer going blank when a
	# child is selected.
	_collect_items(store)

	_clear(_list)
	_clear(_attention_box)
	_build_attention(store, session_id)
	_refresh_filters(store)
	_render()


## Gather the thread's rows from the projection plus the live answer.
##
## The live answer is not a durable interaction, so it is not in the projection:
## `session.text.delta` is ephemeral by contract and exists only so text is visible
## while it arrives. It is included here so a running answer reads as it is written,
## and a settled turn's durable record takes over once it lands.
## Gather the thread's rows from the canonical history, the live observations, and the
## arriving answer.
##
## The canonical rows come FIRST and in the service's own order, because they are the durable
## truth; a live observation the office happened to see is remembered context, not history.
## A durable row for the same message REPLACES a remembered one rather than appearing twice,
## which is what the shared message id makes possible.
func _collect_items(store: OfficeStore) -> void:
	_thread_items = []
	for member in _family:
		_thread_items.append_array(_canonical_items(member))
		_thread_items.append_array(_remembered_items(store, member))
		for block in store.stream_blocks(member):
			_thread_items.append({
				"id": "live:%s:%s:%s" % [member, block["assistantMessageID"], block["ordinal"]],
				"session_id": member,
				"kind": "answer",
				"description": str(block["text"]),
				"source": "session.text (live)",
				"live": true,
			})
		_thread_items.append_array(_shell_items(store, member))
		_thread_items.append_array(_limit_items(store, member))


## The limit failures the runtime reported, as thread rows.
##
## Each carries its own KIND, because a rate limit, an exhausted quota and a context overflow
## are different facts from different sources and send the reader to different fixes. The
## label comes from LimitEvent, so the four kinds cannot drift into one wording here.
func _limit_items(store: OfficeStore, session_id: String) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var index := 0
	for event in store.limit_events(session_id):
		index += 1
		var kind := str(event.get("kind", ""))
		out.append({
			"id": "limit:%s:%d" % [session_id, index],
			"session_id": session_id,
			"kind": "limit",
			"description": "%s: %s" % [
				LimitEvent.label(kind), str(event.get("message", "")),
			],
			"detail": str(event.get("detail", "")),
			"source": Wire.STEP_FAILED,
			"failed": true,
		})
	return out


## The shells the runtime ran for a session, as thread rows.
##
## A shell row is READ-ONLY detail about a command that has already run. It carries no input
## control and offers nothing to send: "do not substitute a fake terminal". What it does say is
## the command, the directory it ran in, whether the runtime settled it, and its captured
## output - plus whether MORE output remains, because a page must not read as the whole.
func _shell_items(store: OfficeStore, session_id: String) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for shell in store.shells_for(session_id):
		out.append({
			"id": "shell:%s:%s" % [session_id, str(shell.get("shell_id", ""))],
			"session_id": session_id,
			"kind": "shell",
			"description": str(shell.get("command", "")),
			"source": Wire.SHELL_STARTED,
			"shell": shell,
		})
	return out


## The durable rows read for a session, tagged with the session they belong to.
##
## They are copied rather than mutated: the history belongs to the reader, and a drawer
## rebuild must not edit the record another view is showing.
func _canonical_items(session_id: String) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	if _history == null:
		return out
	var seen: Array[String] = []
	for row in _history.rows_for(session_id):
		var copy := row.duplicate(true)
		copy["session_id"] = session_id
		out.append(copy)
		seen.append(str(row.get("message_id", "")))
	_durable_message_ids[session_id] = seen
	return out


## The observations the office remembers from the live feed, minus any a durable row already
## covers. The same message must not appear twice.
func _remembered_items(store: OfficeStore, session_id: String) -> Array[Dictionary]:
	var durable: Array = _durable_message_ids.get(session_id, [])
	var out: Array[Dictionary] = []
	for item in store.conversation_items(session_id):
		var message_id := str(item.get("message_id", ""))
		if not message_id.is_empty() and durable.has(message_id):
			continue
		out.append(item)
	return out


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


## Re-render the resident thread from the projection.
##
## A streamed delta arrives many times per second and the drawer is the live view of
## it, so the rows are rebuilt on each change. The filters are deliberately NOT
## rebuilt here: `show_actor` owns them, and clearing them mid-stream would silently
## reset the selection the user made.
func refresh(store: OfficeStore) -> void:
	if _session_id.is_empty():
		return
	_collect_items(store)
	_render()


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
## Every request the shown FAMILY is waiting on, in the order they arrived.
##
## The drawer already shows the family's thread, so a request from any session in that family
## must be answerable here. Showing the thread but only the selected session's requests left
## a delegated child blocked with nothing to answer: the user could read the child's work and
## had no way to unblock it. Nothing is shown twice, and the order is the queue's own, so the
## oldest request the user must deal with is the first one offered.
func _family_attention(store: OfficeStore, session_id: String) -> Array:
	var family := _family
	if family.is_empty():
		family = [session_id]
	var out: Array = []
	for request in store.attention.pending():
		if family.has(str(request.get("session_id", ""))):
			out.append(request)
	return out


func _build_attention(store: OfficeStore, session_id: String) -> void:
	_refresh_stop(store, session_id)
	for request in _family_attention(store, session_id):
		_build_attention_card(request, session_id)


## One request, with the session it belongs to named whenever that is not the session the
## drawer was opened on. Project and family identity have to be legible on every route, so a
## card never leaves the user guessing which session is blocked.
func _build_attention_card(request: Dictionary, shown_session: String) -> void:
	var kind := str(request.get("kind", ""))
	var data: Dictionary = request.get("data", {})
	var owner := str(request.get("session_id", ""))
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", OfficeTheme.panel_style(OfficeTheme.bg_elevated()))
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)

	var tag := Label.new()
	tag.text = "Needs you · %s" % str(KIND_LABELS.get(kind, kind)).capitalize()
	# A HARD review is labelled, so the missing session-wide approval reads as the runtime's
	# restriction rather than as a broken control.
	if AttentionQueue.is_hard_review(request):
		tag.text += " · hard review"
	if owner != shown_session and not owner.is_empty():
		tag.text += " · %s" % owner
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
		# The replies come from the QUEUE's own answer for this request, not from a list kept
		# here: a hard review allows only a one-time approval or a rejection, and a control
		# built from a local list would offer a session-wide approval the runtime refuses.
		var shape := AttentionQueue.reply_shape(request)
		for reply in (shape.get("allowed", []) as Array):
			var button := OfficeTheme.button(_reply_label(str(reply)))
			button.pressed.connect(
				func() -> void: attention_replied.emit(request_id, {"reply": reply})
			)
			row.add_child(button)

	box.add_child(tag)
	box.add_child(prompt)
	if AttentionQueue.is_hard_review(request):
		var why := Label.new()
		why.name = "HardReviewNote"
		why.text = HARD_REVIEW_NOTE
		OfficeTheme.apply_font(why, 11)
		why.add_theme_color_override("font_color", OfficeTheme.text_dim())
		why.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		box.add_child(why)
	box.add_child(row)
	card.add_child(box)
	_attention_box.add_child(card)


## Whether this drawer's session can be stopped, and why not when it cannot.
##
## Mirrors the composer's rule: only a LIVE office has a service to ask, and only work that is
## actually running is worth stopping. DEMO says so rather than offering a control that
## cannot act.
func _refresh_stop(store: OfficeStore, session_id: String) -> void:
	if _stop == null:
		return
	if store.mode != OfficeStore.MODE_LIVE:
		_stop.disabled = true
		_stop.tooltip_text = STOP_DEMO_REASON
		return
	var actor := store.actor_for(session_id)
	var working := actor != null and Presence.is_working(actor.work_state)
	_stop.disabled = not working
	_stop.tooltip_text = STOP_DISABLED_REASON if not working else "Stop " + session_id


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
	var tag_text := (
		"%s  ·  %s" % [str(KIND_LABELS.get(kind, kind.capitalize())), owner]
		if not owner.is_empty()
		else str(KIND_LABELS.get(kind, kind.capitalize()))
	)
	# A live row is an ephemeral stream, not a durable record. It says so, so an
	# arriving answer is never read as settled history.
	if item.get("live", false):
		tag_text = "Live  ·  " + tag_text
	tag.text = tag_text
	OfficeTheme.apply_font(tag, 11)
	tag.add_theme_color_override("font_color", _kind_color(kind))
	box.add_child(tag)
	box.add_child(OfficeTheme.body(str(item.get("description", "")), true))
	# The row's own source is reachable from the row: a delegation handed work to a child, and
	# a report belongs to the session that produced it. It comes AFTER the text it acts on, so
	# the row still reads as a statement rather than opening with a control.
	var row_id := str(item.get("id", ""))
	var source_session := str(item.get("target_session_id", item.get("session_id", "")))
	if not row_id.is_empty() and _store != null and _store.actor_for(source_session) != null:
		var open := OfficeTheme.button("Open source")
		OfficeTheme.apply_font(open, 11)
		open.tooltip_text = "Open " + source_session
		open.pressed.connect(func() -> void: _open_source(row_id))
		box.add_child(open)
	if kind == "file_change":
		_add_change_detail(box, item)
	if kind == "shell":
		_add_shell_detail(box, item)
	if kind == "limit":
		var detail := str(item.get("detail", ""))
		if not detail.is_empty():
			var note := Label.new()
			note.text = detail
			OfficeTheme.apply_font(note, 10)
			note.add_theme_color_override("font_color", OfficeTheme.text_muted())
			note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			box.add_child(note)
	card.add_child(box)
	return card


## Where this assignment sits in its family, spelled out.
##
## The kit requires parent/child identity, and an actor whose parent is not named reads as a
## root. Both directions are stated: a child names its parent, and a parent names the children
## it has, so a delegation is traceable either way. Sessions are named by their own ids
## because an agent configuration is reusable and two sessions sharing one are two actors.
func _family_identity(store: OfficeStore, session_id: String) -> String:
	if store == null or session_id.is_empty():
		return ""
	var actor := store.actor_for(session_id)
	if actor == null:
		return ""
	var parts: Array[String] = []
	var parent := actor.identity.parent_session_id
	if not parent.is_empty():
		parts.append("child of %s" % _named(store, parent))
	else:
		parts.append("root")
	# DIRECT children only. The family list names the whole tree INCLUDING ancestors and the
	# session itself, so using it here would list this assignment's parent as one of its
	# children. Asserted by a test that pins the relation, not merely that an id appears.
	var children := store.child_session_ids(session_id)
	var named: Array[String] = []
	for member in children:
		named.append(_named(store, member))
	if not named.is_empty():
		parts.append("children: " + ", ".join(named))
	return " · ".join(parts)


## A session as a person would recognise it: its display name AND its id, because the name is
## reusable across assignments and the id is what actually identifies one.
func _named(store: OfficeStore, session_id: String) -> String:
	var actor := store.actor_for(session_id)
	if actor == null:
		return session_id
	return "%s (%s)" % [actor.identity.display_name, session_id]


## Open the exact source a row came from.
##
## A row names the session it belongs to, and a delegation additionally names the child it was
## handed to - so following a delegation goes to the CHILD rather than back to the parent it
## was written on. A row whose source is not a session this office has asks for nothing, rather
## than emitting an id that does not exist.
func _open_source(row_id: String) -> void:
	if _store == null or row_id.is_empty():
		return
	var target := ""
	for item in _thread_items:
		if str(item.get("id", "")) != row_id:
			continue
		target = str(item.get("target_session_id", ""))
		if target.is_empty():
			target = str(item.get("session_id", ""))
		break
	if target.is_empty() or _store.actor_for(target) == null:
		return
	open_session_requested.emit(target)


## A shell's command, where it ran, how it ended, and its captured output.
##
## READ-ONLY detail: this function adds labels and never a control that accepts input. The
## runtime's own status is stated rather than inferred, so a running command never reads as
## finished, and the paging state is stated so a page is not mistaken for the whole output.
func _add_shell_detail(box: VBoxContainer, item: Dictionary) -> void:
	var shell: Dictionary = item.get("shell", {})
	var facts := Label.new()
	var status := str(shell.get("status", ""))
	facts.text = "%s  ·  %s" % [
		status if not status.is_empty() else "status not reported",
		str(shell.get("cwd", "")),
	]
	OfficeTheme.apply_font(facts, 10)
	facts.add_theme_color_override(
		"font_color",
		OfficeTheme.ok() if ShellView.is_settled(shell) else OfficeTheme.accent_warm(),
	)
	box.add_child(facts)
	var output := ShellView.output_of(shell)
	var text := str(output.get("output", ""))
	if text.is_empty():
		return
	# Whether more remains, and whether the capture was truncated, are part of reading the
	# output honestly: neither a page nor a truncated capture is the whole of what ran.
	var notes: Array[String] = []
	if ShellView.has_more(output):
		notes.append("%s of %s bytes read" % [str(output.get("cursor", "")), str(output.get("size", ""))])
	if ShellView.is_truncated(output):
		notes.append("capture truncated")
	var detail := Label.new()
	detail.text = text if notes.is_empty() else "%s\n[%s]" % [text, ", ".join(notes)]
	OfficeTheme.apply_font(detail, 10)
	detail.add_theme_color_override("font_color", OfficeTheme.text_dim())
	detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(detail)


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
