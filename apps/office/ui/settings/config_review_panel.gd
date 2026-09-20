## The configuration review surface.
##
## Renders one effective configuration value with its provenance, and drives the real
## `server.config` lifecycle for it: read -> edit -> preview -> commit -> settled
## readback. Every state it can be in comes from `ConfigReview`, which owns the rules;
## this Control only paints them and forwards user intent.
##
## Two properties are why this exists as a separate surface from the navigation:
##
##   * NOTHING IS WRITTEN WITHOUT A PREVIEW. The apply control is disabled until a
##     preview has settled for the EXACT text currently in the editor, so an edit that
##     has not been validated cannot be committed by a second click.
##   * A STALE REVISION IS ACTIONABLE. The service refuses a commit whose
##     `expectedRevision` no longer matches, and that refusal is shown as "re-read and
##     try again" rather than retried blindly or swallowed.
##
## It holds no transport and no credential: it is handed a `ConfigReview`, which owns
## the reader. The panel cannot reach the service on its own.
class_name ConfigReviewPanel
extends VBoxContainer

## The user asked to read (or re-read) the effective configuration.
signal read_requested()
## The user asked to preview the editor's current text for the chosen key.
signal preview_requested(key: String, text: String)
## The user asked to commit, carrying the revision the preview was validated against.
signal commit_requested(key: String, text: String, expected_revision: String)
## The user asked to remove one top-level key. The panel reports the request; the root
## drives the preview, exactly as it does for an edit.
signal remove_requested(key: String)
## The user asked to commit a validated removal.
signal remove_commit_requested(key: String, expected_revision: String)
## The user asked to stop showing a value's editor.
signal dismissed()

## How much of a value to render before cutting it, so one enormous document cannot
## push every control off the page. A cut value says so, and the editor always holds the
## whole text.
const PREVIEW_BOUND := 4000

var _title: Label
var _source_label: Label
var _state_label: Label
var _rows_box: VBoxContainer
var _editor: TextEdit
var _editor_box: VBoxContainer
var _preview: Button
var _apply: Button
var _hint: Label
var _key: String = ""
## The text the settled preview validated. The apply control is enabled only while the
## editor still holds exactly this, so a further edit re-requires a preview.
var _previewed_text := ""
var _preview_revision := ""
## Whether a configuration call of ours is in flight. While one is, neither control may
## issue another: a duplicate Apply would write twice, and a second preview would race the
## first answer.
var _in_flight := false
## Whether the armed preview validated a REMOVAL. Apply then commits a `null` rather than
## the editor's text, and Apply is armed by `removal_settled` rather than `preview_settled`.
var _removing := false

var _review: ConfigReview = null
var _built := false


func _ready() -> void:
	_ensure_built()


