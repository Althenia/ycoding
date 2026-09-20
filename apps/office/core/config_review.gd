## The rules for reviewing and editing configuration, kept out of the widget.
##
## A settings surface has to answer questions that are easy to get subtly wrong, and
## every one of them is decided here so a test can reach it:
##
##   * WHAT IS THE EFFECTIVE VALUE, and which document does it come from? `values` and
##     `sources` are the service's own answer; this class only reads them.
##   * WHICH SCOPE WOULD A WRITE GO TO? The document that most specifically defines the
##     key, among the scopes the API can write. A key only the global document defines is
##     written globally; one the project document defines is written to the project.
##   * MAY THIS VALUE BE WRITTEN AT ALL? A value whose most specific source is `virtual`
##     (a document with no file path, or inline content) has NO file to write, so the
##     edit is refused with a stated reason instead of failing at commit time.
##   * IS THIS TEXT SAFE TO SEND? A value the service withheld as `[redacted]` must never
##     be written back: that would store the placeholder in place of a credential.
##
## It is pure presentation logic in the sense that it owns no scene tree, but it drives
## a real `ConfigApi`. It never invents a value: before a read settles there is no
## effective value at all, and a failed read reports its reason rather than showing the
## last known values as if they were current.
class_name ConfigReview
extends RefCounted

const IDLE := "idle"
const LOADING := "loading"
const READY := "ready"
const ERROR := "error"

## The state of the last read.
const PREVIEW_IDLE := "preview_idle"
const PREVIEW_PENDING := "preview_pending"
const PREVIEW_READY := "preview_ready"

var _api: ConfigApi
var _state := IDLE
var _last_error := ""
var _preview_state := PREVIEW_IDLE
## The write scope the user chose in the settings selector. "" means "follow the
## document that owns the value", which is the only correct default before a choice is
## made. Once set, it OVERRIDES the effective owner, so choosing Project cannot
## silently write Global.
var _chosen_scope := ""
## Identity of the call in flight, captured when it is REQUESTED.
##
## A response is compared against this rather than against whatever the editor holds when
## the answer lands. Without it, an edit made while a preview was in flight would be
## blessed by an answer that validated DIFFERENT text - and the apply control, whose whole
## guarantee is that it commits validated text, would then commit unvalidated text.
var _pending_request: Dictionary = {}
## The identity of the last settled call, so a caller can compare an answer against the
## exact request it belongs to.
var _settled_request: Dictionary = {}
## Whether a COMMIT is the call in flight. Tracked separately from the preview state so a
## caller can refuse a second commit without mistaking an idempotent read for one.
var _commit_pending := false


func configure(api: ConfigApi) -> void:
	# Rebinding to another reader must not leave a request in flight on the OLD transport.
	# An answer for the location the user has left must not be adopted for the one they
	# are in, and the old request would otherwise still be polled by nothing.
	if _api != null and _api != api:
		_api.cancel_pending()
	_api = api
	_state = IDLE
	_last_error = ""
	_preview_state = PREVIEW_IDLE
	_pending_request = {}
	_chosen_scope = ""


func state() -> String:
	return _state


func last_error() -> String:
	return _last_error


func preview_state() -> String:
	return _preview_state


## Whether a configuration call is in flight. The composition root uses this to decide
## whether to advance the review on a frame, so the gate is a named operation rather than
## a reader of one particular sub-state.
func is_pending() -> bool:
	return _api != null and _api.is_pending()


## The location the service resolved for the read, or "". Named separately from the
## values because a value without its location is not a statement about anywhere.
func resolved_directory() -> String:
	if _api == null:
		return ""
	return str(_api.resolved_location().get("directory", ""))


## Start a read. A read for a different location REPLACES the values rather than merging
## them: an answer for a folder the user has left does not describe where they are.
func begin_read() -> bool:
	if _api == null:
		_state = ERROR
		_last_error = "No configuration reader is configured."
		return false
	_state = LOADING
	_last_error = ""
	_preview_state = PREVIEW_IDLE
	if not _api.start_read():
		_state = ERROR
		_last_error = _api.last_error()
		return false
	return true


