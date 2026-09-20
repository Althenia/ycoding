## The canonical conversation read, as the client performs it.
##
## `ConversationHistory` owns the projection and the read state; this owns the REQUEST, so the
## composition root does not have to hold a transport, a request id and a deadline of its own.
## Each module keeps its own transport because two pollers sharing one would each see half the
## answers, which is this codebase's stated contract for every read module.
##
## The route returns the session's whole transcript, ordered, with no pagination: the service
## always answers with the full list. That is why the read is a single request with a bounded
## wait rather than a page walk, and why nothing here invents a partial-history authority.
class_name ConversationApi
extends RefCounted

## One frame of socket work per poll, matching the other read modules.
const POLL_BUDGET_MS := 4
## Bounded wait for a whole read. A read that exceeds it is abandoned, not waited on.
const DEFAULT_TIMEOUT_MS := 6000

var history: ConversationHistory = ConversationHistory.new()

var _transport: HttpTransport = null
var _request_id := -1
var _session_id := ""
var _deadline_ms := 0
var _last_error := ""


## Bind the transport that carries the read. It must already be configured with the location
## set, because every session route is location-scoped.
func configure(transport: HttpTransport) -> void:
	_transport = transport
	_request_id = -1
	_session_id = ""
	_deadline_ms = 0
	_last_error = ""


func last_error() -> String:
	return _last_error


func is_pending() -> bool:
	return _request_id >= 0


## Begin reading a session's history. False means the read could not be issued and
## `last_error()` explains.
##
## A read already in flight for the SAME session is left alone, so selecting the session
## again does not restart it. A read for a DIFFERENT session is started, which is what makes
## the answer to the session left behind arrive as a late answer rather than as the current
## history.
func start(session_id: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if _transport == null:
		_last_error = "No transport is configured, so the history cannot be read."
		return false
	if session_id.strip_edges().is_empty():
		_last_error = "There is no session whose history could be read."
		return false
	if _request_id >= 0 and session_id == _session_id:
		return true
	if _request_id >= 0:
		# The previous read is for a session the user has left. It is cancelled rather than
		# left to be drained, and its answer would not be installed anyway.
		_transport.cancel(_request_id)
		_request_id = -1
	_session_id = session_id
	_last_error = ""
	history.start(session_id)
	_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0)
	var request_id := _transport.request(HTTPClient.METHOD_GET, Gateway.messages(session_id), {})
	if request_id < 0:
		var reason := _transport.last_error()
		_last_error = reason if not reason.is_empty() else "The history request could not be issued."
		history.fail(session_id, _last_error)
		return false
	_request_id = request_id
	return true


## Advance the read within `budget_ms`. Called once per frame, so it never blocks.
func poll(budget_ms: int = POLL_BUDGET_MS) -> void:
	if _request_id < 0:
		return
	for value in _transport.poll(budget_ms):
		var entry: Dictionary = value
		if int(entry.get("request_id", -1)) != _request_id:
			continue
		var kind := str(entry.get("kind", ""))
		if kind == HttpTransport.KIND_RESPONSE:
			_request_id = -1
			_settle(entry)
			return
		if kind == HttpTransport.KIND_ERROR:
			var reason := str(entry.get("error", ""))
			_request_id = -1
			_last_error = reason if not reason.is_empty() else "The history request failed."
			history.fail(_session_id, _last_error)
			return
	if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:
		_transport.cancel(_request_id)
		_request_id = -1
		_last_error = "The history did not answer within its time budget."
		history.fail(_session_id, _last_error)


## One settled answer. A non-2xx status is never read as a history, so a refusal cannot empty
## a screen that was showing something true.
func _settle(entry: Dictionary) -> void:
	var status := int(entry.get("status", 0))
	if status < 200 or status >= 300:
		_last_error = "The service answered the history with HTTP %d." % status
		history.fail(_session_id, _last_error)
		return
	var body: Variant = entry.get("body", {})
	if not (body is Dictionary):
		_last_error = "The history response was not a JSON object."
		history.fail(_session_id, _last_error)
		return
	var data: Variant = (body as Dictionary).get(Gateway.ENVELOPE_DATA, null)
	if not (data is Array):
		_last_error = "The history response carried no message list."
		history.fail(_session_id, _last_error)
		return
	_last_error = ""
	# An empty list is a real answer about a session with no messages, so it installs as
	# empty rather than reading as unread and being awaited forever.
	history.install(_session_id, data)
