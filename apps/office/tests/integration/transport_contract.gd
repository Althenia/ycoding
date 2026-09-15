## Live transport integration check.
##
## Drives the real HttpTransport, SseParser and fixture server over a real
## loopback socket. This is a named integration suite, not a unit test: it needs
## a listening server, so it runs from tools/verify-integration.sh rather than
## the headless unit runner.
##
##   tools/verify-integration.sh
##
## It asserts the wire contract the client depends on, including the two shapes
## that are easy to get wrong: the snapshot is top-level (not wrapped in `data`),
## and the session log is an SSE stream (not a JSON object).
extends SceneTree

var _pass := 0
var _fail := 0
var _fails: Array[String] = []

func _check(condition: bool, message: String) -> void:
	if condition:
		_pass += 1
		return
	_fail += 1
	_fails.append(message)

func _init() -> void:
	var base := ""
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--base="):
			base = argument.substr(7)
	if base.is_empty():
		print("INTEG: missing --base")
		quit(1)
		return

	# Health carries the source epoch the client stamps onto every read.
	var health := _fetch(base, "/api/health")
	_check(int(health.get("status", 0)) == 200, "health status 200")
	var health_body: Dictionary = health.get("body", {})
	_check(str(health_body.get("healthy", "")) == "true", "health.healthy is true")
	var epoch := str(health_body.get("sourceEpoch", ""))
	_check(not epoch.is_empty(), "health carries sourceEpoch")

	# Create establishes the session. A session with no foreground drain is
	# absent from `active`; that is the documented contract, not a bug.
	var created := _send(base, HTTPClient.METHOD_POST, "/api/session", {"title": "integration"})
	_check(int(created.get("status", 0)) == 200, "session create 200")
	var session_id := str((created.get("body", {}) as Dictionary).get("data", {}).get("id", ""))
	_check(session_id.begins_with("ses"), "created id looks like a session id")

	var idle := _fetch(base, "/api/session/active")
	_check((idle.get("body", {}) as Dictionary).get("data", {}).is_empty(),
		"a created-but-unprompted session is absent from active")

	# Snapshot is top-level: sourceEpoch, session, messages, watermark.
	var snapshot := _fetch(base, "/api/session/%s/snapshot" % session_id)
	_check(int(snapshot.get("status", 0)) == 200, "snapshot 200")
	var snapshot_body: Dictionary = snapshot.get("body", {})
	_check(snapshot_body.has("sourceEpoch"), "snapshot has top-level sourceEpoch")
	_check(snapshot_body.get("messages") is Array, "snapshot has top-level messages")
	_check(not snapshot_body.has("data"), "snapshot is not wrapped in data")
	_check(str((snapshot_body.get("watermark", {}) as Dictionary).get("type", "")) == "log.synced",
		"snapshot watermark is log.synced")

	var messages := _fetch(base, "/api/session/%s/message" % session_id)
	_check(int(messages.get("status", 0)) == 200, "message list 200")

	# Admitting a prompt is what makes a session active.
	var prompt := _send(base, HTTPClient.METHOD_POST, "/api/session/%s/prompt" % session_id, {
		"id": "msg_900001",
		"text": "integration probe",
	})
	_check(int(prompt.get("status", 0)) in [200, 201, 204], "prompt accepted")
	var active: Dictionary = (_fetch(base, "/api/session/active").get("body", {}) as Dictionary).get("data", {})
	_check(active.has(session_id), "a prompted session appears in active")
	if active.has(session_id):
		_check(str((active[session_id] as Dictionary).get("type", "")) == "running",
			"active entry type is running")

	# The log route is StreamSse, so it is read through the streaming path.
	var log_transport := HttpTransport.new()
	log_transport.configure(base)
	log_transport.stream("/api/experimental/session/%s/log?after=0&follow=false" % session_id)
	var frames := _collect(log_transport, 2500, 1)
	_check(frames.size() > 0, "log replay yields parsed SSE frames")
	var frame_types := ""
	for frame in frames:
		frame_types += str(frame.get("data", "")) + " "
	_check(frame_types.find("session.created") != -1, "replay includes session.created")

	var interrupt := _send(base, HTTPClient.METHOD_POST, "/api/session/%s/interrupt" % session_id, {})
	_check(int(interrupt.get("status", 0)) == 204, "interrupt returns 204")

	# The global feed is volatile SSE, and its epoch matches the health read.
	var feed := HttpTransport.new()
	feed.configure(base)
	feed.stream("/api/event")
	var events := _collect(feed, 2500, 1)
	_check(events.size() >= 1, "the event stream yields a parsed event")
	if events.size() >= 1:
		var payload := str(events[0].get("data"))
		_check(payload.find("server.connected") != -1, "first streamed event is server.connected")
		_check(payload.find(epoch) != -1, "stream sourceEpoch matches health sourceEpoch")

	print("INTEG: pass=%d fail=%d" % [_pass, _fail])
	for failure in _fails:
		print("  FAIL: ", failure)
	quit(1 if _fail > 0 else 0)

func _fetch(base: String, path: String) -> Dictionary:
	return _send(base, HTTPClient.METHOD_GET, path, {})

## Settle one request/response exchange, returning the response or error entry.
func _send(base: String, method: int, path: String, body: Dictionary) -> Dictionary:
	var transport := HttpTransport.new()
	transport.configure(base)
	transport.request(method, path, body)
	var events: Array = []
	var deadline := Time.get_ticks_msec() + 2000
	while Time.get_ticks_msec() < deadline:
		events.append_array(transport.poll(4))
		var response := _kind(events, "response")
		if not response.is_empty():
			return response
		var failure := _kind(events, "error")
		if not failure.is_empty():
			return failure
	return {}

## Collect until `wanted` parsed events arrive, or the budget expires.
func _collect(transport, budget_ms: int, wanted: int) -> Array:
	var out: Array = []
	var deadline := Time.get_ticks_msec() + budget_ms
	while Time.get_ticks_msec() < deadline and out.size() < wanted:
		for entry in transport.poll(4):
			if str(entry.get("kind", "")) == "event":
				out.append(entry.get("event", {}))
	return out

func _kind(events: Array, kind: String) -> Dictionary:
	for entry in events:
		if str(entry.get("kind", "")) == kind:
			return entry
	return {}
