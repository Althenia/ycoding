## The Statistics surface.
##
## Renders whatever `StatisticsPage` says its state is, and adds nothing of its own. The
## page is the data binding - it decides which state is true and which figures may be shown
## - and this Control's only job is to put those on screen. Keeping the honesty rules out of
## the widget is what makes them reachable by a test.
##
## It reads a real aggregate and never fabricates one. A read that has not settled shows the
## loading state; a failed read shows its reason; a report of no work says so; and the daily
## chart and activity calendar state why they cannot be drawn rather than drawing an empty
## axis, which would claim there was no work.
class_name StatisticsPanel
extends PanelContainer

## The page's own state constants, so a caller compares against one definition.
const LOADING := StatisticsPage.LOADING
const EMPTY := StatisticsPage.EMPTY
const READY := StatisticsPage.READY
const ERROR := StatisticsPage.ERROR

## The two tabs the kit describes: the statistics accounting, and provider quota. They are
## different sources (session provider-request accounting vs the provider's account limits)
## and are never merged, so they are separate views of one route.
const TAB_STATS := "statistics"
const TAB_QUOTA := "quota"

var _tab: String = TAB_STATS
## The user asked to export the figures they are looking at. The panel reports the request and
## the composition root performs it, because writing a file is a real side effect the panel
## does not own.
signal export_requested()

var _export_box: HBoxContainer
var _tab_box: HBoxContainer
var _quota_box: VBoxContainer
var quota_page: QuotaPage = QuotaPage.new()
## The user's own advisory budgets. A DIFFERENT thing from a provider quota: these are the
## user's warning thresholds, they are labelled as such, and nothing here stops work.
var budget_store: QuotaBudgetStore = QuotaBudgetStore.new()
## Observed spend per budget key, as the caller read it. Empty means nothing was read, which
## makes an evaluation partial rather than passing.
var observed_spend: Dictionary = {}
var observed_known: Dictionary = {}

var _title: Label
var _subtitle: Label
var _state_label: Label
var _source_label: Label
var _cards_box: VBoxContainer
var _models_box: VBoxContainer
var _chart_box: VBoxContainer

var page: StatisticsPage = StatisticsPage.new()
var _store: OfficeStore = null


func _ready() -> void:
	if _title != null:
		return
	var outer := VBoxContainer.new()
	outer.add_theme_constant_override("separation", 8)

	_title = Label.new()
	_title.text = "Statistics"
	OfficeTheme.apply_font(_title, 18)
	outer.add_child(_title)

	_tab_box = HBoxContainer.new()
	_tab_box.add_theme_constant_override("separation", 6)
	for tab in [TAB_STATS, TAB_QUOTA]:
		var button := OfficeTheme.pill_button("Statistics" if tab == TAB_STATS else "Provider quota")
		button.pressed.connect(func() -> void: show_tab(tab))
		button.set_meta("tab", tab)
		_tab_box.add_child(button)
	outer.add_child(_tab_box)

	# The EXPORT is a USER ACTION and nothing else: the control only reports the request, and
	# no file is written until the user presses it.
	_export_box = HBoxContainer.new()
	_export_box.add_theme_constant_override("separation", 6)
	var export_csv := OfficeTheme.pill_button("Export CSV")
	export_csv.pressed.connect(func() -> void: export_requested.emit())
	_export_box.add_child(export_csv)
	outer.add_child(_export_box)

	_subtitle = Label.new()
	OfficeTheme.apply_font(_subtitle, 11)
	_subtitle.add_theme_color_override("font_color", OfficeTheme.text_dim())
	outer.add_child(_subtitle)

	_state_label = Label.new()
	OfficeTheme.apply_font(_state_label, 12)
	_state_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	outer.add_child(_state_label)

	_source_label = Label.new()
	OfficeTheme.apply_font(_source_label, 10)
	_source_label.add_theme_color_override("font_color", OfficeTheme.text_muted())
	outer.add_child(_source_label)

	_cards_box = VBoxContainer.new()
	_cards_box.add_theme_constant_override("separation", 3)
	outer.add_child(_cards_box)

	_models_box = VBoxContainer.new()
	_models_box.add_theme_constant_override("separation", 3)
	outer.add_child(_models_box)

	_chart_box = VBoxContainer.new()
	_chart_box.add_theme_constant_override("separation", 3)
	outer.add_child(_chart_box)

	_quota_box = VBoxContainer.new()
	_quota_box.add_theme_constant_override("separation", 3)
	outer.add_child(_quota_box)

	add_child(outer)
	_render()


## Show the page for a store. The store is only used to name what the figures cover; the
## page owns the numbers.
func show_page(store: OfficeStore) -> void:
	_store = store
	if _title == null:
		_ready()
	_render()


## Show one tab. The tab is presentation only: both views read their own source and neither
## changes what the other describes.
func show_tab(tab: String) -> void:
	_tab = tab if tab in [TAB_STATS, TAB_QUOTA] else TAB_STATS
	if _title == null:
		_ready()
	_render()


