## Statistics page tests (R7-03).
##
## The acceptance is: "Cards, activity calendar, daily chart/table, model/provider/project
## breakdown, source drilldown and empty states."
##
## The kit's statistics contract shapes every rule here. Its decisive sentence is: "No
## arbitrary mock graph in production: use proper empty, partial, loading, stale and error
## states." A chart is the easiest place in a product to lie, so this page is built as a
## STATE MACHINE over what has actually been read, and each state is asserted.
##
## Two clauses of the acceptance cannot be satisfied from data the runtime exposes, and this
## suite pins that rather than drawing something plausible:
##
##   * THE DAILY CHART. `session.usage` returns a CUMULATIVE `ProviderRequest.Summary`
##     (packages/schema/src/provider-request.ts: its fields are logical, physical, helpers,
##     continued, fallback, cost, models, tokens, latestInvalidation, latestNamespace - no
##     time). The per-request records that DO carry `time_created` are persisted
##     (packages/core/src/database/schema.gen.ts) but exposed by no endpoint: every GET
##     route in packages/protocol/src/groups was enumerated and none returns a
##     `ProviderRequest.Record` or a date. So the page reports the chart unavailable with its
##     reason instead of grouping sessions by when they started, which would attribute work
##     to the wrong day.
##   * THE ACTIVITY CALENDAR. Same source, same absence.
##
## The overview cards, the model/provider breakdown and the empty/loading/error states ARE
## satisfiable, and are asserted against the real aggregate.
extends RefCounted


func run(t) -> void:
	test_an_unread_page_is_loading_not_empty(t)
	test_an_empty_answer_is_empty_not_zero(t)
	test_a_failed_read_is_an_error_with_its_reason(t)
	test_cards_state_attempts_apart_from_steps(t)
	test_cards_separate_known_from_estimated_spend(t)
	test_an_unknown_component_is_unreported_not_zero(t)
	test_the_model_breakdown_comes_from_the_service(t)
	test_the_provider_breakdown_does_not_invent_a_share(t)
	test_the_daily_chart_is_declared_unavailable(t)
	test_the_activity_calendar_is_declared_unavailable(t)
	test_a_stale_read_is_marked_stale(t)
	test_filtering_by_model_reduces_the_page_consistently(t)
	test_the_drilldown_names_its_source(t)


func _summary(overrides: Dictionary = {}) -> Dictionary:
	var base := {
		"logical": 12, "physical": 15, "helpers": 2, "continued": 1, "fallback": 0,
		"cost": 2.5,
		"tokens": {
			"input": 5000, "output": 900, "reasoning": 120,
			"cache": {"read": 3000, "write": 250},
		},
		"models": [
			{
				"model": {"providerID": "anthropic", "id": "claude-sonnet-4", "variant": "max"},
				"requests": 8,
				"tokens": {"input": 4000, "output": 700, "reasoning": 100, "cache": {"read": 2500, "write": 200}},
				"cost": 2.0, "costProvenance": "recorded",
			},
			{
				"model": {"providerID": "openrouter", "id": "deepseek-v4.1-flash"},
				"requests": 4,
				"tokens": {"input": 1000, "output": 200, "reasoning": 20, "cache": {"read": 500, "write": 50}},
				"cost": 0.5, "costProvenance": "current_catalog",
			},
		],
	}
	for key in overrides:
		base[key] = overrides[key]
	return base


## Before a read settles the page is LOADING. It must never render an empty chart, because
## an empty chart claims there was no work.
func test_an_unread_page_is_loading_not_empty(t) -> void:
	var page := StatisticsPage.new()
	t.check_equal(page.state(), StatisticsPage.LOADING, "an unread page is LOADING")
	t.check(not page.is_empty(), "and it is not presented as having no data")
	t.check(
		page.state_text() != page.empty_text(),
		"the loading state does not read as the empty state"
	)


