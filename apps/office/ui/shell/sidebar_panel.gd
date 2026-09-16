## The floating sidebar.
##
## Shaped like the reference: a product pill with the icon actions beside it, a
## primary action, then labelled sections holding a tree, and a status bar pinned
## to the bottom.
##
## It absorbs what the removed window header held: the mode/connection badge and
## the agent selector now live here. Two rules stay correctness rather than style:
## DEMO must be unmistakable and must never read as LIVE, and selected and
## attention states must be legible without colour, so each carries a text marker.
class_name SidebarPanel
extends PanelContainer

signal session_selected(session_id: String)
signal new_session_requested()
signal agent_selected(agent_id: String)
signal mode_toggle_requested()

## Text markers. These are what make state legible without colour (F-08).
const MARK_SELECTED := "●"
const MODE_NOTE_DEMO := "synthetic"

## The selection marker, so selection is readable without colour.
const MARK_UNSELECTED := "○"
const MARK_ATTENTION := "!"
const MARK_GROUP_OPEN := "▾"
const MARK_GROUP_CLOSED := "▸"

## A wrapping label needs a known minimum width, or at zero width it reports one
## glyph per line and inflates the whole panel's minimum height.
const WRAP_MIN_WIDTH := 200.0

## Optional room lookup, injected by the composition root.
var zone_provider: Callable = Callable()

var _product_button: Button
var _mode_label: Label
var _detail_label: Label
var _new_button: Button
var _sessions_box: VBoxContainer
var _team_box: VBoxContainer
var _agent_button: Button
var _agent_menu: PopupMenu
var _status_label: Label
## The location text, set from the store and shown in the status bar.
var _location: String = ""
var _collapsed: Dictionary = {}
var _agents: Array[String] = []
var _current_agent: String = ""
var _built := false
var _store: OfficeStore


## Build the rail. Called from `_ready` and lazily from `refresh`, so a test can
## drive the panel without adding it to a scene tree.
##
## The product pill, mode row and primary action are pinned; the lists scroll. The
## mode must stay visible so DEMO can never scroll out of sight, and the scrolling
## region bounds the panel's minimum height.
func _ensure_built() -> void:
	if _built:
		return
	_built = true
	add_theme_stylebox_override("panel", OfficeTheme.card_style())

	var outer := VBoxContainer.new()
	outer.add_theme_constant_override("separation", 10)

	# --- product pill with its icon actions --------------------------------
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 6)
	_product_button = OfficeTheme.pill_button("YCoding Office  ⌄")
	_product_button.custom_minimum_size = Vector2(0, 34)
	_product_button.pressed.connect(func(): mode_toggle_requested.emit())
	head.add_child(_product_button)
	var head_spacer := Control.new()
	head_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(head_spacer)
	_mode_label = Label.new()
	_mode_label.add_theme_font_size_override("font_size", 12)
	head.add_child(_mode_label)
	outer.add_child(head)

	_detail_label = Label.new()
	_detail_label.add_theme_font_size_override("font_size", 11)
	_detail_label.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	_detail_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_detail_label.custom_minimum_size = Vector2(WRAP_MIN_WIDTH, 0.0)
	outer.add_child(_detail_label)

	_new_button = OfficeTheme.pill_button("✎   New session")
	_new_button.custom_minimum_size = Vector2(0, 34)
	_new_button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_new_button.pressed.connect(func(): new_session_requested.emit())
	outer.add_child(_new_button)

	# --- scrolling sections -------------------------------------------------
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.follow_focus = true
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(box)

	_sessions_box = VBoxContainer.new()
	_sessions_box.add_theme_constant_override("separation", 2)
	box.add_child(OfficeTheme.section_label("Sessions"))
	box.add_child(_sessions_box)

	box.add_child(OfficeTheme.section_label("Team"))
	_team_box = VBoxContainer.new()
	_team_box.add_theme_constant_override("separation", 2)
	box.add_child(_team_box)

	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	box.add_child(spacer)
	outer.add_child(scroll)

	# --- agent selector -----------------------------------------------------
	_agent_button = OfficeTheme.pill_button("No agent  ⌄")
	_agent_button.custom_minimum_size = Vector2(0, 32)
	_agent_button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_agent_button.add_theme_font_size_override("font_size", 13)
	_agent_button.pressed.connect(_on_agent_pressed)
	outer.add_child(_agent_button)

	# --- status bar ---------------------------------------------------------
	_status_label = Label.new()
	_status_label.add_theme_font_size_override("font_size", 11)
	_status_label.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	outer.add_child(_status_label)

	add_child(outer)

	# The popup is a child of the panel, not of the scrolling list, so the scroll
	# region cannot clip it.
	_agent_menu = PopupMenu.new()
	_agent_menu.index_pressed.connect(_on_agent_index)
	add_child(_agent_menu)


