## Non-blocking HTTP and SSE transport built on Godot's HTTPClient.
##
## One instance owns every in-flight request. `poll()` advances all of them
## within a per-frame millisecond budget and returns the entries produced since
## the previous call, so no caller ever blocks on the network:
##
##   { "request_id": int, "kind": "response"|"event"|"error"|"closed",
##     "status": int, "body": Dictionary, "event": Dictionary, "error": String }
##
## A JSON request settles exactly once, as `response` with the parsed `body` and
## the HTTP `status`, or as `error` with a readable message. A stream emits one
## `event` per complete SSE frame parsed by SseParser and then one terminal
## `closed`, or `error` when the stream fails. Each `event` entry carries the SSE
## field names plus the JSON-decoded `data`; `raw` keeps the undecoded text, and a
## payload that is not JSON leaves `data` null with the reason in `error`. A
## `closed` entry uses `error` only to note that an unfinished trailing event was
## discarded.
##
## Credentials and location are explicit inputs; this class never reads files, the
## environment or an OS keychain, and it ships no default host, port or token.
class_name HttpTransport
extends RefCounted

const KIND_RESPONSE := "response"
const KIND_EVENT := "event"
const KIND_ERROR := "error"
const KIND_CLOSED := "closed"

## A connection or DNS failure stays bounded; an established stream does not.
const CONNECT_TIMEOUT_MS := 15000
const REQUEST_TIMEOUT_MS := 30000

var _host: String = ""
var _port: int = 0
var _tls: bool = false
var _base_path: String = ""
var _username: String = ""
var _password: String = ""
var _directory: String = ""
var _workspace_id: String = ""
var _requests: Dictionary = {}
var _next_id: int = 1
var _last_error: String = ""


## `base_url` is absolute, for example "http://127.0.0.1:41234". Credentials are
## passed explicitly; this class never reads files, environment, or OS keychains.
func configure(base_url: String, username: String = "ycoding", password: String = "") -> void:
	_username = username
	_password = password
	var parsed := _split_base_url(base_url)
	_host = str(parsed["host"])
	_port = int(parsed["port"])
	_base_path = str(parsed["base_path"])
	_tls = bool(parsed["tls"])
	_last_error = str(parsed["error"])


## Optional location scope, sent only when non-empty.
func set_location(directory: String, workspace_id: String = "") -> void:
	_directory = directory
	_workspace_id = workspace_id


## Begin a JSON request. Returns a request id, or -1 with last_error() set.
func request(method: int, path: String, body: Dictionary = {}) -> int:
	return _begin(method, path, body, false)


## Begin an SSE stream at `path`. Returns a request id, or -1 on error.
func stream(path: String) -> int:
	return _begin(HTTPClient.METHOD_GET, path, {}, true)


## Advance I/O within a per-frame budget. Call once per frame. Returns the events
## produced since the last call. One socket poll per request happens per call,
## and buffered body bytes are drained until the budget is spent, so this returns
## promptly instead of spinning through the whole frame.
func poll(budget_ms: int = 4) -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	if _requests.is_empty():
		return events
	var deadline_ms := Time.get_ticks_msec() + maxi(budget_ms, 0)
	var in_flight: Array = _requests.values()
	for value in in_flight:
		var pending: _Request = value
		_advance(pending, events, deadline_ms)
	return events


## Cancel one request. Late results for it are dropped.
func cancel(request_id: int) -> void:
	if not _requests.has(request_id):
		return
	var pending: _Request = _requests[request_id]
	_requests.erase(request_id)
	pending.client.close()


func cancel_all() -> void:
	var in_flight: Array = _requests.keys()
	for value in in_flight:
		cancel(int(value))


func last_error() -> String:
	return _last_error


