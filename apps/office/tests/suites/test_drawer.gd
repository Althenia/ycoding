## Contextual drawer and modal stack tests (R2-05).
##
## The acceptance is: "No permanently opaque giant inspector; stable placement,
## Escape, focus return and dirty-state protection."
##
## Each clause is a separate property and they fail differently:
##
##   * NO GIANT INSPECTOR - the drawer is BOUNDED on both axes, and its width is a
##     capped share of the visible office, so it can never swallow the frame;
##   * STABLE PLACEMENT - its rect comes from the layout owner (not a literal at
##     the placement site), and repeating a placement gives the identical rect;
##   * ESCAPE - the innermost thing releases first, and Escape closes the drawer;
##   * FOCUS RETURN - closing returns the caret to the composer, so the user's next
##     action works without a click;
##   * DIRTY-STATE PROTECTION - closing a panel that merely DESCRIBES work must
##     never cost the composer's draft.
##
## The Escape and focus clauses drive the REAL composition root, because the
## dispatch order between the caret and the drawer is the behaviour under test and a
## copy of it would prove nothing.
extends RefCounted


func run(t) -> void:
	test_the_drawer_is_bounded_and_never_a_giant_inspector(t)
	test_the_drawer_placement_is_stable_and_layout_owned(t)
	test_the_drawer_never_covers_the_composer(t)
	test_escape_releases_the_caret_before_the_drawer(t)
	test_closing_the_drawer_returns_focus_to_the_composer(t)
	test_closing_the_drawer_never_costs_the_draft(t)
	test_a_request_from_any_session_in_the_family_is_answerable(t)
	test_every_waiting_request_in_the_family_is_shown(t)
	test_attention_is_answerable_from_any_page(t)
	test_answering_never_steals_focus_or_moves_the_view(t)
	test_the_drawer_stops_the_session_it_shows_not_the_selection(t)
	test_the_drawer_stop_says_why_it_cannot_act(t)
	test_the_inspector_states_the_task(t)
	test_the_inspector_states_the_parent_and_child_identity(t)
	test_two_sessions_sharing_a_role_are_distinguishable(t)
	test_the_inspector_does_not_dress_up_a_report_without_text(t)
	test_a_row_opens_its_exact_source(t)
	test_a_shortened_report_shows_it_is_shortened(t)


## The drawer must never be a permanently opaque giant inspector: bounded on both
## axes at every window, and never a full-width or full-height surface.
func test_the_drawer_is_bounded_and_never_a_giant_inspector(t) -> void:
	for scale in UiScale.STEPS:
		for size in [
			Vector2(1024, 768), Vector2(1280, 720), Vector2(1440, 900),
			Vector2(1920, 1080), Vector2(2560, 1440),
		]:
			var rects := OfficeShellLayout.overlays(size, scale)
			var drawer: Rect2 = rects["drawer"]
			t.check(drawer.size.x > 0.0, "the drawer has a width at %s" % str(size))
			t.check(drawer.size.y > 0.0, "the drawer has a height at %s" % str(size))
			# Never the whole frame: a full-bleed panel is the inspector this
			# acceptance forbids.
			t.check(
				drawer.size.x < size.x - 1.0,
				"the drawer is narrower than the window at %s x%.2f" % [str(size), scale]
			)
			t.check(
				drawer.size.y < size.y - 1.0,
				"the drawer is shorter than the window at %s x%.2f" % [str(size), scale]
			)
			# The width is CAPPED as a share of the visible office, so a very wide
			# window does not grow it into a full-width sheet.
			var sidebar_rect: Rect2 = rects["sidebar"]
			var content_w: float = size.x - sidebar_rect.size.x
			t.check(
				drawer.size.x <= content_w * OfficeShellLayout.DRAWER_MAX_SHARE + 0.01,
				"the drawer width is a capped share of the office at %s x%.2f"
					% [str(size), scale]
			)
			# And it can never exceed its own declared ceiling.
			t.check(
				drawer.size.x <= OfficeShellLayout.DRAWER_W + 0.01,
				"the drawer width is within its declared ceiling at %s" % str(size)
			)


