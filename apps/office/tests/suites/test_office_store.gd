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
	test_a_declared_model_without_a_variant_is_composed(t)
	test_an_incomplete_model_ref_does_not_blank_the_value(t)
	test_tool_name_is_learned_from_input_started(t)
	test_an_unannounced_call_is_not_classified(t)
	test_a_learned_tool_name_does_not_leak_to_another_call(t)
	test_the_demo_testing_beat_reaches_testing(t)
	test_a_permission_summary_never_carries_a_reason(t)
	test_a_guardrail_summary_carries_its_own_reason(t)
	test_a_text_stream_accumulates_then_the_ended_value_replaces_it(t)
	test_a_partial_text_stream_is_marked_incomplete_not_finished(t)
	test_two_ordinals_in_one_assistant_message_stay_separate(t)
	test_reasoning_content_never_becomes_conversation_text(t)
	test_a_malformed_text_frame_records_nothing(t)
	test_live_text_never_crosses_sessions(t)
	test_live_blocks_are_listed_for_their_own_session(t)


func _store() -> OfficeStore:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-a"})
	return store


## Register one actor so an event addressed to it has somewhere to land. The store
## ignores work events for a session it has never seen, so a test about value mapping
## must establish the actor first rather than relying on an implicit one.
func _register_actor(store: OfficeStore, session_id: String) -> void:
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": session_id,
		"data": {"agent": "lead", "title": "Desk"},
		"sourceEpoch": "epoch-a",
	})


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


## TEST-005: the tool name comes from `session.tool.input.started`, and the
## called/settled transition is what classifies the call. `session.tool.called`
## declares neither `tool` nor `name` (`packages/schema/src/session-event.ts:529-540`),
## so a payload teaching that shape is a fixture that never occurs on the wire.
func test_tool_maps_to_verified_activity(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply(
		{
			"type": Wire.TOOL_CALLED,
			"sessionID": "ses_1",
			"data": {"callID": "call_1", "input": {}, "executed": false},
		}
	)
	t.check_equal(
		store.actor_for("ses_1").work_state,
		WorkState.Kind.PROCESSING,
		"a call with no announced name stays generic"
	)
	store.apply(
		{
			"type": OfficeStore.TOOL_INPUT_STARTED,
			"sessionID": "ses_1",
			"data": {"callID": "call_1", "name": "read"},
		}
	)
	store.apply(
		{
			"type": Wire.TOOL_CALLED,
			"sessionID": "ses_1",
			"data": {"callID": "call_1", "input": {}, "executed": true},
		}
	)
	t.check_equal(
		store.actor_for("ses_1").work_state, WorkState.Kind.READING, "read maps to READING"
	)
	store.apply(
		{
			"type": OfficeStore.TOOL_INPUT_STARTED,
			"sessionID": "ses_1",
			"data": {"callID": "call_2", "name": "edit"},
		}
	)
	store.apply(
		{
			"type": Wire.TOOL_CALLED,
			"sessionID": "ses_1",
			"data": {"callID": "call_2", "input": {}, "executed": true},
		}
	)
	t.check_equal(store.actor_for("ses_1").work_state, WorkState.Kind.TYPING, "edit maps to TYPING")


## TEST-017: an unknown tool must not be classified as a test run.
func test_unknown_tool_is_generic_not_guessed(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply(
		{
			"type": OfficeStore.TOOL_INPUT_STARTED,
			"sessionID": "ses_1",
			"data": {"callID": "call_m", "name": "mystery_tool"},
		}
	)
	store.apply(
		{
			"type": Wire.TOOL_CALLED,
			"sessionID": "ses_1",
			"data": {"callID": "call_m", "input": {}, "executed": true},
		}
	)
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
##
## R1-01: DEMO is no longer a boot mode. The composition root assigns the mode it
## presents, and DEMO is entered only by the explicit demo action, so this suite
## states DEMO explicitly rather than claiming a default it does not own.
func test_demo_store_has_no_live_mutation_path(t) -> void:
	var store := _store()
	# A fresh store carries nothing a production launch could mistake for observed
	# work; the boot decision is pinned in `test_production_boot.gd`.
	t.check(store.actors.is_empty(), "a fresh store fabricates no actor")
	t.check(store.interactions.is_empty(), "a fresh store fabricates no history")
	t.check(store.root_session_id.is_empty(), "a fresh store adopts no root session")
	store.mode = OfficeStore.MODE_DEMO
	t.check_equal(store.mode, OfficeStore.MODE_DEMO, "DEMO is the mode under test")
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
##
## The declared `model` is `Model.Ref` = `{id, providerID, variant?}`
## (`packages/schema/src/model.ts:14-18`); the store composes the client's
## `provider/id#variant` config form that `ModelCatalog` and the composer use.
func test_placement_is_captured_from_session_created(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_place",
		"data": {
			"agent": "lead",
			"parentID": "",
			"location": {"directory": "/tmp/project-one"},
			"model": {"id": "claude-sonnet-4", "providerID": "anthropic", "variant": "high"},
		},
	})
	var actor := store.actor_for("ses_place")
	t.check(actor != null, "the actor exists")
	if actor == null:
		return
	t.check(actor.location_directory == "/tmp/project-one", "the directory is captured")
	t.check(actor.model_ref == "anthropic/claude-sonnet-4#high", "the model ref is composition")


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
			"model": {"id": "deepseek/deepseek-v4.1-flash", "providerID": "openrouter", "variant": "max"},
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


## The declared `model` omits `variant` when the session runs a bare model
## (`Model.Ref.variant` is optional, `packages/schema/src/model.ts:14-18`), and a
## model id may itself contain slashes. The composed reference must be exactly the
## `provider/id` form the catalogue and the composer parse.
func test_a_declared_model_without_a_variant_is_composed(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_bare",
		"data": {
			"agent": "lead",
			"parentID": "",
			"model": {"id": "deepseek/deepseek-v4.1-flash", "providerID": "openrouter"},
		},
	})
	var actor := store.actor_for("ses_bare")
	t.check(actor != null, "the actor exists")
	if actor == null:
		return
	t.check(
		actor.model_ref == "openrouter/deepseek/deepseek-v4.1-flash",
		"an absent variant adds no suffix and a slashed id survives"
	)