## Advance the read. Returns whether the state changed on this call.
func poll() -> bool:
	if _api == null or not _api.is_pending():
		return false
	if not _api.poll():
		return false
	if _api.last_error().is_empty():
		_state = READY
		_last_error = ""
		return true
	_state = ERROR
	_last_error = _api.last_error()
	return true


## Read to completion within one bounded wait. For tests and one-shot callers.
func read_now() -> bool:
	if not begin_read():
		return false
	while _api.is_pending():
		poll()
	return _state == READY


## Whether the last read produced values.
func has_values() -> bool:
	return _state == READY


## The effective value for a top-level key, or null when no document defines it.
func value_for(key: String) -> Variant:
	if not has_values():
		return null
	var values := _api.read_values()
	return values.get(key, null)


## Whether a top-level key is defined by any document.
func defines(key: String) -> bool:
	if not has_values():
		return false
	return _api.read_values().has(key)


## The keys a page owns that the read actually reports, in the page's own order.
func keys_for_page(page: String) -> Array[String]:
	var out: Array[String] = []
	if not has_values():
		return out
	for key in SettingsGroup.keys_for(page):
		if defines(key):
			out.append(key)
	return out


## The raw text an editor should start from for a key.
##
## The editor speaks the same language the DOCUMENT does - JSON, because the document is
## JSONC - so a string is quoted, a number is bare, and an object keeps its shape. That
## is what makes the round trip unambiguous: sending back exactly what was shown cannot
## change a string like "123" into the number 123.
##
## A key no document defines starts blank, because a JSON `null` means the key is ABSENT
## rather than set to null, and inventing a placeholder would be inventing a value.
func raw_text_for(key: String) -> String:
	if not defines(key):
		return ""
	return JSON.stringify(value_for(key), "\t")


## A value rendered for display, with a withheld value shown as withheld.
func render_value(key: String) -> String:
	var value: Variant = value_for(key)
	if not defines(key):
		return "(not set by any document)"
	if ConfigApi.is_redacted(value):
		return "%s (configured; the service withholds the value)" % ConfigApi.REDACTED
	return raw_text_for(key)


## The most specific document that defines a key, as a readable name. `` when the key is
## not defined.
##
## "Most specific" means the LAST contributor in ascending priority whose key list names
## it, because the API reports sources lowest priority first and the settled value is the
## highest-priority contributor.
func provenance_for(key: String) -> String:
	var source := _source_for(key)
	if source.is_empty():
		return ""
	var scope := str(source.get("scope", ""))
	var path := str(source.get("path", ""))
	return "%s (%s)" % [scope, path] if not path.is_empty() else scope


## The scope the user chose, or "" when the review should follow the effective owner.
func chosen_scope() -> String:
	return _chosen_scope


## Choose the write scope. A scope that is not writable is refused, and a change
## INVALIDATES any settled preview, because the revision a preview validated belongs to
## the old scope's document and committing it against another document would either be
## refused as stale or - worse - be accepted by a document the user did not choose.
func set_chosen_scope(scope: String) -> bool:
	if not SettingsScope.is_writable(scope):
		_last_error = "'%s' is not a writable configuration scope." % scope
		return false
	if scope == _chosen_scope:
		return false
	_chosen_scope = scope
	_pending_request = {}
	_preview_state = PREVIEW_IDLE
	return true


## The scope the effective value comes from, or "" when no document defines the key.
func effective_scope_for(key: String) -> String:
	var source := _source_for(key)
	return str(source.get("scope", "")) if not source.is_empty() else ""


## The revision of the document a write to `scope` would TARGET.
##
## Discovery can find SEVERAL documents of one scope, and the owner's `targetOf` selects
## the LAST one in priority order (`packages/core/src/config.ts` uses `findLast`). The
## first match would be a different document, so a guard built from it would let a
## concurrent edit to the real target pass undetected.
func revision_for_scope(scope: String) -> String:
	if _api == null:
		return ""
	return _api.target_revision_for(scope)


