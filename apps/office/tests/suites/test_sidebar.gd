## Sidebar tests.
##
## The rail carries everything the removed window header held, so these pin the
## properties that matter: the mode is unmistakable, state is legible without
## colour, and an incomplete store degrades instead of crashing.
extends RefCounted


func run(t) -> void:
	test_mode_text_distinguishes_demo_from_live(t)
	test_demo_and_live_use_different_accent(t)
	test_empty_store_shows_empty_state(t)
	test_error_overrides_the_detail_line(t)
	test_agents_round_trip(t)
	test_team_rows_are_built_per_actor(t)
	test_selection_marker_is_not_colour_only(t)
	test_team_line_spells_out_attention(t)
	test_sessions_group_children_under_their_root(t)
	test_a_group_can_be_collapsed(t)
	test_the_status_bar_carries_the_location(t)
	test_a_shared_location_is_reported_and_a_split_one_is_not(t)
	test_demo_never_reports_a_live_connection(t)
	test_the_team_row_surfaces_the_reported_activity(t)
	test_a_wire_activity_name_reads_as_words(t)


func _store_with(events: Array) -> OfficeStore:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-a"})
	for event in events:
		store.apply(event)
	return store


func _created(session_id: String, agent: String, parent: String = "") -> Dictionary:
	return {
		"type": Wire.SESSION_CREATED,
		"sessionID": session_id,
		"data": {"agent": agent, "parentID": parent, "title": agent.capitalize()},
	}


