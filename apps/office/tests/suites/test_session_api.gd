## Session lifecycle wire tests.
##
## These cover what can be checked without a listening service: the refusals, the
## route and body the module builds, and the routing of a polled response to the
## operation that issued it. The live socket path is proven separately by
## tests/integration/session_api_live.gd and tools/verify-integration.sh.
##
## The route and body assertions use the protocol's literal strings rather than
## this module's helpers, so a drift in either Gateway or the module fails here.
extends RefCounted


func run(t) -> void:
	test_an_unconfigured_transport_refuses_both_operations(t)
	test_a_missing_transport_is_refused_rather_than_crashing(t)
	test_an_empty_session_id_is_refused_for_interrupt(t)
	test_the_routes_are_the_gateway_routes(t)
	test_the_create_body_carries_only_the_fields_the_endpoint_accepts(t)
	test_a_create_with_nothing_to_send_is_refused(t)
	test_the_created_session_id_is_read_from_the_response(t)
	test_a_non_2xx_response_is_surfaced_as_a_reason(t)
	test_a_successful_interrupt_reports_completion(t)
	test_an_interrupt_refusal_names_the_status(t)


## A transport that was never configured cannot reach a service. Both operations
## must say so instead of issuing a request that would fail silently.
func test_an_unconfigured_transport_refuses_both_operations(t) -> void:
	var api := SessionApi.new(HttpTransport.new())
	t.check(
		not api.create_session("/tmp/workspace").is_empty(),
		"an unconfigured transport refuses to create a session"
	)
	t.check(
		not api.interrupt_session("ses_1").is_empty(),
		"an unconfigured transport refuses to interrupt"
	)
	t.check(
		api.last_created_session().is_empty(),
		"a refused create reports no session"
	)


## There is no transport to refuse through, so the guard must not dereference it.
func test_a_missing_transport_is_refused_rather_than_crashing(t) -> void:
	var api := SessionApi.new()
	t.check(
		not api.create_session("/tmp/workspace").is_empty(),
		"a missing transport refuses to create a session"
	)
	t.check(
		not api.interrupt_session("ses_1").is_empty(),
		"a missing transport refuses to interrupt"
	)
	t.check(api.poll(1).is_empty(), "polling a missing transport emits nothing")


## The session id is the whole request. An empty one would be posted as a route
## with an empty segment, which is a different request entirely.
func test_an_empty_session_id_is_refused_for_interrupt(t) -> void:
	var api := _configured_api()
	t.check(not api.interrupt_session("").is_empty(), "an empty id is refused")
	t.check(not api.interrupt_session("   ").is_empty(), "a blank id is refused")
	t.check(not api.is_creating(), "a refused interrupt issues no request")


func test_the_routes_are_the_gateway_routes(t) -> void:
	t.check_equal(
		SessionApi.create_path(),
		"/api/session",
		"create posts to the protocol's literal path"
	)
	t.check_equal(
		SessionApi.interrupt_path("ses_1"),
		"/api/session/ses_1/interrupt",
		"interrupt posts to the protocol's literal path"
	)
	t.check_equal(
		SessionApi.create_path(),
		Gateway.SESSION_LIST,
		"create reuses the shared gateway route"
	)
	t.check_equal(
		SessionApi.interrupt_path("ses_1"),
		Gateway.interrupt("ses_1"),
		"interrupt reuses the shared gateway route"
	)


## The endpoint accepts `id`, `parentID`, `agent`, `model` and `location`. Nothing
## else may be sent, and an absent input must be omitted rather than sent empty.
func test_the_create_body_carries_only_the_fields_the_endpoint_accepts(t) -> void:
	var full := SessionApi.create_body(
		"/tmp/workspace",
		"lead",
		"openrouter/deepseek/deepseek-v4.1-flash"
	)
	var keys: Array = full.keys()
	keys.sort()
	t.check_equal(keys, ["agent", "location", "model"] as Array, "only accepted fields are sent")
	t.check_equal(
		full.get("location", {}),
		{"directory": "/tmp/workspace"},
		"the location is the endpoint's Ref shape"
	)
	t.check_equal(full.get("agent", ""), "lead", "the agent is sent verbatim")
	t.check_equal(
		full.get("model", {}),
		{"providerID": "openrouter", "id": "deepseek/deepseek-v4.1-flash"} as Dictionary,
		"the model is split into the endpoint's Ref shape"
	)
	var bare := SessionApi.create_body("", "", "")
	t.check(bare.is_empty(), "no input means no field is invented")
	var location_only := SessionApi.create_body("  /tmp/workspace  ", "", "")
	t.check_equal(
		location_only.keys(),
		["location"] as Array,
		"an absent agent and model are omitted, not sent empty"
	)
	t.check(
		SessionApi.create_body("", "", "not-a-reference").is_empty(),
		"an unparseable model reference invents no field"
	)
	t.check_equal(
		SessionApi.create_body("", "", "openrouter/deepseek/deepseek-v4.1-flash#high").get("model", {}),
		{"providerID": "openrouter", "id": "deepseek/deepseek-v4.1-flash", "variant": "high"} as Dictionary,
		"a chosen variant is carried, as Model.Ref declares"
	)


