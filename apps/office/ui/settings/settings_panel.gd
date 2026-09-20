## The Settings surface.
##
## A large page with its own grouped navigation, a search box over the registered pages,
## a scope selector, and - since the `server.config` owner exists - a real configuration
## review surface that reads effective values, previews an edit, commits it, and shows the
## settled readback.
##
## Every row this panel renders comes from `SettingsGroup`, which owns the grouping, the
## search index, and which top-level configuration key each page owns; every scope comes
## from `SettingsScope`, which encodes the live `Config.Scope`/`Config.WriteScope`
## contract; and every value comes from `ConfigReview`, which owns the read/preview/commit
## rules. So this Control decides nothing about what a setting IS.
##
## Two honesty rules it must not break:
##
##   * a page whose key list is empty says WHY it owns no runtime configuration value,
##     rather than rendering as an empty page;
##   * nothing is written before a preview has validated the exact text being committed,
##     which `ConfigReviewPanel` enforces on the control itself.
##
## It reads the STORE only to ask whether a project is open, which is what makes the
## Project scope valid. It never reads or writes a file.
class_name SettingsPanel
extends PanelContainer

## A settings row was activated. The panel cannot reach the owner, so it reports the
## request and the composition root decides what, if anything, happens.
signal page_requested(page: String)
signal scope_changed(scope: String)
signal close_requested()

## The narrowest the navigation column can render without clipping a label.
const NAV_MIN_W := 232.0

var _search: LineEdit
var _scope_button: Button
var _scope_menu: PopupMenu
var _nav_box: VBoxContainer
var _page_title: Label
var _page_detail: Label
var _coverage_box: VBoxContainer
var _empty_label: Label
## The configuration review surface, built lazily on the first page that owns a key.
var review_panel: ConfigReviewPanel

var _page: String = ""
var _scope: String = ""
var _query: String = ""
var _has_project := false
var _project_name := ""
## page id -> nav row, so the current one can be marked without relying on colour.
var _page_rows: Dictionary = {}
var _scope_menu_keys: Array[String] = []
var _built := false
var _review_bound := false
var _reviewed_page := ""


func _ready() -> void:
	_ensure_built()


## Build the page. Called from `_ready` and lazily from `show_page`, so a test can
## drive the panel without adding it to a scene tree.
func _ensure_built() -> void:
	if _built:
		return
	_built = true
	add_theme_stylebox_override("panel", OfficeTheme.card_style())

	var outer := HBoxContainer.new()
	outer.add_theme_constant_override("separation", 16)

	# --- navigation column ------------------------------------------------
	var nav := VBoxContainer.new()
	nav.custom_minimum_size = Vector2(NAV_MIN_W, 0)
	nav.add_theme_constant_override("separation", 8)
	outer.add_child(nav)

	_search = LineEdit.new()
	_search.placeholder_text = "Search settings"
	_search.clear_button_enabled = true
	OfficeTheme.apply_font(_search, 13)
	# Filtering happens on every keystroke, so a half-typed word narrows the list
	# instead of waiting for a submit the user may never make.
	_search.text_changed.connect(_on_search_changed)
	nav.add_child(_search)

	var back := OfficeTheme.pill_button("‹   Back to Office")
	back.alignment = HORIZONTAL_ALIGNMENT_LEFT
	back.custom_minimum_size = Vector2(0, 32)
	back.pressed.connect(func() -> void: close_requested.emit())
	nav.add_child(back)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	nav.add_child(scroll)
	_nav_box = VBoxContainer.new()
	_nav_box.add_theme_constant_override("separation", 2)
	_nav_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_nav_box)

	# --- the page itself --------------------------------------------------
	var body := VBoxContainer.new()
	body.add_theme_constant_override("separation", 8)
	body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	outer.add_child(body)

	_build_body(body)
	add_child(outer)
	_render()


## The body: the page title, the scope row, and the coverage list.
func _build_body(body: VBoxContainer) -> void:
	_page_title = Label.new()
	_page_title.text = "Settings"
	OfficeTheme.apply_font(_page_title, 20)
	body.add_child(_page_title)

	_page_detail = Label.new()
	OfficeTheme.apply_font(_page_detail, 12)
	_page_detail.add_theme_color_override("font_color", OfficeTheme.text_dim())
	_page_detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_child(_page_detail)

	# The scope row. The selector only ever offers scopes valid for this window, and
	# the badge beside it names the folder or session a narrow scope would apply to.
	var scope_row := HBoxContainer.new()
	scope_row.add_theme_constant_override("separation", 8)
	var scope_label := Label.new()
	scope_label.text = "Scope"
	OfficeTheme.apply_font(scope_label, 12)
	scope_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
	scope_row.add_child(scope_label)
	_scope_button = OfficeTheme.pill_button("Global  ⌄")
	_scope_button.custom_minimum_size = Vector2(180, 30)
	_scope_button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	_scope_button.pressed.connect(_on_scope_pressed)
	scope_row.add_child(_scope_button)
	_scope_menu = PopupMenu.new()
	_scope_menu.index_pressed.connect(_on_scope_index)
	add_child(_scope_menu)
	body.add_child(scope_row)

	_empty_label = Label.new()
	OfficeTheme.apply_font(_empty_label, 12)
	_empty_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
	_empty_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_child(_empty_label)

	var body_scroll := ScrollContainer.new()
	body_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	body.add_child(body_scroll)
	_coverage_box = VBoxContainer.new()
	_coverage_box.add_theme_constant_override("separation", 6)
	_coverage_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body_scroll.add_child(_coverage_box)


