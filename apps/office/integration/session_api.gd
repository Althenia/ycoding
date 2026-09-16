## Session lifecycle operations the office UI exposes but no transport performed.
##
## Two operations only, and both follow LiveTransport.submit_prompt's contract: a
## guard clause returns a readable reason, or "" when the request was issued. The
## result is asynchronous for the same reason every other call here is — the
## transport is polled per frame — so `poll` routes the answer to signals and to
## the accessors below.
##
## Hand this class its own HttpTransport. `poll` consumes only the entries for the
## requests this module issued and returns the rest, but two pollers sharing one
## transport would each see half the entries.
##
## Routes come from Gateway and are never re-declared here.
class_name SessionApi
extends RefCounted

## The session the service created. It assigns the id, so it cannot be known when
## the request is issued.
signal session_created(session_id: String)
## The create was refused by the service, or by the connection to it.
signal create_failed(reason: String)
## The interrupt completed successfully.
signal interrupted(session_id: String)
## The interrupt was refused. The session is named because the caller asked about
## one specific session.
signal interrupt_failed(session_id: String, reason: String)

## Intent per in-flight request, so a late answer is routed to the operation that
## issued it rather than read as whichever one happens to finish first.
const INTENT_CREATE := "create"
const INTENT_INTERRUPT := "interrupt"

## The fields `session.create` declares, and nothing else. `parentID` is absent
## deliberately: a child session is created by launching a subagent.
const CREATE_LOCATION := "location"
const CREATE_AGENT := "agent"
const CREATE_MODEL := "model"

var _transport: HttpTransport
var _pending: Dictionary = {}
## Interrupt request id -> session id, so a refusal can name the session.
var _interrupt_sessions: Dictionary = {}
## The id of the most recent request, kept so a test can produce the answer a poll
## would have delivered without a listening socket.
var _last_request_id: int = 0
var _created_session: String = ""
var _last_error: String = ""


func _init(transport: HttpTransport = null) -> void:
	_transport = transport


## The path `session.create` posts to: `POST /api/session`.
static func create_path() -> String:
	return Gateway.SESSION_LIST


## The path `session.interrupt` posts to: `POST /api/session/:sessionID/interrupt`.
static func interrupt_path(session_id: String) -> String:
	return Gateway.interrupt(session_id)


## The create body, carrying only the fields the endpoint accepts.
##
## Every declared field is optional, but a request with no body at all is refused
## before it is decoded ("Expected object, got undefined" from a real service),
## and the transport sends no body for an empty object. So the caller must supply
## at least one real input; this function never invents one.
static func create_body(directory: String, agent: String, model_ref: String) -> Dictionary:
	var body := {}
	if not directory.strip_edges().is_empty():
		body[CREATE_LOCATION] = {"directory": directory.strip_edges()}
	if not agent.strip_edges().is_empty():
		body[CREATE_AGENT] = agent.strip_edges()
	if not model_ref.strip_edges().is_empty():
		var ref := ModelCatalog.parse_ref(model_ref)
		if not ref.is_empty():
			var model := {"providerID": str(ref.get("providerID", "")), "id": str(ref.get("id", ""))}
			var variant := str(ref.get("variant", ""))
			if not variant.is_empty():
				model["variant"] = variant
			body[CREATE_MODEL] = model
	return body


## Create a root session at `directory`, with an optional agent and model.
##
## Returns "" when the request was issued, or a reason when it was refused. The
## created id is not known yet: read it from `session_created` or
## `last_created_session` once `poll` has routed the response.
func create_session(directory: String = "", agent: String = "", model_ref: String = "") -> String:
	if _transport == null:
		return "The transport is not connected."
	var body := create_body(directory, agent, model_ref)
	if body.is_empty():
		return "A new session needs a location, an agent or a model."
	var request_id := _transport.request(HTTPClient.METHOD_POST, create_path(), body)
	if request_id < 0:
		return _transport.last_error()
	_pending[request_id] = INTENT_CREATE
	_last_request_id = request_id
	return ""