## The scope a write for this key would target, or "" when no write is possible.
##
## The USER'S choice wins when one is set: choosing Project writes the project document
## even when the effective value is owned by global, because that is what the choice
## means. With no choice, the most specific document that defines the key is used - and a
## key whose owner is `virtual` has no file to write, so it stays unwritable either way.
func write_scope_for(key: String) -> String:
	if not has_values():
		return ""
	if SettingsScope.is_writable(_chosen_scope):
		return _chosen_scope
	var source := _source_for(key)
	if source.is_empty():
		return ConfigApi.WRITE_GLOBAL
	var scope := str(source.get("scope", ""))
	return scope if SettingsScope.is_writable(scope) else ""


## Why a key cannot be written, or "" when it can. Stated wherever a value is shown, so
## an unavailable write is explained rather than silently missing.
func write_refusal_for(key: String) -> String:
	if not has_values():
		return "The effective configuration has not been read, so there is nothing to write."
	var scope := write_scope_for(key)
	if not scope.is_empty():
		return ""
	var source := _source_for(key)
	if source.is_empty():
		return "No document defines this key, so there is nothing to change here."
	# The document that owns the key has no file to write it to.
	return SettingsScope.not_a_scope_explanation(str(source.get("scope", "")))


## Whether a key can be REMOVED from the document a write would target.
##
## Removal is expressed on the wire as `null` for the key, so it can only act on a key the
## TARGET document actually defines. Removing a key that document does not define would
## write nothing while looking like it deleted something - the enabled-affordance defect.
##
## A withheld value is refused separately: the key may well be defined, but removing a
## credential is a more sensitive flow than removing an ordinary setting, and it is not
## part of this step.
func can_remove(key: String) -> bool:
	return remove_refusal(key).is_empty()


## Why a key cannot be removed here, or "" when it can.
func remove_refusal(key: String) -> String:
	if not has_values():
		return "The effective configuration has not been read, so there is nothing to remove."
	# A withheld value is refused FIRST, because that is the more specific answer: the key
	# may well be defined, but removing a credential is a separate flow. Checked through the
	# SAME recursion the write guard uses, so a record whose nested leaf is withheld is
	# refused too - the service redacts nested credential leaves inside a record, and an
	# ordinary Remove must not be able to delete one.
	var withheld := ConfigApi.withheld_write_reason({key: value_for(key)})
	if not withheld.is_empty():
		return (
			"This value includes something the service withholds. Removing a credential is a "
			+ "separate flow from removing an ordinary setting, so it is not offered here. %s"
		) % withheld
	var scope := write_scope_for(key)
	if scope.is_empty():
		return write_refusal_for(key)
	if _defines_in(key, scope):
		return ""
	# The key is in force, but the document being written does not define it: the value
	# would come back from whichever document does, so removing it here deletes nothing.
	var owner := effective_scope_for(key)
	if owner.is_empty():
		return "No document defines this key, so there is nothing to remove."
	return (
		(
			"The %s document does not define this key, so removing it there would change "
			+ "nothing. It is set by the %s document."
		) % [scope, owner]
	)


## Whether the document a write to `scope` TARGETS defines `key`.
##
## The target is the LAST document of that scope, matching the owner's own `findLast`
## selection. Checking any document of the scope would offer a removal for a key the target
## does not define, which would write nothing while appearing to delete a value.
func _defines_in(key: String, scope: String) -> bool:
	var target := _target_source(scope)
	if target.is_empty():
		return false
	var keys: Variant = target.get("keys", [])
	return keys is Array and (keys as Array).has(key)


## The document a write to `scope` would target: the LAST source of that scope, or {}.
func _target_source(scope: String) -> Dictionary:
	if _api == null:
		return {}
	var found: Dictionary = {}
	for value in _api.sources():
		var source: Dictionary = value
		if str(source.get("scope", "")) == scope:
			# Ascending priority, so the last match is the target the owner writes.
			found = source
	return found