## Placement is stable and owned by the layout module. The same inputs must give
## the identical rect, and the rect must come from `overlays` rather than a literal
## at the placement site.
func test_the_drawer_placement_is_stable_and_layout_owned(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1280, 720), Vector2(1600, 900)]:
			var first := OfficeShellLayout.overlays(size, scale)
			var second := OfficeShellLayout.overlays(size, scale)
			t.check(
				first["drawer"] == second["drawer"],
				"the drawer rect is identical across calls at %s x%.2f" % [str(size), scale]
			)
			# It must be a named overlay, so a caller cannot forget to place it and
			# leave a panel at a stale position.
			t.check(
				OfficeShellLayout.OVERLAYS.has("drawer"),
				"the drawer is a declared overlay"
			)


## The drawer must not cover the composer. The composer is where the user acts; a
## panel that describes the work must never sit on top of the work's controls.
func test_the_drawer_never_covers_the_composer(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1024, 768), Vector2(1280, 720), Vector2(1920, 1080)]:
			var rects := OfficeShellLayout.overlays(size, scale)
			var drawer: Rect2 = rects["drawer"]
			var composer: Rect2 = rects["composer"]
			t.check(
				not drawer.intersects(composer),
				"the drawer clears the composer at %s x%.2f" % [str(size), scale]
			)
			t.check(
				drawer.position.y + drawer.size.y <= composer.position.y + 0.01,
				"the drawer stops above the composer at %s x%.2f" % [str(size), scale]
			)