## One frame step: socket poll, bounded body draining, then whatever terminal
## state that leaves. Unfinished work simply waits for the next call.
func _advance(pending: _Request, events: Array[Dictionary], deadline_ms: int) -> void:
	var client := pending.client
	client.poll()
	var status := client.get_status()
	var elapsed_ms := Time.get_ticks_msec() - pending.started_ms
	if not pending.stream and elapsed_ms > REQUEST_TIMEOUT_MS:
		_fail(pending, events, "request to %s:%d timed out after %d ms" % [_host, _port, REQUEST_TIMEOUT_MS])
		return
	if pending.stream and not pending.response_seen and elapsed_ms > CONNECT_TIMEOUT_MS:
		_fail(pending, events, "stream to %s:%d sent no response header within %d ms" % [_host, _port, CONNECT_TIMEOUT_MS])
		return
	if not pending.sent:
		_send(pending, events, status)
		return
	if client.has_response() and not pending.response_seen:
		pending.response_seen = true
		pending.status_code = client.get_response_code()
		if pending.stream and not _is_success(pending.status_code):
			_fail(pending, events, "stream rejected with HTTP %d" % pending.status_code)
			return
	if _drain(pending, events, deadline_ms):
		return
	if pending.stream:
		_advance_stream(pending, events, status)
		return
	_advance_json(pending, events, status)


## Sends the request once the socket is connected, or reports why it never will.
func _send(pending: _Request, events: Array[Dictionary], status: int) -> void:
	if status == HTTPClient.STATUS_CONNECTED:
		var error := pending.client.request(pending.method, pending.path, pending.headers, pending.body_text)
		if error != OK:
			_fail(pending, events, "could not send the request to %s:%d (error %d)" % [_host, _port, error])
			return
		pending.sent = true
		return
	if status == HTTPClient.STATUS_RESOLVING or status == HTTPClient.STATUS_CONNECTING:
		return
	var failure := _status_failure(status)
	if failure.is_empty():
		failure = "connection to %s:%d closed before the request was sent" % [_host, _port]
	_fail(pending, events, failure)


## Reads body bytes until the frame budget is spent or nothing is buffered.
## HTTPClient serves body bytes only in STATUS_BODY, so the status gates every
## read; a budget stop keeps the rest of the body for the next frame.
func _drain(pending: _Request, events: Array[Dictionary], deadline_ms: int) -> bool:
	if pending.client.get_status() != HTTPClient.STATUS_BODY:
		return false
	var chunk := pending.client.read_response_body_chunk()
	while not chunk.is_empty():
		if pending.stream:
			for raw_event in pending.parser.feed(chunk):
				events.append(_event_entry(pending, raw_event))
		else:
			pending.body.append_array(chunk)
		if Time.get_ticks_msec() >= deadline_ms:
			return true
		if pending.client.get_status() != HTTPClient.STATUS_BODY:
			return false
		chunk = pending.client.read_response_body_chunk()
	return false


## A JSON request settles on exactly one terminal entry.
func _advance_json(pending: _Request, events: Array[Dictionary], status: int) -> void:
	if status == HTTPClient.STATUS_BODY or status == HTTPClient.STATUS_REQUESTING:
		return
	if not pending.response_seen:
		_fail(pending, events, "connection to %s:%d closed before a response was received" % [_host, _port])
		return
	var connection_failed := status == HTTPClient.STATUS_CONNECTION_ERROR or status == HTTPClient.STATUS_TLS_HANDSHAKE_ERROR
	_finish_body(pending, events, connection_failed)


## The buffered bytes decide the outcome: a socket error can arrive after a
## complete body was already buffered, so only an unparseable body becomes one.
func _finish_body(pending: _Request, events: Array[Dictionary], connection_failed: bool) -> void:
	var text := pending.body.get_string_from_utf8()
	var parsed: Variant = _parse_json(text)
	if typeof(parsed) == TYPE_DICTIONARY:
		_settle(pending, events, _entry(pending.id, KIND_RESPONSE, pending.status_code, parsed, {}, ""))
		return
	if connection_failed:
		_fail(pending, events, "connection to %s:%d failed before the response completed" % [_host, _port])
		return
	if text.strip_edges().is_empty() and _is_success(pending.status_code):
		_settle(pending, events, _entry(pending.id, KIND_RESPONSE, pending.status_code, {}, {}, ""))
		return
	_fail(pending, events, "HTTP %d returned a body that is not a JSON object" % pending.status_code)


