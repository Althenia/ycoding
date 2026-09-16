## Model catalogue wire-read tests.
##
## `GET /api/model` answers `Location.response(Schema.Array(Model.Info))`, so the
## JSON body is `{"location": Location.Info, "data": [Model.Info, ...]}`:
##   packages/protocol/src/groups/model.ts:10 declares the success schema,
##   packages/schema/src/location.ts:23 defines `response` as that struct, and
##   packages/server/src/location.ts:16 builds it that way.
##
## These tests drive the reader through a transport double, so the verified wire
## shape is exercised without a socket. The real socket path is covered by
## tools/verify-integration.sh.
extends RefCounted


func run(t) -> void:
	test_reads_models_from_the_wire(t)
	test_polls_until_the_response_settles(t)
	test_a_non_2xx_response_yields_no_models(t)
	test_a_malformed_body_yields_no_models(t)
	test_a_transport_error_is_reported_not_hidden(t)
	test_a_timeout_is_bounded_and_cancels_the_request(t)
	test_wire_models_are_never_labelled_as_the_demo_catalogue(t)
	test_a_slashed_model_id_round_trips_through_the_catalogue_ref(t)
	test_no_transport_is_a_readable_refusal(t)


## The core claim: what the service sends is already the shape the catalogue
## consumes, so grouping, labels, and variant stops need no translation.
func test_reads_models_from_the_wire(t) -> void:
	var transport := StubTransport.new()
	transport.wire_body = _wire_body()
	var api := ModelCatalogApi.new()
	api.configure(transport)
	var models := api.fetch()
	t.check_equal(transport.requests.size(), 1, "exactly one request is issued")
	t.check_equal(str(transport.requests[0].get("path", "")), "/api/model", "the verified route is read")
	t.check_equal(int(transport.requests[0].get("method", 0)), HTTPClient.METHOD_GET, "the model list is a plain JSON GET")
	t.check_equal(api.last_error(), "", "a clean read reports no failure")
	t.check_equal(models.size(), 4, "every wire model is read")
	var groups := ModelCatalog.group_by_provider(models)
	t.check_equal(groups.size(), 3, "the wire models group into their three providers")
	var openrouter := _group_for(groups, "openrouter")
	t.check_equal(openrouter.size(), 2, "both openrouter models land in their group")
	t.check_equal(
		str(openrouter[0].get("id", "")),
		"deepseek/deepseek-v4.1-flash",
		"the newest openrouter model sorts first"
	)
	t.check_equal(
		ModelCatalog.model_label(openrouter[0]),
		"DeepSeek V4.1 Flash",
		"the label reads the server name"
	)
	t.check_equal(
		ModelCatalog.variant_stops(openrouter[0]),
		["low", "high", "max"],
		"the declared variant stops survive the read in order"
	)
	t.check_equal(
		ModelCatalog.display_label(openrouter[0], "max"),
		"DeepSeek V4.1 Flash Max",
		"the display label composes from wire fields"
	)
	t.check_equal(
		ModelCatalog.variant_index(openrouter[0], "medium"),
		-1,
		"a stop the model does not declare is still not offered"
	)


## A response that needs several frames must be waited for, not abandoned.
func test_polls_until_the_response_settles(t) -> void:
	var transport := StubTransport.new()
	transport.wire_body = _wire_body()
	transport.polls_before_settle = 3
	var api := ModelCatalogApi.new()
	api.configure(transport)
	t.check(api.start(2000), "the read begins")
	t.check(api.is_pending(), "the read is in flight")
	t.check(api.poll().is_empty(), "no model is offered before the response arrives")
	t.check(api.poll().is_empty(), "still no model on a later frame")
	t.check(api.is_pending(), "it keeps waiting instead of giving up early")
	t.check_equal(api.poll().size(), 4, "the settled response yields the models")
	t.check(not api.is_pending(), "the read is finished")
	t.check_equal(api.models().size(), 4, "the resolved catalogue is retained")


## A refusal is not a catalogue. The body here carries a decoy `data` array, so a
## reader that ignored the status would invent models the service never offered.
func test_a_non_2xx_response_yields_no_models(t) -> void:
	var transport := StubTransport.new()
	transport.status = 503
	transport.wire_body = _wire_body()
	var api := ModelCatalogApi.new()
	api.configure(transport)
	t.check(api.fetch().is_empty(), "a refused model list yields no models")
	t.check(
		api.last_error().find("503") != -1,
		"the refusal names the status: %s" % api.last_error()
	)


