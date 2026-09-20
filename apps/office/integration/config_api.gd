## The location-scoped configuration owner, over HTTP.
##
## `server.config` is an ADDITIVE surface over the same `@ycoding/v2/Config` owner the
## runtime uses: this class adds no second store and no client-side merge. It reads the
## effective values, previews a patch, and commits one, all through:
##
##   GET  /api/config          -> Location.response(Config.Read)
##   POST /api/config/preview  -> Location.response(Config.Preview)
##   PUT  /api/config          -> Location.response(Config.Commit)
##
## Four contract facts shape everything here, each verified against the live Schema
## (`packages/schema/src/config.ts`) and the spec (`specs/v2/configuration-api.md`):
##
##   * EVERY response is wrapped as `{location, data}`, so the payload is `body["data"]`,
##     never the body itself. The resolved Location comes back with it, which is what
##     lets the client report WHICH location the values describe.
##   * `Config.Patch` accepts only `global` or `project`. There is no session scope and
##     no folder scope in the API: those are not configuration files. The client must
##     therefore never claim one.
##   * `expectedRevision` is the concurrency guard. A mismatch fails the write with HTTP
##     400 rather than overwriting a concurrent edit, so a stale revision is actionable
##     and not retried blindly.
##   * Reads REWRITE secret-bearing values to `[redacted]`. A value read back as
##     `[redacted]` is a configured-but-concealed value, not the literal text, and it
##     must never be written back: doing so would replace a real credential with the
##     sentinel. This class refuses that write locally, before any request is issued.
##
## Credentials belong to the HttpTransport this class drives. It holds no username,
## password, header, or credential value, and its messages never carry one.
class_name ConfigApi
extends RefCounted

## One frame of socket work per poll, matching the other readers' budget.
const POLL_BUDGET_MS := 4
## Bounded wait for one call. A call that exceeds it is abandoned, not waited on.
const DEFAULT_TIMEOUT_MS := 5000

## The two write scopes the API accepts, exactly. A third would have no route.
const WRITE_GLOBAL := "global"
const WRITE_PROJECT := "project"

## The sentinel the service substitutes for secret-bearing values.
const REDACTED := "[redacted]"

## A call kind, so a settled answer is never mistaken for another call's.
const KIND_READ := "read"
const KIND_PREVIEW := "preview"
const KIND_COMMIT := "commit"

## GET /api/config
const CONFIG_PATH := "/api/config"
## POST /api/config/preview
const PREVIEW_PATH := "/api/config/preview"

var _transport: HttpTransport = null
## The call in flight, and its kind. Held together so an answer can never be installed
## for a different call than the one that asked.
var _request_id := -1
var _request_kind := ""
var _deadline_ms := 0
var _last_error := ""

## The last settled read, and the location it describes.
var _read: Dictionary = {}
var _read_location: Dictionary = {}
## The last settled preview, and the last settled commit.
var _preview: Dictionary = {}
var _commit: Dictionary = {}


func configure(transport: HttpTransport) -> void:
	# Rebinding to another transport must cancel whatever the OLD one had in flight. The
	# request was issued against the previous location's document, so its answer must never
	# be adopted for the new one, and nothing would poll it any more.
	if _transport != null and _transport != transport:
		cancel_pending()
	_transport = transport
	_request_id = -1
	_request_kind = ""
	_deadline_ms = 0
	_last_error = ""
	_read = {}
	_read_location = {}
	_preview = {}
	_commit = {}


## True while a call is waiting for its response.
func is_pending() -> bool:
	return _request_id >= 0


## Cancel the call in flight, if any.
##
## Called when the reader is rebound to another location: the request was issued against
## the document of the OLD location, so its answer must never be adopted for the new one.
func cancel_pending() -> void:
	if _request_id >= 0 and _transport != null:
		_transport.cancel(_request_id)
	_finish()


## The kind of the call in flight, or "" when none is.
func pending_kind() -> String:
	return _request_kind


## Why the last call failed. "" when nothing failed.
func last_error() -> String:
	return _last_error


## The last settled read, or {} before one settles. Never carries resolved secrets:
## the service redacts them and this class does not undo that.
func read_values() -> Dictionary:
	return (_read.get("values", {}) as Dictionary).duplicate(true)


## The documents that contributed to the effective values, lowest priority first.
func sources() -> Array:
	var listed: Variant = _read.get("sources", [])
	return (listed as Array).duplicate(true) if listed is Array else []


## The location the last read resolved, so a caller can state what the values describe.
func resolved_location() -> Dictionary:
	return (_read_location.get("location", {}) as Dictionary).duplicate(true)


## The last settled preview, or {}.
func preview() -> Dictionary:
	return _preview.duplicate(true)


## The last settled commit, or {}.
func commit() -> Dictionary:
	return _commit.duplicate(true)