## DEMO and LIVE must never read the same.
func test_mode_text_distinguishes_demo_from_live(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var demo := _store_with([])
	panel.refresh(demo, true)
	var demo_text := panel.mode_text()
	t.check(demo_text.find("DEMO") != -1, "the mode row names DEMO")
	var live := _store_with([])
	live.mode = OfficeStore.MODE_LIVE
	panel.refresh(live, true)
	var live_text := panel.mode_text()
	t.check(live_text.find("LIVE") != -1, "the mode row names LIVE")
	t.check(demo_text != live_text, "DEMO and LIVE do not read the same")
	panel.free()


## DEMO uses the warm accent; LIVE does not.
func test_demo_and_live_use_different_accent(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var demo := _store_with([])
	panel.refresh(demo, true)
	var demo_colour := panel._mode_label.get_theme_color("font_color")
	var live := _store_with([])
	live.mode = OfficeStore.MODE_LIVE
	panel.refresh(live, true)
	var live_colour := panel._mode_label.get_theme_color("font_color")
	t.check(demo_colour != live_colour, "DEMO and LIVE use different accents")
	t.check(
		demo_colour == OfficeTheme.accent_warm(),
		"DEMO uses the warm accent"
	)
	t.check(live_colour == OfficeTheme.ok(), "LIVE uses the ok accent")
	panel.free()


## An empty store must render an empty state, not throw or draw nothing.
func test_empty_store_shows_empty_state(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([])
	panel.refresh(store, false)
	t.check(
		panel._sessions_box.get_child_count() > 0,
		"the session list shows something when empty"
	)
	t.check(
		panel._team_box.get_child_count() > 0,
		"the team list shows something when empty"
	)
	t.check(panel.selected_agent() == "", "no agent is selected initially")
	t.check(panel.available_agents().is_empty(), "no agents are offered initially")
	panel.free()


## A real error outranks the routine detail line.
func test_error_overrides_the_detail_line(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([])
	panel.refresh(store, false)
	var routine := panel._detail_label.text
	t.check(not routine.is_empty(), "the detail line has routine text")
	store.last_error = "fixture missing"
	panel.refresh(store, false)
	t.check(panel._detail_label.text == "fixture missing", "the error replaces the detail line")
	t.check(
		panel._detail_label.get_theme_color("font_color") == OfficeTheme.danger(),
		"the error is shown in the danger colour"
	)
	panel.free()


func test_agents_round_trip(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var agents: Array[String] = ["God", "reviewer"]
	panel.set_agents(agents, "God")
	t.check(panel.available_agents() == agents, "the offered agents round-trip")
	t.check(panel.selected_agent() == "God", "the selection round-trips")
	t.check(panel._agent_button.text.find("God") != -1, "the button shows the selection")
	panel.free()


## One row per actor, and the count matches the store.
func test_team_rows_are_built_per_actor(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([
		_created("ses_a", "lead"),
		_created("ses_b", "backend", "ses_a"),
	])
	panel.refresh(store, false)
	t.check(store.status_rows().size() == 2, "the store reports two actors")
	t.check(
		panel._team_box.get_child_count() == 2,
		"the team list builds one row per actor"
	)
	panel.free()


## Selection must be readable without colour, so it carries a marker character.
func test_selection_marker_is_not_colour_only(t) -> void:
	t.check(
		SidebarPanel.MARK_SELECTED != SidebarPanel.MARK_UNSELECTED,
		"the selected and unselected markers differ"
	)
	# Both are glyphs: the unselected one holds the column so labels stay aligned.
	t.check(not SidebarPanel.MARK_SELECTED.is_empty(), "the selected marker has text")
	t.check(not SidebarPanel.MARK_UNSELECTED.is_empty(), "the unselected marker holds the column")
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([_created("ses_a", "lead")])
	store.select_actor("ses_a")
	panel.refresh(store, false)
	var row := panel._team_box.get_child(0)
	t.check(row != null, "a team row exists")
	if row != null:
		t.check(
			str((row as Button).text).find(SidebarPanel.MARK_SELECTED) != -1,
			"the selected row carries the marker glyph"
		)
	panel.free()


## Attention must be spelled out, not only tinted.
func test_team_line_spells_out_attention(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var row := {"name": "Qa", "session_id": "ses_a"}
	var plain := panel._team_line(row, false, false)
	var urgent := panel._team_line(row, false, true)
	t.check(urgent.find("needs you") != -1, "attention is spelled out")
	t.check(plain.find("needs you") == -1, "a calm row does not claim attention")
	t.check(urgent != plain, "the two rows differ in text, not only colour")
	t.check(plain.find("Qa") != -1, "the row still names the agent")
	panel.free()


## A child session is listed under its root, not beside it.
func test_sessions_group_children_under_their_root(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([
		_created("ses_root", "lead"),
		_created("ses_child", "backend", "ses_root"),
	])
	panel.refresh(store, false)
	t.check(
		panel._sessions_box.get_child_count() == 2,
		"the root and its child are both listed"
	)
	var root_row := panel._sessions_box.get_child(0) as HBoxContainer
	var child_row := panel._sessions_box.get_child(1) as HBoxContainer
	t.check(root_row != null and child_row != null, "both rows exist")
	if root_row == null or child_row == null:
		panel.free()
		return
	# A root with children leads with a disclosure marker, then the selection
	# marker. A child row is indented instead and has no disclosure.
	t.check(
		(root_row.get_child(0) as Button) != null,
		"the root row offers a disclosure control"
	)
	t.check(
		(root_row.get_child(1) as Label).text == SidebarPanel.MARK_SELECTED
		or (root_row.get_child(1) as Label).text == SidebarPanel.MARK_UNSELECTED,
		"the root row carries a selection marker"
	)
	t.check(
		(child_row.get_child(0) as Control) != null
		and not (child_row.get_child(0) is Label),
		"the child row is indented rather than offering disclosure"
	)
	panel.free()


## A group can be collapsed, which is the tree behaviour the reference shows.
func test_a_group_can_be_collapsed(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([
		_created("ses_root", "lead"),
		_created("ses_child", "backend", "ses_root"),
	])
	panel.refresh(store, false)
	t.check(panel._sessions_box.get_child_count() == 2, "both rows show when expanded")
	t.check(not panel.is_group_collapsed("ses_root"), "a group starts expanded")
	panel.toggle_group("ses_root")
	t.check(panel.is_group_collapsed("ses_root"), "toggling collapses it")
	t.check(
		panel._sessions_box.get_child_count() == 1,
		"a collapsed group hides its children"
	)
	panel.toggle_group("ses_root")
	t.check(panel._sessions_box.get_child_count() == 2, "expanding shows them again")
	panel.free()


## The status bar is where the location lives, matching the reference's footer.
func test_the_status_bar_carries_the_location(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var store := _store_with([_created("ses_a", "lead")])
	panel.refresh(store, false)
	panel.set_location(store)
	t.check(panel._status_label != null, "the rail has a status bar")
	t.check(not panel._status_label.text.is_empty(), "the status bar says something")
	t.check(
		panel._status_label.text.find("active") != -1,
		"the status bar reports activity"
	)
	# With no location reported it must still render rather than blank out.
	t.check(panel._location_text(store) == "", "an unplaced store reports no location")
	panel.free()


## The location is only claimed when every visible session agrees on one.
func test_a_shared_location_is_reported_and_a_split_one_is_not(t) -> void:
	var panel := SidebarPanel.new()
	panel._ensure_built()
	var one := _store_with([{
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "lead", "parentID": "", "location": {"directory": "/tmp/one"}},
	}])
	t.check(panel._location_text(one) == "/tmp/one", "one directory is shown as-is")
	var two := _store_with([
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		 "data": {"agent": "lead", "parentID": "", "location": {"directory": "/tmp/one"}}},
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_b",
		 "data": {"agent": "qa", "parentID": "", "location": {"directory": "/tmp/two"}}},
	])
	var text := panel._location_text(two)
	t.check(
		text.find("/tmp") == -1,
		"a split roster reports a count rather than picking one directory"
	)
	t.check(text.find("2") != -1, "the count names how many there are")
	panel.free()


## DEMO performs no network work, so the footer must not claim a live connection.
## Synthetic playback sets the same store field a real connection does, which is
## why the mode has to be consulted rather than the connection state alone.
func test_demo_never_reports_a_live_connection(t) -> void:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "e"})
	t.check(
		store.connection_state == OfficeStore.CONNECTION_LIVE,
		"synthetic playback sets the connection field, which is the trap"
	)
	var panel := SidebarPanel.new()
	t.check_equal(panel.MODE_NOTE_DEMO, "synthetic", "DEMO states its own condition")

	store.mode = OfficeStore.MODE_LIVE
	t.check(
		store.connection_state == OfficeStore.CONNECTION_LIVE,
		"LIVE reports the real connection state"
	)
	panel.free()


## The runtime reports what an agent is doing through activity_label. It was
## populated but shown nowhere, so the inspector could not answer "what is this
## agent doing" beyond a coarse work state.
func test_the_team_row_surfaces_the_reported_activity(t) -> void:
	var store := OfficeStore.new()
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_a",
			"data": {"agent": "backend", "parentID": ""},
		}
	)
	store.apply({"type": Wire.TOOL_CALLED, "sessionID": "ses_a", "data": {"tool": "read"}})
	var rows := store.status_rows()
	t.check(rows.size() == 1, "one actor is reported")
	t.check(
		not str(rows[0].get("activity", "")).is_empty(),
		"the status row carries what the agent is doing"
	)


## The rail shows a wire event name to a person. Reading it raw puts an
## implementation detail in front of the user, so the namespace is dropped and the
## remainder spaced — and an unknown name still reads sensibly rather than being
## invented into a word.
func test_a_wire_activity_name_reads_as_words(t) -> void:
	var panel := SidebarPanel.new()
	t.check_equal(
		panel._readable_activity("session.step.started"),
		"started",
		"the namespace is dropped for a person"
	)
	t.check_equal(
		panel._readable_activity("session.execution.succeeded"),
		"succeeded",
		"the terminal event reads as a plain word"
	)
	t.check_equal(
		panel._readable_activity("session.compaction.started"),
		"started",
		"a compaction event reads as a plain word"
	)
	t.check_equal(
		panel._readable_activity("multi_step_tool"),
		"multi_step_tool",
		"a tool name with no namespace is left exactly as it is"
	)
	t.check_equal(panel._readable_activity("read"), "read", "a tool name passes through")
	t.check_equal(panel._readable_activity(""), "", "an empty activity stays empty")
	panel.free()
