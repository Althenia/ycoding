## Provider quota window tests (R7-04).
##
## The acceptance is: "Reuse existing snapshots; lanes/units independent; missing != zero;
## unsupported hidden; error/stale visible; refresh nonblocking."
##
## Every rule below was checked against the LIVE service before a line was written, and the
## real answer contains each case:
##
##   anthropic "Claude"   status=unsupported, windows=0
##   openrouter "Key limit"  usd, used=44.14, limit=50, remaining=5.86
##   openrouter "Daily"      usd, used=0.33, NO limit
##   openai "Weekly"         percent, used=100, resetAt, periodSeconds
##   openai "Reset credits"  count, remaining=1 only
##
## From that data the rules follow directly:
##
##   * WINDOWS ARE INDEPENDENT. Each carries its own unit and its own figures. Summing two
##     usd windows, or adding a percent window to a count window, produces a number that
##     describes nothing, so no window is ever combined with another.
##   * MISSING IS NOT ZERO, and MISSING IS NOT UNLIMITED. `openrouter/Daily` reports spend
##     with no denominator. That means the provider did not state a limit - it does NOT mean
##     the spend is unlimited, and it does NOT mean the limit is zero.
##   * NO INVENTED PERCENTAGE. A share may be shown only when the provider gave a real
##     denominator (used AND limit), or when the unit IS already a percentage. Deriving
##     "spend / nothing" is not a percentage.
##   * AN UNSUPPORTED PROVIDER IS NOT SHOWN. `anthropic` reports `unsupported` with zero
##     windows, and a surface that renders a row for it is showing a provider that has no
##     usage to show. The runtime still REPORTS it - the reader keeps the snapshot, its
##     status and its source - and the presentation drops the row, exactly as the TUI's
##     own `visibleProviderSnapshots` does (packages/tui/src/routes/session/provider-usage.tsx:45-48).
##     Every other status stays visible: only `unsupported` means there is nothing to show.
##   * FRESHNESS IS REPORTED. `updatedAt` is the provider's own timestamp, and a `stale`
##     status must read differently from a fresh one.
##   * REFRESH IS NON-BLOCKING. The route takes a `refresh` query; asking for one must not
##     stall the caller, because a quota read is best effort and can never block sending a
##     prompt.
extends RefCounted


func run(t) -> void:
	test_each_window_keeps_its_own_unit(t)
	test_windows_are_never_summed_across_units(t)
	test_windows_are_never_summed_within_a_unit(t)
	test_a_missing_limit_is_not_zero(t)
	test_a_window_with_only_remaining_states_what_it_has(t)
	test_a_missing_limit_is_not_unlimited(t)
	test_a_percentage_comes_from_a_real_denominator(t)
	test_a_percent_unit_window_may_show_its_own_figure(t)
	test_an_unsupported_provider_is_hidden(t)
	test_every_other_status_stays_visible(t)
	test_the_panel_names_no_unsupported_row(t)
	test_unsupported_provider_has_no_placeholder_bar(t)
	test_unknown_status_renders_a_truthful_state(t)
	test_the_reader_keeps_an_unsupported_snapshot(t)
	test_the_empty_quota_text_matches_what_was_delivered(t)
	test_a_stale_snapshot_reads_differently(t)
	test_an_error_snapshot_carries_its_message(t)
	test_freshness_comes_from_the_snapshot_timestamp(t)
	test_provider_timestamps_are_milliseconds(t)
	test_the_reader_reads_the_verified_route(t)
	test_the_reader_reads_one_provider(t)
	test_a_refresh_is_requested_without_blocking(t)
	test_a_malformed_snapshot_is_refused_not_half_read(t)


## A snapshot in the shape the live route returns, inside its location envelope.
func _snapshot(overrides: Dictionary = {}) -> Dictionary:
	var base := {
		"providerID": "openrouter", "label": "Openrouter",
		"status": "available", "source": "provider_api", "stability": "stable",
		"updatedAt": 1789805590000,
		"windows": [
			{
				"id": "key", "label": "Key limit", "unit": "usd",
				"used": 44.0, "limit": 50.0, "remaining": 6.0,
			},
			{
				"id": "daily", "label": "Daily", "unit": "usd", "used": 0.33,
			},
		],
	}
	for key in overrides:
		base[key] = overrides[key]
	return base