## A `model` object that does not carry the declared fields must not compose a
## malformed reference (`format_ref` needs both `providerID` and `id`) nor erase a
## reference already learned.
func test_an_incomplete_model_ref_does_not_blank_the_value(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_part",
		"data": {
			"agent": "lead",
			"parentID": "",
			"model": {"id": "claude-sonnet-4", "providerID": "anthropic", "variant": "high"},
		},
	})
	store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": "ses_part",
		"data": {"agent": "lead", "parentID": "", "model": {"variant": "low"}},
	})
	var actor := store.actor_for("ses_part")
	t.check(actor != null, "the actor exists")
	if actor == null:
		return
	t.check(
		actor.model_ref == "anthropic/claude-sonnet-4#high",
		"an incomplete model neither blanks nor mangles the reference"
	)


## `session.tool.called` declares neither `tool` nor `name`: its fields are
## `ToolBase` (`assistantMessageID`, `callID`) plus `input`, `executed`, `state?`
## (`packages/schema/src/session-event.ts:529-540`). The name is published on
## `session.tool.input.started` (`session-event.ts:499-507`) as `name`, so the
## store correlates the two by the one field they share, `callID`, and classifies
## the work state when the call itself is entered.
func test_tool_name_is_learned_from_input_started(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	var cases := [
		["call_read", "read", WorkState.Kind.READING],
		["call_shell", "shell", WorkState.Kind.TESTING],
		["call_edit", "edit", WorkState.Kind.TYPING],
	]
	for entry in cases:
		store.apply({
			"type": OfficeStore.TOOL_INPUT_STARTED,
			"sessionID": "ses_1",
			"data": {"assistantMessageID": "msg_1", "callID": entry[0], "name": entry[1]},
		})
		store.apply({
			"type": Wire.TOOL_CALLED,
			"sessionID": "ses_1",
			"data":
			{"assistantMessageID": "msg_1", "callID": entry[0], "input": {}, "executed": true},
		})
		t.check_equal(
			store.actor_for("ses_1").work_state,
			entry[2],
			"%s classifies through its callID" % entry[1]
		)
	t.check_equal(
		store.actor_for("ses_1").activity_label, "edit", "the attributed tool name is kept"
	)


## A call the runtime never announced has no name to trust, so it stays the
## generic PROCESSING state rather than a guessed category.
func test_an_unannounced_call_is_not_classified(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply({
		"type": Wire.TOOL_CALLED,
		"sessionID": "ses_1",
		"data": {"assistantMessageID": "msg_1", "callID": "call_unknown", "input": {}, "executed": true},
	})
	t.check_equal(
		store.actor_for("ses_1").work_state,
		WorkState.Kind.PROCESSING,
		"a call with no announced name stays generic"
	)


## The name belongs to one call. A second call must not inherit it, and the first
## call must still classify.
func test_a_learned_tool_name_does_not_leak_to_another_call(t) -> void:
	var store := _store()
	store.apply({"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}})
	store.apply({
		"type": OfficeStore.TOOL_INPUT_STARTED,
		"sessionID": "ses_1",
		"data": {"assistantMessageID": "msg_1", "callID": "call_1", "name": "shell"},
	})
	store.apply({
		"type": Wire.TOOL_CALLED,
		"sessionID": "ses_1",
		"data": {"assistantMessageID": "msg_1", "callID": "call_2", "input": {}, "executed": true},
	})
	t.check_equal(
		store.actor_for("ses_1").work_state,
		WorkState.Kind.PROCESSING,
		"another callID does not inherit the learned name"
	)
	store.apply({
		"type": Wire.TOOL_CALLED,
		"sessionID": "ses_1",
		"data": {"assistantMessageID": "msg_1", "callID": "call_1", "input": {}, "executed": true},
	})
	t.check_equal(
		store.actor_for("ses_1").work_state,
		WorkState.Kind.TESTING,
		"its own callID still classifies"
	)


## The DEMO `testing` beat must reach the TESTING state through the same
## correlation the LIVE path uses, or the demo would silently regress the one
## visual payoff D2 exists for.
##
## This drives the real path: the shipped fixture through the real
## `DemoTransport` (which sorts the translated events) and into the real store, so
## an ordering assumption cannot hide behind a hand-built event list.
func test_the_demo_testing_beat_reaches_testing(t) -> void:
	var transport := DemoTransport.new()
	t.check_equal(
		transport.load_fixture(t.fixture_path("oauth-workplace.jsonl")),
		"",
		"the shipped fixture loads"
	)
	var received: Array[Dictionary] = []
	transport.event_ready.connect(func(event: Dictionary): received.append(event))
	transport.play()
	transport.advance(60_000)
	var store := _store()
	store.source_epoch = "demo-epoch-a"
	for event in received:
		store.apply(event)
	var actor := store.actor_for("demo-qa")
	t.check(actor != null, "the demo QA actor exists")
	if actor == null:
		return
	# The sort is not stable, so the causal order is pinned directly rather than
	# assumed: the name must arrive before the call it belongs to.
	var input_index := -1
	var called_index := -1
	for index in received.size():
		var type := str(received[index].get("type", ""))
		if type == OfficeStore.TOOL_INPUT_STARTED and input_index == -1:
			input_index = index
		if type == Wire.TOOL_CALLED and called_index == -1:
			called_index = index
	t.check(
		input_index != -1 and called_index != -1 and input_index < called_index,
		"the tool name arrives before the call it classifies"
	)
	t.check_equal(actor.work_state, WorkState.Kind.TESTING, "the demo testing beat classifies as TESTING")
	t.check(actor.synthetic, "the demo actor is still marked synthetic")


## `permission.v2.asked` declares `id`, `sessionID`, `action`, `resources`,
## `save?`, `metadata?`, `source?` (`packages/schema/src/permission.ts:24-35`) —
## there is no `reason`. `reason` is declared only on `Guardrail.Request`
## (`packages/schema/src/guardrail.ts:57`), so a permission caption must not
## render one even if a payload carries the key: the honest caption is the action
## and the resources the user is actually judging.
func test_a_permission_summary_never_carries_a_reason(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.PERMISSION_ASKED,
		"sessionID": "ses_r",
		"data": {
			"id": "prq_r",
			"sessionID": "ses_r",
			"action": "shell",
			"resources": ["rm -rf build"],
			"reason": "an undeclared permission field",
		},
	})
	var request := store.attention.for_session("ses_r")
	var summary := str((request.get("data", {}) as Dictionary).get("summary", ""))
	t.check(summary.contains("shell"), "the caption names the action")
	t.check(summary.contains("rm -rf build"), "the caption names the resource")
	t.check(
		not summary.contains("an undeclared permission field"),
		"a permission has no reason field, so none is rendered"
	)


## The guardrail request does declare `reason`, and it is the most useful sentence
## available, so it is kept for that family.
func test_a_guardrail_summary_carries_its_own_reason(t) -> void:
	var store := _store()
	store.apply({
		"type": Wire.GUARDRAIL_ASKED,
		"sessionID": "ses_g",
		"data": {
			"id": "grq_r",
			"sessionID": "ses_g",
			"action": "git.push",
			"resources": ["main"],
			"reason": "Protected branch",
		},
	})
	var request := store.attention.for_session("ses_g")
	var summary := str((request.get("data", {}) as Dictionary).get("summary", ""))
	t.check(summary.contains("git.push"), "the caption names the action")
	t.check(summary.contains("Protected branch"), "the declared guardrail reason is kept")


## A live text stream accumulates from its deltas, and the terminal `ended` value
## REPLACES what they built rather than appending to it. `ended` is the replayable
## full-value boundary, so appending would double the text whenever the deltas had
## already arrived.
func test_a_text_stream_accumulates_then_the_ended_value_replaces_it(t) -> void:
	var store := _store()
	_register_actor(store, "ses_t")
	var block := {"assistantMessageID": "msg_1", "ordinal": 0}
	store.apply({
		"type": Wire.TEXT_STARTED, "sessionID": "ses_t", "data": block.duplicate(),
	})
	for fragment in ["Hel", "lo ", "there"]:
		var delta := block.duplicate()
		delta["delta"] = fragment
		store.apply({"type": Wire.TEXT_DELTA, "sessionID": "ses_t", "data": delta})
	t.check(
		store.stream_text("ses_t", "msg_1", 0) == "Hello there",
		"the deltas accumulate in arrival order (got %s)" % store.stream_text("ses_t", "msg_1", 0)
	)
	var ended := block.duplicate()
	ended["text"] = "Hello there!"
	store.apply({"type": Wire.TEXT_ENDED, "sessionID": "ses_t", "data": ended})
	t.check(
		store.stream_text("ses_t", "msg_1", 0) == "Hello there!",
		"the ended value replaces the accumulated deltas (got %s)" % store.stream_text("ses_t", "msg_1", 0)
	)


## Two sessions can carry the same assistant message id. The live text must stay
## with its own session, or one session's answer appears under another's.
func test_live_text_never_crosses_sessions(t) -> void:
	var store := _store()
	_register_actor(store, "ses_a")
	_register_actor(store, "ses_b")
	store.apply({
		"type": Wire.TEXT_DELTA, "sessionID": "ses_a",
		"data": {"assistantMessageID": "msg_1", "ordinal": 0, "delta": "mine"},
	})
	store.apply({
		"type": Wire.TEXT_DELTA, "sessionID": "ses_b",
		"data": {"assistantMessageID": "msg_1", "ordinal": 0, "delta": "theirs"},
	})
	t.check(store.stream_text("ses_a", "msg_1", 0) == "mine", "session A keeps its own text")
	t.check(store.stream_text("ses_b", "msg_1", 0) == "theirs", "session B keeps its own text")


## One assistant message can emit more than one text block, and the ordinal is what
## keeps them apart. Concatenating them would corrupt both.
func test_two_ordinals_in_one_assistant_message_stay_separate(t) -> void:
	var store := _store()
	_register_actor(store, "ses_t")
	for ordinal in [0, 1]:
		var delta := {"assistantMessageID": "msg_2", "ordinal": ordinal, "delta": "block%d" % ordinal}
		store.apply({"type": Wire.TEXT_DELTA, "sessionID": "ses_t", "data": delta})
	t.check(store.stream_text("ses_t", "msg_2", 0) == "block0", "ordinal 0 keeps its own text")
	t.check(store.stream_text("ses_t", "msg_2", 1) == "block1", "ordinal 1 keeps its own text")


## Reasoning deltas must never surface as conversation text: the product forbids
## presenting hidden model reasoning as an answer.
func test_reasoning_content_never_becomes_conversation_text(t) -> void:
	var store := _store()
	_register_actor(store, "ses_t")
	store.apply({
		"type": Wire.REASONING_DELTA, "sessionID": "ses_t",
		"data": {"assistantMessageID": "msg_3", "ordinal": 0, "delta": "private thought"},
	})
	t.check(
		store.stream_text("ses_t", "msg_3", 0) == "",
		"reasoning does not appear as assistant text"
	)
	# And no conversation item was created from it either.
	var items := store.conversation_items("ses_t")
	for item in items:
		t.check(
			not str(item.get("description", "")).contains("private thought"),
			"reasoning is not projected into the transcript"
		)


## A frame missing its identifying fields records nothing, so a malformed stream
## cannot fabricate a finished state.
func test_a_malformed_text_frame_records_nothing(t) -> void:
	var store := _store()
	_register_actor(store, "ses_t")
	store.apply({"type": Wire.TEXT_DELTA, "sessionID": "ses_t", "data": {}})
	t.check(store.stream_text("ses_t", "", 0) == "", "an unidentifiable delta stores nothing")
	store.apply({"type": Wire.TEXT_ENDED, "sessionID": "ses_t", "data": {"text": "orphan"}})
	t.check(store.stream_text("ses_t", "msg_x", 0) == "", "an ended with no block stores nothing")


## A block whose terminal `ended` was never seen keeps its partial value. The partial
## is honest - incomplete, not wrong - and must not be reported as finished.
func test_a_partial_text_stream_is_marked_incomplete_not_finished(t) -> void:
	var store := _store()
	_register_actor(store, "ses_t")
	store.apply({
		"type": Wire.TEXT_DELTA, "sessionID": "ses_t",
		"data": {"assistantMessageID": "msg_4", "ordinal": 0, "delta": "half a thou"},
	})
	t.check(
		store.stream_text("ses_t", "msg_4", 0) == "half a thou",
		"the partial value is preserved rather than discarded"
	)
	# A partial stream must not settle the actor: only a terminal execution event does.
	var actor := store.actor_for("ses_t")
	t.check(
		actor != null and actor.settled_status.is_empty(),
		"a partial stream does not claim the session finished"
	)


## The drawer needs the session's own live blocks, in ordinal order, so an answer
## can appear while it is still arriving.
func test_live_blocks_are_listed_for_their_own_session(t) -> void:
	var store := _store()
	_register_actor(store, "ses_a")
	_register_actor(store, "ses_b")
	store.apply({
		"type": Wire.TEXT_DELTA, "sessionID": "ses_a",
		"data": {"assistantMessageID": "msg_9", "ordinal": 1, "delta": "second"},
	})
	store.apply({
		"type": Wire.TEXT_DELTA, "sessionID": "ses_a",
		"data": {"assistantMessageID": "msg_9", "ordinal": 0, "delta": "first"},
	})
	store.apply({
		"type": Wire.TEXT_DELTA, "sessionID": "ses_b",
		"data": {"assistantMessageID": "msg_9", "ordinal": 0, "delta": "other"},
	})
	var blocks := store.stream_blocks("ses_a")
	t.check(blocks.size() == 2, "only this session's blocks are listed (got %d)" % blocks.size())
	if blocks.size() == 2:
		t.check(str(blocks[0]["text"]) == "first", "blocks are ordered by ordinal")
		t.check(str(blocks[1]["text"]) == "second", "and the higher ordinal follows")
	# Nothing with no live text is offered, and reasoning stays out entirely.
	store.apply({
		"type": Wire.REASONING_DELTA, "sessionID": "ses_a",
		"data": {"assistantMessageID": "msg_r", "ordinal": 0, "delta": "thought"},
	})
	t.check(
		store.stream_blocks("ses_a").size() == 2,
		"reasoning is never offered as a live text block"
	)