## A stream ends as `closed`, or as `error` when framing or the connection broke.
## An event still unterminated at close is discarded, never dispatched.
func _advance_stream(pending: _Request, events: Array[Dictionary], status: int) -> void:
	if not pending.parser.last_error().is_empty():
		_fail(pending, events, "SSE framing failed: %s" % pending.parser.last_error())
		return
	if status == HTTPClient.STATUS_BODY or status == HTTPClient.STATUS_REQUESTING:
		return
	if status == HTTPClient.STATUS_CONNECTION_ERROR or status == HTTPClient.STATUS_TLS_HANDSHAKE_ERROR:
		_fail(pending, events, "stream connection to %s:%d failed" % [_host, _port])
		return
	if not pending.response_seen:
		_fail(pending, events, "stream to %s:%d closed before any response header" % [_host, _port])
		return
	var note := ""
	if pending.parser.has_pending():
		note = "unfinished trailing event discarded at end of stream"
	_settle(pending, events, _entry(pending.id, KIND_CLOSED, pending.status_code, {}, {}, note))


## Framing and JSON validation stay separate concerns: a payload that is not JSON
## is reported on its own entry without killing the stream.
func _event_entry(pending: _Request, raw: Dictionary) -> Dictionary:
	var payload: Variant = _parse_json(str(raw.get("data", "")))
	var event := {
		"event": str(raw.get("event", "")),
		"id": str(raw.get("id", "")),
		"retry": int(raw.get("retry", -1)),
		"data": payload,
		"raw": str(raw.get("data", "")),
	}
	var error := "" if typeof(payload) != TYPE_NIL else "SSE event data is not valid JSON"
	return _entry(pending.id, KIND_EVENT, pending.status_code, {}, event, error)


## A malformed payload is a handled outcome here, so parse without the engine
## error that JSON.parse_string prints for input this transport already reports.
func _parse_json(text: String) -> Variant:
	var json := JSON.new()
	if json.parse(text) != OK:
		return null
	return json.get_data()


func _begin(method: int, path: String, body: Dictionary, is_stream: bool) -> int:
	if _host.is_empty():
		_last_error = "HttpTransport is not configured; call configure() with an absolute base_url"
		return -1
	var pending := _Request.new()
	pending.id = _next_id
	pending.method = method
	pending.path = "%s/%s" % [_base_path, path.lstrip("/")]
	pending.stream = is_stream
	pending.body_text = JSON.stringify(body) if not body.is_empty() else ""
	pending.headers = _headers(not pending.body_text.is_empty(), is_stream)
	pending.started_ms = Time.get_ticks_msec()
	if is_stream:
		pending.parser = SseParser.new()
	pending.client = HTTPClient.new()
	var error := pending.client.connect_to_host(_host, _port, _tls_options())
	if error != OK:
		_last_error = "could not start a connection to %s:%d (error %d)" % [_host, _port, error]
		return -1
	_requests[pending.id] = pending
	_next_id += 1
	_last_error = ""
	return pending.id


func _settle(pending: _Request, events: Array[Dictionary], entry: Dictionary) -> void:
	events.append(entry)
	_requests.erase(pending.id)
	pending.client.close()


func _fail(pending: _Request, events: Array[Dictionary], message: String) -> void:
	_last_error = message
	_settle(pending, events, _entry(pending.id, KIND_ERROR, pending.status_code, {}, {}, message))


func _entry(request_id: int, kind: String, status: int, body: Dictionary, event: Dictionary, error: String) -> Dictionary:
	return {
		"request_id": request_id,
		"kind": kind,
		"status": status,
		"body": body,
		"event": event,
		"error": error,
	}


## Per-request headers. Credentials are sent only when a password is configured
## and the location scope only when it is set.
func _headers(has_body: bool, is_stream: bool) -> PackedStringArray:
	var headers := PackedStringArray()
	if not _password.is_empty():
		headers.append("Authorization: Basic %s" % _basic_credentials())
	if is_stream:
		headers.append("Accept: text/event-stream")
	if has_body:
		headers.append("Content-Type: application/json")
	if not _directory.is_empty():
		headers.append("x-ycoding-directory: %s" % encode(_directory))
	if not _workspace_id.is_empty():
		headers.append("x-ycoding-workspace: %s" % _workspace_id)
	return headers