func _ensure_built() -> void:
	if _built:
		return
	_built = true

	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	_title = Label.new()
	_title.text = "Configuration"
	OfficeTheme.apply_font(_title, 14)
	head.add_child(_title)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(spacer)
	var read := OfficeTheme.pill_button("Read effective values")
	read.pressed.connect(func() -> void: read_requested.emit())
	head.add_child(read)
	var close := OfficeTheme.pill_button("Close")
	close.pressed.connect(func() -> void: dismissed.emit())
	head.add_child(close)
	add_child(head)

	_source_label = Label.new()
	OfficeTheme.apply_font(_source_label, 10)
	_source_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
	_source_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_source_label)

	_state_label = Label.new()
	OfficeTheme.apply_font(_state_label, 12)
	_state_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_state_label)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)
	_rows_box = VBoxContainer.new()
	_rows_box.add_theme_constant_override("separation", 4)
	_rows_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_rows_box)

	# The editor is built once and shown only while a value is being edited, so the
	# panel does not grow a second control per read.
	_editor_box = VBoxContainer.new()
	_editor_box.add_theme_constant_override("separation", 6)
	_editor_box.visible = false
	add_child(_editor_box)
	_editor = TextEdit.new()
	_editor.custom_minimum_size = Vector2(0, 120)
	_editor.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	# An edit invalidates the preview, because the apply control's whole guarantee is
	# that it commits text which was validated exactly as it stands.
	_editor.text_changed.connect(_on_edit_changed)
	_editor_box.add_child(_editor)
	var actions := HBoxContainer.new()
	actions.add_theme_constant_override("separation", 8)
	# The Preview control is what ARM Apply. Without it the whole preview-before-commit
	# guarantee would be unreachable from the interface, because no user action could ever
	# produce a validated revision.
	_preview = OfficeTheme.button("Preview")
	_preview.pressed.connect(_on_preview)
	actions.add_child(_preview)
	_apply = OfficeTheme.button("Apply to configuration", true)
	_apply.pressed.connect(_on_apply)
	actions.add_child(_apply)
	_editor_box.add_child(actions)
	_hint = Label.new()
	OfficeTheme.apply_font(_hint, 11)
	_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_editor_box.add_child(_hint)

	# `read_requested` is not emitted here: building the panel must not perform I/O. The
	# composition root asks for the first read when the surface is shown.


## Bind the review the panel renders, and repaint. The panel holds no reader of its own.
func bind(review: ConfigReview) -> void:
	_ensure_built()
	_review = review
	_previewed_text = ""
	_preview_revision = ""
	_render()


## Render the page for `page_id`, which decides which top-level keys are offered.
func show_page_for(page_id: String) -> void:
	_ensure_built()
	_page_id = page_id
	# Leaving a page abandons whatever was pending on it: a late answer for a key the new
	# page does not show must not arm anything here.
	_key = ""
	_removing = false
	_previewed_text = ""
	_preview_revision = ""
	_in_flight = false
	_editor_box.visible = false
	_render()


var _page_id: String = ""


func page_id() -> String:
	return _page_id


func is_editing() -> bool:
	return _editor_box != null and _editor_box.visible


func edited_key() -> String:
	return _key


## Whether the value being edited is a pending REMOVAL rather than an edit.
##
## The two produce different payloads for the same key - a `null` versus a value - so the
## panel records which one Apply would commit and cannot confuse them.
func is_removing() -> bool:
	return _removing


func editor_text() -> String:
	return _editor.text if _editor != null else ""


## Begin editing one top-level key. The editor starts on the value the service
## reported, so an edit is a change to a real value rather than a blank box.
func edit_key(key: String, initial_text: String) -> void:
	_ensure_built()
	# An edit supersedes any pending removal: they are different payloads for one key, and
	# a late answer for the removal must not arm the edit.
	_removing = false
	_key = key
	_previewed_text = ""
	_preview_revision = ""
	_editor.text = initial_text
	_editor_box.visible = true
	_render()


## Stop editing. Nothing is written, so cancelling can never leave a partial change.
func cancel_edit() -> void:
	_key = ""
	_removing = false
	_previewed_text = ""
	_preview_revision = ""
	if _editor != null:
		_editor.text = ""
	if _editor_box != null:
		_editor_box.visible = false
	_render()


## Whether a Remove control can act for `key`, i.e. whether the action would change the
## document the write targets.
func remove_offered(key: String) -> bool:
	return remove_available(key)


## Whether a Remove control can act for `key`.
##
## False while the review has not settled a read or a call is in flight, for the same
## reason Apply is: a removal is guarded by a revision the client must have seen.
func remove_available(key: String) -> bool:
	if _review == null or _review.state() != ConfigReview.READY or _in_flight:
		return false
	return _review.can_remove(key)


## Why `key` cannot be removed, or "" when it can. The review owns the rule.
func remove_refusal(key: String) -> String:
	if _review == null:
		return "No configuration reader is bound."
	return _review.remove_refusal(key)