## Start a preview that REMOVES a key from the document a write would target.
##
## The wire spelling of a removal is a `null` value, so the preview request is built from
## `removal_patch` rather than from editor text. The request identity records the removal
## so the commit cannot be mistaken for an edit of the same key - the two produce
## different payloads for the same key name.
func begin_preview_removal(key: String) -> bool:
	if _api == null:
		_last_error = "No configuration reader is configured."
		return false
	if _api.is_pending():
		_last_error = "A configuration call is still in flight. Wait for it to answer."
		return false
	var refusal := remove_refusal(key)
	if not refusal.is_empty():
		_last_error = refusal
		_preview_state = PREVIEW_IDLE
		return false
	var scope := write_scope_for(key)
	var guard := revision_for_scope(scope)
	_pending_request = {
		"kind": ConfigApi.KIND_PREVIEW,
		"key": key,
		"removal": true,
		"scope": scope,
		"expectedRevision": guard,
	}
	_preview_state = PREVIEW_PENDING
	_last_error = ""
	if not _api.start_preview(ConfigApi.removal_patch(key), scope, guard):
		_last_error = _api.last_error()
		_preview_state = PREVIEW_IDLE
		_pending_request = {}
		return false
	return true


## Start a commit that removes a key.
##
## Requires a settled REMOVAL preview for the same key, so a removal cannot be issued from
## an edit's validation or the other way round.
func begin_commit_removal(key: String, expected_revision: String) -> bool:
	if _api == null:
		_last_error = "No configuration reader is configured."
		return false
	if expected_revision.is_empty():
		_last_error = "Nothing has been previewed for this value, so it has not been validated."
		return false
	if _api.is_pending():
		_last_error = "A configuration call is still in flight. Wait for it to answer."
		return false
	var validated_key := str(_settled_request.get("key", ""))
	if validated_key != key or not bool(_settled_request.get("removal", false)) \
			or _preview_state != PREVIEW_READY:
		_last_error = (
			"The removal to write is not the one the preview validated. Preview it again."
		)
		return false
	var validated_scope := str(_settled_request.get("scope", ""))
	var scope := validated_scope if SettingsScope.is_writable(validated_scope) else write_scope_for(key)
	if scope.is_empty():
		_last_error = write_refusal_for(key)
		return false
	_commit_pending = true
	_last_error = ""
	if not _api.start_commit(ConfigApi.removal_patch(key), scope, expected_revision):
		_last_error = _api.last_error()
		_commit_pending = false
		return false
	return true


## A withheld value must never be re-sent. Returns a reason when the text for `key` would
## write the service's placeholder back, and "" when it is safe.
##
## Checked on the TEXT the user is about to send rather than only on the object read, so
## a placeholder the user copied by hand is caught too.
func withheld_reason(key: String, text: String) -> String:
	if text.strip_edges() != ConfigApi.REDACTED:
		return ""
	var value: Variant = value_for(key)
	if not ConfigApi.is_redacted(value):
		# The user typed the sentinel themselves for a key that is not withheld. That is
		# still almost certainly a mistake, and writing it verbatim would store the
		# placeholder as a literal value.
		return (
			"'%s' is the service's redaction placeholder, not a value. Writing it would "
			+ "store that text as the setting."
		) % ConfigApi.REDACTED
	return (
		"This value is withheld by the service and cannot be written back: sending the "
		+ "placeholder would replace the real value. Enter a new value, or leave it alone."
	)


## The document that most specifically defines a key, or {}.
func _source_for(key: String) -> Dictionary:
	if not has_values():
		return {}
	var found: Dictionary = {}
	for value in _api.sources():
		var source: Dictionary = value
		var keys: Variant = source.get("keys", [])
		if keys is Array and (keys as Array).has(key):
			# Ascending priority, so the last match wins.
			found = source
	return found


