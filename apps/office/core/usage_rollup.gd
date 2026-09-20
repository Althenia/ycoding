## Usage across many sessions, and the filters the statistics page needs.
##
## The service owns per-session accounting: `GET /api/session/:sessionID/usage` returns a
## `ProviderRequest.Summary`, and a ROOT session's Summary already includes its descendant
## subagent family while a CHILD's is scoped to itself
## (packages/protocol/src/groups/session.ts). This class therefore never sums walked
## history: it takes the summaries the client already read and adds the ones that stand
## alone.
##
## THE RULE THAT MATTERS: a session already inside another's total is NOT counted again.
## The acceptance says "helpers and children once", and a rollup that added a child to its
## root would report every delegated request twice - once in the child's own right and once
## inside the parent's family total. `from_sessions` takes the declared family for each
## session and skips any session a ROOT already covers.
##
## A DAY BREAKDOWN IS NOT OFFERED, because there is no per-day source to group by. The
## cumulative Summary carries no per-request time, and the per-request events that do carry
## one are excluded from public logs. Grouping sessions by when they started would
## attribute work to the wrong day, so `supports_day_breakdown` is false and
## `unavailable_reason` states why. An unavailable figure is reported as unavailable rather
## than approximated into something that looks like data.
class_name UsageRollup
extends RefCounted

## What an unreported total renders as, matching SessionUsage.
const UNREPORTED := SessionUsage.UNREPORTED

## The reason a day breakdown cannot be produced, in the product's own terms.
const DAY_UNAVAILABLE := (
	"session usage is cumulative: the service reports one total per session with no " +
	"per-request time, and the per-request events that carry one are excluded from public " +
	"logs, so there is nothing to group by day"
)

var _sessions: Array[Dictionary] = []
var _counted: Array[String] = []
var _skipped: Array[String] = []


static func empty() -> UsageRollup:
	return UsageRollup.new()


## Build a rollup from the accounted sessions the client holds.
##
## `rows` carries `{session_id, project_id, summary, models}`. `models` lists the
## provider/model refs the session used, so a provider or model filter can select it
## without re-reading the summary's groups.
##
## `declared_families` maps a session id to the family its Summary covers. A session whose
## family contains another session in `rows` is a COVERING session, and the sessions it
## covers are skipped rather than added again. A session absent from the map is treated as
## covering only itself, which is what the service does for a child.
static func from_sessions(rows: Array, declared_families: Dictionary = {}) -> UsageRollup:
	var rollup := UsageRollup.new()
	# A session id appears ONCE. Two rows naming one session describe that session, and a
	# reconnect or a replayed read is exactly how a duplicate arrives. Summing them would
	# report one session's work twice; a later row SUPERSEDES an earlier one, because a re-read
	# is a fresher account of the same session rather than additional work.
	var by_session: Dictionary = {}
	var order: Array[String] = []
	for row in rows:
		var row_session := str(row.get("session_id", ""))
		if row_session.is_empty():
			continue
		if not by_session.has(row_session):
			order.append(row_session)
		by_session[row_session] = row
	var deduped: Array[Dictionary] = []
	for session_id in order:
		deduped.append(by_session[session_id])
	rows = deduped
	var present: Array[String] = []
	for row in rows:
		present.append(str(row.get("session_id", "")))
	# Which sessions cover which. A session covers every member of its declared family
	# that another row already accounted for.
	var covered: Dictionary = {}
	for row in rows:
		var session_id := str(row.get("session_id", ""))
		var family: Array = declared_families.get(session_id, [session_id])
		for member in family:
			var member_id := str(member)
			# A family always names the session itself; only OTHER sessions can be covered,
			# and only when they are actually present to be covered.
			if member_id != session_id and present.has(member_id):
				covered[member_id] = session_id
	for row in rows:
		var session_id := str(row.get("session_id", ""))
		if covered.has(session_id):
			rollup._skipped.append(session_id)
			continue
		rollup._counted.append(session_id)
		rollup._sessions.append(row)
	return rollup


## The sessions this rollup actually counts, in the order given.
func sessions_counted() -> int:
	return _counted.size()


## The sessions skipped because another session's total already covered them. Reported
## rather than silently dropped, so a total can be explained.
func sessions_skipped() -> int:
	return _skipped.size()


