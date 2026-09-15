## LIVE transport.
##
## The same surface as DemoTransport — a signal, play/stop, and a clock — backed
## by a real YCoding service instead of a fixture. Presenting one interface for
## both modes is what lets the store and the directors stay mode-agnostic.
##
## Two differences are deliberate and visible:
##   * LIVE has no clock. `advance` polls the socket; nothing is synthesised.
##   * A LIVE session is never replayed from the start. The global feed is
##     volatile by contract, so a reconnect rejoins live and gaps are recovered
##     from the durable per-session log, not by pretending the feed is reliable.
class_name LiveTransport
extends RefCounted

signal event_ready(event: Dictionary)
signal connection_changed(state: String)
signal failure(message: String)
## Emitted when the feed cannot be resumed and the projection must be reloaded.
## The composition root answers this with a canonical reload.
signal reload_required(epoch: String)
## A completed canonical reload: the ordered frames to replay, and the epoch they
## belong to. Emitted only when every requested session log has answered.
signal reload_ready(frames: Array, epoch: String)
## The reload could not be completed, with a reason. The projection stays stale.
signal reload_failed(reason: String)

## Poll budget per frame. Bounded so an idle transport never blocks the renderer.
const POLL_BUDGET_MS := 2

var _transport: HttpTransport
var _base_url: String = ""
var _connected := false
var _running := false
var _last_error := ""
## The event feed is subscribed once; reconnects re-issue it explicitly.
var _stream_id := 0
## The epoch the service reported. A reload is stamped with it, so the store never
## claims a watermark from a different process generation.
var _epoch := ""
## Reload bookkeeping. The session list is read first; each session's durable log
## is then replayed into one ordered batch, so the projection is rebuilt from the
## service rather than from whatever the volatile feed happened to deliver.
var _reloading := false
var _pending_sessions: Array = []
var _replay: Array = []
var _replay_have := 0
var _replay_need := 0
var _reload_list_id := 0
var _reload_log_ids: Dictionary = {}


## Point at a service. Does not connect; call `play`.
func configure(base_url: String, username: String = "ycoding", password: String = "") -> String:
	_base_url = base_url.strip_edges()
	if _base_url.is_empty():
		return "A server address is required."
	_transport = HttpTransport.new()
	_transport.configure(_base_url, username, password)
	return ""


## Forward the session scope. Session routes derive their own location, so this is
## only needed for the location-scoped routes such as the model list.
func set_location(directory: String, workspace_id: String = "") -> void:
	if _transport != null:
		_transport.set_location(directory, workspace_id)


func play() -> void:
	if _transport == null:
		_fail("The transport is not configured.")
		return
	_running = true
	_set_connected(false, OfficeStore.CONNECTION_SYNCING)
	# Health first so a wrong address or password fails loudly instead of showing
	# an empty office that looks like a working session with no agents.
	_transport.request(HTTPClient.METHOD_GET, Gateway.HEALTH, {})
	_stream_id = _transport.stream(Gateway.EVENT_STREAM)


func stop() -> void:
	_running = false
	if _transport != null:
		_transport.cancel_all()
	_set_connected(false, OfficeStore.CONNECTION_DISCONNECTED)


func is_playing() -> bool:
	return _running


func is_synthetic() -> bool:
	return false


func last_error() -> String:
	return _last_error


## Poll the socket. Called every frame, so it must never block: the transport
## yields a bounded budget and returns whatever arrived.
func advance(_delta_ms: int) -> void:
	if not _running or _transport == null:
		return
	for entry in _transport.poll(POLL_BUDGET_MS):
		_handle(entry)


func _handle(entry: Dictionary) -> void:
	var kind := str(entry.get("kind", ""))
	var request_id := int(entry.get("request_id", -1))
	if kind == "response":
		_on_response(request_id, entry)
		return
	if kind == "event":
		if _reloading and _reload_log_ids.has(request_id):
			_collect_frame(request_id, entry)
			return
		# An SSE entry carries the SSE *envelope*: `data` is the decoded wire event
		# and `event`/`id`/`retry` are SSE fields the server never sets. The store
		# consumes wire events, so the payload is what gets emitted, not the
		# envelope. Emitting the envelope would deliver every real event with no
		# `type`, which is indistinguishable from a frame the projection ignores.
		var envelope: Variant = entry.get("event", {})
		if envelope is not Dictionary:
			return
		var payload: Variant = envelope.get("data", null)
		if payload is Dictionary:
			_emit(payload)
		return
	if kind == "error":
		var message := str(entry.get("error", "request failed"))
		# A dropped feed is a connection problem, and the feed is volatile by
		# contract, so anything that arrived during the gap is simply lost. Ask
		# for a reload rather than pretending the stream resumed.
		_set_connected(false, OfficeStore.CONNECTION_RECONNECTING)
		_fail(message)
		reload_required.emit(_epoch)


