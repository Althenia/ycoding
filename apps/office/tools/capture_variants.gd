## Capture the interface in the states TASK-043 requires: light panels and a 200%
## text scale, so "without hiding runtime state" can be checked by eye.
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")
const STEP_MS := 16
var _scene: Node
var _elapsed := 0
var _stage := 0
var _out := ""
func _initialize() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--out="):
			_out = argument.substr(6)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
func _process(_d: float) -> bool:
	if _stage == 0:
		if not DemoCapture.started(_scene):
			return false
		while _elapsed < 40000:
			_elapsed += STEP_MS
			_scene.demo.advance(STEP_MS)
			if _elapsed % 6000 == 0:
				_scene._tick_ambient()
		# Light panels at the stated 200% scale, applied through the real path.
		_scene._apply_shortcut(Shortcuts.TOGGLE_THEME)
		_scene._cycle_scale(2.0)
		print("mode=", OfficeTheme.mode(), " scale=", _scene.ui_scale)
		var shell_sz: Vector2 = _scene._shell.size
		var sb = _scene.sidebar
		var cp = _scene.prompt_panel
		print("AT CAPTURE shell=", shell_sz, " sidebar_right=", sb.position.x + sb.size.x, " composer_left=", cp.position.x, " overlap=", cp.position.x < sb.position.x + sb.size.x)
		print("AT CAPTURE global: sidebar=", sb.get_global_rect(), " composer=", cp.get_global_rect())
		print("AT CAPTURE window=", DisplayServer.window_get_size(), " factor=", get_root().content_scale_factor)
		_stage = 1
		return false
	if _stage == 1:
		_scene._process(0.016)
		_stage = 2
		return false
	var image := root.get_texture().get_image()
	if image == null or image.get_width() == 0:
		print("capture: no viewport image")
		quit(1)
		return true
	var absolute := _out if _out.is_absolute_path() else ProjectSettings.globalize_path(_out)
	image.save_png(absolute)
	print("capture: wrote %s (%dx%d)" % [absolute, image.get_width(), image.get_height()])
	quit(0)
	return true
