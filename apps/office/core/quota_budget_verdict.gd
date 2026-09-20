## What a budget comparison found.
##
## A separate value from the budget itself, because the budget is a SETTING and this is an
## OBSERVATION. Keeping them apart is what stops an observation from being mistaken for a
## policy, and it is why nothing here can stop work.
##
## The distinctions this carries:
##
##   * KNOWN vs NOT KNOWN. An unknown spend makes the comparison PARTIAL. It does not pass,
##     because "under budget" over an unread figure is a claim the client cannot make.
##   * WARNED vs DISMISSED. A dismissed warning still carries its figures. Dismissing a
##     notification is not the same as hiding what it described.
##   * OVER vs UNDER. Past the limit, or merely past the threshold, or neither.
class_name QuotaBudgetVerdict
extends RefCounted

const UNREPORTED := "Not reported"

## Whether the spend this was compared against was actually known.
var known := false
var spend := 0.0
var limit := 0.0
var warn_at := 0.0
var dismissed := false
var scope_label := ""


## Whether the comparison had a real figure to compare.
func is_known() -> bool:
	return known


## Whether the spend has passed the budget's limit.
##
## False when the spend is unknown: nothing about the limit can be said without a figure.
func is_over() -> bool:
	return known and spend >= limit


## Whether this warrants a warning: the spend is known, has reached the threshold, and the
## user has not already dismissed it.
func should_warn() -> bool:
	if not known or dismissed:
		return false
	return spend >= limit * warn_at if warn_at > 0.0 else spend >= limit


## The observed spend as text, or unreported. Never a zero standing in for an unknown figure.
func spend_text() -> String:
	if not known:
		return UNREPORTED
	return _money(spend)


func limit_text() -> String:
	return _money(limit)


## A sentence describing the finding, always naming what the budget is.
func text() -> String:
	if not known:
		return "%s: spend is %s, so no comparison is made." % [scope_label, UNREPORTED]
	if should_warn():
		return "%s: %s spent of %s." % [scope_label, _money(spend), _money(limit)]
	if is_over():
		return "%s: past its limit at %s of %s, and already acknowledged." % [
			scope_label, _money(spend), _money(limit),
		]
	return "%s: %s spent of %s, within the budget." % [
		scope_label, _money(spend), _money(limit),
	]


func _money(value: float) -> String:
	if is_equal_approx(value, round(value)):
		return str(int(round(value)))
	return "%.2f" % value