func counted_ids() -> Array[String]:
	return _counted.duplicate()


func skipped_ids() -> Array[String]:
	return _skipped.duplicate()


## A new rollup over a subset, with the coverage decision recomputed for that subset.
##
## Filtering AFTER the coverage pass would be wrong: dropping a root would leave its
## covered child looking like an uncounted session. Each filter therefore rebuilds from the
## rows it keeps, so a subset is internally consistent.
func _subset(keep: Callable) -> UsageRollup:
	var kept: Array[Dictionary] = []
	var kept_families: Dictionary = {}
	for row in _sessions:
		if not keep.call(row):
			continue
		var session_id := str(row.get("session_id", ""))
		kept.append(row)
		# A counted session's family is those of its members that survived the filter.
		var family: Array[String] = []
		for other in _sessions:
			family.append(str(other.get("session_id", "")))
		kept_families[session_id] = family
	return UsageRollup.from_sessions(kept, kept_families)


## Keep only the sessions that used this provider.
func filtered_by_provider(provider_id: String) -> UsageRollup:
	return _subset(func(row: Dictionary) -> bool:
		return _uses_provider(row, provider_id))


## Keep only the sessions that used this exact provider/model/variant ref.
func filtered_by_model(model_ref: String) -> UsageRollup:
	return _subset(func(row: Dictionary) -> bool:
		return _uses_model(row, model_ref))


## Keep only the sessions that belong to this project.
func filtered_by_project(project_id: String) -> UsageRollup:
	return _subset(func(row: Dictionary) -> bool:
		return str(row.get("project_id", "")) == project_id)


## The logical steps across the counted sessions.
func logical_steps() -> int:
	var total := 0
	for row in _sessions:
		total += int((row.get("summary", {}) as Dictionary).get("logical", 0))
	return total


## The physical attempts across the counted sessions. Never conflated with the steps.
func physical_attempts() -> int:
	var total := 0
	for row in _sessions:
		total += int((row.get("summary", {}) as Dictionary).get("physical", 0))
	return total


## The helper requests across the counted sessions, counted separately from the work.
func helper_requests() -> int:
	var total := 0
	for row in _sessions:
		total += int((row.get("summary", {}) as Dictionary).get("helpers", 0))
	return total


## Whether every counted session was fully priced. Only then is the total complete.
func is_fully_priced() -> bool:
	if _sessions.is_empty():
		return false
	for row in _sessions:
		if not SessionUsage.from_summary(row.get("summary", {})).is_fully_priced():
			return false
	return true


## How many counted sessions carried a complete price, spelled out.
func priced_of() -> String:
	var priced := 0
	for row in _sessions:
		if SessionUsage.from_summary(row.get("summary", {})).is_fully_priced():
			priced += 1
	return "%d of %d" % [priced, _sessions.size()]


## The summed known cost as text. A total is only a sum of what was actually priced, so it
## is reported with its completeness beside it.
func cost_text() -> String:
	var any := false
	var total := 0.0
	for row in _sessions:
		var usage := SessionUsage.from_summary(row.get("summary", {}))
		if usage.has_cost():
			any = true
			total += usage.cost()
	if not any:
		return UNREPORTED
	return "$%.2f" % total


## A day breakdown is not available from this service, and says so.
func supports_day_breakdown() -> bool:
	return false


## Why a day breakdown is unavailable.
func unavailable_reason() -> String:
	return DAY_UNAVAILABLE


## A day grouping. Always empty, because there is no per-day source: an invented bucket
## would present a session's whole history under one arbitrary day.
func grouped_by_day() -> Array:
	return []


## Whether a session's accounted rows name this provider.
static func _uses_provider(row: Dictionary, provider_id: String) -> bool:
	for model in row.get("models", []):
		if _provider_of(str(model)) == provider_id:
			return true
	return false


## Whether a session's accounted rows name this exact model ref.
static func _uses_model(row: Dictionary, model_ref: String) -> bool:
	for model in row.get("models", []):
		if str(model) == model_ref:
			return true
	return false


## The provider part of a `provider/model` or `provider/model#variant` ref.
static func _provider_of(model_ref: String) -> String:
	return model_ref.split("/")[0] if model_ref.contains("/") else model_ref