## The endpoint declares every field optional, but a request carrying no body at
## all is rejected before it is decoded, and the transport sends no body for an
## empty object. A create with nothing to send must therefore be refused here
## rather than sent and failed by the service.
func test_a_create_with_nothing_to_send_is_refused(t) -> void:
	var api := _configured_api()
	var reason := api.create_session("", "", "")
	t.check(not reason.is_empty(), "a create with nothing to send is refused")
	t.check(not api.is_creating(), "the refused create issued no request")


## The service assigns the id, so it can only be read from the response.
func test_the_created_session_id_is_read_from_the_response(t) -> void:
	var api := _configured_api()
	var created: Array = []
	api.session_created.connect(func(session_id: String): created.append(session_id))
	t.check(api.create_session("/tmp/workspace").is_empty(), "the create was issued")
	api._handle_entry({
		"request_id": api._last_request_id,
		"kind": "response",
		"status": 200,
		"body": {"data": {"id": "ses_new", "title": "Fixture session"}},
		"event": {},
		"error": "",
	})
	t.check_equal(api.last_created_session(), "ses_new", "the id comes from the data envelope")
	t.check_equal(created, ["ses_new"] as Array, "the id is reported to the caller")
	t.check(not api.is_creating(), "the create is no longer in flight")
	# The module routes only its own entries. The transport here was pointed at a
	# closed port, so it may still be holding that connection open; what must be
	# true is that nothing this module owns is left unsettleable.
	for entry in api.poll(1):
		t.check(
			int(entry.get("request_id", -1)) != api._last_request_id,
			"the settled request is not left for the caller to poll again"
		)


## A refusal from the service is a result, not a swallowed error.
func test_a_non_2xx_response_is_surfaced_as_a_reason(t) -> void:
	var api := _configured_api()
	var failures: Array = []
	api.create_failed.connect(func(reason: String): failures.append(reason))
	t.check(api.create_session("/tmp/workspace").is_empty(), "the create was issued")
	api._handle_entry({
		"request_id": api._last_request_id,
		"kind": "response",
		"status": 400,
		"body": {"message": "Expected object, got undefined"},
		"event": {},
		"error": "",
	})
	t.check_equal(failures.size(), 1, "the refusal is reported once")
	t.check(
		api.last_error().find("400") != -1,
		"the refusal names the HTTP status"
	)
	t.check(
		api.last_error().find("Expected object") != -1,
		"the refusal carries the service's message"
	)
	t.check(api.last_created_session().is_empty(), "a refused create reports no session")


## A 204 carries no body, so completion is read from the status alone.
func test_a_successful_interrupt_reports_completion(t) -> void:
	var api := _configured_api()
	var done: Array = []
	var failed: Array = []
	api.interrupted.connect(func(session_id: String): done.append(session_id))
	api.interrupt_failed.connect(func(session_id: String, reason: String): failed.append(reason))
	t.check(api.interrupt_session("ses_1").is_empty(), "the interrupt was issued")
	api._handle_entry({
		"request_id": api._last_request_id,
		"kind": "response",
		"status": 204,
		"body": {},
		"event": {},
		"error": "",
	})
	t.check_equal(done, ["ses_1"] as Array, "the interrupt completes for the session asked about")
	t.check(failed.is_empty(), "a completed interrupt reports no failure")
	t.check(api.last_error().is_empty(), "a completed interrupt is not an error")


## Interrupting a session the service does not know is a 404, and the caller has
## to be able to say which session and why.
func test_an_interrupt_refusal_names_the_status(t) -> void:
	var api := _configured_api()
	var failed: Array = []
	api.interrupt_failed.connect(func(session_id: String, reason: String): failed.append(reason))
	t.check(api.interrupt_session("ses_missing").is_empty(), "the interrupt was issued")
	api._handle_entry({
		"request_id": api._last_request_id,
		"kind": "response",
		"status": 404,
		"body": {"message": "Unknown session"},
		"event": {},
		"error": "",
	})
	t.check_equal(failed.size(), 1, "the refusal is reported against the session")
	t.check(api.last_error().find("404") != -1, "the refusal names the HTTP status")


## A transport pointed at a closed port never has to reach one: the tests above
## inject the entries a response would have produced.
func _configured_api() -> SessionApi:
	var transport := HttpTransport.new()
	transport.configure("http://127.0.0.1:1")
	return SessionApi.new(transport)
