## Fixture translator contract tests (TEST-004 / TEST-017).
extends RefCounted


func run(t) -> void:
	test_fixture_labels_never_pass_through(t)
	test_connection_is_not_live_mode(t)
	test_observation_becomes_session_created(t)
	test_null_parent_normalizes_to_root(t)
	test_delegation_becomes_task_updated(t)
	test_settlement_maps_to_real_terminal_events(t)
	test_unknown_fixture_kind_is_rejected(t)


func _record(kind: String, payload: Dictionary) -> Dictionary:
	return {
		"schema_version": 1,
		"mode": "DEMO",
		"at_ms": 100,
		"event_id": "t-1",
		"source_epoch": "demo-epoch-a",
		"session_id": "demo-root",
		"kind": kind,
		"payload": payload,
		"source": {"kind": "synthetic_fixture", "message_id": null, "label": "test"},
	}


## The five fixture labels must never reach the store.
func test_fixture_labels_never_pass_through(t) -> void:
	var labels := [
		FixtureTranslator.FIXTURE_CONNECTION,
		FixtureTranslator.FIXTURE_OBSERVED,
		FixtureTranslator.FIXTURE_ACTIVITY,
		FixtureTranslator.FIXTURE_INTERACTION,
		FixtureTranslator.FIXTURE_SETTLED,
	]
	for label in labels:
		var events := FixtureTranslator.translate(_record(label, {"state": "live", "status": "succeeded"}))
		for event in events:
			t.check(
				not labels.has(str(event.get("type", ""))),
				"fixture label %s leaked into a wire event" % label
			)


## A synthetic connection being ready is not LIVE mode.
func test_connection_is_not_live_mode(t) -> void:
	var events := FixtureTranslator.translate(_record(FixtureTranslator.FIXTURE_CONNECTION, {"state": "live"}))
	t.check_equal(events.size(), 1, "connection produced one event")
	t.check_equal(events[0]["type"], Wire.CONNECTED, "live connection maps to server.connected")
	t.check(events[0].get("_synthetic", false), "synthetic connection is labelled")


func test_observation_becomes_session_created(t) -> void:
	var events := FixtureTranslator.translate(
		_record(
			FixtureTranslator.FIXTURE_OBSERVED,
			{
				"agent_id": "backend",
				"parent_session_id": "demo-root",
				"display_role": "Backend",
				"status": "running",
			}
		)
	)
	t.check_equal(events.size(), 1, "observation produced one event")
	t.check_equal(events[0]["type"], Wire.SESSION_CREATED, "observation maps to session.created")
	t.check_equal(events[0]["data"]["agent"], "backend", "agent carried through")
	t.check_equal(events[0]["data"]["parentID"], "demo-root", "parent carried through")


## A JSON null parent must normalize to empty so the session is a root.
func test_null_parent_normalizes_to_root(t) -> void:
	var events := FixtureTranslator.translate(
		_record(
			FixtureTranslator.FIXTURE_OBSERVED,
			{"agent_id": "lead", "parent_session_id": null, "display_role": "CEO / Lead", "status": "idle"}
		)
	)
	t.check_equal(events[0]["data"]["parentID"], "", "null parent becomes an empty string")
	var store := OfficeStore.new()
	store.apply(events[0])
	t.check_equal(store.root_session_id, "demo-root", "root session is identified")


func test_delegation_becomes_task_updated(t) -> void:
	var events := FixtureTranslator.translate(
		_record(
			FixtureTranslator.FIXTURE_INTERACTION,
			{
				"interaction_id": "d-1",
				"from_session_id": "demo-root",
				"to_session_id": "demo-backend",
				"interaction_kind": "delegation",
				"summary": "Implement the callback.",
				"details": "Full instruction text.",
			}
		)
	)
	t.check_equal(events.size(), 1, "interaction produced one event")
	t.check_equal(events[0]["type"], Wire.TASK_UPDATED, "interaction maps to session.task.updated")
	t.check_equal(
		events[0]["data"]["change"]["type"], Wire.CHANGE_LAUNCHED, "delegation maps to launched change"
	)
	t.check_equal(events[0]["data"]["change"]["inputID"], "demo-backend", "child session carried through")


func test_settlement_maps_to_real_terminal_events(t) -> void:
	var expectations := {
		"succeeded": Wire.EXECUTION_SUCCEEDED,
		"failed": Wire.EXECUTION_FAILED,
		"cancelled": Wire.EXECUTION_INTERRUPTED,
	}
	for status in expectations:
		var events := FixtureTranslator.translate(
			_record(FixtureTranslator.FIXTURE_SETTLED, {"status": status})
		)
		t.check_equal(events.size(), 1, "settlement produced one event")
		t.check_equal(events[0]["type"], expectations[status], "settlement %s maps correctly" % status)


func test_unknown_fixture_kind_is_rejected(t) -> void:
	var events := FixtureTranslator.translate(_record("invented.kind", {}))
	t.check_equal(events.size(), 0, "unknown fixture kind produces no wire event")
