## Replicates capture_effort.gd's exact flow via the shared helper and reports the
## office state, so AC2 is evidenced for that tool and the prompt_panel SCRIPT
## ERROR can be attributed.
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

var _scene: Node
var _stage := 0


func _initialize() -> void:
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)


func _process(_d: float) -> bool:
	if _stage == 0:
		if not DemoCapture.started(_scene):
			return false
		# EVIDENCE: show that the guard is a no-op here. Post-G the boot is LIVE,
		# so the helper is the ONLY thing that starts demo. Before calling it the
		# mode was LIVE; record that, then the model state that triggers the error.
		print("probe: after helper mode=%s playing=%s models=%d model_ref='%s'" % [
			_scene.store.mode, _scene.demo.is_playing(),
			_scene.prompt_panel._models.size(), _scene.prompt_panel.model_ref()])
		_stage = 1
		return false
	if _stage == 1:
		_scene.prompt_panel._open_effort()
		_stage = 2
		return false
	print("probe: actors=%d interactions=%d effort_visible=%s" % [
		_scene.store.actors.size(), _scene.store.interactions.size(),
		_scene.prompt_panel._effort.visible if _scene.prompt_panel._effort != null else "null"])
	quit(0)
	return true
