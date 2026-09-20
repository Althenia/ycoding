## Integration discovery and provider credential management, over HTTP.
##
## The runtime keeps credential material in its own store and exposes it through two
## groups (`packages/protocol/src/groups/{integration,credential}.ts`):
##
##   GET    /api/integration                       -> Location.response(Array(Integration.Info))
##   POST   /api/integration/:id/connect/key       -> 204 NoContent
##   PATCH  /api/credential/:id                    -> 204 NoContent   (rename)
##   POST   /api/credential/:id/activate           -> 204 NoContent
##   DELETE /api/credential/:id                    -> 204 NoContent   (remove)
##
## Five contract facts shape everything here, each read from the live Protocol and
## Schema (`packages/schema/src/{integration,connection,credential}.ts`):
##
##   * THE LIST IS ENVELOPED, THE MUTATIONS ARE NOT. The read answers `{location, data}`
##     and the mutations answer 204 with no body at all, so a reader requiring a payload
##     would report every successful write as a failure. Both shapes are handled, and
##     neither is coerced into the other.
##
##   * ONLY SANITIZED METADATA IS KEPT. `Integration.Info` carries methods with prompt
##     text and command vectors, and `Connection.Info` has an `env` variant that names a
##     process variable. None of that belongs on a credential surface, so each integration
##     is rebuilt from a fixed allowlist of five fields and each profile from three. A
##     field the schema later adds cannot leak in by default.
##
##   * THE KEY IS WRITE-ONLY. `integration.connect.key` takes the key in its payload and
##     no route ever returns it. This class therefore keeps no copy: the key is placed on
##     the wire and dropped, and no error message quotes it.
##
##   * A REBIND DISCARDS OLD STATE. Rebinding cancels the call in flight and clears the
##     list, so an answer for the folder the user left is never adopted for the one they
##     are in.
##
##   * AN UNCERTAIN MUTATION IS NEVER RETRIED. A mutation whose answer never arrived may
##     or may not have been applied; repeating it could create or delete a second
##     credential. It is reported as uncertain and further mutations are refused until an
##     authoritative list read settles.
##
## Credentials belong to the HttpTransport this class drives. It holds no username,
## password, header, or credential value, and its messages never carry one.
class_name IntegrationApi
extends RefCounted

## One frame of socket work per poll, matching the other readers' budget.
const POLL_BUDGET_MS := 4
## Bounded wait for one call. A call that exceeds it is abandoned, not waited on.
const DEFAULT_TIMEOUT_MS := 5000

## Call kinds, so a settled answer is never installed for a different call.
const KIND_LIST := "list"
const KIND_CONNECT := "connect"
const KIND_RENAME := "rename"
const KIND_ACTIVATE := "activate"
const KIND_DELETE := "delete"

## The outcome of the last mutation. `uncertain` means a mutation was issued but its
## answer never arrived, so whether it applied is unknown.
const MUTATION_NONE := ""
const MUTATION_APPLIED := "applied"
const MUTATION_FAILED := "failed"
const MUTATION_UNCERTAIN := "uncertain"

## The fields one integration contributes to the surface, in render order. The allowlist
## is the contract: `methods` details, prompts, and command vectors are dropped.
const INTEGRATION_FIELDS := ["id", "name", "has_key_method", "has_other_method", "credentials"]
## The fields one stored profile contributes.
const CREDENTIAL_FIELDS := ["id", "label", "active"]

var _transport: HttpTransport = null
## The call in flight, and its kind. Held together so an answer can never be installed
## for a different call than the one that asked.
var _request_id := -1
var _request_kind := ""
var _deadline_ms := 0
var _last_error := ""
var _mutation_state := MUTATION_NONE

## The last settled list, sanitized, and the location it describes.
var _integrations: Array = []
var _location: Dictionary = {}


func configure(transport: HttpTransport) -> void:
	# Rebinding to another transport must cancel whatever the OLD one had in flight. The
	# request was issued against the previous location, so its answer must never be adopted
	# for the new one, and nothing would poll it any more.
	if _transport != null and _transport != transport:
		cancel_pending()
	_transport = transport
	_request_id = -1
	_request_kind = ""
	_deadline_ms = 0
	_last_error = ""
	_mutation_state = MUTATION_NONE
	_integrations = []
	_location = {}


## True while a call is waiting for its response.
func is_pending() -> bool:
	return _request_id >= 0


## Cancel the call in flight, if any.
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


## The integrations and their stored profiles, sanitized. Never carries credential
## material: the runtime reports a profile by label, id and active flag only.
func integrations() -> Array:
	return _integrations.duplicate(true)


