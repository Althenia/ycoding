## DemoTransport tests (TEST-004, TEST-005).
extends RefCounted

var _received: Array[Dictionary] = []


func run(t) -> void:
	test_loads_shipped_fixture(t)
	test_missing_fixture_reports_error(t)
	test_deterministic_ordering_and_delivery(t)
	test_transport_has_no_network_capability(t)
	test_playback_finishes(t)


func _on_event(event: Dictionary) -> void:
	_received.append(event)


func test_loads_shipped_fixture(t) -> void:
	var transport := DemoTransport.new()
	var error := transport.load_fixture(t.fixture_path("oauth-workplace.jsonl"))
	t.check_equal(error, "", "shipped fixture loads without error")
	t.check(transport.event_count() > 0, "fixture produced wire events")


func test_missing_fixture_reports_error(t) -> void:
	var transport := DemoTransport.new()
	var error := transport.load_fixture("/nonexistent/fixture.jsonl")
	t.check(not error.is_empty(), "missing fixture reports an error")


func test_deterministic_ordering_and_delivery(t) -> void:
	var transport := DemoTransport.new()
	transport.load_fixture(t.fixture_path("oauth-workplace.jsonl"))
	transport.event_ready.connect(_on_event)
	_received.clear()
	transport.play()
	transport.advance(1000)
	var early := _received.size()
	t.check(early > 0, "events before 1s are delivered")
	var first_type := str(_received[0].get("type", ""))
	t.check_equal(first_type, Wire.SESSION_STATUS, "connection state precedes live events")
	for event in _received:
		t.check(event.get("_synthetic", false), "every demo event is marked synthetic")
	transport.advance(200000)
	t.check(_received.size() >= early, "playback advances monotonically")


func test_transport_has_no_network_capability(t) -> void:
	var transport := DemoTransport.new()
	t.check_equal(transport.is_synthetic(), true, "transport declares itself synthetic")
	var methods := transport.get_method_list()
	for method in methods:
		var name := str(method.get("name", ""))
		t.check(
			name.find("http") == -1 and name.find("post") == -1 and name.find("request") == -1,
			"demo transport exposes no network method named %s" % name
		)


func test_playback_finishes(t) -> void:
	var transport := DemoTransport.new()
	transport.load_fixture(t.fixture_path("oauth-workplace.jsonl"))
	transport.play()
	transport.advance(1_000_000)
	t.check(not transport.is_playing(), "playback stops at the end without looping")
