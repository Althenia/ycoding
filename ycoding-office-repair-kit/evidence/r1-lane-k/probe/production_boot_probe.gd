## AC3/AC4: a production launch is `res://app/main.tscn` with no tool script. This
## instantiates the same scene the app boots and never opts into demo, then reports
## the mode the production path reaches.
extends SceneTree

var _scene: Node
var _frame := 0


func _initialize() -> void:
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)


func _process(_d: float) -> bool:
	_frame += 1
	if _frame < 5:
		return false
	print("AC3: production boot mode=%s playing=%s conn=%s actors=%d interactions=%d" % [
		_scene.store.mode,
		_scene.demo.is_playing(),
		_scene.store.connection_state,
		_scene.store.actors.size(),
		_scene.store.interactions.size(),
	])
	quit(0)
	return true