func tab() -> String:
	return _tab


## The rows this surface would export, in the shape the export writes.
##
## Takes them from the SAME page the surface is rendering, so the export cannot describe
## figures the user is not looking at.
func export_rows() -> Array:
	var rows: Array = []
	if _tab == TAB_QUOTA:
		for provider_row in quota_page.provider_rows():
			rows.append({
				"label": str(provider_row.get("label", "")),
				"value": str(provider_row.get("status", "")),
				"count": int(provider_row.get("windows", 0)),
				"spend": 0,
			})
		return rows
	for model_row in page.model_rows():
		rows.append({
			"label": str(model_row.get("label", "")),
			"value": str(model_row.get("provider", "")),
			"count": int(model_row.get("requests", 0)),
			"spend": float(model_row.get("cost", 0.0)) if model_row.get("cost", null) != null else 0.0,
		})
	return rows


## Record the spend a budget should be compared against, and whether it is actually known.
##
## Both are passed together because an unknown figure must make the comparison PARTIAL rather
## than passing: "under budget" over an unread number is a claim this client cannot make.
func observe_spend(scope: String, scope_id: String, spend: float, known: bool) -> void:
	var key := "%s:%s" % [scope, scope_id]
	observed_spend[key] = spend
	observed_known[key] = known


## Set an advisory budget and persist it.
func set_budget(budget: QuotaBudget) -> void:
	budget_store.put(budget)
	budget_store.save()
	if _title == null:
		_ready()
	_render()


## Replace the quota snapshots and repaint.
func adopt_quota(page_state: QuotaPage) -> void:
	quota_page = page_state
	if _title == null:
		_ready()
	_render()


## Replace the page's data and repaint. The caller owns reading; this only shows.
func adopt(page_state: StatisticsPage) -> void:
	page = page_state
	if _title == null:
		_ready()
	_render()


func _render() -> void:
	_clear(_cards_box)
	_clear(_models_box)
	_clear(_chart_box)
	_clear(_quota_box)
	if _tab_box != null:
		for child in _tab_box.get_children():
			if child is Button:
				child.modulate = Color.WHITE if str(child.get_meta("tab", "")) == _tab else Color(1, 1, 1, 0.6)
	if _tab == TAB_QUOTA:
		_render_quota()
		return
	_subtitle.text = "Provider request accounting, as the service reports it."

	match page.state():
		LOADING:
			_state_label.text = page.state_text()
			_state_label.add_theme_color_override("font_color", OfficeTheme.text_dim())
		EMPTY:
			_state_label.text = page.empty_text()
			_state_label.add_theme_color_override("font_color", OfficeTheme.text_dim())
		ERROR:
			_state_label.text = "Could not read usage: %s" % page.error_text()
			_state_label.add_theme_color_override("font_color", OfficeTheme.accent_warm())
		_:
			_state_label.text = "Reported by the runtime."
			_state_label.add_theme_color_override("font_color", OfficeTheme.text())

	if page.is_stale():
		_source_label.text = page.stale_text()
	else:
		_source_label.text = page.source_text()

	if page.state() == READY:
		_add_cards()
		_add_model_rows()
	_add_chart_states()


## The overview cards. Attempts and steps are separate cards, so the two are never read as
## one number.
func _add_cards() -> void:
	_add_fact("Observed requests", str(page.cards().get("requests", "")))
	_add_fact("Logical steps", str(page.cards().get("logical_steps", "")))
	_add_fact("Physical attempts", str(page.cards().get("physical_attempts", "")))
	_add_fact("Helper requests", str(page.cards().get("helpers", "")))
	# The two spend figures are labelled by PROVENANCE, not by confidence. A recorded
	# figure is the provider's own billing and an estimated one comes from a price list, so
	# "recorded $0.00 beside estimated $18.06" is a true statement about a session whose
	# spend is mostly unpriced - not a claim that it was free.
	_add_fact("Spend (provider-recorded)", str(page.cards().get("known_spend", "")))
	_add_fact("Spend (catalog estimate)", str(page.cards().get("estimated_spend", "")))
	_add_fact("Input tokens", str(page.cards().get("input_tokens", "")))
	_add_fact("Output tokens", str(page.cards().get("output_tokens", "")))
	_add_fact("Reasoning tokens", str(page.cards().get("reasoning_tokens", "")))
	_add_fact("Cache read tokens", str(page.cards().get("cache_read_tokens", "")))


func _add_model_rows() -> void:
	var rows := page.model_rows()
	if rows.is_empty():
		return
	_add_heading("By model")
	for row in rows:
		var priced := "priced" if bool(row.get("priced", false)) else "unpriced"
		_add_fact(
			str(row.get("label", "")),
			"%d requests · %s · %s" % [
				int(row.get("requests", 0)),
				str(row.get("cost", "")) if row.get("cost", null) != null else StatisticsPage.UNREPORTED,
				priced,
			]
		)