## A body that does not carry usable entries never becomes a plausible model.
func test_a_malformed_body_yields_no_models(t) -> void:
	var malformed := [
		{},
		{"location": {"directory": "/fixture/workspace"}},
		{"data": {}},
		{"data": "models"},
		{"data": ["gpt-5.6-luna"]},
		{"data": [{"name": "no id or provider"}]},
		{"data": [{"providerID": "openai", "name": "no id"}]},
		{"data": [{"id": "no-provider", "name": "no provider"}]},
	]
	for body in malformed:
		var transport := StubTransport.new()
		transport.wire_body = body
		var api := ModelCatalogApi.new()
		api.configure(transport)
		t.check(api.fetch().is_empty(), "a malformed body yields no models: %s" % str(body))
		t.check(
			not api.last_error().is_empty(),
			"a malformed body is explained rather than hidden: %s" % str(body)
		)


func test_a_transport_error_is_reported_not_hidden(t) -> void:
	var transport := StubTransport.new()
	transport.error_message = "connection error for 127.0.0.1:4096"
	var api := ModelCatalogApi.new()
	api.configure(transport)
	t.check(api.fetch().is_empty(), "a failed request yields no models")
	t.check(
		api.last_error().find("connection error") != -1,
		"the transport reason is kept: %s" % api.last_error()
	)
	t.check(not api.is_pending(), "a failed read is not left in flight")


## "Never spin forever": an unanswered read gives up inside its bound, says so,
## and releases the in-flight request instead of leaving it to be drained every
## poll for the life of the process.
func test_a_timeout_is_bounded_and_cancels_the_request(t) -> void:
	var transport := StubTransport.new()
	transport.polls_before_settle = 1000000
	var api := ModelCatalogApi.new()
	api.configure(transport)
	var started := Time.get_ticks_msec()
	var models := api.fetch(120)
	var elapsed := Time.get_ticks_msec() - started
	t.check(models.is_empty(), "a read that never answers yields no models")
	t.check(elapsed < 2000, "the read gives up within its bound (%d ms)" % elapsed)
	t.check(not api.is_pending(), "the timed-out read is not left in flight")
	t.check(not api.last_error().is_empty(), "the timeout is explained: %s" % api.last_error())
	t.check_equal(transport.cancelled, [1], "the abandoned request is cancelled")


## Server entries must never be mistaken for the fabricated demo set, or the
## composer would label a real catalogue as demo playback.
func test_wire_models_are_never_labelled_as_the_demo_catalogue(t) -> void:
	var transport := StubTransport.new()
	transport.wire_body = _wire_body()
	var api := ModelCatalogApi.new()
	api.configure(transport)
	var models := api.fetch()
	t.check(not models.is_empty(), "the wire models were read")
	t.check(
		not ModelCatalog.is_demo_catalog(models),
		"server data is never presented as the synthetic demo list"
	)
	# The marker belongs to the fabricated set only, so a wire entry that carried
	# it cannot relabel live data as demo.
	var marked := StubTransport.new()
	marked.wire_body = _wire_body()
	var marked_entries: Array = marked.wire_body["data"]
	(marked_entries[0] as Dictionary)["synthetic"] = true
	var marked_api := ModelCatalogApi.new()
	marked_api.configure(marked)
	var marked_models := marked_api.fetch()
	t.check_equal(marked_models.size(), 4, "the marked entry is still read as a model")
	t.check(
		not marked_models[0].has("synthetic"),
		"the synthetic marker is dropped from a wire entry"
	)
	t.check(
		not ModelCatalog.is_demo_catalog(marked_models),
		"a wire-carried synthetic marker cannot label a live catalogue as demo"
	)


## Model ids contain slashes, so the config form splits on the FIRST slash only.
## A read that mangled the id would make switchModel send a model the provider
## never published.
func test_a_slashed_model_id_round_trips_through_the_catalogue_ref(t) -> void:
	var transport := StubTransport.new()
	transport.wire_body = _wire_body()
	var api := ModelCatalogApi.new()
	api.configure(transport)
	var models := api.fetch()
	var slashed: Array = []
	for model in models:
		if str((model as Dictionary).get("id", "")).contains("/"):
			slashed.append(model)
	t.check(slashed.size() >= 1, "the wire list carries models whose ids contain slashes")
	for model in slashed:
		var entry: Dictionary = model
		var text := ModelCatalog.format_ref(entry)
		t.check_equal(
			text,
			"openrouter/%s" % str(entry.get("id", "")),
			"the config form is the provider then the id: %s" % text
		)
		var parsed := ModelCatalog.parse_ref(text)
		t.check_equal(
			str(parsed.get("providerID", "")),
			"openrouter",
			"only the first slash separates the provider: %s" % text
		)
		t.check_equal(
			str(parsed.get("id", "")),
			str(entry.get("id", "")),
			"the model id keeps its own slashes: %s" % text
		)
		t.check_equal(str(parsed.get("variant", "")), "", "no variant is invented for a plain read")
		t.check_equal(
			ModelCatalog.format_ref(parsed),
			text,
			"the reference survives the round trip unchanged"
		)