## Show the page for a store. The store is read only to learn whether a project is open,
## which is what makes the Project scope writable.
func show_page(store: OfficeStore) -> void:
	_ensure_built()
	_refresh_context(store)
	if _page.is_empty() or not SettingsGroup.is_page(_page):
		_page = SettingsGroup.default_page()
	_scope = SettingsScope.reconcile(_scope, _has_project)
	_render()


## Show one page directly. An unknown page is refused rather than adopted, so the
## surface can never be left on a page that does not exist.
##
## This is the PROGRAMMATIC entry point (a restored page, a route change) and it does
## not emit `page_requested`: that signal reports a USER's navigation, and emitting it
## from a restore would report a request nobody made.
func show_page_id(page: String) -> void:
	_ensure_built()
	if not SettingsGroup.is_page(page):
		return
	_page = page
	# A page chosen from a filtered list keeps the filter, so the list the user is
	# looking at does not rearrange under the selection they just made.
	_render()


func page() -> String:
	return _page


func scope() -> String:
	return _scope


func query() -> String:
	return _query


## Choose a scope by name. A scope that is not valid for this context is refused
## rather than adopted, so a control can never claim a scope the window cannot honour.
func select_scope(scope: String) -> bool:
	_ensure_built()
	if not SettingsScope.is_available(scope, _has_project):
		return false
	if scope == _scope:
		return false
	_scope = scope
	# A scope change invalidates any armed preview: the revision a preview was validated
	# against belongs to the document of the OLD scope, so committing it now would either
	# be refused as stale or, worse, be valid against a different document.
	if review_panel != null:
		review_panel.invalidate_preview()
	_render()
	scope_changed.emit(_scope)
	return true


## The scopes currently offered, in precedence order.
func available_scopes() -> Array[String]:
	_ensure_built()
	return SettingsScope.readable(_has_project)


## The nav rows currently rendered, keyed by page. Built by `_render`.
func page_rows() -> Dictionary:
	_ensure_built()
	return _page_rows


## Search for a query. Empty restores every page.
func search(value: String) -> void:
	_ensure_built()
	_query = value
	if _search != null and _search.text != value:
		_search.text = value
	_render()


## Re-apply what `_ready` baked into styleboxes and colours.
func restyle() -> void:
	add_theme_stylebox_override("panel", OfficeTheme.card_style())


## Move the selection one step through the list the user is looking at, wrapping.
func step(delta: int) -> void:
	_ensure_built()
	var next := SettingsGroup.stepped_page(_page, delta, _query)
	if next.is_empty() or next == _page:
		return
	_page = next
	_render()


func _refresh_context(store: OfficeStore) -> void:
	# A project is present when any adopted session reports a real directory. Reading it
	# from the projection rather than from a local field keeps the two from disagreeing
	# about which folder the window is actually in. A synthetic session's fixture folder
	# is not a real place, so it never makes a project document writable.
	_project_name = ""
	if store != null:
		for actor in store.actor_list():
			if actor.synthetic or actor.location_directory.is_empty():
				continue
			_project_name = actor.location_directory
			break
	_has_project = not _project_name.is_empty()


## --- rendering ---------------------------------------------------------------

func _render() -> void:
	if _coverage_box == null:
		return
	_render_nav()
	_render_page()
	_render_scope()
	_render_review()


## Bind the configuration review surface. The panel does not own a reader, so this is
## injected by the composition root; without it, the surface is simply absent.
func bind_review(review: ConfigReview) -> void:
	_ensure_built()
	if review_panel == null:
		review_panel = ConfigReviewPanel.new()
		add_child(review_panel)
	review_panel.bind(review)
	_review_bound = true
	_render_review()


## The review surface, or null before one is bound.
func review_surface() -> ConfigReviewPanel:
	return review_panel


## Show the configuration review for the current page, where the read has a value to
## show or a key to explain.
##
## Reserved for pages that OWN a top-level key: a page whose keys all live elsewhere says
## so in its own body rather than showing an empty review.
func _render_review() -> void:
	if review_panel == null or not _review_bound:
		return
	var owns_keys := not SettingsGroup.keys_for(_page).is_empty()
	review_panel.visible = owns_keys
	if not owns_keys:
		return
	# The page is handed over only when it changes, so a repaint does not reset the
	# editor a user is typing in.
	if review_panel.page_id() != _page:
		review_panel.show_page_for(_page)
	# The scope the user chose decides which document a write targets, so it is pushed
	# to the review that owns that decision. An empty or non-writable scope means no
	# choice has been made, which the review reads as "follow the value's own document".
	if review_panel._review != null and SettingsScope.is_writable(_scope):
		review_panel._review.set_chosen_scope(_scope)


