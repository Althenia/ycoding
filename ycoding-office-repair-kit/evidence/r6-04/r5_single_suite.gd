## Run ONE suite file, so a mutation check costs seconds instead of a whole run.
##
## The full runner takes minutes because it loads every suite. Proving that a suite
## DISCRIMINATES means running it repeatedly against deliberately broken copies, which is
## only practical if a single suite can be driven on its own.
##
## Same assertion API the real runner exposes, so a suite written for the runner runs
## here unchanged.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --headless --path apps/office \
##     --script res://r5_single_suite_tmp.gd -- res://tests/suites/<name>.gd
extends SceneTree

const SETTLE_FRAMES := 16

var _passed := 0
var _failed := 0
var _failures: Array[String] = []
var _suite_path := ""


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	_suite_path = str(args[0]) if args.size() > 0 else ""


func _initialize() -> void:
	if _suite_path.is_empty():
		print("SINGLE no suite given")
		quit(2)
		return
	var script = load(_suite_path)
	if script == null:
		print("SINGLE could not load ", _suite_path)
		quit(2)
		return
	var suite = script.new()
	suite.run(self)
	for _frame in SETTLE_FRAMES:
		await process_frame
	print("SINGLE passed=%d failed=%d" % [_passed, _failed])
	for failure in _failures:
		print("  SINGLE FAIL: %s" % failure)
	quit(1 if _failed > 0 else 0)


func check(condition: bool, message: String) -> void:
	if condition:
		_passed += 1
		return
	_failed += 1
	_failures.append(message)


func check_equal(actual, expected, message: String) -> void:
	if actual == expected:
		_passed += 1
		return
	_failed += 1
	_failures.append("%s (expected %s, got %s)" % [message, str(expected), str(actual)])


func fixture_path(name: String) -> String:
	return ProjectSettings.globalize_path("res://fixtures/%s" % name)
