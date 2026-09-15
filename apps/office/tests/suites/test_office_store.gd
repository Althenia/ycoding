## Store reducer tests (TEST-005, TEST-006, TEST-010, TEST-013).
extends RefCounted


func run(t) -> void:
	test_created_session_registers_actor(t)
	test_same_agent_two_sessions_stay_distinct(t)
	test_tool_maps_to_verified_activity(t)
	test_unknown_tool_is_generic_not_guessed(t)
	test_inactive_is_not_success(t)
	test_attention_is_immediate_and_cleared_by_real_answer(t)
	test_duplicate_interaction_is_one_item(t)
	test_epoch_change_invalidates_tokens(t)
	test_bounded_conversation(t)
	test_demo_store_has_no_live_mutation_path(t)


func _store() -> OfficeStore:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-a"})
	return store


func test_created_session_registers_actor(t) -> void:
	var store := _store()
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_root",
			"data": {"agent": "lead", "title": "CEO"},
			"sourceEpoch": "epoch-a",
		}
	)
	t.check(store.actor_for("ses_root") != null, "root actor registered")
	t.check_equal(store.root_session_id, "ses_root", "root session recorded")


## RQ-09 / TEST-006: a reusable agent definition must not collapse two sessions.
func test_same_agent_two_sessions_stay_distinct(t) -> void:
	var store := _store()
	for id in ["ses_a", "ses_b"]:
		store.apply(
			{
				"type": Wire.SESSION_CREATED,
				"sessionID": id,
				"data": {"agent": "backend", "parentID": "ses_root"},
				"sourceEpoch": "epoch-a",
			}
		)
	t.check_equal(store.actors.size(), 2, "two actors exist")
	t.check(store.actor_for("ses_a") != store.actor_for("ses_b"), "actors are distinct objects")
	t.check(
		store.actor_for("ses_a").identity.display_name != store.actor_for("ses_b").identity.display_name,
		"repeated agent names are disambiguated"
	)


func test_tool_maps_to_verified_activity(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply({"type": Wire.TOOL_CALLED, "sessionID": "ses_1", "data": {"tool": "read"}})
	t.check_equal(
		store.actor_for("ses_1").work_state, WorkState.Kind.READING, "read maps to READING"
	)
	store.apply({"type": Wire.TOOL_CALLED, "sessionID": "ses_1", "data": {"tool": "edit"}})
	t.check_equal(store.actor_for("ses_1").work_state, WorkState.Kind.TYPING, "edit maps to TYPING")


## TEST-017: an unknown tool must not be classified as a test run.
func test_unknown_tool_is_generic_not_guessed(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply({"type": Wire.TOOL_CALLED, "sessionID": "ses_1", "data": {"tool": "mystery_tool"}})
	t.check_equal(
		store.actor_for("ses_1").work_state, WorkState.Kind.PROCESSING, "unknown tool stays generic"
	)


## The handoff's core truthfulness rule: inactive is not success.
func test_inactive_is_not_success(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply({"type": Wire.SESSION_STATUS, "sessionID": "ses_1", "data": {"status": {"type": "idle"}}})
	t.check_equal(store.actor_for("ses_1").settled_status, "", "idle does not claim success")
	t.check_equal(store.actor_for("ses_1").work_state, WorkState.Kind.IDLE, "idle maps to IDLE")


func test_attention_is_immediate_and_cleared_by_real_answer(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply(
		{
			"type": Wire.TASK_UPDATED,
			"sessionID": "ses_1",
			"data":
			{
				"change":
				{"type": Wire.CHANGE_QUESTION_ASKED, "question": {"id": "q1", "text": "Include rotation?"}}
			},
		}
	)
	t.check(store.actor_for("ses_1").attention_required, "question raises attention")
	t.check_equal(store.conversation_items("ses_1").size(), 1, "question recorded once")
	store.apply(
		{
			"type": Wire.TASK_UPDATED,
			"sessionID": "ses_1",
			"data":
			{
				"change":
				{"type": Wire.CHANGE_QUESTION_ANSWERED, "answer": {"questionID": "q1", "text": "No."}}
			},
		}
	)
	t.check(not store.actor_for("ses_1").attention_required, "answer clears attention")


func test_duplicate_interaction_is_one_item(t) -> void:
	var store := _store()
	var change := {
		"type": Wire.CHANGE_QUESTION_ASKED,
		"question": {"id": "q-dup", "text": "Same question"},
	}
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply({"type": Wire.TASK_UPDATED, "sessionID": "ses_1", "data": {"change": change}})
	store.apply({"type": Wire.TASK_UPDATED, "sessionID": "ses_1", "data": {"change": change}})
	t.check_equal(store.conversation_items("ses_1").size(), 1, "a repeated source identity is one item")


func test_epoch_change_invalidates_tokens(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	var before := store.actor_for("ses_1").interaction_token
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-b"})
	t.check(
		store.actor_for("ses_1").interaction_token > before,
		"epoch change invalidates cosmetic tokens"
	)
	t.check_equal(store.source_epoch, "epoch-b", "epoch updated")


func test_bounded_conversation(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	for index in OfficeStore.MAX_CONVERSATION_ITEMS + 25:
		store.apply(
			{
				"type": Wire.TASK_UPDATED,
				"sessionID": "ses_1",
				"data":
				{
					"change":
					{
						"type": Wire.CHANGE_QUESTION_ASKED,
						"question": {"id": "q%d" % index, "text": "Q%d" % index}
					}
				},
			}
		)
	t.check(
		store.interactions.size() <= OfficeStore.MAX_CONVERSATION_ITEMS,
		"conversation stays bounded"
	)


## TEST-005: the DEMO store exposes no mutation entry point at all.
func test_demo_store_has_no_live_mutation_path(t) -> void:
	var store := _store()
	t.check_equal(store.mode, OfficeStore.MODE_DEMO, "store defaults to DEMO")
	var methods := store.get_method_list()
	var mutation_names := ["prompt", "interrupt", "launch", "approve", "reply", "send"]
	for method in methods:
		var name := str(method.get("name", ""))
		t.check(
			not mutation_names.has(name),
			"store must not expose a mutation method named %s" % name
		)
