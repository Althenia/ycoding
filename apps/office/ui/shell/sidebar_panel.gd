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
## Emitted when the user asks to try the registered service again. The rail cannot
## connect anything itself: the composition root owns discovery and the transports.
signal retry_connection_requested()
## The user asked to show a route. The rail cannot route: the composition root owns
## which surface is showing, exactly as it owns the transports.
signal route_requested(route: String)
## The user chose a project from the recent/pinned list. The rail cannot open a
## folder itself: resolution and the transports belong to the composition root.
signal project_requested(local_entry_id: String)

## Text markers. These are what make state legible without colour (F-08).
const MARK_SELECTED := "●"
const MODE_NOTE_DEMO := "synthetic"

## The selection marker, so selection is readable without colour.
const MARK_UNSELECTED := "○"
const MARK_ATTENTION := "!"
const MARK_GROUP_OPEN := "▾"
const MARK_GROUP_CLOSED := "▸"
## Project-row markers: a pin for a pinned project, a folder for a recent one. Text,
## like every other marker here, so the distinction survives without colour.
const MARK_PINNED := "★"
const MARK_PROJECT := "▸"

## A wrapping label needs a known minimum width, or at zero width it reports one
## glyph per line and inflates the whole panel's minimum height.
const WRAP_MIN_WIDTH := 200.0

## Optional room lookup, injected by the composition root.
## The interface text scale. The window's content scale enlarges the drawn text;
## a minimum size is logical and must shrink with the shell or it overflows.
var ui_scale: float = UiScale.MIN

var zone_provider: Callable = Callable()

var _product_button: Button
var _mode_label: Label
var _detail_label: Label
## The connection retry. Present but disabled while the office is attached or is
## synthetic, because a control that cannot act must be disabled and say so.
var _retry_button: Button
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
## The nav rows, so the current one can be marked without colour.
var _route_buttons: Dictionary = {}
var _nav_box: VBoxContainer
## The recent and pinned project rows, rebuilt from the ledger on every refresh.
var _projects_box: VBoxContainer
var _route: String = OfficeRoute.DEFAULT
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
	OfficeTheme.apply_font(_mode_label, 12)
	head.add_child(_mode_label)
	outer.add_child(head)

	_detail_label = Label.new()
	OfficeTheme.apply_font(_detail_label, 11)
	_detail_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
	_detail_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_detail_label.custom_minimum_size = Vector2(WRAP_MIN_WIDTH * ui_scale, 0.0)
	outer.add_child(_detail_label)

	# The retry sits directly under the message that says why it is needed, so the
	# disconnected state is actionable rather than merely described.
	_retry_button = OfficeTheme.pill_button("Retry connection")
	_retry_button.custom_minimum_size = Vector2(0, 30)
	_retry_button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	OfficeTheme.apply_font(_retry_button, 12)
	_retry_button.pressed.connect(func(): retry_connection_requested.emit())
	_retry_button.visible = false
	outer.add_child(_retry_button)

	_new_button = OfficeTheme.pill_button("✎   New session")
	_new_button.custom_minimum_size = Vector2(0, 34)
	_new_button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_new_button.pressed.connect(func(): new_session_requested.emit())
	outer.add_child(_new_button)

	# --- route navigation ---------------------------------------------------
	# The surfaces the shell can show. Each row names its route AND carries a
	# distinct glyph, so the current one is legible without colour. These are
	# navigation: they change what is being looked at and nothing else.
	_nav_box = VBoxContainer.new()
	_nav_box.add_theme_constant_override("separation", 2)
	for route in OfficeRoute.ALL:
		var row := OfficeTheme.pill_button(
			"%s   %s" % [OfficeRoute.glyph(route), OfficeRoute.label(route)]
		)
		row.custom_minimum_size = Vector2(0, 32)
		row.alignment = HORIZONTAL_ALIGNMENT_LEFT
		row.pressed.connect(func(): route_requested.emit(route))
		_nav_box.add_child(row)
		_route_buttons[route] = row
	outer.add_child(_nav_box)

	# --- scrolling sections -------------------------------------------------
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.follow_focus = true
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(box)

	# --- projects: pinned first, then recents ------------------------------
	box.add_child(OfficeTheme.section_label("Projects"))
	_projects_box = VBoxContainer.new()
	_projects_box.add_theme_constant_override("separation", 2)
	box.add_child(_projects_box)

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
	OfficeTheme.apply_font(_agent_button, 13)
	_agent_button.pressed.connect(_on_agent_pressed)
	outer.add_child(_agent_button)

	# --- status bar ---------------------------------------------------------
	_status_label = Label.new()
	OfficeTheme.apply_font(_status_label, 11)
	_status_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
	# The footer carries a filesystem path, which is long and unbreakable. A Label
	# without wrapping takes its full text as its minimum width, which silently made
	# the rail 25px wider than the layout declares and pushed it over the composer.
	# It shortens instead, and the tooltip keeps the whole value readable.
	_status_label.clip_text = true
	_status_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	outer.add_child(_status_label)

	add_child(outer)

	# The popup is a child of the panel, not of the scrolling list, so the scroll
	# region cannot clip it.
	_agent_menu = PopupMenu.new()
	_agent_menu.index_pressed.connect(_on_agent_index)
	add_child(_agent_menu)


