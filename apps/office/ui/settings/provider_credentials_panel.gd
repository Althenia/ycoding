## Provider credential management surface.
##
## Renders the provider integrations that support entering a key, and the stored profiles
## the runtime reports for each: a label and whether it is the active one. Every row comes
## from `IntegrationApi`, which owns the list, the allowlist, and the mutation lifecycle;
## this Control paints them and forwards user intent.
##
## Four properties are why this is a separate surface from the configuration review:
##
##   * ONLY A KEY METHOD IS OFFERED. OAuth and command sign-in are separate workflows with
##     their own attempt lifecycle, and neither is implemented here. An integration whose
##     only methods are those states its limitation instead of showing a control that
##     would claim a connection it cannot make.
##
##   * THE KEY IS TRANSIENT AND MASKED. The key field is a masked editor separate from the
##     profile-name field. On submit the field is cleared IMMEDIATELY, and on failure it is
##     cleared again; the panel keeps no copy and renders none. A failure message that
##     echoed credential-shaped text is redacted before it is shown.
##
##   * DELETION IS CONFIRMED. Removing a profile is irreversible, so the first press arms
##     it and a second press on the same profile confirms it. Pressing a different profile
##     re-arms instead, so a mis-click cannot delete the wrong one.
##
##   * RENAMING COLLECTS ITS OWN LABEL. The label lives on the row's editor, and submitting
##     it emits the rename intent for that exact profile.
##
## The panel holds no transport and no credential: it is handed an `IntegrationApi`, which
## owns the reader.
class_name ProviderCredentialsPanel
extends VBoxContainer

## The user asked to connect a new profile for an integration, carrying the key once.
signal connect_requested(integration_id: String, key: String, label: String)
## The user asked to rename a stored profile.
signal rename_requested(credential_id: String, label: String)
## The user asked to make a stored profile the active one.
signal activate_requested(credential_id: String)
## The user confirmed the removal of a stored profile.
signal delete_requested(credential_id: String)

## What a redacted secret renders as. Matches the configuration owner's own sentinel, so
## a withheld value reads the same on both surfaces.
const REDACTED := "[redacted]"

## A run of credential-shaped characters. Applied to a failure message before it is shown,
## because a service or proxy may quote the payload it rejected.
const SECRET_RUN := "[A-Za-z0-9_\\-]{20,}"

var _api: IntegrationApi = null
var _rows_box: VBoxContainer
var _state_label: Label
var _failure_label: Label
## The profile whose removal is armed, or "" when none is.
var _pending_delete: String = ""
## The integration currently being connected, or "" when no editor is open.
var _connecting: String = ""

## The masked key editor and the plain profile-name editor, distinct controls.
var _key_field: LineEdit
var _label_field: LineEdit
var _connect_box: VBoxContainer
## credential id -> the row's rename editor, so a rename reads the field it was typed in.
var _rename_fields: Dictionary = {}
var _built := false


func _ready() -> void:
	_ensure_built()


## Bind the reader this panel renders, and repaint. The panel holds no reader of its own.
func bind(api: IntegrationApi) -> void:
	_ensure_built()
	_api = api
	refresh()


## Repaint from the bound reader's current state, sanitized.
func refresh() -> void:
	_ensure_built()
	_render()


## The integrations offered for a key connect, in the order the runtime reported them.
func visible_integration_ids() -> Array[String]:
	_ensure_built()
	var out: Array[String] = []
	if _api == null:
		return out
	for value in _api.integrations():
		var entry: Dictionary = value
		if bool(entry.get("has_key_method", false)):
			out.append(str(entry.get("id", "")))
	return out


## Whether a key connect is possible for `integration_id`. False for an OAuth-only
## integration, which is stated rather than offered.
func connect_available(integration_id: String) -> bool:
	_ensure_built()
	if _api == null:
		return false
	for value in _api.integrations():
		var entry: Dictionary = value
		if str(entry.get("id", "")) == integration_id:
			return bool(entry.get("has_key_method", false))
	return false


## Why an integration cannot be connected here, or "" when it can. An OAuth-only
## integration names the separate workflow it would need.
func oauth_note(integration_id: String) -> String:
	_ensure_built()
	if _api == null:
		return ""
	for value in _api.integrations():
		var entry: Dictionary = value
		if str(entry.get("id", "")) != integration_id:
			continue
		if bool(entry.get("has_key_method", false)):
			return ""
		if bool(entry.get("has_other_method", false)):
			return (
				"%s signs in with OAuth or a command, which this build does not support yet. "
				+ "Add a key profile here, or connect it from the terminal client."
			) % str(entry.get("name", integration_id))
		return "%s offers no sign-in method this build can use." % str(entry.get("name", integration_id))
	return ""