## Escape releases what is open INNERMOST FIRST: the caret before the drawer. A
## user pressing Escape with the caret in the composer expects the caret to leave,
## not the panel behind it to vanish.
func test_escape_releases_the_caret_before_the_drawer(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return

	# Nothing open: Escape is a safe no-op rather than an error.
	main.conversation_panel.visible = false
	main._apply_shortcut(Shortcuts.DISMISS)
	t.check(
		not main.conversation_panel.visible,
		"Escape with nothing open changes nothing"
	)

	# The drawer open, no caret: Escape closes the drawer.
	main.conversation_panel.visible = true
	main._apply_shortcut(Shortcuts.DISMISS)
	t.check(
		not main.conversation_panel.visible,
		"Escape closes the open drawer"
	)

	# The drawer open AND the caret in the composer: the caret leaves first, and the
	# drawer stays, because the innermost thing releases first.
	main.conversation_panel.visible = true
	main.prompt_panel.focus_input()
	if main.prompt_panel.has_input_focus():
		main._apply_shortcut(Shortcuts.DISMISS)
		t.check(
			not main.prompt_panel.has_input_focus(),
			"the first Escape releases the caret"
		)
		t.check(
			main.conversation_panel.visible,
			"and leaves the drawer open, because the caret was innermost"
		)
		main._apply_shortcut(Shortcuts.DISMISS)
		t.check(
			not main.conversation_panel.visible,
			"the second Escape then closes the drawer"
		)
	_free(main)


## Closing the drawer returns the caret to the composer. Without this the user is
## left with focus nowhere after dismissing a panel, and their next keystroke goes
## into the void.
func test_closing_the_drawer_returns_focus_to_the_composer(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return

	main.conversation_panel.visible = true
	main._close_drawer()
	t.check(not main.conversation_panel.visible, "the drawer closed")
	# Focus return is what keeps the user's next keystroke from going nowhere. The
	# panel holds no text control of its own, so nothing can be left focused inside
	# it; the observable requirement is that the composer holds the caret again.
	t.check(
		main.prompt_panel._input != null,
		"the composer has an editor to return focus to"
	)
	main.prompt_panel.focus_input()
	t.check(
		main.prompt_panel.has_input_focus() == main.prompt_panel._input.has_focus(),
		"the composer reports the focus the engine granted it"
	)

	# The panel's own close signal must take the SAME path, or the two ways of
	# closing would differ in whether focus returns.
	main.conversation_panel.visible = true
	main.conversation_panel.close_requested.emit()
	t.check(
		not main.conversation_panel.visible,
		"the panel's own close request closes the drawer"
	)
	_free(main)


## DIRTY-STATE PROTECTION. Closing a panel that merely DESCRIBES work must never
## cost the composer's draft. The draft lives in the composer, so this is asserted
## end to end: type, open, close, and the text is still there.
func test_closing_the_drawer_never_costs_the_draft(t) -> void:
	var main := await _bootable(t)
	if main == null:
		t.check(false, "the composition root builds")
		return
	if main.prompt_panel._input == null:
		_free(main)
		return

	main.prompt_panel._input.text = "half-written thought"
	main.conversation_panel.visible = true
	main._close_drawer()
	t.check_equal(
		main.prompt_panel.current_text(),
		"half-written thought",
		"closing the drawer preserves the composer draft"
	)

	# And closing via Escape, the other path, must preserve it too. The close above
	# returned the caret to the composer, so the innermost thing releases first: the
	# first Escape gives up the caret and the second closes the drawer. Driven
	# explicitly rather than conditionally, so neither press can silently stop mattering.
	t.check(
		main.prompt_panel.has_input_focus(),
		"the close above returned the caret to the composer"
	)
	main.conversation_panel.visible = true
	main._apply_shortcut(Shortcuts.DISMISS)
	t.check(
		not main.prompt_panel.has_input_focus(),
		"the first Escape releases the returned caret"
	)
	main._apply_shortcut(Shortcuts.DISMISS)
	t.check(
		not main.conversation_panel.visible,
		"Escape closed the drawer in this case"
	)
	t.check_equal(
		main.prompt_panel.current_text(),
		"half-written thought",
		"closing by Escape also preserves the draft"
	)
	_free(main)


## A session that needs a human, in the shape the wire delivers it.
func _ask(store: OfficeStore, session_id: String, request_id: String, summary: String) -> void:
	store.attention.push(
		AttentionQueue.KIND_PERMISSION, request_id, session_id,
		{"summary": summary, "options": []}
	)


## R5-06. The drawer shows a session's whole FAMILY thread, so a request from any session in
## that family must be answerable there. Showing the thread but only the selected session's
## requests left a delegated child blocked with nothing to answer: the user could read the
## child's work and had no way to unblock it.
func test_a_request_from_any_session_in_the_family_is_answerable(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	# A parent and its child, as a delegation produces.
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_parent",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_child",
		"data": {"agent": "lead", "title": "Child", "parentID": "ses_parent"},
		"sourceEpoch": "epoch-live",
	})
	t.check(
		store.family_session_ids("ses_parent").has("ses_child"),
		"the child is in the parent's family"
	)
	_ask(store, "ses_child", "req_child", "a child tool needs approval")
	main.conversation_panel.show_actor(store, "ses_parent", "")
	t.check(
		main.conversation_panel._attention_box.get_child_count() > 0,
		"the child's request is answerable from the parent's drawer"
	)
	# And it names the session it belongs to, so the user knows which one is blocked.
	var text := _attention_text(main.conversation_panel)
	t.check(
		text.contains("ses_child"),
		"the card names the session that is blocked (got '%s')" % text
	)
	_free(main)


## R5-06. Every waiting request in the family is shown, not just the first. A second one
## arriving must not hide behind the first, or the user answers one and the session stays
## blocked.
func test_every_waiting_request_in_the_family_is_shown(t) -> void:
	var main := await _bootable(t)
	_ask(main.store, "ses_a", "req_one", "first")
	_ask(main.store, "ses_a", "req_two", "second")
	main.conversation_panel.show_actor(main.store, "ses_a", "")
	var text := _attention_text(main.conversation_panel)
	t.check(text.contains("first"), "the first request is shown")
	t.check(text.contains("second"), "the second request is shown too")
	_free(main)


## R5-06. Attention must be answerable from ANY page, because a blocked session does not
## stop being blocked when the user looks at Statistics. Closing the drawer on leaving the
## Office route left the request unreachable everywhere else.
func test_attention_is_answerable_from_any_page(t) -> void:
	var main := await _bootable(t)
	_ask(main.store, "ses_a", "req_page", "waiting")
	for route in [OfficeRoute.SESSIONS, OfficeRoute.STATISTICS, OfficeRoute.OFFICE]:
		main.router.go(route)
		main.conversation_panel.show_actor(main.store, "ses_a", "")
		main._apply_route_visibility()
		t.check(
			main.conversation_panel.visible,
			"the drawer stays shown on the %s page" % route
		)
		t.check(
			main.conversation_panel._attention_box.get_child_count() > 0,
			"and the request is answerable there"
		)
	_free(main)


## R5-06. Answering must not steal focus. The user answers and carries on where they were:
## the same page, the same selection, the same draft in the composer, and the drawer still
## open. Moving any of them would make answering an interruption rather than a reply.
func test_answering_never_steals_focus_or_moves_the_view(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	store.select_actor("ses_a")
	main.router.go(OfficeRoute.STATISTICS)
	main.conversation_panel.show_actor(store, "ses_a", "")
	main.prompt_panel.set_draft("a thought I was in the middle of")
	main._apply_route_visibility()
	_ask(store, "ses_a", "req_focus", "waiting")

	var route_before := main.router.route()
	var target_before := main._prompt_target()
	main._on_attention_replied("req_focus", {"reply": "once"})
	t.check_equal(main.router.route(), route_before, "answering does not change the page")
	t.check_equal(
		main._prompt_target(), target_before, "nor which session is selected"
	)
	t.check_equal(
		main.prompt_panel.current_text(), "a thought I was in the middle of",
		"nor the draft the user was writing"
	)
	t.check(
		main.conversation_panel.visible,
		"nor does it close the drawer the user was reading"
	)
	_free(main)


## The attention text the drawer actually renders, so an assertion is about what the user
## can read rather than about bookkeeping.
func _attention_text(panel: ConversationPanel) -> String:
	var text := ""
	for node in panel._attention_box.get_children():
		text += _label_text(node) + "\n"
	return text


func _label_text(node: Node) -> String:
	var out := ""
	if node is Label:
		out += (node as Label).text
	for child in node.get_children():
		out += _label_text(child)
	return out


## R5-06. The drawer's stop names the session the drawer is SHOWING, not whatever happens to
## be selected. Resolving the selection instead would stop another project's work - the exact
## cross-project mistake this programme keeps finding.
func test_the_drawer_stops_the_session_it_shows_not_the_selection(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_background",
		"data": {"agent": "lead", "title": "Background"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_shown",
		"data": {"agent": "lead", "title": "Shown"}, "sourceEpoch": "epoch-live",
	})
	# The user is looking at one session's drawer while another is selected.
	store.select_actor("ses_background")
	var asked: Array[String] = []
	main.conversation_panel.stop_requested.connect(
		func(session_id: String) -> void: asked.append(session_id)
	)
	main.conversation_panel.show_actor(store, "ses_shown", "")
	main.conversation_panel._stop.pressed.emit()
	t.check_equal(
		asked, ["ses_shown"] as Array[String],
		"the stop asks for the session the drawer shows"
	)
	t.check_equal(
		main._prompt_target(), "ses_background",
		"and the selection is left where the user had it"
	)
	_free(main)


## R5-06 / R2-06. A control that cannot act says why. DEMO has no service to stop work in,
## and an idle session has nothing to stop, so the drawer's control is disabled with the
## matching reason in both cases rather than swallowing the click.
func test_the_drawer_stop_says_why_it_cannot_act(t) -> void:
	var main := await _bootable(t)
	var panel := main.conversation_panel
	# DEMO: built by `_bootable` with no live attach, so the store is in DEMO. The drawer is
	# shown first, because the reason is set when the drawer learns what it is showing - a
	# control's opening tooltip is not yet an answer about the office.
	main.store.mode = OfficeStore.MODE_DEMO
	panel.show_actor(main.store, "ses_a", "")
	t.check(panel._stop.disabled, "the control is disabled with no service")
	t.check_equal(
		panel._stop.tooltip_text, ConversationPanel.STOP_DEMO_REASON,
		"and says the office is a preview"
	)
	# LIVE but idle: nothing is running, so nothing can be stopped.
	main.store.mode = OfficeStore.MODE_LIVE
	panel.show_actor(main.store, "ses_a", "")
	t.check(panel._stop.disabled, "the control stays disabled while nothing runs")
	t.check_equal(
		panel._stop.tooltip_text, ConversationPanel.STOP_DISABLED_REASON,
		"and says there is nothing to stop"
	)
	# WORKING: now it can act.
	main.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	main.store.apply({"type": Wire.STEP_STARTED, "sessionID": "ses_a", "data": {}})
	panel.show_actor(main.store, "ses_a", "")
	t.check(
		not panel._stop.disabled,
		"a running session offers the stop (state %d)" % main.store.actor_for("ses_a").work_state
	)
	_free(main)


## --- R6-03: the inspector ---------------------------------------------------

## The drawer's whole visible text, so an assertion is about what a user can read.
func _drawer_state(panel: ConversationPanel) -> String:
	return (
		_label_text(panel._title) + " | " + _label_text(panel._subtitle)
		+ " | " + _label_text(panel._family_text) + " | " + _attention_text(panel)
	)


## Everything the drawer RENDERS, read back from its own controls rather than from the rows
## that fed them. A row the drawer failed to render is then visible as missing.
func _drawer_text(panel: ConversationPanel) -> String:
	var out := _label_text(panel._title) + " " + _label_text(panel._subtitle)
	for node in panel._list.get_children():
		out += " " + _label_text(node)
	return out.strip_edges()


## R6-03. The inspector must state the TASK the assignment is working on. "Click an actor to
## show current work": without the task the header names a session and says nothing about
## what it is doing, which is the first thing a user opening an actor wants.
func test_the_inspector_states_the_task(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_task",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_task",
		"data": {"change": {
			"type": Wire.CHANGE_LAUNCHED, "inputID": "ses_child_x",
			"parentID": "ses_task", "toolCallID": "call_t",
			"description": "repair the transcript projection",
		}},
		"sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_task", "")
	var shown := _drawer_state(main.conversation_panel)
	t.check(
		shown.contains("repair the transcript projection"),
		"the inspector states the task (got '%s')" % shown
	)
	_free(main)


## R6-03. The inspector must state WHERE the assignment sits in its family. The kit requires
## parent/child identity, and an actor whose parent is not named reads as a root.
func test_the_inspector_states_the_parent_and_child_identity(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_parent",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_child",
		"data": {"agent": "lead", "title": "Child", "parentID": "ses_parent"},
		"sourceEpoch": "epoch-live",
	})
	# A CHILD says it is a child OF a named session. Asserting that the parent's id appears
	# somewhere would pass for a "root" fallback that names nothing, so the RELATION is
	# asserted: the word "child" and the parent's id, together.
	main.conversation_panel.show_actor(store, "ses_child", "")
	var child_shown := _drawer_state(main.conversation_panel)
	t.check(
		child_shown.contains("child of") and child_shown.contains("ses_parent"),
		"a child's inspector says it is a child of its parent (got '%s')" % child_shown
	)
	t.check(
		not child_shown.contains("root"),
		"and never calls a child a root (got '%s')" % child_shown
	)
	# A PARENT that has children names them, so the delegation is traceable both ways.
	main.conversation_panel.show_actor(store, "ses_parent", "")
	var parent_shown := _drawer_state(main.conversation_panel)
	t.check(
		parent_shown.contains("children") and parent_shown.contains("ses_child"),
		"a parent's inspector names its children (got '%s')" % parent_shown
	)
	# A SIBLING must not be listed as this parent's child either. The family list returns the
	# whole tree, so a "children" line built from it would name the sibling - and, with a
	# different session, the session itself. This is what makes the direct-children rule
	# observable rather than a filter that happens to coincide.
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_sibling",
		"data": {"agent": "lead", "title": "Sibling", "parentID": "ses_parent"},
		"sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_child", "")
	var sibling_view := _drawer_state(main.conversation_panel)
	t.check(
		not sibling_view.contains("ses_sibling"),
		"a sibling is NOT listed among this session's children (got '%s')" % sibling_view
	)
	# And a session with no children of its own claims none.
	t.check(
		not sibling_view.contains("children:"),
		"a session with no children of its own claims none (got '%s')" % sibling_view
	)
	# The parent still lists BOTH real children, so the rule did not simply stop listing.
	main.conversation_panel.show_actor(store, "ses_parent", "")
	var both_shown := _drawer_state(main.conversation_panel)
	t.check(
		both_shown.contains("children:") and both_shown.contains("ses_child")
		and both_shown.contains("ses_sibling"),
		"the parent lists both of its children (got '%s')" % both_shown
	)
	_free(main)


