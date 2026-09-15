## Deterministic end-to-end flow check.
##
## Boots the real main scene and drives the demo clock directly. Each advance
## emits fixture events through the scene's real handler, so this exercises the
## production cascade: translator -> store reducer -> director -> world/overlay.
## Deterministic (no wall-clock dependence) and exits nonzero on failure.
##   "$GODOT_BIN" --headless --path apps/office --script res://tools/flow_check.gd
extends SceneTree

const STEP_MS := 500
const TARGET_MS := 60000

var _failures: Array[String] = []
var _checks := 0
var _scene: Node
var _main: OfficeMain
var _elapsed := 0
var _done := false


func _initialize() -> void:
	var packed := load("res://app/main.tscn")
	if packed == null:
		push_error("flow_check: main scene failed to load")
		quit(1)
		return
	_scene = packed.instantiate()
	root.add_child(_scene)


func _process(_delta: float) -> bool:
	if _done:
		return true
	if _main == null:
		_main = _scene as OfficeMain
	# Do not latch `_done` until the scene is actually ready: `demo` is built in
	# `_ready`, so touching it earlier would error on every frame.
	if _main == null or _main.demo == null:
		return false
	_done = true
	_advance()
	_verify()
	for failure in _failures:
		print("  FAIL: %s" % failure)
	print("checks: %d, failures: %d" % [_checks, _failures.size()])
	if _failures.is_empty():
		print("FLOW RESULT: PASSED")
		quit(0)
		return true
	print("FLOW RESULT: FAILED")
	quit(1)
	return true


## Drive the demo clock through the scene's real handler.
func _advance() -> void:
	while _elapsed < TARGET_MS:
		_elapsed += STEP_MS
		_main.demo.advance(STEP_MS)
		if _elapsed % 6000 == 0:
			_main._tick_ambient()


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _verify() -> void:
	var store: OfficeStore = _main.store
	_check(store.mode == OfficeStore.MODE_DEMO, "mode stays DEMO")
	_check(store.root_session_id == "demo-root", "root session identified")
	_check(store.actors.size() >= 3, "multiple scoped actors registered")
	_check(store.interactions.size() >= 3, "source-backed interactions recorded")
	_check(store.last_error.is_empty(), "no transport error surfaced")

	# RQ-09: a reusable agent definition must not collapse two assignments.
	var names: Dictionary = {}
	var distinct := true
	for actor in store.actor_list():
		var key := actor.identity.session_id
		names[key] = actor.identity.display_name
	var seen: Dictionary = {}
	for actor in store.actor_list():
		var label := actor.identity.display_name
		if seen.has(label):
			distinct = false
		seen[label] = true
	_check(distinct, "display names are unique across assignments")

	# Every actor exists in the scene and holds a desk assignment.
	var world: OfficeWorld = _main.office_view.world
	for actor in store.actor_list():
		var session_id: String = actor.identity.session_id
		_check(world.actors.has(session_id), "actor %s has a scene node" % session_id)
		_check(not world.desk_id_for(session_id).is_empty(), "actor %s has a desk" % session_id)

	# Truthfulness: only a real terminal fact may claim success, and DEMO never
	# becomes LIVE.
	for actor in store.actor_list():
		if actor.settled_status == "succeeded":
			_check(
				store.mode == OfficeStore.MODE_DEMO,
				"a settled success only occurs inside synthetic DEMO"
			)
	_check(
		store.connection_state != OfficeStore.CONNECTION_LIVE
		or store.mode != OfficeStore.MODE_LIVE,
		"demo never silently becomes LIVE"
	)
	_check(_main.demo != null, "demo transport is the active transport")