## Interrupt whatever this service is running for `session_id`.
##
## Returns "" when the request was issued, or a reason when it was refused. An
## idle session is a no-op on the service, which answers 204.
func interrupt_session(session_id: String) -> String:
	if _transport == null:
		return "The transport is not connected."
	var id := session_id.strip_edges()
	if id.is_empty():
		return "There is no session to interrupt."
	# The endpoint declares no payload, so no body is sent; a body here would be
	# an invention the route never reads.
	var request_id := _transport.request(HTTPClient.METHOD_POST, interrupt_path(id), {})
	if request_id < 0:
		return _transport.last_error()
	_pending[request_id] = INTENT_INTERRUPT
	_interrupt_sessions[request_id] = id
	_last_request_id = request_id
	return ""


func is_creating() -> bool:
	for intent in _pending.values():
		if str(intent) == INTENT_CREATE:
			return true
	return false


## The session the last successful create returned, or "" when there is not one.
func last_created_session() -> String:
	return _created_session


func last_error() -> String:
	return _last_error


## Advance the socket within a budget and route this module's answers.
##
## Returns the entries it did not consume, so a caller that shares the transport
## can still handle its own. The budget is the transport's own bound: this method
## never loops, so it cannot spin.
func poll(budget_ms: int = 4) -> Array[Dictionary]:
	var leftover: Array[Dictionary] = []
	if _transport == null:
		return leftover
	for entry in _transport.poll(budget_ms):
		if not _handle_entry(entry):
			leftover.append(entry)
	return leftover


## Route one transport entry. Returns true when it belonged to this module.
func _handle_entry(entry: Dictionary) -> bool:
	var request_id := int(entry.get("request_id", -1))
	if not _pending.has(request_id):
		return false
	var intent := str(_pending[request_id])
	match str(entry.get("kind", "")):
		"response":
			_pending.erase(request_id)
			_on_response(intent, request_id, entry)
		"error":
			_pending.erase(request_id)
			_on_failure(intent, request_id, str(entry.get("error", "")))
		"closed":
			# Neither operation streams, so a closed connection means the answer
			# never arrived.
			_pending.erase(request_id)
			_on_failure(intent, request_id, "The service closed the connection before answering.")
	return true


func _on_response(intent: String, request_id: int, entry: Dictionary) -> void:
	var status := int(entry.get("status", 0))
	if intent == INTENT_CREATE:
		if not _is_success(status):
			_refuse_create("The service refused to create a session (%s)." % _reason(status, entry))
			return
		var body: Dictionary = entry.get("body", {})
		var data: Variant = body.get(Gateway.ENVELOPE_DATA, {})
		var session_id := ""
		if data is Dictionary:
			session_id = str((data as Dictionary).get("id", ""))
		if session_id.is_empty():
			_refuse_create("The service created a session but returned no id.")
			return
		_created_session = session_id
		_last_error = ""
		session_created.emit(session_id)
		return
	var session_id := _take_interrupt_session(request_id)
	if not _is_success(status):
		_refuse_interrupt(session_id, "%s could not be interrupted (%s)." % [
			_session_label(session_id),
			_reason(status, entry),
		])
		return
	_last_error = ""
	interrupted.emit(session_id)


func _on_failure(intent: String, request_id: int, message: String) -> void:
	var reason := message if not message.is_empty() else "The request failed."
	if intent == INTENT_CREATE:
		_refuse_create(reason)
		return
	_refuse_interrupt(_take_interrupt_session(request_id), reason)


func _refuse_create(reason: String) -> void:
	_last_error = reason
	create_failed.emit(reason)


func _refuse_interrupt(session_id: String, reason: String) -> void:
	_last_error = reason
	interrupt_failed.emit(session_id, reason)


func _take_interrupt_session(request_id: int) -> String:
	var session_id := str(_interrupt_sessions.get(request_id, ""))
	_interrupt_sessions.erase(request_id)
	return session_id


## The service's own message, prefixed with the status so a refusal always names
## the HTTP outcome even when the body carries no message.
func _reason(status: int, entry: Dictionary) -> String:
	var body: Variant = entry.get("body", {})
	var detail := ""
	if body is Dictionary:
		detail = str((body as Dictionary).get("message", ""))
	if detail.is_empty():
		return "HTTP %d" % status
	return "HTTP %d: %s" % [status, detail]


func _session_label(session_id: String) -> String:
	if session_id.is_empty():
		return "The session"
	return session_id


func _is_success(status: int) -> bool:
	return status >= 200 and status < 300
