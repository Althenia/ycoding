## Model catalogue as the service publishes it.
##
## `GET /api/model` answers `Location.response(Schema.Array(Model.Info))`, so the
## JSON body is `{"location": Location.Info, "data": [Model.Info, ...]}`:
##   packages/protocol/src/groups/model.ts:10 declares the success schema,
##   packages/schema/src/location.ts:23 defines `response` as that struct, and
##   packages/server/src/location.ts:16 builds the body that way.
##
## The service already restricts the list to models of available providers, skips
## disabled models and orders by `time.released` descending
## (packages/core/src/catalog.ts:190-202), so entries are passed through in the
## order they arrive and are never re-filtered or re-ordered here.
##
## Nothing in this class is fabricated. A read that fails, times out, or cannot be
## parsed yields an empty array with a readable reason in `last_error()`. Every
## entry that is returned is server data, which is why none carries the synthetic
## marker the demo set is identified by.
##
## Credentials belong to the HttpTransport this class drives. It holds no
## username, password, or header, and its messages never carry one.
class_name ModelCatalogApi
extends RefCounted

## The verified route. It is location-scoped, so the caller puts the location on
## The route is owned by the Gateway contract, so the two cannot drift.
const MODELS_PATH := Gateway.MODELS
## One frame of socket work per poll, matching the LIVE transport's budget.
const POLL_BUDGET_MS := 4
## Bounded wait for a whole read. A read that exceeds it is abandoned, not waited on.
const DEFAULT_TIMEOUT_MS := 4000

var _transport: HttpTransport = null
var _request_id := -1
var _deadline_ms := 0
var _models: Array = []
var _last_error := ""


## Bind the transport that carries the request. It must already be configured,
## with the location set, because the model route is location-scoped.
func configure(transport: HttpTransport) -> void:
	_transport = transport
	_request_id = -1
	_deadline_ms = 0
	_models = []
	_last_error = ""


## True while a read is waiting for its response.
func is_pending() -> bool:
	return _request_id >= 0


## The models from the last settled read, or [] when it has not settled.
func models() -> Array:
	return _models


## Why the last read produced no models. "" when nothing failed.
func last_error() -> String:
	return _last_error


## Begin the read. False means it could not be issued, and `last_error()` explains;
## `poll` then returns [].
func start(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	if _transport == null:
		_last_error = "No transport is configured, so the model list cannot be read."
		return false
	_models = []
	_last_error = ""
	_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0)
	var request_id := _transport.request(HTTPClient.METHOD_GET, MODELS_PATH, {})
	if request_id < 0:
		var reason := _transport.last_error()
		_last_error = reason if not reason.is_empty() else "The model list request could not be issued."
		_request_id = -1
		return false
	_request_id = request_id
	return true


## Advance the read within `budget_ms`. Returns the models once the response has
## settled, and [] while it is still in flight or after any failure. Past the
## deadline the read is cancelled instead of being left to be drained forever.
func poll(budget_ms: int = POLL_BUDGET_MS) -> Array:
	if _request_id < 0:
		return _models
	for value in _transport.poll(budget_ms):
		var entry: Dictionary = value
		if int(entry.get("request_id", -1)) != _request_id:
			continue
		var kind := str(entry.get("kind", ""))
		if kind == HttpTransport.KIND_RESPONSE:
			_request_id = -1
			_models = _read_response(entry)
			return _models
		if kind == HttpTransport.KIND_ERROR:
			var reason := str(entry.get("error", ""))
			_request_id = -1
			_models = []
			_last_error = reason if not reason.is_empty() else "The model list request failed."
			return _models
	if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:
		_transport.cancel(_request_id)
		_request_id = -1
		_models = []
		_last_error = "The model list did not answer within its time budget."
	return _models


## Drive the read to completion inside one bounded wait and return the models.
##
## Prefer `start`/`poll` from a frame loop: this blocks the caller until the
## response settles or the budget runs out. The wait is never longer than
## `timeout_ms`, because `poll` abandons the request at that same deadline, so an
## unresponsive service costs one bounded delay instead of a hang.
func fetch(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> Array:
	if not start(timeout_ms):
		return []
	while _request_id >= 0:
		poll(POLL_BUDGET_MS)
	return _models


## Turn one settled response entry into models. Anything that is not the verified
## body shape is reported rather than guessed at, and a non-2xx status is never
## read as a catalogue even when its body looks like one.
func _read_response(entry: Dictionary) -> Array:
	var status := int(entry.get("status", 0))
	if status < 200 or status >= 300:
		_last_error = "The service answered the model list with HTTP %d." % status
		return []
	var body: Variant = entry.get("body", {})
	if not (body is Dictionary):
		_last_error = "The model list response was not a JSON object."
		return []
	var data: Variant = (body as Dictionary).get("data")
	if not (data is Array):
		_last_error = "The model list response carried no `data` array."
		return []
	var models := _read_entries(data)
	if models.is_empty() and not (data as Array).is_empty():
		_last_error = "The model list response carried no usable model entries."
	return models


## Entries that cannot identify a model are dropped, never repaired into one.
func _read_entries(data: Array) -> Array:
	var models: Array = []
	for value in data:
		var entry := _read_entry(value)
		if not entry.is_empty():
			models.append(entry)
	return models


## One wire entry as the service published it. An entry that cannot identify a
## model is dropped, never repaired into one, because a model with no id or no
## provider cannot be switched to and must not be offered.
##
## The synthetic marker is the only field that is removed: it belongs to the
## fabricated demo set alone, so a wire entry that carried it would make server
## data render as demo playback.
func _read_entry(value: Variant) -> Dictionary:
	if not (value is Dictionary):
		return {}
	var entry: Dictionary = (value as Dictionary).duplicate()
	entry.erase(ModelCatalog.SYNTHETIC_FIELD)
	if str(entry.get("id", "")).is_empty() or str(entry.get("providerID", "")).is_empty():
		return {}
	return entry
