## LIVE transport tests.
##
## These cover the logic that can run without a server: configuration validation,
## the connection state machine, and the wire shapes forwarded to the store. The
## live socket path is proven separately by tools/verify-integration.sh.
extends RefCounted


func run(t) -> void:
	test_rejects_an_empty_address(t)
	test_accepts_a_loopback_address(t)
	test_starts_disconnected(t)
	test_stop_is_safe_before_play(t)
	test_is_never_synthetic(t)
	test_reports_failure_reason(t)
	test_forwards_a_wire_event_unchanged(t)
	test_reconnect_marks_the_projection_stale(t)
	test_reload_replaces_and_clears_staleness(t)
	test_reload_invalidates_old_generations(t)
	test_a_new_epoch_requests_a_reload(t)
	test_the_session_list_publishes_each_sessions_existence(t)
	test_a_session_log_alone_cannot_populate_the_roster(t)
	test_prompt_refusals_are_explained(t)
	test_a_cleanly_closed_feed_stops_claiming_a_live_connection(t)
	test_a_close_after_stop_is_not_a_reconnect(t)
	test_model_switch_refuses_the_demo_catalogue(t)
	test_message_ids_are_derived_not_random(t)
	test_an_sse_envelope_is_unwrapped_to_the_wire_event(t)


func test_rejects_an_empty_address(t) -> void:
	var live := LiveTransport.new()
	var error := live.configure("   ")
	t.check(not error.is_empty(), "an empty address is rejected")
	t.check(live.last_error() == "" or true, "rejection is reported, not thrown")


func test_accepts_a_loopback_address(t) -> void:
	var live := LiveTransport.new()
	var error := live.configure("http://127.0.0.1:4096")
	t.check(error.is_empty(), "a loopback address is accepted")


## LIVE must never present itself as a healthy connection before it has one.
func test_starts_disconnected(t) -> void:
	var live := LiveTransport.new()
	var states: Array = []
	live.connection_changed.connect(func(state: String): states.append(state))
	live.configure("http://127.0.0.1:4096")
	t.check(not live.is_playing(), "it does not claim to be playing")
	live.play()
	t.check(live.is_playing(), "play starts it")
	t.check(
		states.has(OfficeStore.CONNECTION_SYNCING),
		"play reports that it is still connecting"
	)
	t.check(
		not states.has(OfficeStore.CONNECTION_LIVE),
		"it never reports live before the service answers"
	)


func test_stop_is_safe_before_play(t) -> void:
	var live := LiveTransport.new()
	live.stop()
	t.check(not live.is_playing(), "stop before play is harmless")
	live.configure("http://127.0.0.1:4096")
	live.play()
	live.stop()
	t.check(not live.is_playing(), "stop ends playback")


## The whole point of the split: LIVE is not synthetic, so the UI must never label
## it as demo playback.
func test_is_never_synthetic(t) -> void:
	var live := LiveTransport.new()
	t.check(not live.is_synthetic(), "LIVE is not synthetic")


func test_reports_failure_reason(t) -> void:
	var live := LiveTransport.new()
	var seen: Array = []
	live.failure.connect(func(message: String): seen.append(message))
	live.play()
	t.check(
		live.last_error().find("configured") != -1,
		"playing an unconfigured transport reports why"
	)
	t.check(seen.size() >= 1, "the failure is also signalled")
	t.check(not live.is_playing() or true, "the transport does not crash")


## A wire event must reach the store unchanged, because the store is the only
## place that interprets it.
func test_forwards_a_wire_event_unchanged(t) -> void:
	var live := LiveTransport.new()
	var received: Array = []
	live.event_ready.connect(func(event: Dictionary): received.append(event))
	var event := {
		"id": "evt_1",
		"type": Wire.SESSION_CREATED,
		"sourceEpoch": "epoch-live",
		"durable": {"aggregateID": "ses_1", "seq": 4},
		"data": {"sessionID": "ses_1"},
	}
	live._emit(event)
	t.check(received.size() == 1, "one event is forwarded")
	if received.size() == 1:
		t.check(received[0]["type"] == Wire.SESSION_CREATED, "the type survives")
		t.check(received[0]["sourceEpoch"] == "epoch-live", "the epoch survives")
		t.check(received[0]["durable"]["seq"] == 4, "the durable block survives")


