## Provider quota snapshots, read from the runtime.
##
## `GET /api/provider/usage` answers `Location.response(Schema.Array(ProviderUsage.Snapshot))`
## and `GET /api/provider/:providerID/usage` answers one Snapshot
## (packages/protocol/src/groups/provider-usage.ts). Both take the location query and an
## optional `refresh`. Both error with `ServiceUnavailableError`.
##
## THREE properties shape this reader, and each is in the acceptance:
##
##   * REUSE EXISTING SNAPSHOTS. The runtime normalizes providers into one shape. This reads
##     that shape and never re-derives it, so a provider's own oddities stay the runtime's to
##     handle rather than the client's to guess at.
##
##   * REFRESH IS NON-BLOCKING. `refresh` asks the runtime to re-poll the provider, and a
##     provider call can take seconds. The read is therefore bounded and STARTED rather than
##     waited on from a caller's perspective, and a read that overruns its budget is
##     cancelled rather than left to drain. A quota read is best effort: it must never stall
##     the window and must never block sending a prompt.
##
##   * A MALFORMED SNAPSHOT IS REFUSED, NOT HALF-READ. `ProviderUsage.Window` REQUIRES
##     `id`, `label` and `unit`. A window without a unit cannot be rendered honestly - a
##     figure without a unit is not a figure - so a snapshot failing that requirement yields
##     no snapshots and a stated reason, rather than a row that looks complete and is not.
##
## Credentials belong to the HttpTransport this class drives. It holds no username, password,
## or header, and its messages never carry one.
class_name ProviderUsageApi
extends RefCounted

## One frame of socket work per poll, matching the LIVE transport's budget.
const POLL_BUDGET_MS := 4
## Bounded wait for a whole read. A read that exceeds it is abandoned, not waited on.
const DEFAULT_TIMEOUT_MS := 4000

## The fields `ProviderUsage.Window` requires. A window missing one cannot be rendered
## honestly, so its snapshot is refused whole.
const REQUIRED_WINDOW_FIELDS := ["id", "label", "unit"]
## The fields `ProviderUsage.Snapshot` requires.
const REQUIRED_SNAPSHOT_FIELDS := [
	"providerID", "label", "status", "source", "stability", "updatedAt", "windows",
]

var _transport: HttpTransport = null
var _request_id := -1
var _deadline_ms := 0
var _snapshots: Array = []
var _last_error := ""
var _last_freshness := QuotaPage.FRESH


## Bind the transport that carries the request. It must already be configured with the
## location set, because both routes are location-scoped.
func configure(transport: HttpTransport) -> void:
	_transport = transport
	_request_id = -1
	_deadline_ms = 0
	_snapshots = []
	_last_error = ""
	_last_freshness = QuotaPage.FRESH


func is_pending() -> bool:
	return _request_id >= 0


## The snapshots from the last settled read, or [] when it has not settled.
func snapshots() -> Array:
	return _snapshots


## Why the last read produced no snapshots. "" when nothing failed.
func last_error() -> String:
	return _last_error


## The freshness the runtime stated, which a page reports rather than measuring itself.
func freshness() -> String:
	return _last_freshness


## Begin the list read. `refresh` asks the runtime to re-poll the providers, which is why the
## read is bounded: a provider call can be slow and the caller must never wait on it.
func start(refresh: bool = false, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> bool:
	return _start_path(Gateway.PROVIDER_USAGE, refresh, timeout_ms)


## Begin the single-provider read.
func start_provider(
	provider_id: String, refresh: bool = false, timeout_ms: int = DEFAULT_TIMEOUT_MS
) -> bool:
	if provider_id.is_empty():
		_last_error = "No provider was named, so there is no usage to read."
		return false
	return _start_path(Gateway.provider_usage(provider_id), refresh, timeout_ms)


func _start_path(path: String, refresh: bool, timeout_ms: int) -> bool:
	if _transport == null:
		_last_error = "No transport is configured, so provider usage cannot be read."
		return false
	_snapshots = []
	_last_error = ""
	_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0)
	var query := "?refresh=true" if refresh else ""
	var request_id := _transport.request(HTTPClient.METHOD_GET, path + query, {})
	if request_id < 0:
		var reason := _transport.last_error()
		_last_error = reason if not reason.is_empty() else "The provider usage request could not be issued."
		_request_id = -1
		return false
	# A refresh re-polls the provider, so a longer budget applies to it alone.
	if refresh:
		_deadline_ms = Time.get_ticks_msec() + maxi(timeout_ms, 0) * 3
	_request_id = request_id
	return true