func _ready() -> void:
	_ensure_built()


## Rebuild the whole rail from the store.
func refresh(store: OfficeStore, playing: bool) -> void:
	_ensure_built()
	_store = store
	if store == null:
		return
	_refresh_mode(store, playing)
	_refresh_sessions(store)
	_refresh_team(store)
	_refresh_agent_button()
	_refresh_status(store)


## The exact text shown in the mode row, e.g. "DEMO · READY".
func mode_text() -> String:
	_ensure_built()
	return _mode_label.text


func available_agents() -> Array[String]:
	return _agents.duplicate()


func selected_agent() -> String:
	return _current_agent


func set_agents(agent_ids: Array[String], current: String) -> void:
	_ensure_built()
	_agents = agent_ids.duplicate()
	_current_agent = current
	_agent_menu.clear()
	if _agents.is_empty():
		_refresh_agent_button()
		return
	for index in _agents.size():
		var agent_id := _agents[index]
		_agent_menu.add_item(agent_id, index)
		if agent_id == current:
			_agent_menu.set_item_checked(index, true)
	_refresh_agent_button()


## Show the location every visible session shares.
##
## The office is a view over sessions and each session carries its own durable
## directory, so a single path is only claimed when they actually agree. With more
## than one directory the label reports the count instead of picking one.
func set_location(store: OfficeStore) -> void:
	_location = _location_text(store)
	if _status_label != null and _store != null:
		_refresh_status(_store)


func _location_text(store: OfficeStore) -> String:
	if store == null:
		return ""
	var locations := store.locations()
	if locations.is_empty():
		return ""
	if locations.size() > 1:
		return "%d locations" % locations.size()
	return locations[0]


## Collapse or expand a session group.
func toggle_group(group_id: String) -> void:
	_collapsed[group_id] = not bool(_collapsed.get(group_id, false))
	if _store != null:
		_refresh_sessions(_store)


func is_group_collapsed(group_id: String) -> bool:
	return bool(_collapsed.get(group_id, false))


## --- mode -------------------------------------------------------------------

func _refresh_mode(store: OfficeStore, playing: bool) -> void:
	_mode_label.text = store.mode
	# DEMO is a hard visual boundary, never a quiet label.
	var demo := store.mode == OfficeStore.MODE_DEMO
	_mode_label.add_theme_color_override(
		"font_color", OfficeTheme.ACCENT_WARM if demo else OfficeTheme.OK
	)
	if store.last_error.is_empty():
		_detail_label.text = _detail_text(store, playing)
		_detail_label.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
		return
	_detail_label.text = store.last_error
	_detail_label.add_theme_color_override("font_color", OfficeTheme.DANGER)


func _detail_text(store: OfficeStore, playing: bool) -> String:
	if store.mode == OfficeStore.MODE_DEMO:
		return "Synthetic playback — no runtime work is executed"
	return "Live playback" if playing else "Idle"


