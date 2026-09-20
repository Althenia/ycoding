## Capture the office mid-report.
##
## A finished child walks to the lead's office, so this captures the walk partway
## across the floor rather than the instant it starts. Follows the same two-stage
## shape as capture_scene.gd: advance the production handlers, then present.
extends SceneTree
const DemoCapture := preload("res://tools/demo_capture.gd")
const STEP_MS := 16
var _scene: Node
var _stage := 0
var _elapsed := 0
var _out := "user://report_capture.png"
func _initialize() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--out="):
			_out = argument.substr(6)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
func _process(_delta: float) -> bool:
	if _stage == 0:
		# Opt in explicitly: production boot no longer has to imply DEMO.
		if not DemoCapture.started(_scene):
			return false
		while _elapsed < 40000:
			_elapsed += STEP_MS
			_scene.demo.advance(STEP_MS)
			if _elapsed % 6000 == 0:
				_scene._tick_ambient()
		var world = _scene.office_view.world
		for key in world.actors:
			if key == "demo-root":
				continue
			_scene._on_event({
				"type": "session.task.updated",
				"sessionID": key,
				"data": {"change": {"type": "completed", "excerpt": "Report for the lead"}},
				"sourceEpoch": "e",
			})
			print("report capture: sent ", key, " to report")
			break
		_stage = 1
		return false
	if _stage == 1:
		# Let the walk progress so the capture shows it in motion.
		for step in 120:
			_scene._process(0.032)
		_stage = 2
		return false
	var image := root.get_texture().get_image()
	var absolute := _out if _out.is_absolute_path() else ProjectSettings.globalize_path(_out)
	var error := image.save_png(absolute)
	if error != OK:
		push_error("report capture: failed to write %s (error %d)" % [absolute, error])
		quit(1)
		return true
	print("report capture: wrote %s (%dx%d)" % [absolute, image.get_width(), image.get_height()])
	quit(0)
	return true