func _ready() -> void:
	_ensure_built()


## Re-apply what `_ready` baked into styleboxes and colours.
##
## A palette change alters the palette, not the nodes: colours read at paint time
## follow on their own, but a StyleBox and an override capture their value once, so
## the surfaces carrying one are restyled explicitly.
## Adopt a new text scale and re-apply the minimums that depend on it.
func set_ui_scale(value: float) -> void:
	ui_scale = UiScale.clamp_scale(value)
	if _detail_label != null:
		_detail_label.custom_minimum_size = Vector2(WRAP_MIN_WIDTH * ui_scale, 0.0)


func restyle() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.card_style())


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
		"font_color", OfficeTheme.accent_warm() if demo else OfficeTheme.ok()
	)
	_refresh_retry(store)
	if store.last_error.is_empty():
		_detail_label.text = _detail_text(store, playing)
		_detail_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
		return
	_detail_label.text = store.last_error
	_detail_label.add_theme_color_override("font_color", OfficeTheme.danger())


## Offer the connection retry exactly when it can act: a LIVE office that has not
## reached the service. A synthetic office has nothing to attach to, so the
## control is hidden rather than left as an affordance that does nothing.
func _refresh_retry(store: OfficeStore) -> void:
	var attached := store.connection_state == OfficeStore.CONNECTION_LIVE
	var offered := store.mode == OfficeStore.MODE_LIVE and not attached
	_retry_button.visible = offered
	_retry_button.disabled = not offered
	_retry_button.tooltip_text = (
		"Try the registered local service again"
		if offered
		else "Retry is offered when a live connection has not been reached"
	)


## Whether the retry is currently reachable by the user.
func retry_available() -> bool:
	_ensure_built()
	return _retry_button.visible and not _retry_button.disabled


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
	_status_label.tooltip_text = _status_label.text
	_status_label.add_theme_color_override(
		"font_color",
		OfficeTheme.ok() if connected else OfficeTheme.text_muted()
	)