## The location the last list resolved, so a caller can state what the metadata describes.
func resolved_location() -> Dictionary:
	return (_location.get("location", {}) as Dictionary).duplicate(true)


## Whether the last mutation was reported as applied.
func mutation_succeeded() -> bool:
	return _mutation_state == MUTATION_APPLIED


## Whether the last mutation's outcome is unknown, so it must not be repeated blind.
func mutation_uncertain() -> bool:
	return _mutation_state == MUTATION_UNCERTAIN


## Begin a list read. An authoritative read clears an uncertain mutation, because the
## list is what resolves whether it applied.
func start_list(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if not _can_call(false):
		return false
	_integrations = []
	_location = {}
	_mutation_state = MUTATION_NONE
	_last_error = ""
	return _begin(HTTPClient.METHOD_GET, Gateway.INTEGRATION_LIST, {}, KIND_LIST, timeout_ms)


## Drive a list read to completion inside one bounded wait.
func fetch_list(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	return _run(start_list(timeout_ms))


## Begin a key connect for `integration_id`. The key is placed on the wire and never
## retained; an empty key is refused locally so no request is issued.
func start_connect_key(
	integration_id: String, key: String, label: String, timeout_ms: int = DEFAULT_TIMEOUT_MS
) -> bool:
	if integration_id.strip_edges().is_empty():
		_last_error = "No integration was named, so there is nothing to connect."
		return false
	if key.is_empty():
		_last_error = "Enter the key before connecting."
		return false
	if not _can_call(true):
		return false
	var body := {"key": key}
	# An unnamed profile omits `label` rather than sending an empty string, because the
	# schema treats the field as optional and the runtime keeps its own default name.
	var name := label.strip_edges()
	if not name.is_empty():
		body["label"] = name
	_last_error = ""
	return _begin(
		HTTPClient.METHOD_POST, Gateway.integration_connect_key(integration_id), body, KIND_CONNECT, timeout_ms
	)


## Begin renaming a stored profile. An empty label is refused locally: the route
## requires one, and silently sending nothing would make the rename a no-op.
func start_rename(credential_id: String, label: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if credential_id.strip_edges().is_empty():
		_last_error = "No profile was named, so there is nothing to rename."
		return false
	var name := label.strip_edges()
	if name.is_empty():
		_last_error = "Enter a name for this profile before renaming it."
		return false
	if not _can_call(true):
		return false
	_last_error = ""
	return _begin(
		HTTPClient.METHOD_PATCH, Gateway.credential(credential_id), {"label": name}, KIND_RENAME, timeout_ms
	)


## Begin activating a stored profile. Switching the active profile does not remove the
## others; the runtime promotes the remaining one when the active profile is removed.
func start_activate(credential_id: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if credential_id.strip_edges().is_empty():
		_last_error = "No profile was named, so there is nothing to activate."
		return false
	if not _can_call(true):
		return false
	_last_error = ""
	return _begin(
		HTTPClient.METHOD_POST, Gateway.credential_activate(credential_id), {}, KIND_ACTIVATE, timeout_ms
	)


## Begin removing a stored profile. Irreversible, so the surface requires confirmation
## before this is reached.
func start_delete(credential_id: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if credential_id.strip_edges().is_empty():
		_last_error = "No profile was named, so there is nothing to remove."
		return false
	if not _can_call(true):
		return false
	_last_error = ""
	return _begin(
		HTTPClient.METHOD_DELETE, Gateway.credential(credential_id), {}, KIND_DELETE, timeout_ms
	)


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
			var was_mutation := _is_mutation(_request_kind)
			_finish()
			_last_error = reason if not reason.is_empty() else "The integration call failed."
			# A transport failure after the request was sent leaves the outcome unknown
			# for a mutation; it is never repeated.
			_mutation_state = MUTATION_UNCERTAIN if was_mutation else MUTATION_NONE
			return true
	if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:
		_transport.cancel(_request_id)
		var uncertain := _is_mutation(_request_kind)
		_finish()
		_last_error = "The integration call did not answer within its time budget."
		if uncertain:
			_last_error += " The change may or may not have been applied; re-read the integrations before trying again."
			_mutation_state = MUTATION_UNCERTAIN
		return true
	return false


## --- internals ---------------------------------------------------------------

func _run(started: bool) -> bool:
	if not started:
		return false
	while _request_id >= 0:
		poll(POLL_BUDGET_MS)
	return _last_error.is_empty()


## Whether a call may be issued. A mutation is additionally refused while the previous
## one is uncertain, because repeating it could create or delete a second credential.
func _can_call(for_mutation: bool) -> bool:
	if _transport == null:
		_last_error = "No transport is configured, so integrations cannot be read."
		return false
	if _request_id >= 0:
		_last_error = "An integration call is already in flight."
		return false
	if for_mutation and _mutation_state == MUTATION_UNCERTAIN:
		_last_error = (
			"A previous change may or may not have been applied. Re-read the integrations "
			+ "before making another change."
		)
		return false
	return true


func _begin(method: int, path: String, body: Dictionary, kind: String, timeout_ms: int) -> bool:
	_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0)
	var request_id := _transport.request(method, path, body)
	if request_id < 0:
		var reason := _transport.last_error()
		_last_error = reason if not reason.is_empty() else "The integration request could not be issued."
		return false
	# Recorded with the REQUEST, so an answer is installed only for the call that asked.
	_request_id = request_id
	_request_kind = kind
	return true


func _finish() -> void:
	_request_id = -1
	_request_kind = ""


func _is_mutation(kind: String) -> bool:
	return kind != KIND_LIST and not kind.is_empty()


## Install a settled response. The kind recorded with the request decides how the status
## and body are read, so a mutation's 204 can never be adopted as a list.
func _settle(entry: Dictionary) -> void:
	var kind := _request_kind
	_finish()
	var status := int(entry.get("status", 0))
	var body: Variant = entry.get("body", {})
	if status < 200 or status >= 300:
		_last_error = _refusal(status, body)
		if _is_mutation(kind):
			_mutation_state = MUTATION_FAILED
		return
	if kind == KIND_LIST:
		_adopt_list(body)
		return
	if kind.is_empty():
		_last_error = "An integration answer arrived for no known call."
		return
	# A mutation succeeds with 204 NoContent, so there is no payload to read and no body
	# to demand. The list is NOT patched locally: the surface re-reads it, so what is
	# shown is the runtime's own report rather than this client's guess.
	_last_error = ""
	_mutation_state = MUTATION_APPLIED


## Adopt the declared `{location, data: [Integration.Info]}` envelope, rebuilt from the
## allowlist. A body that is not the declared shape is refused whole rather than
## half-read, and nothing is adopted when it is.
func _adopt_list(body: Variant) -> void:
	if not (body is Dictionary):
		_last_error = "The integration answer was not a JSON object."
		return
	var data: Variant = (body as Dictionary).get("data", null)
	if not (data is Array):
		_last_error = "The integration answer did not carry a list."
		return
	var out: Array = []
	for value in data:
		if not (value is Dictionary):
			_last_error = "The integration answer carried a malformed entry."
			return
		var row: Dictionary = value
		if not row.has("id") or str(row.get("id", "")).is_empty():
			_last_error = "The integration answer carried an entry with no id."
			return
		out.append(_sanitize_integration(row))
	_integrations = out
	_location = body
	_last_error = ""
	_mutation_state = MUTATION_NONE


## One integration, rebuilt from the allowlist. Methods are reduced to two booleans,
## because only "can a key be entered" and "is some other sign-in needed" reach the
## surface; prompt text and command vectors are dropped. `env` connections are dropped
## entirely: an environment variable is not a stored profile and cannot be renamed or
## removed from here.
static func _sanitize_integration(row: Dictionary) -> Dictionary:
	var has_key := false
	var has_other := false
	var methods: Variant = row.get("methods", [])
	if methods is Array:
		for value in methods:
			if not (value is Dictionary):
				continue
			if str((value as Dictionary).get("type", "")) == "key":
				has_key = true
			else:
				has_other = true
	var credentials: Array = []
	var connections: Variant = row.get("connections", [])
	if connections is Array:
		for value in connections:
			if not (value is Dictionary):
				continue
			var connection: Dictionary = value
			if str(connection.get("type", "")) != "credential":
				continue
			credentials.append({
				"id": str(connection.get("id", "")),
				"label": str(connection.get("label", "")),
				"active": bool(connection.get("active", false)),
			})
	return {
		"id": str(row.get("id", "")),
		"name": str(row.get("name", "")),
		"has_key_method": has_key,
		"has_other_method": has_other,
		"credentials": credentials,
	}


## The service's own refusal, surfaced rather than replaced by a generic message.
##
## A refusal quotes nothing the client sent: the service's error payloads name what
## failed and never echo a payload, and that is why the key is never quoted back here.
func _refusal(status: int, body: Variant) -> String:
	if body is Dictionary:
		var message := str((body as Dictionary).get("message", ""))
		if not message.is_empty():
			return message
	return "The integration call was refused with status %d." % status