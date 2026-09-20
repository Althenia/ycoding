## A local advisory budget.
##
## Three DIFFERENT things that a careless UI merges into one:
##
##   A PROVIDER QUOTA is provider data - the account's own limit, reported by the provider.
##   A RATE LIMIT is a time-window constraint or a 429 observation.
##   A LOCAL BUDGET is the user's own warning policy. This class.
##
## The kit is explicit that "each needs its own label", and that "a budget presented as
## hard/enforced requires backend admission/continuation enforcement shared with the TUI and
## all concurrent sessions, not disabling the desktop Send button". No such enforcement
## exists, so this budget is ADVISORY BY CONSTRUCTION:
##
##   * it exposes NO method that blocks, denies, or cancels anything, so a caller cannot make
##     it stop work even by mistake;
##   * `is_enforced()` is false and `ENFORCED_REASON` names what enforcement would actually
##     require, so the absence is explained rather than merely asserted;
##   * its label says it is the user's own warning, and never reads as a provider's limit;
##   * when the spend is not known, the evaluation is PARTIAL rather than passing - reporting
##     "under budget" over an unread figure is a claim this client cannot make.
##
## A dismissed warning suppresses the WARNING and never the accounting: the figures stay
## readable, because dismissing a notification is not the same as hiding what it described.
class_name QuotaBudget
extends RefCounted

## The scopes with real accounting support: a provider account, a project, a session. The
## kit says "only expose scopes with real accounting support", and these are the three the
## runtime's own summaries can actually be attributed to.
const SCOPE_PROVIDER := "provider"
const SCOPE_PROJECT := "project"
const SCOPE_SESSION := "session"
const SUPPORTED_SCOPES := [SCOPE_PROVIDER, SCOPE_PROJECT, SCOPE_SESSION]

## Why this budget cannot be enforced. Stated rather than implied, so a reader is not left
## wondering whether the control is merely unimplemented.
const ENFORCED_REASON := (
	"Enforcing a budget would require admission and continuation enforcement in the shared " +
	"backend, applying to the TUI and every concurrent session. No such enforcement exists, " +
	"so this budget warns only and never stops work."
)

## The fields a budget may carry. Exactly this list is persisted, so an undeclared field -
## including a credential - cannot reach the file.
const STORED_FIELDS := [
	"scope", "scope_id", "unit", "limit", "period_seconds", "warn_at", "dismissed",
]

var _fields: Dictionary = {}
var _last_error := ""


## Build a budget from caller-supplied fields, refusing the shapes that are not budgets.
##
## An unsupported scope is refused rather than accepted and ignored: a budget for a scope
## nothing can be attributed to would warn about a figure that never exists.
static func from_fields(fields: Dictionary) -> QuotaBudget:
	var out := QuotaBudget.new()
	var scope := str(fields.get("scope", ""))
	if not is_supported_scope(scope):
		out._last_error = "No accounting supports a '%s' scope, so a budget for it is not accepted." % scope
		return out
	var limit := float(fields.get("limit", 0.0))
	if not is_finite(limit) or limit <= 0.0:
		out._last_error = "A budget needs a limit greater than zero."
		return out
	for key in STORED_FIELDS:
		if fields.has(key):
			out._fields[key] = fields[key]
	out._fields["scope"] = scope
	out._fields["limit"] = limit
	out._last_error = ""
	return out


static func is_supported_scope(scope: String) -> bool:
	return SUPPORTED_SCOPES.has(scope)


func last_error() -> String:
	return _last_error


## The declared fields, for a store to persist. A copy, so a caller cannot mutate the budget
## by holding its dictionary.
func raw() -> Dictionary:
	return _fields.duplicate(true)


func scope() -> String:
	return str(_fields.get("scope", ""))


func scope_id() -> String:
	return str(_fields.get("scope_id", ""))


func unit() -> String:
	return str(_fields.get("unit", ""))


func limit() -> float:
	return float(_fields.get("limit", 0.0))


func period_seconds() -> int:
	return int(_fields.get("period_seconds", 0))


func warn_at() -> float:
	return float(_fields.get("warn_at", 0.0))


func is_dismissed() -> bool:
	return bool(_fields.get("dismissed", false))


## Remember that the user has seen this warning. Suppresses the warning, never the figures.
func dismiss() -> void:
	_fields["dismissed"] = true


## A local budget is always advisory. True by construction, because nothing else exists.
func is_advisory() -> bool:
	return true


## Whether the runtime enforces this budget. Never: enforcement lives in the backend and does
## not exist for a desktop budget.
func is_enforced() -> bool:
	return false


## The period as readable text.
func period_text() -> String:
	var total := period_seconds()
	if total <= 0:
		return "no period set"
	if total % 86400 == 0:
		return "%d days" % (total / 86400)
	if total % 3600 == 0:
		return "%d hours" % (total / 3600)
	return "%d seconds" % total


## The budget's own label.
##
## It names the scope, the id and the currency, and says it is the user's own warning. It
## never reads as the provider's limit, because that is a different fact from a different
## source.
func label() -> String:
	var where := scope()
	if not scope_id().is_empty():
		where = "%s %s" % [scope(), scope_id()]
	var money := ""
	if not unit().is_empty():
		money = " in %s" % unit()
	return "Your advisory %s budget%s" % [where, money]


## Compare observed spend against this budget.
##
## `known` is whether the spend is actually known. An evaluation over an unknown figure is
## PARTIAL: it does not pass, because passing would claim a comparison that never happened.
func evaluate(spend: float, known: bool) -> QuotaBudgetVerdict:
	var verdict := QuotaBudgetVerdict.new()
	verdict.known = known
	verdict.spend = spend
	verdict.limit = limit()
	verdict.warn_at = warn_at()
	verdict.dismissed = is_dismissed()
	verdict.scope_label = label()
	return verdict


func _init() -> void:
	pass