## The location header's own encoding.
##
## The service reads this header and runs `decodeURIComponent` on it
## (packages/server/src/location.ts:34), so the value must be URI-ENCODED. Sending the raw
## path corrupted every folder whose name contains a percent sign - the server decoded an
## escape this client never wrote - and made a folder whose name contains non-ASCII
## characters fail outright with HTTP 500, because a raw non-ASCII byte in a header is not
## a valid header value.
##
## Pure and static so the rule is asserted directly: a stub transport never sees the
## headers Godot actually puts on the wire, so a test through a double could not catch this.
static func encode(directory: String) -> String:
	return directory.uri_encode()


func _basic_credentials() -> String:
	return Marshalls.raw_to_base64(("%s:%s" % [_username, _password]).to_utf8_buffer())


## Readable message for a terminal HTTPClient status, or "" when it is not one.
func _status_failure(status: int) -> String:
	match status:
		HTTPClient.STATUS_CANT_RESOLVE:
			return "could not resolve host %s" % _host
		HTTPClient.STATUS_CANT_CONNECT:
			return "could not connect to %s:%d" % [_host, _port]
		HTTPClient.STATUS_TLS_HANDSHAKE_ERROR:
			return "TLS handshake failed for %s:%d" % [_host, _port]
		HTTPClient.STATUS_CONNECTION_ERROR:
			return "connection error for %s:%d" % [_host, _port]
	return ""


func _tls_options() -> TLSOptions:
	if _tls:
		return TLSOptions.client()
	return null


func _is_success(status: int) -> bool:
	return status >= 200 and status < 300


## Splits an absolute base URL into host, port, optional path prefix and scheme.
## Every key is always present; `error` is non-empty only when it cannot be used.
func _split_base_url(base_url: String) -> Dictionary:
	var trimmed := base_url.strip_edges()
	var tls := trimmed.begins_with("https://")
	var scheme_width := 0
	if tls:
		scheme_width = 8
	elif trimmed.begins_with("http://"):
		scheme_width = 7
	else:
		return _invalid_base_url(trimmed, "base_url must be absolute (http:// or https://)")
	var remainder := trimmed.substr(scheme_width)
	var slash := remainder.find("/")
	var authority := remainder if slash < 0 else remainder.substr(0, slash)
	var base_path := "" if slash < 0 else remainder.substr(slash).rstrip("/")
	if authority.is_empty():
		return _invalid_base_url(trimmed, "base_url has no host")
	var host := authority
	var port_text := ""
	if authority.begins_with("["):
		var closing := authority.find("]")
		if closing < 0:
			return _invalid_base_url(trimmed, "IPv6 host is missing its closing bracket")
		host = authority.substr(1, closing - 1)
		port_text = authority.substr(closing + 1)
		if port_text.begins_with(":"):
			port_text = port_text.substr(1)
	else:
		var parts := authority.rsplit(":", true, 1)
		if parts.size() == 2:
			host = parts[0]
			port_text = parts[1]
	var port := 443 if tls else 80
	if not port_text.is_empty():
		if not port_text.is_valid_int():
			return _invalid_base_url(trimmed, "port is not a number")
		port = port_text.to_int()
	if host.is_empty():
		return _invalid_base_url(trimmed, "base_url has no host")
	if port <= 0 or port > 65535:
		return _invalid_base_url(trimmed, "port is out of range")
	return {"host": host, "port": port, "base_path": base_path, "tls": tls, "error": ""}


func _invalid_base_url(base_url: String, reason: String) -> Dictionary:
	return {
		"host": "",
		"port": 0,
		"base_path": "",
		"tls": false,
		"error": "%s: %s" % [reason, base_url],
	}


## One in-flight request. Owned by the transport and dropped when it settles.
class _Request:
	var id: int = 0
	var client: HTTPClient = null
	var method: int = HTTPClient.METHOD_GET
	var path: String = ""
	var body_text: String = ""
	var headers: PackedStringArray = PackedStringArray()
	var stream: bool = false
	var parser: SseParser = null
	var status_code: int = 0
	var body: PackedByteArray = PackedByteArray()
	var response_seen: bool = false
	var sent: bool = false
	var started_ms: int = 0