## Each window carries its own unit, so a reader can tell a dollar limit from a percentage.
func test_each_window_keeps_its_own_unit(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var windows := page.windows_for("openrouter")
	t.check_equal(windows.size(), 2, "both windows are kept")
	if windows.size() < 2:
		return
	t.check_equal(windows[0].unit(), "usd", "the first window's unit is usd")
	t.check(
		windows[0].unit() != windows[1].unit() or windows[1].unit() == "usd",
		"and each window names its own unit rather than assuming one"
	)


## Windows of DIFFERENT units are never combined. Adding dollars to a percentage describes
## nothing.
func test_windows_are_never_summed_across_units(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot({
		"providerID": "openai", "label": "Codex Pro",
		"windows": [
			{"id": "codex-primary", "label": "Weekly", "unit": "percent", "used": 100},
			{"id": "reset-credits", "label": "Reset credits", "unit": "count", "remaining": 1},
		],
	})], QuotaPage.VALID_AT, QuotaPage.FRESH)
	# The page exposes no combined total, and says so rather than offering a number.
	t.check(
		not page.has_combined_total(),
		"the page offers no total across windows of different units"
	)
	t.check(
		not page.combined_total_text().contains("100") or page.combined_total_text().contains("cannot"),
		"and its text does not present a combined figure (%s)" % page.combined_total_text()
	)


