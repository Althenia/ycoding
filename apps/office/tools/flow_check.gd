## Deterministic end-to-end flow check.
##
## Boots the real main scene and drives the demo clock directly. Each advance
## emits fixture events through the scene's real handler, so this exercises the
## production cascade: translator -> store reducer -> director -> world/overlay.
## Deterministic (no wall-clock dependence) and exits nonzero on failure.
##
## It also proves the PRODUCTION BOOT contract, which is why discovery is pointed
## at a path that exists nowhere: the booted scene must attach to nothing and
## fabricate nothing, and synthetic playback must be reachable only through the
## explicit demo action this check then takes.
##   "$GODOT_BIN" --headless --path apps/office --script res://tools/flow_check.gd
extends SceneTree

const STEP_MS := 500
const TARGET_MS := 60000

## A path that exists nowhere, used only when the caller supplied no registration.
const MISSING_SERVICE_FILE := "/nonexistent-ycoding-office-flow-check"

var _failures: Array[String] = []
var _checks := 0
var _scene: Node
var _main: OfficeMain
var _elapsed := 0
var _done := false
var _previous_environment: Dictionary = {}
## Whether the caller supplied a registration. Default behavior is the
## no-service launch; pointing `YCODING_SERVICE_FILE` at a real registration makes
## the same check prove the attach path instead.
var _expects_attach := false


func _initialize() -> void:
	# Point discovery away from any real registration BEFORE the scene is added,
	# because the boot decision runs in `_ready`. A caller-supplied registration is
	# honoured, which is how this check proves the attach path against a live
	# service without a second script.
	var supplied := OS.get_environment("YCODING_SERVICE_FILE")
	_expects_attach = not supplied.strip_edges().is_empty()
	for name in ["YCODING_SERVICE_FILE", "XDG_STATE_HOME", "HOME"]:
		_previous_environment[name] = OS.get_environment(name)
		if name == "YCODING_SERVICE_FILE" and _expects_attach:
			continue
		OS.set_environment(name, MISSING_SERVICE_FILE)
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
	_verify_production_boot()
	# Synthetic playback is entered the way a user enters it, not by the boot.
	_main.start_demo_mode()
	_advance()
	_verify()
	for name in _previous_environment:
		OS.set_environment(str(name), str(_previous_environment[name]))
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


## The production boot, on the real scene.
##
## A launch must never present synthetic work or synthetic data as if it came from
## the runtime, so this runs BEFORE the explicit demo action below.
func _verify_production_boot() -> void:
	var store: OfficeStore = _main.store
	_check(store.mode != OfficeStore.MODE_DEMO, "the boot did not enter DEMO")
	_check(store.mode == OfficeStore.MODE_LIVE, "the boot takes the live path")
	_check(store.actors.is_empty(), "the boot fabricates no actor")
	_check(store.interactions.is_empty(), "the boot fabricates no history")
	_check(store.root_session_id.is_empty(), "the boot adopts no synthetic root session")
	_check(not _main.demo.is_playing(), "the boot starts no synthetic playback")
	_check(
		not ModelCatalog.is_demo_catalog(_main.prompt_panel._models),
		"the boot installs no synthetic model catalogue"
	)
	if _expects_attach:
		# A real registration was supplied, so the same check proves the attach.
		_check(_main.live.is_playing(), "a registered service is attached with no user action")
		_check(
			_main.live.base_url() == _registered_url(),
			"the attach used the registered address"
		)
		_check(
			store.last_error.find("service.json") == -1,
			"no missing-registration message is shown when one was found"
		)
		return
	_check(
		store.connection_state == OfficeStore.CONNECTION_DISCONNECTED,
		"the missing service is stated as a disconnection"
	)
	_check(not store.last_error.is_empty(), "the disconnected office says why")
	_check(
		store.last_error.find("service.json") != -1,
		"it names the registration that was not found"
	)
	_check(
		store.last_error.find("ycoding service start") != -1,
		"and names the command that fixes it"
	)
	_check(_main.sidebar.retry_available(), "and offers a reachable retry")
	_check(
		_main.sidebar._detail_label.text == store.last_error,
		"the rail shows the same message the office recorded"
	)


## The address the supplied registration carries, read back from the file the
## caller pointed discovery at. Used only to prove the attach used it.
func _registered_url() -> String:
	var parsed: Variant = JSON.parse_string(
		FileAccess.get_file_as_string(OS.get_environment("YCODING_SERVICE_FILE"))
	)
	if parsed is Dictionary:
		return str((parsed as Dictionary).get("url", ""))
	return ""


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
	_check(store.mode == OfficeStore.MODE_DEMO, "the explicit demo action entered DEMO")
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
	# The synthetic catalogue is offered in DEMO, and it is identified as synthetic
	# wherever it renders, which is what keeps the preview honest.
	_check(
		ModelCatalog.is_demo_catalog(_main.prompt_panel._models),
		"the synthetic model catalogue is in play and identified as synthetic"
	)
	_check(
		_main.prompt_panel.pill_text().find("demo list") != -1,
		"the composer labels the synthetic list as such"
	)
	_check(not _main.sidebar.retry_available(), "a synthetic office offers no connection retry")