## The navigation: one section per group that still has a matching page, each
## holding its own page rows. A filtered-out group is omitted, so a search never
## leaves a heading opening onto nothing.
func _render_nav() -> void:
	for child in _nav_box.get_children():
		_nav_box.remove_child(child)
		child.queue_free()
	_page_rows.clear()

	var matched := SettingsGroup.matching_pages(_query)
	if matched.is_empty():
		var none := OfficeTheme.body("No setting matches “%s”." % _query.strip_edges(), true)
		none.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_nav_box.add_child(none)
		return

	for group in SettingsGroup.ORDER:
		var pages: Array[String] = []
		for page_id in matched:
			if SettingsGroup.group_of(page_id) == group:
				pages.append(page_id)
		if pages.is_empty():
			continue
		_nav_box.add_child(OfficeTheme.section_label(SettingsGroup.label(group).to_upper()))
		for page_id in pages:
			var row := OfficeTheme.pill_button(_row_text(page_id))
			row.custom_minimum_size = Vector2(0, 30)
			row.alignment = HORIZONTAL_ALIGNMENT_LEFT
			OfficeTheme.apply_font(row, 12)
			row.pressed.connect(func() -> void: _on_page_pressed(page_id))
			_nav_box.add_child(row)
			_page_rows[page_id] = row


## A nav row was pressed. The page moves and the request is reported; the panel does
## not act on it beyond showing the page, because what a page DOES belongs to whoever
## owns the configuration.
func _on_page_pressed(page_id: String) -> void:
	if not SettingsGroup.is_page(page_id):
		return
	_page = page_id
	_render()
	page_requested.emit(_page)


## A nav row: the page, marked when current. The marker is TEXT, so the current page
## is legible without relying on colour.
func _row_text(page_id: String) -> String:
	var mark := "   " + SidebarPanel.MARK_SELECTED if page_id == _page else ""
	return "%s%s" % [SettingsGroup.page_label(page_id), mark]


func _render_page() -> void:
	_page_title.text = SettingsGroup.page_label(_page) if SettingsGroup.is_page(_page) else "Settings"
	_page_detail.text = SettingsGroup.page_detail(_page)
	_empty_label.text = ""
	for child in _coverage_box.get_children():
		_coverage_box.remove_child(child)
		child.queue_free()
	if _query.strip_edges() != "":
		_empty_label.text = "Filtered by “%s”." % _query.strip_edges()

	for area in SettingsGroup.coverage(_page):
		var row := Label.new()
		row.text = area
		OfficeTheme.apply_font(row, 13)
		row.add_theme_color_override("font_color", OfficeTheme.text())
		row.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_coverage_box.add_child(row)

	# A page that owns no runtime configuration key says WHY, rather than rendering as an
	# empty page that reads as broken.
	var reason := SettingsGroup.no_key_reason(_page)
	if not reason.is_empty():
		var why := Label.new()
		why.text = reason
		OfficeTheme.apply_font(why, 11)
		why.add_theme_color_override("font_color", OfficeTheme.text_muted())
		why.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_coverage_box.add_child(why)


## The scope selector: only scopes this location supports are offered, and the badge names
## the project document a narrow scope would apply to.
func _render_scope() -> void:
	_scope_button.text = "%s  ⌄" % SettingsScope.badge(_scope, _project_name)
	_scope_menu.clear()
	_scope_menu_keys.clear()
	var scopes := SettingsScope.readable(_has_project)
	for scope in scopes:
		_scope_menu_keys.append(scope)
		_scope_menu.add_item(SettingsScope.badge(scope, _project_name))
	# A control that cannot act is disabled and states why. With only one scope valid there
	# is nothing to choose, so the selector says so rather than opening a menu of one.
	var only_global := scopes.size() <= 1
	_scope_button.disabled = only_global
	_scope_button.tooltip_text = (
		SettingsScope.reason_unavailable(SettingsScope.PROJECT, _has_project) if only_global
		else "Which configuration document a change to this page would be written to"
	)


func _on_search_changed(value: String) -> void:
	_query = value
	_render()


func _on_scope_pressed() -> void:
	if _scope_button.disabled:
		return
	_scope_menu.position = Vector2i(
		Vector2(_scope_button.global_position.x, _scope_button.global_position.y - 8.0)
	)
	_scope_menu.popup()


func _on_scope_index(index: int) -> void:
	if index < 0 or index >= _scope_menu_keys.size():
		return
	select_scope(_scope_menu_keys[index])