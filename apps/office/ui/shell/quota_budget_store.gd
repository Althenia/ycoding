## Persisted local advisory budgets.
##
## DESKTOP data, not runtime authority: losing it costs the user their warning thresholds and
## never changes what the service runs. The durable record stays server-owned.
##
## It follows the established desktop-preference pattern, for the same reasons:
##
##   * ONLY THE DECLARED FIELDS are copied, so a credential cannot reach the file even when a
##     caller hands one over;
##   * the file is SCHEMA-VERSIONED, and a version this build does not know is not adopted -
##     guessing at an unknown shape is how a preference store reads nonsense as state;
##   * the write is ATOMIC through a temporary file in the same directory, so a failed write
##     cannot leave a half-written budget where the good one was.
##
## Held under `user://`, so a budget is per-person rather than per-repository: a warning
## threshold is the user's own policy and does not belong in a shared checkout.
class_name QuotaBudgetStore
extends RefCounted

## ConfigFile section holding every budget this store owns.
const SECTION := "budgets"
## The schema version this build writes, and the only one it reads.
const SCHEMA_VERSION := 1
const VERSION_KEY := "version"
const BUDGETS_KEY := "entries"

## The default path under `user://`, Godot's own persistence idiom.
const DEFAULT_PATH := "user://quota_budgets.cfg"
## Suffix for the in-flight write. It sits beside the target so the rename that publishes it
## stays on one filesystem and is therefore atomic.
const TEMP_SUFFIX := ".tmp"

var _budgets: Dictionary = {}
var _last_error := ""

## The file this store reads and writes when a caller names no path. Held on the instance so
## a caller can point one at its own file: a test must never write over the preference a
## person is actually using.
var file_path := DEFAULT_PATH


## The temporary path a write goes through. Exposed so the atomicity of the write can be
## observed rather than assumed.
static func temp_path(path: String) -> String:
	return path + TEMP_SUFFIX


func last_error() -> String:
	return _last_error


## Every budget, in a stable order so a page renders the same list twice.
func budgets() -> Array[QuotaBudget]:
	var keys: Array[String] = []
	for key in _budgets:
		keys.append(str(key))
	keys.sort()
	var out: Array[QuotaBudget] = []
	for key in keys:
		out.append(_budgets[key])
	return out


## One budget, or an empty one when none is set for that scope.
func get_budget(scope: String, scope_id: String) -> QuotaBudget:
	return _budgets.get(_key(scope, scope_id), QuotaBudget.new())


## Set or replace the budget for its own scope.
##
## The budget's own construction is what restrict the fields: `from_fields` copies only
## `QuotaBudget.STORED_FIELDS`, so an undeclared field cannot be present on the object this
## receives. Re-filtering here would be a second guard on the same path, and a second guard
## is one more thing that can be wrong without anyone noticing.
func put(budget: QuotaBudget) -> void:
	if budget == null or budget.scope().is_empty():
		return
	_budgets[_key(budget.scope(), budget.scope_id())] = budget


func remove(scope: String, scope_id: String) -> void:
	_budgets.erase(_key(scope, scope_id))


## Read the persisted budgets. Never fails: an absent file is the normal first run, and a
## file that cannot be read leaves an empty store with a readable reason.
func load(path: String = "") -> void:
	var target := path if not path.is_empty() else file_path
	_last_error = ""
	_budgets = {}
	var config := ConfigFile.new()
	var error := config.load(target)
	if error != OK:
		if error != ERR_FILE_NOT_FOUND:
			_last_error = "The saved budgets could not be read."
		return
	var version := int(config.get_value(SECTION, VERSION_KEY, 0))
	if version != SCHEMA_VERSION:
		# The shape is unknown, so nothing in it is adopted.
		_last_error = "The saved budgets are version %d, which this build does not read." % version
		return
	var raw: Variant = config.get_value(SECTION, BUDGETS_KEY, null)
	if not (raw is Dictionary):
		if raw != null:
			_last_error = "The saved budgets were not in a readable form."
		return
	for key in (raw as Dictionary):
		var entry: Variant = (raw as Dictionary)[key]
		if not (entry is Dictionary):
			continue
		var budget := QuotaBudget.from_fields(entry as Dictionary)
		if not budget.scope().is_empty():
			_budgets[str(key)] = budget


## Persist the budgets atomically. Returns the write error so a caller can report it, and
## leaves an existing file untouched when the write cannot complete.
func save(path: String = "") -> Error:
	var target := path if not path.is_empty() else file_path
	var entries := {}
	for key in _budgets:
		entries[str(key)] = (_budgets[key] as QuotaBudget).raw()
	var config := ConfigFile.new()
	config.set_value(SECTION, VERSION_KEY, SCHEMA_VERSION)
	config.set_value(SECTION, BUDGETS_KEY, entries)
	var temp := temp_path(target)
	var error := config.save(temp)
	if error != OK:
		# A failed write must not leave a partial file where a preference is expected.
		if FileAccess.file_exists(temp):
			DirAccess.remove_absolute(temp)
		_last_error = "The budgets could not be written."
		return error
	# The rename is what publishes it. Until this succeeds the previous file is still the
	# whole truth, which is why a failure here is recoverable rather than data loss.
	error = DirAccess.rename_absolute(temp, target)
	if error != OK:
		DirAccess.remove_absolute(temp)
		_last_error = "The budgets could not be written."
		return error
	_last_error = ""
	return OK


func _key(scope: String, scope_id: String) -> String:
	return "%s:%s" % [scope, scope_id]