## The status bar states the connection, so the reference's bottom strip has
## something real to say.
## The footer reports the mode and what is actually in the office.
##
## In DEMO the store's connection state is set by synthetic playback, so echoing
## it would claim a live connection the client never made and contradict the mode
## badge beside it. DEMO states its own condition instead.
func _refresh_status(store: OfficeStore) -> void:
	var parts: Array[String] = []
	if not _location.is_empty():
		parts.append(_location)
	var connected := store.mode == OfficeStore.MODE_LIVE \
		and store.connection_state == OfficeStore.CONNECTION_LIVE
	parts.append(
		"%s · %d active" % [
			store.connection_state if store.mode == OfficeStore.MODE_LIVE else MODE_NOTE_DEMO,
			store.actor_list().size(),
		]
	)
	_status_label.text = "  ·  ".join(parts)
	_status_label.add_theme_color_override(
		"font_color",
		OfficeTheme.OK if connected else OfficeTheme.TEXT_MUTED
	)


## --- sessions ---------------------------------------------------------------

## Roots first, each followed by its children. A group is a root session, and a
## group with children can be collapsed, which is the reference's tree behaviour.
func _refresh_sessions(store: OfficeStore) -> void:
	_clear(_sessions_box)
	var actors := store.actor_list()
	if actors.is_empty():
		_sessions_box.add_child(OfficeTheme.body("No sessions observed yet.", true))
		return
	var children: Dictionary = {}
	var roots: Array[ActorPresentation] = []
	for actor in actors:
		var parent := actor.identity.parent_session_id
		if parent.is_empty() or store.actor_for(parent) == null:
			roots.append(actor)
			continue
		var bucket: Array = children.get(parent, [])
		bucket.append(actor)
		children[parent] = bucket
	for root in roots:
		var group_id := root.identity.session_id
		var nested: Array = children.get(group_id, [])
		_sessions_box.add_child(_group_row(root, nested.size()))
		if is_group_collapsed(group_id):
			continue
		for child in nested:
			_sessions_box.add_child(_session_row(child, true))


## A root row: a disclosure marker, the selection marker, and the title.
func _group_row(actor: ActorPresentation, child_count: int) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 4)
	var selected := _is_selected(actor)
	if child_count > 0:
		var twisty := Button.new()
		twisty.flat = true
		twisty.text = MARK_GROUP_CLOSED if is_group_collapsed(actor.identity.session_id) else MARK_GROUP_OPEN
		twisty.add_theme_font_size_override("font_size", 11)
		twisty.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
		var group_id := actor.identity.session_id
		twisty.pressed.connect(func(): toggle_group(group_id))
		row.add_child(twisty)
	else:
		var pad := Control.new()
		pad.custom_minimum_size = Vector2(14, 0)
		row.add_child(pad)
	row.add_child(_marker(selected))
	var button := Button.new()
	button.flat = true
	button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	button.text = _session_label(actor)
	button.add_theme_font_size_override("font_size", 14)
	button.add_theme_color_override(
		"font_color", OfficeTheme.TEXT if selected else OfficeTheme.TEXT_DIM
	)
	var session_id := actor.identity.session_id
	button.pressed.connect(func(): session_selected.emit(session_id))
	row.add_child(button)
	return row


## A nested row: indented, with the selection marker and presence.
func _session_row(actor: ActorPresentation, nested: bool) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 4)
	if nested:
		var indent := Control.new()
		indent.custom_minimum_size = Vector2(28, 0)
		row.add_child(indent)
	var selected := _is_selected(actor)
	row.add_child(_marker(selected))
	var text := _session_label(actor)
	var presence := Presence.label(actor.presence)
	if not presence.is_empty():
		text = "%s  ·  %s" % [text, presence]
	var button := Button.new()
	button.flat = true
	button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	button.text = text
	button.add_theme_font_size_override("font_size", 13)
	button.add_theme_color_override(
		"font_color", OfficeTheme.TEXT if selected else OfficeTheme.TEXT_MUTED
	)
	var session_id := actor.identity.session_id
	button.pressed.connect(func(): session_selected.emit(session_id))
	row.add_child(button)
	return row


