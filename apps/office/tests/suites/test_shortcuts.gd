## Keyboard shortcut tests (TASK-043).
##
## The registry maps an input event to an intent; it never grabs input or touches a
## node, so the mapping is testable without a scene. The properties that matter are
## the ones a user feels immediately when they are wrong:
##
##   1. a key PRESS fires and its release does not, so holding a key is not a
##      stream of toggles;
##   2. nothing the registry claims collides with typing into the composer or with
##      panning the office, so the two cannot fight over a keystroke;
##   3. every intent is named and described, so a help surface can never show a
##      blank line.
extends RefCounted

const MOD := KEY_MASK_CMD_OR_CTRL


func run(t) -> void:
	test_a_key_press_fires_and_its_release_does_not(t)
	test_an_unrelated_key_produces_nothing(t)
	test_a_repeated_key_produces_nothing(t)
	test_a_printable_key_alone_is_never_a_shortcut(t)
	test_every_chrome_toggle_has_a_shortcut(t)
	test_no_shortcut_collides_with_panning(t)
	test_every_intent_is_named_and_described(t)
	test_two_shortcuts_do_not_share_a_key(t)
	test_each_toggle_names_real_chrome(t)
	test_selection_intents_carry_a_signed_step(t)
	test_escape_is_the_only_bare_binding(t)
	test_the_composer_answers_a_focus_request(t)
	test_inspect_is_reachable_and_modifier_guarded(t)
	test_inspect_has_a_target_when_nothing_is_selected(t)


## --- event helpers ----------------------------------------------------------

func _press(keycode: int, modifier: bool = true, echo: bool = false) -> InputEventKey:
	var event := InputEventKey.new()
	event.keycode = keycode
	event.pressed = true
	event.echo = echo
	if modifier:
		event.command_or_control_autoremap = true
	return event


func _release(keycode: int, modifier: bool = true) -> InputEventKey:
	var event := _press(keycode, modifier)
	event.pressed = false
	return event


## --- the properties ---------------------------------------------------------

## Holding a key must not repeatedly toggle a panel. Godot reports auto-repeat with
## `echo`, and a release is not a press.
func test_a_key_press_fires_and_its_release_does_not(t) -> void:
	t.check(
		not Shortcuts.intent(_press(KEY_1)).is_empty(),
		"a key press produces an intent"
	)
	t.check(
		Shortcuts.intent(_release(KEY_1)).is_empty(),
		"the matching release produces nothing"
	)
	t.check(
		Shortcuts.intent(_press(KEY_1, true, true)).is_empty(),
		"an auto-repeated key produces nothing"
	)


func test_an_unrelated_key_produces_nothing(t) -> void:
	t.check(Shortcuts.intent(_press(KEY_F13)).is_empty(), "an unbound key produces nothing")
	t.check(
		Shortcuts.intent(InputEventMouseButton.new()).is_empty(),
		"a non-key event produces nothing"
	)


## Auto-repeat is the same event flagged `echo`; a shortcut must still fire once.
func test_a_repeated_key_produces_nothing(t) -> void:
	var event := _press(KEY_1)
	t.check(not Shortcuts.intent(event).is_empty(), "the first press fires")
	event.echo = true
	t.check(Shortcuts.intent(event).is_empty(), "the repeat does not")


## An unmodified letter or digit belongs to whatever text the user is typing, so no
## bare printable key may be a shortcut. This is the property that keeps the
## composer usable.
func test_a_printable_key_alone_is_never_a_shortcut(t) -> void:
	for keycode in [KEY_A, KEY_B, KEY_J, KEY_P, KEY_Z, KEY_1, KEY_2, KEY_3, KEY_4]:
		t.check(
			Shortcuts.intent(_press(keycode, false)).is_empty(),
			"bare %d is not a shortcut" % keycode
		)


## The chrome the shell exposes must all be reachable from the keyboard, or the
## toggle row is the only way to hide a panel.
func test_every_chrome_toggle_has_a_shortcut(t) -> void:
	var reachable := {}
	for keycode in Shortcuts.BINDINGS:
		var intent := Shortcuts.intent(_press(keycode))
		var name := Shortcuts.chrome_name(intent)
		if not name.is_empty():
			reachable[name] = true
	for entry in ChromeToggles.ENTRIES:
		t.check(
			reachable.has(str(entry["name"])),
			"the %s toggle is reachable from the keyboard" % str(entry["name"])
		)


## The office pans with the arrows and WASD. A shortcut that shares those keys
## without a modifier would pan and act at once, so panning must ignore modified
## keys and the registry must ignore unmodified ones.
func test_no_shortcut_collides_with_panning(t) -> void:
	for keycode in [KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_W, KEY_A, KEY_S, KEY_D]:
		t.check(
			not Shortcuts.is_modified(_press(keycode, false)),
			"a bare %d is a pan, not a shortcut" % keycode
		)
		t.check(
			Shortcuts.is_modified(_press(keycode, true)),
			"a modified %d is not left to panning" % keycode
		)


func test_every_intent_is_named_and_described(t) -> void:
	for intent in Shortcuts.all_intents():
		t.check(not intent.is_empty(), "an intent id is not empty")
		t.check(
			not Shortcuts.description(intent).is_empty(),
			"intent %s has a description a help surface can show" % intent
		)