## An answer that reports zero requests is genuinely EMPTY, and says so rather than drawing
## an axis with nothing on it.
func test_an_empty_answer_is_empty_not_zero(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary({
		"logical": 0, "physical": 0, "helpers": 0, "cost": null,
		"tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
		"models": [],
	})))
	t.check_equal(page.state(), StatisticsPage.EMPTY, "a report of no work is EMPTY")
	t.check(page.is_empty(), "and it says so")
	t.check(
		page.empty_text().contains("No"),
		"with a readable empty message (%s)" % page.empty_text()
	)


## A failed read is an ERROR state carrying the service's reason. It is never an empty
## chart, because "we could not read it" and "there is none" are different facts.
func test_a_failed_read_is_an_error_with_its_reason(t) -> void:
	var page := StatisticsPage.new()
	page.fail("The usage read did not answer within its time budget.")
	t.check_equal(page.state(), StatisticsPage.ERROR, "a failure is an ERROR state")
	t.check(
		page.error_text().contains("time budget"),
		"and it carries the reason it failed (%s)" % page.error_text()
	)
	t.check(
		page.state() != StatisticsPage.EMPTY,
		"a failed read is never presented as an empty one"
	)
	# The state TEXT is what a reader actually sees, so it must not read as the empty
	# message either. Asserting only the state name left the visible text unguarded.
	t.check(
		page.state_text() != page.empty_text(),
		"and its text does not read as the empty message (%s)" % page.state_text()
	)