## The revision of the document a write should be validated against for `scope`.
##
## Taken from the most recent read or preview that named that scope and document, so the
## guard is the revision the client actually saw. "" when nothing has been read, in which
## case the write is sent without a guard rather than with an invented one.
## The revision of the document a write to `scope` would TARGET, from the last read.
##
## Discovery can find several documents of one scope; the owner writes to the LAST one in
## priority order (`targetOf` uses `findLast`), so the guard must come from that document.
## Using the first match would guard a write with another document's revision.
##
## A settled preview for the scope takes precedence: it reports the target's revision
## directly, which is the exact value that must be passed back to commit.
func target_revision_for(scope: String) -> String:
	if not _preview.is_empty() and str(_preview.get("scope", "")) == scope:
		return str(_preview.get("revision", ""))
	var found := ""
	for value in sources():
		var source: Dictionary = value
		if str(source.get("scope", "")) != scope:
			continue
		var revision := str(source.get("revision", ""))
		# Ascending priority, so the LAST non-empty revision is the target's.
		if not revision.is_empty():
			found = revision
	return found


## The scope a write for `scope` would target, retained for callers that only need the
## revision. Kept as the older name for the same decision.
func revision_for(scope: String) -> String:
	return target_revision_for(scope)


## Whether a value read back is the service's REDACTED sentinel rather than real text.
##
## A `[redacted]` value is a configured secret whose content the service withholds. It is
## not writable: sending it back would store the sentinel in place of the credential.
static func is_redacted(value: Variant) -> bool:
	return value is String and str(value) == REDACTED


## Whether a patch would write a withheld value back over a real one.
##
## Returns a readable reason when it would, and "" when the patch is safe to send. Nested
## containers are walked, because a redacted leaf the client never edited sits inside the
## same subtree the API replaces whole.
static func withheld_write_reason(patch: Dictionary) -> String:
	for key in _redacted_paths(patch, ""):
		return (
			"This patch would write the service's redacted placeholder back for '%s'. "
			+ "A withheld value cannot be re-sent; edit the field with a new value or leave it alone."
		) % key
	return ""


static func _redacted_paths(value: Variant, path: String) -> Array[String]:
	var found: Array[String] = []
	if is_redacted(value):
		found.append(path if not path.is_empty() else "(root)")
		return found
	if value is Dictionary:
		for key in (value as Dictionary):
			found.append_array(
				_redacted_paths((value as Dictionary)[key], str(key) if path.is_empty() else "%s.%s" % [path, str(key)])
			)
	elif value is Array:
		for index in (value as Array).size():
			found.append_array(_redacted_paths((value as Array)[index], "%s[%d]" % [path, index]))
	return found


