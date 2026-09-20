## R5-03 native capture: the composer naming the project a prompt would reach.
##
## Drives the REAL `res://app/main.tscn` scene and enters DEMO so the office and the
## rail are fully built, then hands the store two sessions that report REAL folders
## and their own models - the shape the service sends. Selecting one project must
## move the composer's name AND its model to that project.
##
## The printed state is read back from the panels, not from the values the driver
## wrote, so the image and the state it shows are bound together rather than left for
## a reader to infer.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r5_03_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SETTLE_FRAMES := 4
const ALPHA_DIR := "/tmp/r5-03-alpha"
const BETA_DIR := "/tmp/r5-03-beta"

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _settle := 0
var _step := 0
var _done := false


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r5-03"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R503 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done:
		return true
	if _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R503 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R503 blocked: demo never started")
			quit(2)
			return true
		return false

	_waited += 1
	if _waited < 5:
		return false

	if _settle > 0:
		_settle -= 1
		if _settle == 0:
			_run_step()
		return false
	_advance()
	return false


func _advance() -> void:
	if _step >= _steps().size():
		_done = true
		print("R503 done")
		if _scene.live != null:
			_scene.live.stop()
		quit(0)
		return
	var step: Dictionary = _steps()[_step]
	_step += 1
	if step["action"] == "seed":
		_seed()
	elif step["action"] == "select":
		_scene.store.select_actor(str(step["session"]))
		_scene._refresh_ui()
	_settle = SETTLE_FRAMES


func _steps() -> Array:
	return [
		{"action": "seed"},
		{"action": "select", "session": "ses_r503_alpha"},
		{"action": "select", "session": "ses_r503_beta"},
	]


## Two projects, each reporting its own real folder and its own model.
func _seed() -> void:
	DirAccess.make_dir_recursive_absolute(ALPHA_DIR)
	DirAccess.make_dir_recursive_absolute(BETA_DIR)
	_project("ses_r503_alpha", ALPHA_DIR, "Alpha project", "openrouter", "deepseek/deepseek-v4.1-flash")
	_project("ses_r503_beta", BETA_DIR, "Beta project", "anthropic", "claude-sonnet-4")
	# Refresh once so the composer reflects the seeded office before anything is
	# selected; reading it earlier would read the boot state, which is not the
	# behavior under test.
	_scene._refresh_ui()
	print("R503 seeded projects: ", ALPHA_DIR, " and ", BETA_DIR)


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


## Read the state back out of the panels, so what is reported is what is shown.
func _run_step() -> void:
	var panel = _scene.prompt_panel
	var target: String = _scene._prompt_target()
	print("R503 target='%s' composer_name='%s' model_pill='%s'" % [
		target, panel.target_text(), panel.pill_text(),
	])
	# What the store holds and what the rail actually drew, so the image and the
	# state cannot be read as disagreeing.
	var ids: Array[String] = []
	for actor in _scene.store.actor_list():
		ids.append("%s(%s)" % [actor.identity.session_id, actor.identity.display_name])
	print("R503 store actors=", ids)
	var rows: Array = _scene.sidebar._sessions_box.get_children()
	for row in rows:
		var label := ""
		for node in (row as Node).get_children():
			if node is Label:
				label += (node as Label).text + " "
		print("R503 rail session row='%s'" % label.strip_edges())
	_measure()
	_capture()


## Whether the name the composer shows is actually INSIDE the window. A target the
## user cannot see is not a target that was shown, so this is measured rather than
## left to the eye.
func _measure() -> void:
	var panel = _scene.prompt_panel
	var window := Vector2(root.size)
	var panel_rect := Rect2(panel.global_position, panel.size)
	var label = panel._target_label
	if label == null:
		print("R503 measure: no target label")
		return
	var label_rect := Rect2(label.global_position, label.size)
	print("R503 measure window=%s composer=%s target_label=%s" % [
		str(window), str(panel_rect), str(label_rect),
	])
	print("R503 measure label_above_bottom=%s label_inside=%s" % [
		str(label_rect.end.y <= window.y + 0.5),
		str(window.x >= label_rect.end.x and window.y >= label_rect.end.y),
	])


func _capture() -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R503 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R503 no image to capture")
		quit(1)
		return
	var target: String = _scene._prompt_target()
	var owner := target if not target.is_empty() else "none"
	var path := "%s/r5-03-composer-%s.png" % [_outdir, owner]
	image.save_png(path)
	print("R503 captured ", path)
