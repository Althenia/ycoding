## R5-04 native capture: a late answer for the project the user LEFT.
##
## Drives the REAL `res://app/main.tscn` scene, so the panels, layout and composer are
## the production ones. The one doubled thing is the SOCKET: a recording transport takes
## the place of the side transport, because a race between two answers cannot be produced
## against a service that answers on demand - the driver has to decide which answer
## arrives when, and that is exactly the thing under test.
##
## Sequence, all in the real scene:
##   1. choose project ALPHA  -> a catalogue read is issued, scoped to ALPHA
##   2. choose project BETA   -> a second read is issued, scoped to BETA
##   3. ALPHA answers LAST    -> its answer must not become the catalogue on offer
##   4. BETA answers          -> that one is installed
##
## Every step prints what the transport was asked for, what was delivered, and what the
## composer shows, so the image and the state it proves are bound together in the log.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r5_04_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SETTLE_FRAMES := 4
const ALPHA_DIR := "/tmp/r5-04-alpha"
const BETA_DIR := "/tmp/r5-04-beta"


## Records what it was asked for and delivers only what the driver hands it, so an answer
## for a project the user has already left can be delivered after the switch.
class RecordingTransport extends "res://integration/http_transport.gd":
	var requests: Array = []
	var cancelled: Array = []
	var _location := ""
	var _settled: Array = []

	func set_location(directory: String, workspace_id: String = "") -> void:
		_location = directory
		workspace_id = workspace_id

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({"method": method, "path": path, "location": _location})
		return requests.size()

	func poll(budget_ms: int = 4) -> Array[Dictionary]:
		budget_ms = budget_ms
		var entries: Array[Dictionary] = []
		entries.assign(_settled)
		_settled.clear()
		return entries

	func cancel(request_id: int) -> void:
		cancelled.append(request_id)

	func deliver(request_id: int, models: Array) -> void:
		_settled.append({
			"request_id": request_id, "kind": "response", "status": 200,
			"body": {"data": models}, "event": {}, "error": "",
		})


var _outdir := ""
var _scene: Node = null
var _held: RecordingTransport = null
var _waited := 0
var _settle := 0
var _step := 0
var _done := false
var _alpha_read := 0
var _beta_read := 0


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r5-04"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R504 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R504 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R504 blocked: demo never started")
			quit(2)
			return true
		return false
	_waited += 1
	if _waited < 5:
		return false
	if _settle > 0:
		# The step has already run; this only lets the renderer and the layout catch up
		# before the next one, which is what makes each capture show its own state.
		_settle -= 1
		return false
	_advance()
	return false


func _advance() -> void:
	if _step >= _steps().size():
		_finish()
		return
	var step: Dictionary = _steps()[_step]
	_step += 1
	if step.has("call"):
		callv(str(step["call"]), step.get("args", []))
	_settle = SETTLE_FRAMES


func _steps() -> Array:
	return [
		{"call": "_install"},
		{"call": "_choose_alpha"},
		{"call": "_choose_beta"},
		{"call": "_deliver_alpha_late"},
		{"call": "_deliver_beta"},
		{"call": "_capture"},
	]


## Take over the compose root's socket, so the driver decides when each answer lands.
func _install() -> void:
	DirAccess.make_dir_recursive_absolute(ALPHA_DIR)
	DirAccess.make_dir_recursive_absolute(BETA_DIR)
	_held = RecordingTransport.new()
	_scene._side = _held
	_scene.models_api.configure(_held)
	# The scene boots into synthetic playback. The model route is a LIVE route, so the
	# office is put in the mode `start_live` itself sets before a read can be scoped -
	# this is the one state the driver sets rather than reaching through a real service.
	_scene.store.mode = OfficeStore.MODE_LIVE
	_scene.prompt_panel.set_mode(OfficeStore.MODE_LIVE)
	# Two sessions, one per project, so the composer has a target to name on each side.
	_project("ses_r504_alpha", ALPHA_DIR, "Alpha project", "openrouter", "deepseek/deepseek-v4.1-flash")
	_project("ses_r504_beta", BETA_DIR, "Beta project", "anthropic", "claude-sonnet-4")
	print("R504 installed; two real folders: ", ALPHA_DIR, " ", BETA_DIR)


func _project(
	session_id: String, directory: String, title: String, provider: String, id: String
) -> void:
	_scene.store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": session_id,
		"data": {
			"agent": "lead",
			"title": title,
			"location": {"directory": directory},
			"model": {"providerID": provider, "id": id},
		},
		"sourceEpoch": "epoch-capture",
	})


func _choose_alpha() -> void:
	_scene.select_folder(ALPHA_DIR)
	_alpha_read = _held.requests.size()
	print("R504 chose ALPHA; reads=%d last_location=%s" % [
		_alpha_read, _last_location(),
	])


func _choose_beta() -> void:
	_scene.select_folder(BETA_DIR)
	_beta_read = _held.requests.size()
	print("R504 chose BETA; reads=%d last_location=%s cancelled_first=%s" % [
		_beta_read, _last_location(), str(_held.cancelled.has(_alpha_read)),
	])
	print("R504 pending=%s pill='%s' target='%s'" % [
		str(_scene.models_api.is_pending()), _scene.prompt_panel.pill_text(),
		_scene.prompt_panel.target_text(),
	])


## The project the user LEFT answers after the switch. Admitting it would offer another
## project's models.
func _deliver_alpha_late() -> void:
	_held.deliver(_alpha_read, _models_for("alpha-only-model", "alpha-provider"))
	_scene._settle_models()
	var offered: Array[String] = []
	for entry in _scene._service_models:
		offered.append(str(entry.get("id", "")))
	print("R504 ALPHA answered LATE; offered=%s pill='%s'" % [
		str(offered), _scene.prompt_panel.pill_text(),
	])
	print("R504 late_answer_admitted=%s" % str(offered.has("alpha-only-model")))


func _deliver_beta() -> void:
	_held.deliver(_beta_read, _models_for("beta-only-model", "beta-provider"))
	_scene._settle_models()
	var offered: Array[String] = []
	for entry in _scene._service_models:
		offered.append(str(entry.get("id", "")))
	print("R504 BETA answered; offered=%s pill='%s'" % [
		str(offered), _scene.prompt_panel.pill_text(),
	])
	_scene.store.select_actor("ses_r504_beta")
	_scene._refresh_ui()
	print("R504 composer target='%s' model_ref='%s'" % [
		_scene.prompt_panel.target_text(), _scene.prompt_panel.model_ref(),
	])


func _models_for(id: String, provider: String) -> Array:
	return [{
		"id": id, "modelID": id, "providerID": provider, "name": id,
		"variants": [], "status": "active", "enabled": true,
	}]


func _last_location() -> String:
	if _held.requests.is_empty():
		return ""
	return str(_held.requests[_held.requests.size() - 1].get("location", ""))


func _capture() -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R504 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R504 no image to capture")
		quit(1)
		return
	var path := "%s/r5-04-after-switch.png" % _outdir
	image.save_png(path)
	print("R504 captured ", path)


func _finish() -> void:
	_done = true
	print("R504 done")
	if _scene.live != null:
		_scene.live.stop()
	quit(0)