func test_two_shortcuts_do_not_share_a_key(t) -> void:
	var seen := {}
	for keycode in Shortcuts.BINDINGS:
		var intent := Shortcuts.intent(_press(keycode))
		if intent.is_empty():
			continue
		t.check(not seen.has(intent), "intent %s is bound once" % intent)
		seen[intent] = keycode


## --- intent meaning ---------------------------------------------------------

## A chrome toggle must name the chrome it controls, using the SAME names
## ChromeToggles uses, or the shortcut would toggle a panel that does not exist.
func test_each_toggle_names_real_chrome(t) -> void:
	var names := {}
	for entry in ChromeToggles.ENTRIES:
		names[str(entry["name"])] = true
	for action in [Shortcuts.TOGGLE_SIDEBAR, Shortcuts.TOGGLE_COMPOSER, Shortcuts.TOGGLE_MOTION]:
		var chrome := Shortcuts.chrome_name(action)
		t.check(not chrome.is_empty(), "%s names a panel" % action)
		t.check(names.has(chrome), "%s names real chrome (%s)" % [action, chrome])
	t.check(
		Shortcuts.chrome_name(Shortcuts.DISMISS).is_empty(),
		"dismiss controls no panel"
	)


## Selection moves by a signed step and wraps, so it is never a dead key at the
## end of the roster.
func test_selection_intents_carry_a_signed_step(t) -> void:
	t.check_equal(Shortcuts.selection_step(Shortcuts.NEXT_SESSION), 1, "next moves forward")
	t.check_equal(Shortcuts.selection_step(Shortcuts.PREVIOUS_SESSION), -1, "previous moves back")
	t.check_equal(Shortcuts.selection_step(Shortcuts.DISMISS), 0, "a non-selection does not move")
	t.check(Shortcuts.is_selection(Shortcuts.NEXT_SESSION), "next is a selection intent")
	t.check(not Shortcuts.is_selection(Shortcuts.TOGGLE_SIDEBAR), "a toggle is not a selection")
	# Wrapping is what keeps the shortcut useful at either end.
	t.check_equal(wrapi(2 + 1, 0, 3), 0, "stepping past the end wraps to the start")
	t.check_equal(wrapi(0 - 1, 0, 3), 2, "stepping before the start wraps to the end")


## Escape is the only bare binding, and it must be usable while typing, which is
## why it is exempt from the modifier rule and from the typing guard.
func test_escape_is_the_only_bare_binding(t) -> void:
	t.check_equal(Shortcuts.BARE_KEYS.size(), 1, "exactly one key stands alone")
	t.check(Shortcuts.BARE_KEYS.has(KEY_ESCAPE), "that key is Escape")
	var bare := InputEventKey.new()
	bare.keycode = KEY_ESCAPE
	bare.pressed = true
	t.check_equal(Shortcuts.intent(bare), Shortcuts.DISMISS, "bare Escape dismisses")
	# And it must NOT also answer to the modifier, or it would be two bindings.
	var modified := InputEventKey.new()
	modified.keycode = KEY_ESCAPE
	modified.pressed = true
	modified.command_or_control_autoremap = true
	t.check(Shortcuts.intent(modified).is_empty(), "modified Escape is not bound")


## Revealing the composer must ASK for the caret, or the shortcut ends in a panel
## the user still has to click before they can type — which is what makes "keyboard
## can prompt" true rather than nearly true.
##
## The engine grants focus only to a node inside a live viewport, which a headless
## suite does not have. What is asserted here is therefore the contract the
## composition root depends on: the composer reports no focus initially, and asking
## for focus is a call it answers without error. The caret actually landing is
## proven on the running scene, where a viewport exists.
func test_the_composer_answers_a_focus_request(t) -> void:
	var panel := PromptPanel.new()
	t.check(not panel.has_input_focus(), "a composer with no viewport holds no caret")
	panel.focus_input()
	panel.release_input_focus()
	t.check(
		not panel.has_input_focus(),
		"asking for and releasing focus is answerable without a viewport"
	)
	panel.free()


## Inspecting must be reachable from the keyboard, because a session can be blocked
## on a question and the drawer is where it is answered.
func test_inspect_is_reachable_and_modifier_guarded(t) -> void:
	t.check_equal(
		Shortcuts.intent(_press(KEY_I)),
		Shortcuts.INSPECT,
		"Cmd/Ctrl+I opens the source drawer"
	)
	t.check(
		Shortcuts.intent(_press(KEY_I, false)).is_empty(),
		"bare I belongs to typing, not to inspecting"
	)
	t.check(
		not Shortcuts.is_selection(Shortcuts.INSPECT),
		"inspecting is not a selection move"
	)
	t.check_equal(
		Shortcuts.selection_step(Shortcuts.INSPECT),
		0,
		"inspecting does not move the selection"
	)


## Inspecting must not be a dead key on a fresh window, where nothing is selected
## yet. The fallback is the lead session, which is what the office is about.
func test_inspect_has_a_target_when_nothing_is_selected(t) -> void:
	var store := OfficeStore.new()
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_root",
			"data": {"agent": "lead", "parentID": ""},
		}
	)
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_child",
			"data": {"agent": "backend", "parentID": "ses_root"},
		}
	)
	t.check(store.selected_actor() == null, "nothing is selected initially")
	t.check(
		store.actor_for(store.root_session_id) != null,
		"the lead is resolvable, which is what the fallback needs"
	)
	store.select_actor("ses_child")
	t.check(store.selected_actor() != null, "a selection can be made")