func _on_response(request_id: int, entry: Dictionary) -> void:
	var status := int(entry.get("status", 0))
	var body: Dictionary = entry.get("body", {})
	if request_id == _stream_id:
		return
	if _reloading and request_id == _reload_list_id:
		_reload_list_id = 0
		if not _is_success(status):
			_reload_failed("The session list could not be read (HTTP %d)." % status)
			return
		_begin_session_replays(body)
		return

	if not _is_success(status):
		_set_connected(false, OfficeStore.CONNECTION_DISCONNECTED)
		_fail("The service returned HTTP %d." % status)
		return
	# A health response is the signal that the service is reachable. `sourceEpoch`
	# is what the store stamps onto every read, so it is emitted as a connection
	# frame rather than kept private here.
	var epoch := str(body.get("sourceEpoch", ""))
	if not epoch.is_empty():
		if not _epoch.is_empty() and epoch != _epoch:
			# A restarted service is a new world: everything held is stale.
			reload_required.emit(epoch)
		_epoch = epoch
	_set_connected(true, OfficeStore.CONNECTION_LIVE)
	_emit({
		"id": "live:connected",
		"type": Wire.CONNECTED,
		"data": {},
		"sourceEpoch": epoch,
	})


## Emit one wire event exactly as the service framed it.
##
## The durable block is carried through when present, so the store sees the same
## shape it would from any other source.
func _emit(event: Dictionary) -> void:
	event_ready.emit(event)


func epoch() -> String:
	return _epoch


## Rebuild the projection from the service.
##
## The feed is volatile, so a reconnect may have holes. Rather than patch them,
## the sessions are re-listed and each one's durable log is replayed in order.
## `reload_ready` carries the completed batch and is only emitted when every
## requested log has answered, so a partial read can never look like a whole one.
func reload() -> void:
	if _transport == null or not _running:
		return
	_reloading = true
	_pending_sessions.clear()
	_replay.clear()
	_replay_have = 0
	_replay_need = 0
	_reload_log_ids.clear()
	_reload_list_id = _transport.request(HTTPClient.METHOD_GET, Gateway.SESSION_LIST, {})
	if _reload_list_id < 0:
		_reload_failed(_transport.last_error())


func is_reloading() -> bool:
	return _reloading


## Start one log replay per session. A session with no id is skipped rather than
## requested as an empty path, which would 404 and stall the batch.
func _begin_session_replays(body: Dictionary) -> void:
	_pending_sessions = body.get("data", [])
	if not _pending_sessions is Array or _pending_sessions.is_empty():
		_finish_reload()
		return
	_replay_need = 0
	for value in _pending_sessions:
		if not value is Dictionary:
			continue
		var session_id := str(value.get("id", ""))
		if session_id.is_empty():
			continue
		# The log route is StreamSse, so it is opened as a stream rather than as a
		# JSON request. A JSON GET here would never settle.
		var request_id := _transport.stream(Gateway.log(session_id, 0, false))
		if request_id >= 0:
			_reload_log_ids[request_id] = session_id
			_replay_need += 1
	if _replay_need == 0:
		_finish_reload()


## Keep one wire event from a session's log replay.
##
## The replay ends with the `log.synced` watermark, which is bookkeeping rather
## than session state, so it is not applied as an event; it is the signal that
## this session finished and its stream can be closed.
func _collect_frame(request_id: int, entry: Dictionary) -> void:
	var envelope: Variant = entry.get("event", {})
	if not envelope is Dictionary:
		return
	var payload: Variant = envelope.get("data", null)
	if not payload is Dictionary:
		return
	var event: Dictionary = payload
	if str(event.get("type", "")) == Gateway.WATERMARK_TYPE:
		_transport.cancel(request_id)
		_reload_log_ids.erase(request_id)
		_replay_have += 1
		if _replay_have >= _replay_need:
			_finish_reload()
		return
	_replay.append(event)