## Whether the key field masks its contents.
func key_field_secret() -> bool:
	_ensure_built()
	return _key_field != null and _key_field.secret


## Whether the profile-name field masks its contents. It does not: a profile name is not
## a secret, and hiding it would make a rename unreadable.
func label_field_secret() -> bool:
	_ensure_built()
	return _label_field != null and _label_field.secret


func key_field() -> LineEdit:
	_ensure_built()
	return _key_field


func label_field() -> LineEdit:
	_ensure_built()
	return _label_field


## Open the connect editor for an integration. An integration without a key method is
## refused rather than offered a key field that could never be used.
func begin_connect(integration_id: String) -> void:
	_ensure_built()
	if not connect_available(integration_id):
		_connecting = ""
		if _connect_box != null:
			_connect_box.visible = false
		return
	_connecting = integration_id
	_set_failure("")
	if _key_field != null:
		_key_field.text = ""
	if _label_field != null:
		_label_field.text = ""
	_connect_box.visible = true


func set_key_text(text: String) -> void:
	_ensure_built()
	_key_field.text = text


func set_label_text(text: String) -> void:
	_ensure_built()
	_label_field.text = text


## The key currently typed, for a caller that needs to assert the field was cleared. The
## panel never keeps a copy of it.
func key_field_text() -> String:
	_ensure_built()
	return _key_field.text if _key_field != null else ""


## Emit the connect intent for the open editor, then clear the key field IMMEDIATELY, so
## the key lives for exactly as long as it takes to hand it to the caller.
func submit_connect() -> void:
	_ensure_built()
	if _connecting.is_empty():
		return
	var key := _key_field.text if _key_field != null else ""
	var label := _label_field.text if _label_field != null else ""
	var integration_id := _connecting
	_key_field.text = ""
	connect_requested.emit(integration_id, key, label)


## The service applied the connect. The editor closes and nothing about the key remains.
func connect_settled() -> void:
	_ensure_built()
	if _key_field != null:
		_key_field.text = ""
	_connecting = ""
	if _connect_box != null:
		_connect_box.visible = false
	_set_failure("")


## The connect failed. The key field is cleared again, and the reason is redacted before
## it is shown so a service or proxy quoting the payload cannot put the key on screen.
func connect_failed(reason: String) -> void:
	_ensure_built()
	if _key_field != null:
		_key_field.text = ""
	_set_failure(sanitize(reason))


## The failure line currently shown, or "" when nothing failed.
func failure_text() -> String:
	_ensure_built()
	return _failure_label.text if _failure_label != null else ""


## Whether the removal of `credential_id` is armed and waiting for confirmation.
func pending_delete() -> String:
	return _pending_delete


## Press Remove on a profile. The first press arms it; a second press on the same profile
## confirms and emits; a press on a different profile re-arms instead.
func press_delete(credential_id: String) -> void:
	if _pending_delete == credential_id:
		_pending_delete = ""
		_render()
		delete_requested.emit(credential_id)
		return
	_pending_delete = credential_id
	_render()


func press_activate(credential_id: String) -> void:
	activate_requested.emit(credential_id)


## Rename a profile to the text in its own row editor. An empty name is not emitted: the
## route requires one, and sending nothing would make the rename a no-op that looked
## like it worked.
func press_rename(credential_id: String, label: String) -> void:
	var name := label.strip_edges()
	if name.is_empty():
		return
	rename_requested.emit(credential_id, name)


## Whether the removal of `credential_id` is awaiting confirmation.
func delete_armed(credential_id: String) -> bool:
	return _pending_delete == credential_id


## Every piece of text this surface is showing, including the editors.
func rendered_text() -> String:
	_ensure_built()
	return _collect_text(self)


## Redact credential-shaped runs from text before it is shown or kept.
##
## A service refusal names what failed, but a proxy or an upstream provider may echo the
## payload it rejected. Any long credential-shaped run is therefore replaced, so the key
## cannot reach a label, a log, or history through an error path.
static func sanitize(text: String) -> String:
	if text.strip_edges().is_empty():
		return text
	var regex := RegEx.new()
	if regex.compile(SECRET_RUN) != OK:
		return REDACTED
	return regex.sub(text, REDACTED, true)


## --- rendering ---------------------------------------------------------------