## Start a preview of one key's new text against the scope a write would use.
##
## The key, text, scope and the revision the client will guard with are captured HERE,
## when the request is made. The settled answer is matched against that identity, so an
## edit made while the call was in flight cannot have its answer bless text the service
## never validated.
func begin_preview(key: String, text: String) -> bool:
	if _api == null:
		_last_error = "No configuration reader is configured."
		return false
	if _api.is_pending():
		_last_error = "A configuration call is still in flight. Wait for it to answer."
		return false
	var scope := write_scope_for(key)
	if scope.is_empty():
		_last_error = write_refusal_for(key)
		_preview_state = PREVIEW_IDLE
		return false
	var refusal := withheld_reason(key, text)
	if not refusal.is_empty():
		_last_error = refusal
		_preview_state = PREVIEW_IDLE
		return false
	var invalid := text_refusal(text)
	if not invalid.is_empty():
		_last_error = invalid
		_preview_state = PREVIEW_IDLE
		return false
	# The guard comes from the document of the SCOPE BEING WRITTEN, not from whichever
	# document happens to define the key: a project write must present the project
	# document's revision or the service cannot tell whether that file moved.
	var guard := revision_for_scope(scope)
	_pending_request = {
		"kind": ConfigApi.KIND_PREVIEW,
		"key": key,
		"text": text,
		"scope": scope,
		"expectedRevision": guard,
	}
	_preview_state = PREVIEW_PENDING
	_last_error = ""
	if not _api.start_preview(ConfigApi.key_patch(key, parse_text(text)), scope, guard):
		_last_error = _api.last_error()
		_preview_state = PREVIEW_IDLE
		_pending_request = {}
		return false
	return true


## The request identity of the call in flight, or {} when none is.
##
## Exposed so the composition root can compare a settled answer against exactly what was
## asked, rather than against the editor's current contents.
func pending_request() -> Dictionary:
	return _pending_request.duplicate(true)


## Advance a pending preview. Returns whether it settled on this call.
##
## On settlement the identity captured at request time is retained in
## `settled_request()`, so the caller can compare the answer to what was asked rather than
## to what the editor holds now.
func poll_preview() -> bool:
	if _api == null or _api.is_pending() == false or _preview_state != PREVIEW_PENDING:
		return false
	if not _api.poll():
		return false
	_settled_request = _pending_request.duplicate(true)
	_pending_request = {}
	if not _api.last_error().is_empty():
		_last_error = _api.last_error()
		_preview_state = PREVIEW_IDLE
		return true
	_preview_state = PREVIEW_READY
	_last_error = ""
	return true


## The identity of the last SETTLED preview, or {}. Compared by the caller against the
## editor's current contents before arming anything.
func settled_request() -> Dictionary:
	return _settled_request.duplicate(true)


## The revision a commit should be validated against: the one the preview reported.
func preview_revision() -> String:
	if _api == null:
		return ""
	return str(_api.preview().get("revision", ""))


## The keys a settled preview reports it would change.
func preview_changes() -> Array:
	if _api == null:
		return []
	var listed: Variant = _api.preview().get("changes", [])
	return (listed as Array).duplicate(true) if listed is Array else []


## The document a settled preview says it would write, and its scope.
func preview_target() -> String:
	if _api == null:
		return ""
	var scope := str(_api.preview().get("scope", ""))
	var path := str(_api.preview().get("path", ""))
	if scope.is_empty():
		return ""
	return "%s (%s)" % [scope, path] if not path.is_empty() else scope


## Start a commit of the previewed text. Requires a settled preview for the same key, so
## a commit cannot be issued for text that was never validated.
##
## The scope and guard are the ones the PREVIEW was validated against, so the two calls
## cannot disagree about which document the write lands in.
func begin_commit(key: String, text: String, expected_revision: String) -> bool:
	if _api == null:
		_last_error = "No configuration reader is configured."
		return false
	if expected_revision.is_empty():
		_last_error = "Nothing has been previewed for this value, so it has not been validated."
		return false
	if _api.is_pending():
		_last_error = "A configuration call is still in flight. Wait for it to answer."
		return false
	# The preview's own scope is authoritative for the commit: a scope change invalidates
	# the preview, so falling back to the current choice would commit a revision that
	# belongs to another document.
	var validated_scope := str(_settled_request.get("scope", ""))
	var validated_key := str(_settled_request.get("key", ""))
	var validated_text := str(_settled_request.get("text", ""))
	if validated_key != key or validated_text != text or _preview_state != PREVIEW_READY:
		_last_error = (
			"The text to write is not the text the preview validated. Preview it again."
		)
		return false
	var scope := validated_scope if SettingsScope.is_writable(validated_scope) else write_scope_for(key)
	if scope.is_empty():
		_last_error = write_refusal_for(key)
		return false
	var refusal := withheld_reason(key, text)
	if not refusal.is_empty():
		_last_error = refusal
		return false
	var invalid := text_refusal(text)
	if not invalid.is_empty():
		_last_error = invalid
		return false
	_commit_pending = true
	_last_error = ""
	if not _api.start_commit(
		ConfigApi.key_patch(key, parse_text(text)), scope, expected_revision
	):
		_last_error = _api.last_error()
		_commit_pending = false
		return false
	return true