func _marker(selected: bool) -> Label:
	var marker := Label.new()
	marker.text = MARK_SELECTED if selected else MARK_UNSELECTED
	marker.add_theme_font_size_override("font_size", 11)
	marker.custom_minimum_size = Vector2(14, 0)
	marker.add_theme_color_override(
		"font_color", OfficeTheme.ACCENT if selected else OfficeTheme.TEXT_MUTED
	)
	return marker


func _session_label(actor: ActorPresentation) -> String:
	var title := actor.identity.display_name
	if not actor.task_description.is_empty():
		title = actor.task_description
	if bool(actor.attention_required):
		return "%s %s" % [MARK_ATTENTION, title]
	return title


## --- team -------------------------------------------------------------------

func _refresh_team(store: OfficeStore) -> void:
	_clear(_team_box)
	var rows := store.status_rows()
	if rows.is_empty():
		_team_box.add_child(OfficeTheme.body("No agents working.", true))
		return
	for row in rows:
		_team_box.add_child(_team_row(row))


func _team_row(row: Dictionary) -> Control:
	var session_id := str(row["session_id"])
	var selected := false
	if _store != null:
		var actor := _store.selected_actor()
		selected = actor != null and actor.identity.session_id == session_id
	var attention := bool(row["attention"])
	var line := Button.new()
	line.flat = true
	line.alignment = HORIZONTAL_ALIGNMENT_LEFT
	line.add_theme_font_size_override("font_size", 13)
	line.text = "%s  %s" % [str(row["glyph"]), _team_line(row, selected, attention)]
	line.add_theme_color_override(
		"font_color",
		OfficeTheme.ACCENT_WARM if attention
		else (OfficeTheme.TEXT if selected else OfficeTheme.TEXT_DIM)
	)
	line.pressed.connect(func(): session_selected.emit(session_id))
	return line


## The row text. Selection and attention are both spelled out, so neither depends
## on the colour tint above.
func _team_line(row: Dictionary, selected: bool, attention: bool) -> String:
	var parts := [str(row.get("name", "Agent"))]
	var presence := str(row.get("presence_label", ""))
	if not presence.is_empty():
		parts.append(presence)
	# What the agent is doing right now, when the runtime reported it. An empty
	# activity is omitted rather than rendered as a blank separator.
	var activity := str(row.get("activity", "")).strip_edges()
	if not activity.is_empty() and not attention:
		parts.append(activity)
	if attention:
		parts.append("needs you")
	if selected:
		parts.append(MARK_SELECTED)
	return "  ".join(parts)


## --- agent ------------------------------------------------------------------

func _refresh_agent_button() -> void:
	if _agents.is_empty():
		_agent_button.text = "No agent"
		_agent_button.disabled = true
		return
	_agent_button.disabled = false
	var label := _current_agent if not _current_agent.is_empty() else _agents[0]
	_agent_button.text = "%s  ⌄" % label


func _on_agent_pressed() -> void:
	if _agents.is_empty():
		return
	_agent_menu.position = Vector2i(
		Vector2(_agent_button.global_position.x, _agent_button.global_position.y - 8.0)
	)
	_agent_menu.popup()


func _on_agent_index(index: int) -> void:
	if index < 0 or index >= _agents.size():
		return
	_current_agent = _agents[index]
	_refresh_agent_button()
	agent_selected.emit(_current_agent)


func _is_selected(actor: ActorPresentation) -> bool:
	if _store == null:
		return false
	var current := _store.selected_actor()
	return current != null and current.identity.session_id == actor.identity.session_id


func _clear(container: VBoxContainer) -> void:
	for child in container.get_children():
		container.remove_child(child)
		child.queue_free()