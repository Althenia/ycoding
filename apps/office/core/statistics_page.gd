## The Statistics page's data binding.
##
## A presentation model rather than a Control, deliberately: every honesty rule the kit's
## statistics contract demands is a rule about WHAT MAY BE SAID, and a rule expressed in a
## widget is a rule no test can reach. Here the page is a state machine over what has
## actually been read, and a Control renders whichever state it is in.
##
## The contract's decisive sentence is: "No arbitrary mock graph in production: use proper
## empty, partial, loading, stale and error states." Those five states are distinct and each
## says something different:
##
##   LOADING - nothing has been read yet. NOT "no work": that is a claim, and there is none.
##   EMPTY   - the service answered, and it reported no work.
##   READY   - the service answered with work. Cards, rows and a source.
##   ERROR   - the read failed. Carries the reason, and is never shown as empty.
##   (STALE is a mark on READY, not a state: the figures are real but known incomplete.)
##
## TWO PARTS OF THE ACCEPTANCE CANNOT BE BUILT FROM WHAT THE RUNTIME EXPOSES, and this page
## says so rather than drawing something plausible:
##
##   THE DAILY CHART and THE ACTIVITY CALENDAR both need per-day data. `session.usage`
##   returns a cumulative `ProviderRequest.Summary` with no time field, and although the
##   per-request records carry `time_created` in the database, no endpoint exposes them -
##   every GET route in packages/protocol/src/groups was enumerated and none returns a
##   `ProviderRequest.Record` or a date. Grouping sessions by when they STARTED would
##   attribute a long session's work to its first day, so no series is drawn and the reason
##   is stated. Both remain open until a per-day read model exists; they are not silently
##   dropped, and `daily_unavailable_text` is what a reader sees instead.
class_name StatisticsPage
extends RefCounted

## Nothing read yet. Not the same as empty.
const LOADING := "loading"
## The service answered and reported no work.
const EMPTY := "empty"
## The service answered with work.
const READY := "ready"
## The read failed. Carries its reason.
const ERROR := "error"

const UNREPORTED := SessionUsage.UNREPORTED
const EMPTY_MESSAGE := "No provider requests have been recorded for this selection."
const LOADING_MESSAGE := "Reading usage from the service…"

## Why a daily chart and a calendar cannot be drawn, in the product's own terms.
const DAILY_UNAVAILABLE := (
	"Session usage is cumulative: the service reports one total per session with no " +
	"per-request time, and no read model exposes the per-request records that carry one. A " +
	"daily series would attribute a long session's work to a single day, so none is drawn."
)

var _state := LOADING
var _usage: SessionUsage = null
var _error := ""
var _stale_reason := ""
var _model_filter := ""
var _session_id := ""


## The current state. One of LOADING, EMPTY, READY or ERROR.
func state() -> String:
	return _state


func is_empty() -> bool:
	return _state == EMPTY


func is_stale() -> bool:
	return not _stale_reason.is_empty()


## The session the figures came from. "" before a read.
func source_text() -> String:
	if _session_id.is_empty():
		return "No source session has been read yet."
	return "Source: %s" % _session_id


func empty_text() -> String:
	return EMPTY_MESSAGE


func state_text() -> String:
	if _state == LOADING:
		return LOADING_MESSAGE
	if _state == EMPTY:
		return EMPTY_MESSAGE
	return ""


func error_text() -> String:
	return _error


func stale_text() -> String:
	return _stale_reason


## Adopt a settled read. An answer reporting no work is EMPTY; one with work is READY.
func adopt(usage: SessionUsage, session_id: String = "") -> void:
	_usage = usage
	_error = ""
	if not session_id.is_empty():
		_session_id = session_id
	# A usage built with its family carries the session it came from, so the page can name
	# its source even when the caller passes no id of its own.
	elif not usage.session_ids().is_empty():
		_session_id = usage.session_ids()[0]
	if usage == null or not usage.is_reported():
		_state = LOADING
		return
	if usage.logical_steps() == 0 and usage.physical_attempts() == 0 and usage.model_groups().is_empty():
		_state = EMPTY
		return
	_state = READY


## Record a failed read. A failure is never an empty page.
func fail(reason: String) -> void:
	_usage = null
	_error = reason if not reason.is_empty() else "The usage read failed."
	_state = ERROR


## Mark the figures stale: they are real but known incomplete.
func mark_stale(reason: String) -> void:
	_stale_reason = reason


## Keep only one model's figures, so the cards and the rows describe the same subset.
func filter_by_model(model_ref: String) -> void:
	_model_filter = model_ref


func filter_by_model_ref() -> String:
	return _model_filter


## The overview cards.
##
## Known and estimated spend are SEPARATE because one is the provider's own figure and one
## is derived from a price list. A missing figure is the unreported marker, never a zero.
func cards() -> Dictionary:
	var usage := _effective_usage()
	var out := {
		"requests": str(usage.physical_attempts()),
		"logical_steps": str(usage.logical_steps()),
		"physical_attempts": str(usage.physical_attempts()),
		"helpers": str(usage.helper_requests()),
		"known_spend": _spend_text(usage, "recorded"),
		"estimated_spend": _spend_text(usage, "current_catalog"),
		"input_tokens": _token_text(usage, "input"),
		"output_tokens": _token_text(usage, "output"),
		"reasoning_tokens": _token_text(usage, "reasoning"),
		"cache_read_tokens": _token_text(usage, "cache_read"),
		"cache_write_tokens": _token_text(usage, "cache_write"),
	}
	return out


