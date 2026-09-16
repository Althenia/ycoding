## Keyboard shortcuts.
##
## A pure mapping from an input event to an intent. It never grabs input and never
## touches a node, so the keymap is testable without a scene and the composition
## root stays the only place that decides what an intent does.
##
## Two constraints shape the map, and both come from keys the app already uses:
##
##   * The office pans with the arrows and WASD. Every shortcut therefore carries a
##     modifier, and `is_modified` is what lets the viewport ignore a modified key
##     instead of panning while a panel also toggles.
##   * The composer is a text editor. No bare printable key may be a shortcut, and
##     Escape must be safe to press while typing.
##
## Alt is deliberately avoided: on macOS it composes characters, so a shortcut on a
## bare Alt key would fight text entry.
class_name Shortcuts
extends RefCounted

## The modifier every non-Escape shortcut requires. Godot maps Cmd on macOS and
## Ctrl elsewhere to the same flag, so one binding serves both.
const MOD := KEY_MASK_CMD_OR_CTRL

## Sidebar, composer and motion, matching ChromeToggles' own names.
const TOGGLE_SIDEBAR := "toggle_sidebar"
const TOGGLE_COMPOSER := "toggle_composer"
const TOGGLE_MOTION := "toggle_motion"

const NEXT_SESSION := "next_session"
const PREVIOUS_SESSION := "previous_session"

## Open the source drawer for the current selection, which is how a user inspects
## an assignment and answers anything it is blocked on.
const INSPECT := "inspect"

## Cycle the palette mode, and the text scale.
const TOGGLE_THEME := "toggle_theme"
const TOGGLE_SCALE := "toggle_scale"

## Escape is the one unmodified binding: it closes or releases what is open, which
## is safe while typing because it never inserts text.
const DISMISS := "dismiss"

## Every intent, with the description a help surface shows. A binding that is not
## listed here is not a binding.
const BINDINGS := {
	KEY_1: TOGGLE_SIDEBAR,
	KEY_2: TOGGLE_COMPOSER,
	KEY_3: TOGGLE_MOTION,
	KEY_DOWN: NEXT_SESSION,
	KEY_UP: PREVIOUS_SESSION,
	KEY_I: INSPECT,
	KEY_T: TOGGLE_THEME,
	KEY_EQUAL: TOGGLE_SCALE,
	KEY_ESCAPE: DISMISS,
}

const DESCRIPTIONS := {
	TOGGLE_SIDEBAR: "Show or hide the sidebar",
	TOGGLE_COMPOSER: "Show or hide the prompt composer",
	TOGGLE_MOTION: "Reduce motion",
	NEXT_SESSION: "Select the next session",
	PREVIOUS_SESSION: "Select the previous session",
	INSPECT: "Open the source drawer for the selection",
	TOGGLE_THEME: "Switch between the light and dark panels",
	TOGGLE_SCALE: "Enlarge the interface text",
	DISMISS: "Close the open drawer or leave the composer",
}


## Keys that stand alone, without the modifier.
const BARE_KEYS := [KEY_ESCAPE]


## The intent an event asks for, or "" when it asks for nothing.
##
## Only a press fires, so holding a key is not a stream of toggles, and an
## auto-repeat is refused for the same reason.
static func intent(event: InputEvent) -> String:
	if not (event is InputEventKey):
		return ""
	var key := event as InputEventKey
	if not key.pressed or key.echo:
		return ""
	var bound: Variant = BINDINGS.get(key.keycode, "")
	if bound == "":
		return ""
	var action := str(bound)
	# A bare key is only valid for the keys that are declared safe to stand alone.
	if BARE_KEYS.has(key.keycode):
		return "" if is_modified(key) else action
	return action if is_modified(key) else ""


## Whether the event carries the shortcut modifier.
##
## The viewport shares this, so panning and shortcuts can never both act on one
## keystroke: a modified key is a shortcut's, an unmodified one is panning's.
static func is_modified(event: InputEvent) -> bool:
	if not (event is InputEventKey):
		return false
	var key := event as InputEventKey
	return key.command_or_control_autoremap or (key.get_modifiers_mask() & MOD) != 0


## The chrome a toggle intent controls, or "" when the intent toggles nothing.
static func chrome_name(action: String) -> String:
	match action:
		TOGGLE_SIDEBAR:
			return "sidebar"
		TOGGLE_COMPOSER:
			return "composer"
		TOGGLE_MOTION:
			return "motion"
	return ""


## Whether this intent moves the selection.
static func is_selection(action: String) -> bool:
	return action == NEXT_SESSION or action == PREVIOUS_SESSION


## The step a selection intent moves by: +1 forward, -1 back, 0 otherwise.
static func selection_step(action: String) -> int:
	if action == NEXT_SESSION:
		return 1
	if action == PREVIOUS_SESSION:
		return -1
	return 0


static func description(action: String) -> String:
	return str(DESCRIPTIONS.get(action, ""))


## Every intent the registry can produce.
static func all_intents() -> Array[String]:
	var out: Array[String] = []
	for keycode in BINDINGS:
		var action := str(BINDINGS[keycode])
		if not out.has(action):
			out.append(action)
	return out