## Begin a read of the effective configuration for the transport's location.
func start_read(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if not _can_call():
		return false
	_read = {}
	_read_location = {}
	_last_error = ""
	return _begin(HTTPClient.METHOD_GET, CONFIG_PATH, {}, KIND_READ, timeout_ms)


## Begin a preview of `patch` against `scope`. Writes nothing.
##
## `expected_revision` is optional: when empty, the revision the client last saw for that
## scope is used, and when there is none the call is made without a guard.
func start_preview(patch: Dictionary, scope: String, expected_revision: String = "", timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if not _can_call():
		return false
	var refusal := _patch_refusal(patch, scope, "preview")
	if not refusal.is_empty():
		_last_error = refusal
		return false
	_preview = {}
	_last_error = ""
	var body := _patch_body(patch, scope, expected_revision)
	return _begin(HTTPClient.METHOD_POST, PREVIEW_PATH, body, KIND_PREVIEW, timeout_ms)


## Begin a commit of `patch` to `scope`. This is the only writing call.
##
## The revision guard is attached by default: a commit without one would overwrite a
## concurrent edit silently, which is the failure the guard exists to prevent. Passing an
## explicit `expected_revision` overrides what the client last saw, so a caller can commit
## a preview it is holding.
func start_commit(patch: Dictionary, scope: String, expected_revision: String = "", timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if not _can_call():
		return false
	var refusal := _patch_refusal(patch, scope, "commit")
	if not refusal.is_empty():
		_last_error = refusal
		return false
	_commit = {}
	_last_error = ""
	var body := _patch_body(patch, scope, expected_revision)
	return _begin(HTTPClient.METHOD_PUT, CONFIG_PATH, body, KIND_COMMIT, timeout_ms)


## Advance the call within `budget_ms`. Returns whether it settled on this call.
func poll(budget_ms: int = POLL_BUDGET_MS) -> bool:
	if _request_id < 0:
		return false
	for value in _transport.poll(budget_ms):
		var entry: Dictionary = value
		if int(entry.get("request_id", -1)) != _request_id:
			continue
		var kind := str(entry.get("kind", ""))
		if kind == HttpTransport.KIND_RESPONSE:
			_settle(entry)
			return true
		if kind == HttpTransport.KIND_ERROR:
			var reason := str(entry.get("error", ""))
			_finish()
			_last_error = reason if not reason.is_empty() else "The configuration call failed."
			return true
	if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:
		_transport.cancel(_request_id)
		_finish()
		_last_error = "The configuration call did not answer within its time budget."
		return true
	return false


## Drive one call to completion inside one bounded wait.
func fetch_read(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	return _run(start_read(timeout_ms))


func fetch_preview(patch: Dictionary, scope: String, expected_revision: String = "", timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	return _run(start_preview(patch, scope, expected_revision, timeout_ms))


func fetch_commit(patch: Dictionary, scope: String, expected_revision: String = "", timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	return _run(start_commit(patch, scope, expected_revision, timeout_ms))


## --- internals ---------------------------------------------------------------

func _run(started: bool) -> bool:
	if not started:
		return false
	while _request_id >= 0:
		poll(POLL_BUDGET_MS)
	return _last_error.is_empty()


func _can_call() -> bool:
	if _transport == null:
		_last_error = "No transport is configured, so configuration cannot be read."
		return false
	if _request_id >= 0:
		_last_error = "A configuration call is already in flight."
		return false
	return true


## The local refusal for a patch, before anything reaches the wire.
##
## A withheld value must never be written back, and a scope the API does not accept must
## never be sent. Both are refused here with a readable reason rather than becoming a
## confusing HTTP 400 later.
func _patch_refusal(patch: Dictionary, scope: String, verb: String) -> String:
	if scope != WRITE_GLOBAL and scope != WRITE_PROJECT:
		return (
			"'%s' is not a writable configuration scope. A setting can be written globally "
			+ "or to the open project; session and folder overrides are not configuration documents."
		) % scope
	if patch.is_empty():
		return "A %s with no changed keys would write nothing." % verb
	return withheld_write_reason(patch)


func _patch_body(patch: Dictionary, scope: String, expected_revision: String) -> Dictionary:
	var body := {"patch": patch.duplicate(true), "scope": scope}
	# The guard is the revision the client last saw for this scope unless the caller
	# supplied one. It is OMITTED rather than sent empty when there is none, because the
	# schema treats an absent guard as "no expectation" and an empty string as a value.
	var revision := expected_revision if not expected_revision.is_empty() else revision_for(scope)
	if not revision.is_empty():
		body["expectedRevision"] = revision
	return body


func _begin(method: int, path: String, body: Dictionary, kind: String, timeout_ms: int) -> bool:
	_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0)
	var request_id := _transport.request(method, path, body)
	if request_id < 0:
		var reason := _transport.last_error()
		_last_error = reason if not reason.is_empty() else "The configuration request could not be issued."
		return false
	# Recorded with the REQUEST, so an answer is installed only for the call that asked.
	_request_id = request_id
	_request_kind = kind
	return true


func _finish() -> void:
	_request_id = -1
	_request_kind = ""


## Install a settled response. The kind recorded with the request decides where the
## payload lands, so a preview answer can never be adopted as a commit.
func _settle(entry: Dictionary) -> void:
	var kind := _request_kind
	_finish()
	var status := int(entry.get("status", 0))
	var body: Variant = entry.get("body", {})
	if status < 200 or status >= 300:
		_last_error = _refusal(status, body)
		return
	if not (body is Dictionary):
		_last_error = "The configuration answer was not a JSON object."
		return
	var payload: Variant = (body as Dictionary).get("data", null)
	if not (payload is Dictionary):
		_last_error = "The configuration answer did not carry a payload."
		return
	match kind:
		KIND_READ:
			_read = payload
			_read_location = body
		KIND_PREVIEW:
			_preview = payload
		KIND_COMMIT:
			_commit = payload
			# A commit returns the settled readback. Adopting it is what lets the UI show
			# the effective value the service actually reports, rather than the patch it
			# hoped it wrote.
			var settled: Variant = (payload as Dictionary).get("read", null)
			if settled is Dictionary:
				_read = settled
				_read_location = body
		_:
			_last_error = "A configuration answer arrived for no known call."
			return
	_last_error = ""


## The service's own refusal, surfaced rather than replaced by a generic message.
##
## `ConfigInvalidError` carries an actionable `message` and an optional `path`, both of
## which name what to fix; a stale revision arrives here as one of those messages, so the
## caller can act on it instead of retrying blindly.
func _refusal(status: int, body: Variant) -> String:
	if body is Dictionary:
		var message := str((body as Dictionary).get("message", ""))
		var path := str((body as Dictionary).get("path", ""))
		if not message.is_empty():
			return "%s (%s)" % [message, path] if not path.is_empty() else message
	return "The configuration call was refused with status %d." % status


## Build a patch from a single top-level key, which is the shape this UI writes.
static func key_patch(key: String, value: Variant) -> Dictionary:
	return {key: value} if not key.is_empty() else {}


## A patch that removes one top-level key. The API spells a removal as a null value.
static func removal_patch(key: String) -> Dictionary:
	return {key: null} if not key.is_empty() else {}