## Session usage as the runtime accounts for it.
##
## The runtime already answers this. `GET /api/session/:sessionID/usage` returns a
## `ProviderRequest.Summary` (packages/protocol/src/groups/session.ts,
## packages/schema/src/provider-request.ts), whose body is `{data: Summary}`. A root
## session's Summary already includes its descendant subagent family, while a child's is
## scoped to itself. Nothing here recomputes that: the service owns the accounting, and
## the client's job is to present it without inventing or double-counting.
##
## Four rules shape the presentation, and each is a way the numbers can lie:
##
##   * ATTEMPTS ARE NOT STEPS. `logical` is the steps and `physical` the attempts those
##     steps took. One step that retried is 1 logical step and 2 attempts; adding the two
##     numbers would invent work, and reporting only one would hide the retries or the
##     work.
##   * HELPERS ARE A SEPARATE CLASS. `helpers` counts title, goal and compaction requests.
##     They are billed but are not the user's work, so they are shown apart.
##   * INCOMPLETE PRICING IS NOT CHEAP. `cost` and each group's cost are OPTIONAL, and a
##     group's cost is absent when ANY request in it was unpriced. Zero known spend with
##     missing pricing is not "free", so the aggregate reports how many groups it priced.
##   * AN ESTIMATE IS NOT AN INVOICE. `costProvenance` says whether a figure is the
##     provider's recorded billing or a query-time catalog estimate, and the two are
##     labelled differently.
class_name SessionUsage
extends RefCounted

## The token components the normalization contract defines. Cached and reasoning tokens
## are their own components and are never added into input or output.
const TOKEN_COMPONENTS := ["input", "output", "reasoning", "cache_read", "cache_write"]

## What an unreported value renders as. Never a zero: zero is a claim about money or work,
## and absent is the absence of a claim.
const UNREPORTED := "Not reported"

var _summary: Dictionary = {}
var _reported := false
var _session_ids: Array[String] = []


## An aggregate for nothing read. It reports nothing as known rather than reporting zero
## work, so an unread session and an idle one cannot look the same.
static func empty() -> SessionUsage:
	return SessionUsage.new()


## An aggregate over one session's wire Summary.
##
## `family` names the sessions the Summary covers. The service already decided that
## scope - a root covers its descendants, a child only itself - so it is recorded for
## display rather than recomputed.
static func from_summary(summary: Dictionary, family: Array = []) -> SessionUsage:
	var usage := SessionUsage.new()
	usage._summary = summary if summary is Dictionary else {}
	usage._reported = true
	for session_id in family:
		usage._session_ids.append(str(session_id))
	return usage


## Whether a root's total already covers its descendants.
##
## The service scopes a root to its whole family and a child to itself
## (packages/protocol/src/groups/session.ts), so a root's total must be taken as the
## family total rather than added to its children's.
static func includes_descendants(session_id: String, family: Array) -> bool:
	if family.is_empty():
		return false
	return str(family[0]) == session_id


func is_reported() -> bool:
	return _reported


func session_ids() -> Array[String]:
	return _session_ids


## The logical steps the user's work took. One step is one logical model call, however
## many physical attempts it needed.
func logical_steps() -> int:
	return int(_summary.get("logical", 0))


## The physical attempts made on behalf of those steps. Always at least the step count;
## the difference is retries.
func physical_attempts() -> int:
	return int(_summary.get("physical", 0))


## Title, goal and compaction requests. Billed, but a separate class from the user's work.
func helper_requests() -> int:
	return int(_summary.get("helpers", 0))


## Requests that continued a previous conversation rather than sending it whole.
func continued_requests() -> int:
	return int(_summary.get("continued", 0))


## Requests that fell back to another route.
func fallback_requests() -> int:
	return int(_summary.get("fallback", 0))


## The model groups the service reported, as it ordered them (descending cost).
func model_groups() -> Array:
	var models: Variant = _summary.get("models", [])
	if models is Array:
		return models
	return []


## Whether the service reported a cost at all. Absent means unknown, and unknown is never
## presented as zero.
func has_cost() -> bool:
	var cost: Variant = _summary.get("cost", null)
	return cost != null


func cost() -> float:
	return float(_summary.get("cost", 0.0))


## The cost as text, or the unreported marker. A missing figure is never "$0.00".
func cost_text() -> String:
	if not has_cost():
		return UNREPORTED
	return "$%.2f" % cost()


## How many model groups carried a price.
func priced_groups() -> int:
	var count := 0
	for group in model_groups():
		if group is Dictionary and group.get("cost", null) != null:
			count += 1
	return count


## How many did not. A group's cost is absent when ANY request in it was unpriced, so
## this is a count of groups whose spend is incomplete.
func unpriced_groups() -> int:
	return model_groups().size() - priced_groups()


## Whether every group carried a price. Only then is the total a complete figure.
func is_fully_priced() -> bool:
	return not model_groups().is_empty() and unpriced_groups() == 0


## The completeness of the total, spelled out, so an incomplete figure cannot read as a
## cheap one.
func priced_of() -> String:
	return "%d of %d" % [priced_groups(), model_groups().size()]


## Whether the reported figures are the provider's own billing or a catalog estimate.
##
## A group's `costProvenance` is required whenever it carries a cost, so the reported
## groups are consulted rather than the total.
func cost_provenance_text() -> String:
	for group in model_groups():
		if group is Dictionary and group.get("cost", null) != null:
			var provenance := str(group.get("costProvenance", ""))
			if provenance == "recorded":
				return "recorded"
			if provenance == "current_catalog":
				return "estimated"
	return UNREPORTED


## One token component, or -1 when the service did not report it.
##
## A component that was not reported is NOT zero: zero would claim the provider counted
## none, which is a different statement from not having the figure.
func tokens(component: String) -> int:
	var tokens: Variant = _summary.get("tokens", {})
	if tokens is not Dictionary:
		return -1
	match component:
		"input", "output", "reasoning":
			if not tokens.has(component):
				return -1
			return int(tokens[component])
		"cache_read", "cache_write":
			var cache: Variant = tokens.get("cache", {})
			if not (cache is Dictionary):
				return -1
			var key := "read" if component == "cache_read" else "write"
			if not cache.has(key):
				return -1
			return int(cache[key])
	return -1