func test_no_transport_is_a_readable_refusal(t) -> void:
	var api := ModelCatalogApi.new()
	t.check(api.fetch().is_empty(), "a reader with no transport yields no models")
	t.check(not api.last_error().is_empty(), "the refusal explains itself: %s" % api.last_error())
	t.check(not api.is_pending(), "nothing is left in flight")
	t.check(api.models().is_empty(), "no catalogue is retained")


## The verified body: `Location.response` nests the payload under `data`.
func _wire_body() -> Dictionary:
	return {
		"location": {
			"directory": "/fixture/workspace",
			"project": {"id": "global", "directory": "/fixture/workspace"},
		},
		"data": [
			{
				"id": "gpt-5.6-luna",
				"modelID": "gpt-5.6-luna",
				"providerID": "openai",
				"name": "GPT-5.6 Luna",
				"variants": [{"id": "low"}, {"id": "medium"}],
				"time": {"released": 1767225600000},
				"status": "active",
				"enabled": true,
				"cost": [],
				"limit": {"context": 400000, "output": 128000},
			},
			{
				"id": "claude-sonnet-4",
				"modelID": "claude-sonnet-4",
				"providerID": "anthropic",
				"name": "Claude Sonnet 4",
				"variants": [{"id": "high"}],
				"time": {"released": 1764547200000},
				"status": "active",
				"enabled": true,
				"cost": [],
				"limit": {"context": 200000, "output": 64000},
			},
			{
				"id": "deepseek/deepseek-v4.1-flash",
				"modelID": "deepseek/deepseek-v4.1-flash",
				"providerID": "openrouter",
				"name": "DeepSeek V4.1 Flash",
				"variants": [{"id": "low"}, {"id": "high"}, {"id": "max"}],
				"time": {"released": 1761955200000},
				"status": "active",
				"enabled": true,
				"cost": [],
				"limit": {"context": 131072, "output": 32768},
			},
			{
				"id": "deepseek/deepseek-v4-pro",
				"modelID": "deepseek/deepseek-v4-pro",
				"providerID": "openrouter",
				"name": "DeepSeek V4 Pro",
				"variants": [],
				"time": {"released": 1759276800000},
				"status": "active",
				"enabled": true,
				"cost": [],
				"limit": {"context": 131072, "output": 32768},
			},
		],
	}


## The grouping output for one provider, so a test can look a group up by name
## instead of depending on its sort position.
func _group_for(groups: Array, provider_id: String) -> Array:
	for group in groups:
		var entry: Dictionary = group
		if str(entry.get("provider", "")) == provider_id:
			return entry.get("models", [])
	return []


## A transport double: it answers from a canned wire body instead of a socket.
## Only the surface the reader drives is replaced — `request`, `poll`, `cancel` —
## so the reader's own code paths run unchanged.
class StubTransport extends "res://integration/http_transport.gd":
	var status := 200
	var wire_body: Dictionary = {}
	var error_message := ""
	var polls_before_settle := 1
	var requests: Array = []
	var cancelled: Array = []
	var _polls := 0
	var _settled := false
	var _last_request_id := 0

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({"method": method, "path": path, "body": body})
		_last_request_id = requests.size()
		return _last_request_id

	func poll(budget_ms: int = 4) -> Array[Dictionary]:
		_polls += 1
		var entries: Array[Dictionary] = []
		if _settled or _polls < polls_before_settle:
			return entries
		_settled = true
		if not error_message.is_empty():
			entries.append(
				{
					"request_id": _last_request_id,
					"kind": "error",
					"status": 0,
					"body": {},
					"event": {},
					"error": error_message,
				}
			)
			return entries
		entries.append(
			{
				"request_id": _last_request_id,
				"kind": "response",
				"status": status,
				"body": wire_body,
				"event": {},
				"error": "",
			}
		)
		return entries

	func cancel(request_id: int) -> void:
		cancelled.append(request_id)