## The model rows, in the SERVICE's order and grouping.
##
## Each row names its own source, so a figure can always be traced to the session it came
## from, and each states whether its spend is complete.
func model_rows() -> Array[Dictionary]:
	var usage := _effective_usage()
	var rows: Array[Dictionary] = []
	var source := _session_id
	for group in usage.model_groups():
		var model: Dictionary = group.get("model", {})
		var ref := "%s/%s" % [str(model.get("providerID", "")), str(model.get("id", ""))]
		var variant := str(model.get("variant", ""))
		if not variant.is_empty():
			ref = "%s#%s" % [ref, variant]
		rows.append({
			"ref": ref,
			# The wire `Model.Ref` carries id, providerID and an optional variant - NOT a
			# display name (packages/schema/src/model.ts), so the label is composed from the
			# reference itself. A catalogue name would be an enrichment this page has not
			# read, and inventing one would label a row with something the service did not say.
			"label": ref,
			"provider": str(model.get("providerID", "")),
			"requests": int(group.get("requests", 0)),
			"cost": group.get("cost", null),
			"priced": group.get("cost", null) != null,
			"provenance": str(group.get("costProvenance", "")),
			"source": source,
		})
	return rows


## The provider rows, grouped from the service's model rows.
##
## A row carries its own request count and NO SHARE: a percentage of an incomplete total is
## not a fact, and the kit forbids summing or inventing one.
func provider_rows() -> Array[Dictionary]:
	var by_provider: Dictionary = {}
	var order: Array[String] = []
	for row in model_rows():
		var provider := str(row.get("provider", ""))
		if not by_provider.has(provider):
			by_provider[provider] = {
				"provider": provider, "requests": 0, "priced": true, "models": 0,
			}
			order.append(provider)
		var entry: Dictionary = by_provider[provider]
		entry["requests"] = int(entry["requests"]) + int(row.get("requests", 0))
		entry["models"] = int(entry["models"]) + 1
		if not bool(row.get("priced", false)):
			entry["priced"] = false
		by_provider[provider] = entry
	var rows: Array[Dictionary] = []
	for provider in order:
		rows.append(by_provider[provider])
	return rows


## No daily chart is drawn, because there is no per-day source.
func has_daily_chart() -> bool:
	return false


func daily_series() -> Array:
	return []


func daily_unavailable_text() -> String:
	return DAILY_UNAVAILABLE


## No activity calendar is drawn, for the same reason.
func has_calendar() -> bool:
	return false


func calendar_cells() -> Array:
	return []


func calendar_unavailable_text() -> String:
	return DAILY_UNAVAILABLE


## The usage the page describes, narrowed to the active model filter when one is set.
func _effective_usage() -> SessionUsage:
	if _usage == null:
		return SessionUsage.empty()
	if _model_filter.is_empty():
		return _usage
	var groups: Array = []
	for group in _usage.model_groups():
		var model: Dictionary = group.get("model", {})
		var ref := "%s/%s" % [str(model.get("providerID", "")), str(model.get("id", ""))]
		var variant := str(model.get("variant", ""))
		if not variant.is_empty():
			ref = "%s#%s" % [ref, variant]
		if ref == _model_filter:
			groups.append(group)
	var filtered := {
		"logical": _usage.logical_steps(),
		"physical": 0,
		"helpers": _usage.helper_requests(),
		"tokens": {},
		"models": groups,
	}
	# The filtered subset's requests are its own groups' requests, so the cards describe the
	# same rows the table does.
	var requests := 0
	var tokens := {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}
	var cost := 0.0
	var all_priced := not groups.is_empty()
	for group in groups:
		requests += int(group.get("requests", 0))
		_accumulate_tokens(tokens, group.get("tokens", {}))
		if group.get("cost", null) == null:
			all_priced = false
		else:
			cost += float(group.get("cost"))
	filtered["physical"] = requests
	filtered["tokens"] = tokens
	if all_priced and not groups.is_empty():
		filtered["cost"] = cost
	return SessionUsage.from_summary(filtered, [_session_id])


## A spend figure for one provenance. An absent figure is the unreported marker.
func _spend_text(usage: SessionUsage, provenance: String) -> String:
	var total := 0.0
	var any := false
	for group in usage.model_groups():
		if group.get("cost", null) == null:
			continue
		if str(group.get("costProvenance", "")) != provenance:
			continue
		any = true
		total += float(group.get("cost"))
	if not any:
		return UNREPORTED
	return "$%.2f" % total


## A token component, or the unreported marker. Never zero for an unreported component.
func _token_text(usage: SessionUsage, component: String) -> String:
	var value := usage.tokens(component)
	if value < 0:
		return UNREPORTED
	return str(value)


func _accumulate_tokens(into: Dictionary, from: Variant) -> void:
	if not (from is Dictionary):
		return
	for key in ["input", "output", "reasoning"]:
		into[key] = int(into.get(key, 0)) + int(from.get(key, 0))
	var source_cache: Variant = from.get("cache", {})
	var into_cache: Dictionary = into.get("cache", {"read": 0, "write": 0})
	if source_cache is Dictionary:
		into_cache["read"] = int(into_cache.get("read", 0)) + int(source_cache.get("read", 0))
		into_cache["write"] = int(into_cache.get("write", 0)) + int(source_cache.get("write", 0))
	into["cache"] = into_cache