## Ask for a removal preview for `key`. Refused where the action could not change the
## document, so a dead request is never issued.
func press_remove(key: String) -> void:
	_ensure_built()
	if not remove_available(key):
		return
	# A removal is a pending change like an edit: it owns the editor slot so Apply applies
	# to it, and any earlier armed preview is dropped because it validated other text.
	_key = key
	_removing = true
	_previewed_text = ""
	_preview_revision = ""
	_in_flight = true
	# Apply lives INSIDE the editor box, so the box must be shown or the user is told a
	# control is available that they cannot see or click. The editor holds no text for a
	# removal: the value is not being edited, and showing its contents would present a
	# deletion as if it were an edit.
	_editor.text = ""
	_editor_box.visible = true
	_render()
	remove_requested.emit(key)


## Record a settled REMOVAL preview, arming Apply for the removal.
##
## The answer is honoured only when it belongs to the removal STILL pending: a late answer
## for a key the user has moved on from must not arm the current intent. `_key` is cleared
## by an edit or a page change, so a mismatched answer is dropped here.
func removal_settled(key: String, revision: String) -> void:
	_ensure_built()
	_in_flight = false
	if key != _key or not _removing:
		_sync_apply()
		return
	_previewed_text = ""
	_preview_revision = revision
	_render()


## Whether the apply control can act, and why not when it cannot.
##
## Exposed so a test asserts the CONTROL's state rather than only the review's, which is
## what makes "an enabled control that does nothing" detectable.
func apply_available() -> bool:
	return _apply != null and not _apply.disabled


func apply_reason() -> String:
	return _hint.text if _hint != null else ""


## --- rendering ---------------------------------------------------------------

## Repaint from the bound review's current state.
##
## Public because the composition root drives the read/preview/commit lifecycle and the
## surface must repaint when an answer settles; the panel does not poll by itself.
func refresh() -> void:
	_render()


func _render() -> void:
	if _rows_box == null:
		return
	for child in _rows_box.get_children():
		_rows_box.remove_child(child)
		child.queue_free()

	if _review == null:
		_state_label.text = "No configuration reader is bound."
		_source_label.text = ""
		_sync_apply()
		return

	_render_provenance()
	_render_values()
	_sync_apply()


## Where the values came from, including which document owns the key being edited.
func _render_provenance() -> void:
	if not _review.last_error().is_empty():
		_state_label.text = _review.last_error()
		_state_label.add_theme_color_override("font_color", OfficeTheme.accent_warm())
		_source_label.text = ""
		return
	match _review.state():
		ConfigReview.IDLE:
			_state_label.text = "Nothing has been read yet."
		ConfigReview.LOADING:
			_state_label.text = "Reading the effective configuration…"
		ConfigReview.ERROR:
			_state_label.text = _review.last_error()
			_state_label.add_theme_color_override("font_color", OfficeTheme.accent_warm())
			_source_label.text = ""
			return
		_:
			_state_label.text = _review.summary_text()
	_state_label.add_theme_color_override("font_color", OfficeTheme.text())
	var location := str(_review.resolved_directory())
	_source_label.text = (
		"Location: %s" % location if not location.is_empty()
		else "The service did not report a resolved location."
	)


## One row per top-level key the read returned, with its provenance.
func _render_values() -> void:
	if _review.state() != ConfigReview.READY:
		return
	var keys := _review.keys_for_page(_page_id)
	if keys.is_empty():
		var none := OfficeTheme.body(
			"No effective configuration value is reported for this page. A key no document "
			+ "defines is absent rather than empty.",
			true,
		)
		none.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_rows_box.add_child(none)
		return
	for key in keys:
		_rows_box.add_child(_value_row(key))