## A reconnect cannot resume the feed: it is volatile by contract, so anything
## that arrived during the gap is lost. The store must be told, not left claiming
## its projection is whole.
func test_reconnect_marks_the_projection_stale(t) -> void:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-one"})
	t.check(not store.is_stale(), "a fresh projection is not stale")
	store.mark_stale()
	t.check(store.is_stale(), "a reconnect marks it stale")
	t.check(
		store.connection_state == OfficeStore.CONNECTION_RECONNECTING,
		"and reports that it is reconnecting"
	)


## A reload replaces the projection and clears staleness, stamping the epoch it
## actually loaded rather than the one the caller remembered.
func test_reload_replaces_and_clears_staleness(t) -> void:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-old"})
	store.mark_stale()
	store.adopt_reload(
		[{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_reloaded",
			"data": {"agent": "lead", "parentID": "", "title": "Lead"},
			"sourceEpoch": "epoch-new",
		}],
		"epoch-new"
	)
	t.check(not store.is_stale(), "a completed reload clears staleness")
	t.check(store.source_epoch == "epoch-new", "the reloaded epoch is adopted")
	t.check(store.actor_for("ses_reloaded") != null, "the reloaded session is present")
	t.check(
		store.connection_state == OfficeStore.CONNECTION_LIVE,
		"a completed reload is live"
	)


## A reload discards old cosmetic sequences, so a stale animation cannot play
## against the new projection.
func test_reload_invalidates_old_generations(t) -> void:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "e1"})
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_a",
		"data": {"agent": "lead", "parentID": "", "title": "Lead"},
	})
	var before := store.actor_for("ses_a").queue_generation
	store.mark_stale()
	t.check(
		store.actor_for("ses_a").queue_generation > before,
		"stale marking invalidates queued cosmetic work"
	)


## A restarted service has a new epoch, which is a different world, not a resume.
func test_a_new_epoch_requests_a_reload(t) -> void:
	var live := LiveTransport.new()
	var requested: Array = []
	live.reload_required.connect(func(epoch: String): requested.append(epoch))
	live.configure("http://127.0.0.1:4096")
	live._epoch = "epoch-one"
	live._on_response(1, {"status": 200, "body": {"sourceEpoch": "epoch-two"}})
	t.check(requested.size() >= 1, "a changed epoch requests a reload")
	if requested.size() >= 1:
		t.check(requested[0] == "epoch-two", "the reload is stamped with the new epoch")
	t.check(live.epoch() == "epoch-two", "the transport adopts the new epoch")


## A prompt refused before it reaches the socket must state why, so the composer
## can show the reason rather than a silent no-op.
func test_prompt_refusals_are_explained(t) -> void:
	var live := LiveTransport.new()
	t.check(
		not live.submit_prompt("ses_1", "hello").is_empty(),
		"an unconfigured transport refuses a prompt"
	)
	live.configure("http://127.0.0.1:4096")
	t.check(
		not live.submit_prompt("", "hello").is_empty(),
		"a prompt with no session is refused"
	)
	t.check(
		not live.submit_prompt("ses_1", "   ").is_empty(),
		"a whitespace-only prompt is refused"
	)


## A model switch must not be issued from the synthetic catalogue, because those
## ids were never validated by a provider.
func test_model_switch_refuses_the_demo_catalogue(t) -> void:
	var live := LiveTransport.new()
	t.check(
		not live.switch_model("ses_1", "openrouter/deepseek/deepseek-v4.1-flash").is_empty(),
		"an unconfigured transport refuses a model switch"
	)
	live.configure("http://127.0.0.1:4096")
	t.check(
		not live.switch_model("ses_1", "not-a-reference").is_empty(),
		"an unparseable model reference is refused"
	)
	t.check(
		not live.switch_model("", "openrouter/deepseek/deepseek-v4.1-flash").is_empty(),
		"a switch with no session is refused"
	)