func _finish_reload() -> void:
	_reloading = false
	reload_ready.emit(_replay.duplicate(), _epoch)


func _reload_failed(reason: String) -> void:
	_reloading = false
	# A reload that did not complete must not present a partial projection as
	# whole. The caller keeps the stale marking and reports the reason.
	reload_failed.emit(reason)


## Admit a prompt into a session.
##
## Returns "" on acceptance or a reason on refusal. The body carries only the
## fields the endpoint declares; `steer` is the default delivery, matching the
## runtime's contract that a prompt joins the current drain when one is running.
##
## The caller supplies a stable id so a retried submission reconciles against the
## already-admitted input instead of being admitted twice.
func submit_prompt(
	session_id: String,
	text: String,
	message_id: String = "",
	delivery: String = "steer"
) -> String:
	if _transport == null or not _running:
		return "The transport is not connected."
	if session_id.strip_edges().is_empty():
		return "There is no session to prompt."
	if text.strip_edges().is_empty():
		return "The prompt is empty."
	var body := {"text": text, "delivery": delivery}
	if not message_id.is_empty():
		body["id"] = message_id
	_transport.request(HTTPClient.METHOD_POST, Gateway.prompt(session_id), body)
	return ""


## Ask the service to switch the session's model.
##
## `model_ref` is the config-string form the composer carries; the wire wants the
## three separate fields, so it is parsed rather than sent verbatim.
func switch_model(session_id: String, model_ref: String) -> String:
	if _transport == null or not _running:
		return "The transport is not connected."
	if session_id.strip_edges().is_empty():
		return "There is no session to switch."
	var ref := ModelCatalog.parse_ref(model_ref)
	if ref.is_empty():
		return "That model reference cannot be parsed."
	var provider_id := str(ref.get("providerID", ""))
	var model_id := str(ref.get("id", ""))
	if provider_id.is_empty() or model_id.is_empty():
		return "That model has no provider or id."
	var body := {"providerID": provider_id, "id": model_id}
	var variant := str(ref.get("variant", ""))
	if not variant.is_empty():
		body["variant"] = variant
	_transport.request(
		HTTPClient.METHOD_POST,
		Gateway.switch_model(session_id),
		{"model": body}
	)
	return ""


## Answer a pending question, permission or guardrail request.
##
## Returns "" on success or a reason on refusal. A malformed reply is refused
## here, so a request the schema would reject never reaches the service.
func reply(request: Dictionary, body: Dictionary) -> String:
	if _transport == null or not _running:
		return "The transport is not connected."
	if request.is_empty():
		return "There is no request to answer."
	var session_id := str(request.get("session_id", ""))
	var request_id := str(request.get("id", ""))
	if session_id.is_empty() or request_id.is_empty():
		return "The request has no session or id."
	var path := ""
	match str(request.get("kind", "")):
		AttentionQueue.KIND_QUESTION:
			path = Gateway.question_reply(session_id, request_id)
		AttentionQueue.KIND_PERMISSION:
			path = Gateway.permission_reply(session_id, request_id)
		AttentionQueue.KIND_GUARDRAIL:
			path = Gateway.guardrail_reply(session_id, request_id)
	if path.is_empty():
		return "That request kind cannot be answered."
	if body.is_empty():
		return "The reply is empty."
	_transport.request(HTTPClient.METHOD_POST, path, body)
	return ""


## Reject a pending question without answering it.
func reject(request: Dictionary) -> String:
	if _transport == null or not _running:
		return "The transport is not connected."
	var session_id := str(request.get("session_id", ""))
	var request_id := str(request.get("id", ""))
	if session_id.is_empty() or request_id.is_empty():
		return "The request has no session or id."
	_transport.request(
		HTTPClient.METHOD_POST,
		Gateway.question_reject(session_id, request_id),
		{}
	)
	return ""


func _set_connected(connected: bool, state: String) -> void:
	if connected == _connected and state == "":
		return
	_connected = connected
	connection_changed.emit(state)


func _fail(message: String) -> void:
	_last_error = message
	failure.emit(message)


func _is_success(status: int) -> bool:
	return status >= 200 and status < 300
