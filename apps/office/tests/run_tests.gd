## Minimal headless test runner.
##
## Runs production modules and exits nonzero on any failed assertion. Usage:
##   "$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd
extends SceneTree

var _passed := 0
var _failed := 0
var _failures: Array[String] = []

## Frames to let an awaited test continuation resume before the summary is printed.
const SETTLE_FRAMES := 16


## The suites, in the order they run.
func _suites() -> Array:
	return [
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
		preload("res://tests/suites/test_live_transport.gd"),
		preload("res://tests/suites/test_service_registration.gd"),
		preload("res://tests/suites/test_motion.gd"),
		preload("res://tests/suites/test_conversation.gd"),
		preload("res://tests/suites/test_conversation_history.gd"),
		preload("res://tests/suites/test_transcript_detail.gd"),
		preload("res://tests/suites/test_human_review.gd"),
		preload("res://tests/suites/test_shell_views.gd"),
		preload("res://tests/suites/test_session_usage.gd"),
		preload("res://tests/suites/test_statistics_page.gd"),
		preload("res://tests/suites/test_quota_windows.gd"),
		preload("res://tests/suites/test_quota_budget.gd"),
		preload("res://tests/suites/test_limit_semantics.gd"),
		preload("res://tests/suites/test_export.gd"),
		preload("res://tests/suites/test_accounting_edges.gd"),
		preload("res://tests/suites/test_analytics_verification.gd"),
		preload("res://tests/suites/test_release_identity.gd"),
		preload("res://tests/suites/test_shortcuts.gd"),
		preload("res://tests/suites/test_ui_scale.gd"),
		preload("res://tests/suites/test_session_api.gd"),
		preload("res://tests/suites/test_model_catalog_api.gd"),
		preload("res://tests/suites/test_concurrent_actors.gd"),
		preload("res://tests/suites/test_attention_queue.gd"),
		preload("res://tests/suites/test_effort_slider.gd"),
		preload("res://tests/suites/test_asset_provenance.gd"),
		preload("res://tests/suites/test_composer_submit.gd"),
		preload("res://tests/suites/test_production_boot.gd"),
		preload("res://tests/suites/test_scale_ownership.gd"),
		preload("res://tests/suites/test_routes.gd"),
		preload("res://tests/suites/test_drawer.gd"),
		preload("res://tests/suites/test_anchor_reservations.gd"),
		preload("res://tests/suites/test_folder_target.gd"),
		preload("res://tests/suites/test_project_ledger.gd"),
		preload("res://tests/suites/test_project_persistence.gd"),
		preload("res://tests/suites/test_view_state.gd"),
		preload("res://tests/suites/test_settings_navigation.gd"),
		preload("res://tests/suites/test_config_bridge.gd"),
	]


## Suites may await a frame. `_init` cannot await, so a run there would leave every
## awaited continuation suspended for good - an assertion after an `await` was never
## counted, and the suite still reported PASSED around it. The run therefore happens
## in `_initialize`, where frames actually happen, and the summary waits for those
## continuations before it is printed.
## Built before the main loop starts, so a suite that awaits a frame resumes inside
## the loop rather than being left suspended when the run is summarised.
var _instances: Array = []


func _init() -> void:
	for suite_script in _suites():
		_instances.append(suite_script.new())


func _initialize() -> void:
	for suite in _instances:
		suite.run(self)
	for _frame in SETTLE_FRAMES:
		await process_frame
	_summarise()


func _summarise() -> void:
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
	# A run that asserted NOTHING is not a pass. This happens when a suite fails to
	# COMPILE: the engine reports a parse error, the runner is left with a failed
	# preload, no case executes, and the summary used to print PASSED around zero
	# assertions - so a broken suite read as a green one. The assertion count is the
	# only tell, so it is checked here rather than left to a reader.
	if _passed == 0:
		print("RESULT: FAILED (no assertions ran)")
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
