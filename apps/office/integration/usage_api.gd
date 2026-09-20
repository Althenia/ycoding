## Provider-request usage and spend for one session, as the service accounts for it.
##
## `GET /api/session/:sessionID/usage` answers `{data: ProviderRequest.Summary}` - no
## location wrapper, because the handler builds the body directly
## (packages/server/src/handlers/session.ts). The Summary's own docstring is the contract
## this reader honours:
##
##   "Retrieve provider-request usage and recorded or current-catalog-estimated spend after
##    transcript compaction or when cache diagnostics are unavailable. Each priced model row
##    identifies its cost provenance. Root sessions include their descendant subagent family;
##    child sessions remain scoped to themselves."
##
## Two consequences follow, and both are why this is a read and not a computation:
##
##   * the SERVICE decides a session's scope, so the reader records which session it asked
##     about rather than widening the result itself;
##   * the response is required to be REPLAYABLE, so it does not expire into a stale cache.
##
## Nothing here is fabricated. A read that fails, times out, or cannot be parsed yields no
## summary with a readable reason in `last_error()`, and `usage()` then reports that nothing
## is known rather than that nothing was spent.
##
## Credentials belong to the HttpTransport this class drives. It holds no username,
## password, or header, and its messages never carry one.
class_name UsageApi
extends RefCounted

## One frame of socket work per poll, matching the LIVE transport's budget.
const POLL_BUDGET_MS := 4
## Bounded wait for a whole read. A read that exceeds it is abandoned, not waited on.
const DEFAULT_TIMEOUT_MS := 4000

var _transport: HttpTransport = null
var _request_id := -1
var _deadline_ms := 0
var _summary: Dictionary = {}
var _session_id := ""
var _reported := false
var _last_error := ""
## The session the in-flight request was issued for. Held with the REQUEST rather than read
## at settle time, so a response can never be attributed to a session the user has since
## switched away from.
var _pending_session := ""


## Bind the transport that carries the request. It must already be configured with the
## location set, because the session route is location-scoped.
func configure(transport: HttpTransport) -> void:
	_transport = transport
	_request_id = -1
	_deadline_ms = 0
	_summary = {}
	_session_id = ""
	_reported = false
	_last_error = ""
	_pending_session = ""


## True while a read is waiting for its response.
func is_pending() -> bool:
	return _request_id >= 0


## The session the last settled read asked about. "" when it has not settled, so a summary
## is never attributed to a session it did not come from.
func session_id() -> String:
	return _session_id


## The aggregate for the last settled read.
##
## Before a read settles this reports NOTHING as known, which is a different statement from
## reporting that nothing was spent.
func usage() -> SessionUsage:
	if not _reported:
		return SessionUsage.empty()
	return SessionUsage.from_summary(_summary, [_session_id])


## Why the last read produced no summary. "" when nothing failed.
func last_error() -> String:
	return _last_error


## Begin a read for one session.
func start(session_id: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if _transport == null:
		_last_error = "No transport is configured, so session usage cannot be read."
		return false
	if session_id.is_empty():
		_last_error = "No session was named, so there is nothing to read usage for."
		return false
	_summary = {}
	_session_id = ""
	_reported = false
	_last_error = ""
	_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0)
	var request_id := _transport.request(
		HTTPClient.METHOD_GET, Gateway.usage(session_id), {}
	)
	if request_id < 0:
		var reason := _transport.last_error()
		_last_error = reason if not reason.is_empty() else "The usage request could not be issued."
		_request_id = -1
		return false
	# The session is recorded with the REQUEST, so a response can never be attributed to a
	# session the user has since switched away from.
	_pending_session = session_id
	_request_id = request_id
	return true


## Advance the read within `budget_ms`. Returns the usage once the response has settled,
## and the unreported aggregate while it is in flight or after any failure.
func poll(budget_ms: int = POLL_BUDGET_MS) -> SessionUsage:
	if _request_id < 0:
		return usage()
	for value in _transport.poll(budget_ms):
		var entry: Dictionary = value
		if int(entry.get("request_id", -1)) != _request_id:
			continue
		var kind := str(entry.get("kind", ""))
		if kind == HttpTransport.KIND_RESPONSE:
			var settled_session := _pending_session
			_request_id = -1
			_pending_session = ""
			var body: Variant = entry.get("body", {})
			if not _is_success(int(entry.get("status", 0))):
				_last_error = _reason(int(entry.get("status", 0)), body)
				return usage()
			if not (body is Dictionary) or not (body.get("data", null) is Dictionary):
				_summary = {}
				_reported = false
				_last_error = "The usage answer did not carry a summary."
				return usage()
			_summary = body["data"]
			_session_id = settled_session
			_reported = true
			return usage()
		if kind == HttpTransport.KIND_ERROR:
			var reason := str(entry.get("error", ""))
			_request_id = -1
			_pending_session = ""
			_summary = {}
			_reported = false
			_last_error = reason if not reason.is_empty() else "The usage request failed."
			return usage()
	if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:
		_transport.cancel(_request_id)
		_request_id = -1
		_pending_session = ""
		_summary = {}
		_reported = false
		_last_error = "The usage read did not answer within its time budget."
	return usage()


## Drive the read to completion inside one bounded wait.
##
## Prefer `start`/`poll` from a frame loop: this blocks the caller until the response
## settles or the budget runs out. The wait is never longer than `timeout_ms`, because
## `poll` abandons the request at that same deadline, so an unresponsive service costs one
## bounded delay instead of a hang.
func fetch(session_id: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> SessionUsage:
	if not start(session_id, timeout_ms):
		return SessionUsage.empty()
	while _request_id >= 0:
		poll(POLL_BUDGET_MS)
	return usage()


func _is_success(status: int) -> bool:
	return status >= 200 and status < 300


## The service's own refusal, surfaced rather than replaced by a generic message.
func _reason(status: int, body: Variant) -> String:
	if body is Dictionary:
		var message := str(body.get("message", ""))
		if not message.is_empty():
			return message
	return "The usage read was refused with status %d." % status