## A wire event name rendered for a person.
##
## The store records the event name verbatim, because that is the fact. Reading it
## raw in the rail shows an implementation detail: "session.step.started" is noise
## beside "Frontend". The namespace is dropped and the remainder spaced, so an
## unknown name still reads sensibly rather than being invented into a word.
##
## A tool name is already a plain word ("read", "edit"), so it passes through.
func _readable_activity(activity: String) -> String:
	var text := activity.strip_edges()
	if text.is_empty():
		return ""
	if not text.contains("."):
		return text
	var tail := text.split(".")[-1]
	return tail.replace("_", " ")


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
		OfficeTheme.apply_font(twisty, 11)
		twisty.add_theme_color_override("font_color", OfficeTheme.text_muted())
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
	OfficeTheme.apply_font(button, 14)
	button.add_theme_color_override(
		"font_color", OfficeTheme.text() if selected else OfficeTheme.text_dim()
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
	OfficeTheme.apply_font(button, 13)
	button.add_theme_color_override(
		"font_color", OfficeTheme.text() if selected else OfficeTheme.text_muted()
	)
	var session_id := actor.identity.session_id
	button.pressed.connect(func(): session_selected.emit(session_id))
	row.add_child(button)
	return row


func _marker(selected: bool) -> Label:
	var marker := Label.new()
	marker.text = MARK_SELECTED if selected else MARK_UNSELECTED
	OfficeTheme.apply_font(marker, 11)
	marker.custom_minimum_size = Vector2(14, 0)
	marker.add_theme_color_override(
		"font_color", OfficeTheme.accent() if selected else OfficeTheme.text_muted()
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
	OfficeTheme.apply_font(line, 13)
	line.text = "%s  %s" % [str(row["glyph"]), _team_line(row, selected, attention)]
	line.add_theme_color_override(
		"font_color",
		OfficeTheme.accent_warm() if attention
		else (OfficeTheme.text() if selected else OfficeTheme.text_dim())
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
	var activity := _readable_activity(str(row.get("activity", "")))
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

## Show which route is currently displayed. A setter rather than an argument to
## `refresh`, because the route is shell state and not part of the projection.
##
## The current row is marked with the selection glyph, so the reader can tell which
## surface is showing without relying on colour.
func set_route(route: String) -> void:
	_route = OfficeRoute.clamp_route(route)
	if not _built:
		return
	for key in _route_buttons:
		var name := str(key)
		var button: Button = _route_buttons[name]
		button.text = "%s   %s%s" % [
			OfficeRoute.glyph(name),
			OfficeRoute.label(name),
			"   " + MARK_SELECTED if name == _route else "",
		]


## Rebuild the project rows from the ledger, with the per-project counts the store
## can answer for right now.
##
## Counts are DERIVED on each refresh rather than stored on the entry, so a session
## that starts or a review that arrives shows up without the ledger being rewritten.
## The count is COMPACT: a project with nothing to report carries no suffix at all,
## because a row of zeroes is noise rather than information.
func set_projects(ledger: ProjectLedger, store: OfficeStore) -> void:
	if not _built or _projects_box == null:
		return
	_clear_children(_projects_box)
	for entry in ledger.entries():
		var local_entry_id := str(entry["local_entry_id"])
		var directory := str(entry["canonical_directory"])
		var label := str(entry["display_name"])
		var pinned := int(entry["pin_order"]) > ProjectLedger.UNPINNED
		var summary := ledger.summary_for(directory, store)
		var row := Button.new()
		row.flat = true
		row.alignment = HORIZONTAL_ALIGNMENT_LEFT
		row.text = "%s  %s%s" % [
			MARK_PINNED if pinned else MARK_PROJECT,
			label,
			_project_suffix(summary),
		]
		OfficeTheme.apply_font(row, 13)
		row.add_theme_color_override("font_color", OfficeTheme.text_muted())
		# The tooltip carries the FULL path, because the row deliberately shortens it:
		# a shortened label must never be the only way to learn where work would run.
		row.tooltip_text = directory
		row.pressed.connect(func(): project_requested.emit(local_entry_id))
		_projects_box.add_child(row)


## The compact suffix for a project row: running work and pending attention, and
## nothing when there is none of either.
func _project_suffix(summary: Dictionary) -> String:
	var parts: Array[String] = []
	var running := int(summary.get("running", 0))
	var attention := int(summary.get("attention", 0))
	if running > 0:
		parts.append("%d running" % running)
	if attention > 0:
		parts.append("%d!" % attention)
	if parts.is_empty():
		return ""
	return "  ·  " + "  ".join(parts)


## Remove every child of a container, so a rebuild does not stack old rows.
func _clear_children(container: Node) -> void:
	for child in container.get_children():
		container.remove_child(child)
		child.queue_free()