## The cards keep attempts apart from steps, which is the accounting rule R7-02 proved.
func test_cards_state_attempts_apart_from_steps(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	var cards := page.cards()
	t.check(
		str(cards.get("logical_steps", "")) == "12",
		"the steps card shows the logical count (%s)" % str(cards.get("logical_steps", ""))
	)
	t.check(
		str(cards.get("physical_attempts", "")) == "15",
		"the attempts card shows the physical count (%s)" % str(cards.get("physical_attempts", ""))
	)
	t.check(
		not str(cards.get("physical_attempts", "")) == str(cards.get("logical_steps", "")),
		"and the two cards do not show the same number"
	)
	t.check(str(cards.get("requests", "")) == "15", "observed requests are the physical attempts")


## Known and estimated spend are SEPARATE cards, because one is an invoice and one is a
## guess from a price list.
func test_cards_separate_known_from_estimated_spend(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	var cards := page.cards()
	t.check(cards.has("known_spend"), "there is a known-spend card")
	t.check(cards.has("estimated_spend"), "and a separate estimated-spend card")
	t.check(
		not str(cards.get("known_spend", "")) == str(cards.get("estimated_spend", "")),
		"the two are not one number under two labels"
	)
	t.check(
		"recorded" in str(cards.get("known_spend", "")).to_lower() or "$" in str(cards.get("known_spend", "")),
		"known spend is an amount or states it is unreported (%s)" % str(cards.get("known_spend", ""))
	)
	# A recorded figure that happens to be ZERO is still a recorded figure, and must not be
	# confused with an absent one. The service really does report cost 0 for a free tier.
	var free := StatisticsPage.new()
	free.adopt(SessionUsage.from_summary(_summary({"models": [
		{
			"model": {"providerID": "openai", "id": "gpt-5.6-luna", "variant": "none"},
			"requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 0, "costProvenance": "recorded",
		},
	]})))
	t.check(
		str(free.cards().get("known_spend", "")) == "$0.00",
		"a recorded zero renders as an amount, not as unreported (%s)" % str(free.cards().get("known_spend", ""))
	)
	t.check(
		str(free.cards().get("known_spend", "")) != StatisticsPage.UNREPORTED,
		"and it is NOT labelled unreported, because the service did report it"
	)


## Every token component is its own card value, and a component the service did not report
## renders as unreported rather than zero.
func test_an_unknown_component_is_unreported_not_zero(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	var cards := page.cards()
	t.check(str(cards.get("input_tokens", "")) == "5000", "input tokens are reported")
	t.check(str(cards.get("cache_read_tokens", "")) == "3000", "cache read is its own value")
	# A summary with no tokens object at all: nothing is known, and nothing becomes zero.
	var bare := StatisticsPage.new()
	bare.adopt(SessionUsage.from_summary({"logical": 1, "physical": 1, "helpers": 0}))
	t.check_equal(
		str(bare.cards().get("input_tokens", "")), "Not reported",
		"an unreported component reads as unreported, not as 0"
	)


## The model breakdown is the SERVICE's grouping, in the service's order. It is not
## recomputed, so a model the service grouped once cannot appear twice.
func test_the_model_breakdown_comes_from_the_service(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	var rows := page.model_rows()
	t.check_equal(rows.size(), 2, "both service groups appear")
	if rows.size() < 2:
		return
	t.check(
		str(rows[0].get("label", "")).contains("claude") or str(rows[0].get("ref", "")).contains("claude"),
		"the service's first group is first, not re-sorted locally"
	)
	t.check(
		rows[0].has("priced") and rows[1].has("priced"),
		"each row states whether its spend is complete"
	)
	t.check(not bool(rows[0].get("priced", false)) == not bool(rows[1].get("priced", false)),
		"and the two rows differ, because one is recorded and one is an estimate")


## A provider breakdown groups the service's model rows by provider. It must not invent a
## PERCENTAGE, because a share of an incomplete total is not a fact.
func test_the_provider_breakdown_does_not_invent_a_share(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	var rows := page.provider_rows()
	t.check_equal(rows.size(), 2, "the two providers are separated")
	for row in rows:
		t.check(
			not row.has("share") and not row.has("percent") and not row.has("percentage"),
			"a provider row carries no invented share of the total"
		)
		t.check(row.has("requests"), "but it does carry its own request count")


## The daily chart is DECLARED UNAVAILABLE with its reason, never approximated.
func test_the_daily_chart_is_declared_unavailable(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	t.check(not page.has_daily_chart(), "the page does not claim a daily chart")
	t.check_equal(page.daily_series().size(), 0, "and holds no invented series")
	t.check(
		page.daily_unavailable_text().contains("cumulative"),
		"it states the actual reason (%s)" % page.daily_unavailable_text()
	)


## The activity calendar has the same source and the same absence, stated the same way.
func test_the_activity_calendar_is_declared_unavailable(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	t.check(not page.has_calendar(), "the page does not claim an activity calendar")
	t.check_equal(page.calendar_cells().size(), 0, "and holds no invented cells")
	t.check(
		not page.calendar_unavailable_text().is_empty(),
		"it states why (%s)" % page.calendar_unavailable_text()
	)


## A read that succeeded but is known to be incomplete says so, rather than presenting a
## partial total as the whole picture.
func test_a_stale_read_is_marked_stale(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	t.check(not page.is_stale(), "a fresh read is not stale")
	page.mark_stale("The projection was reloaded after a reconnect.")
	t.check(page.is_stale(), "a reloaded projection is marked stale")
	t.check(
		page.stale_text().contains("reload"),
		"and the reason is carried (%s)" % page.stale_text()
	)


## Filtering by model reduces the page consistently: the cards and the rows describe the
## SAME subset, so the page cannot show one model's spend beside another's requests.
func test_filtering_by_model_reduces_the_page_consistently(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary()))
	var rows := page.model_rows()
	var target := str(rows[1].get("ref", "")) if rows.size() > 1 else ""
	if target.is_empty():
		t.check(false, "a second model row exists to filter by")
		return
	page.filter_by_model(target)
	t.check_equal(page.model_rows().size(), 1, "only the filtered model's row remains")
	t.check_equal(
		int(page.cards().get("requests", "0")), 4,
		"and the cards describe that same subset"
	)


## The drilldown names a REAL source. It points at the session the figures came from, not at
## the page's own aggregate.
func test_the_drilldown_names_its_source(t) -> void:
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary(), ["ses_alpha"]))
	var rows := page.model_rows()
	if rows.is_empty():
		t.check(false, "there is a row to drill from")
		return
	var source := str(rows[0].get("source", ""))
	t.check_equal(source, "ses_alpha", "the row names the session its figures came from")
	t.check(
		page.source_text().contains("ses_alpha"),
		"and the page names its source (%s)" % page.source_text()
	)