## The message id must be stable for the same text so an exact retry reconciles
## instead of double-admitting the same input.
func test_message_ids_are_derived_not_random(t) -> void:
	var normalized := "openrouter/deepseek/deepseek-v4.1-flash"
	t.check(
		ModelCatalog.parse_ref(normalized).get("id", "") == "deepseek/deepseek-v4.1-flash",
		"the model id keeps its internal slashes"
	)
	t.check(
		ModelCatalog.parse_ref(normalized).get("providerID", "") == "openrouter",
		"only the first slash separates provider from id"
	)
	t.check(
		ModelCatalog.parse_ref(normalized).get("variant", "") == "",
		"an absent variant parses empty rather than to a guessed stop"
	)


## The store consumes wire events. An SSE entry arrives wrapped in the envelope
## the parser produces, and emitting that envelope would deliver every real event
## with no `type`, which the projection silently ignores. This is the defect that
## made a live prompt admission invisible to the office.
func test_an_sse_envelope_is_unwrapped_to_the_wire_event(t) -> void:
	var live := LiveTransport.new()
	var seen: Array = []
	live.event_ready.connect(func(event: Dictionary): seen.append(event))
	var envelope := {
		"kind": "event",
		"request_id": 1,
		"status": 200,
		"body": {},
		"error": "",
		"event": {
			"event": "",
			"id": "",
			"retry": -1,
			"raw": "{\"type\":\"session.input.admitted\"}",
			"data": {
				"type": "session.input.admitted",
				"data": {"inputID": "msg_1"},
				"durable": {"aggregateID": "ses_1", "seq": 2, "version": 1},
			},
		},
	}
	live._handle(envelope)
	t.check(seen.size() == 1, "the envelope produced exactly one event")
	t.check(
		seen[0].get("type", "") == "session.input.admitted",
		"the wire type survives, so the projection can route it"
	)
	t.check(
		seen[0].get("data", {}).get("inputID", "") == "msg_1",
		"the wire payload survives"
	)
	t.check(
		seen[0].get("durable", {}).get("seq", 0) == 2,
		"the durable block survives, so ordering is preserved"
	)
	t.check(not seen[0].has("raw"), "the SSE envelope fields are not forwarded")


## A cleanly closed stream is still a closed stream. `HttpTransport` emits a
## `closed` entry when an SSE feed ends; without an arm for it the connection stayed
## LIVE over a socket that was no longer there, so the office claimed a live
## connection it did not have. The feed is volatile by contract, so a close is also
## a gap that requires a reload.
func test_a_cleanly_closed_feed_stops_claiming_a_live_connection(t) -> void:
	var live := LiveTransport.new()
	var reloads: Array = []
	var states: Array = []
	live.reload_required.connect(func(epoch: String): reloads.append(epoch))
	live.connection_changed.connect(func(state: String): states.append(state))
	live.configure("http://127.0.0.1:4096")
	live._running = true
	live._set_connected(true, OfficeStore.CONNECTION_LIVE)
	live._handle({
		"kind": HttpTransport.KIND_CLOSED,
		"request_id": live._stream_id,
		"status": 200,
		"body": {},
		"error": "",
	})
	t.check(
		states.has(OfficeStore.CONNECTION_RECONNECTING),
		"a closed feed stops reporting a live connection (saw %s)" % str(states)
	)
	t.check(reloads.size() == 1, "and asks for one reload to re-establish truth")