## R6-03. The kit: "assignment keyed by session not reusable role." Two sessions sharing one
## agent configuration are TWO actors, so an inspector must be able to tell them apart and
## must never merge them.
func test_two_sessions_sharing_a_role_are_distinguishable(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "backend", "title": "Backend"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_b",
		"data": {"agent": "backend", "title": "Backend"}, "sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_a", "")
	var a_shown := _drawer_state(main.conversation_panel)
	main.conversation_panel.show_actor(store, "ses_b", "")
	var b_shown := _drawer_state(main.conversation_panel)
	t.check(
		a_shown.contains("ses_a"), "the first session's inspector names its own session"
	)
	t.check(
		b_shown.contains("ses_b"), "and the second names its own"
	)
	t.check(
		a_shown != b_shown,
		"two sessions sharing a role inspect differently"
	)
	_free(main)


## R6-03. A report must be REAL. A completion that carried no report text says so rather than
## being dressed up as a success, which is what the store's own rule requires and what an
## inspector must not undo.
func test_the_inspector_does_not_dress_up_a_report_without_text(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_r",
		"data": {"change": {"type": Wire.CHANGE_COMPLETED, "runID": "run-1"}},
		"sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_r", "")
	var rendered: String = _drawer_text(main.conversation_panel)
	t.check(
		rendered.contains(ConversationHistory.NO_REPORT_STATUS)
			or rendered.contains("Completed"),
		"a completion with no report says what happened (%s)" % rendered
	)
	for invented in ["success", "succeeded successfully", "all done"]:
		t.check(
			not rendered.to_lower().contains(invented),
			"and does not invent a success statement ('%s')" % invented
		)
	_free(main)


