## Diagnose boot order: when does `_ready` start demo, and why did a headless probe
## see an empty office?
extends SceneTree

var _scene: Node
var _frame := 0


func _initialize() -> void:
	print("probe: initialize begin")
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("probe: after add_child demo=", _scene.demo,
		" playing=", _scene.demo.is_playing() if _scene.demo != null else "n/a",
		" mode=", _scene.store.mode if _scene.store != null else "n/a",
		" actors=", _scene.store.actors.size() if _scene.store != null else "n/a",
		" err=", _scene.store.last_error if _scene.store != null else "n/a")


func _process(_d: float) -> bool:
	_frame += 1
	print("probe: frame %d playing=%s mode=%s actors=%d err='%s'" % [
		_frame,
		_scene.demo.is_playing() if _scene.demo != null else "n/a",
		_scene.store.mode if _scene.store != null else "n/a",
		_scene.store.actors.size() if _scene.store != null else -1,
		_scene.store.last_error if _scene.store != null else "n/a",
	])
	if _frame >= 3:
		quit(0)
		return true
	return false
