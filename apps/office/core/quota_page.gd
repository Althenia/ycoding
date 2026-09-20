## Provider quota snapshots, presented without inventing a figure.
##
## The runtime normalizes this already: `GET /api/provider/usage` answers
## `Location.response(Schema.Array(ProviderUsage.Snapshot))` - a `location` AND a `data`
## envelope - and `GET /api/provider/:providerID/usage` answers one Snapshot
## (packages/protocol/src/groups/provider-usage.ts). This page presents them; it never
## recomputes them.
##
## The acceptance's rules each rule out a specific lie:
##
##   LANES AND UNITS ARE INDEPENDENT. Two usd windows are two DIFFERENT limits, and adding
##   them produces a limit that does not exist. Adding a percent window to a count window
##   produces a number describing nothing. So `has_combined_total` is false and no window is
##   ever combined with another.
##
##   UNSUPPORTED PROVIDERS ARE NOT RENDERED. A provider the runtime cannot read usage from has no
##   figures to show. The snapshot is still ADOPTED and still readable - the status, the
##   source and the provider's own message are all retained - but it produces no row, no card
##   and no placeholder. Every other status IS rendered, because each of those is a statement
##   about usage: `stale` and `error` describe a read of figures that exist or failed, and
##   `unauthorized` names a permission the user can act on.
##
##   FRESHNESS IS THE PROVIDER'S TIMESTAMP. `updatedAt` is the snapshot's own, and the page
##   reports a staleness the runtime stated rather than one it measured itself.
##
## QUOTA IS NOT COST. A provider window is the provider's own account limit; the session
## usage this client also reads is its own provider-request accounting. They are different
## surfaces with different sources and are never merged.
class_name QuotaPage
extends RefCounted

## What an unreported value renders as, matching the usage surfaces.
const UNREPORTED := QuotaWindow.UNREPORTED

## The page's own freshness, from the runtime's status rather than a local clock.
const FRESH := "fresh"
const STALE := "stale"
const ERROR := "error"

## The one snapshot status that produces no row. `ProviderUsage.Status` also declares
## `available`, `stale`, `unauthorized` and `error`; each of those describes a read, so each
## is rendered.
const UNSUPPORTED_STATUS := "unsupported"

## Passed as the read time where the test does not care about it.
const VALID_AT := 0

var _snapshots: Array = []
var _freshness := FRESH
var _read_at := 0


static func empty() -> QuotaPage:
	return QuotaPage.new()


## Adopt the snapshots the service reported, with the freshness the runtime stated.
##
## `freshness` is the runtime's own status, not a measurement made here: a quota read is best
## effort, so the page reports what it was told.
func adopt(snapshots: Array, read_at: int = VALID_AT, freshness: String = FRESH) -> void:
	_snapshots = snapshots if snapshots is Array else []
	_freshness = freshness
	_read_at = read_at


## One provider's windows, in the order the service reported them.
func windows_for(provider_id: String) -> Array[QuotaWindow]:
	var out: Array[QuotaWindow] = []
	for snapshot in _snapshots:
		if snapshot is Dictionary and str(snapshot.get("providerID", "")) == provider_id:
			for window in snapshot.get("windows", []):
				if window is Dictionary:
					out.append(QuotaWindow.from_wire(window))
	return out


## A row per provider the service reported with usage to show.
##
## An `unsupported` provider is SKIPPED: the runtime stated it cannot read that account's
## usage, so the row would describe a provider that has nothing to describe. This is the same
## presentation rule the TUI applies (`visibleProviderSnapshots`,
## packages/tui/src/routes/session/provider-usage.tsx:45-48), and it filters DISPLAY only -
## `_snapshots` keeps every snapshot the reader delivered, so nothing about provenance or
## status is destroyed.
##
## Every other status keeps its row, INCLUDING one this build does not recognize: a status
## the schema later adds must render as itself rather than vanish, and silently dropping an
## unexpected value is how a real state becomes invisible.
func provider_rows() -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for snapshot in _snapshots:
		if not (snapshot is Dictionary):
			continue
		var status := str(snapshot.get("status", ""))
		if status == UNSUPPORTED_STATUS:
			continue
		var windows: Variant = snapshot.get("windows", [])
		rows.append({
			"provider": str(snapshot.get("providerID", "")),
			"label": str(snapshot.get("label", "")),
			"status": status,
			"source": str(snapshot.get("source", "")),
			"stability": str(snapshot.get("stability", "")),
			"windows": windows.size() if windows is Array else 0,
			"updated_at": int(snapshot.get("updatedAt", 0)),
			"updated_text": _updated_text(int(snapshot.get("updatedAt", 0))),
			"note": _note(status, str(snapshot.get("message", ""))),
		})
	return rows


## Whether the reader delivered any snapshot at all, including ones that produce no row.
##
## A surface needs this to tell "the runtime reported nothing" from "the runtime reported
## providers that have no usage to show": those are different facts, and only the first one
## may say that no provider reported usage.
func has_snapshots() -> bool:
	return not _snapshots.is_empty()


## Whether the page offers a total across windows. It does NOT: windows differ in unit, and
## two windows of one unit are two different limits.
func has_combined_total() -> bool:
	return false


## Why there is no combined total.
func combined_total_text() -> String:
	return "No combined total: provider windows have their own units and their own limits, and summing them would describe a limit that does not exist."


## The page's freshness, as the runtime stated it.
func freshness() -> String:
	return _freshness


func freshness_text() -> String:
	if _freshness == STALE:
		return "These figures are stale: the runtime reported them as out of date."
	if _freshness == ERROR:
		return "These figures could not be refreshed."
	return "Figures as the runtime last reported them."


## A provider's state as a reader needs to read it. The status is the fact and the note
## explains it.
##
## There is no `unsupported` branch: those snapshots produce no row, so a note for one would
## be text nothing could ever render. A status this build does not know is still named, so an
## unrecognized state reads as itself rather than as an empty row.
func _note(status: String, message: String) -> String:
	if not message.is_empty():
		return message
	if status == "unauthorized":
		return "This account is not authorized to read provider usage."
	if status == "stale":
		return "These figures are out of date."
	if status == "error":
		return "The provider usage read failed."
	if status == "available":
		return ""
	return "Provider usage status: %s" % status


## The provider's own timestamp, rendered. An absent timestamp is unreported, not "now".
##
## `updatedAt` is MILLISECONDS since the epoch, which the schema's `NonNegativeInt` does not
## say and only the value reveals: the runtime writes `now()` into it
## (packages/core/src/provider-usage.ts) and the TUI compares it against `Date.now()` and
## divides by 60_000 for minutes (packages/tui/src/util/provider-usage.ts). Reading it as
## seconds renders the year 58683, which is what this looked like before it was verified.
func _updated_text(updated_at: int) -> String:
	if updated_at <= 0:
		return UNREPORTED
	return Time.get_datetime_string_from_unix_time(_seconds(updated_at), true)


## Epoch milliseconds as epoch seconds. A value already in seconds is left alone, so a
## producer using the other convention is not misread either.
static func _seconds(milliseconds: int) -> int:
	if milliseconds >= 100000000000:
		return milliseconds / 1000
	return milliseconds