## Windows of the SAME unit are also never summed: two dollar windows are two DIFFERENT
## limits, and their sum is not a limit that exists.
func test_windows_are_never_summed_within_a_unit(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var windows := page.windows_for("openrouter")
	var labels: Array[String] = []
	for window in windows:
		labels.append(window.label())
	t.check_equal(labels.size(), 2, "both usd windows remain separate rows")
	t.check(
		not page.has_combined_total(),
		"and their two limits are not added into one figure"
	)


## A window with `used` and no `limit` reports spend, and the LIMIT is unreported - not
## zero, which would claim the provider allows nothing.
func test_a_missing_limit_is_not_zero(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var daily := _window(page.windows_for("openrouter"), "daily")
	t.check(not daily.id().is_empty(), "the daily window is present")
	if daily.id().is_empty():
		return
	t.check(not daily.has_limit(), "it reports no limit")
	t.check_equal(
		daily.limit_text(), QuotaPage.UNREPORTED,
		"and its limit reads as unreported, not as 0"
	)
	t.check(
		not daily.limit_text() == "0",
		"the unreported limit is not a zero"
	)
	t.check(daily.used_text() != QuotaPage.UNREPORTED, "while its USED figure is reported")


## A window that reports NEITHER used nor limit still renders honestly. The live service has
## one: openai "Reset credits" carries only `remaining`.
func test_a_window_with_only_remaining_states_what_it_has(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot({
		"providerID": "openai",
		"windows": [{"id": "reset-credits", "label": "Reset credits", "unit": "count", "remaining": 1}],
	})], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var window := _window(page.windows_for("openai"), "reset-credits")
	t.check_equal(window.remaining_text(), "1", "its remaining figure is reported")
	t.check_equal(
		window.used_text(), QuotaPage.UNREPORTED,
		"an unreported used figure is NOT rendered as zero (%s)" % window.used_text()
	)
	t.check(
		not window.used_text() == "0",
		"the unreported figure is not a zero"
	)
	t.check_equal(
		window.percent_text(), QuotaPage.UNREPORTED,
		"and no share is invented from a remaining count alone"
	)


## A window with no `limit` is NOT unlimited. The `unlimited` flag is the provider's own
## statement, and its absence is the absence of a statement.
func test_a_missing_limit_is_not_unlimited(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var daily := _window(page.windows_for("openrouter"), "daily")
	t.check(not daily.is_unlimited(), "a missing limit is not an unlimited flag")
	# Only the provider's own flag makes a window unlimited.
	var flagged := QuotaPage.new()
	flagged.adopt([_snapshot({
		"windows": [{"id": "k", "label": "Key", "unit": "usd", "used": 1.0, "unlimited": true}],
	})], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var window := _window(flagged.windows_for("openrouter"), "k")
	t.check(window.is_unlimited(), "a window the provider marks unlimited says so")


## A percentage is only shown when the provider gave a real denominator, so no share is
## derived from a missing limit.
func test_a_percentage_comes_from_a_real_denominator(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var key := _window(page.windows_for("openrouter"), "key")
	t.check(key.has_limit(), "the key window has a denominator")
	t.check_equal(
		key.percent_text(), "88%",
		"so its share is computed from used and limit (%s)" % key.percent_text()
	)
	var daily := _window(page.windows_for("openrouter"), "daily")
	t.check(
		not daily.has_limit(),
		"the daily window has none"
	)
	t.check_equal(
		daily.percent_text(), QuotaPage.UNREPORTED,
		"so NO percentage is derived for it (%s)" % daily.percent_text()
	)


## A window whose unit IS percent already carries the figure, so it is shown as reported -
## without inventing a denominator from anything.
func test_a_percent_unit_window_may_show_its_own_figure(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot({
		"providerID": "openai",
		"windows": [{"id": "codex-primary", "label": "Weekly", "unit": "percent", "used": 100}],
	})], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var weekly := _window(page.windows_for("openai"), "codex-primary")
	t.check(weekly.unit_is_percent(), "the window's unit is percent")
	t.check_equal(
		weekly.percent_text(), "100%",
		"so its own figure is shown as reported (%s)" % weekly.percent_text()
	)
	t.check(
		not weekly.has_limit(),
		"and no denominator was invented to produce it"
	)


## An `unsupported` provider is NOT RENDERED. It has no usage to show, so a row for it is a
## row about nothing.
func test_an_unsupported_provider_is_hidden(t) -> void:
	var page := QuotaPage.new()
	page.adopt([
		_snapshot(),
		_snapshot({
			"providerID": "anthropic", "label": "Claude",
			"status": "unsupported", "windows": [],
		}),
	], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var rows := page.provider_rows()
	t.check_equal(rows.size(), 1, "only the provider with usage gets a row")
	t.check(_provider(rows, "anthropic").is_empty(), "the unsupported provider has no row")
	# Paired with the presence check, so the absence cannot come from an empty page.
	t.check(not _provider(rows, "openrouter").is_empty(), "while the provider that reports usage keeps its row")
	for row in rows:
		t.check(
			str(row.get("status", "")) != "unsupported",
			"and no rendered row carries the unsupported status"
		)


## Only `unsupported` is hidden. Every other status is a statement ABOUT usage, so it keeps
## its row and its own status text.
func test_every_other_status_stays_visible(t) -> void:
	var statuses := ["available", "stale", "unauthorized", "error"]
	var snapshots: Array = []
	for status in statuses:
		snapshots.append(_snapshot({
			"providerID": "p_%s" % status, "label": status.capitalize(),
			"status": status, "windows": [],
		}))
	var page := QuotaPage.new()
	page.adopt(snapshots, QuotaPage.VALID_AT, QuotaPage.FRESH)
	var rows := page.provider_rows()
	t.check_equal(rows.size(), statuses.size(), "every other status keeps its row")
	for status in statuses:
		var row := _provider(rows, "p_%s" % status)
		t.check(not row.is_empty(), "the %s provider is still shown" % status)
		if row.is_empty():
			continue
		t.check_equal(str(row.get("status", "")), status, "and its own status is carried")
		# A status that names a problem must explain it. `available` is the one status that
		# is not a problem, so its note is empty by design.
		if status == "available":
			t.check(
				str(row.get("note", "")).is_empty(),
				"a provider reporting usage carries no problem note"
			)
			continue
		t.check(
			not str(row.get("note", "")).is_empty(),
			"the %s status is explained (%s)" % [status, str(row.get("note", ""))]
		)


## THE RENDERED BOUNDARY: the real panel a user looks at, not the page behind it.
##
## The page and the widget are separate objects, so a filter on the page is only half the
## claim. This mounts the actual `StatisticsPanel`, shows the quota tab, adopts a real quota
## page and reads the strings it put on screen.
func test_the_panel_names_no_unsupported_row(t) -> void:
	var panel := _mount_quota_panel(t, [
		_snapshot(),
		_snapshot({
			"providerID": "anthropic", "label": "Claude",
			"status": "unsupported", "windows": [],
		}),
	])
	var shown := _panel_text(panel)
	# The tab really rendered, so the absence below is a filtered row rather than a panel
	# that never built.
	t.check(
		shown.contains("Provider account limits"),
		"the quota tab rendered (%s)" % shown
	)
	t.check(shown.contains("Openrouter"), "and the provider that reports usage is named")
	t.check(
		not shown.to_lower().contains("unsupported"),
		"no unsupported row is on screen (%s)" % shown
	)
	t.check(not shown.contains("Claude"), "and the unsupported provider is not named either")
	# A WINDOW is still shown for the provider that has one, so the surface is not merely
	# blank.
	t.check(shown.contains("Key limit"), "while the reported window is still on screen")
	_unmount(t, panel)


## Unsupported data cannot produce a placeholder bar. Supported metrics may use charts.
func test_unsupported_provider_has_no_placeholder_bar(t) -> void:
	var panel := _mount_quota_panel(t, [_snapshot({
		"providerID": "anthropic", "label": "Claude",
		"status": "unsupported", "windows": [],
	})])
	t.check_equal(_count_bars(panel), 0, "unsupported provider produces no placeholder bar")
	var shown := _panel_text(panel)
	t.check(not shown.contains("Claude"), "unsupported provider produces no placeholder card")
	_unmount(t, panel)


## A status the schema does not declare still renders a truthful state rather than being
## silently dropped, so the hide rule is not a blanket swallow of anything unexpected.
func test_unknown_status_renders_a_truthful_state(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot({
		"providerID": "mystery", "label": "Mystery", "status": "unheard_of", "windows": [],
	})], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var row := _provider(page.provider_rows(), "mystery")
	t.check(not row.is_empty(), "an unrecognized status is still shown")
	if row.is_empty():
		return
	t.check_equal(str(row.get("status", "")), "unheard_of", "its status is carried unchanged")
	t.check(
		str(row.get("note", "")).contains("unheard_of"),
		"and the note names the status it does not explain (%s)" % str(row.get("note", ""))
	)


## The filter is PRESENTATION ONLY. The snapshots the reader delivered are still the page's
## own data, untouched, so provenance and status are not destroyed by a display decision.
func test_the_reader_keeps_an_unsupported_snapshot(t) -> void:
	var unsupported := _snapshot({
		"providerID": "anthropic", "label": "Claude", "status": "unsupported", "windows": [],
	})
	var delivered: Array = [_snapshot(), unsupported]
	var page := QuotaPage.new()
	page.adopt(delivered, QuotaPage.VALID_AT, QuotaPage.FRESH)
	t.check_equal(delivered.size(), 2, "the caller's array is not filtered in place")
	t.check(delivered.has(unsupported), "and the unsupported snapshot is still in it")
	t.check_equal(
		str(unsupported.get("status", "")), "unsupported",
		"with its status and source intact"
	)
	t.check_equal(
		page.provider_rows().size(), 1,
		"while the rendered rows exclude it"
	)
	t.check(page.has_snapshots(), "and the page still holds the snapshot it was given")
	t.check(
		page.windows_for("anthropic").is_empty(),
		"an unsupported provider has no windows to read either way"
	)


## The quota tab's own empty text, at the rendered boundary. A runtime that answered with
## providers whose usage it cannot read DID report, so the surface may not say that nothing
## was reported.
func test_the_empty_quota_text_matches_what_was_delivered(t) -> void:
	var unsupported_only := _mount_quota_panel(t, [
		_snapshot({
			"providerID": "anthropic", "label": "Claude",
			"status": "unsupported", "windows": [],
		}),
	])
	var reported := _panel_text(unsupported_only)
	t.check(
		reported.contains("No provider reported usage this account can read."),
		"a report of unreadable usage says so (%s)" % reported
	)
	t.check(
		not reported.contains("This is not the same as no provider having work."),
		"and it does not claim the runtime reported nothing"
	)
	t.check(not reported.contains("Claude"), "with no card for the unsupported provider")
	_unmount(t, unsupported_only)

	# The other fact: nothing was delivered at all.
	var nothing := _mount_quota_panel(t, [])
	var empty := _panel_text(nothing)
	t.check(
		empty.contains("No provider reported usage. This is not the same as no provider having work."),
		"an empty read keeps its own text (%s)" % empty
	)
	_unmount(t, nothing)


## A stale snapshot must read differently from a fresh one.
func test_a_stale_snapshot_reads_differently(t) -> void:
	var fresh := QuotaPage.new()
	fresh.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var stale := QuotaPage.new()
	stale.adopt([_snapshot({"status": "stale"})], QuotaPage.VALID_AT, QuotaPage.STALE)
	t.check(
		fresh.freshness_text() != stale.freshness_text(),
		"a stale page does not read as a fresh one (%s vs %s)" % [
			fresh.freshness_text(), stale.freshness_text(),
		]
	)
	t.check(
		stale.freshness_text().to_lower().contains("stale"),
		"and it says it is stale (%s)" % stale.freshness_text()
	)


## An `error` snapshot carries its message, so a failure is explained rather than blank.
func test_an_error_snapshot_carries_its_message(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot({
		"status": "error", "message": "The provider refused the usage request.",
	})], QuotaPage.VALID_AT, QuotaPage.ERROR)
	var row := _provider(page.provider_rows(), "openrouter")
	t.check_equal(str(row.get("status", "")), "error", "the error status is shown")
	t.check(
		str(row.get("note", "")).contains("refused"),
		"and the provider's own message is carried (%s)" % str(row.get("note", ""))
	)


## Freshness is the provider's OWN timestamp, not when the client happened to read it.
func test_freshness_comes_from_the_snapshot_timestamp(t) -> void:
	var page := QuotaPage.new()
	page.adopt([_snapshot()], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var row := _provider(page.provider_rows(), "openrouter")
	t.check(
		int(row.get("updated_at", 0)) == 1789805590000,
		"the snapshot's own updatedAt is carried (%d)" % int(row.get("updated_at", 0))
	)
	t.check(
		not str(row.get("updated_text", "")).is_empty(),
		"and it renders as readable text (%s)" % str(row.get("updated_text", ""))
	)


## The provider's timestamps are EPOCH MILLISECONDS, which the schema type does not state and
## only the value reveals. Read as seconds they render the year 58683, so the unit is pinned
## by the observable property: a recent millisecond value is a recent date.
func test_provider_timestamps_are_milliseconds(t) -> void:
	var page := QuotaPage.new()
	# 2026-09-18T02:26:12Z in milliseconds, as the live service reports it.
	page.adopt([_snapshot({"updatedAt": 1789698372979})], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var row := _provider(page.provider_rows(), "openrouter")
	var text := str(row.get("updated_text", ""))
	t.check(
		text.begins_with("2026-"),
		"a millisecond timestamp renders its real year, not 58683 (%s)" % text
	)
	t.check(not text.begins_with("5868"), "and not a year five centuries from now")
	t.check(
		int(row.get("updated_at", 0)) == 1789698372979,
		"the raw value is carried unchanged, so nothing is silently rewritten"
	)
	# resetAt uses the same convention: the live service reports 1789805590000.
	var window := QuotaWindow.from_wire({
		"id": "w", "label": "Weekly", "unit": "percent", "used": 1,
		"resetAt": 1789805590000,
	})
	t.check(
		window.reset_text().begins_with("2026-"),
		"a window's resetAt is millisecond too (%s)" % window.reset_text()
	)
	# An absent timestamp is unreported, never "now".
	var absent := QuotaWindow.from_wire({"id": "w", "label": "W", "unit": "usd", "used": 1})
	t.check_equal(absent.reset_text(), QuotaPage.UNREPORTED, "an absent reset is unreported")


## The reader reads the VERIFIED route, and its envelope carries a location.
func test_the_reader_reads_the_verified_route(t) -> void:
	var transport := QuotaStub.new()
	transport.wire_body = {"location": {"directory": "/tmp"}, "data": [_snapshot()]}
	var api := ProviderUsageApi.new()
	api.configure(transport)
	var snapshots := api.fetch()
	t.check_equal(transport.requests.size(), 1, "one request is issued")
	t.check_equal(
		str(transport.requests[0].get("path", "")), "/api/provider/usage",
		"the verified list route is read"
	)
	t.check_equal(api.last_error(), "", "a clean read reports no failure")
	t.check_equal(snapshots.size(), 1, "the snapshot is read from the data envelope")


## The single-provider route is read for one provider.
func test_the_reader_reads_one_provider(t) -> void:
	var transport := QuotaStub.new()
	transport.wire_body = {"location": {"directory": "/tmp"}, "data": _snapshot()}
	var api := ProviderUsageApi.new()
	api.configure(transport)
	var snapshot := api.fetch_provider("openrouter")
	t.check_equal(
		str(transport.requests[0].get("path", "")), "/api/provider/openrouter/usage",
		"the verified single-provider route is read"
	)
	t.check_equal(str(snapshot.get("providerID", "")), "openrouter", "and its snapshot returned")


## Asking for a refresh must not stall the caller: the read is a bounded, best-effort one
## that a prompt never waits on.
func test_a_refresh_is_requested_without_blocking(t) -> void:
	var transport := QuotaStub.new()
	transport.wire_body = {"location": {"directory": "/tmp"}, "data": []}
	transport.never_settles = true
	var api := ProviderUsageApi.new()
	api.configure(transport)
	var started := Time.get_ticks_msec()
	# A read that never answers must return within its own budget rather than hang.
	var snapshots := api.fetch(300)
	var elapsed := Time.get_ticks_msec() - started
	t.check(elapsed < 3000, "a never-answering read returns within its budget (%dms)" % elapsed)
	t.check_equal(snapshots.size(), 0, "and reports no snapshots rather than stale ones")
	t.check(
		not api.last_error().is_empty(),
		"with a reason (%s)" % api.last_error()
	)
	t.check(
		transport.cancelled.size() > 0,
		"and the abandoned request was cancelled rather than left to drain"
	)


## A snapshot missing a REQUIRED field is refused rather than half-read, because a window
## with no unit cannot be rendered honestly.
func test_a_malformed_snapshot_is_refused_not_half_read(t) -> void:
	var transport := QuotaStub.new()
	# A window with no unit: the schema requires one (ProviderUsage.Window).
	transport.wire_body = {"location": {"directory": "/tmp"}, "data": [
		{"providerID": "x", "label": "X", "status": "available", "source": "provider_api",
		 "stability": "stable", "updatedAt": 1, "windows": [{"id": "a", "label": "A"}]},
	]}
	var api := ProviderUsageApi.new()
	api.configure(transport)
	var snapshots := api.fetch()
	t.check_equal(snapshots.size(), 0, "a malformed snapshot is not half-read")
	t.check(
		not api.last_error().is_empty(),
		"and the reason is stated (%s)" % api.last_error()
	)


## The REAL panel, mounted in tree scope with a real quota page adopted and the quota tab
## shown. The presentation model and the widget are separate objects, so the rules are
## asserted at the surface a user actually reads.
##
## Synchronous on purpose: entering the tree runs `_ready`, which builds the panel, and
## `show_tab` repaints it in the same call. Nothing here awaits a frame, so no assertion
## after it can be silently dropped.
func _mount_quota_panel(t, snapshots: Array) -> StatisticsPanel:
	var panel := StatisticsPanel.new()
	t.root.add_child(panel)
	var page := QuotaPage.new()
	page.adopt(snapshots, QuotaPage.VALID_AT, QuotaPage.FRESH)
	panel.adopt_quota(page)
	panel.show_tab(StatisticsPanel.TAB_QUOTA)
	return panel


## Detach before freeing: the runner is a SceneTree, which owns no `remove_child`, and a
## node freed while still parented leaks.
func _unmount(t, panel: Node) -> void:
	var parent: Node = panel.get_parent()
	if parent != null:
		parent.remove_child(panel)
	panel.free()


## Every visible string in a subtree, including BUTTON text, because the tab is a button and
## a probe that read only Labels reported a control missing while it was on screen.
func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


## Count progress bars in the unsupported-only fixture.
func _count_bars(node) -> int:
	var found := 0
	if node is ProgressBar:
		found += 1
	for child in node.get_children():
		found += _count_bars(child)
	return found


func _window(windows: Array, id: String) -> QuotaWindow:
	for window in windows:
		if window.id() == id:
			return window
	return QuotaWindow.empty()


func _provider(rows: Array, provider_id: String) -> Dictionary:
	for row in rows:
		if str(row.get("provider", "")) == provider_id:
			return row
	return {}


## A transport double at the boundary being read, in the verified entry shape.
class QuotaStub extends "res://integration/http_transport.gd":
	var status := 200
	var wire_body: Dictionary = {}
	var error_message := ""
	var never_settles := false
	var requests: Array = []
	var cancelled: Array = []
	var _last_request_id := 0
	var _delivered := false

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({"method": method, "path": path, "body": body})
		_last_request_id = requests.size()
		return _last_request_id

	func poll(_budget_ms: int = 4) -> Array[Dictionary]:
		var entries: Array[Dictionary] = []
		if _delivered or never_settles:
			return entries
		_delivered = true
		if not error_message.is_empty():
			entries.append({
				"request_id": _last_request_id, "kind": "error", "status": 0,
				"body": {}, "event": {}, "error": error_message,
			})
			return entries
		entries.append({
			"request_id": _last_request_id, "kind": "response", "status": status,
			"body": wire_body, "event": {}, "error": "",
		})
		return entries

	func cancel(request_id: int) -> void:
		cancelled.append(request_id)
