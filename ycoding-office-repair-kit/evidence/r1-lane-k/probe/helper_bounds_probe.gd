## Narrowest test of the helper's branches with stubs, so the wait/failure logic is
## proven without depending on the real fixture.
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")


class StubDemo extends RefCounted:
	var playing := false
	func is_playing() -> bool:
		return playing


class StubStore extends RefCounted:
	var last_error := ""


class StubScene extends Node:
	var demo: Object
	var store: Object
	func start_demo_mode() -> void:
		pass


func _initialize() -> void:
	# A scene whose demo is already playing is adopted without a second start.
	var ok := StubScene.new()
	ok.demo = StubDemo.new()
	(ok.demo as StubDemo).playing = true
	ok.store = StubStore.new()
	root.add_child(ok)
	print("stub: already-playing adopted =", DemoCapture.started(ok))
	print("stub: failure on healthy scene ='%s'" % DemoCapture.failure(ok))

	# A scene that never plays stays waiting and reports the failure bound.
	var stuck := StubScene.new()
	stuck.demo = StubDemo.new()
	stuck.store = StubStore.new()
	root.add_child(stuck)
	for i in 700:
		DemoCapture.started(stuck)
	print("stub: still waiting =", not DemoCapture.started(stuck))
	print("stub: failure reason ='%s'" % DemoCapture.failure(stuck))

	# A scene whose fixture error is recorded surfaces that error as the reason.
	var broken := StubScene.new()
	broken.demo = StubDemo.new()
	broken.store = StubStore.new()
	(broken.store as StubStore).last_error = "fixture not found: /nope"
	root.add_child(broken)
	DemoCapture.started(broken)
	print("stub: fixture-error reason ='%s'" % DemoCapture.failure(broken))
	quit(0)