## The chart states. Both say WHY they cannot be drawn, so a reader is not left wondering
## whether the page is broken or the data is missing.
func _add_chart_states() -> void:
	_add_heading("Daily activity")
	var daily := Label.new()
	daily.text = page.daily_unavailable_text()
	OfficeTheme.apply_font(daily, 10)
	daily.add_theme_color_override("font_color", OfficeTheme.text_dim())
	daily.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_chart_box.add_child(daily)

	_add_heading("Activity calendar")
	var calendar := Label.new()
	calendar.text = page.calendar_unavailable_text()
	OfficeTheme.apply_font(calendar, 10)
	calendar.add_theme_color_override("font_color", OfficeTheme.text_dim())
	calendar.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_chart_box.add_child(calendar)


## The quota tab: one card per provider, each window shown INDEPENDENTLY.
##
## No window is combined with another and no share is derived from a missing denominator;
## the page owns both rules, so this only renders what it is given.
##
## A provider the runtime cannot read usage from produces no card at all: there is nothing to
## show, and a card stating that would be a row about nothing.
func _render_quota() -> void:
	_subtitle.text = "Provider account limits, as the runtime reports them."
	_render_budgets()
	_state_label.text = quota_page.freshness_text()
	_state_label.add_theme_color_override("font_color", OfficeTheme.text_dim())
	_source_label.text = quota_page.combined_total_text()

	var rows := quota_page.provider_rows()
	if rows.is_empty():
		# Two different facts, and only one of them may say nothing was reported. A runtime
		# that answered with providers whose usage it cannot read DID report; claiming
		# otherwise would be false, so the empty text is chosen from what was delivered.
		_add_to(_quota_box, (
			"No provider reported usage. This is not the same as no provider having work."
			if not quota_page.has_snapshots()
			else "No provider reported usage this account can read."
		), 11)
		return
	for row in rows:
		_add_to(_quota_box, "%s  ·  %s" % [
			str(row.get("label", "")), str(row.get("status", "")),
		], 12, OfficeTheme.accent())
		var note := str(row.get("note", ""))
		if not note.is_empty():
			_add_to(_quota_box, note, 10)
		_add_to(_quota_box, "Updated %s  ·  %s  ·  %s" % [
			str(row.get("updated_text", "")), str(row.get("source", "")),
			str(row.get("stability", "")),
		], 10, OfficeTheme.text_muted())
		for window in quota_page.windows_for(str(row.get("provider", ""))):
			_add_to(_quota_box, "%s  ·  %s" % [
				window.label(), window.summary_text(),
			], 11)
			_add_to(_quota_box, "  %s  ·  resets %s  ·  period %s" % [
				window.percent_text(), window.reset_text(), window.period_text(),
			], 10, OfficeTheme.text_dim())


## The user's own advisory budgets, shown APART from the provider windows and labelled as the
## user's policy.
##
## The separation is the point: a provider window is the account's own limit and a budget is
## the user's warning threshold. Merging them would present a local preference as provider
## data, and the kit forbids exactly that. Nothing rendered here can stop work.
func _render_budgets() -> void:
	var budgets := budget_store.budgets()
	if budgets.is_empty():
		return
	_add_to(_quota_box, "Your advisory budgets", 12, OfficeTheme.accent_warm())
	_add_to(_quota_box, QuotaBudget.ENFORCED_REASON, 10, OfficeTheme.text_dim())
	for budget in budgets:
		_add_to(_quota_box, budget.label(), 11)
		var key := "%s:%s" % [budget.scope(), budget.scope_id()]
		var known := bool(observed_known.get(key, false))
		var spend := float(observed_spend.get(key, 0.0))
		var verdict := budget.evaluate(spend, known)
		_add_to(_quota_box, verdict.text(), 10, OfficeTheme.text_dim())


func _add_to(box: VBoxContainer, text: String, font_size: int, color: Color = Color.TRANSPARENT) -> void:
	var label := Label.new()
	label.text = text
	OfficeTheme.apply_font(label, font_size)
	if color != Color.TRANSPARENT:
		label.add_theme_color_override("font_color", color)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(label)


func _add_heading(text: String) -> void:
	var label := Label.new()
	label.text = text
	OfficeTheme.apply_font(label, 12)
	label.add_theme_color_override("font_color", OfficeTheme.accent())
	_cards_box.add_child(label)


func _add_fact(label: String, value: String) -> void:
	var row := Label.new()
	row.text = "%s: %s" % [label, value]
	OfficeTheme.apply_font(row, 11)
	row.add_theme_color_override("font_color", OfficeTheme.text())
	_cards_box.add_child(row)


func _clear(box: VBoxContainer) -> void:
	for child in box.get_children():
		box.remove_child(child)
		child.queue_free()