func _ensure_built() -> void:
	if _built:
		return
	_built = true
	add_theme_stylebox_override("panel", OfficeTheme.card_style())

	var title := Label.new()
	title.text = "Provider credentials"
	OfficeTheme.apply_font(title, 14)
	add_child(title)

	_state_label = Label.new()
	OfficeTheme.apply_font(_state_label, 11)
	_state_label.add_theme_color_override("font_color", OfficeTheme.text_dim())
	_state_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_state_label)

	_failure_label = Label.new()
	OfficeTheme.apply_font(_failure_label, 11)
	_failure_label.add_theme_color_override("font_color", OfficeTheme.accent_warm())
	_failure_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_failure_label)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)
	_rows_box = VBoxContainer.new()
	_rows_box.add_theme_constant_override("separation", 6)
	_rows_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_rows_box)

	# The connect editor: a masked key field, a plain profile-name field, and one action.
	_connect_box = VBoxContainer.new()
	_connect_box.add_theme_constant_override("separation", 4)
	_connect_box.visible = false
	add_child(_connect_box)
	_key_field = LineEdit.new()
	_key_field.secret = true
	_key_field.placeholder_text = "Key"
	OfficeTheme.apply_font(_key_field, 12)
	_connect_box.add_child(_key_field)
	_label_field = LineEdit.new()
	_label_field.placeholder_text = "Profile name (optional)"
	OfficeTheme.apply_font(_label_field, 12)
	_connect_box.add_child(_label_field)
	var connect := OfficeTheme.button("Connect", true)
	connect.pressed.connect(submit_connect)
	_connect_box.add_child(connect)


func _render() -> void:
	if _rows_box == null:
		return
	for child in _rows_box.get_children():
		_rows_box.remove_child(child)
		child.queue_free()
	_rename_fields.clear()

	if _api == null:
		_state_label.text = "No integration reader is bound."
		return
	var entries := _api.integrations()
	if entries.is_empty():
		_state_label.text = (
			_offered_text()
			if not _api.last_error().is_empty()
			else "Load the integrations to see configured providers."
		)
		return
	_state_label.text = "Configured providers, as the runtime reports them."
	for value in entries:
		var entry: Dictionary = value
		if not bool(entry.get("has_key_method", false)):
			var note := Label.new()
			note.text = oauth_note(str(entry.get("id", "")))
			OfficeTheme.apply_font(note, 11)
			note.add_theme_color_override("font_color", OfficeTheme.text_muted())
			note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			_rows_box.add_child(note)
			continue
		_rows_box.add_child(_integration_row(entry))


func _offered_text() -> String:
	return (
		"The integrations could not be read: %s" % _api.last_error()
		if _api != null and not _api.last_error().is_empty()
		else "No integrations were reported."
	)


func _integration_row(entry: Dictionary) -> Control:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 3)

	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	var name_label := Label.new()
	name_label.text = str(entry.get("name", entry.get("id", "")))
	OfficeTheme.apply_font(name_label, 13)
	name_label.add_theme_color_override("font_color", OfficeTheme.text())
	head.add_child(name_label)
	var add := OfficeTheme.pill_button("Connect")
	add.pressed.connect(func() -> void: begin_connect(str(entry.get("id", ""))))
	head.add_child(add)
	box.add_child(head)

	for value in entry.get("credentials", []):
		box.add_child(_profile_row(value))
	return box


func _profile_row(profile: Dictionary) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	var credential_id := str(profile.get("id", ""))
	var label := Label.new()
	label.text = "%s  ·  %s" % [
		str(profile.get("label", "")),
		"active" if bool(profile.get("active", false)) else "inactive",
	]
	OfficeTheme.apply_font(label, 12)
	label.add_theme_color_override("font_color", OfficeTheme.text())
	row.add_child(label)

	var rename_field := LineEdit.new()
	rename_field.text = str(profile.get("label", ""))
	rename_field.custom_minimum_size = Vector2(180, 0)
	OfficeTheme.apply_font(rename_field, 12)
	_rename_fields[credential_id] = rename_field
	row.add_child(rename_field)
	var rename := OfficeTheme.pill_button("Rename")
	rename.pressed.connect(func() -> void: press_rename(credential_id, rename_field.text))
	row.add_child(rename)

	if not bool(profile.get("active", false)):
		var activate := OfficeTheme.pill_button("Use")
		activate.pressed.connect(func() -> void: press_activate(credential_id))
		row.add_child(activate)

	var remove := OfficeTheme.pill_button("Remove")
	remove.pressed.connect(func() -> void: press_delete(credential_id))
	row.add_child(remove)
	if delete_armed(credential_id):
		var confirm := Label.new()
		confirm.text = "Press Remove again to confirm."
		OfficeTheme.apply_font(confirm, 10)
		confirm.add_theme_color_override("font_color", OfficeTheme.accent_warm())
		row.add_child(confirm)
	return row


func _set_failure(text: String) -> void:
	if _failure_label != null:
		_failure_label.text = text


func _collect_text(node) -> String:
	var out := ""
	for child in node.get_children():
		if child is Label:
			out += " " + child.text
		elif child is Button:
			out += " " + child.text
		elif child is LineEdit:
			out += " " + child.text
		out += _collect_text(child)
	return out.strip_edges()