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
	test_placement_is_captured_from_session_created(t)
	test_absent_placement_does_not_blank_existing(t)
	test_location_scope_reports_when_rosters_differ(t)
	test_a_reload_evicts_the_previous_generation(t)
	test_permission_and_guardrail_requests_reach_the_queue(t)
	test_an_attention_event_without_an_id_is_ignored(t)
	test_an_attention_summary_falls_back_when_detail_is_absent(t)


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


## `session.created` carries the session's durable location and model, so the
## office can show a real path and the composer can start on the session's own
## model instead of inventing one.
func test_placement_is_captured_from_session_created(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_place",
		"data": {
			"agent": "lead",
			"parentID": "",
			"location": {"directory": "/tmp/project-one"},
			"model": {"ref": "anthropic/claude-sonnet-4#high"},
		},
	})
	var actor := store.actor_for("ses_place")
	t.check(actor != null, "the actor exists")
	if actor == null:
		return
	t.check(actor.location_directory == "/tmp/project-one", "the directory is captured")
	t.check(actor.model_ref == "anthropic/claude-sonnet-4#high", "the model ref is captured")


## A later event that omits placement must not erase what is already known. A
## status update carries no location, and blanking it would lose real data.
func test_absent_placement_does_not_blank_existing(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_keep",
		"data": {
			"agent": "lead",
			"parentID": "",
			"location": {"directory": "/tmp/project-two"},
			"model": {"ref": "openrouter/deepseek/deepseek-v4.1-flash#max"},
		},
	})
	# A second session.created for the same session without placement.
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_keep",
		"data": {"agent": "lead", "parentID": ""},
	})
	var actor := store.actor_for("ses_keep")
	t.check(actor != null, "the actor still exists")
	if actor == null:
		return
	t.check(actor.location_directory == "/tmp/project-two", "the directory survives")
	t.check(actor.model_ref.find("deepseek") != -1, "the model ref survives")


## The office is a view over sessions and each session carries its own directory,
## so the UI must be able to tell when the roster is not location-scoped.
func test_location_scope_reports_when_rosters_differ(t) -> void:
	var store := _store()
	t.check(store.locations().is_empty(), "no locations before any session")
	for pair in [["ses_a", "/tmp/one"], ["ses_b", "/tmp/one"]]:
		store.apply({
			"type": Wire.SESSION_CREATED,
			"sessionID": pair[0],
			"data": {"agent": "lead", "parentID": "", "location": {"directory": pair[1]}},
		})
	t.check(store.locations().size() == 1, "one directory for one project")
	t.check(store.has_single_location(), "the roster is location-scoped")
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_c",
		"data": {"agent": "qa", "parentID": "", "location": {"directory": "/tmp/two"}},
	})
	t.check(store.locations().size() == 2, "a second directory is reported")
	t.check(not store.has_single_location(), "the roster is no longer location-scoped")


## A reload replaces the projection rather than merging into it, so no actor or
## interaction from the previous generation can survive into the new one. If it
## merged, a session from another workspace would keep a place in the office after
## the office had been pointed somewhere else.
func test_a_reload_evicts_the_previous_generation(t) -> void:
	var store := _store()
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_old",
			"data": {"agent": "backend", "parentID": ""},
			"sourceEpoch": "epoch-a",
		}
	)
	store.record_interaction(
		{
			"id": "report:ses_old",
			"kind": "report",
			"session_id": "ses_old",
			"description": "From the previous generation",
		}
	)
	t.check_equal(store.actors.size(), 1, "the old generation has one actor")
	t.check(store.interactions.size() > 0, "the old generation has history")

	store.adopt_reload(
		[
			{
				"type": Wire.SESSION_CREATED,
				"sessionID": "ses_new",
				"data": {"agent": "frontend", "parentID": ""},
				"sourceEpoch": "epoch-b",
			}
		],
		"epoch-b"
	)
	t.check(not store.actors.has("ses_old"), "the old actor is evicted")
	t.check(store.actors.has("ses_new"), "the reloaded actor is present")
	t.check_equal(store.actors.size(), 1, "the projection is replaced, not merged")
	for item in store.interactions:
		t.check(
			str(item.get("session_id", "")) != "ses_old",
			"no interaction from the previous generation survives"
		)
	t.check(not store.is_stale(), "a completed reload clears the stale marking")
	t.check_equal(store.source_epoch, "epoch-b", "the reload adopts its own epoch")


## A session blocked on a permission or guardrail review must become answerable.
##
## These arrive as EPHEMERAL wire events, which the store previously ignored
## entirely, so a session waiting on approval showed nothing and could never be
## answered. The queue is what makes them answerable.
func test_permission_and_guardrail_requests_reach_the_queue(t) -> void:
	var store := _store()
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_p",
			"data": {"agent": "backend", "parentID": ""},
		}
	)
	store.apply(
		{
			"type": Wire.PERMISSION_ASKED,
			"sessionID": "ses_p",
			"data": {
				"id": "prq_1",
				"sessionID": "ses_p",
				"action": "shell",
				"resources": ["rm -rf build"],
			},
		}
	)
	t.check(store.attention.has("prq_1"), "a permission request is pending")
	t.check(
		store.actor_for("ses_p").attention_required,
		"the blocked actor is marked as needing the user"
	)
	var request := store.attention.for_session("ses_p")
	t.check_equal(str(request.get("kind", "")), AttentionQueue.KIND_PERMISSION, "its kind is kept")
	var summary := str((request.get("data", {}) as Dictionary).get("summary", ""))
	t.check(summary.contains("shell"), "the summary names the action being judged")
	t.check(summary.contains("rm -rf build"), "the summary names the resource")

	# A guardrail review is a distinct kind, so the UI can word it differently.
	store.apply(
		{
			"type": Wire.GUARDRAIL_ASKED,
			"sessionID": "ses_p",
			"data": {
				"id": "grq_1",
				"sessionID": "ses_p",
				"action": "git.push",
				"resources": ["main"],
				"reason": "Protected branch",
			},
		}
	)
	t.check(store.attention.has("grq_1"), "a guardrail review is pending")
	var kinds := {}
	for entry in store.attention.pending():
		kinds[str(entry["id"])] = str(entry.get("kind", ""))
	t.check_equal(
		kinds.get("grq_1", ""),
		AttentionQueue.KIND_GUARDRAIL,
		"the guardrail review is queued as its own kind"
	)
	t.check_equal(
		kinds.get("prq_1", ""),
		AttentionQueue.KIND_PERMISSION,
		"the permission keeps its own kind beside it"
	)


## A malformed attention event must not invent a request the user cannot answer.
func test_an_attention_event_without_an_id_is_ignored(t) -> void:
	var store := _store()
	store.apply({"type": Wire.PERMISSION_ASKED, "sessionID": "ses_x", "data": {"action": "shell"}})
	t.check_equal(store.attention.count(), 0, "a request with no id is not queued")


## The neutral fallback stands when the wire carries no detail, rather than an
## empty caption that reads like a rendering bug.
func test_an_attention_summary_falls_back_when_detail_is_absent(t) -> void:
	var store := _store()
	store.apply({"type": Wire.PERMISSION_ASKED, "sessionID": "ses_y", "data": {"id": "prq_2"}})
	var request := store.attention.for_session("ses_y")
	t.check(
		not str((request.get("data", {}) as Dictionary).get("summary", "")).is_empty(),
		"a request with no detail still has a readable caption"
	)
