## The floating sidebar.
##
## One rail carries everything the window header would have: the mode/connection
## badge, the session list, the team, and the agent selector. It absorbs the
## former `mode_badge.gd` and `status_panel.gd`, which is why the mode wording and
## the F-08 legibility rules below are preserved rather than reinvented.
##
## Two rules are correctness, not styling:
##   * DEMO must be unmistakable and must never read as LIVE.
##   * selected and attention states must be legible without colour, so each one
##     carries a text marker as well as a tint.
class_name SidebarPanel
extends PanelContainer

signal session_selected(session_id: String)
signal new_session_requested()
signal agent_selected(agent_id: String)

## Text markers. These are what make state legible without colour (F-08).
const MARK_SELECTED := "●"
const MARK_UNSELECTED := "○"
const MARK_ATTENTION := "!"
const MARK_NONE := " "

## Wrapping labels need a known minimum width. An autowrap Label computes its
## minimum height from its current width, so at zero width it reports one glyph
## per line and inflates the whole panel's minimum height before the first
## layout pass, which clamps every later size assignment.
const WRAP_MIN_WIDTH := 240.0

## Optional room lookup, injected by the composition root so this panel needs no
## scene-tree knowledge of its own.
var zone_provider: Callable = Callable()

var _mode_label: Label
var _detail_label: Label
var _new_button: Button
var _sessions_box: VBoxContainer
var _team_box: VBoxContainer
var _agent_button: Button
var _agent_menu: PopupMenu
var _agents: Array[String] = []
var _current_agent: String = ""
var _built := false
var _store: OfficeStore


## Build the rail. Called from `_ready` and lazily from `refresh`, so a test can
## drive the panel without adding it to a scene tree.
##
## The mode row, the detail line and the New session button are pinned; the lists
## scroll. Two reasons: the mode must stay visible so DEMO can never scroll out of
## sight, and the scrolling region bounds the panel's minimum height. Without
## that bound a wrapping label reports one glyph per line while the panel is still
## zero-width, the panel's minimum height explodes, and every later size
## assignment is clamped to it.
func _ensure_built() -> void:
	if _built:
		return
	_built = true
	add_theme_stylebox_override("panel", OfficeTheme.panel_style())
	var outer := VBoxContainer.new()
	outer.add_theme_constant_override("separation", 10)

	# --- mode row (pinned) --------------------------------------------------
	var mode_row := HBoxContainer.new()
	mode_row.add_theme_constant_override("separation", 8)
	_mode_label = Label.new()
	_mode_label.add_theme_font_size_override("font_size", 14)
	mode_row.add_child(_mode_label)
	outer.add_child(mode_row)

	_detail_label = Label.new()
	_detail_label.add_theme_font_size_override("font_size", 11)
	_detail_label.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
	_detail_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_detail_label.custom_minimum_size = Vector2(WRAP_MIN_WIDTH, 0.0)
	outer.add_child(_detail_label)

	_new_button = OfficeTheme.button("+  New session", true)
	_new_button.pressed.connect(func(): new_session_requested.emit())
	outer.add_child(_new_button)

	# --- scrolling lists ----------------------------------------------------
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.follow_focus = true
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(box)

	box.add_child(OfficeTheme.heading("SESSIONS"))
	_sessions_box = VBoxContainer.new()
	_sessions_box.add_theme_constant_override("separation", 2)
	box.add_child(_sessions_box)

	box.add_child(OfficeTheme.heading("TEAM"))
	_team_box = VBoxContainer.new()
	_team_box.add_theme_constant_override("separation", 2)
	box.add_child(_team_box)

	# --- agent --------------------------------------------------------------
	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	box.add_child(spacer)
	box.add_child(OfficeTheme.heading("AGENT"))
	_agent_button = OfficeTheme.button("No agent", false)
	_agent_button.pressed.connect(_on_agent_pressed)
	box.add_child(_agent_button)

	outer.add_child(scroll)
	add_child(outer)

	# The popup is a child of the panel, not of the scrolling list, so it is not
	# clipped by the scroll region.
	_agent_menu = PopupMenu.new()
	_agent_menu.index_pressed.connect(_on_agent_index)
	add_child(_agent_menu)


func _ready() -> void:
	_ensure_built()


## Rebuild the whole rail from the store. `playing` only chooses the detail line,
## matching the badge this replaces.
func refresh(store: OfficeStore, playing: bool) -> void:
	_ensure_built()
	_store = store
	if store == null:
		return
	_refresh_mode(store, playing)
	_refresh_sessions(store)
	_refresh_team(store)
	_refresh_agent_button()


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