## Advance a pending commit. Returns whether it settled.
func poll_commit() -> bool:
	if _api == null or not _api.is_pending() or _commit_pending == false:
		return false
	if not _api.poll():
		return false
	_commit_pending = false
	_pending_request = {}
	if _api.last_error().is_empty():
		# The committed readback replaces the values, so the surface shows what the
		# service actually settled on rather than the patch it hoped it wrote.
		_state = READY
		_last_error = ""
		_preview_state = PREVIEW_IDLE
		return true
	_last_error = _api.last_error()
	_preview_state = PREVIEW_IDLE
	return true


## Whether a commit is in flight, so a caller can refuse to start a second one.
func commit_pending() -> bool:
	return _commit_pending


## The keys a committed write reports are still owned by another document.
##
## This is a SUCCESS with a caveat, not a failure: removing a project value that a global
## document also defines leaves the global value in force.
func unsettled_keys() -> Array:
	if _api == null:
		return []
	var listed: Variant = _api.commit().get("unsettled", [])
	return (listed as Array).duplicate(true) if listed is Array else []


## The text a committed write settled on for a key, from the service's own readback.
func settled_text_for(key: String) -> String:
	if not defines(key):
		return "(removed or still owned by another document)"
	return JSON.stringify(value_for(key), "\t")


## Whether editor text is a JSON document this client can send, and why not when it is
## not.
##
## Checked locally so an obvious mistake is reported against the field the user is
## typing in, rather than becoming an HTTP 400. The SERVICE remains the authority on
## whether a value is valid for its key: this only rejects text that is not JSON at all,
## which no configuration value can be.
static func text_refusal(text: String) -> String:
	var trimmed := text.strip_edges()
	if trimmed.is_empty():
		return "Enter a JSON value, or use Remove to unset the key."
	if trimmed == "null":
		return "`null` unsets a key; use Remove so the intent is explicit."
	var json := JSON.new()
	if json.parse(trimmed) != OK:
		return "That is not valid JSON, so it cannot be stored: %s" % json.get_error_message()
	return ""


## How the current state reads, in one line.
func summary_text() -> String:
	match _state:
		IDLE:
			return "Nothing has been read yet."
		LOADING:
			return "Reading the effective configuration…"
		READY:
			var count := _api.read_values().size() if _api != null else 0
			return "Effective configuration from %d document(s), %d top-level key(s)." % [
				_api.sources().size(), count,
			]
		_:
			return _last_error


## One line for a preview's state, so a reader can tell validated from unvalidated.
func preview_summary() -> String:
	match _preview_state:
		PREVIEW_PENDING:
			return "Validating the change…"
		PREVIEW_READY:
			var changes := preview_changes()
			return "Validated: %d key(s) would change in %s." % [changes.size(), preview_target()]
		_:
			return "Not validated yet."


## Parse editor text into the JSON value the document stores.
##
## The editor speaks JSON, so this is a plain parse whose failure is REPORTED by
## `text_refusal` before the call is issued. There is deliberately no string fallback: a
## bare `auto` is not JSON, and coercing it to the string "auto" would store something
## different from what the document format means.
static func parse_text(text: String) -> Variant:
	var json := JSON.new()
	if json.parse(text.strip_edges()) != OK:
		return null
	return json.get_data()