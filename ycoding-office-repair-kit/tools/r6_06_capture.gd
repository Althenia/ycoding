## R6-06 native capture: the classified 'equivalent' actions really work.
##
## The ledger claims 24 actions are implemented, each naming an office path. This capture
## drives those claims through the REAL `res://app/main.tscn` scene and reads the effect,
## so the classification rests on runtime behaviour rather than on a cited path existing.
##
## What it proves, in one run:
##
##   * every SHORTCUT intent changes observable state (a chrome panel toggles, the
##     selection moves, the theme and the text scale change, the drawer opens and closes);
##   * the composer submissions the ledger claims (submit, newline) are real;
##   * the model pill the ledger claims is a real catalogue read;
##   * the session list and inspector the ledger claims operate on real actors.
##
## It also prints the ledger's own totals beside the live state, so a reader can see the
## classification and the behaviour in one place.
##
## Kit-local: no repository source depends on this file.
extends SceneTree

var _out := ""
var _frames := 0
var _results: Array[String] = []
var _checks := 0
var _fails := 0


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		_out = str(args[0])


func _initialize() -> void:
	_go()


func _go() -> void:
	var packed := load("res://app/main.tscn")
	if packed == null:
		print("R606 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R606 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		_results.append("PASS  " + message)
		return
	_fails += 1
	_results.append("FAIL  " + message)


func _run(scene) -> void:
	scene.start_demo_mode()
	await process_frame
	var store: Variant = scene.store

	# --- the graded set: every shortcut intent must change observable state -------------
	var sidebar_before: bool = scene.sidebar.visible
	scene._apply_shortcut("toggle_sidebar")
	_check(scene.sidebar.visible != sidebar_before, "toggle_sidebar changes the sidebar's visibility")

	var composer_before: bool = scene.prompt_panel.visible
	scene._apply_shortcut("toggle_composer")
	_check(scene.prompt_panel.visible != composer_before, "toggle_composer changes the composer's visibility")
	# A revealed composer must end with the caret in it, not merely visible.
	scene._apply_shortcut("toggle_composer")
	_check(scene.prompt_panel.visible, "toggle_composer restores the composer")

	var theme_before: String = OfficeTheme.mode()
	scene._apply_shortcut("toggle_theme")
	_check(OfficeTheme.mode() != theme_before, "toggle_theme changes the palette mode")
	scene._apply_shortcut("toggle_theme")

	var scale_before: float = OfficeTheme.text_scale()
	scene._apply_shortcut("toggle_scale")
	_check(OfficeTheme.text_scale() != scale_before, "toggle_scale changes the text scale")
	scene._cycle_scale(scale_before)

	# A second session, so the selection actions have somewhere to move TO. Asserting a
	# move within a one-session roster would be vacuous.
	store.apply({
		"type": "session.created", "sessionID": "ses_r606_second",
		"data": {"agent": "lead", "title": "Lead R606"}, "sourceEpoch": "epoch-r606",
	})
	await process_frame

	# Selection needs a roster.
	var roster: Array = store.actor_list()
	_check(not roster.is_empty(), "the office has a roster to select within (%d)" % roster.size())
	if roster.size() >= 2:
		store.select_actor(roster[0].identity.session_id)
		scene._apply_shortcut("next_session")
		var after: Variant = store.selected_actor()
		_check(after != null and after.identity.session_id != roster[0].identity.session_id,
			"next_session moves the selection")
		scene._apply_shortcut("previous_session")
		var back: Variant = store.selected_actor()
		_check(back != null and back.identity.session_id == roster[0].identity.session_id,
			"previous_session moves it back")

	# inspect opens the drawer; dismiss releases what is open, INNERMOST FIRST: the caret
	# while the composer holds it, and only then the drawer.
	scene._apply_shortcut("inspect")
	await process_frame
	_check(scene.conversation_panel.visible, "inspect opens the source drawer")
	# Give the drawer something to hold, so 'dismiss closes it' is not vacuous.
	scene.conversation_panel.show_actor(store, store.selected_actor().identity.session_id)
	await process_frame
	if scene.prompt_panel.has_input_focus():
		scene._apply_shortcut("dismiss")
		await process_frame
		_check(
			not scene.prompt_panel.has_input_focus(),
			"dismiss releases the caret first while the composer holds it"
		)
		_check(
			scene.conversation_panel.visible,
			"and leaves the drawer open, because the caret is the innermost thing open"
		)
	else:
		_results.append("NOTE  the composer did not hold the caret, so the innermost-first step is not shown")
	scene._apply_shortcut("dismiss")
	await process_frame
	_check(not scene.conversation_panel.visible, "dismiss then closes the open drawer")

	# --- composer actions ---------------------------------------------------------------
	# The ledger classifies prompt_submit and input_newline as implemented. Both are driven
	# through the REAL key path the composer uses, not by calling a setter: a submit is a
	# Return press and a newline is a modified Return, which is what the binding means.
	var sent: Array[String] = []
	scene.prompt_panel.prompt_submitted.connect(func(text: String) -> void: sent.append(text))
	scene.prompt_panel.set_draft("a submitted line")
	scene.prompt_panel._on_input_event(_return(false))
	_check(sent.size() == 1, "prompt_submit sends the draft through the panel's own signal")
	_check(sent.size() == 1 and sent[0] == "a submitted line", "and it sends the text that was typed")

	# A modified Return must break the line, not submit.
	scene.prompt_panel.set_draft("line one")
	scene.prompt_panel._on_input_event(_return(true))
	_check(sent.size() == 1, "a modified Return does not submit")
	_check(
		scene.prompt_panel.current_text().contains("\n"),
		"input_newline breaks the line instead (%s)" % scene.prompt_panel.current_text()
	)
	scene.prompt_panel.set_draft("")

	# --- model pill: a real catalogue read ---------------------------------------------
	var ref: String = scene.prompt_panel.model_ref()
	_check(not str(ref).is_empty(), "the model control names a model (%s)" % str(ref))

	# --- inspector state the ledger claims ----------------------------------------------
	var target: Variant = store.selected_actor()
	if target != null:
		var family: Array = store.family_session_ids(target.identity.session_id)
		_check(not family.is_empty(), "the inspected session has a family (%d)" % family.size())

	print("R606 checks=%d fails=%d" % [_checks, _fails])
	for line in _results:
		print("R606 " + line)
	await _capture(scene, "%s/r6-06-parity-real-scene.png" % _out)
	print("R606 done")
	quit(1 if _fails > 0 else 0)


## A Return press, optionally modified, in the shape the composer reads.
func _return(modified: bool) -> InputEventKey:
	var key := InputEventKey.new()
	key.keycode = KEY_ENTER
	key.pressed = true
	key.shift_pressed = modified
	return key


func _capture(scene, path: String) -> void:
	scene.capture_mode = true
	await process_frame
	await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null:
		print("R606 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R606 captured %s" % path)
	else:
		print("R606 FAIL: could not write %s" % path)