func _value_row(key: String) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var name_label := Label.new()
	name_label.text = key
	name_label.custom_minimum_size = Vector2(220, 0)
	OfficeTheme.apply_font(name_label, 12)
	name_label.add_theme_color_override("font_color", OfficeTheme.text())
	row.add_child(name_label)

	var value_label := Label.new()
	var rendered := _review.render_value(key)
	# A cut value says so rather than looking like the whole of it.
	value_label.text = (
		rendered.substr(0, PREVIEW_BOUND) + "  … (cut; open the editor for the whole value)"
		if rendered.length() > PREVIEW_BOUND else rendered
	)
	value_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	value_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	OfficeTheme.apply_font(value_label, 11)
	value_label.add_theme_color_override("font_color", OfficeTheme.text_dim())
	row.add_child(value_label)

	# A withheld value is labelled, so a reader is never told it is the literal text.
	var provenance := _review.provenance_for(key)
	var note := Label.new()
	OfficeTheme.apply_font(note, 10)
	note.add_theme_color_override("font_color", OfficeTheme.text_muted())
	note.text = _provenance_text(key, provenance)
	note.custom_minimum_size = Vector2(150, 0)
	row.add_child(note)

	# Edit is offered only where a write is actually possible. A value owned by a
	# document with no file path cannot be written, so the control states that instead
	# of opening an editor that would fail on apply.
	var scope := _review.write_scope_for(key)
	if scope.is_empty():
		var why := Label.new()
		OfficeTheme.apply_font(why, 10)
		why.add_theme_color_override("font_color", OfficeTheme.text_muted())
		why.text = _review.write_refusal_for(key)
		why.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		why.custom_minimum_size = Vector2(200, 0)
		row.add_child(why)
		return row
	var edit := OfficeTheme.pill_button("Edit")
	edit.pressed.connect(func() -> void: edit_key(key, _review.raw_text_for(key)))
	row.add_child(edit)
	# Remove is offered only where the action would actually change the document the write
	# targets, and only for a value that is not withheld. Where it cannot act, the reason is
	# stated on the row rather than a dead button being shown.
	if _review.can_remove(key):
		var remove := OfficeTheme.pill_button("Remove")
		remove.pressed.connect(func() -> void: press_remove(key))
		row.add_child(remove)
	else:
		var why := Label.new()
		OfficeTheme.apply_font(why, 10)
		why.add_theme_color_override("font_color", OfficeTheme.text_muted())
		why.text = _review.remove_refusal(key)
		why.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		why.custom_minimum_size = Vector2(180, 0)
		row.add_child(why)
	return row


func _provenance_text(key: String, provenance: String) -> String:
	if provenance.is_empty():
		return ""
	return "from: %s" % provenance


## The apply control's state is derived, never remembered: it can act only while the
## review has settled a read, no call is in flight, and the editor holds exactly the text
## a preview validated.
func _sync_apply() -> void:
	if _apply == null:
		return
	var editing := is_editing() or _removing
	var ready := _review != null and _review.state() == ConfigReview.READY
	# A call of ours in flight disables BOTH controls: a second Apply would write twice,
	# and a second Preview would race the first answer. Preview also stays inert during a
	# REMOVAL: it validates the editor's text, and a removal has none, so an enabled
	# Preview there would be an affordance that does nothing.
	if _preview != null:
		_preview.disabled = not editing or _in_flight or not ready or _removing
	if not editing:
		_apply.disabled = true
		_hint.text = ""
		return
	_apply.disabled = true
	if not ready:
		# The read that supplies the guard has not settled, or failed. Arming Apply here
		# would commit against a revision the client has not seen.
		_hint.text = (
			"The effective configuration has not been read, so nothing can be validated "
			+ "or written yet."
		)
		return
	if _in_flight:
		_apply.disabled = true
		_preview.disabled = true
		_hint.text = "Waiting for the configuration service to answer…"
		return
	# A REMOVAL: the editor is not involved, so the only condition is a validated removal.
	# The rest of this function speaks about editor text and would otherwise compare the
	# empty editor against the empty previewed text and mis-report the state.
	if _removing:
		_apply.disabled = _preview_revision.is_empty()
		_apply.tooltip_text = ""
		_hint.text = (
			"Removing '%s' from the %s document." % [_key, _review.write_scope_for(_key)]
			if not _preview_revision.is_empty()
			else "Validate the removal before applying it."
		)
		return
	var change := _editor.text != _previewed_text
	_apply.disabled = change or _preview_revision.is_empty()
	_apply.tooltip_text = ""
	if change:
		_hint.text = "Preview this text before applying: an edit is not written until it has been validated."
		return
	if _preview_revision.is_empty():
		_hint.text = "Preview this text before applying."
		return
	var withheld := _review.withheld_reason(_key, _editor.text)
	if not withheld.is_empty():
		_apply.disabled = true
		_hint.text = withheld
		return
	_hint.text = "Previewed against revision %s. Apply writes it and reads back the settled value." % _preview_revision.substr(0, 12)


