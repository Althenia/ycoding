## One provider quota window, as the runtime reports it.
##
## `ProviderUsage.Window` (packages/schema/src/provider-usage.ts) requires only `id`, `label`
## and `unit`. Every figure - `used`, `limit`, `remaining`, `unlimited`, `resetAt`,
## `periodSeconds` - is OPTIONAL, and the live service really does omit some:
##
##   openrouter "Key limit"     unit=usd,     used=44.14, limit=50, remaining=5.86
##   openrouter "Daily"         unit=usd,     used=0.33            <- NO limit
##   openai     "Weekly"        unit=percent, used=100, resetAt, periodSeconds
##   openai     "Reset credits" unit=count,   remaining=1
##
## Three distinctions follow from the optionality, and each is a way a quota display lies:
##
##   MISSING IS NOT ZERO. A window with `used` and no `limit` has an UNREPORTED limit. Zero
##   would claim the provider allows nothing.
##
##   MISSING IS NOT UNLIMITED. Only the provider's own `unlimited` flag says unlimited. A
##   missing limit is the absence of a statement, and reading it as "no limit so no worries"
##   is the opposite of what the absence means.
##
##   A SHARE NEEDS A DENOMINATOR. A percentage is shown when the provider gave one (used AND
##   a non-zero limit), or when the unit IS percent and the figure therefore already is one.
##   A share derived from a missing denominator describes nothing.
class_name QuotaWindow
extends RefCounted

const UNREPORTED := "Not reported"

var _window: Dictionary = {}


static func empty() -> QuotaWindow:
	return QuotaWindow.new()


static func from_wire(window: Dictionary) -> QuotaWindow:
	var out := QuotaWindow.new()
	out._window = window if window is Dictionary else {}
	return out


func id() -> String:
	return str(_window.get("id", ""))


func label() -> String:
	return str(_window.get("label", ""))


func unit() -> String:
	return str(_window.get("unit", ""))


func unit_is_percent() -> bool:
	return unit() == "percent"


## Whether the provider stated a limit. Absent means unreported, never zero.
func has_limit() -> bool:
	return _window.get("limit", null) != null


func limit() -> float:
	return float(_window.get("limit", 0.0))


## The limit as text, or the unreported marker. Never "0" for an absent limit.
func limit_text() -> String:
	if not has_limit():
		return UNREPORTED
	return _format(limit())


func has_used() -> bool:
	return _window.get("used", null) != null


func used_text() -> String:
	if not has_used():
		return UNREPORTED
	return _format(float(_window.get("used")))


func has_remaining() -> bool:
	return _window.get("remaining", null) != null


func remaining_text() -> String:
	if not has_remaining():
		return UNREPORTED
	return _format(float(_window.get("remaining")))


## Whether the PROVIDER marked this window unlimited. Its absence is not a claim of
## unlimited.
func is_unlimited() -> bool:
	return bool(_window.get("unlimited", false))


## The share of the limit used, or the unreported marker.
##
## A percentage requires a real denominator. It is NOT derived from a missing limit, and a
## zero limit is not used as a denominator either - a share of nothing is not a figure.
func percent_text() -> String:
	# A window whose unit IS percent already carries the figure.
	if unit_is_percent() and has_used():
		return "%d%%" % int(round(float(_window.get("used"))))
	if not has_used():
		return UNREPORTED
	# A missing limit reads as 0 here, and a zero denominator yields no share: the provider
	# stated no limit, and a share of nothing is not a percentage.
	var denominator := limit()
	if denominator <= 0.0:
		return UNREPORTED
	return "%d%%" % int(round(float(_window.get("used")) / denominator * 100.0))


## When the window resets, as text, or the unreported marker.
##
## `resetAt` is epoch MILLISECONDS, like `updatedAt`: the live service reports
## `1789805590000`, and reading that as seconds yields the year 58682.
func reset_text() -> String:
	var reset: Variant = _window.get("resetAt", null)
	if reset == null:
		return UNREPORTED
	var value := int(reset)
	if value >= 100000000000:
		value = value / 1000
	return Time.get_datetime_string_from_unix_time(value, true)


## The window's period as text, or the unreported marker.
func period_text() -> String:
	var seconds: Variant = _window.get("periodSeconds", null)
	if seconds == null:
		return UNREPORTED
	var total := int(seconds)
	if total % 86400 == 0:
		return "%d days" % (total / 86400)
	if total % 3600 == 0:
		return "%d hours" % (total / 3600)
	return "%d seconds" % total


## One line describing the window, with every unreported figure saying so.
func summary_text() -> String:
	return "%s: %s used of %s%s" % [
		label(),
		used_text(),
		limit_text(),
		"" if not is_unlimited() else " (unlimited)",
	]


## A number without a trailing zero, so 50.0 reads as 50 and 44.14 keeps its cents.
func _format(value: float) -> String:
	if is_equal_approx(value, round(value)):
		return str(int(round(value)))
	return "%.2f" % value
