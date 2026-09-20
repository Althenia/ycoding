## Does an `await` inside a test ever resume under the headless runner?
##
## The runner runs every suite inside `_init()` and calls `quit()` before returning,
## so a test that awaits a frame signal may never resume - its assertions would never
## be counted while the suite still reports PASSED. This decides it: a test that awaits
## and then asserts something FALSE must be reported as a failure if the await resumes.
##
## Kit-local probe; no repository source depends on it.
##
## Run:
##   godot --headless --path apps/office --script res://r5_03_await_tmp.gd
extends SceneTree

var _passed := 0
var _failed := 0


func _init() -> void:
	var suite = load("res://r5_03_await_suite_tmp.gd").new()
	suite.run(self)
	print("PROBE summary before any frame: passed=%d failed=%d" % [_passed, _failed])
	if _failed > 0:
		print("PROBE RESULT: the awaited assertion WAS counted as a failure")
	else:
		print("PROBE RESULT: the awaited assertion was NOT counted - awaiting is vacuous")
	quit(0)


func check(condition: bool, message: String) -> void:
	if condition:
		_passed += 1
		return
	_failed += 1
	print("PROBE FAIL: %s" % message)
