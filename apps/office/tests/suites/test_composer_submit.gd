## Composer submit tests.
##
## The composer is where typing becomes work, and the key map it honours is the
## TUI's own: a bare Return submits, and Return with a modifier inserts a newline.
## The submission itself stays the host's business, so the composer's contract is
## narrow: exactly one `prompt_submitted` with the trimmed draft, and the draft
## left in place so a refused submission does not destroy what the user wrote.
##
## The tests drive the panel's real key handler with synthetic `InputEventKey`
## objects. The engine routes a key only to the focused control inside a live
## viewport, and a headless suite has no running frame in which to grant that
## focus, so the handler is the boundary under test here and the key map is
## asserted through it.
extends RefCounted


func run(t) -> void:
	test_a_bare_return_submits_the_draft(t)
	test_a_submission_reports_the_trimmed_text_and_keeps_the_draft(t)
	test_the_submit_signal_is_unchanged_for_the_host(t)
	test_shift_return_inserts_a_newline_at_the_caret(t)
	test_ctrl_return_inserts_a_newline_without_submitting(t)
	test_alt_return_inserts_a_newline_without_submitting(t)
	test_the_command_modifier_is_the_same_newline_binding(t)
	test_both_return_keys_submit(t)
	test_whitespace_only_input_never_submits(t)
	test_return_on_an_empty_composer_does_not_submit(t)
	test_a_held_return_does_not_resubmit(t)
	test_a_return_release_does_not_submit(t)
	test_no_other_input_submits(t)
	test_the_editor_exposes_the_composition_state_the_guard_reads(t)
	test_a_submission_leaves_the_controls_coherent(t)
	test_stop_is_disabled_with_its_reason_by_default(t)
	test_stop_is_offered_only_when_there_is_work_to_stop(t)
	test_stop_asks_the_host_rather_than_acting_itself(t)
	test_focus_is_reported_from_the_real_editor(t)
	test_the_composer_never_assumes_it_has_focus(t)
	test_the_model_control_names_a_model_the_catalogue_does_not_describe(t)


## A composer holding `text`, with the caret at the end of it, which is where a
## user who has just finished typing leaves it.
func _composer(text: String) -> PromptPanel:
	var panel := PromptPanel.new()
	panel._ready()
	panel._input.text = text
	_move_caret_to_end(panel)
	return panel


func _move_caret_to_end(panel: PromptPanel) -> void:
	var last: int = panel._input.get_line_count() - 1
	panel._input.set_caret_line(last)
	panel._input.set_caret_column(panel._input.get_line(last).length())


## The model control must always name the model in use. A session can report a model the
## current catalogue read has not listed, and leaving the pill blank in that case states
## nothing: the user cannot tell whether a model is selected at all.
func test_the_model_control_names_a_model_the_catalogue_does_not_describe(t) -> void:
	var panel := PromptPanel.new()
	panel._ready()
	# A catalogue that does NOT contain the session's model, which is the case that used
	# to render an empty control.
	panel.set_models([{
		"id": "some-other-model", "modelID": "some-other-model",
		"providerID": "other-provider", "name": "Some Other Model",
	}], "anthropic/claude-sonnet-4")
	t.check(
		not panel.pill_text().strip_edges().is_empty(),
		"the model control names the model in use (got '%s')" % panel.pill_text()
	)
	t.check(
		panel.pill_text().contains("claude-sonnet-4"),
		"and names it from the reference the session actually reported"
	)
	# A catalogue that DOES describe it still wins, so the friendly name is preferred.
	panel.set_models([{
		"id": "claude-sonnet-4", "modelID": "claude-sonnet-4",
		"providerID": "anthropic", "name": "Claude Sonnet 4",
	}], "anthropic/claude-sonnet-4")
	t.check(
		panel.pill_text().contains("Claude Sonnet 4"),
		"a described model is named by its catalogue label"
	)
	panel.free()


## Every submission the composer reports, in order.
func _watching(panel: PromptPanel) -> Array:
	var seen: Array = []
	panel.prompt_submitted.connect(func(text: String): seen.append(text))
	return seen