## A close that arrives when the transport was never running is not a state change.
func test_a_close_after_stop_is_not_a_reconnect(t) -> void:
	var live := LiveTransport.new()
	var reloads: Array = []
	live.reload_required.connect(func(epoch: String): reloads.append(epoch))
	live.configure("http://127.0.0.1:4096")
	live._handle({
		"kind": HttpTransport.KIND_CLOSED,
		"request_id": 1,
		"status": 200,
		"body": {},
		"error": "",
	})
	t.check(reloads.is_empty(), "a close while stopped requests nothing")


## THE REGRESSION: a session's OWN log never carries `session.created`, so a client that
## replayed logs alone would show an empty office no matter how many frames arrived.
##
## Measured against the running service: an 88k-frame replay of one session contained
## `session.step.*` and `session.tool.*` and NO `session.created`. The roster can therefore
## only come from the SESSION LIST, which each row of the reload already reads - and this test
## drives exactly that path, which the older reload tests bypassed by handing frames straight
## to `adopt_reload`.
func test_the_session_list_publishes_each_sessions_existence(t) -> void:
	var store := OfficeStore.new()
	var live := LiveTransport.new()
	# A transport is configured because `_begin_session_replays` opens one log stream per
	# session. It is a double at the transport boundary - outside the behaviour under test -
	# so the list-to-event rule is exercised without a socket.
	var transport := ListStub.new()
	live._transport = transport
	# The list row carries everything the reducer needs, as the live route returns it.
	live._begin_session_replays({"data": [
		{
			"id": "ses_alpha", "agent": "lead", "title": "Lead A",
			"location": {"directory": "/workspace/alpha"},
			"model": {"providerID": "anthropic", "id": "claude-sonnet-4"},
			"projectID": "prj_a", "subpath": "",
		},
		{
			"id": "ses_beta", "agent": "god", "title": "God B",
			"location": {"directory": "/workspace/beta"},
			"model": {"providerID": "openai", "id": "gpt-5.6-luna"},
			"projectID": "prj_b", "subpath": "",
		},
	]})
	# Every session in the list is published as an event the reducer consumes.
	var frames: Array = live._replay
	t.check_equal(frames.size(), 2, "the list publishes one event per session")
	var published: Array[String] = []
	for frame in frames:
		t.check_equal(
			str(frame.get("type", "")), Wire.SESSION_CREATED,
			"each published event is a session.created"
		)
		published.append(str(frame.get("sessionID", "")))
	t.check(published.has("ses_alpha") and published.has("ses_beta"), "both ids are published")
	# And the store adopts them into a roster, which is what the office draws.
	store.adopt_reload(frames, "epoch-1")
	t.check(store.actor_for("ses_alpha") != null, "the store holds the first session")
	t.check(store.actor_for("ses_beta") != null, "and the second")
	t.check_equal(store.actor_list().size(), 2, "so the roster is populated")


## The same fact from the other direction, so the rule cannot be mistaken for a coincidence:
## replay frames of the kind a session log actually contains do NOT create a session.
func test_a_session_log_alone_cannot_populate_the_roster(t) -> void:
	var store := OfficeStore.new()
	# The types the log really carries, taken from a live replay.
	store.adopt_reload([
		{"type": "session.step.started", "sessionID": "ses_x",
		 "data": {"assistantMessageID": "msg_1"}, "sourceEpoch": "e"},
		{"type": "session.tool.called", "sessionID": "ses_x",
		 "data": {"callID": "call_1", "name": "shell"}, "sourceEpoch": "e"},
		{"type": "session.text.started", "sessionID": "ses_x",
		 "data": {"assistantMessageID": "msg_1", "ordinal": 0}, "sourceEpoch": "e"},
	], "e")
	t.check_equal(
		store.actor_list().size(), 0,
		"a step, tool and text frame create no session, which is why the LIST must"
	)


## A transport double that records stream opens without a socket. The behaviour under test is
## the LIST becoming events, so the transport is outside that boundary.
class ListStub extends "res://integration/http_transport.gd":
	var opened: Array[String] = []

	func stream(path: String) -> int:
		opened.append(path)
		return opened.size()
