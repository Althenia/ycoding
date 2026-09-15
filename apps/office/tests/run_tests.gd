## Minimal headless test runner.
##
## Runs production modules and exits nonzero on any failed assertion. Usage:
##   "$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd
extends SceneTree

var _passed := 0
var _failed := 0
var _failures: Array[String] = []


func _init() -> void:
	var suites := [
		preload("res://tests/suites/test_fixture_translator.gd"),
		preload("res://tests/suites/test_office_store.gd"),
		preload("res://tests/suites/test_demo_transport.gd"),
		preload("res://tests/suites/test_office_director.gd"),
		preload("res://tests/suites/test_work_state.gd"),
		preload("res://tests/suites/test_navigation.gd"),
		preload("res://tests/suites/test_character_sheet.gd"),
		preload("res://tests/suites/test_sse_parser.gd"),
		preload("res://tests/suites/test_http_transport.gd"),
		preload("res://tests/suites/test_gateway_contract.gd"),
		preload("res://tests/suites/test_layout.gd"),
		preload("res://tests/suites/test_shell_layout.gd"),
		preload("res://tests/suites/test_prop_art.gd"),
		preload("res://tests/suites/test_focus_visibility.gd"),
		preload("res://tests/suites/test_model_catalog.gd"),
		preload("res://tests/suites/test_sidebar.gd"),
		preload("res://tests/suites/test_chrome_toggles.gd"),
		preload("res://tests/suites/test_shift_change.gd"),
	]
	for suite_script in suites:
		var suite = suite_script.new()
		suite.run(self)
	print("")
	print("=== office test summary ===")
	print("passed: %d" % _passed)
	print("failed: %d" % _failed)
	for failure in _failures:
		print("  FAIL: %s" % failure)
	if _failed > 0:
		print("RESULT: FAILED")
		quit(1)
		return
	print("RESULT: PASSED")
	quit(0)


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