## A synthetic key press, Return unless another key is named. Ctrl and the command
## key are separate flags in Godot, so a test names the modifier it means rather
## than a combined mask.
func _key_press(modifiers: Array = [], keycode: Key = KEY_ENTER) -> InputEventKey:
	var event := InputEventKey.new()
	event.keycode = keycode
	event.physical_keycode = keycode
	event.pressed = true
	event.shift_pressed = modifiers.has("shift")
	event.ctrl_pressed = modifiers.has("ctrl")
	event.alt_pressed = modifiers.has("alt")
	event.meta_pressed = modifiers.has("cmd")
	return event


## AC1, AC6. A bare Return submits, and the draft stays where the user left it,
## because a submission the service refuses must not cost the text.
func test_a_bare_return_submits_the_draft(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	panel._on_input_event(_key_press())
	t.check(seen == ["hello"], "a bare Return submits the draft")
	t.check(panel.current_text() == "hello", "and the draft survives the submission")
	t.check(
		panel._input.get_line_count() == 1,
		"submitting does not also break the line the user submitted"
	)
	panel.free()


## AC5. The host is handed the trimmed text, and only the trimmed text.
func test_a_submission_reports_the_trimmed_text_and_keeps_the_draft(t) -> void:
	var panel := _composer("  hello  \n  ")
	var seen := _watching(panel)
	panel._on_input_event(_key_press())
	t.check(seen == ["hello"], "the reported text is trimmed")
	t.check(
		panel.current_text() == "  hello  \n  ",
		"the draft is reported trimmed but kept as typed"
	)
	panel.free()


## AC5. `app/main.gd` connects a one-argument handler, so the signal must keep
## exactly that shape: a `prompt_submitted` carrying one String.
func test_the_submit_signal_is_unchanged_for_the_host(t) -> void:
	var panel := PromptPanel.new()
	t.check(panel.has_signal("prompt_submitted"), "the signal the host connects exists")
	var arguments: Array = []
	for signal_info in panel.get_signal_list():
		if str(signal_info["name"]) == "prompt_submitted":
			arguments = signal_info["args"]
	t.check(arguments.size() == 1, "it carries exactly one argument")
	t.check(
		arguments.size() == 1 and int(arguments[0]["type"]) == TYPE_STRING,
		"and that argument is a String"
	)
	panel._ready()
	panel._input.text = "typed"
	var received: Array = []
	panel.prompt_submitted.connect(func(text: String): received.append(text))
	panel._on_input_event(_key_press())
	t.check(received == ["typed"], "a one-argument handler still receives the text")
	var once: Array = []
	panel.prompt_submitted.connect(func(_text: String): once.append(1))
	panel._on_input_event(_key_press())
	t.check(once.size() == 1, "one press fires the signal exactly once")
	panel.free()


## AC2. Shift+Return breaks the line where the caret is, and does not submit.
func test_shift_return_inserts_a_newline_at_the_caret(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	panel._input.set_caret_column(3)
	panel._on_input_event(_key_press(["shift"]))
	t.check(seen.is_empty(), "Shift+Return does not submit")
	t.check(panel.current_text() == "hel\nlo", "it inserts a newline at the caret")
	t.check(panel._input.get_line_count() == 2, "the caret's line is broken in two")
	t.check(
		panel._input.get_caret_line() == 1 and panel._input.get_caret_column() == 0,
		"the caret follows the inserted break"
	)
	panel.free()


## AC2. The TUI binds Control+Return to a newline; the desktop must agree.
func test_ctrl_return_inserts_a_newline_without_submitting(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	panel._on_input_event(_key_press(["ctrl"]))
	t.check(seen.is_empty(), "Ctrl+Return does not submit")
	t.check(panel.current_text() == "hello\n", "it inserts a newline")
	panel.free()


## AC2. Alt+Return is the third of the TUI's newline bindings.
func test_alt_return_inserts_a_newline_without_submitting(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	panel._on_input_event(_key_press(["alt"]))
	t.check(seen.is_empty(), "Alt+Return does not submit")
	t.check(panel.current_text() == "hello\n", "it inserts a newline")
	panel.free()


## The application already treats Cmd on macOS and Ctrl elsewhere as one shortcut
## modifier, so the command key is the same newline binding as Ctrl and never a
## second submit key.
func test_the_command_modifier_is_the_same_newline_binding(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	panel._on_input_event(_key_press(["cmd"]))
	t.check(seen.is_empty(), "Cmd+Return does not submit")
	t.check(panel.current_text() == "hello\n", "it inserts a newline, like Ctrl+Return")
	panel.free()


## Godot distinguishes the main Return from the keypad Return, and a terminal's
## `return` is one key. Both submit.
func test_both_return_keys_submit(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	panel._on_input_event(_key_press([], KEY_KP_ENTER))
	t.check(seen == ["hello"], "the keypad Return submits like the main one")
	panel.free()


## AC3. Whitespace is not a prompt, and it must not stay silent by submitting an
## empty string either.
func test_whitespace_only_input_never_submits(t) -> void:
	var panel := _composer("   \n\t  ")
	var seen := _watching(panel)
	panel._on_input_event(_key_press())
	t.check(seen.is_empty(), "whitespace-only input never submits")
	t.check(
		panel.current_text() == "   \n\t  ",
		"and the whitespace is left exactly as the user typed it"
	)
	panel.free()


## AC3. An empty composer has nothing to submit, so a Return adds no stray blank
## line to an empty draft either.
func test_return_on_an_empty_composer_does_not_submit(t) -> void:
	var panel := _composer("")
	var seen := _watching(panel)
	panel._on_input_event(_key_press())
	t.check(seen.is_empty(), "an empty composer never submits")
	t.check(
		panel.current_text() == "" and panel._input.get_line_count() == 1,
		"and a Return on an empty draft does not open a blank line"
	)
	panel.free()


## A held key repeats. Submitting the surviving draft once per repeat would admit
## the same prompt several times, so a repeat is consumed and ignored.
func test_a_held_return_does_not_resubmit(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	var repeat := _key_press()
	repeat.echo = true
	panel._on_input_event(repeat)
	t.check(seen.is_empty(), "a repeated Return does not submit again")
	var newline_repeat := _key_press(["shift"])
	newline_repeat.echo = true
	panel._on_input_event(newline_repeat)
	t.check(
		panel.current_text() == "hello",
		"and a repeated Shift+Return does not insert a newline either"
	)
	panel.free()


## Only a press is a submission. Releasing Return is not.
func test_a_return_release_does_not_submit(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	var release := _key_press()
	release.pressed = false
	panel._on_input_event(release)
	t.check(seen.is_empty(), "releasing Return does not submit")
	panel.free()


## Typing wins: nothing but Return is the composer's business, and no other key
## may turn into a submission.
func test_no_other_input_submits(t) -> void:
	var panel := _composer("hello")
	var seen := _watching(panel)
	var ctrl_j := _key_press(["ctrl"], KEY_J)
	panel._on_input_event(ctrl_j)
	var letter := _key_press([], KEY_A)
	panel._on_input_event(letter)
	panel._on_input_event(InputEventMouseButton.new())
	t.check(seen.is_empty(), "no key but Return submits")
	t.check(panel.current_text() == "hello", "and the text is untouched")
	panel.free()


## AC4. An active input-method composition is never a submission. Godot exposes
## the editor's composition state and nothing sets it on a headless run, so this
## pins the engine surface the guard reads rather than a synthesised composition.
func test_the_editor_exposes_the_composition_state_the_guard_reads(t) -> void:
	t.check(
		ClassDB.class_has_method("TextEdit", "has_ime_text", true),
		"the editor reports whether a composition is in progress"
	)
	var editor := TextEdit.new()
	t.check(
		not editor.has_ime_text(),
		"and reports no composition for a plain editor"
	)
	editor.free()


## AC7. Submitting changes nothing about what the controls claim: the send control
## stays able to send and says what sending does, the unsupported approval control
## stays disabled with its reason, and the composer reports no outcome of its own.
func test_a_submission_leaves_the_controls_coherent(t) -> void:
	var panel := _composer("hello")
	# The host puts the composer in its mode on start, which is what gives the send
	# control its sentence.
	panel.set_mode(OfficeStore.MODE_DEMO)
	var seen := _watching(panel)
	panel._on_input_event(_key_press())
	t.check(seen == ["hello"], "the draft is submitted")
	t.check(not panel._send.disabled, "the send control is still able to send")
	t.check(not panel._send.tooltip_text.is_empty(), "and it still says what it sends")
	t.check(panel._approval.disabled, "the unsupported approval control stays disabled")
	t.check(
		not panel._approval.tooltip_text.is_empty(),
		"and it still states why it cannot act"
	)
	t.check(
		panel._notice.text.is_empty(),
		"the composer reports no outcome of its own; the host owns the notice"
	)
	panel.free()


## Stop is unavailable until the host says otherwise, and it says why rather than
## presenting a control that silently swallows a click.
func test_stop_is_disabled_with_its_reason_by_default(t) -> void:
	var panel := _composer("")
	t.check(panel._stop.disabled, "Stop cannot act before the host offers it")
	t.check(
		panel._stop.tooltip_text == PromptPanel.STOP_DISABLED_REASON,
		"and it states the reason it cannot act"
	)
	panel.free()


## The host decides availability from real work state, and the panel follows it.
func test_stop_is_offered_only_when_there_is_work_to_stop(t) -> void:
	var panel := _composer("")
	panel.set_stop_available(true)
	t.check(not panel._stop.disabled, "Stop becomes available when work is running")
	panel.set_stop_available(false, PromptPanel.STOP_DEMO_REASON)
	t.check(panel._stop.disabled, "and goes away again when it is not")
	t.check(
		panel._stop.tooltip_text == PromptPanel.STOP_DEMO_REASON,
		"with the reason the host gave, not a generic one"
	)
	panel.free()


## The panel never performs the stop. Stopping is a service mutation, so the panel
## only asks and the composition root owns the request.
func test_stop_asks_the_host_rather_than_acting_itself(t) -> void:
	var panel := _composer("")
	panel.set_stop_available(true)
	var asked := []
	panel.stop_requested.connect(func(): asked.append(true))
	panel._on_stop()
	t.check(asked.size() == 1, "exactly one stop request reaches the host")
	t.check(panel._input.text == "", "and the composer draft is untouched")
	panel.free()


## R2-03 "focus without masking workspace": the composer must be able to say
## whether the caret is in it, because a shortcut that only makes sense outside
## text entry checks that instead of assuming. The answer must come from the real
## editor, not from a flag the panel keeps beside it.
func test_focus_is_reported_from_the_real_editor(t) -> void:
	# Attach FIRST and let the engine run the panel's own `_ready`, so the UI is
	# built exactly once and in tree scope. A headless suite runs no frame between
	# a script's `_init` and its assertions, so the tree must be awaited or the
	# controls the panel builds do not exist yet.
	var panel := PromptPanel.new()
	t.root.add_child(panel)
	await t.process_frame
	t.check(panel._input != null, "the composer builds its editor")
	if panel._input == null:
		panel.free()
		return
	_move_caret_to_end(panel)
	# The panel's answer must equal the editor's own, in both directions.
	t.check(
		panel.has_input_focus() == panel._input.has_focus(),
		"the reported focus matches the editor's own state"
	)
	panel.release_input_focus()
	t.check(not panel.has_input_focus(), "a released composer reports no focus")
	t.check(not panel._input.has_focus(), "and the editor itself has no focus")
	panel.free()


## A composer that has never been focused must not claim focus, and the answering
## method must be safe to call before the editor exists rather than crashing a
## shortcut that asks.
func test_the_composer_never_assumes_it_has_focus(t) -> void:
	var panel := PromptPanel.new()
	# Deliberately NOT readied: this is the state a shortcut could ask in.
	t.check(not panel.has_input_focus(), "an unbuilt composer reports no focus")
	# And the guard methods must tolerate being called in that state.
	panel.focus_input()
	panel.release_input_focus()
	t.check(not panel.has_input_focus(), "an unbuilt composer still reports no focus after both calls")
	panel.free()
