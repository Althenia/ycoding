## Proves the SCRIPT ERROR seen in capture_effort.gd is independent of the lane-K
## guard: replicates the TOOL's pre-change frame sequence exactly (no guard), and
## reports the demo state at frame 0.
extends SceneTree

var _scene: Node
var _stage := 0
var _reported := false


func _initialize() -> void:
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)


func _process(_d: float) -> bool:
	if not _reported:
		_reported = true
		print("probe: frame0 demo.is_playing=", _scene.demo.is_playing() if _scene.demo != null else "null")
	_stage += 1
	if _stage == 3:
		print("probe: model_ref='%s' models=%d" % [
			_scene.prompt_panel.model_ref(), _scene.prompt_panel._models.size()])
		_scene.prompt_panel._open_effort()
		return false
	if _stage < 5:
		return false
	print("probe: actors=%d interactions=%d" % [
		_scene.store.actors.size(), _scene.store.interactions.size()])
	quit(0)
	return true