## Advance the read within `budget_ms`.
func poll(budget_ms: int = POLL_BUDGET_MS) -> Array:
	if _request_id < 0:
		return _snapshots
	for value in _transport.poll(budget_ms):
		var entry: Dictionary = value
		if int(entry.get("request_id", -1)) != _request_id:
			continue
		var kind := str(entry.get("kind", ""))
		if kind == HttpTransport.KIND_RESPONSE:
			_request_id = -1
			var status := int(entry.get("status", 0))
			var body: Variant = entry.get("body", {})
			if not _is_success(status):
				_snapshots = []
				_last_error = _reason(status, body)
				return _snapshots
			_snapshots = _read_body(body)
			return _snapshots
		if kind == HttpTransport.KIND_ERROR:
			var reason := str(entry.get("error", ""))
			_request_id = -1
			_snapshots = []
			_last_error = reason if not reason.is_empty() else "The provider usage read failed."
			return _snapshots
	if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:
		_transport.cancel(_request_id)
		_request_id = -1
		_snapshots = []
		_last_error = "The provider usage read did not answer within its time budget."
	return _snapshots


## Drive the list read to completion inside one bounded wait.
func fetch(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> Array:
	if not start(false, timeout_ms):
		return []
	while _request_id >= 0:
		poll(POLL_BUDGET_MS)
	return _snapshots


## Drive the single-provider read to completion inside one bounded wait.
func fetch_provider(provider_id: String, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> Dictionary:
	if not start_provider(provider_id, false, timeout_ms):
		return {}
	while _request_id >= 0:
		poll(POLL_BUDGET_MS)
	if _snapshots.is_empty():
		return {}
	return _snapshots[0]


## Read snapshots from the response envelope.
##
## The list route's body is `{location, data: [Snapshot]}`, and the single route's is
## `{location, data: Snapshot}`. A body that does not match is refused with a reason rather
## than being coerced: a half-read snapshot is worse than none.
func _read_body(body: Variant) -> Array:
	if not (body is Dictionary):
		_last_error = "The provider usage answer was not a JSON object."
		return []
	var data: Variant = body.get("data", null)
	if data == null:
		_last_error = "The provider usage answer carried no data."
		return []
	var rows: Array = data if data is Array else [data]
	var out: Array = []
	for row in rows:
		if not (row is Dictionary):
			_last_error = "The provider usage answer carried a malformed snapshot."
			return []
		var missing := _missing_field(row, REQUIRED_SNAPSHOT_FIELDS, "snapshot")
		if not missing.is_empty():
			_last_error = "The provider usage answer carried a snapshot with no %s." % missing
			return []
		var windows: Variant = row.get("windows")
		if not (windows is Array):
			_last_error = "The provider usage snapshot carried no window list."
			return []
		for window in windows:
			if not (window is Dictionary):
				_last_error = "The provider usage snapshot carried a malformed window."
				return []
			var window_missing := _missing_field(window, REQUIRED_WINDOW_FIELDS, "window")
			if not window_missing.is_empty():
				# A window with no unit cannot be rendered honestly, so its whole snapshot
				# is refused rather than shown as a figure whose meaning is unknown.
				_last_error = "The provider usage snapshot carried a window with no %s." % window_missing
				return []
		out.append(row)
	_last_error = ""
	return out


func _missing_field(row: Dictionary, fields: Array, _kind: String) -> String:
	for field in fields:
		if not row.has(field):
			return field
	return ""


func _is_success(status: int) -> bool:
	return status >= 200 and status < 300


## The service's own refusal, surfaced rather than replaced by a generic message.
func _reason(status: int, body: Variant) -> String:
	if body is Dictionary:
		var message := str(body.get("message", ""))
		if not message.is_empty():
			return message
	return "The provider usage read was refused with status %d." % status