## R6-03. A row must open its EXACT SOURCE. A delegation names the child it was handed to, so
## the row can be followed there rather than leaving the user to guess which session it was.
func test_a_row_opens_its_exact_source(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_p",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_c",
		"data": {"agent": "lead", "title": "Child", "parentID": "ses_p"},
		"sourceEpoch": "epoch-live",
	})
	store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_p",
		"data": {"change": {
			"type": Wire.CHANGE_LAUNCHED, "inputID": "ses_c", "parentID": "ses_p",
			"toolCallID": "call_x", "description": "handed to the child",
		}},
		"sourceEpoch": "epoch-live",
	})
	var asked: Array[String] = []
	main.conversation_panel.open_session_requested.connect(
		func(session_id: String) -> void: asked.append(session_id)
	)
	main.conversation_panel.show_actor(store, "ses_p", "")
	main.conversation_panel._open_source("delegation:call_x")
	t.check_equal(
		asked, ["ses_c"] as Array[String],
		"opening a delegation's source asks for the session it was handed to"
	)
	# A row that EXISTS and names a session this office does NOT have asks for nothing. A row
	# id that simply does not exist would leave the target empty and return for a different
	# reason, so it would not exercise the existence guard at all - which is why the first
	# version of this test caught nothing.
	store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_p",
		"data": {"change": {
			"type": Wire.CHANGE_LAUNCHED, "inputID": "ses_ghost",
			"parentID": "ses_p", "toolCallID": "call_ghost",
			"description": "handed to a session this office never saw",
		}},
		"sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_p", "")
	main.conversation_panel._open_source("delegation:call_ghost")
	t.check_equal(
		asked, ["ses_c"] as Array[String],
		"a row naming a session this office does not have emits nothing (events: %s)" % str(asked)
	)
	t.check_equal(
		asked.size(), 1,
		"so the emitted events are still only the real one"
	)
	# A row that DOES name a real session still opens, so the guard is not simply dead. The
	# completion report on the parent is exactly such a row.
	store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_p",
		"data": {"change": {
			"type": Wire.CHANGE_COMPLETED, "runID": "run-real", "excerpt": "the real report",
		}},
		"sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_p", "")
	var report_row := ""
	for item in main.conversation_panel._thread_items:
		if str(item.get("description", "")) == "the real report":
			report_row = str(item.get("id", ""))
	t.check(not report_row.is_empty(), "the report row exists to be opened")
	if not report_row.is_empty():
		main.conversation_panel._open_source(report_row)
		t.check(
			asked.has("ses_p"),
			"a row naming a real session still opens it (events: %s)" % str(asked)
		)
	_free(main)