## --- mode -------------------------------------------------------------------

func _refresh_mode(store: OfficeStore, playing: bool) -> void:
	_mode_label.text = "%s · %s" % [store.mode, _connection_text(store.connection_state)]
	# DEMO is a hard visual boundary, never a quiet label.
	var demo := store.mode == OfficeStore.MODE_DEMO
	_mode_label.add_theme_color_override(
		"font_color", OfficeTheme.ACCENT_WARM if demo else OfficeTheme.OK
	)
	if store.last_error.is_empty():
		_detail_label.text = _detail_text(store, playing)
		_detail_label.add_theme_color_override("font_color", OfficeTheme.TEXT_MUTED)
		return
	# An error outranks the routine detail line, matching the badge this replaces.
	_detail_label.text = store.last_error
	_detail_label.add_theme_color_override("font_color", OfficeTheme.DANGER)


func _connection_text(state: String) -> String:
	match state:
		OfficeStore.CONNECTION_SYNCING:
			return "SYNCING"
		OfficeStore.CONNECTION_RECONNECTING:
			return "RECONNECTING"
		OfficeStore.CONNECTION_DISCONNECTED:
			return "DISCONNECTED"
	return "READY"


func _detail_text(store: OfficeStore, playing: bool) -> String:
	if store.mode == OfficeStore.MODE_DEMO:
		return "Synthetic playback — no runtime work is executed"
	return "Live playback" if playing else "Idle"


## --- sessions ---------------------------------------------------------------

## Roots first, each followed by its children. The store already exposes parent
## identity per actor, so grouping needs no second source of truth.
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
		_sessions_box.add_child(_session_row(root, false))
		for child in children.get(root.identity.session_id, []):
			_sessions_box.add_child(_session_row(child, true))


func _session_row(actor: ActorPresentation, nested: bool) -> Control:
	var selected := _is_selected(actor)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	if nested:
		var indent := Control.new()
		indent.custom_minimum_size = Vector2(16, 0)
		row.add_child(indent)
	var marker := Label.new()
	marker.text = MARK_SELECTED if selected else MARK_UNSELECTED
	marker.add_theme_font_size_override("font_size", 12)
	marker.custom_minimum_size = Vector2(14, 0)
	marker.add_theme_color_override(
		"font_color", OfficeTheme.ACCENT if selected else OfficeTheme.TEXT_MUTED
	)
	row.add_child(marker)
	var button := Button.new()
	button.flat = true
	button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	button.text = _session_label(actor)
	button.add_theme_font_size_override("font_size", 13)
	button.add_theme_color_override(
		"font_color", OfficeTheme.TEXT if selected else OfficeTheme.TEXT_DIM
	)
	var session_id := actor.identity.session_id
	button.pressed.connect(func(): session_selected.emit(session_id))
	row.add_child(button)
	return row


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
		OfficeTheme.ACCENT_WARM if attention else (OfficeTheme.TEXT if selected else OfficeTheme.TEXT_DIM)
	)
	line.pressed.connect(func(): session_selected.emit(session_id))
	return line


## The row text. Selection and attention are both spelled out, so neither depends
## on the colour tint above. Reads with defaults so a partial row degrades to a
## plain label instead of raising.
func _team_line(row: Dictionary, selected: bool, attention: bool) -> String:
	var parts := [str(row.get("name", "Agent"))]
	var room := _room_for(str(row.get("session_id", "")))
	if not room.is_empty():
		parts.append(room)
	if attention:
		parts.append("needs you")
	if selected:
		parts.append(MARK_SELECTED)
	return "  ".join(parts)


func _room_for(session_id: String) -> String:
	if not zone_provider.is_valid():
		return ""
	return str(zone_provider.call(session_id))


func _is_selected(actor: ActorPresentation) -> bool:
	if _store == null:
		return false
	var current := _store.selected_actor()
	return current != null and current.identity.session_id == actor.identity.session_id


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
	var position := _agent_button.global_position + Vector2(0, _agent_button.size.y)
	_agent_menu.position = Vector2i(position)
	_agent_menu.popup()


func _on_agent_index(index: int) -> void:
	if index < 0 or index >= _agents.size():
		return
	_current_agent = _agents[index]
	_refresh_agent_button()
	agent_selected.emit(_current_agent)


func _clear(container: VBoxContainer) -> void:
	for child in container.get_children():
		container.remove_child(child)
		child.queue_free()