## Whether the Preview control can act.
func preview_available() -> bool:
	return _preview != null and not _preview.disabled


## Record that a configuration call of ours is now in flight, so neither control issues
## another until it answers.
func preview_pending() -> void:
	_ensure_built()
	_in_flight = true
	_sync_apply()


func commit_pending() -> void:
	_ensure_built()
	_in_flight = true
	_sync_apply()


## Record a settled preview. Only a preview for the key, text, scope and location
## CURRENTLY in play arms the apply control, so an answer for superseded text never
## blesses the edit that replaced it.
func preview_settled(key: String, text: String, revision: String, scope: String = "", location: String = "") -> void:
	_ensure_built()
	_in_flight = false
	# A settled EDIT drops any pending removal for the same slot: the two are different
	# payloads for one key, and arming the wrong one would write a value where a removal
	# was asked for.
	_removing = false
	if key != _key:
		_sync_apply()
		return
	if _review != null:
		# The SCOPE and LOCATION are compared too: the same key and text against another
		# document is a different write, and the revision would not belong to it.
		if not scope.is_empty() and scope != _review.write_scope_for(_key):
			_sync_apply()
			return
		if not location.is_empty() and location != _review.resolved_directory():
			_sync_apply()
			return
	_previewed_text = text
	_preview_revision = revision
	_render()


## Record a settled commit and stop editing, because the readback is now the effective
## value and the editor would otherwise hold a stale copy of it.
func commit_settled() -> void:
	_ensure_built()
	_in_flight = false
	_previewed_text = ""
	_preview_revision = ""
	_removing = false
	if _editor != null:
		_editor.text = ""
	if _editor_box != null:
		_editor_box.visible = false
	_key = ""
	_render()


## A refusal arrived for the update in flight. The editor keeps its text, because the
## user's edit is the thing that was refused and discarding it would lose their work. A
## refused REMOVAL keeps its armed state cleared, so nothing is applied by accident.
func refusal_settled() -> void:
	_ensure_built()
	_in_flight = false
	_previewed_text = ""
	_preview_revision = ""
	_removing = false
	_render()


## Clear the armed preview, so a stale revision cannot arm an apply after a scope or
## location change.
func invalidate_preview() -> void:
	_in_flight = false
	_previewed_text = ""
	_preview_revision = ""
	_removing = false
	_sync_apply()


func _on_edit_changed() -> void:
	_sync_apply()


func _on_preview() -> void:
	# Preview validates the EDITOR's text, so it is inert during a removal: pressing it
	# would issue a preview for empty text, which is a dead action.
	if _review == null or _removing or not is_editing() or _preview.disabled:
		return
	_in_flight = true
	_sync_apply()
	preview_requested.emit(_key, _editor.text)


func _on_apply() -> void:
	if _review == null or not (is_editing() or _removing) or _apply.disabled:
		return
	_in_flight = true
	_sync_apply()
	if _removing:
		remove_commit_requested.emit(_key, _preview_revision)
		return
	commit_requested.emit(_key, _editor.text, _preview_revision)