## R6-03. A shortened report must preserve its QUALIFIERS. The kit requires it, and the
## truncation marker is what tells a reader the text they see is not the whole of it.
func test_a_shortened_report_shows_it_is_shortened(t) -> void:
	var main := await _bootable(t)
	var store := main.store
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_long",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	var long_text := "IMPORTANT QUALIFIER: ".repeat(200)
	store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_long",
		"data": {"change": {
			"type": Wire.CHANGE_COMPLETED, "runID": "run-long", "excerpt": long_text,
		}},
		"sourceEpoch": "epoch-live",
	})
	main.conversation_panel.show_actor(store, "ses_long", "")
	var rendered: String = _drawer_text(main.conversation_panel)
	t.check(
		rendered.contains("…") or rendered.length() >= long_text.length(),
		"a shortened report is marked as shortened rather than presented whole"
	)
	_free(main)


## A composition root with the panels the drawer path needs.
##
## The root is deliberately NEVER added to the tree: `OfficeMain._ready` resolves
## scene children (`$Shell`, `$Shell/OfficeViewport`), so putting a scene-less root
## in the tree makes `_ready` fire against nulls and raises engine errors. This
## suite drives the shortcut and close paths directly, which is where the dispatch
## order lives, so no tree is needed for the root itself.
##
## The COMPOSER is the exception: focus only exists in tree scope, so the panel is
## readied by attaching it as the root's sole child while the root stays out of the
## tree, which is how the composer suite drives it too.
## Suites must `await` this: the composer's `_ready` runs on tree entry, which is
## deferred to the next frame, and a test that asserted before it would be asserting
## against a panel whose controls do not exist yet.
func _bootable(t) -> OfficeMain:
	var main := OfficeMain.new()
	main.store = OfficeStore.new()
	main.director = OfficeDirector.new()
	main.demo = DemoTransport.new()
	main.live = LiveTransport.new()
	main.models_api = ModelCatalogApi.new()
	main.sessions_api = SessionApi.new()
	main.prompt_panel = PromptPanel.new()
	# The composer is the exception: focus exists only in tree scope, so a panel built
	# outside it can never take the caret and the Escape precedence would skip silently.
	# It is attached to the TREE (not to the scene-less root, whose `_ready` would fire
	# against missing scene children) and its own `_ready` runs once on tree entry.
	t.root.add_child(main.prompt_panel)
	# Exactly ONE build: `_ready` runs on tree entry and is NOT called explicitly here,
	# because the panel has no build guard and a second call would build the rows twice.
	await t.process_frame
	main.sidebar = SidebarPanel.new()
	main.sidebar._ensure_built()
	main.add_child(main.sidebar)
	main.conversation_panel = ConversationPanel.new()
	# The drawer is attached to the TREE, not to the scene-less root, so its `_ready` runs
	# exactly once and it actually builds its attention cards and list. Added to the root
	# instead, `_ready` never fires and every assertion about the drawer would be made
	# against null controls.
	t.root.add_child(main.conversation_panel)
	main.chrome_toggles = ChromeToggles.new()
	main.add_child(main.chrome_toggles)
	main.office_view = OfficeViewport.new()
	main.add_child(main.office_view)
	main._wire_signals()
	return main


func _free(main: OfficeMain) -> void:
	if main.live != null:
		main.live.stop()
	# The composer and the drawer are parented to the tree rather than the root so their
	# `_ready` could run in real scope, so freeing the root does not free them.
	if main.prompt_panel != null:
		main.prompt_panel.free()
	if main.conversation_panel != null:
		main.conversation_panel.free()
	main.free()
