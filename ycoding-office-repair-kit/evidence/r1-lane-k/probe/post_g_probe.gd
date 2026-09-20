## Simulates the POST-lane-G tree: stops the boot demo, then proves the shared
## helper's explicit opt-in restores a populated DEMO office without boot help.
## Run from outside the project: --script <abs path outside res://>.
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")
const STEP_MS := 250

var _scene: Node
var _stage := 0
var _elapsed := 0


func _initialize() -> void:
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)


func _process(_d: float) -> bool:
	if _scene == null or _scene.demo == null:
		return false
	if _stage == 0:
		# Undo the CURRENT tree's boot demo, reproducing the post-G world where
		# `_ready` never started it: no playback, no signal, empty projection.
		_scene._stop_demo()
		_scene.start_demo_mode()
		_scene._stop_demo()
		_scene.store = OfficeStore.new()
		_scene.office_view.bind_store(_scene.store)
		print("probe: playing after forced stop =", _scene.demo.is_playing(),
			" actors=", _scene.store.actors.size())
		_stage = 1
		return false
	if _stage == 1:
		if not DemoCapture.started(_scene):
			print("probe: helper waiting; failure=", DemoCapture.failure(_scene))
			return false
		print("probe: playing after helper =", _scene.demo.is_playing())
		while _elapsed < 35000:
			_elapsed += STEP_MS
			_scene.demo.advance(STEP_MS)
			if _elapsed % 6000 == 0:
				_scene._tick_ambient()
		print("probe: actors=%d interactions=%d mode=%s" % [
			_scene.store.actors.size(), _scene.store.interactions.size(), _scene.store.mode])
		quit(0 if _scene.store.actors.size() > 0 else 1)
		return true
	return true
