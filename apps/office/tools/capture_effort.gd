## Capture the composer with its effort card open.
##
## The effort card is only visible while the user is choosing, so a normal boot
## capture never shows it. This opens it deliberately and shoots the frame.
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

var _scene: Node
var _stage := 0
var _out := "user://effort.png"


func _initialize() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--out="):
			_out = argument.substr("--out=".length())
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)


func _process(_delta: float) -> bool:
	# Opt in explicitly: production boot no longer has to imply DEMO.
	if not DemoCapture.started(_scene):
		return false
	_stage += 1
	if _stage == 3:
		# Open the real card through the real control, so the frame shows what the
		# user would actually see.
		_scene.prompt_panel._open_effort()
		return false
	if _stage < 5:
		return false
	var image := root.get_texture().get_image()
	var code := image.save_png(_out)
	print("effort capture: wrote %s (code %d)" % [_out, code])
	quit(0 if code == OK else 1)
	return true
